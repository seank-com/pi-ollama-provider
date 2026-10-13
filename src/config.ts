import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { OllamaProviderError } from "./errors.ts";

export const CONFIG_SUBDIRECTORY = "ollama-provider";
export const CONFIG_FILE_NAME = "config.json";
export const MAX_CONFIG_BYTES = 64 * 1024;

export const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000;
export type OllamaProviderMode = "standalone" | "require-observability";
export function validateOllamaProviderMode(value: unknown): OllamaProviderMode {
	if (value !== "standalone" && value !== "require-observability") throw new OllamaProviderError("CONFIG_INVALID", "mode must be standalone or require-observability");
	return value;
}

export interface OllamaModelConfig {
	readonly id: string;
	readonly displayName: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly reasoning: boolean;
}

export interface OllamaProviderConfig {
	readonly mode: OllamaProviderMode;
	readonly schemaVersion: 1;
	readonly configPath: string;
	/** Normalized origin, `http(s)://host[:port]`, with no trailing slash. */
	readonly baseUrl: string;
	readonly timeouts: { readonly metadataMs: number; readonly streamIdleMs: number };
	/** `null` omits `keep_alive` so the server's `OLLAMA_KEEP_ALIVE` decides. */
	readonly keepAlive: string | number | null;
	readonly models: ReadonlyMap<string, OllamaModelConfig>;
}

/** What one `lstat` or `fstat` observed. Tests inject these to cover POSIX policy on any platform. */
export interface InspectedEntry {
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly uid: number;
	readonly mode: number;
	readonly size: number;
	readonly dev: number;
	readonly ino: number;
}

export interface ConfigOpenFile {
	stat(): Promise<InspectedEntry>;
	/** Reads at most `limit` bytes from the start of the file. */
	read(limit: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

export interface ConfigFileSystem {
	readonly platform: string;
	currentUid(): number | undefined;
	realpath(path: string): Promise<string>;
	/** Returns undefined only when the entry does not exist; other failures throw. */
	lstat(path: string): Promise<InspectedEntry | undefined>;
	/** Opens read-only without following a final symlink. */
	openNoFollow(path: string): Promise<ConfigOpenFile>;
}

function inspected(info: Stats): InspectedEntry {
	return {
		kind: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
		uid: info.uid,
		mode: info.mode,
		size: info.size,
		dev: info.dev,
		ino: info.ino,
	};
}

export const nodeConfigFileSystem: ConfigFileSystem = {
	platform: process.platform,
	currentUid: () => process.getuid?.(),
	realpath: (path) => realpath(path),
	async lstat(path) {
		try {
			return inspected(await lstat(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	async openNoFollow(path) {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		return {
			stat: async () => inspected(await handle.stat()),
			async read(limit) {
				const bytes = Buffer.alloc(limit);
				let offset = 0;
				while (offset < limit) {
					const { bytesRead } = await handle.read(bytes, offset, limit - offset, offset);
					if (bytesRead === 0) break;
					offset += bytesRead;
				}
				return bytes.subarray(0, offset);
			},
			close: () => handle.close(),
		};
	},
};

export interface LoadOllamaProviderConfigOptions {
	/** Pi's exported `CONFIG_DIR_NAME`, passed in so this module does not import Pi. */
	configDirName: string;
	fileSystem?: ConfigFileSystem;
}

const invalid = (detail: string) => new OllamaProviderError("CONFIG_INVALID", detail);

async function inspect(fs: ConfigFileSystem, path: string): Promise<InspectedEntry | undefined> {
	try {
		return await fs.lstat(path);
	} catch {
		throw invalid("configuration path cannot be inspected");
	}
}

/**
 * Loads `<project>/<CONFIG_DIR_NAME>/ollama-provider/config.json` under the
 * same protection rules as the datastore and Telegram loaders: every directory
 * from the project root down is a real, user-owned directory that is not group
 * or world writable, the configuration directory is 0700 or stricter, and the
 * file is a user-owned regular file, 0600 or stricter, at most 64 KiB, whose
 * opened identity matches the inspected one. Throws `OllamaProviderError`.
 */
export async function loadOllamaProviderConfig(
	projectRoot: string,
	options: LoadOllamaProviderConfigOptions,
): Promise<OllamaProviderConfig> {
	const fs = options.fileSystem ?? nodeConfigFileSystem;
	if (fs.platform === "win32") {
		throw new OllamaProviderError("PLATFORM_UNSUPPORTED", "POSIX ownership and mode checks are unavailable on Windows");
	}
	const uid = fs.currentUid();
	if (uid === undefined) throw new OllamaProviderError("PLATFORM_UNSUPPORTED", "the current user ID is unavailable");
	const configDirName = options.configDirName;
	if (!configDirName || configDirName === "." || configDirName === ".." || /[\\/\0]/.test(configDirName)) {
		throw invalid("configuration directory name is not a single path component");
	}

	let root: string;
	try {
		root = await fs.realpath(projectRoot);
	} catch {
		throw invalid("project root cannot be resolved");
	}
	const directories = [
		{ path: root, privateMode: false },
		{ path: join(root, configDirName), privateMode: false },
		{ path: join(root, configDirName, CONFIG_SUBDIRECTORY), privateMode: true },
	];
	for (const directory of directories) {
		const info = await inspect(fs, directory.path);
		if (!info) throw new OllamaProviderError("CONFIG_MISSING");
		if (info.kind !== "directory" || info.uid !== uid || (info.mode & (directory.privateMode ? 0o077 : 0o022)) !== 0) {
			throw invalid("configuration directories must be user-owned real directories with protected modes");
		}
	}

	const configPath = join(root, configDirName, CONFIG_SUBDIRECTORY, CONFIG_FILE_NAME);
	const before = await inspect(fs, configPath);
	if (!before) throw new OllamaProviderError("CONFIG_MISSING");
	if (before.kind !== "file" || before.uid !== uid || (before.mode & 0o077) !== 0 || before.size > MAX_CONFIG_BYTES) {
		throw invalid("configuration file must be a user-owned regular file, mode 0600 or stricter, at most 64 KiB");
	}

	let handle: ConfigOpenFile;
	try {
		handle = await fs.openNoFollow(configPath);
	} catch {
		throw invalid("configuration file cannot be opened");
	}
	let bytes: Uint8Array;
	try {
		const current = await handle.stat();
		if (current.kind !== "file" || current.dev !== before.dev || current.ino !== before.ino || current.size > MAX_CONFIG_BYTES) {
			throw invalid("configuration file changed while it was being opened");
		}
		bytes = await handle.read(MAX_CONFIG_BYTES + 1);
		if (bytes.length !== current.size) throw invalid("configuration file changed while it was being read");
	} catch (error) {
		if (error instanceof OllamaProviderError) throw error;
		throw invalid("configuration file cannot be read");
	} finally {
		await handle.close().catch(() => undefined);
	}

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw invalid("configuration file is not valid UTF-8");
	}
	return parseOllamaProviderConfig(text, configPath);
}

/** Rejects duplicate object keys, which `JSON.parse` silently collapses. Call only on valid JSON. */
export function assertNoDuplicateJsonKeys(text: string): void {
	const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\"") {
			let end = index + 1;
			while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
			const frame = stack.at(-1);
			if (frame?.expectKey) {
				const key = JSON.parse(text.slice(index, end + 1)) as string;
				if (frame.keys.has(key)) throw invalid("duplicate JSON key");
				frame.keys.add(key);
				frame.expectKey = false;
			}
			index = end;
		} else if (char === "{") {
			stack.push({ keys: new Set(), expectKey: true });
		} else if (char === "[") {
			stack.push(null);
		} else if (char === "}" || char === "]") {
			stack.pop();
		} else if (char === ",") {
			const frame = stack.at(-1);
			if (frame) frame.expectKey = true;
		}
	}
}

const TOP_KEYS = new Set(["schemaVersion", "mode", "baseUrl", "timeouts", "keepAlive", "models"]);
const TIMEOUT_KEYS = new Set(["metadataMs", "streamIdleMs"]);
const MODEL_KEYS = new Set(["displayName", "contextWindow", "maxOutputTokens", "reasoning"]);
// No whitespace, C0/C1 controls, or bidirectional formatting characters.
const MODEL_REFERENCE = /^[^\s\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]{1,200}$/u;
const DISPLAY_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u;
const GO_DURATION = /^[-+]?(?:0|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/u;

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${what} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, what: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.has(key));
	if (unknown !== undefined) throw invalid(`${what} has an unknown field`);
}

function integer(value: unknown, min: number, max: number, what: string): number {
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw invalid(`${what} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

export function normalizeBaseUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
		throw invalid("baseUrl must be an absolute http or https URL");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid("baseUrl must be an absolute http or https URL");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw invalid("baseUrl must be an absolute http or https URL with a host");
	}
	if (url.username || url.password || value.includes("@")) throw invalid("baseUrl must not contain credentials");
	if (value.includes("?") || value.includes("#")) throw invalid("baseUrl must not contain a query or fragment");
	if (url.pathname !== "/") throw invalid("baseUrl must have an empty or / path");
	return `${url.protocol}//${url.host}`;
}

function keepAlive(value: unknown): string | number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw invalid("keepAlive must be an integer number of seconds");
		return value;
	}
	if (typeof value !== "string" || value.length > 64 || !GO_DURATION.test(value)) {
		throw invalid("keepAlive must be null, a Go duration string, or integer seconds");
	}
	return value;
}

/** Strict v1 schema (design Section 4). Throws `OllamaProviderError`. */
export function parseOllamaProviderConfig(text: string, configPath: string): OllamaProviderConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw invalid("configuration is not valid JSON");
	}
	assertNoDuplicateJsonKeys(text);
	const top = record(raw, "configuration");
	if (!Object.hasOwn(top, "schemaVersion")) throw invalid("schemaVersion is required");
	if (top.schemaVersion !== 1) throw new OllamaProviderError("CONFIG_VERSION_UNSUPPORTED");
	exactKeys(top, TOP_KEYS, "configuration");

	const baseUrl = normalizeBaseUrl(top.baseUrl);

	const timeoutsRaw = top.timeouts === undefined ? {} : record(top.timeouts, "timeouts");
	exactKeys(timeoutsRaw, TIMEOUT_KEYS, "timeouts");
	const timeouts = Object.freeze({
		metadataMs: timeoutsRaw.metadataMs === undefined
			? DEFAULT_METADATA_TIMEOUT_MS
			: integer(timeoutsRaw.metadataMs, 1_000, 30_000, "timeouts.metadataMs"),
		streamIdleMs: timeoutsRaw.streamIdleMs === undefined
			? DEFAULT_STREAM_IDLE_TIMEOUT_MS
			: integer(timeoutsRaw.streamIdleMs, 60_000, 3_600_000, "timeouts.streamIdleMs"),
	});

	const modelsRaw = record(top.models, "models");
	const models = new Map<string, OllamaModelConfig>();
	for (const [id, value] of Object.entries(modelsRaw)) {
		if (!MODEL_REFERENCE.test(id)) throw invalid("model keys must be 1-200 characters without whitespace or control characters");
		const model = record(value, "model");
		exactKeys(model, MODEL_KEYS, "model");
		const displayName = model.displayName;
		if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 200 || DISPLAY_NAME_FORBIDDEN.test(displayName)) {
			throw invalid("displayName must be 1-200 characters without control characters");
		}
		const contextWindow = integer(model.contextWindow, 2_048, 1_048_576, "contextWindow");
		const maxOutputTokens = integer(model.maxOutputTokens, 256, contextWindow, "maxOutputTokens");
		if (typeof model.reasoning !== "boolean") throw invalid("reasoning must be a boolean");
		models.set(id, Object.freeze({ id, displayName, contextWindow, maxOutputTokens, reasoning: model.reasoning }));
	}
	if (models.size === 0) throw invalid("models must declare at least one model");

	return Object.freeze({
		mode: top.mode === undefined ? "standalone" : validateOllamaProviderMode(top.mode),
		schemaVersion: 1,
		configPath,
		baseUrl,
		timeouts,
		keepAlive: keepAlive(top.keepAlive),
		models,
	});
}
