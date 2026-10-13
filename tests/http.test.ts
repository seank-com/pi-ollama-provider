import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { MAX_SHOW_BODY_BYTES, postShow, type FetchLike } from "../src/client.ts";
import { parseOllamaProviderConfig } from "../src/config.ts";
import { formatRegistrationStatus, validateConfiguredModels } from "../src/models.ts";
import { streamOllamaChat, type PiAssistantEvent } from "../src/stream.ts";

// Real loopback HTTP servers and Node's real fetch: the transport behavior
// these tests pin (redirect handling, body bounds, refusal, timeout) belongs
// to fetch itself, not to a scripted stand-in.

const MODEL_ID = "qwen-test:latest";
const realFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

interface Recorded { method?: string; url?: string; body: string }

async function listen(handler: (request: IncomingMessage, body: string, response: ServerResponse) => void) {
	const requests: Recorded[] = [];
	const server: Server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (part) => { body += part; });
		request.on("end", () => {
			requests.push({ method: request.method, url: request.url, body });
			handler(request, body, response);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		requests,
		close: () => new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

async function closedOrigin(): Promise<string> {
	const server = await listen(() => undefined);
	await server.close();
	return server.origin;
}

for (const status of [307, 308]) {
	test(`chat: an HTTP ${status} is refused, and the body never reaches the redirect target`, { timeout: 10_000 }, async (t) => {
		const target = await listen((_request, _body, response) => response.end("{}"));
		t.after(() => target.close());
		const origin = await listen((_request, _body, response) => {
			response.writeHead(status, { location: `${target.origin}/api/chat` });
			response.end();
		});
		t.after(() => origin.close());

		const events: PiAssistantEvent[] = [];
		let ends = 0;
		await streamOllamaChat({
			fetch: realFetch,
			baseUrl: origin.origin,
			keepAlive: null,
			streamIdleMs: 60_000,
			models: new Map([[MODEL_ID, { id: MODEL_ID, contextWindow: 8192, reasoning: false }]]),
		}, { id: MODEL_ID, provider: "ollama" }, { systemPrompt: "s", messages: [{ role: "user", content: "secret question", timestamp: 1 }] }, {
			onPayload: () => undefined,
		}, { push: (event) => events.push(event), end: () => { ends += 1; } });

		assert.equal(ends, 1);
		assert.deepEqual(events.map((event) => event.type), ["error"]);
		const terminal = events[0];
		assert.match(terminal.type === "error" ? terminal.error.errorMessage ?? "" : "", new RegExp(`^HTTP_ERROR: unexpected redirect \\(HTTP ${status}\\) refused`));
		assert.equal(origin.requests.length, 1);
		assert.match(origin.requests[0].body, /secret question/);
		assert.deepEqual(target.requests, []);
	});

	test(`metadata: an HTTP ${status} rejects the model and is never followed`, { timeout: 10_000 }, async (t) => {
		const target = await listen((_request, _body, response) => response.end(JSON.stringify({ capabilities: ["completion", "tools"] })));
		t.after(() => target.close());
		const origin = await listen((_request, _body, response) => {
			response.writeHead(status, { location: `${target.origin}/api/show` });
			response.end();
		});
		t.after(() => origin.close());
		assert.deepEqual(await postShow(realFetch, origin.origin, MODEL_ID, 2_000), {
			kind: "invalid", code: "HTTP_ERROR", detail: `unexpected redirect (HTTP ${status}) refused`,
		});
		assert.deepEqual(target.requests, []);
	});
}

test("metadata classification separates invalid answers from transport unavailability", { timeout: 20_000 }, async (t) => {
	const hanging: ServerResponse[] = [];
	const server = await listen((_request, body, response) => {
		const model = JSON.parse(body).model as string;
		if (model === "malformed") return void response.end("{\"capabilities\": [");
		if (model === "array") return void response.end("[]");
		if (model === "oversized") return void response.end(JSON.stringify({ capabilities: ["completion", "tools"], padding: "x".repeat(MAX_SHOW_BODY_BYTES) }));
		if (model === "server-error") return void response.writeHead(500).end("{\"error\":\"boom\"}");
		if (model === "forbidden") return void response.writeHead(403).end();
		if (model === "missing") return void response.writeHead(404).end("{\"error\":\"model not found\"}");
		if (model === "slow") return void hanging.push(response);
		response.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "test.context_length": 32768 } }));
	});
	t.after(() => server.close());

	const expectations: Array<[string, unknown]> = [
		["malformed", { kind: "invalid", code: "METADATA_INVALID", detail: "response is not JSON" }],
		["array", { kind: "invalid", code: "METADATA_INVALID", detail: "response is not a JSON object" }],
		["oversized", { kind: "invalid", code: "METADATA_INVALID", detail: `response exceeds ${MAX_SHOW_BODY_BYTES} bytes` }],
		["server-error", { kind: "invalid", code: "HTTP_ERROR", detail: "HTTP 500" }],
		["forbidden", { kind: "invalid", code: "HTTP_ERROR", detail: "HTTP 403" }],
		["missing", { kind: "not_found" }],
		["slow", { kind: "unreachable", detail: "timed out" }],
	];
	for (const [model, expected] of expectations) {
		assert.deepEqual(await postShow(realFetch, server.origin, model, model === "slow" ? 100 : 2_000), expected, model);
	}
	assert.deepEqual(await postShow(realFetch, await closedOrigin(), "any", 2_000), { kind: "unreachable", detail: "connection failed" });

	// Through the registration table: only the transport-unavailable model registers unverified.
	const model = (contextWindow = 8192) => ({ displayName: "M", contextWindow, maxOutputTokens: 1024, reasoning: false });
	const config = parseOllamaProviderConfig(JSON.stringify({
		schemaVersion: 1,
		baseUrl: server.origin,
		timeouts: { metadataMs: 1_000 },
		models: { good: model(), malformed: model(), oversized: model(), "server-error": model(), slow: model() },
	}), "/c");
	const validations = await validateConfiguredModels(config, realFetch);
	assert.deepEqual(validations.map((validation) => [validation.model.id, validation.status, validation.status === "rejected" ? validation.code : undefined]), [
		["good", "verified", undefined],
		["malformed", "rejected", "METADATA_INVALID"],
		["oversized", "rejected", "METADATA_INVALID"],
		["server-error", "rejected", "HTTP_ERROR"],
		["slow", "unverified", undefined],
	]);
	assert.match(formatRegistrationStatus(config, validations), /malformed rejected \(METADATA_INVALID\); oversized rejected \(METADATA_INVALID\); server-error rejected \(HTTP_ERROR\); slow unverified$/);
	for (const response of hanging) response.destroy();
});

test("the host fetch's header and body timeouts are STREAM_IDLE_TIMEOUT, not CONNECTION_FAILED", { timeout: 20_000 }, async (t) => {
	// Pi installs its own undici fetch with headersTimeout = bodyTimeout = httpIdleTimeoutMs
	// (300000 ms by default). Use that undici with 100 ms to reproduce the boundary quickly.
	const { createRequire } = await import("node:module");
	const { piPackageRoot } = await import("./pi-host.ts");
	const undici = createRequire(`${piPackageRoot()}/package.json`)("undici");
	const agent = new undici.Agent({ headersTimeout: 100, bodyTimeout: 100 });
	t.after(() => agent.close());
	const piFetch: FetchLike = (url, init) => undici.fetch(url, { ...init, dispatcher: agent });
	const server = await listen((request, _body, response) => {
		if (request.url === "/slow-headers/api/chat") return; // prompt evaluation outlasting the timeout
		response.writeHead(200, { "content-type": "application/x-ndjson" });
		response.write(`${JSON.stringify({ model: MODEL_ID, message: { role: "assistant", content: "partial" }, done: false })}\n`);
		// then silence: the body stalls
	});
	t.after(() => server.close());
	const run = async (baseUrl: string) => {
		const events: PiAssistantEvent[] = [];
		await streamOllamaChat({
			fetch: piFetch, baseUrl, keepAlive: null, streamIdleMs: 60_000,
			models: new Map([[MODEL_ID, { id: MODEL_ID, contextWindow: 8192, reasoning: false }]]),
		}, { id: MODEL_ID, provider: "ollama" }, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { onPayload: () => undefined }, { push: (event) => events.push(event), end: () => undefined });
		const terminal = events.at(-1)!;
		return terminal.type === "error" ? terminal.error.errorMessage ?? "" : "done";
	};
	assert.match(await run(`${server.origin}/slow-headers`), /^STREAM_IDLE_TIMEOUT: no response headers within the host HTTP timeout/);
	assert.match(await run(server.origin), /^STREAM_IDLE_TIMEOUT: no response bytes within the host HTTP timeout/);
	assert.match(await run(await closedOrigin()), /^CONNECTION_FAILED/);
});
