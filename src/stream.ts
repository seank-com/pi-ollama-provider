import { randomUUID } from "node:crypto";

import { OLLAMA_API_ID, OLLAMA_TOOL_CALL_ID_PREFIX, type OllamaChatRequest } from "./contract.ts";
import { isRedirectStatus, MAX_ERROR_BODY_BYTES, postChat, readBoundedText, type FetchLike } from "./client.ts";
import { buildOllamaChatRequest, type PiThinkingLevelMap } from "./convert.ts";
import { OllamaProviderError, serverError } from "./errors.ts";
import { validateOllamaProviderMode, type OllamaProviderMode } from "./config.ts";
import { compatiblePolicy, type ObservabilityPolicy } from "./observability.ts";

export const MAX_NDJSON_LINE_LENGTH = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Structural Pi views. The stream never imports Pi; index.ts binds the sink to
// Pi's AssistantMessageEventStream.

export type PiContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiContentBlock[];
	api: string;
	provider: string;
	model: string;
	usage: PiUsage;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

export type PiAssistantEvent =
	| { type: "start"; partial: PiAssistantMessage }
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: PiAssistantMessage }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: PiContentBlock & { type: "toolCall" }; partial: PiAssistantMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: PiAssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: PiAssistantMessage };

export interface PiEventSink {
	push(event: PiAssistantEvent): void;
	end(): void;
}

/** The registered Pi model as streamSimple receives it. Only these fields are read. */
export interface PiStreamModel {
	id: string;
	provider: string;
	thinkingLevelMap?: PiThinkingLevelMap;
}

export interface PiStreamOptions {
	signal?: AbortSignal;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	onPayload?: (payload: unknown, model: any) => unknown;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: any) => unknown;
}

export interface StreamModelConfig {
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface StreamDependencies {
	mode?: OllamaProviderMode;
	observability?: () => ObservabilityPolicy | undefined;
	fetch: FetchLike;
	baseUrl: string;
	keepAlive: string | number | null;
	streamIdleMs: number;
	/** Configured models by exact reference. The Pi model object is never trusted for egress or limits. */
	models: ReadonlyMap<string, StreamModelConfig>;
	mintToolCallId?: () => string;
	now?: () => number;
}

export function mintOllamaToolCallId(): string {
	return `${OLLAMA_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The host fetch's own HTTP timeouts. Pi installs an undici dispatcher whose
 * headers and body timeouts equal its httpIdleTimeoutMs setting (300000 ms by
 * default). Ollama sends no headers until prompt evaluation finishes, so a long
 * prompt, queueing, or a stalled server can hit them; that is a timeout, not an
 * unreachable server.
 */
function hostHttpTimeout(error: unknown): "headers" | "body" | undefined {
	for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (code === "UND_ERR_HEADERS_TIMEOUT") return "headers";
		if (code === "UND_ERR_BODY_TIMEOUT") return "body";
	}
	return undefined;
}

function zeroUsage(): PiUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

type OpenBlock = { kind: "text" | "thinking"; index: number } | undefined;

/**
 * Streams one Pi turn through Ollama `/api/chat` (design 7). Resolves when the
 * turn has finished; it never rejects. Exactly one terminal event and exactly
 * one `end()` reach the sink on every path.
 */
export async function streamOllamaChat(
	deps: StreamDependencies,
	model: PiStreamModel,
	context: unknown,
	options: PiStreamOptions = {},
	sink: PiEventSink,
): Promise<void> {
	const now = deps.now ?? Date.now;
	const mintId = deps.mintToolCallId ?? mintOllamaToolCallId;
	const output: PiAssistantMessage = {
		role: "assistant",
		content: [],
		api: OLLAMA_API_ID,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: now(),
	};

	// --- Pi event mapping: every sink call goes through these functions. ---
	let started = false;
	let finished = false;
	const emit = (event: PiAssistantEvent) => {
		if (!finished) sink.push(event);
	};
	const start = () => {
		if (started) return;
		started = true;
		emit({ type: "start", partial: output });
	};
	const finish = (error?: OllamaProviderError) => {
		if (finished) return;
		if (error) {
			const aborted = error.code === "CANCELLED";
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = error.message;
			// A failed turn is never executed; its partial tool calls must not be
			// audited or replayed.
			output.content = output.content.filter((block) => block.type !== "toolCall");
			emit({ type: "error", reason: aborted ? "aborted" : "error", error: output });
		} else {
			emit({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		}
		finished = true;
		sink.end();
	};

	let open: OpenBlock;
	const closeOpen = () => {
		if (!open) return;
		const block = output.content[open.index];
		const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "";
		emit({ type: open.kind === "text" ? "text_end" : "thinking_end", contentIndex: open.index, content: text, partial: output });
		open = undefined;
	};
	const appendText = (kind: "text" | "thinking", delta: string) => {
		if (open?.kind !== kind) {
			closeOpen();
			output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			open = { kind, index: output.content.length - 1 };
			emit({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: open.index, partial: output });
		}
		const block = output.content[open.index];
		if (block.type === "text") block.text += delta;
		else if (block.type === "thinking") block.thinking += delta;
		emit({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: open.index, delta, partial: output });
	};
	const appendToolCall = (name: string, args: Record<string, unknown>) => {
		closeOpen();
		const block: PiContentBlock & { type: "toolCall" } = { type: "toolCall", id: mintId(), name, arguments: {} };
		output.content.push(block);
		const index = output.content.length - 1;
		emit({ type: "toolcall_start", contentIndex: index, partial: output });
		block.arguments = args;
		emit({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
		emit({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
	};

	// --- Cancellation and liveness. ---
	const local = new AbortController();
	let abortCause: "cancelled" | "idle" | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const abortWith = (cause: "cancelled" | "idle") => {
		if (abortCause) return;
		abortCause = cause;
		local.abort();
		void reader?.cancel().catch(() => undefined);
	};
	const armWatchdog = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => abortWith("idle"), deps.streamIdleMs);
	};
	const onParentAbort = () => abortWith("cancelled");
	const abortError = () => abortCause === "idle"
		? new OllamaProviderError("STREAM_IDLE_TIMEOUT", `no bytes received for ${deps.streamIdleMs} ms`)
		: new OllamaProviderError("CANCELLED");
	// Pi's hooks take no signal, so a pending hook cannot be cancelled. An abort
	// retires the turn without waiting; the hook's late result is discarded and
	// can no longer cause egress or stream events.
	const retired = new Promise<void>((resolve) => local.signal.addEventListener("abort", () => resolve(), { once: true }));
	const awaitHook = async (call: () => unknown): Promise<{ ok: true; value: unknown } | { ok: false }> => {
		const settled = Promise.resolve().then(call).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
		const result = await Promise.race([settled, retired.then(() => undefined)]);
		if (result === undefined || abortCause) throw abortError();
		return result;
	};

	try {
		if (options.signal?.aborted) throw new OllamaProviderError("CANCELLED");
		options.signal?.addEventListener("abort", onParentAbort, { once: true });

		// 1. Build.
		const configured = deps.models.get(model.id);
		if (!configured) throw new OllamaProviderError("MODEL_UNAVAILABLE", "model is not in the provider configuration");
		const built = buildOllamaChatRequest(
			{ ...configured, thinkingLevelMap: model.thinkingLevelMap },
			context,
			{ reasoning: options.reasoning, temperature: options.temperature, maxTokens: options.maxTokens, keepAlive: deps.keepAlive },
		);

		const mode = validateOllamaProviderMode(deps.mode ?? "standalone");
		const policy = deps.observability?.();
		if (mode === "require-observability" && !compatiblePolicy(policy)) throw new OllamaProviderError("OBSERVABILITY_UNAVAILABLE");
		// Supplied hooks are authoritative; absence is permitted only in standalone.
		let hooked: unknown;
		if (options.onPayload === undefined) {
			if (mode === "require-observability") throw new OllamaProviderError("PAYLOAD_HOOK_UNAVAILABLE");
		} else {
			if (typeof options.onPayload !== "function") throw new OllamaProviderError("PAYLOAD_REJECTED", "the payload hook is not callable");
			const onPayload = options.onPayload;
			const hookResult = await awaitHook(() => onPayload(built, model));
			if (!hookResult.ok) throw new OllamaProviderError("PAYLOAD_REJECTED", "the payload hook threw");
			hooked = hookResult.value;
		}
		let payload: OllamaChatRequest;
		if (hooked === undefined) {
			payload = built;
		} else if (isPlainRecord(hooked) && hooked.model === configured.id && Array.isArray(hooked.messages) && hooked.stream === true) {
			payload = hooked as unknown as OllamaChatRequest;
		} else {
			throw new OllamaProviderError("PAYLOAD_REJECTED", "the payload hook returned an unusable body");
		}
		if (payload.model !== configured.id || payload.stream !== true || payload.truncate !== false
			|| !isPlainRecord(payload.options) || payload.options.num_ctx !== configured.contextWindow
			|| !Array.isArray(payload.messages) || payload.messages.some(message => !isPlainRecord(message)
				|| !["system", "user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string")) {
			throw new OllamaProviderError("PAYLOAD_REJECTED", "the hooked body violates the native request bounds or shape");
		}
		let body: string;
		try {
			body = JSON.stringify(payload);
		} catch {
			throw new OllamaProviderError("PAYLOAD_REJECTED", "the hooked body cannot be serialized");
		}
		if (abortCause || options.signal?.aborted) throw abortError();
		if (mode === "require-observability" && !compatiblePolicy(policy)) throw new OllamaProviderError("OBSERVABILITY_UNAVAILABLE");

		// 3. Send. The watchdog covers model load and queueing before headers.
		armWatchdog();
		let response: Response;
		try {
			response = await postChat(deps.fetch, deps.baseUrl, body, local.signal);
		} catch (error) {
			if (abortCause) throw abortError();
			if (hostHttpTimeout(error) === "headers") {
				throw new OllamaProviderError("STREAM_IDLE_TIMEOUT", "no response headers within the host HTTP timeout (Pi httpIdleTimeoutMs); prompt evaluation may still be running");
			}
			throw new OllamaProviderError("CONNECTION_FAILED", `cannot reach ${new URL(deps.baseUrl).host}`);
		}
		if (abortCause) {
			await response.body?.cancel().catch(() => undefined);
			throw abortError();
		}
		const onResponse = options.onResponse;
		if (onResponse) {
			// Observational callback only; a throw cannot change the turn, but an abort while it is pending retires it.
			try {
				await awaitHook(() => onResponse({ status: response.status, headers: Object.fromEntries(response.headers) }, model));
			} catch (error) {
				await response.body?.cancel().catch(() => undefined);
				throw error;
			}
		}

		// 4. HTTP failure. Redirects are never followed (invariant 1), so a 3xx is a refusal, not a hop.
		if (isRedirectStatus(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			throw new OllamaProviderError("HTTP_ERROR", `unexpected redirect (HTTP ${response.status}) refused; only the configured baseUrl is contacted`);
		}
		if (!response.ok) {
			let text = "";
			try {
				text = (await readBoundedText(response, MAX_ERROR_BODY_BYTES)).text;
			} catch {
				if (abortCause) throw abortError();
			}
			if (abortCause) throw abortError();
			throw serverError(text, response.status);
		}
		if (!response.body) throw new OllamaProviderError("STREAM_TRUNCATED", "response has no body");

		// 5-6. Read NDJSON.
		start();
		reader = response.body.getReader();
		if (abortCause) throw abortError();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";
		let sawDone = false;
		let sawToolCall = false;
		let evalCount = 0;

		const processLine = (rawLine: string): void => {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line.trim().length === 0) return;
			let chunk: unknown;
			try {
				chunk = JSON.parse(line);
			} catch {
				throw new OllamaProviderError("STREAM_MALFORMED", "a response line is not JSON");
			}
			if (!isPlainRecord(chunk)) throw new OllamaProviderError("STREAM_MALFORMED", "a response line is not a JSON object");
			if (typeof chunk.error === "string") throw serverError(chunk.error);
			if (chunk.done !== undefined && typeof chunk.done !== "boolean") {
				throw new OllamaProviderError("STREAM_MALFORMED", "done is not a boolean");
			}
			const message = chunk.message;
			if (message !== undefined) {
				if (!isPlainRecord(message)) throw new OllamaProviderError("STREAM_MALFORMED", "message is not an object");
				for (const field of ["thinking", "content"] as const) {
					if (message[field] !== undefined && typeof message[field] !== "string") {
						throw new OllamaProviderError("STREAM_MALFORMED", `message.${field} is not a string`);
					}
				}
				if (typeof message.thinking === "string" && message.thinking.length > 0) appendText("thinking", message.thinking);
				if (typeof message.content === "string" && message.content.length > 0) appendText("text", message.content);
				if (message.tool_calls !== undefined) {
					if (!Array.isArray(message.tool_calls)) throw new OllamaProviderError("TOOL_CALL_INVALID", "tool_calls is not an array");
					for (const call of message.tool_calls) {
						const fn = isPlainRecord(call) ? call.function : undefined;
						if (!isPlainRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
							throw new OllamaProviderError("TOOL_CALL_INVALID", "a tool call has no function name");
						}
						let args = fn.arguments;
						if (typeof args === "string") {
							try {
								args = JSON.parse(args);
							} catch {
								throw new OllamaProviderError("TOOL_CALL_INVALID", `arguments for ${fn.name} are not JSON`);
							}
						}
						if (!isPlainRecord(args)) throw new OllamaProviderError("TOOL_CALL_INVALID", `arguments for ${fn.name} are not an object`);
						appendToolCall(fn.name, args);
						sawToolCall = true;
					}
				}
			}
			if (chunk.done === true) {
				closeOpen();
				const input = count(chunk.prompt_eval_count);
				evalCount = count(chunk.eval_count);
				output.usage = { ...zeroUsage(), input, output: evalCount, totalTokens: input + evalCount };
				output.stopReason = sawToolCall ? "toolUse" : chunk.done_reason === "length" ? "length" : "stop";
				sawDone = true;
			}
		};

		while (!sawDone) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch (error) {
				if (abortCause) throw abortError();
				if (hostHttpTimeout(error) === "body") {
					throw new OllamaProviderError("STREAM_IDLE_TIMEOUT", "no response bytes within the host HTTP timeout (Pi httpIdleTimeoutMs)");
				}
				throw new OllamaProviderError("STREAM_TRUNCATED", "the response stream failed");
			}
			if (abortCause) throw abortError();
			if (result.done) {
				buffer += decoder.decode();
				if (buffer.length > 0) processLine(buffer);
				buffer = "";
				break;
			}
			armWatchdog();
			buffer += decoder.decode(result.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1 && !sawDone) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length > MAX_NDJSON_LINE_LENGTH) throw new OllamaProviderError("STREAM_MALFORMED", "a response line exceeds 8 MiB");
				processLine(line);
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > MAX_NDJSON_LINE_LENGTH) throw new OllamaProviderError("STREAM_MALFORMED", "a response line exceeds 8 MiB");
		}

		// 7. Post-stream checks.
		if (!sawDone) throw new OllamaProviderError("STREAM_TRUNCATED", "the stream ended before the done chunk");
		const visibleText = output.content.some((block) =>
			(block.type === "text" && block.text.trim().length > 0) || block.type === "thinking" || block.type === "toolCall");
		if (evalCount > 0 && !visibleText) {
			throw new OllamaProviderError("GHOST_OUTPUT", `${evalCount} tokens generated with no visible output`);
		}

		finish();
	} catch (error) {
		finish(error instanceof OllamaProviderError
			? error
			: new OllamaProviderError(abortCause ? (abortCause === "idle" ? "STREAM_IDLE_TIMEOUT" : "CANCELLED") : "STREAM_MALFORMED",
				error instanceof Error ? error.message : undefined));
	} finally {
		// 8. The guard makes this a no-op on every path that already finished.
		finish(new OllamaProviderError("STREAM_TRUNCATED", "the stream ended without a terminal event"));
		if (idleTimer) clearTimeout(idleTimer);
		options.signal?.removeEventListener("abort", onParentAbort);
		if (reader) await reader.cancel().catch(() => undefined);
	}
}
