import type { IntentSanitizer, ObservabilityPolicy } from "../../src/observability.ts";

// Exact synthetic responses from an injected policy. The owner's sanitizer
// implementation and its comprehensive tests stay in the owning component.
const rejections = new Map([
  ["Find files matching `**/*.ts`.", "shell_syntax"],
  ["Read the file at /srv/app/config.json.", "path"],
  ["Search with --ignore-case for handlers.", "option"],
]);
export const fixtureSanitize: IntentSanitizer = value => {
  if (typeof value !== "string") return {ok:false,reason:"invalid_type"};
  const reason = rejections.get(value);
  return reason ? {ok:false,reason} : {ok:true,value};
};
export function fixturePolicy(overrides: Partial<ObservabilityPolicy> = {}): ObservabilityPolicy {
  return {version:1,ready:true,sanitizeIntent:fixtureSanitize,redactRecovery:body=>structuredClone(body),...overrides};
}
