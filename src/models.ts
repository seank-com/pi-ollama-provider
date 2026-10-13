import { OLLAMA_API_ID, type OllamaProviderErrorCode } from "./contract.ts";
import { postShow, type FetchLike, type ShowResult } from "./client.ts";
import type { OllamaModelConfig, OllamaProviderConfig } from "./config.ts";
import type { PiThinkingLevelMap } from "./convert.ts";

/** Pi thinking levels other than off, in Pi's order. */
export const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelValidation =
	| {
		status: "verified" | "unverified";
		model: OllamaModelConfig;
		thinkingLevelMap?: PiThinkingLevelMap;
		/** Server thinking values no Pi level can carry. Reported, never renamed. */
		unmappedThinkingValues: string[];
		detail?: string;
	}
	| { status: "rejected"; model: OllamaModelConfig; code: OllamaProviderErrorCode; detail: string };

/** The Pi `ProviderModelConfig` for one validated model (design Section 5). */
export interface PiModelDefinition {
	id: string;
	name: string;
	api: typeof OLLAMA_API_ID;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: PiThinkingLevelMap;
	input: ["text"];
	cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
	contextWindow: number;
	maxTokens: number;
	compat: { supportsDeveloperRole: false; supportsReasoningEffort: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Builds Pi's thinking map from reported values. A Pi level whose name the
 * model reports maps to that string; other levels map to `null`
 * (unsupported). `off` stays unmapped, which sends `think: false`.
 */
export function buildThinkingLevelMap(values: readonly string[]): { map: PiThinkingLevelMap; unmapped: string[] } {
	const reported = new Set(values);
	const map: PiThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) map[level] = reported.has(level) ? level : null;
	const piLevels = new Set<string>(["off", ...PI_THINKING_LEVELS]);
	return { map, unmapped: values.filter((value) => !piLevels.has(value)) };
}

function contextLengths(modelInfo: unknown): number[] {
	if (!isRecord(modelInfo)) return [];
	return Object.entries(modelInfo)
		.filter(([key, value]) => key.endsWith(".context_length") && Number.isSafeInteger(value) && (value as number) > 0)
		.map(([, value]) => value as number);
}

/** Applies the design 8 validation table to one `/api/show` result. */
export function validateShowResult(model: OllamaModelConfig, result: ShowResult): ModelValidation {
	if (result.kind === "unreachable") {
		return { status: "unverified", model, unmappedThinkingValues: [], detail: result.detail };
	}
	if (result.kind === "not_found") {
		return { status: "rejected", model, code: "MODEL_UNAVAILABLE", detail: "the server does not have this model" };
	}
	if (result.kind === "invalid") {
		// The server answered without usable metadata. Registering unverified
		// would hide a protocol or configuration fault behind the availability rule.
		return { status: "rejected", model, code: result.code, detail: result.detail };
	}
	const body = result.body;
	const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((item) => typeof item === "string") : [];
	const mismatch = (detail: string): ModelValidation => ({ status: "rejected", model, code: "MODEL_CAPABILITY_MISMATCH", detail });
	for (const required of ["completion", "tools"]) {
		if (!capabilities.includes(required)) return mismatch(`capabilities lack ${required}`);
	}
	if (model.reasoning && !capabilities.includes("thinking")) return mismatch("reasoning is configured but capabilities lack thinking");
	const lengths = [...new Set(contextLengths(body.model_info))];
	if (lengths.length !== 1) return mismatch("model_info does not report exactly one context_length");
	if (model.contextWindow > lengths[0]) return mismatch(`contextWindow exceeds the model context_length of ${lengths[0]}`);

	const rawValues = isRecord(body.thinking) && Array.isArray(body.thinking.values) ? body.thinking.values : [];
	const values = rawValues.filter((value): value is string => typeof value === "string");
	if (!model.reasoning || values.length === 0) {
		return { status: "verified", model, unmappedThinkingValues: model.reasoning ? [] : values };
	}
	const { map, unmapped } = buildThinkingLevelMap(values);
	return { status: "verified", model, thinkingLevelMap: map, unmappedThinkingValues: unmapped };
}

/** Validates every configured model in parallel. Each call is bounded by `timeouts.metadataMs`. */
export async function validateConfiguredModels(config: OllamaProviderConfig, fetch: FetchLike): Promise<ModelValidation[]> {
	return Promise.all([...config.models.values()].map(async (model) =>
		validateShowResult(model, await postShow(fetch, config.baseUrl, model.id, config.timeouts.metadataMs))));
}

export function piModelDefinition(config: OllamaProviderConfig, validation: ModelValidation): PiModelDefinition {
	const { model } = validation;
	return {
		id: model.id,
		name: model.displayName,
		api: OLLAMA_API_ID,
		baseUrl: config.baseUrl,
		reasoning: model.reasoning,
		...(validation.status !== "rejected" && validation.thinkingLevelMap ? { thinkingLevelMap: validation.thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}

/** One status line: host and port only, then per-model state. */
export function formatRegistrationStatus(config: OllamaProviderConfig, validations: readonly ModelValidation[]): string {
	const models = validations.map((validation) => {
		const id = validation.model.id;
		if (validation.status === "rejected") return `${id} rejected (${validation.code})`;
		const unmapped = validation.unmappedThinkingValues.length > 0
			? ` [unmapped thinking values: ${validation.unmappedThinkingValues.join(", ")}]`
			: "";
		return `${id} ${validation.status}${unmapped}`;
	});
	return `Ollama ${new URL(config.baseUrl).host}: ${models.join("; ")}`;
}
