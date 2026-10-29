import { describe, expect, it } from 'bun:test'

import {
  blockReasonOf,
  PoolAdapter,
  PoolExhaustedError,
  type AdapterCall,
  type InnerAdapter,
} from '../src/adapter.ts'
import { KeyPool } from '../src/pool.ts'

/** Error carrying a provider code the way harness adapters do. */
function coded(code: string): Error {
  return Object.assign(new Error(`provider said ${code}`), { code })
}

function collecting(chunks: readonly unknown[]): {
  adapter: InnerAdapter
  calls: AdapterCall[]
} {
  const calls: AdapterCall[] = []
  return {
    calls,
    adapter: {
      async *stream(options) {
        calls.push(options)
        for (const chunk of chunks) yield chunk
      },
    },
  }
}

function failing(error: Error): InnerAdapter {
  return {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
      }
    },
  }
}

function catalog(chunks: readonly unknown[] = ['ok']): InnerAdapter {
  const source = collecting(chunks).adapter
  return {
    ...source,
    providerInfo: (provider) => ({ provider, id: provider, name: 'OpenCode Go' }),
    providerRetryPolicy: () => ({ mode: 'normal' }),
    imageRequestPricing: () => ({ inputPerImage: 0 }),
    imageRequestTarget: (_provider, _model, image) => image,
    listModels: async () => [{ provider: 'opencode-go', id: 'deepseek-v4-pro', name: 'V4' }],
    resolveModel: async (provider, model) => ({ provider, id: model, name: `model ${model}` }),
  }
}

function call(provider = 'opencode-go', model = 'deepseek-v4-pro'): AdapterCall {
  return { provider, model }
}

function build(options: {
  adapters: ReadonlyMap<string, InnerAdapter>
  pool?: KeyPool
  affinityOf?: (options: AdapterCall) => string
  failed?: Array<{ keyId: string; error: unknown }>
}): PoolAdapter {
  return new PoolAdapter(
    {
      pool: options.pool ?? new KeyPool({ keys: [{ id: 'a' }, { id: 'b' }], policy: 'sticky' }),
      adapters: options.adapters,
      catalog: catalog(),
      affinityOf: options.affinityOf ?? (() => 'root'),
      onError: (detail) => options.failed?.push(detail),
    },
    ['opencode-go'],
  )
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('PoolAdapter catalog surface', () => {
  it('answers metadata from the catalog instead of a pooled adapter', async () => {
    const adapter = build({ adapters: new Map() })

    expect(adapter.providerInfo('opencode-go').name).toBe('OpenCode Go')
    expect(adapter.providerRetryPolicy('opencode-go')).toEqual({ mode: 'normal' })
    expect(await adapter.listModels('opencode-go')).toHaveLength(1)
    expect((await adapter.resolveModel('opencode-go', 'deepseek-v4-pro')).name).toBe(
      'model deepseek-v4-pro',
    )
    expect(adapter.imageRequestTarget('opencode-go', 'm', 'img')).toBe('img')
  })

  it('binds metadata and dispatch together for a prepared call', async () => {
    const inner = collecting(['hello'])
    const adapter = build({
      adapters: new Map([
        ['a', inner.adapter],
        ['b', inner.adapter],
      ]),
    })

    const prepared = await adapter.prepareCall('opencode-go', 'deepseek-v4-pro')

    expect(prepared.model.id).toBe('deepseek-v4-pro')
    expect(await drain(prepared.stream(call()))).toEqual(['hello'])
  })

  it('refuses to exist without a route', () => {
    expect(
      () =>
        new PoolAdapter(
          {
            pool: new KeyPool({ keys: [{ id: 'a' }], policy: 'sticky' }),
            adapters: new Map(),
            catalog: catalog(),
            affinityOf: () => 'root',
          },
          [],
        ),
    ).toThrow()
  })
})

describe('PoolAdapter dispatch', () => {
  it('serves a conversation from the key the pool pinned', async () => {
    const first = collecting(['from-a'])
    const second = collecting(['from-b'])
    const adapter = build({
      adapters: new Map([
        ['a', first.adapter],
        ['b', second.adapter],
      ]),
    })

    expect(await drain(adapter.stream(call()))).toEqual(['from-a'])
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
  })

  it('routes a child conversation to the adapter behind its shared affinity', async () => {
    const first = collecting(['from-a'])
    const second = collecting(['from-b'])
    const adapter = build({
      adapters: new Map([
        ['a', first.adapter],
        ['b', second.adapter],
      ]),
      affinityOf: () => 'root',
    })

    await drain(adapter.stream(call()))
    await drain(adapter.stream(call()))

    expect(first.calls).toHaveLength(2)
    expect(second.calls).toHaveLength(0)
  })

  it('blocks a spent key and serves the next call from the other one', async () => {
    const second = collecting(['from-b'])
    const failed: Array<{ keyId: string; error: unknown }> = []
    const adapter = build({
      adapters: new Map([
        ['a', failing(coded('QUOTA_EXCEEDED'))],
        ['b', second.adapter],
      ]),
      failed,
    })

    await expect(drain(adapter.stream(call()))).rejects.toThrow('provider said QUOTA_EXCEEDED')
    expect(failed.map((entry) => entry.keyId)).toEqual(['a'])
    expect(await drain(adapter.stream(call()))).toEqual(['from-b'])
  })

  it('leaves a transient failure unblocked so the same key is retried', async () => {
    const second = collecting(['from-b'])
    const pool = new KeyPool({ keys: [{ id: 'a' }, { id: 'b' }], policy: 'sticky' })
    const adapter = build({
      adapters: new Map([
        ['a', failing(coded('RATE_LIMIT'))],
        ['b', second.adapter],
      ]),
      pool,
    })

    await expect(drain(adapter.stream(call()))).rejects.toThrow()
    expect(pool.report().every((entry) => entry.assessment.usable)).toBe(true)
    await expect(drain(adapter.stream(call()))).rejects.toThrow()
  })

  it('fails with a quota code when no key can serve', async () => {
    const pool = new KeyPool({ keys: [{ id: 'a' }, { id: 'b' }], policy: 'sticky' })
    pool.block('a', 'rate-limited')
    pool.block('b', 'exhausted')
    const adapter = build({ adapters: new Map(), pool })

    await expect(drain(adapter.stream(call()))).rejects.toThrow(PoolExhaustedError)
    await expect(drain(adapter.stream(call()))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      blocked: [
        { keyId: 'a', reason: 'rate-limited' },
        { keyId: 'b', reason: 'exhausted' },
      ],
    })
  })
})

describe('blockReasonOf', () => {
  it('recognizes quota codes and ignores everything else', () => {
    expect(blockReasonOf(coded('QUOTA_EXCEEDED'))).toBe('rate-limited')
    expect(blockReasonOf(coded('INSUFFICIENT_QUOTA'))).toBe('rate-limited')
    expect(blockReasonOf(coded('AUTH'))).toBe('unauthorized')
    expect(blockReasonOf(coded('INVALID_CREDENTIAL'))).toBe('unauthorized')
    expect(blockReasonOf(new Error('plain'))).toBeNull()
    expect(blockReasonOf('not an error')).toBeNull()
  })

  it('reads a code nested in a carried failure', () => {
    const error = Object.assign(new Error('wrapped'), {
      failure: { message: 'out of allowance', code: 'USAGE_LIMIT_REACHED' },
    })

    expect(blockReasonOf(error)).toBe('rate-limited')
  })
})
