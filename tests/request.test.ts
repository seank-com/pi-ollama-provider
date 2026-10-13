import assert from "node:assert/strict";
import test from "node:test";

import { buildOllamaChatRequest, resolveThink, type PiModelView } from "../src/convert.ts";
import { OllamaProviderError } from "../src/errors.ts";

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const reasoningModel: PiModelView = { id: "qwen3.8:32b", contextWindow: 65536, reasoning: true };
const plainModel: PiModelView = { id: "llama4:8b", contextWindow: 8192, reasoning: false };

const readTool = {
	name: "read",
	description: "Read a file.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
};

function context(overrides: Record<string, unknown> = {}) {
	return { systemPrompt: "You are a test agent.", tools: [readTool], messages: [{ role: "user", content: "hi", timestamp: 1 }], ...overrides };
}

function assertNoUndefinedOrNull(value: unknown, path = "body"): void {
	assert.notEqual(value, undefined, path);
	assert.notEqual(value, null, path);
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) assertNoUndefinedOrNull(child, `${path}.${key}`);
	}
}

test("golden: reasoning model, thinking off, defaults", () => {
	const body = buildOllamaChatRequest(reasoningModel, context(), { keepAlive: null });
	assert.equal(JSON.stringify(body), JSON.stringify({
		model: "qwen3.8:32b",
		messages: [
			{ role: "system", content: "You are a test agent." },
			{ role: "user", content: "hi" },
		],
		tools: [{ type: "function", function: readTool }],
		stream: true,
		think: false,
		options: { num_ctx: 65536 },
		truncate: false,
	}));
	assertNoUndefinedOrNull(body);
	assert.equal(Object.hasOwn(body, "keep_alive"), false);
	assert.deepEqual(Object.keys(body.options), ["num_ctx"]);
});

test("golden: every optional key present", () => {
	const body = buildOllamaChatRequest(reasoningModel, context(), {
		reasoning: "high",
		temperature: 0.2,
		maxTokens: 4096,
		keepAlive: "30m",
	});
	assert.equal(JSON.stringify(body), JSON.stringify({
		model: "qwen3.8:32b",
		messages: [
			{ role: "system", content: "You are a test agent." },
			{ role: "user", content: "hi" },
		],
		tools: [{ type: "function", function: readTool }],
		stream: true,
		think: true,
		options: { num_ctx: 65536, temperature: 0.2, num_predict: 4096 },
		keep_alive: "30m",
		truncate: false,
	}));
	assert.equal(buildOllamaChatRequest(reasoningModel, context(), { keepAlive: -1 }).keep_alive, -1);
	assert.equal(buildOllamaChatRequest(reasoningModel, context(), { keepAlive: 0, temperature: 0 }).options.temperature, 0);
});

test("golden: non-reasoning model without tools or system prompt omits think, tools, and the system message", () => {
	const body = buildOllamaChatRequest(plainModel, context({ systemPrompt: "", tools: [] }), { reasoning: "high", keepAlive: null });
	assert.equal(JSON.stringify(body), JSON.stringify({
		model: "llama4:8b",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		options: { num_ctx: 8192 },
		truncate: false,
	}));
	const withoutTools = buildOllamaChatRequest(plainModel, { messages: [] }, { keepAlive: null });
	assert.equal(Object.hasOwn(withoutTools, "tools"), false);
	assert.deepEqual(withoutTools.messages, []);
});

test("num_ctx always equals the model contextWindow and truncate is always false", () => {
	for (const contextWindow of [2048, 65536, 1_048_576]) {
		const body = buildOllamaChatRequest({ ...plainModel, contextWindow }, context(), { maxTokens: 256, keepAlive: null });
		assert.equal(body.options.num_ctx, contextWindow);
		assert.equal(body.truncate, false);
		assert.equal(body.stream, true);
	}
});

test("think for every Pi level and model kind", () => {
	// Non-reasoning models never send think.
	for (const level of [undefined, ...PI_LEVELS]) assert.equal(resolveThink(plainModel, level), undefined);
	// Reasoning model without reported values: off is false, every other level is true.
	assert.equal(resolveThink(reasoningModel, undefined), false);
	for (const level of PI_LEVELS) assert.equal(resolveThink(reasoningModel, level), level !== "off");

	// Reported values: a level maps to its string; unsupported levels fail; off sends false.
	const leveled: PiModelView = {
		...reasoningModel,
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	};
	assert.equal(resolveThink(leveled, undefined), false);
	assert.equal(resolveThink(leveled, "off"), false);
	assert.equal(resolveThink(leveled, "low"), "low");
	assert.equal(resolveThink(leveled, "high"), "high");
	for (const level of ["minimal", "xhigh", "max", "unknown-level"]) {
		assert.throws(() => resolveThink(leveled, level), (error: unknown) =>
			error instanceof OllamaProviderError && error.code === "CONTEXT_CONVERSION_FAILED");
	}
	// A model that cannot disable thinking omits think when Pi asks for off.
	assert.equal(resolveThink({ ...leveled, thinkingLevelMap: { ...leveled.thinkingLevelMap, off: null } }, undefined), undefined);

	const body = buildOllamaChatRequest(leveled, context(), { reasoning: "medium", keepAlive: null });
	assert.equal(body.think, "medium");
});

test("invalid per-turn sampling options fail conversion before any hook runs", () => {
	for (const options of [
		{ temperature: Number.NaN },
		{ temperature: Number.POSITIVE_INFINITY },
		{ temperature: "0.2" },
		{ maxTokens: 0 },
		{ maxTokens: 1.5 },
		{ maxTokens: -1 },
	]) {
		assert.throws(
			() => buildOllamaChatRequest(plainModel, context(), { keepAlive: null, ...(options as any) }),
			(error: unknown) => error instanceof OllamaProviderError && error.code === "CONTEXT_CONVERSION_FAILED",
		);
	}
});

test("the built body never aliases Pi's live tool or message objects", () => {
	const piContext = context({
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "ollama_1", name: "read", arguments: { path: "a" } }], stopReason: "toolUse", timestamp: 1 },
		],
	});
	const snapshot = structuredClone(piContext);
	const body = buildOllamaChatRequest(reasoningModel, piContext, { keepAlive: null });
	(body.tools![0].function.parameters as any).properties.intent = { type: "string" };
	(body.messages[2].tool_calls![0].function.arguments as any).intent = "x";
	assert.deepEqual(piContext, snapshot);
});
