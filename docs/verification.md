# Wire-level verification

What has been checked against real code, and how to repeat it. Nothing here is a live-harness run:
these checks stop at the pi-ai request, with the network replaced by a stub.

## 1. Per-account credential and session header

Purpose: prove that the plugin's adapter construction — one `PiAiAdapter` per account, a
hand-built provider profile, `resolveApiKey` returning that account's secret — produces real
requests with the right credential and the right session header.

Procedure, inside a harness checkout that carries the `sessionAffinity` change:

```ts
// run from packages/llm/llm-pi-ai
import { PiAiAdapter } from './src/index.ts'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'

// profile: { provider: 'opencode-go', displayName, streamLenDefaults..., retryPolicy,
//            configuredMaxTokens: new Map(), modelErrors: new Map(),
//            piProvider: opencodeGoProvider() }

// globalThis.fetch = stub that records `new Headers(init.headers)` and answers 500
// adapter.stream({ provider: 'opencode-go', model: 'deepseek-v4-pro',
//                  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
//                  sessionId, sessionAffinity })
```

Result on `2026-10-27`, harness `feat/session-affinity` + patched pi-ai 1.3.0:

| dispatch             | `authorization`   | `x-opencode-session` | `x-opencode-session-id` |
| -------------------- | ----------------- | -------------------- | ----------------------- |
| root session, key 1  | `Bearer sk-key-1` | `sess-root`          | `sess-root`             |
| child session, key 2 | `Bearer sk-key-2` | `sess-root`          | `sess-child`            |

Two facts this pins down: the credential follows the adapter instance (so per-account adapters are
the mechanism), and the header that keys the gateway cache carries the **lineage root** while the
raw session id travels separately — exactly the behaviour the rotation depends on.

A hand-built profile is enough: `listModels` returns the full catalog (29 models),
`resolveModel('opencode-go', 'deepseek-v4-pro')` resolves with a 1M context window, and
`providerRetryPolicy` round-trips the policy the plugin declares.

## 2. Endpoints

- Model traffic goes to `https://opencode.ai/inference/go/v1/...` (from the pi-ai provider).
- Usage lives at `https://opencode.ai/zen/go/v1/usage`. The two prefixes differ; the usage client
  defaults to the `zen` one.

## Not verified yet

- The plugin mounted inside a running harness: route takeover, `DUPLICATE_ADAPTER` retry, pin
  records written and read back, and the background poller.
- A real quota failure mid-conversation, which needs two accounts and a spent one.
