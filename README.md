# dsh-opencode-go-pool

DeepSeek Harness plugin: a pool of OpenCode Go accounts with **session-pinned rotation**.

OpenCode Go accounts have separate rolling (5h), weekly, and monthly allowances, and a
conversation served by one account keeps its prompt cache only on that account. Rotating per
request therefore costs a full uncached re-read of the conversation prefix on every switch. This
plugin rotates at **session boundaries** instead: a conversation keeps the account it started on,
and a key is left only when it can no longer serve.

Status: work in progress, not usable yet.

## Layout

| path | purpose |
|---|---|
| `src/policy.ts` | pure decision logic: is a key healthy, which key serves a session |
| `src/pool.ts` | pins, key states, and the rotation state machine |
| `src/usage.ts` | background poller for the usage endpoint |
| `src/adapter.ts` | adapter composing the harness pi-ai adapter, with key selection |
| `src/index.ts` | plugin entry: route takeover and wiring |

## Development

```sh
bun install
bun test        # unit tests
bun run gate    # lint + format check + type check + tests
```

## License

MIT
