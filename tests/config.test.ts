import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
	assertNoDuplicateJsonKeys,
	loadOllamaProviderConfig,
	MAX_CONFIG_BYTES,
	normalizeBaseUrl,
	parseOllamaProviderConfig,
	type ConfigFileSystem,
	type InspectedEntry,
} from "../src/config.ts";
import { OllamaProviderError } from "../src/errors.ts";

const UID = 501;
const ROOT = "/project";
const CONFIG_DIR = join(ROOT, ".pi");
const PROVIDER_DIR = join(CONFIG_DIR, "ollama-provider");
const CONFIG_PATH = join(PROVIDER_DIR, "config.json");

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		baseUrl: "http://ollama.example.test:11434",
		timeouts: { metadataMs: 5000, streamIdleMs: 900000 },
		keepAlive: null,
		models: {
			"qwen3.8:32b": { displayName: "Qwen 3.8 (DGX)", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true },
		},
		...overrides,
	};
}

function parse(value: unknown) {
	return parseOllamaProviderConfig(typeof value === "string" ? value : JSON.stringify(value), CONFIG_PATH);
}

function assertCode(action: () => unknown, code: string) {
	assert.throws(action, (error: unknown) => error instanceof OllamaProviderError && error.code === code);
}

async function assertRejectsCode(action: () => Promise<unknown>, code: string) {
	await assert.rejects(action, (error: unknown) => {
		assert.ok(error instanceof OllamaProviderError, String(error));
		assert.equal(error.code, code);
		return true;
	});
}

function entry(kind: InspectedEntry["kind"], mode: number, extra: Partial<InspectedEntry> = {}): InspectedEntry {
	return { kind, uid: UID, mode, size: 0, dev: 1, ino: 1, ...extra };
}

interface FakeOptions {
	platform?: string;
	uid?: number | undefined;
	entries?: Record<string, InspectedEntry | undefined>;
	contents?: string;
	openedStat?: Partial<InspectedEntry>;
	readBytes?: Uint8Array;
	failOpen?: boolean;
}

function fakeFileSystem(options: FakeOptions = {}) {
	const contents = options.contents ?? JSON.stringify(validConfig());
	const bytes = options.readBytes ?? new TextEncoder().encode(contents);
	const entries: Record<string, InspectedEntry | undefined> = {
		[ROOT]: entry("directory", 0o40755, { ino: 10 }),
		[CONFIG_DIR]: entry("directory", 0o40755, { ino: 11 }),
		[PROVIDER_DIR]: entry("directory", 0o40700, { ino: 12 }),
		[CONFIG_PATH]: entry("file", 0o100600, { size: bytes.length, ino: 13 }),
		...options.entries,
	};
	const calls = { opened: 0, closed: 0, lstat: [] as string[] };
	const fs: ConfigFileSystem = {
		platform: options.platform ?? "darwin",
		currentUid: () => ("uid" in options ? options.uid : UID),
		realpath: async (path) => path,
		async lstat(path) {
			calls.lstat.push(path);
			return entries[path];
		},
		async openNoFollow() {
			if (options.failOpen) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
			calls.opened += 1;
			return {
				stat: async () => ({ ...entries[CONFIG_PATH]!, ...options.openedStat }),
				read: async (limit) => bytes.subarray(0, limit),
				close: async () => { calls.closed += 1; },
			};
		},
	};
	return { fs, calls };
}

const load = (fs: ConfigFileSystem) => loadOllamaProviderConfig(ROOT, { configDirName: ".pi", fileSystem: fs });

test("a valid configuration loads as an immutable normalized snapshot", async () => {
	const { fs, calls } = fakeFileSystem();
	const config = await load(fs);
	assert.equal(config.schemaVersion, 1);
	assert.equal(config.configPath, CONFIG_PATH);
	assert.equal(config.baseUrl, "http://ollama.example.test:11434");
	assert.deepEqual(config.timeouts, { metadataMs: 5000, streamIdleMs: 900000 });
	assert.equal(config.keepAlive, null);
	assert.deepEqual([...config.models.values()], [{
		id: "qwen3.8:32b",
		displayName: "Qwen 3.8 (DGX)",
		contextWindow: 65536,
		maxOutputTokens: 16384,
		reasoning: true,
	}]);
	assert.equal(Object.isFrozen(config), true);
	assert.equal(Object.isFrozen(config.timeouts), true);
	assert.equal(Object.isFrozen(config.models.get("qwen3.8:32b")), true);
	assert.deepEqual(calls.lstat, [ROOT, CONFIG_DIR, PROVIDER_DIR, CONFIG_PATH]);
	assert.equal(calls.closed, calls.opened);
});

test("win32 and a missing user ID are PLATFORM_UNSUPPORTED before any file access", async () => {
	const windows = fakeFileSystem({ platform: "win32" });
	await assertRejectsCode(() => load(windows.fs), "PLATFORM_UNSUPPORTED");
	assert.deepEqual(windows.calls.lstat, []);
	const noUid = fakeFileSystem({ uid: undefined });
	await assertRejectsCode(() => load(noUid.fs), "PLATFORM_UNSUPPORTED");
	assert.deepEqual(noUid.calls.lstat, []);
});

test("the real loader reports PLATFORM_UNSUPPORTED on Windows", { skip: process.platform !== "win32" }, async () => {
	await assertRejectsCode(() => loadOllamaProviderConfig(process.cwd(), { configDirName: ".pi" }), "PLATFORM_UNSUPPORTED");
});

test("missing directories or file are CONFIG_MISSING without opening anything", async () => {
	for (const path of [CONFIG_DIR, PROVIDER_DIR, CONFIG_PATH]) {
		const { fs, calls } = fakeFileSystem({ entries: { [path]: undefined } });
		await assertRejectsCode(() => load(fs), "CONFIG_MISSING");
		assert.equal(calls.opened, 0);
	}
});

test("ownership, mode, type, size, and identity rules fail closed", async () => {
	const cases: Array<[string, FakeOptions]> = [
		["project root group-writable", { entries: { [ROOT]: entry("directory", 0o40775) } }],
		["config dir world-writable", { entries: { [CONFIG_DIR]: entry("directory", 0o40757) } }],
		["config dir symlink", { entries: { [CONFIG_DIR]: entry("symlink", 0o120777) } }],
		["provider dir group-readable", { entries: { [PROVIDER_DIR]: entry("directory", 0o40750) } }],
		["provider dir other owner", { entries: { [PROVIDER_DIR]: entry("directory", 0o40700, { uid: 0 }) } }],
		["provider dir is a file", { entries: { [PROVIDER_DIR]: entry("file", 0o100700) } }],
		["file group-readable", { entries: { [CONFIG_PATH]: entry("file", 0o100640, { ino: 13 }) } }],
		["file other owner", { entries: { [CONFIG_PATH]: entry("file", 0o100600, { uid: 0, ino: 13 }) } }],
		["file symlink", { entries: { [CONFIG_PATH]: entry("symlink", 0o120600, { ino: 13 }) } }],
		["file is a directory", { entries: { [CONFIG_PATH]: entry("directory", 0o40700, { ino: 13 }) } }],
		["file too large", { entries: { [CONFIG_PATH]: entry("file", 0o100600, { size: MAX_CONFIG_BYTES + 1, ino: 13 }) } }],
		["opened inode differs", { openedStat: { ino: 99 } }],
		["opened device differs", { openedStat: { dev: 99 } }],
		["opened entry not a file", { openedStat: { kind: "other" } }],
		["file grew after inspection", { openedStat: { size: 3 }, readBytes: new TextEncoder().encode("{}   ") }],
		["open refuses a symlink", { failOpen: true }],
		["invalid UTF-8", { readBytes: new Uint8Array([0x7b, 0xff, 0x7d]) }],
	];
	for (const [label, options] of cases) {
		const { fs, calls } = fakeFileSystem(options);
		await assert.rejects(() => load(fs), (error: unknown) => {
			assert.ok(error instanceof OllamaProviderError, label);
			assert.equal(error.code, "CONFIG_INVALID", label);
			return true;
		});
		assert.equal(calls.closed, calls.opened, label);
	}
});

test("the configuration directory name must be one path component", async () => {
	for (const configDirName of ["", ".", "..", "a/b", "a\\b"]) {
		const { fs } = fakeFileSystem();
		await assertRejectsCode(() => loadOllamaProviderConfig(ROOT, { configDirName, fileSystem: fs }), "CONFIG_INVALID");
	}
});

test("unknown fields at every level and duplicate keys are rejected", () => {
	assertCode(() => parse(validConfig({ extra: true })), "CONFIG_INVALID");
	assertCode(() => parse(validConfig({ timeouts: { metadataMs: 5000, other: 1 } })), "CONFIG_INVALID");
	assertCode(() => parse(validConfig({
		models: { m: { displayName: "M", contextWindow: 4096, maxOutputTokens: 256, reasoning: false, tags: [] } },
	})), "CONFIG_INVALID");

	const text = JSON.stringify(validConfig());
	assertCode(() => parse(text.replace("\"keepAlive\":null", "\"keepAlive\":null,\"keepAlive\":\"5m\"")), "CONFIG_INVALID");
	assertCode(() => parse(text.replace("\"reasoning\":true", "\"reasoning\":true,\"reasoning\":false")), "CONFIG_INVALID");
	// Same key in sibling objects and escaped-equal keys.
	assertNoDuplicateJsonKeys("{\"a\":{\"x\":1},\"b\":{\"x\":2},\"c\":[{\"x\":1},{\"x\":2}],\"s\":\"\\\"x\\\"\"}");
	assert.throws(() => assertNoDuplicateJsonKeys("{\"a\":1,\"\\u0061\":2}"));
	assertCode(() => parse("{"), "CONFIG_INVALID");
	assertCode(() => parse("[]"), "CONFIG_INVALID");
});

test("schema version is required and only version 1 is supported", () => {
	const { schemaVersion: _, ...withoutVersion } = validConfig();
	assertCode(() => parse(withoutVersion), "CONFIG_INVALID");
	assertCode(() => parse(validConfig({ schemaVersion: 2 })), "CONFIG_VERSION_UNSUPPORTED");
	assertCode(() => parse(validConfig({ schemaVersion: 2, futureField: true })), "CONFIG_VERSION_UNSUPPORTED");
	assertCode(() => parse(validConfig({ schemaVersion: "1" })), "CONFIG_VERSION_UNSUPPORTED");
});

test("baseUrl rules normalize trailing slashes and reject everything else", () => {
	assert.equal(normalizeBaseUrl("http://ollama.example.test:11434"), "http://ollama.example.test:11434");
	assert.equal(normalizeBaseUrl("http://ollama.example.test:11434/"), "http://ollama.example.test:11434");
	assert.equal(normalizeBaseUrl("HTTPS://Example.LAN"), "https://example.lan");
	assert.equal(normalizeBaseUrl("http://192.0.2.20:11434"), "http://192.0.2.20:11434");
	assert.equal(normalizeBaseUrl("http://[fd00::1]:11434/"), "http://[fd00::1]:11434");
	for (const value of [
		undefined, 1, "", "dgx:11434", "//dgx:11434", "ftp://dgx", "file:///tmp/x", "http://",
		"http://user:pass@dgx:11434", "http://user@dgx:11434", "http://dgx:11434/?", "http://dgx:11434?x=1",
		"http://dgx:11434/#frag", "http://dgx:11434/api", "http://dgx:11434//", "http://dgx :11434",
		"http:\\\\dgx:11434", " http://dgx:11434", `http://${"a".repeat(2050)}`,
	]) {
		assertCode(() => normalizeBaseUrl(value), "CONFIG_INVALID");
	}
});

test("numeric bounds, model keys, display names, reasoning, and keepAlive are enforced", () => {
	const model = (fields: Record<string, unknown>) => validConfig({
		models: { "qwen3.8:32b": { displayName: "Q", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true, ...fields } },
	});
	for (const good of [
		model({ contextWindow: 2048, maxOutputTokens: 256 }),
		model({ contextWindow: 1_048_576, maxOutputTokens: 1_048_576 }),
		validConfig({ timeouts: { metadataMs: 1000, streamIdleMs: 60000 } }),
		validConfig({ timeouts: { metadataMs: 30000, streamIdleMs: 3600000 } }),
	]) {
		parse(good);
	}
	for (const bad of [
		model({ contextWindow: 2047 }),
		model({ contextWindow: 1_048_577 }),
		model({ contextWindow: 4096.5 }),
		model({ contextWindow: "65536" }),
		model({ maxOutputTokens: 255 }),
		model({ maxOutputTokens: 65537 }),
		model({ reasoning: "yes" }),
		model({ displayName: "" }),
		model({ displayName: "x".repeat(201) }),
		model({ displayName: "bad\nname" }),
		model({ displayName: 3 }),
		validConfig({ timeouts: { metadataMs: 999 } }),
		validConfig({ timeouts: { metadataMs: 30001 } }),
		validConfig({ timeouts: { streamIdleMs: 59999 } }),
		validConfig({ timeouts: { streamIdleMs: 3600001 } }),
		validConfig({ timeouts: [] }),
		validConfig({ models: {} }),
		validConfig({ models: [] }),
		validConfig({ models: { "has space": { displayName: "Q", contextWindow: 4096, maxOutputTokens: 256, reasoning: false } } }),
		validConfig({ models: { "tab\tname": { displayName: "Q", contextWindow: 4096, maxOutputTokens: 256, reasoning: false } } }),
		validConfig({ models: { ["m".repeat(201)]: { displayName: "Q", contextWindow: 4096, maxOutputTokens: 256, reasoning: false } } }),
		validConfig({ models: { m: "Q" } }),
		validConfig({ keepAlive: "5 minutes" }),
		validConfig({ keepAlive: "" }),
		validConfig({ keepAlive: 1.5 }),
		validConfig({ keepAlive: true }),
		validConfig({ keepAlive: {} }),
	]) {
		assertCode(() => parse(bad), "CONFIG_INVALID");
	}
	assert.equal(parse(model({ displayName: "x".repeat(200) })).models.size, 1);
	assert.equal(parse(validConfig({ models: { ["m".repeat(200)]: { displayName: "Q", contextWindow: 4096, maxOutputTokens: 256, reasoning: false } } })).models.size, 1);
});

test("optional fields take documented defaults and keepAlive accepts durations and seconds", () => {
	const { timeouts: _timeouts, keepAlive: _keepAlive, ...minimal } = validConfig();
	const config = parse(minimal);
	assert.deepEqual(config.timeouts, { metadataMs: 5000, streamIdleMs: 900000 });
	assert.equal(config.keepAlive, null);
	assert.deepEqual(parse(validConfig({ timeouts: {} })).timeouts, { metadataMs: 5000, streamIdleMs: 900000 });
	for (const value of ["5m", "1h30m", "-1m", "0", "300ms", "1.5h", -1, 0, 3600]) {
		assert.equal(parse(validConfig({ keepAlive: value })).keepAlive, value);
	}
});

test("model keys are exact references compared byte for byte", () => {
	const config = parse(validConfig({
		models: {
			"qwen3.8:32b": { displayName: "A", contextWindow: 4096, maxOutputTokens: 256, reasoning: false },
			"Qwen3.8:32b": { displayName: "B", contextWindow: 4096, maxOutputTokens: 256, reasoning: false },
			"registry.lan/library/qwen3.8:32b-q4_K_M": { displayName: "C", contextWindow: 4096, maxOutputTokens: 256, reasoning: false },
		},
	}));
	assert.deepEqual([...config.models.keys()], ["qwen3.8:32b", "Qwen3.8:32b", "registry.lan/library/qwen3.8:32b-q4_K_M"]);
});
