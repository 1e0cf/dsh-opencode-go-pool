import { describe, expect, it } from 'bun:test'

import { fetchUsage, parseUsage, UsageError, type UsageRequest } from '../src/usage.ts'

/** Minimal fetch stand-in that records the request it received. */
function stubFetch(respond: () => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit }>
  fetch: typeof fetch
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(respond())
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-10-27T22:00:00Z' },
    weekly: { status: 'ok', percent: 8, resetsAt: '2026-11-02T00:00:00Z' },
    monthly: { status: 'rate-limited', percent: 93, resetsAt: '2026-11-04T15:17:00Z' },
  },
}

function request(overrides: Partial<UsageRequest>): UsageRequest {
  return { apiKey: 'secret', ...overrides }
}

describe('parseUsage', () => {
  it('reads all three windows', () => {
    const reading = parseUsage(PAYLOAD)

    expect(reading.monthly).toEqual({
      status: 'rate-limited',
      percent: 93,
      resetsAt: '2026-11-04T15:17:00Z',
    })
    expect(reading.rolling?.percent).toBe(4)
    expect(reading.weekly?.status).toBe('ok')
  })

  it('degrades one drifted window without losing the others', () => {
    const reading = parseUsage({
      usage: { weekly: { percent: '12.5', status: 42 }, rolling: null },
    })

    expect(reading.weekly).toEqual({ status: null, percent: 12.5, resetsAt: null })
    expect(reading.rolling).toBeNull()
    expect(reading.monthly).toBeNull()
  })

  it('rejects a payload without the usage envelope', () => {
    expect(() => parseUsage({ ok: true })).toThrow(UsageError)
    expect(() => parseUsage(null)).toThrow(UsageError)
  })
})

describe('fetchUsage', () => {
  it('requests the usage resource with the key as a bearer token', async () => {
    const stub = stubFetch(() => json(PAYLOAD))
    const reading = await fetchUsage(request({ fetchImpl: stub.fetch, orgId: 'org_1' }))

    expect(reading.monthly?.percent).toBe(93)
    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]!
    expect(call.url).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(call.init.method).toBe('GET')
    expect(call.init.headers).toMatchObject({
      authorization: 'Bearer secret',
      'x-opencode-org-id': 'org_1',
    })
  })

  it('joins a base url that already ends in a slash', async () => {
    const stub = stubFetch(() => json(PAYLOAD))
    await fetchUsage(request({ fetchImpl: stub.fetch, baseUrl: 'https://example.test/v1/' }))

    expect(stub.calls[0]?.url).toBe('https://example.test/v1/usage')
  })

  it('omits the organisation header when it is not configured', async () => {
    const stub = stubFetch(() => json(PAYLOAD))
    await fetchUsage(request({ fetchImpl: stub.fetch }))

    expect(stub.calls[0]?.init.headers).not.toHaveProperty('x-opencode-org-id')
  })

  it('classifies a rejected key as unauthorized', async () => {
    const stub = stubFetch(() => json({ error: 'nope' }, 401))
    const failure = fetchUsage(request({ fetchImpl: stub.fetch }))

    await expect(failure).rejects.toThrow(UsageError)
    await expect(failure).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
  })

  it('classifies other statuses as http failures', async () => {
    const stub = stubFetch(() => json({ error: 'boom' }, 503))

    await expect(fetchUsage(request({ fetchImpl: stub.fetch }))).rejects.toMatchObject({
      code: 'http',
      status: 503,
    })
  })

  it('classifies a transport error as unreachable', async () => {
    const stub = stubFetch(() => {
      throw new Error('connection reset')
    })

    await expect(fetchUsage(request({ fetchImpl: stub.fetch }))).rejects.toMatchObject({
      code: 'unreachable',
    })
  })

  it('classifies a non-JSON body as a shape failure', async () => {
    const stub = stubFetch(() => new Response('<html>gateway</html>', { status: 200 }))

    await expect(fetchUsage(request({ fetchImpl: stub.fetch }))).rejects.toMatchObject({
      code: 'shape',
    })
  })
})
