import type { OllamaProviderErrorCode } from "./contract.ts";

export const MAX_ERROR_DETAIL_LENGTH = 500;
const MAX_UNWRAP_DEPTH = 3;

/**
 * Pi's `isContextOverflow` recognizes this phrase in both 0.85.1 and 0.87.1
 * (`/prompt too long; exceeded (?:max )?context length/i`), so an overflow
 * reaches Pi as a compaction signal instead of a failed session.
 */
export const PI_CONTEXT_OVERFLOW_PHRASE = "prompt too long; exceeded max context length";

/** A stable code plus a bounded, human-readable detail. */
export class OllamaProviderError extends Error {
	readonly code: OllamaProviderErrorCode;

	constructor(code: OllamaProviderErrorCode, detail?: string) {
		const bounded = detail === undefined ? undefined : truncateDetail(detail);
		super(bounded ? `${code}: ${bounded}` : code);
		this.name = "OllamaProviderError";
		this.code = code;
	}
}

export function truncateDetail(text: string): string {
	return text.length > MAX_ERROR_DETAIL_LENGTH ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH - 3)}...` : text;
}

/** Unwraps nested JSON `{"error": ...}` bodies, at most three levels, then bounds the text. */
export function unwrapOllamaErrorText(raw: string): string {
	let text = raw.trim();
	for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			break;
		}
		if (typeof parsed === "string") {
			text = parsed.trim();
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) break;
		const inner = (parsed as Record<string, unknown>).error;
		if (typeof inner === "string") text = inner.trim();
		else if (inner && typeof inner === "object") text = JSON.stringify(inner);
		else break;
	}
	return truncateDetail(text);
}

// "Requested context size too large for model" is a load-time refusal of the
// configured num_ctx, not a prompt that outgrew the window.
const LOAD_TIME_CONTEXT_REFUSAL = /context size too large/i;
const OLLAMA_OVERFLOW_PATTERNS = [
	// Native truncate:false refusal: HTTP 400, nested
	// {"error":{"message":"request (N tokens) exceeds the available context size (M tokens), ...","type":"exceed_context_size_error"}}.
	/exceeds the available context size/i,
	/exceed_context_size_error/i,
	/prompt too long/i,
	/exceed(?:s|ed)?\b[^.]*\bcontext (?:length|window)/i,
	/input length[^.]*exceeds/i,
	/context length exceeded/i,
];

export function isOllamaOverflowText(text: string): boolean {
	if (LOAD_TIME_CONTEXT_REFUSAL.test(text)) return false;
	return OLLAMA_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/** Maps a server-reported error, from an HTTP body or an NDJSON `error` line. */
export function serverError(rawText: string, status?: number): OllamaProviderError {
	const text = unwrapOllamaErrorText(rawText);
	if (isOllamaOverflowText(text)) {
		return new OllamaProviderError("CONTEXT_OVERFLOW", `${PI_CONTEXT_OVERFLOW_PHRASE} (Ollama: ${text})`);
	}
	if (status === 404) return new OllamaProviderError("MODEL_UNAVAILABLE", `HTTP 404${text ? `: ${text}` : ""}`);
	const prefix = status === undefined ? "server error" : `HTTP ${status}`;
	return new OllamaProviderError("HTTP_ERROR", text ? `${prefix}: ${text}` : prefix);
}
