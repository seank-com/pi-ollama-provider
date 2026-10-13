/**
 * Stable, implementation-free Ollama `/api/chat` and `/api/show` wire contract
 * shared by the Ollama provider and its tests. Observability never imports
 * this module; its instrumentation and retries use normalized Pi messages.
 */
export const OLLAMA_PROVIDER_NAME = "ollama" as const;
export const OLLAMA_API_ID = "pi-ollama-chat" as const;
export const OLLAMA_CHAT_PATH = "/api/chat" as const;
export const OLLAMA_SHOW_PATH = "/api/show" as const;
export const OLLAMA_TOOL_CALL_ID_PREFIX = "ollama_" as const;
export const OLLAMA_IMAGE_OMITTED_MARKER = "[image omitted: model is text-only]" as const;

export type OllamaProviderErrorCode =
	| "CONFIG_MISSING" | "CONFIG_INVALID" | "CONFIG_VERSION_UNSUPPORTED" | "PLATFORM_UNSUPPORTED"
	| "MODEL_UNAVAILABLE" | "MODEL_CAPABILITY_MISMATCH" | "METADATA_INVALID"
	| "CONTEXT_CONVERSION_FAILED"
	| "PAYLOAD_HOOK_UNAVAILABLE" | "PAYLOAD_REJECTED"
	| "OBSERVABILITY_UNAVAILABLE"
	| "HTTP_ERROR" | "CONNECTION_FAILED"
	| "CONTEXT_OVERFLOW"
	| "STREAM_MALFORMED" | "STREAM_TRUNCATED" | "STREAM_IDLE_TIMEOUT" | "GHOST_OUTPUT" | "TOOL_CALL_INVALID"
	| "CANCELLED";

export interface OllamaTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaToolCall {
	id: string;
	function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	thinking?: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
	tool_call_id?: string;
}

export interface OllamaChatOptions {
	num_ctx: number;
	temperature?: number;
	num_predict?: number;
}

/** Optional fields are absent when unset; they are never `undefined` or `null` on the wire. */
export interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	tools?: OllamaTool[];
	stream: true;
	think?: boolean | string;
	options: OllamaChatOptions;
	keep_alive?: string | number;
	truncate: false;
}

export interface OllamaChatChunk {
	model: string;
	created_at: string;
	message?: {
		role: "assistant";
		content?: string;
		thinking?: string;
		tool_calls?: Array<{ id?: string; function: { name: string; arguments: unknown } }>;
	};
	done: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

/** The `/api/show` fields the provider reads. Every other field is ignored. */
export interface OllamaShowResponse {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
	thinking?: { values?: unknown[] };
}
