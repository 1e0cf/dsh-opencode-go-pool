import { describe, expect, it } from 'bun:test'

import { pollUsage, UsagePoller, type PollOutcome, type PollTarget } from '../src/poller.ts'

const PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-10-27T22:00:00Z' },
    weekly: { status: 'ok', percent: 8, resetsAt: '2026-11-02T00:00:00Z' },
    monthly: { status: 'ok', percent: 42, resetsAt: '2026-11-04T15:17:00Z' },
  },
}

/** Fetch stub keyed by the bearer token it receives. */
function fetchByKey(responses: Record<string, () => Response>): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
    const token = auth.replace('Bearer ', '')
    const respond = responses[token]
    if (!respond) throw new Error(`unexpected token ${token}`)
    return Promise.resolve(respond())
  }) as unknown as typeof fetch
}

function ok(): Response {
  return new Response(JSON.stringify(PAYLOAD), { status: 200 })
}

const targets: PollTarget[] = [
  { keyId: 'a', apiKey: 'key-a' },
  { keyId: 'b', apiKey: 'key-b' },
]

describe('pollUsage', () => {
  it('reports a reading per key with one shared timestamp', async () => {
    const outcomes = await pollUsage(targets, {
      fetchImpl: fetchByKey({ 'key-a': ok, 'key-b': ok }),
      now: () => 1_700_000_000_000,
    })

    expect(outcomes).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.usage.monthly?.percent).toBe(42)
        expect(outcome.at).toBe(1_700_000_000_000)
      }
    }
  })

  it('keeps polling the other keys when one is rejected', async () => {
    const outcomes = await pollUsage(targets, {
      fetchImpl: fetchByKey({
        'key-a': () => new Response('{}', { status: 401 }),
        'key-b': ok,
      }),
    })

    const [first, second] = outcomes

    expect(first).toMatchObject({ keyId: 'a', ok: false, code: 'unauthorized' })
    expect(second).toMatchObject({ keyId: 'b', ok: true })
  })

  it('reports a transport failure without throwing', async () => {
    const outcomes = await pollUsage([{ keyId: 'a', apiKey: 'key-a' }], {
      fetchImpl: (() => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    })

    expect(outcomes[0]).toMatchObject({ keyId: 'a', ok: false, code: 'unreachable' })
  })

  it('passes the organisation id through to the request', async () => {
    let seen: string | undefined
    await pollUsage([{ keyId: 'a', apiKey: 'key-a', orgId: 'org_1' }], {
      fetchImpl: ((_url: string, init?: RequestInit) => {
        seen = (init?.headers as Record<string, string> | undefined)?.['x-opencode-org-id']
        return Promise.resolve(ok())
      }) as unknown as typeof fetch,
    })

    expect(seen).toBe('org_1')
  })
})

describe('UsagePoller', () => {
  it('sweeps what the resolver returns and reports every outcome', async () => {
    const seen: PollOutcome[] = []
    const poller = new UsagePoller({
      targets: () => targets,
      onOutcome: (outcome) => seen.push(outcome),
      fetchImpl: fetchByKey({ 'key-a': ok, 'key-b': ok }),
    })

    const outcomes = await poller.once()

    expect(outcomes).toHaveLength(2)
    expect(seen).toHaveLength(2)
  })

  it('does nothing when no key is configured', async () => {
    const seen: PollOutcome[] = []
    const poller = new UsagePoller({
      targets: () => [],
      onOutcome: (outcome) => seen.push(outcome),
    })

    expect(await poller.once()).toEqual([])
    expect(seen).toEqual([])
  })

  it('reports a sweep that failed before producing outcomes', async () => {
    const reported: unknown[] = []
    const poller = new UsagePoller({
      targets: () => {
        throw new Error('no usable credentials')
      },
      onOutcome: () => {},
      onError: (error) => reported.push(error),
    })

    poller.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    poller.stop()

    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('no usable credentials')
  })

  it('survives a resolver that throws, and stops when asked', async () => {
    const poller = new UsagePoller({
      targets: () => {
        throw new Error('credentials unavailable')
      },
      onOutcome: () => {},
    })

    poller.start()
    poller.stop()

    await expect(poller.once()).rejects.toThrow('credentials unavailable')
  })
})
