import type { IntentSanitizer, ObservabilityPolicy } from "../../src/observability.ts";

// Provider tests inspect capability shape/readiness, not owner policy.
// Calling either owner operation here is a provider-boundary regression.
export const fixtureSanitize: IntentSanitizer = () => {
  throw new Error("provider must not sanitize audit intent");
};
export function fixturePolicy(overrides: Partial<ObservabilityPolicy> = {}): ObservabilityPolicy {
  return {version:1,ready:true,sanitizeIntent:fixtureSanitize,redactRecovery:()=>{throw new Error("provider must not construct owner recovery payloads");},...overrides};
}
