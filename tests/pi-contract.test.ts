import assert from "node:assert/strict";
import test from "node:test";

import { buildOllamaChatRequest, normalizePiContext } from "../src/convert.ts";
import { OllamaProviderError, serverError } from "../src/errors.ts";
import { streamOllamaChat, type PiAssistantMessage } from "../src/stream.ts";
import { importPi, importPiAi } from "./pi-host.ts";

// Pins the provider to the installed host Pi (0.87.1 in production): its
// transcript helpers, overflow detector, event stream, built-in tool schemas,
// and real payload serializers. No network: serializers are stopped by a
// throwing onPayload before any request is sent.

const BUILT_IN_TOOLS = ["Read", "Bash", "Edit", "Write", "Grep", "Find", "Ls"];
const MODEL = { id: "qwen-test:latest", contextWindow: 8192, reasoning: false };

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function jsonOf<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

async function realTools() {
	const pi = await importPi();
	return BUILT_IN_TOOLS.map((name) => {
		const definition = pi[`create${name}ToolDefinition`](process.cwd());
		return { name: definition.name as string, description: definition.description as string, parameters: jsonOf(definition.parameters) as Record<string, unknown> };
	});
}

function assistantToolCall(id: string) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.txt" } }], api: "x", provider: "x", model: "m", usage, stopReason: "toolUse", timestamp: 2 };
}

test("U3: transcript normalization matches the host getCurrentSystemPrompt and getCurrentTools", async () => {
	const ai = await importPiAi();
	const tools = await realTools();
	const [read, bash, edit] = tools;
	const transcripts: Array<{ name: string; context: { messages: unknown[] } }> = [
		{ name: "legacy fields folded by the host", context: ai.normalizeContext({ systemPrompt: "Base prompt.", tools: [read, bash], messages: [{ role: "user", content: "hi", timestamp: 1 }] }) },
		{ name: "empty", context: ai.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }) },
		{
			name: "sections, content blocks, and mid-conversation changes",
			context: {
				messages: [
					{ role: "system", content: [{ type: "text", text: "Line one." }, { type: "text", text: "Line two." }], sections: { skills: "Skills A.", memory: "Memory A." }, toolsAdded: [read, bash], timestamp: 1 },
					{ role: "user", content: "hi", timestamp: 2 },
					assistantToolCall("call_1"),
					{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
					{ role: "system", content: "Appended guidance.", sections: { skills: "Skills B.", memory: null }, toolsRemoved: [{ name: "bash" }], toolsAdded: [edit], timestamp: 4 },
					{ role: "user", content: "again", timestamp: 5 },
					{ role: "system", content: "", toolsAdded: [{ ...read, description: "Redefined read." }], timestamp: 6 },
				],
			},
		},
	];
	for (const { name, context } of transcripts) {
		const ours = normalizePiContext(context);
		assert.equal(ours.systemPrompt, ai.getCurrentSystemPrompt(context.messages), name);
		assert.deepEqual(jsonOf(ours.tools), jsonOf(ai.getCurrentTools(context.messages)), name);
		assert.deepEqual(ours.messages, context.messages.filter((message: any) => message.role !== "system"), name);
	}
});

test("overflow parity: CONTEXT_OVERFLOW messages satisfy the host isContextOverflow; other failures do not", async () => {
	const ai = await importPiAi();
	const asMessage = (error: OllamaProviderError) => ({ role: "assistant", content: [], api: "pi-ollama-chat", provider: "ollama", model: MODEL.id, usage, stopReason: "error", errorMessage: error.message, timestamp: 1 });
	for (const text of [
		// Synthetic nested native overflow response with truncate:false.
		"{\"error\":\"{\\\"error\\\":{\\\"code\\\":400,\\\"message\\\":\\\"request (5517 tokens) exceeds the available context size (512 tokens), try increasing it\\\",\\\"type\\\":\\\"exceed_context_size_error\\\",\\\"n_prompt_tokens\\\":5517,\\\"n_ctx\\\":512}}\"}",
		"{\"error\":\"prompt too long; exceeded max context length by 412 tokens\"}",
		"{\"error\":\"the input length exceeds the context length\"}",
		"context length exceeded",
	]) {
		const error = serverError(text, 400);
		assert.equal(error.code, "CONTEXT_OVERFLOW", text);
		assert.equal(ai.isContextOverflow(asMessage(error), MODEL.contextWindow), true, text);
	}
	for (const [text, status] of [["{\"error\":\"requested context size too large for model\"}", 500], ["{\"error\":\"model is loading\"}", 503], ["rate limited", 429]] as const) {
		const error = serverError(text, status);
		assert.notEqual(error.code, "CONTEXT_OVERFLOW", text);
		assert.equal(ai.isContextOverflow(asMessage(error), MODEL.contextWindow), false, text);
	}
});

test("U3: the provider's events drive the host AssistantMessageEventStream to its result", async () => {
	const ai = await importPiAi();
	const body = [
		{ message: { role: "assistant", thinking: "plan" }, done: false },
		{ message: { role: "assistant", content: "answer" }, done: false },
		{ done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
	].map((line) => `${JSON.stringify({ model: MODEL.id, ...line })}\n`).join("");
	const run = async (response: Response, signal?: AbortSignal) => {
		const stream = ai.createAssistantMessageEventStream();
		void streamOllamaChat({
			fetch: async () => response, baseUrl: "http://127.0.0.1:9", keepAlive: null, streamIdleMs: 60_000,
			models: new Map([[MODEL.id, MODEL]]),
		}, { id: MODEL.id, provider: "ollama" }, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { onPayload: () => undefined, signal }, stream);
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		return { types, message: await stream.result() as PiAssistantMessage };
	};
	const done = await run(new Response(body));
	assert.deepEqual(done.types, ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	assert.deepEqual(done.message.content, [{ type: "thinking", thinking: "plan" }, { type: "text", text: "answer" }]);
	assert.equal(done.message.stopReason, "stop");

	const truncated = await run(new Response(body.split("\n")[1] + "\n"));
	assert.deepEqual(truncated.types, ["start", "text_start", "text_delta", "error"]);
	assert.equal(truncated.message.stopReason, "error");
	assert.match(truncated.message.errorMessage ?? "", /^STREAM_TRUNCATED/);
});
