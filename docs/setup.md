# Standalone setup

Use Node 24.14.1 or later and a tested Pi 0.87.1 host on POSIX. The provider
does not install Ollama, pull models, or change Pi settings. Prepare the server
and exact model references manually, then create a trusted project's protected
configuration:

```bash
mkdir -p .pi/ollama-provider
chmod 700 .pi/ollama-provider
```

Write `.pi/ollama-provider/config.json`:

```json
{
  "schemaVersion": 1,
  "mode": "standalone",
  "baseUrl": "http://localhost:11434",
  "timeouts": { "metadataMs": 5000, "streamIdleMs": 900000 },
  "keepAlive": "15m",
  "models": {
    "example-model:latest": {
      "displayName": "Example model",
      "contextWindow": 8192,
      "maxOutputTokens": 1024,
      "reasoning": false
    }
  }
}
```

Replace the example reference with an installed model whose native metadata
supports completion and tools. Set `reasoning` only when it supports thinking.
`contextWindow` must fit the metadata's model context length. Set the file to
mode 0600 or stricter. Configuration directories/files must be real,
current-user-owned and protected; source config is never repaired or rewritten
automatically. Duplicate/unknown keys fail validation.

The base URL must be an HTTP(S) origin with no credentials, path prefix, query,
or fragment. `metadataMs` is 1,000–30,000; `streamIdleMs` is 60,000–3,600,000.
Default values are 5,000 and 900,000 ms. Omit `keepAlive` or use null to leave
server residency policy unchanged; reviewed duration strings or integer seconds
are accepted. Context windows are 2,048–1,048,576 and maximum output tokens are
256 through the configured context window. All values are validated locally.

Build with `npm ci && npm run build`, load `/path/to/pi-ollama-provider/dist/index.js`
once, then select provider `ollama` and the configured model. Missing config is
quiet and makes no request. Invalid config visibly disables the provider;
per-model validation reports verified, unverified, or rejected state. An
unverified transport result does not claim the model was checked successfully.

## Standalone versus strict policy

The omitted/default mode is `standalone`. Normal tools operate without synthetic
audit intent, and missing payload callbacks do not prevent inference/compaction.
Any supplied callback is still authoritative: throws/rejections, null or
malformed output, serialization failures, and changed configured request bounds
are errors, with no raw-request fallback.

Use `require-observability` when the runtime requires enforced outbound policy.
Load a compatible observability extension and ensure its credential prerequisites
are ready. Neither an installed library nor callback presence alone establishes
an active service. Requests require both v1 active capability and callback;
otherwise they fail before chat HTTP. Recovery uses that service's helpers, and
never sends unredacted questions.

For private assembly, enforce mode through a small factory wrapper:

```typescript
import { createOllamaExtension } from "@seank/pi-ollama-provider";
export default createOllamaExtension({ mode: "require-observability" });
```

The override wins over `mode: standalone` in the project file. Select only the
wrapper in the Pi manifest, not both it and the public entry. Readiness is
reevaluated at session start/resource discovery and checked on outbound turns;
reversed initialization order is supported. Shutdown/reload retires old turns.

Stock Pi 0.87.1 omits the compaction callback: strict mode produces
`PAYLOAD_HOOK_UNAVAILABLE` without HTTP. The existing tested patched artifact
forwards it and passes strict redacted compaction. Standalone works on both.
Verify the selected host capability before relying on strict compaction; do not
switch private assembly to standalone to evade a missing callback.

## Troubleshooting

`OBSERVABILITY_UNAVAILABLE` means the required active capability is absent,
incompatible, unready, or ambiguous. Check extension selection and owner
readiness; installing it alone is insufficient. `PAYLOAD_HOOK_UNAVAILABLE` means
the strict request path supplied no callback. `PAYLOAD_REJECTED` means a supplied
callback failed or produced unusable output; do not retry with the original body.

`MODEL_CAPABILITY_MISMATCH`/`METADATA_INVALID` reject unsafe registration. Check
the exact reference, reported tools/thinking capabilities, and context length.
`CONTEXT_OVERFLOW` preserves Pi's recognized signal; a load-time refusal of an
oversized configured context is a different failure and requires correcting
configuration, not advancing history or hiding the error.

`STREAM_IDLE_TIMEOUT` can come from the provider's byte-gap watchdog or Pi's own
HTTP header/body timeout during queueing/loading. Investigate progress before
changing budgets. Any Pi setting or live runtime change remains a separate
operator action. `STREAM_TRUNCATED`, `STREAM_MALFORMED`, or `TOOL_CALL_INVALID`
prevent partial calls from executing. Abort retires pending callbacks/readers;
their late results cannot send requests or affect an active replacement turn.

Missing-intent retry and its outcome records are owned by pi-observability.
The provider does not repair calls. With observability active, one corrected
call may be requested; failed correction remains blocked. Ordinary standalone
tools need no audit intent.

Default and explicit packed integration commands are in the README. Tests use
synthetic loopback endpoints and disposable sessions; live server/model
qualification is a separate manual acceptance step.
