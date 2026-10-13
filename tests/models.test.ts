import assert from "node:assert/strict";
import test from "node:test";

import type { FetchLike, ShowResult } from "../src/client.ts";
import { parseOllamaProviderConfig, type ConfigFileSystem, type OllamaModelConfig } from "../src/config.ts";
import { createOllamaProviderExtension, STATUS_KEY } from "../src/extension.ts";
import {
	buildThinkingLevelMap,
	formatRegistrationStatus,
	piModelDefinition,
	validateConfiguredModels,
	validateShowResult,
} from "../src/models.ts";

const reasoningModel: OllamaModelConfig = { id: "qwen3.8:32b", displayName: "Qwen", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true };
const plainModel: OllamaModelConfig = { ...reasoningModel, id: "llama4:8b", displayName: "Llama", reasoning: false };

function show(overrides: Record<string, unknown> = {}): ShowResult {
	return {
		kind: "ok",
		body: {
			capabilities: ["completion", "tools", "thinking"],
			model_info: { "general.architecture": "qwen3", "qwen3.context_length": 131072 },
			...overrides,
		},
	};
}

function configText(models: Record<string, unknown>) {
	return JSON.stringify({ schemaVersion: 1, baseUrl: "http://dgx.test:11434/", models });
}

test("design 8 validation table", () => {
	assert.deepEqual(validateShowResult(reasoningModel, { kind: "unreachable", detail: "timed out" }), {
		status: "unverified", model: reasoningModel, unmappedThinkingValues: [], detail: "timed out",
	});
	assert.deepEqual(validateShowResult(reasoningModel, show()), { status: "verified", model: reasoningModel, unmappedThinkingValues: [] });
	const rejected = (result: ShowResult, model = reasoningModel) => {
		const validation = validateShowResult(model, result);
		assert.equal(validation.status, "rejected");
		return validation.status === "rejected" ? validation.code : undefined;
	};
	assert.equal(rejected({ kind: "not_found" }), "MODEL_UNAVAILABLE");
	assert.equal(rejected(show({ capabilities: ["completion", "thinking"] })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ capabilities: ["tools", "thinking"] })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ capabilities: undefined })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ capabilities: ["completion", "tools"] })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ model_info: { "qwen3.context_length": 32768 } })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ model_info: {} })), "MODEL_CAPABILITY_MISMATCH");
	assert.equal(rejected(show({ model_info: { "a.context_length": 131072, "b.context_length": 65536 } })), "MODEL_CAPABILITY_MISMATCH");
	// The server answered without usable metadata: a fault, never the unverified availability path.
	assert.equal(rejected({ kind: "invalid", code: "METADATA_INVALID", detail: "response is not JSON" }), "METADATA_INVALID");
	assert.equal(rejected({ kind: "invalid", code: "HTTP_ERROR", detail: "HTTP 500" }), "HTTP_ERROR");
	// Non-reasoning models need no thinking capability; an exactly equal context is allowed.
	assert.equal(validateShowResult(plainModel, show({ capabilities: ["completion", "tools"], model_info: { "llama.context_length": 65536 } })).status, "verified");
	// No name-based guessing: a "qwen" name with no capabilities is still rejected.
	assert.equal(rejected({ kind: "ok", body: { model_info: { "qwen3.context_length": 131072 } } }), "MODEL_CAPABILITY_MISMATCH");
});

test("thinking map construction from reported values", () => {
	assert.deepEqual(buildThinkingLevelMap(["low", "medium", "high"]), {
		map: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		unmapped: [],
	});
	assert.deepEqual(buildThinkingLevelMap(["high", "turbo", "off"]).unmapped, ["turbo"]);

	const verified = validateShowResult(reasoningModel, show({ thinking: { values: ["low", "high", "ultra", 3] } }));
	assert.equal(verified.status, "verified");
	assert.deepEqual(verified.status === "verified" && verified.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
	assert.deepEqual(verified.status === "verified" && verified.unmappedThinkingValues, ["ultra"]);
	// Non-reasoning models never get a map, and unreachable registration is on/off only.
	const plain = validateShowResult(plainModel, show({ thinking: { values: ["high"] } }));
	assert.equal(plain.status === "verified" && plain.thinkingLevelMap, undefined);
	const config = parseOllamaProviderConfig(configText({ [reasoningModel.id]: { displayName: "Qwen", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true } }), "/c");
	const unverified = piModelDefinition(config, validateShowResult(reasoningModel, { kind: "unreachable", detail: "x" }));
	assert.equal(Object.hasOwn(unverified, "thinkingLevelMap"), false);
});

test("Pi model definitions follow design Section 5", () => {
	const config = parseOllamaProviderConfig(configText({ [reasoningModel.id]: { displayName: "Qwen", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true } }), "/c");
	const definition = piModelDefinition(config, validateShowResult(reasoningModel, show({ thinking: { values: ["high"] } })));
	assert.deepEqual(definition, {
		id: "qwen3.8:32b",
		name: "Qwen",
		api: "pi-ollama-chat",
		baseUrl: "http://dgx.test:11434",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	});
});

test("validation calls /api/show once per model in parallel, bounded by metadataMs", async () => {
	const config = parseOllamaProviderConfig(JSON.stringify({
		schemaVersion: 1,
		baseUrl: "http://dgx.test:11434",
		timeouts: { metadataMs: 1000 },
		models: {
			"qwen3.8:32b": { displayName: "Qwen", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true },
			"llama4:8b": { displayName: "Llama", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false },
			"missing:1b": { displayName: "Missing", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false },
			"slow:1b": { displayName: "Slow", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false },
		},
	}), "/c");
	const requests: Array<{ url: string; body: string }> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetch: FetchLike = (url, init) => {
		requests.push({ url, body: init.body });
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const model = JSON.parse(init.body).model;
		return new Promise<Response>((resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				inFlight -= 1;
				reject(new DOMException("aborted", "AbortError"));
			});
			if (model === "slow:1b") return;
			setTimeout(() => {
				inFlight -= 1;
				if (model === "missing:1b") resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
				else resolve(new Response(JSON.stringify((show() as any).body)));
			}, 5);
		});
	};
	const started = Date.now();
	const validations = await validateConfiguredModels(config, fetch);
	assert.ok(Date.now() - started < 3_000);
	assert.deepEqual(validations.map((validation) => [validation.model.id, validation.status]), [
		["qwen3.8:32b", "verified"],
		["llama4:8b", "verified"],
		["missing:1b", "rejected"],
		["slow:1b", "unverified"],
	]);
	assert.equal(maxInFlight, 4);
	assert.ok(requests.every((request) => request.url === "http://dgx.test:11434/api/show"));
	assert.deepEqual(requests.map((request) => JSON.parse(request.body)), [
		{ model: "qwen3.8:32b" }, { model: "llama4:8b" }, { model: "missing:1b" }, { model: "slow:1b" },
	]);

	const status = formatRegistrationStatus(config, validations);
	assert.equal(status, "Ollama dgx.test:11434: qwen3.8:32b verified; llama4:8b verified; missing:1b rejected (MODEL_UNAVAILABLE); slow:1b unverified");
	assert.equal(status.includes("http:"), false);
});

// ---------------------------------------------------------------------------
// Registration through the extension factory

function fakeFs(contents: string | undefined, platform = "darwin"): ConfigFileSystem {
	const bytes = new TextEncoder().encode(contents ?? "");
	const entry = (kind: "file" | "directory", mode: number) => ({ kind, uid: 501, mode, size: kind === "file" ? bytes.length : 0, dev: 1, ino: kind === "file" ? 2 : 1 });
	return {
		platform,
		currentUid: () => 501,
		realpath: async (path) => path,
		lstat: async (path) => {
			if (path.endsWith("config.json")) return contents === undefined ? undefined : entry("file", 0o100600);
			return entry("directory", path.endsWith("ollama-provider") ? 0o40700 : 0o40755);
		},
		openNoFollow: async () => ({
			stat: async () => entry("file", 0o100600),
			read: async (limit) => bytes.subarray(0, limit),
			close: async () => undefined,
		}),
	};
}

function fakePi() {
	const registered: Array<{ name: string; config: any }> = [];
	const handlers: Array<(event: unknown, ctx: any) => void> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const pi = {
		registerProvider(name: string, config: any) {
			registered.push({ name, config });
		},
		on(event: string, handler: (event: unknown, ctx: any) => void) {
			if (event === "session_start") handlers.push(handler);
		},
	};
	const sessionStart = () => {
		for (const handler of handlers) handler({ type: "session_start", reason: "startup" }, { ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) } });
	};
	return { pi, registered, statuses, sessionStart };
}

const noFetch: FetchLike = async () => {
	throw new Error("unexpected network access");
};

test("missing configuration registers nothing, reports nothing, and makes no request", async () => {
	const { pi, registered, statuses, sessionStart } = fakePi();
	await createOllamaProviderExtension({ configDirName: ".pi", createEventStream: () => ({ push() {}, end() {} }), projectRoot: "/p", fetch: noFetch, fileSystem: fakeFs(undefined) })(pi);
	sessionStart();
	assert.deepEqual(registered, []);
	assert.deepEqual(statuses, []);
});

test("invalid configuration and Windows are reported as disabled without network access", async () => {
	for (const [fs, code] of [
		[fakeFs("{\"schemaVersion\":1}"), "CONFIG_INVALID"],
		[fakeFs("{\"schemaVersion\":9}"), "CONFIG_VERSION_UNSUPPORTED"],
		[fakeFs(configText({}), "win32"), "PLATFORM_UNSUPPORTED"],
	] as const) {
		const { pi, registered, statuses, sessionStart } = fakePi();
		await createOllamaProviderExtension({ configDirName: ".pi", createEventStream: () => ({ push() {}, end() {} }), projectRoot: "/p", fetch: noFetch, fileSystem: fs })(pi);
		sessionStart();
		assert.deepEqual(registered, []);
		assert.deepEqual(statuses, [[STATUS_KEY, `Ollama disabled (${code})`]]);
	}
});

test("validated models register under provider ollama with API pi-ollama-chat; rejected ones do not", async () => {
	const contents = configText({
		"qwen3.8:32b": { displayName: "Qwen", contextWindow: 65536, maxOutputTokens: 16384, reasoning: true },
		"missing:1b": { displayName: "Missing", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false },
	});
	const fetch: FetchLike = async (_url, init) => _url.endsWith("/api/chat")
		? new Response(JSON.stringify({model:"qwen3.8:32b",message:{role:"assistant",content:"fixture"},done:true,done_reason:"stop"})+"\n")
		: JSON.parse(init.body).model === "missing:1b"
		? new Response("{}", { status: 404 })
		: new Response(JSON.stringify((show({ thinking: { values: ["high"] } }) as any).body));
	const streams: unknown[] = [];
	const { pi, registered, statuses, sessionStart } = fakePi();
	await createOllamaProviderExtension({
		configDirName: ".pi",
		createEventStream: () => {
			const stream = { events: [] as unknown[], push(event: unknown) { this.events.push(event); }, end() {} };
			streams.push(stream);
			return stream;
		},
		projectRoot: "/p",
		fetch,
		fileSystem: fakeFs(contents),
	})(pi);
	sessionStart();
	assert.equal(registered.length, 1);
	const { name, config } = registered[0];
	assert.equal(name, "ollama");
	assert.equal(config.api, "pi-ollama-chat");
	assert.equal(config.baseUrl, "http://dgx.test:11434");
	assert.equal(config.apiKey, "unused");
	assert.deepEqual(config.models.map((model: any) => model.id), ["qwen3.8:32b"]);
	assert.equal(config.models[0].thinkingLevelMap.high, "high");
	assert.deepEqual(statuses, [[STATUS_KEY, "Ollama dgx.test:11434: qwen3.8:32b verified; missing:1b rejected (MODEL_UNAVAILABLE)"]]);

	// streamSimple returns the bound Pi stream synchronously and always terminates it.
	const stream: any = config.streamSimple({ id: "qwen3.8:32b", provider: "ollama" }, { messages: [] }, {});
	assert.equal(stream, streams[0]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(stream.events.at(-1).type, "done");
});

test("a configuration whose every model is rejected registers no provider but reports status", async () => {
	const contents = configText({ "missing:1b": { displayName: "Missing", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false } });
	const { pi, registered, statuses, sessionStart } = fakePi();
	await createOllamaProviderExtension({
		configDirName: ".pi",
		createEventStream: () => ({ push() {}, end() {} }),
		projectRoot: "/p",
		fetch: async () => new Response("{}", { status: 404 }),
		fileSystem: fakeFs(contents),
	})(pi);
	sessionStart();
	assert.deepEqual(registered, []);
	assert.deepEqual(statuses, [[STATUS_KEY, "Ollama dgx.test:11434: missing:1b rejected (MODEL_UNAVAILABLE)"]]);
});
