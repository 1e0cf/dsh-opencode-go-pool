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

## 3. Live harness, in-session re-pin

Observed on `2026-10-29` with the desktop build (`0.2.2-alpha.2`, `feat/session-affinity`), two
OpenCode Go accounts, `policy: threshold`, `thresholdPercent: 90`, `primary` at 99% monthly and
`secondary` at 0%.

The session log is the record of truth — a pin is one line:

```
compaction/summary                     seq 5145  19:11:03
plugin:opencode-go-pool/pin  {keyId:"secondary"}  seq 5159  19:11:13
```

The compaction invalidated the existing `primary` pin, the next request asked the store again,
found it stale, re-picked by policy and wrote `secondary` — no restart involved. The cache side
confirms the move landed on another backend:

| turn                        | key         | `input` | `cacheRead` |
| --------------------------- | ----------- | ------- | ----------- |
| before the compaction       | `primary`   | 1 133   | 74 112      |
| first turn after the re-pin | `secondary` | 23 421  | **256**     |

A cache read of 256 against a 74k prefix means the prefix cache was empty: a different account,
which is exactly what the rotation is supposed to cost at a conversation boundary and never
inside one.

`/usage` is not a usable signal here — one compaction is ~80k tokens against a monthly allowance,
so `secondary` still reported `0/0/0` afterwards. Pins in the log are the observable.

A cold start showed the other edge: a process that has booted but not yet polled has no readings,
so the first choice ties every account at 0% and falls back to configuration order. The pool now
waits for the first sweep before choosing for an unattached conversation.

## Not verified yet

- `DUPLICATE_ADAPTER` retry after another plugin re-registers the route.
- A real quota failure mid-conversation, which needs two accounts and a spent one.
