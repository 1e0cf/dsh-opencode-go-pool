# dsh-opencode-go-pool

DeepSeek Harness plugin: a pool of OpenCode Go accounts with **session-pinned rotation**.

Several OpenCode Go subscriptions behind one model route. When one account can no longer serve,
work continues on the next — and it switches at a **conversation boundary**, not mid-conversation.

## Why the switch is per conversation

OpenCode Go accounts have separate rolling (5h), weekly, and monthly allowances, and the gateway
keys its prompt cache by account. A conversation that moves to another account re-reads its whole
prefix uncached: on a long session that is the expensive part of the next request, paid again on
every switch. Rotating per request is therefore the wrong unit. This pool pins a conversation to
an account and only moves it when that account actually stops serving.

Two consequences worth knowing:

- A subagent is a child session. It resolves to its conversation's **lineage root**, so it shares
  the parent's account instead of opening a second one.
- A nearly spent account (90% by default) still serves the conversations pinned to it. It is only
  avoided when a _new_ conversation picks an account, because starting there would force a move
  soon after.
- Right after the harness starts, the first conversation waits for the first usage sweep (one HTTP
  round trip) instead of tying every account at "unknown" and picking by configuration order.

## Requirements

- A harness build that stamps `sessionAffinity` on model requests (the lineage root) **and** a
  `pi-ai` build whose OpenCode provider sends it as `x-opencode-session`. Without it the gateway
  answers `400 MissingSessionID`, and a fixed header would break the cache this plugin exists to
  protect.
- The `opencode-go` route vacated in `llm-pi-ai`: remove that entry from `providers` in its
  configuration, otherwise registration fails with `DUPLICATE_ADAPTER` and the plugin waits.
- Every account's secret stored under its own credential reference.

## Configuration

```yaml
- id: opencode-go-pool
  name: dsh-opencode-go-pool
  config:
    policy: threshold
    thresholdPercent: 90
    keys:
      - id: primary
        apiKeyEnv: OPENCODE_API_KEY
      - id: secondary
        apiKeyEnv: OPENCODE_API_KEY_2
        orgId: org_... # optional, sent as x-opencode-org-id
```

| key                | default                         | meaning                                                         |
| ------------------ | ------------------------------- | --------------------------------------------------------------- |
| `keys`             | required                        | accounts in preference order; `id` is `[a-z0-9-]`, max 32       |
| `policy`           | `sticky`                        | how a conversation without a pin picks an account               |
| `thresholdPercent` | `90`                            | consumed share above which a new conversation avoids an account |
| `baseUrl`          | `https://opencode.ai/zen/go/v1` | usage endpoint root                                             |
| `pollIntervalMs`   | `60000`                         | background usage poll interval, at least 5000                   |

## Policies

| policy        | a new conversation starts on                                                |
| ------------- | --------------------------------------------------------------------------- |
| `sticky`      | the first configured account that can serve                                 |
| `threshold`   | the least loaded account below the threshold                                |
| `round-robin` | an account chosen by hashing the conversation id, so sessions spread evenly |

Every policy shares one invariant: **an account that can still serve keeps the conversations pinned
to it.** Policies only decide where _new_ conversations start.

## Rotation

Readings come from the account's usage endpoint on a timer, so the pool knows an account is spent
before a conversation starts on it. A failed request confirms it: the account is blocked locally
until the next successful poll, and the retried step resolves the pin again and lands elsewhere.

If every account is spent the request fails with `QUOTA_EXCEEDED`, naming each blocked account and
its window.

## Status

Working: policy, pool, usage polling, pin storage, adapter, plugin wiring — 92 unit tests.

Verified at the wire level: one adapter per account produces requests with that account's
credential, and `x-opencode-session` carries the lineage root while the raw session id travels
separately ([docs/verification.md](docs/verification.md)).

Verified in a live harness: route takeover, pins written to and read back from the session log, a
re-pick after compaction that moved the conversation to the second account mid-session, and the
background poller feeding the pool.

Not yet verified: a real mid-conversation quota failure, and route takeover after another plugin
re-registers it. No settings UI.

## Development

```sh
bun install
bun test        # unit tests
bun run gate    # lint + format check + type check + tests
```

Bun provides the whole toolchain natively (`bun test`, `bun lint`, `bun fmt`, `bun check`), so the
only dependency is Bun's own type package.

| path             | purpose                                      |
| ---------------- | -------------------------------------------- |
| `src/policy.ts`  | is an account usable; which one should serve |
| `src/pool.ts`    | account state, block marks, pins             |
| `src/usage.ts`   | usage endpoint client and parser             |
| `src/poller.ts`  | background sweep                             |
| `src/pins.ts`    | pins stored in the conversation log          |
| `src/adapter.ts` | routing a dispatch to the pinned account     |
| `src/config.ts`  | configuration validation                     |
| `src/index.ts`   | harness wiring                               |

## License

MIT
