import assert from "node:assert/strict";
import test from "node:test";

import type { FetchLike } from "../src/client.ts";
import {
	MAX_NDJSON_LINE_LENGTH,
	mintOllamaToolCallId,
	streamOllamaChat,
	type PiAssistantEvent,
	type PiStreamOptions,
	type StreamDependencies,
} from "../src/stream.ts";

const BASE_URL = "http://dgx.test:11434";
const MODEL_ID = "qwen3.8:32b";
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9_|-]{1,128}$/;
// Copied from Pi's isContextOverflow; pi-contract.test.ts pins it to the installed host pi-ai.
const PI_OLLAMA_OVERFLOW = /prompt too long; exceeded (?:max )?context length/i;

const piModel = { id: MODEL_ID, provider: "ollama", api: "pi-ollama-chat", baseUrl: "http://attacker.invalid:1" };
const piContext = {
	systemPrompt: "You are a test agent.",
	tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } }],
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

type Body = { chunks: Array<string | Uint8Array>; hang?: boolean; error?: Error };

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function chunk(message: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
	return line({ model: MODEL_ID, created_at: "2026-09-29T00:00:00Z", ...(message ? { message: { role: "assistant", ...message } } : {}), done: false, ...extra });
}

function doneChunk(extra: Record<string, unknown> = {}) {
	return line({ model: MODEL_ID, created_at: "2026-09-29T00:00:01Z", done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 7, ...extra });
}

function bodyStream({ chunks, hang, error }: Body): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				const next = chunks[index++];
				controller.enqueue(typeof next === "string" ? encoder.encode(next) : next);
				return;
			}
			if (error) {
				controller.error(error);
				return;
			}
			if (hang) return new Promise(() => undefined);
			controller.close();
		},
	});
}

interface FetchCall {
	url: string;
	init: Parameters<FetchLike>[1];
}

function scriptedFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const fetch: FetchLike = (url, init) => {
		const call = { url, init };
		calls.push(call);
		if (init.signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
		return new Promise((resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			Promise.resolve(respond(call)).then(resolve, reject);
		});
	};
	return { fetch, calls };
}

function ndjson(body: Body, status = 200) {
	return scriptedFetch(() => new Response(bodyStream(body), { status, headers: { "content-type": "application/x-ndjson" } }));
}

function deps(fetch: FetchLike, overrides: Partial<StreamDependencies> = {}): StreamDependencies {
	return {
		fetch,
		baseUrl: BASE_URL,
		keepAlive: null,
		streamIdleMs: 5_000,
		models: new Map([[MODEL_ID, { id: MODEL_ID, contextWindow: 65536, reasoning: true }]]),
		now: () => 1_000,
		...overrides,
	};
}

async function run(fetch: FetchLike, options: PiStreamOptions & { deps?: Partial<StreamDependencies> } = {}, context: unknown = piContext) {
	const events: PiAssistantEvent[] = [];
	let ends = 0;
	let pushedAfterEnd = false;
	const hookCalls: unknown[] = [];
	const { deps: depOverrides, ...rest } = options;
	const streamOptions: PiStreamOptions = {
		onPayload: (payload) => {
			hookCalls.push(payload);
			return undefined;
		},
		...rest,
	};
	await streamOllamaChat(deps(fetch, depOverrides), piModel, context, streamOptions, {
		push(event) {
			if (ends > 0) pushedAfterEnd = true;
			events.push(event);
		},
		end() {
			ends += 1;
		},
	});
	const terminals = events.filter((event) => event.type === "done" || event.type === "error");
	assert.equal(terminals.length, 1, "exactly one terminal event");
	assert.equal(ends, 1, "exactly one end()");
	assert.equal(pushedAfterEnd, false, "no event after end()");
	assert.equal(events.at(-1), terminals[0], "terminal event is last");
	const startIndex = events.findIndex((event) => event.type === "start");
	if (terminals[0].type === "done") assert.equal(startIndex, 0, "start precedes every update");
	else assert.ok(startIndex === -1 || startIndex === 0);
	const terminal = terminals[0];
	const message = terminal.type === "done" ? terminal.message : terminal.error;
	return { events, terminal, message, hookCalls };
}

function errorCode(message: { errorMessage?: string }): string | undefined {
	return message.errorMessage?.split(":")[0];
}

function types(events: PiAssistantEvent[]) {
	return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// Text, thinking, and block indices

test("text streams as one block with usage mapping and a stop reason", async () => {
	const { fetch } = ndjson({ chunks: [chunk({ content: "Hel" }), chunk({ content: "lo" }), doneChunk()] });
	const { events, terminal, message } = await run(fetch);
	assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	assert.equal(terminal.type, "done");
	assert.equal(terminal.type === "done" && terminal.reason, "stop");
	assert.deepEqual(message.content, [{ type: "text", text: "Hello" }]);
	assert.deepEqual(message.usage, {
		input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.equal(message.api, "pi-ollama-chat");
	assert.equal(message.provider, "ollama");
	assert.equal(message.model, MODEL_ID);
	assert.equal((events[4] as any).content, "Hello");
});

test("thinking and text interleave with correct indices; thinking precedes content within one chunk", async () => {
	const { fetch } = ndjson({ chunks: [
		chunk({ thinking: "plan " }),
		chunk({ thinking: "more", content: "Answer" }),
		chunk({ content: " continues" }),
		chunk({ thinking: "afterthought" }),
		doneChunk(),
	] });
	const { events, message } = await run(fetch);
	assert.deepEqual(message.content, [
		{ type: "thinking", thinking: "plan more" },
		{ type: "text", text: "Answer continues" },
		{ type: "thinking", thinking: "afterthought" },
	]);
	const indexed = events.filter((event) => "contentIndex" in event).map((event: any) => `${event.type}@${event.contentIndex}`);
	assert.deepEqual(indexed, [
		"thinking_start@0", "thinking_delta@0", "thinking_delta@0", "thinking_end@0",
		"text_start@1", "text_delta@1", "text_delta@1", "text_end@1",
		"thinking_start@2", "thinking_delta@2", "thinking_end@2",
	]);
});

test("missing fields, empty strings, and usage-free done chunks are tolerated", async () => {
	const { fetch } = ndjson({ chunks: [
		chunk({ content: "" }),
		line({ model: MODEL_ID, done: false }),
		chunk({ content: "x" }),
		line({ model: MODEL_ID, done: true }),
	] });
	const { message } = await run(fetch);
	assert.deepEqual(message.content, [{ type: "text", text: "x" }]);
	assert.equal(message.usage.totalTokens, 0);
	assert.equal(message.stopReason, "stop");
});

// ---------------------------------------------------------------------------
// Tool calls

test("a single tool call is one start/delta/end burst with arguments preserved exactly", async () => {
	const args = { path: "config.ts", intent: "Read config.ts", "x-unknown": { nested: [1, null, "two"] } };
	const { fetch } = ndjson({ chunks: [
		chunk({ content: "Reading." }),
		chunk({ tool_calls: [{ id: "call_from_ollama", function: { name: "read", arguments: args } }] }),
		doneChunk({ done_reason: "stop" }),
	] });
	const { events, terminal, message } = await run(fetch);
	assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
	assert.equal(terminal.type === "done" && terminal.reason, "toolUse");
	const call = message.content[1] as any;
	assert.equal(call.type, "toolCall");
	assert.equal(call.name, "read");
	assert.deepEqual(call.arguments, args);
	assert.notEqual(call.id, "call_from_ollama");
	assert.match(call.id, /^ollama_[0-9a-f-]{36}$/);
	assert.match(call.id, SAFE_TOOL_CALL_ID);
	assert.equal((events[5] as any).delta, JSON.stringify(args));
	assert.equal((events[6] as any).toolCall, call);
});

test("multiple tool calls in one chunk and across chunks keep order and distinct IDs", async () => {
	const { fetch } = ndjson({ chunks: [
		chunk({ thinking: "two reads", tool_calls: [
			{ function: { name: "read", arguments: { path: "a" } } },
			{ function: { name: "read", arguments: { path: "b" } } },
		] }),
		chunk({ tool_calls: [{ function: { name: "bash", arguments: { command: "echo ok" } } }] }),
		doneChunk({ done_reason: "length" }),
	] });
	const { events, message } = await run(fetch);
	assert.deepEqual(message.content.map((block: any) => block.type === "toolCall" ? `${block.name}:${JSON.stringify(block.arguments)}` : block.type), [
		"thinking", "read:{\"path\":\"a\"}", "read:{\"path\":\"b\"}", "bash:{\"command\":\"echo ok\"}",
	]);
	// Any tool call wins over done_reason "length".
	assert.equal(message.stopReason, "toolUse");
	assert.equal(events.filter((event) => event.type === "thinking_end").length, 1);
	const ids = message.content.filter((block: any) => block.type === "toolCall").map((block: any) => block.id);
	assert.equal(new Set(ids).size, 3);
});

test("string arguments that strictly parse to an object are accepted; others are TOOL_CALL_INVALID", async () => {
	const accepted = ndjson({ chunks: [
		chunk({ tool_calls: [{ function: { name: "read", arguments: "{\"path\":\"a\",\"intent\":\"Read a\"}" } }] }),
		doneChunk(),
	] });
	const { message } = await run(accepted.fetch);
	assert.deepEqual((message.content[0] as any).arguments, { path: "a", intent: "Read a" });

	for (const call of [
		{ function: { name: "read", arguments: "{not json" } },
		{ function: { name: "read", arguments: "[1,2]" } },
		{ function: { name: "read", arguments: "\"text\"" } },
		{ function: { name: "read", arguments: [1] } },
		{ function: { name: "read", arguments: null } },
		{ function: { name: "read" } },
		{ function: { name: "", arguments: {} } },
		{ function: { arguments: {} } },
		{ name: "flat", arguments: {} },
		"read",
	]) {
		const { fetch } = ndjson({ chunks: [chunk({ content: "x" }), chunk({ tool_calls: [call] }), doneChunk()] });
		const { terminal, message: failed } = await run(fetch);
		assert.equal(terminal.type, "error", JSON.stringify(call));
		assert.equal(errorCode(failed), "TOOL_CALL_INVALID", JSON.stringify(call));
		assert.equal(failed.stopReason, "error");
	}
	const notArray = ndjson({ chunks: [chunk({ tool_calls: { name: "read" } }), doneChunk()] });
	assert.equal(errorCode((await run(notArray.fetch)).message), "TOOL_CALL_INVALID");
});

test("tool-call IDs are unique across 10,000 mints and stay in the observability safe alphabet", () => {
	const ids = new Set<string>();
	for (let index = 0; index < 10_000; index += 1) {
		const id = mintOllamaToolCallId();
		assert.match(id, SAFE_TOOL_CALL_ID);
		assert.ok(id.startsWith("ollama_"));
		ids.add(id);
	}
	assert.equal(ids.size, 10_000);
});

test("a failed turn drops its partial tool calls from the terminal message", async () => {
	const { fetch } = ndjson({ chunks: [
		chunk({ content: "Working." }),
		chunk({ tool_calls: [{ function: { name: "read", arguments: { path: "a", intent: "Read a" } } }] }),
	] });
	const { events, message } = await run(fetch);
	assert.equal(errorCode(message), "STREAM_TRUNCATED");
	assert.ok(events.some((event) => event.type === "toolcall_end"));
	assert.deepEqual(message.content, [{ type: "text", text: "Working." }]);
});

// ---------------------------------------------------------------------------
// Framing: byte splits, CRLF, malformed and oversized lines

test("byte-split lines, split multi-byte characters, CRLF, blank lines, and a final unterminated line", async () => {
	const text = `${chunk({ content: "héllo " }).replace("\n", "\r\n")}\r\n\n${chunk({ content: "wörld 🌍" })}${doneChunk().trimEnd()}`;
	const bytes = new TextEncoder().encode(text);
	const pieces: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += 3) pieces.push(bytes.subarray(offset, offset + 3));
	const { fetch } = ndjson({ chunks: pieces });
	const { terminal, message } = await run(fetch);
	assert.equal(terminal.type, "done");
	assert.deepEqual(message.content, [{ type: "text", text: "héllo wörld 🌍" }]);
});

test("malformed lines are STREAM_MALFORMED", async () => {
	for (const bad of ["{not json}\n", "[1,2]\n", "\"text\"\n", "42\n", line({ done: "yes" }), line({ message: "hi", done: false }), line({ message: { content: 3 }, done: false }), line({ message: { thinking: {} }, done: false })]) {
		const { fetch } = ndjson({ chunks: [chunk({ content: "x" }), bad, doneChunk()] });
		const { message } = await run(fetch);
		assert.equal(errorCode(message), "STREAM_MALFORMED", bad);
	}
});

test("a line over 8 MiB is STREAM_MALFORMED, with or without a newline", async () => {
	const huge = "x".repeat(MAX_NDJSON_LINE_LENGTH + 1);
	for (const chunks of [[huge], [`${huge}\n`, doneChunk()]]) {
		const { fetch } = ndjson({ chunks });
		const { message } = await run(fetch);
		assert.equal(errorCode(message), "STREAM_MALFORMED");
	}
});

test("anything after the done chunk is ignored and the body is cancelled", async () => {
	let cancelled = false;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`${chunk({ content: "ok" })}${doneChunk()}{garbage`));
		},
		cancel() {
			cancelled = true;
		},
	});
	const { fetch } = scriptedFetch(() => new Response(stream));
	const { terminal, message } = await run(fetch);
	assert.equal(terminal.type, "done");
	assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
	assert.equal(cancelled, true);
});

// ---------------------------------------------------------------------------
// Server errors, truncation, ghost output

test("an NDJSON error line maps to CONTEXT_OVERFLOW or HTTP_ERROR", async () => {
	const overflow = ndjson({ chunks: [line({ error: "prompt too long; exceeded context length by 120 tokens" })] });
	const overflowed = await run(overflow.fetch);
	assert.equal(errorCode(overflowed.message), "CONTEXT_OVERFLOW");
	assert.match(overflowed.message.errorMessage!, PI_OLLAMA_OVERFLOW);
	const generic = ndjson({ chunks: [chunk({ content: "x" }), line({ error: "model runner crashed" })] });
	const failed = await run(generic.fetch);
	assert.equal(errorCode(failed.message), "HTTP_ERROR");
	assert.match(failed.message.errorMessage!, /model runner crashed/);
	assert.doesNotMatch(failed.message.errorMessage!, PI_OLLAMA_OVERFLOW);
});

test("EOF before done is STREAM_TRUNCATED with and without content, and a failing body too", async () => {
	for (const body of [
		{ chunks: [] },
		{ chunks: [chunk({ content: "partial" })] },
		{ chunks: [chunk({ content: "partial" })], error: new Error("socket reset") },
	]) {
		const { fetch } = ndjson(body);
		const { message } = await run(fetch);
		assert.equal(errorCode(message), "STREAM_TRUNCATED");
		assert.equal(message.stopReason, "error");
	}
});

test("generated tokens with no visible output are GHOST_OUTPUT; zero-token empty turns are not", async () => {
	for (const chunks of [[doneChunk({ eval_count: 40 })], [chunk({ content: "  \n " }), doneChunk({ eval_count: 3 })]]) {
		const { fetch } = ndjson({ chunks });
		assert.equal(errorCode((await run(fetch)).message), "GHOST_OUTPUT");
	}
	const thinkingOnly = ndjson({ chunks: [chunk({ thinking: "hmm" }), doneChunk({ eval_count: 3 })] });
	assert.equal((await run(thinkingOnly.fetch)).terminal.type, "done");
	const empty = ndjson({ chunks: [doneChunk({ eval_count: 0 })] });
	assert.equal((await run(empty.fetch)).terminal.type, "done");
});

test("HTTP 400 overflow, 404, 500, and a load-time context refusal", async () => {
	const cases: Array<[number, string, string]> = [
		[400, JSON.stringify({ error: "prompt too long; exceeded max context length by 900 tokens" }), "CONTEXT_OVERFLOW"],
		[400, JSON.stringify({ error: JSON.stringify({ error: "input length exceeds the context length" }) }), "CONTEXT_OVERFLOW"],
		[404, JSON.stringify({ error: `model "${MODEL_ID}" not found, try pulling it first` }), "MODEL_UNAVAILABLE"],
		[500, "internal failure", "HTTP_ERROR"],
		[500, JSON.stringify({ error: "requested context size too large for model" }), "HTTP_ERROR"],
	];
	for (const [status, text, code] of cases) {
		const { fetch } = scriptedFetch(() => new Response(text, { status }));
		const { events, message } = await run(fetch);
		assert.equal(errorCode(message), code, text);
		assert.equal(events.some((event) => event.type === "start"), false);
		if (code === "CONTEXT_OVERFLOW") assert.match(message.errorMessage!, PI_OLLAMA_OVERFLOW);
		else assert.doesNotMatch(message.errorMessage!, PI_OLLAMA_OVERFLOW);
		assert.ok(message.errorMessage!.length <= 600);
	}
	const long = scriptedFetch(() => new Response(JSON.stringify({ error: "e".repeat(5_000) }), { status: 500 }));
	assert.ok((await run(long.fetch)).message.errorMessage!.length <= 520);
});

test("an HTTP error body is read at most 64 KiB", async () => {
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 1;
			controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
		},
	});
	const { fetch } = scriptedFetch(() => new Response(stream, { status: 500 }));
	const { message } = await run(fetch);
	assert.equal(errorCode(message), "HTTP_ERROR");
	assert.ok(pulled <= 6, `pulled ${pulled} chunks`);
});

test("connection refused is CONNECTION_FAILED and names only host and port", async () => {
	const fetch: FetchLike = async () => {
		throw new TypeError("fetch failed");
	};
	const { message } = await run(fetch);
	assert.equal(errorCode(message), "CONNECTION_FAILED");
	assert.match(message.errorMessage!, /dgx\.test:11434/);
	assert.doesNotMatch(message.errorMessage!, /http:/);
});

// ---------------------------------------------------------------------------
// Cancellation and the idle watchdog

test("an already-aborted signal finishes aborted without a hook call or fetch", async () => {
	const { fetch, calls } = ndjson({ chunks: [doneChunk()] });
	const controller = new AbortController();
	controller.abort();
	const { terminal, hookCalls } = await run(fetch, { signal: controller.signal });
	assert.equal(terminal.type === "error" && terminal.reason, "aborted");
	assert.equal(hookCalls.length, 0);
	assert.equal(calls.length, 0);
});

test("abort before headers, mid-stream, and after done", async () => {
	const before = scriptedFetch(() => new Promise<Response>(() => undefined));
	const beforeController = new AbortController();
	const beforeRun = run(before.fetch, { signal: beforeController.signal });
	setTimeout(() => beforeController.abort(), 10);
	const beforeResult = await beforeRun;
	assert.equal(beforeResult.terminal.type === "error" && beforeResult.terminal.reason, "aborted");
	assert.equal(beforeResult.message.stopReason, "aborted");
	assert.equal(errorCode(beforeResult.message), "CANCELLED");

	const midController = new AbortController();
	const mid = ndjson({ chunks: [chunk({ content: "partial" })], hang: true });
	const midRun = run(mid.fetch, { signal: midController.signal });
	setTimeout(() => midController.abort(), 20);
	const midResult = await midRun;
	assert.equal(midResult.terminal.type === "error" && midResult.terminal.reason, "aborted");
	assert.deepEqual(midResult.message.content, [{ type: "text", text: "partial" }]);
	const afterAbort = midResult.events.findIndex((event) => event.type === "error");
	assert.equal(afterAbort, midResult.events.length - 1);

	const afterController = new AbortController();
	const after = ndjson({ chunks: [chunk({ content: "done" }), doneChunk()] });
	const afterResult = await run(after.fetch, { signal: afterController.signal });
	afterController.abort();
	assert.equal(afterResult.terminal.type, "done");
});

function deferred<T = unknown>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("abort while the payload hook is pending retires the turn; the released hook causes no egress or events", { timeout: 10_000 }, async () => {
	const { fetch, calls } = ndjson({ chunks: [chunk({ content: "late" }), doneChunk()] });
	const hook = deferred();
	const controller = new AbortController();
	const pending = run(fetch, { signal: controller.signal, onPayload: () => hook.promise });
	setTimeout(() => controller.abort(), 10);
	const result = await pending;
	assert.equal(result.terminal.type === "error" && result.terminal.reason, "aborted");
	assert.equal(errorCode(result.message), "CANCELLED");
	assert.deepEqual(types(result.events), ["error"]);

	// The released hook returns a usable replacement body; it must not reach the network.
	const eventCount = result.events.length;
	hook.resolve(undefined);
	await settle();
	assert.equal(calls.length, 0);
	assert.equal(result.events.length, eventCount);

	// A hook that rejects after the abort is also absorbed.
	const rejecting = deferred<never>();
	const rejectingController = new AbortController();
	const rejectingRun = run(fetch, { signal: rejectingController.signal, onPayload: () => rejecting.promise.then(() => { throw new Error("late"); }) });
	setTimeout(() => rejectingController.abort(), 10);
	assert.equal(errorCode((await rejectingRun).message), "CANCELLED");
	rejecting.resolve(undefined as never);
	await settle();
	assert.equal(calls.length, 0);
});

test("abort while the response hook is pending retires the turn, cancels the body, and reads nothing", { timeout: 10_000 }, async () => {
	let cancelled = false;
	const encoder = new TextEncoder();
	const { fetch, calls } = scriptedFetch(() => new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(chunk({ content: "late" }) + doneChunk()));
		},
		cancel() {
			cancelled = true;
		},
	}), { headers: { "content-type": "application/x-ndjson" } }));
	const hook = deferred();
	const controller = new AbortController();
	let responseHookCalls = 0;
	const pending = run(fetch, {
		signal: controller.signal,
		onResponse: () => {
			responseHookCalls += 1;
			setTimeout(() => controller.abort(), 10);
			return hook.promise;
		},
	});
	const result = await pending;
	assert.equal(calls.length, 1);
	assert.equal(responseHookCalls, 1);
	assert.equal(result.terminal.type === "error" && result.terminal.reason, "aborted");
	assert.equal(errorCode(result.message), "CANCELLED");
	assert.deepEqual(types(result.events), ["error"], "no start or content event");
	assert.equal(cancelled, true);

	const eventCount = result.events.length;
	hook.resolve(undefined);
	await settle();
	assert.equal(result.events.length, eventCount);
});

test("a response hook that resolves normally still lets the turn complete", { timeout: 10_000 }, async () => {
	const { fetch } = ndjson({ chunks: [chunk({ content: "ok" }), doneChunk()] });
	const statuses: number[] = [];
	const result = await run(fetch, { onResponse: async (response) => { statuses.push(response.status); } });
	assert.equal(result.terminal.type, "done");
	assert.deepEqual(statuses, [200]);
});

test("a redirect is refused without following it or reading its body", { timeout: 10_000 }, async () => {
	const { fetch, calls } = scriptedFetch(() => new Response("moved", { status: 307, headers: { location: "http://elsewhere.invalid:11434/api/chat" } }));
	const result = await run(fetch);
	assert.equal(errorCode(result.message), "HTTP_ERROR");
	assert.match(result.message.errorMessage ?? "", /unexpected redirect \(HTTP 307\) refused/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.redirect, "manual");
});

test("the idle watchdog fails a silent stream, before headers or mid-body", async () => {
	const beforeHeaders = scriptedFetch(() => new Promise<Response>(() => undefined));
	const silent = await run(beforeHeaders.fetch, { deps: { streamIdleMs: 20 } });
	assert.equal(silent.terminal.type === "error" && silent.terminal.reason, "error");
	assert.equal(errorCode(silent.message), "STREAM_IDLE_TIMEOUT");

	const stalled = ndjson({ chunks: [chunk({ content: "a" })], hang: true });
	const stalledResult = await run(stalled.fetch, { deps: { streamIdleMs: 20 } });
	assert.equal(errorCode(stalledResult.message), "STREAM_IDLE_TIMEOUT");
	assert.deepEqual(stalledResult.message.content, [{ type: "text", text: "a" }]);
});

test("the watchdog resets on every byte chunk, so slow steady streams succeed", async () => {
	const encoder = new TextEncoder();
	const parts = [chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }), doneChunk()];
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			await new Promise((resolve) => setTimeout(resolve, 15));
			const next = parts.shift();
			if (next) controller.enqueue(encoder.encode(next));
			else controller.close();
		},
	});
	const { fetch } = scriptedFetch(() => new Response(stream));
	const { terminal, message } = await run(fetch, { deps: { streamIdleMs: 40 } });
	assert.equal(terminal.type, "done");
	assert.deepEqual(message.content, [{ type: "text", text: "abc" }]);
});

// ---------------------------------------------------------------------------
// The payload hook and egress

test("the hook is called exactly once, before fetch, and undefined keeps the built body", async () => {
	const order: string[] = [];
	const { fetch, calls } = scriptedFetch(() => {
		order.push("fetch");
		return new Response(bodyStream({ chunks: [chunk({ content: "ok" }), doneChunk()] }));
	});
	let hookModel: unknown;
	const hookCalls: unknown[] = [];
	const { terminal } = await run(fetch, {
		onPayload(payload, model) {
			order.push("hook");
			hookModel = model;
			hookCalls.push(payload);
			return undefined;
		},
	});
	assert.equal(terminal.type, "done");
	assert.deepEqual(order, ["hook", "fetch"]);
	assert.equal(hookCalls.length, 1);
	assert.equal(hookModel, piModel);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.body, JSON.stringify(hookCalls[0]));
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.model, MODEL_ID);
	assert.equal(sent.truncate, false);
	assert.equal(sent.options.num_ctx, 65536);
	assert.equal(sent.think, false);
});

test("a replacement body is sent verbatim, and awaited hooks are supported", async () => {
	const { fetch, calls } = ndjson({ chunks: [chunk({ content: "ok" }), doneChunk()] });
	const replacement = {
		model: MODEL_ID,
		messages: [{ role: "system", content: "decorated <REDACTED X VALUE>" }],
		stream: true,
		options: { num_ctx: 65536 },
		truncate: false,
		extra: { kept: true },
	};
	await run(fetch, { onPayload: async () => replacement });
	assert.equal(calls[0].init.body, JSON.stringify(replacement));
});

test("a malformed, rejecting, or throwing supplied hook means no fetch and an error", async () => {
	const cases: Array<[string, PiStreamOptions, string]> = [
		["null", { onPayload: () => null }, "PAYLOAD_REJECTED"],
		["string", { onPayload: () => "body" }, "PAYLOAD_REJECTED"],
		["array", { onPayload: () => [] }, "PAYLOAD_REJECTED"],
		["changed model", { onPayload: (payload: any) => ({ ...payload, model: "other:model" }) }, "PAYLOAD_REJECTED"],
		["no messages", { onPayload: (payload: any) => ({ ...payload, messages: undefined }) }, "PAYLOAD_REJECTED"],
		["not streaming", { onPayload: (payload: any) => ({ ...payload, stream: false }) }, "PAYLOAD_REJECTED"],
		["class instance", { onPayload: (payload: any) => Object.assign(new (class Body {})(), payload) }, "PAYLOAD_REJECTED"],
		["throws", { onPayload: () => { throw new Error("hook failure"); } }, "PAYLOAD_REJECTED"],
		["rejects", { onPayload: async () => { throw new Error("hook failure"); } }, "PAYLOAD_REJECTED"],
		["unserializable", { onPayload: (payload: any) => ({ ...payload, big: 1n }) }, "PAYLOAD_REJECTED"],
	];
	for (const [label, options, code] of cases) {
		const { fetch, calls } = ndjson({ chunks: [doneChunk()] });
		const { events, message } = await run(fetch, options);
		assert.equal(calls.length, 0, label);
		assert.equal(errorCode(message), code, label);
		assert.equal(events.some((event) => event.type === "start"), false, label);
	}
});

test("egress goes only to the configured origin with a JSON content type", async () => {
	const { fetch, calls } = ndjson({ chunks: [chunk({ content: "ok" }), doneChunk()] });
	const responses: unknown[] = [];
	await run(fetch, {
		onResponse: (response) => {
			responses.push(response);
		},
		...({ apiKey: "sk-secret", headers: { authorization: "Bearer x" } } as object),
	});
	assert.equal(calls[0].url, `${BASE_URL}/api/chat`);
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
	assert.equal(calls[0].init.body.includes("sk-secret"), false);
	assert.equal(responses.length, 1);
	assert.equal((responses[0] as any).status, 200);
	assert.equal((responses[0] as any).headers["content-type"], "application/x-ndjson");
});

test("conversion failures and unconfigured models end the turn before the hook", async () => {
	const { fetch, calls } = ndjson({ chunks: [doneChunk()] });
	const conversion = await run(fetch, {}, { messages: [{ role: "custom", content: "x" }] });
	assert.equal(errorCode(conversion.message), "CONTEXT_CONVERSION_FAILED");
	assert.equal(conversion.hookCalls.length, 0);
	const unconfigured = await run(fetch, { deps: { models: new Map() } });
	assert.equal(errorCode(unconfigured.message), "MODEL_UNAVAILABLE");
	assert.equal(unconfigured.hookCalls.length, 0);
	assert.equal(calls.length, 0);
});

test("reasoning levels and per-turn options reach the wire", async () => {
	const { fetch, calls } = ndjson({ chunks: [chunk({ content: "ok" }), doneChunk()] });
	await run(fetch, { reasoning: "high", temperature: 0.3, maxTokens: 512 });
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.think, true);
	assert.deepEqual(sent.options, { num_ctx: 65536, temperature: 0.3, num_predict: 512 });
});
