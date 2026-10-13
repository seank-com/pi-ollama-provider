# pi-ollama-provider
A simple extension for Pi that implements native ollama provider to work around tool call failures in OpenAI compatible endpoints

This standalone provider uses Ollama's native `/api/chat` protocol, preserves
tool schemas and conversation history, maps streaming text/thinking/tools into
Pi events, and validates explicitly configured models. It requires no Telegram,
datastore, or observability package.

## Local quick start

The `0.1.0` candidate has not been published. Use Node 24.14.1 or later and Pi
0.87.1 on a POSIX host. CI pins the stock npm host; local acceptance additionally
checks the selected patched 0.87.1 artifact. Other host versions are unverified.
The configuration loader rejects Windows because its ownership/mode contract
depends on POSIX filesystem semantics.

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm run test:package
```

Create a protected project-local config as described in [setup](docs/setup.md),
then load `dist/index.js` once through Pi. Models remain under provider `ollama`
and API `pi-ollama-chat`; the provider does not install Ollama or download models.

## Two modes

`standalone` is the public default. With no payload callback, inference and
compaction use the ordinary validated request. A supplied callback is called
exactly once; its mutations/replacement are honored, and failure never falls
back to an unprocessed request. Ordinary tools need no audit intent.

`require-observability` requires both a compatible active observability policy
and a payload callback on every outbound Pi inference/compaction request.
Missing/incompatible/unready policy, missing callback, or malformed/rejected
callback results fail before chat egress. Installing a companion package alone
does not satisfy readiness. Startup `/api/show` metadata checks are separate
from Pi content-bearing requests.

A private assembly can enforce this mode without editing settings:

```typescript
import { createOllamaExtension } from "@seank/pi-ollama-provider";
export default createOllamaExtension({ mode: "require-observability" });
```

Load only this wrapper, rather than also loading the public default entry. The
factory override takes precedence over the configuration's mode. Pure protocol
definitions are exported from `@seank/pi-ollama-provider/contract`.

**Host limitation:** stock Pi 0.87.1 omits the compaction payload callback, so
strict compaction refuses before HTTP. The separately tested existing patched
artifact forwards it and passes strict redacted compaction. Standalone compaction
works on both. This package does not repair the host or upgrade Pi.

## Intent policy and tests

Missing-intent retry belongs to pi-observability. This provider returns model
calls unchanged and never asks a separate explanation question or retries them.
An active observability extension can request one corrected tool call through
Pi's common model interface, then audit and gate execution. Standalone use
still requires no audit intent. See [design](docs/design.md).

Default tests use scripted/loopback HTTP and disposable profiles; no live
providers, personal histories, or agent state are fixtures. The packed test
installs the actual tarball alone, imports its contract/declarations, and checks
real Pi tool execution and compaction. One Windows-only test is skipped on POSIX.

Packed composition is a separate explicit check, not a default dependency:

```bash
OBSERVABILITY_TARBALL=/path/to/tested-observability.tgz npm run test:integration
EXPECTED_COMPACTION_POLICY=enforced PI_CODING_AGENT_PACKAGE=/path/to/tested-patched-host \
  OBSERVABILITY_TARBALL=/path/to/tested-observability.tgz npm run test:integration
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm test
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm run test:package
```

Integration installs the owner tarball under a separate module root and tests
both load orders, redaction/tool-call retry/auditing, hook failures, teardown, strict
real-host inference, and the selected host’s strict compaction behavior. Only compiled JS/declarations,
generic docs, README, LICENSE, and package metadata ship. Public README/MIT
history and extracted-code attribution are preserved.
