import {
	OLLAMA_IMAGE_OMITTED_MARKER,
	type OllamaChatMessage,
	type OllamaChatRequest,
	type OllamaTool,
	type OllamaToolCall,
} from "./contract.ts";
import { OllamaProviderError } from "./errors.ts";

/**
 * Structural views of the Pi `@earendil-works/pi-ai` message contract, so this
 * module never imports Pi. Only the fields the provider reads are named.
 */
export interface PiTool {
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
}

export type PiThinkingLevelMap = Partial<Record<string, string | null>>;

export interface PiModelView {
	id: string;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevelMap?: PiThinkingLevelMap;
}

export interface NormalizedContext {
	systemPrompt: string;
	tools: PiTool[];
	/** The conversation without system messages. */
	messages: Record<string, unknown>[];
}

const fail = (detail: string) => new OllamaProviderError("CONTEXT_CONVERSION_FAILED", detail);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const SYSTEM_MESSAGE_KEYS = new Set(["role", "content", "sections", "toolsAdded", "toolsRemoved", "timestamp"]);

function textBlocks(content: unknown, what: string): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) throw fail(`${what} content must be a string or an array of text blocks`);
	return content.map((block) => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
			throw fail(`${what} content contains an unsupported block`);
		}
		return block.text;
	});
}

function piTool(value: unknown): PiTool {
	if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) throw fail("tool has no name");
	if (value.description !== undefined && typeof value.description !== "string") throw fail(`tool ${value.name} has a non-string description`);
	if (!isRecord(value.parameters)) throw fail(`tool ${value.name} has no parameters object`);
	return value as unknown as PiTool;
}

interface SystemView {
	content: string;
	sections?: Record<string, string | null>;
	toolsAdded: PiTool[];
	toolsRemoved: string[];
}

function systemMessage(value: Record<string, unknown>): SystemView {
	if (Object.keys(value).some((key) => !SYSTEM_MESSAGE_KEYS.has(key))) throw fail("system message has an unrecognized field");
	const content = textBlocks(value.content, "system message").join("\n");
	let sections: Record<string, string | null> | undefined;
	if (value.sections !== undefined) {
		if (!isRecord(value.sections)) throw fail("system message sections must be an object");
		for (const section of Object.values(value.sections)) {
			if (section !== null && typeof section !== "string") throw fail("system message section must be a string or null");
		}
		sections = value.sections as Record<string, string | null>;
	}
	if (value.toolsAdded !== undefined && !Array.isArray(value.toolsAdded)) throw fail("toolsAdded must be an array");
	if (value.toolsRemoved !== undefined && !Array.isArray(value.toolsRemoved)) throw fail("toolsRemoved must be an array");
	const toolsAdded = ((value.toolsAdded as unknown[] | undefined) ?? []).map(piTool);
	const toolsRemoved = ((value.toolsRemoved as unknown[] | undefined) ?? []).map((reference) => {
		if (!isRecord(reference) || typeof reference.name !== "string") throw fail("toolsRemoved entry has no name");
		return reference.name;
	});
	return { content, sections, toolsAdded, toolsRemoved };
}

/**
 * Normalizes both Pi context contracts into one prompt, one tool list, and the
 * conversation. Pi 0.85.1 passes `systemPrompt` and `tools`; Pi 0.86+ carries
 * them as `role: "system"` transcript messages. As in Pi's own
 * `normalizeContext`, top-level fields fold into a leading system message, and
 * every system message is then replayed in order: content accumulates, named
 * sections are replaced or removed (`null`), and tools are removed then added
 * by name. The rendered prompt is the accumulated content followed by the live
 * sections, non-empty parts joined by a blank line.
 */
export function normalizePiContext(context: unknown): NormalizedContext {
	if (!isRecord(context) || !Array.isArray(context.messages)) throw fail("context has no messages array");
	if (context.systemPrompt !== undefined && typeof context.systemPrompt !== "string") throw fail("systemPrompt must be a string");
	if (context.tools !== undefined && !Array.isArray(context.tools)) throw fail("tools must be an array");

	const systemViews: SystemView[] = [];
	const initialTools = ((context.tools as unknown[] | undefined) ?? []).map(piTool);
	const initialPrompt = (context.systemPrompt as string | undefined) ?? "";
	if (initialPrompt.length > 0 || initialTools.length > 0) {
		systemViews.push({ content: initialPrompt, toolsAdded: initialTools, toolsRemoved: [] });
	}
	const messages: Record<string, unknown>[] = [];
	for (const message of context.messages) {
		if (!isRecord(message) || typeof message.role !== "string") throw fail("message has no role");
		if (message.role === "system") systemViews.push(systemMessage(message));
		else messages.push(message);
	}

	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, PiTool>();
	for (const view of systemViews) {
		if (view.content.length > 0) content.push(view.content);
		for (const [name, value] of Object.entries(view.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const name of view.toolsRemoved) tools.delete(name);
		for (const tool of view.toolsAdded) tools.set(tool.name, tool);
	}
	const systemPrompt = [content.join("\n\n"), ...sections.values()].filter((part) => part.length > 0).join("\n\n");
	return { systemPrompt, tools: [...tools.values()], messages };
}

function userOrResultText(content: unknown, what: string): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw fail(`${what} content must be a string or an array`);
	return content.map((block) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
		if (isRecord(block) && block.type === "image") return OLLAMA_IMAGE_OMITTED_MARKER;
		throw fail(`${what} content contains an unsupported block`);
	}).join("\n");
}

function cloneJson<T>(value: T, what: string): T {
	try {
		return structuredClone(value);
	} catch {
		throw fail(`${what} is not cloneable data`);
	}
}

function assistantMessage(message: Record<string, unknown>, includeThinking: boolean): OllamaChatMessage {
	if (!Array.isArray(message.content)) throw fail("assistant content must be an array");
	let text = "";
	let thinking = "";
	const toolCalls: OllamaToolCall[] = [];
	for (const block of message.content) {
		if (!isRecord(block)) throw fail("assistant content contains an unsupported block");
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			// Redacted thinking is an opaque provider payload, never model-readable text.
			if (block.redacted !== true) thinking += block.thinking;
		} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" && isRecord(block.arguments)) {
			toolCalls.push({ id: block.id, function: { name: block.name, arguments: cloneJson(block.arguments, "tool-call arguments") } });
		} else {
			throw fail("assistant content contains an unsupported block");
		}
	}
	const result: OllamaChatMessage = { role: "assistant", content: text };
	if (includeThinking && thinking.length > 0) result.thinking = thinking;
	if (toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

/**
 * Thinking-history policy (design 6): only assistant messages after the last
 * user message, the current agent loop, carry `thinking`.
 */
export function currentLoopStart(messages: readonly Record<string, unknown>[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index + 1;
	}
	return 0;
}

/** Maps the non-system conversation to Ollama messages, applying pruning and the thinking policy. */
export function convertConversation(messages: readonly Record<string, unknown>[]): OllamaChatMessage[] {
	const loopStart = currentLoopStart(messages);
	const result: OllamaChatMessage[] = [];
	let pruningResults = false;
	for (const [index, message] of messages.entries()) {
		if (message.role !== "toolResult") pruningResults = false;
		if (message.role === "user") {
			result.push({ role: "user", content: userOrResultText(message.content, "user") });
		} else if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// A failed turn and the results that answer it are not replayable history.
				pruningResults = true;
				continue;
			}
			result.push(assistantMessage(message, index >= loopStart));
		} else if (message.role === "toolResult") {
			if (pruningResults) continue;
			if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
				throw fail("tool result has no toolCallId or toolName");
			}
			result.push({
				role: "tool",
				content: userOrResultText(message.content, "tool result"),
				tool_name: message.toolName,
				tool_call_id: message.toolCallId,
			});
		} else {
			throw fail("message has an unsupported role");
		}
	}
	return result;
}

export function convertTools(tools: readonly PiTool[]): OllamaTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: cloneJson(tool.parameters, `tool ${tool.name} parameters`),
		},
	}));
}

/**
 * Resolves the wire `think` value (design 8). Non-reasoning models never send
 * it. Reasoning models always send it, because an omitted `think` lets the
 * server choose. With a thinking map, a level maps to its reported string and
 * `off` sends `false` unless the map marks it unsupported (`null`, in which
 * case the server default applies). Without a map, off is `false` and every
 * other level is `true`.
 */
export function resolveThink(model: PiModelView, level: string | undefined): boolean | string | undefined {
	if (!model.reasoning) return undefined;
	const requested = level ?? "off";
	const map = model.thinkingLevelMap;
	if (!map) return requested !== "off";
	const mapped = map[requested];
	if (typeof mapped === "string") return mapped;
	if (requested === "off") return mapped === null ? undefined : false;
	throw fail(`thinking level ${requested} is not supported by this model`);
}

export interface BuildRequestOptions {
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	keepAlive: string | number | null;
}

/** Builds the `/api/chat` body. Optional keys are absent when unset, never `undefined` or `null`. */
export function buildOllamaChatRequest(model: PiModelView, context: unknown, options: BuildRequestOptions): OllamaChatRequest {
	const normalized = normalizePiContext(context);
	const messages = convertConversation(normalized.messages);
	if (normalized.systemPrompt.length > 0) messages.unshift({ role: "system", content: normalized.systemPrompt });
	const tools = convertTools(normalized.tools);
	const think = resolveThink(model, options.reasoning);

	if (options.temperature !== undefined && (typeof options.temperature !== "number" || !Number.isFinite(options.temperature))) {
		throw fail("temperature must be a finite number");
	}
	if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
		throw fail("maxTokens must be a positive integer");
	}
	return {
		model: model.id,
		messages,
		...(tools.length > 0 ? { tools } : {}),
		stream: true,
		...(think !== undefined ? { think } : {}),
		options: {
			num_ctx: model.contextWindow,
			...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
		},
		...(options.keepAlive !== null ? { keep_alive: options.keepAlive } : {}),
		truncate: false,
	};
}
