import { randomUUID } from "node:crypto";

// Minimal consumer wire shapes. Owner contract fixtures check these identifiers
// and signatures; no owner business logic or npm dependency is copied here.
export const OBSERVABILITY_CAPABILITY_REQUEST = "pi-observability:v1:capability-request";
export const OBSERVABILITY_CAPABILITY_REPLY = "pi-observability:v1:capability-reply";
export const TOOL_INTENT_ARGUMENT = "intent";
export type IntentSanitizer = (value: unknown, supplied?: boolean) => { ok: true; value: string } | { ok: false; reason: string };
export interface ObservabilityPolicy {
	version: 1;
	readonly ready: boolean;
	sanitizeIntent: IntentSanitizer;
	redactRecovery(payload: unknown): unknown;
}
export interface ObservabilityBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}
export function compatiblePolicy(value: unknown): value is ObservabilityPolicy {
	const policy = value as Partial<ObservabilityPolicy> | null;
	return !!policy && policy.version === 1 && policy.ready === true
		&& typeof policy.sanitizeIntent === "function" && typeof policy.redactRecovery === "function";
}
export function queryObservabilityPolicy(bus: ObservabilityBus | undefined): ObservabilityPolicy | undefined {
	if (!bus) return undefined;
	const requestId = randomUUID();
	let result: ObservabilityPolicy | undefined; let replies = 0;
	const unsubscribe = bus.on(OBSERVABILITY_CAPABILITY_REPLY, (data) => {
		const reply = data as { version?: number; requestId?: string; capability?: unknown } | null;
		if (!reply || reply.version !== 1 || reply.requestId !== requestId || !compatiblePolicy(reply.capability)) return;
		result = reply.capability; replies++;
	});
	try { bus.emit(OBSERVABILITY_CAPABILITY_REQUEST, { version: 1, requestId }); }
	finally { unsubscribe(); }
	return replies === 1 ? result : undefined;
}
