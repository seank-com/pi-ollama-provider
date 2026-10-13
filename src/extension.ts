import { resolve } from "node:path";

import { OLLAMA_API_ID, OLLAMA_PROVIDER_NAME } from "./contract.ts";
import type { FetchLike } from "./client.ts";
import { loadOllamaProviderConfig, validateOllamaProviderMode, type ConfigFileSystem, type OllamaProviderConfig, type OllamaProviderMode } from "./config.ts";
import { queryObservabilityPolicy, type ObservabilityBus } from "./observability.ts";
import { OllamaProviderError } from "./errors.ts";
import { formatRegistrationStatus, piModelDefinition, validateConfiguredModels } from "./models.ts";
import { streamOllamaChat, type PiEventSink, type PiStreamModel, type PiStreamOptions } from "./stream.ts";

export const STATUS_KEY = "ollama-provider";

/** The slice of Pi's ExtensionAPI this extension uses. */
export interface OllamaProviderPi {
	events?: ObservabilityBus;
	registerProvider(name: string, config: Record<string, unknown>): void;
	on(event: "session_start" | "resources_discover" | "session_shutdown", handler: (event: unknown, ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => void): void;
}

export interface OllamaProviderExtensionOptions<TStream extends PiEventSink> {
	/** Pi's exported `CONFIG_DIR_NAME`. */
	configDirName: string;
	/** Pi's `createAssistantMessageEventStream`. */
	createEventStream: () => TStream;
	/** Injected project root; defaults once to the process launch directory. */
	projectRoot?: string;
	fetch?: FetchLike;
	fileSystem?: ConfigFileSystem;
	/** Private assembly may enforce strict mode regardless of public config. */
	mode?: OllamaProviderMode;
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * Loads one immutable configuration snapshot per session runtime, validates
 * each configured model against `/api/show`, registers the ones that pass,
 * and reports per-model state at `session_start`. Missing configuration
 * registers nothing and performs no network access.
 */
export function createOllamaProviderExtension<TStream extends PiEventSink>(options: OllamaProviderExtensionOptions<TStream>) {
	return async (pi: OllamaProviderPi): Promise<void> => {
		const projectRoot = resolve(options.projectRoot ?? process.cwd());
		const fetch = options.fetch ?? defaultFetch;
		let lifecycle = new AbortController();
		let active = true;
		const overrideMode = options.mode === undefined ? undefined : validateOllamaProviderMode(options.mode);
		let mode: OllamaProviderMode = overrideMode ?? "standalone";
		let status: string | undefined;
		pi.on("session_start", (_event, ctx) => {
			if (!active) lifecycle = new AbortController();
			active = true;
			if (status !== undefined) ctx.ui.setStatus(STATUS_KEY, status);
		});
		pi.on("resources_discover", (_event, ctx) => {
			if (mode === "require-observability" && !queryObservabilityPolicy(pi.events)) ctx.ui.setStatus(STATUS_KEY, "Ollama blocked (OBSERVABILITY_UNAVAILABLE)");
			else if (status !== undefined) ctx.ui.setStatus(STATUS_KEY, status);
		});
		pi.on("session_shutdown", () => { active = false; lifecycle.abort(); });

		let config: OllamaProviderConfig;
		try {
			config = await loadOllamaProviderConfig(projectRoot, { configDirName: options.configDirName, fileSystem: options.fileSystem });
		} catch (error) {
			const code = error instanceof OllamaProviderError ? error.code : "CONFIG_INVALID";
			if (code !== "CONFIG_MISSING") status = `Ollama disabled (${code})`;
			return;
		}

		mode = overrideMode ?? config.mode;

		const validations = await validateConfiguredModels(config, fetch);
		status = formatRegistrationStatus(config, validations);
		const accepted = validations.filter((validation) => validation.status !== "rejected");
		if (accepted.length === 0) return;

		const deps = {
			mode,
			observability: () => active ? queryObservabilityPolicy(pi.events) : undefined,
			fetch,
			baseUrl: config.baseUrl,
			keepAlive: config.keepAlive,
			streamIdleMs: config.timeouts.streamIdleMs,
			models: new Map(accepted.map((validation) => [validation.model.id, validation.model])),
		};
		const streamSimple = (model: PiStreamModel, context: unknown, streamOptions?: PiStreamOptions): TStream => {
			const stream = options.createEventStream();
			const signal = streamOptions?.signal ? AbortSignal.any([streamOptions.signal, lifecycle.signal]) : lifecycle.signal;
			void streamOllamaChat(deps, model, context, { ...streamOptions, signal }, stream);
			return stream;
		};
		pi.registerProvider(OLLAMA_PROVIDER_NAME, {
			name: "Ollama",
			api: OLLAMA_API_ID,
			baseUrl: config.baseUrl,
			// Pi requires an API key when models are defined. It is never sent.
			apiKey: "unused",
			streamSimple,
			models: accepted.map((validation) => piModelDefinition(config, validation)),
		});
	};
}
