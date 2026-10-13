# Native Ollama provider design

The extension owns model/config validation, Pi transcript conversion, native
Ollama streaming, tool-call mapping, transport bounds, cancellation, and the
provider-neutral intent policy boundary. It is independently useful without
other extensions. Observability owns auditing, intent policy, redaction, and tool
execution gating; those business rules are not duplicated here.

## Configuration and model identity

One protected `<project>/.pi/ollama-provider/config.json` snapshot is loaded per
runtime. JSON is strict: unknown/duplicate fields, unsupported versions, unsafe
paths/modes, wrong ownership, symlinks, identity changes, oversize config, and
invalid UTF-8 fail closed. Missing config registers no provider and makes no
network request. Windows is explicitly unsupported by this filesystem contract.

`baseUrl` is a normalized HTTP(S) origin with no credentials, path prefix, query,
or fragment. Only that configured origin is contacted; a Pi model's ambient
`baseUrl` cannot override it. Exact configured model references are validated
through bounded `/api/show`. Completion/tools capabilities and one compatible
context-length value are required; reasoning additionally requires thinking.
Invalid/mismatching models are rejected. Transport-unavailable models retain
the existing explicit unverified status instead of pretending metadata passed.
The provider never installs models, accepts an ambient alias, or supplies a
second Pi runtime. Its required registration key `unused` is never transmitted.

## Modes and payload callback semantics

Schema v1 adds `mode: standalone | require-observability`, defaulting to
`standalone`. A validated factory override takes precedence and is captured as
an immutable runtime choice. Private wrappers can require strict behavior while
leaving public configuration intact. Both entries must not be loaded together.

Each turn builds an ordinary validated native request from its configured model
and current transcript. In standalone mode, an absent callback uses that body.
A supplied `onPayload` executes exactly once, is awaited, and follows Pi's
semantics: undefined keeps the possibly mutated body; a usable object replaces
it. Null, non-callable callbacks, throws/rejections, malformed shapes, changed
model/context/truncation bounds, or unserializable bodies fail with
`PAYLOAD_REJECTED`; no unprocessed fallback is sent.

Strict mode additionally requires compatible live policy readiness and a
callback on every content-bearing Pi request, including compaction. Absence of
policy yields `OBSERVABILITY_UNAVAILABLE`; absence of callback yields
`PAYLOAD_HOOK_UNAVAILABLE`. Readiness is checked before the hook and again before
HTTP, preventing a revoked capability from authorizing egress after a pending
callback. `/api/show` startup checks contain model identity, not Pi conversation
content, and are outside this callback contract.

Stock Pi 0.87.1 omits its compaction callback and strict compaction refuses
before network traffic. The existing patched artifact forwards the callback and
passes strict redacted compaction. Standalone compaction succeeds on both. Host
capability must be verified independently; extraction does not fix the upstream
defect or relax private assembly policy.

## Small optional integration

The consumer keeps only the structural v1 policy interface and wire identifiers
for `pi-observability:v1:capability-request` / `...:capability-reply`, checked
against the owner's packed contract. A synchronous event-bus query resolves
readiness, `sanitizeIntent`, and `redactRecovery`. Missing, incompatible,
unready, malformed, or duplicate responders grant no capability. The reply
listener is removed immediately. No optional npm peer, module singleton, or
sibling source lookup acts as discovery.

The extension reevaluates at session readiness and queries the active service
for requests. Session shutdown aborts its owned streams and invalidates future
use of their lifecycle signal; a replacement start gets a fresh controller.
Captured policy generations are checked by the owner. Supplied hooks have no
signal in Pi's API, so their asynchronous work cannot be forcibly cancelled;
retired turns discard late results and cannot send requests or emit late events.

## Conversion and streaming

The provider registers as `ollama` with API identifier `pi-ollama-chat`. The
call ID prefix remains `ollama_`, and native wire shapes are unchanged. This
pre-release API identifier replaces the earlier monorepo identifier without an
alias; rebuild consumers together. Existing session files are not rewritten.
Transcript normalization folds current system
sections/tools and mid-conversation tool changes. Native messages preserve
system/user/assistant/tool roles, separate thinking, historical tool IDs/names,
and object arguments. JSON-schema tools are preserved. Unsupported modalities
fail or use the existing explicit image-omission marker for text-only models.
Thinking resolves from validated Pi level mappings; configured context windows
are always sent as `options.num_ctx`, with `truncate:false`.

Every turn has exactly one terminal event and sink end. Failed/aborted turns
remove partial executable calls from their terminal message. Tool IDs are
provider-minted and unique, independent of server IDs. Arguments must decode to
plain objects; malformed NDJSON/tool calls, missing done frames, and ghost output
produce deterministic errors. Usage counts describe the main request only.
Overflow messages preserve the phrase recognized by the selected Pi host.

HTTP redirects are manual refusals and never followed. Metadata bodies are
bounded at 4 MiB, error bodies at 64 KiB, and decoded stream lines at
8 * 1024 * 1024 code units. The configured idle watchdog starts before fetch,
covers model load/queueing and response gaps, and resets on byte arrival.
Pi's own HTTP header/body timeout can also fire and remains separately classified.
Parent cancellation aborts fetch, cancels owned readers, and retires pending
payload/response callbacks. Observational response-hook failure does not replace
the request or cause retry fallback.

## Intent policy ownership

The provider returns parsed tool calls without filling missing intent. It does
not make auxiliary explanation requests, retry calls, or record recovery outcomes.
pi-observability owns one corrective tool-call retry at the awaited message-end
boundary. It uses the same registered provider through Pi's model registry,
with its own redacted payload callback and parent-owned cancellation. The provider
handles that request as an ordinary request; strict mode still requires a live
policy and a payload callback. The retry must repeat the original tool and
arguments, adding only intent. Observability validates, audits, strips intent,
and gates execution; failure leaves the held call blocked.

The old recovery module and outcome constant are removed from this pre-release
package. Rebuild companions together. Ordinary standalone tools still require
no observability policy or intent.

## Package and validation boundary

`dist/index.js` is the explicit default entry. The root exports
`createOllamaExtension` for strict wrappers; pure `/contract` exports protocol
types/identifiers without activation. ESM runtime imports are rewritten to `.js`,
and declarations ship alongside them. Only actual Pi host imports are `*` peers;
the test host is separately pinned at 0.87.1. There are no production libraries
or companion-extension dependencies.

Unit tests pin conversion, metadata, callbacks, streaming, cancellation, and
strict policy readiness with injected fixtures. Real host checks pin transcript helpers,
schemas, overflow recognition, and event consumers. Packed standalone tests use
real Pi tools and compaction with no observability installation. Explicit packed
composition tests use separate module roots and the actual owner, both load
orders, redaction/tool-call retry/auditing, teardown, and strict compaction behavior.
Historical policy/campaign harnesses remain private composition evidence; they
are not copied into this package or required for its isolated default suite.
