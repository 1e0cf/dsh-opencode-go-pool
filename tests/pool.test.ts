import { describe, expect, it } from 'bun:test'

import { MemoryPinStore, KeyPool, type PinStore, type PoolOptions } from '../src/pool.ts'
import type { MeterReading, UsageReading } from '../src/policy.ts'

function meter(percent: number, status = 'ok', resetsAt: string | null = null): MeterReading {
  return { status, percent, resetsAt }
}

/** Monthly-only reading, the window that actually fills up. */
function usage(percent: number, status = 'ok'): UsageReading {
  return { rolling: meter(1), weekly: meter(2), monthly: meter(percent, status) }
}

function pool(overrides: Partial<PoolOptions> = {}): KeyPool {
  return new KeyPool({
    keys: [{ id: 'a' }, { id: 'b' }],
    policy: 'sticky',
    ...overrides,
  })
}

/** Pin store that records every write, for assertions. */
function spyStore(seed: Record<string, string> = {}): PinStore & { writes: string[] } {
  const pins = new Map(Object.entries(seed))
  const writes: string[] = []
  return {
    writes,
    get: async (affinity: string) => pins.get(affinity),
    set: async (affinity: string, keyId: string) => {
      pins.set(affinity, keyId)
      writes.push(`${affinity}=${keyId}`)
    },
  }
}

describe('KeyPool configuration', () => {
  it('refuses an empty or duplicated key set', () => {
    expect(() => new KeyPool({ keys: [], policy: 'sticky' })).toThrow()
    expect(() => new KeyPool({ keys: [{ id: 'a' }, { id: 'a' }], policy: 'sticky' })).toThrow()
  })

  it('keeps configuration order', () => {
    const configured = new KeyPool({ keys: [{ id: 'b' }, { id: 'a' }], policy: 'sticky' })

    expect(configured.keys().map((key) => key.id)).toEqual(['b', 'a'])
  })
})

describe('KeyPool observations', () => {
  it('turns a reading into a consumed share', () => {
    const subject = pool()
    subject.observe('a', usage(93), 1_700_000_000_000)

    const report = subject.report().find((entry) => entry.id === 'a')

    expect(report?.assessment.consumed).toBe(93)
    expect(report?.assessment.usable).toBe(true)
    expect(report?.observedAt).toBe(1_700_000_000_000)
  })

  it('lets a failed request block a key whose last poll still looked healthy', () => {
    const subject = pool()
    subject.observe('a', usage(40), 1)
    subject.block('a', 'rate-limited')

    const report = subject.report().find((entry) => entry.id === 'a')

    expect(report?.assessment.usable).toBe(false)
    expect(report?.assessment.reason).toBe('rate-limited')
    expect(report?.blocked).toBe('rate-limited')
  })

  it('clears the block on the next successful poll', () => {
    const subject = pool()
    subject.observe('a', usage(40), 1)
    subject.block('a', 'rate-limited')
    subject.observe('a', usage(5), 2)

    const report = subject.report().find((entry) => entry.id === 'a')

    expect(report?.assessment.usable).toBe(true)
    expect(report?.blocked).toBeNull()
  })

  it('ignores unknown key ids instead of inventing entries', () => {
    const subject = pool()
    subject.observe('ghost', usage(10), 1)
    subject.block('ghost', 'exhausted')

    expect(subject.keys().map((key) => key.id)).toEqual(['a', 'b'])
    expect(subject.report().every((entry) => entry.assessment.observed === false)).toBe(true)
  })
})

describe('KeyPool resolution', () => {
  it('pins the first usable key of a fresh conversation', async () => {
    const pins = spyStore()
    const subject = pool({ pins })

    const selection = await subject.resolve('root')

    expect(selection).toEqual({ keyId: 'a', pinned: false, avoided: [] })
    expect(pins.writes).toEqual(['root=a'])
  })

  it('keeps a pinned conversation on its key while it serves', async () => {
    const pins = spyStore({ root: 'a' })
    const subject = pool({ pins, policy: 'threshold' })
    subject.observe('a', usage(80), 1)
    subject.observe('b', usage(1), 1)

    const selection = await subject.resolve('root')

    expect(selection?.keyId).toBe('a')
    expect(selection?.pinned).toBe(true)
    expect(pins.writes).toEqual([])
  })

  it('moves a conversation whose key stopped serving, and records it', async () => {
    const pins = spyStore({ root: 'a' })
    const subject = pool({ pins })
    subject.observe('a', usage(100, 'rate-limited'), 1)
    subject.observe('b', usage(5), 1)

    const selection = await subject.resolve('root')

    expect(selection?.keyId).toBe('b')
    expect(selection?.pinned).toBe(false)
    expect(pins.writes).toEqual(['root=b'])
  })

  it('re-asks the store when a pin it already used stops applying', async () => {
    // The store is what learns about a context rebuild, and it can learn while
    // the process runs. A memoised pin would outlive its meaning.
    let applies = true
    const writes: string[] = []
    const pins: PinStore = {
      get: async () => (applies ? 'a' : undefined),
      set: async (_affinity: string, keyId: string) => {
        writes.push(keyId)
        applies = true
      },
    }
    const subject = pool({ pins, policy: 'threshold' })
    subject.observe('a', usage(80), 1)
    subject.observe('b', usage(10), 1)

    const first = await subject.resolve('root')
    applies = false
    const second = await subject.resolve('root')

    expect(first).toEqual({ keyId: 'a', pinned: true, avoided: [] })
    expect(second).toEqual({ keyId: 'b', pinned: false, avoided: [] })
    expect(writes).toEqual(['b'])
  })

  it('shares the pin of the root affinity with anything resolving it', async () => {
    const pins = spyStore()
    const subject = pool({ pins })

    await subject.resolve('root')
    const childSelection = await subject.resolve('root')

    expect(childSelection?.pinned).toBe(true)
    expect(subject.status().pinCount).toBe(1)
  })

  it('reads a pin written by an earlier process from the same store', async () => {
    const pins = new MemoryPinStore()
    await new KeyPool({ keys: [{ id: 'a' }, { id: 'b' }], policy: 'sticky', pins }).resolve('root')

    const restarted = new KeyPool({ keys: [{ id: 'a' }, { id: 'b' }], policy: 'sticky', pins })
    const selection = await restarted.resolve('root')

    expect(selection?.pinned).toBe(true)
    expect(selection?.keyId).toBe('a')
  })

  it('starts an unpinned conversation off keys above the threshold', async () => {
    const subject = pool({ policy: 'threshold' })
    subject.observe('a', usage(95), 1)
    subject.observe('b', usage(4), 1)

    const selection = await subject.resolve('fresh')

    expect(selection?.keyId).toBe('b')
  })

  it('returns null when no key can serve', async () => {
    const subject = pool()
    subject.block('a', 'rate-limited')
    subject.block('b', 'rate-limited')

    expect(await subject.resolve('root')).toBeNull()
  })

  it('waits for the first readings before an unattached conversation chooses', async () => {
    let release!: () => void
    const readings = new Promise<void>((resolve) => {
      release = resolve
    })
    const subject = new KeyPool({
      keys: [{ id: 'a' }, { id: 'b' }],
      policy: 'threshold',
      thresholdPercent: 90,
      ready: () => readings,
    })

    const pending = subject.resolve('fresh')
    // Nothing observed yet: the choice must not have happened.
    await Bun.sleep(0)
    subject.observe('a', usage(99), 1)
    subject.observe('b', usage(0), 1)
    release()

    expect(await pending).toEqual({ keyId: 'b', pinned: false, avoided: ['a'] })
  })

  it('does not wait for readings once a key has been observed', async () => {
    let asked = false
    const subject = pool({
      policy: 'threshold',
      ready: () => {
        asked = true
        return new Promise<void>(() => {})
      },
    })
    subject.observe('a', usage(99), 1)
    subject.observe('b', usage(10), 1)

    const selection = await subject.resolve('fresh')

    expect(selection?.keyId).toBe('b')
    expect(asked).toBe(false)
  })

  it('does not make an attached conversation wait for readings', async () => {
    let asked = false
    const pins = spyStore({ root: 'a' })
    const subject = pool({
      pins,
      ready: () => {
        asked = true
        return new Promise<void>(() => {})
      },
    })

    const selection = await subject.resolve('root')

    expect(selection).toEqual({ keyId: 'a', pinned: true, avoided: [] })
    expect(asked).toBe(false)
  })

  it('routes anyway when the readings never arrive', async () => {
    const subject = pool({
      policy: 'threshold',
      ready: async () => {
        throw new Error('usage endpoint down')
      },
    })

    expect(await subject.resolve('fresh')).toMatchObject({ keyId: 'a', pinned: false })
  })

  it('reports pins without writing new ones', async () => {
    const pins = spyStore()
    const subject = pool({ pins })
    await subject.resolve('root')

    expect(await subject.pinned('root')).toBe('a')
    expect(await subject.pinned('elsewhere')).toBeUndefined()
    expect(pins.writes).toHaveLength(1)
  })
})
