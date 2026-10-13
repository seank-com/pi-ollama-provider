import assert from "node:assert/strict";
import test from "node:test";

import {
	convertConversation,
	convertTools,
	normalizePiContext,
} from "../src/convert.ts";
import { OllamaProviderError } from "../src/errors.ts";
import { OLLAMA_IMAGE_OMITTED_MARKER } from "../src/contract.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(content: unknown) {
	return { role: "user", content, timestamp: 1 };
}

function assistant(content: unknown[], stopReason = "stop") {
	return { role: "assistant", content, api: "pi-ollama-chat", provider: "ollama", model: "m", usage, stopReason, timestamp: 1 };
}

function toolResult(toolCallId: string, toolName: string, content: unknown[], isError = false) {
	return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: 1 };
}

function tool(name: string, parameters: Record<string, unknown> = { type: "object", properties: {} }, description = `${name} tool`) {
	return { name, description, parameters };
}

function assertConversionFails(action: () => unknown) {
	assert.throws(action, (error: unknown) => error instanceof OllamaProviderError && error.code === "CONTEXT_CONVERSION_FAILED");
}

test("Pi 0.85.1 context: systemPrompt, tools, and messages", () => {
	const normalized = normalizePiContext({
		systemPrompt: "You are a test agent.",
		tools: [tool("read"), tool("bash")],
		messages: [user("hi")],
	});
	assert.equal(normalized.systemPrompt, "You are a test agent.");
	assert.deepEqual(normalized.tools.map((entry) => entry.name), ["read", "bash"]);
	assert.deepEqual(normalized.messages, [user("hi")]);
});

test("Pi 0.86+ transcript: system messages replay content, sections, and tool changes in order", () => {
	const normalized = normalizePiContext({
		messages: [
			{
				role: "system",
				content: [{ type: "text", text: "Base prompt." }, { type: "text", text: "Second line." }],
				sections: { "<env>": "<env>cwd</env>", "<skills>": "<skills>a</skills>", "<date>": "<date>today</date>" },
				toolsAdded: [tool("read"), tool("bash"), tool("edit")],
				timestamp: 0,
			},
			user("first"),
			{ role: "system", content: "Extra instruction.", sections: { "<skills>": "<skills>b</skills>", "<date>": null }, timestamp: 2 },
			assistant([{ type: "text", text: "ok" }]),
			{ role: "system", content: "", toolsRemoved: [{ name: "bash" }], toolsAdded: [tool("edit", { type: "object", properties: { v: { type: "number" } } }), tool("grep")], timestamp: 3 },
			user("second"),
		],
	});
	assert.equal(
		normalized.systemPrompt,
		"Base prompt.\nSecond line.\n\nExtra instruction.\n\n<env>cwd</env>\n\n<skills>b</skills>",
	);
	assert.deepEqual(normalized.tools.map((entry) => entry.name), ["read", "edit", "grep"]);
	assert.deepEqual(normalized.tools[1].parameters, { type: "object", properties: { v: { type: "number" } } });
	assert.deepEqual(normalized.messages.map((message) => message.role), ["user", "assistant", "user"]);
});

test("top-level prompt and tools fold ahead of transcript system messages, as Pi normalizeContext does", () => {
	const normalized = normalizePiContext({
		systemPrompt: "Top.",
		tools: [tool("read")],
		messages: [{ role: "system", content: "Later.", toolsAdded: [tool("bash")], timestamp: 0 }, user("x")],
	});
	assert.equal(normalized.systemPrompt, "Top.\n\nLater.");
	assert.deepEqual(normalized.tools.map((entry) => entry.name), ["read", "bash"]);
	assert.equal(normalizePiContext({ systemPrompt: "", messages: [] }).systemPrompt, "");
});

test("unrecognized system message shapes and malformed contexts fail the turn", () => {
	for (const context of [
		undefined,
		{},
		{ messages: {} },
		{ systemPrompt: 3, messages: [] },
		{ tools: {}, messages: [] },
		{ tools: [{ name: "x" }], messages: [] },
		{ tools: [{ name: "x", parameters: {}, description: 3 }], messages: [] },
		{ messages: [{ content: "no role" }] },
		{ messages: [{ role: "system", content: "x", mode: "append", timestamp: 0 }] },
		{ messages: [{ role: "system", content: 3, timestamp: 0 }] },
		{ messages: [{ role: "system", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 0 }] },
		{ messages: [{ role: "system", content: "x", sections: [], timestamp: 0 }] },
		{ messages: [{ role: "system", content: "x", sections: { a: 1 }, timestamp: 0 }] },
		{ messages: [{ role: "system", content: "x", toolsAdded: {}, timestamp: 0 }] },
		{ messages: [{ role: "system", content: "x", toolsRemoved: ["bash"], timestamp: 0 }] },
	]) {
		assertConversionFails(() => normalizePiContext(context));
	}
});

test("role mapping, text joining, and image omission", () => {
	const messages = convertConversation([
		user("plain"),
		user([{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "b" }]),
		assistant([{ type: "text", text: "one" }, { type: "text", text: "two" }]),
		toolResult("ollama_1", "read", [{ type: "text", text: "l1" }, { type: "text", text: "l2" }, { type: "image", data: "AAAA", mimeType: "image/png" }]),
	]);
	assert.deepEqual(messages, [
		{ role: "user", content: "plain" },
		{ role: "user", content: `a\n${OLLAMA_IMAGE_OMITTED_MARKER}\nb` },
		{ role: "assistant", content: "onetwo" },
		{ role: "tool", content: `l1\nl2\n${OLLAMA_IMAGE_OMITTED_MARKER}`, tool_name: "read", tool_call_id: "ollama_1" },
	]);
	assert.equal(JSON.stringify(messages).includes("AAAA"), false);
});

test("tool IDs and argument objects in history, with tool_name and tool_call_id on results", () => {
	const args = { path: "config.ts", nested: { keep: [1, 2] }, "x-unknown": true };
	const history = [
		user("go"),
		assistant([
			{ type: "text", text: "Reading." },
			{ type: "toolCall", id: "ollama_a", name: "read", arguments: args },
			{ type: "toolCall", id: "call_codex|fc_1", name: "bash", arguments: { command: "ls" } },
		], "toolUse"),
		toolResult("ollama_a", "read", [{ type: "text", text: "contents" }]),
		toolResult("call_codex|fc_1", "bash", [{ type: "text", text: "out" }], true),
	];
	const messages = convertConversation(history);
	assert.deepEqual(messages[1], {
		role: "assistant",
		content: "Reading.",
		tool_calls: [
			{ id: "ollama_a", function: { name: "read", arguments: args } },
			{ id: "call_codex|fc_1", function: { name: "bash", arguments: { command: "ls" } } },
		],
	});
	assert.notEqual(messages[1].tool_calls![0].function.arguments, args);
	(messages[1].tool_calls![0].function.arguments as any).nested.keep.push(3);
	assert.deepEqual(args.nested.keep, [1, 2]);
	assert.deepEqual(messages.slice(2), [
		{ role: "tool", content: "contents", tool_name: "read", tool_call_id: "ollama_a" },
		{ role: "tool", content: "out", tool_name: "bash", tool_call_id: "call_codex|fc_1" },
	]);
});

test("errored and aborted assistant turns are pruned with their immediately following tool results", () => {
	const messages = convertConversation([
		user("go"),
		assistant([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], "error"),
		toolResult("t1", "read", [{ type: "text", text: "never replayed" }]),
		assistant([{ type: "text", text: "partial" }], "aborted"),
		user("again"),
		assistant([{ type: "toolCall", id: "t2", name: "read", arguments: {} }], "toolUse"),
		toolResult("t2", "read", [{ type: "text", text: "kept" }]),
		assistant([{ type: "toolCall", id: "t3", name: "read", arguments: {} }], "aborted"),
		toolResult("t3", "read", [{ type: "text", text: "dropped" }]),
		toolResult("t3b", "read", [{ type: "text", text: "dropped too" }]),
	]);
	assert.deepEqual(messages, [
		{ role: "user", content: "go" },
		{ role: "user", content: "again" },
		{ role: "assistant", content: "", tool_calls: [{ id: "t2", function: { name: "read", arguments: {} } }] },
		{ role: "tool", content: "kept", tool_name: "read", tool_call_id: "t2" },
	]);
});

test("thinking is sent only after the last user message, and never when redacted", () => {
	const messages = convertConversation([
		user("first"),
		assistant([{ type: "thinking", thinking: "old reasoning" }, { type: "text", text: "old answer" }]),
		user("second"),
		assistant([{ type: "thinking", thinking: "step one" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }], "toolUse"),
		toolResult("t1", "read", [{ type: "text", text: "r" }]),
		assistant([
			{ type: "thinking", thinking: "part a " },
			{ type: "thinking", thinking: "opaque", redacted: true },
			{ type: "thinking", thinking: "part b" },
			{ type: "text", text: "done" },
		]),
	]);
	assert.deepEqual(messages[1], { role: "assistant", content: "old answer" });
	assert.equal(messages[3].thinking, "step one");
	assert.equal(messages[5].thinking, "part a part b");

	// With no user message at all, the whole conversation is the current loop.
	assert.equal(convertConversation([assistant([{ type: "thinking", thinking: "t" }])])[0].thinking, "t");
	// Empty thinking adds no key.
	assert.equal(Object.hasOwn(convertConversation([assistant([{ type: "thinking", thinking: "" }])])[0], "thinking"), false);
});

test("unsupported roles and content blocks fail the turn", () => {
	for (const messages of [
		[{ role: "custom", content: "x" }],
		[user(3)],
		[user([{ type: "toolCall", id: "x", name: "y", arguments: {} }])],
		[assistant([{ type: "image", data: "", mimeType: "image/png" }])],
		[assistant([{ type: "toolCall", id: "x", name: "y", arguments: "{}" }])],
		[{ ...assistant([]), content: "text" }],
		[toolResult("x", "y", [{ type: "thinking", thinking: "no" }])],
		[{ role: "toolResult", content: [], isError: false }],
	]) {
		assertConversionFails(() => convertConversation(messages as any));
	}
});

test("tool schemas are cloned deep-equal, keeping unknown keywords, anyOf, not, and a pre-decorated intent", () => {
	const parameters = {
		type: "object",
		properties: {
			store: { type: "string", pattern: "^[a-z]+$" },
			intent: { type: "string", minLength: 1, maxLength: 1000, description: "pre-decorated" },
		},
		required: ["store", "intent"],
		additionalProperties: false,
		anyOf: [{ required: ["path"] }, { required: ["uri"] }],
		not: { required: ["path", "uri"] },
		"x-vendor": { nested: [1, { deep: true }] },
		$defs: { Ref: { type: "string" } },
	};
	const snapshot = structuredClone(parameters);
	const [converted, undescribed] = convertTools([
		{ name: "datastore_read", description: "Read a note.", parameters },
		{ name: "bare", parameters: { type: "object" } },
	]);
	assert.deepEqual(converted, { type: "function", function: { name: "datastore_read", description: "Read a note.", parameters: snapshot } });
	assert.notEqual(converted.function.parameters, parameters);
	(converted.function.parameters as any).properties.store.pattern = "changed";
	assert.deepEqual(parameters, snapshot);
	assert.equal(undescribed.function.description, "");

	// TypeBox symbol keys do not survive; uncloneable values fail the turn.
	const kind = Symbol.for("TypeBox.Kind");
	const typebox = { type: "object", properties: {}, [kind]: "Object" };
	assert.deepEqual(Object.getOwnPropertySymbols(convertTools([{ name: "t", parameters: typebox }])[0].function.parameters), []);
	assertConversionFails(() => convertTools([{ name: "f", parameters: { type: "object", check: () => true } }]));
});
