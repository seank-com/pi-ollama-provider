import { OLLAMA_CHAT_PATH, OLLAMA_SHOW_PATH } from "./contract.ts";

export type FetchLike = (url: string, init: {
	method: "POST";
	headers: Record<string, string>;
	body: string;
	/** Always manual: the configured origin is the only destination, so a 3xx is returned, never followed. */
	redirect: "manual";
	signal: AbortSignal;
}) => Promise<Response>;

export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_SHOW_BODY_BYTES = 4 * 1024 * 1024;

export function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

/** The only chat request the provider sends. `baseUrl` is the configured origin, never Pi's `model.baseUrl`. */
export function postChat(fetch: FetchLike, baseUrl: string, body: string, signal: AbortSignal): Promise<Response> {
	return fetch(`${baseUrl}${OLLAMA_CHAT_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		redirect: "manual",
		signal,
	});
}

/** Reads at most `limit` bytes of a response body as UTF-8 and releases the rest. */
export async function readBoundedText(response: Response, limit: number): Promise<{ text: string; complete: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: "", complete: true };
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	try {
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done) {
				complete = true;
				break;
			}
			const room = limit - total;
			chunks.push(value.length > room ? value.subarray(0, room) : value);
			total += Math.min(value.length, room);
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { text: new TextDecoder().decode(bytes), complete };
}

export type ShowResult =
	| { kind: "ok"; body: Record<string, unknown> }
	| { kind: "not_found" }
	/** No HTTP answer: connection failure or timeout. The only temporary-availability class. */
	| { kind: "unreachable"; detail: string }
	/** The server answered, but not with usable metadata. A protocol or configuration fault, never availability. */
	| { kind: "invalid"; code: "HTTP_ERROR" | "METADATA_INVALID"; detail: string };

/**
 * One bounded `/api/show` call. Only a missing HTTP answer (connection
 * failure or timeout) is unreachable. Any answer other than a 2xx JSON object
 * or a 404, including a redirect, an oversized body, or malformed JSON, is
 * invalid.
 */
export async function postShow(fetch: FetchLike, baseUrl: string, model: string, timeoutMs: number): Promise<ShowResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl}${OLLAMA_SHOW_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model }),
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status === 404) {
			await response.body?.cancel().catch(() => undefined);
			return { kind: "not_found" };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			const detail = isRedirectStatus(response.status)
				? `unexpected redirect (HTTP ${response.status}) refused`
				: `HTTP ${response.status}`;
			return { kind: "invalid", code: "HTTP_ERROR", detail };
		}
		const { text, complete } = await readBoundedText(response, MAX_SHOW_BODY_BYTES);
		if (!complete) return { kind: "invalid", code: "METADATA_INVALID", detail: `response exceeds ${MAX_SHOW_BODY_BYTES} bytes` };
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { kind: "invalid", code: "METADATA_INVALID", detail: "response is not JSON" };
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return { kind: "invalid", code: "METADATA_INVALID", detail: "response is not a JSON object" };
		}
		return { kind: "ok", body: body as Record<string, unknown> };
	} catch {
		return { kind: "unreachable", detail: controller.signal.aborted ? "timed out" : "connection failed" };
	} finally {
		clearTimeout(timer);
	}
}
