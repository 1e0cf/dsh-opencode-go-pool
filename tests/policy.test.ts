import { describe, expect, it } from 'bun:test'

import {
  assessKey,
  DEFAULT_THRESHOLD_PERCENT,
  selectKey,
  type KeyAssessment,
  type KeyState,
  type MeterReading,
  type SelectionContext,
  type UsageReading,
} from '../src/policy.ts'

function meter(
  percent: number | null,
  status = 'ok',
  resetsAt: string | null = null,
): MeterReading {
  return { status, percent, resetsAt }
}

function usage(readings: Partial<Record<keyof UsageReading, MeterReading | null>>): UsageReading {
  return {
    rolling: readings.rolling ?? null,
    weekly: readings.weekly ?? null,
    monthly: readings.monthly ?? null,
  }
}

function state(readings: UsageReading | null): KeyState {
  return { id: 'k1', usage: readings, observedAt: readings ? 1_700_000_000_000 : null }
}

describe('assessKey', () => {
  it('treats a never-polled key as usable, with no consumption figure', () => {
    const verdict = assessKey(state(null))

    expect(verdict.usable).toBe(true)
    expect(verdict.observed).toBe(false)
    expect(verdict.consumed).toBeNull()
    expect(verdict.reason).toBeNull()
  })

  it('reports the busiest window as the consumed share', () => {
    const verdict = assessKey(
      state(
        usage({
          rolling: meter(4),
          weekly: meter(8, 'ok', '2026-11-02T00:00:00Z'),
          monthly: meter(93, 'ok', '2026-11-04T15:17:00Z'),
        }),
      ),
    )

    expect(verdict.usable).toBe(true)
    expect(verdict.consumed).toBe(93)
    expect(verdict.worstMeter).toBe('monthly')
    expect(verdict.resetsAt).toBe('2026-11-04T15:17:00Z')
  })

  it('lets a rate-limited window win over low percentages in the others', () => {
    const verdict = assessKey(
      state(
        usage({
          rolling: meter(4, 'rate-limited', '2026-10-27T22:00:00Z'),
          weekly: meter(8),
          monthly: meter(20),
        }),
      ),
    )

    expect(verdict.usable).toBe(false)
    expect(verdict.reason).toBe('rate-limited')
    expect(verdict.worstMeter).toBe('rolling')
    expect(verdict.resetsAt).toBe('2026-10-27T22:00:00Z')
  })

  it('treats a fully consumed window as exhausted even before the status flips', () => {
    const verdict = assessKey(state(usage({ monthly: meter(100, 'ok', '2026-11-04T15:17:00Z') })))

    expect(verdict.usable).toBe(false)
    expect(verdict.reason).toBe('exhausted')
    expect(verdict.worstMeter).toBe('monthly')
  })

  it('clamps a percentage above 100 instead of trusting it', () => {
    const verdict = assessKey(state(usage({ monthly: meter(140) })))

    expect(verdict.usable).toBe(false)
    expect(verdict.reason).toBe('exhausted')
    expect(verdict.consumed).toBe(100)
  })

  it('accepts percentages delivered as strings', () => {
    // The gateway payload is untyped, so a figure may arrive as a string.
    const untyped = { status: 'ok', percent: '93.5', resetsAt: null } as unknown as MeterReading
    const verdict = assessKey(state(usage({ monthly: untyped })))

    expect(verdict.consumed).toBe(93.5)
    expect(verdict.usable).toBe(true)
  })

  it('survives windows the gateway omitted', () => {
    const verdict = assessKey(state(usage({ weekly: meter(12, 'ok', '2026-11-02T00:00:00Z') })))

    expect(verdict.usable).toBe(true)
    expect(verdict.consumed).toBe(12)
    expect(verdict.worstMeter).toBe('weekly')
  })

  it('ignores a window whose percentage is missing', () => {
    const verdict = assessKey(state(usage({ rolling: meter(null), weekly: meter(30) })))

    expect(verdict.usable).toBe(true)
    expect(verdict.consumed).toBe(30)
    expect(verdict.worstMeter).toBe('weekly')
  })

  it('prefers the earliest blocked window when several report rate-limited', () => {
    const verdict = assessKey(
      state(
        usage({
          weekly: meter(50, 'rate-limited', '2026-11-02T00:00:00Z'),
          monthly: meter(100, 'rate-limited', '2026-11-04T15:17:00Z'),
        }),
      ),
    )

    expect(verdict.usable).toBe(false)
    expect(verdict.worstMeter).toBe('weekly')
  })
})

/** Assessment of one key whose monthly window reads `percent`. */
function key(id: string, percent: number | null, status = 'ok'): KeyAssessment {
  return assessKey({
    id,
    usage: percent === null ? null : usage({ monthly: meter(percent, status) }),
    observedAt: percent === null ? null : 1_700_000_000_000,
  })
}

function context(
  keys: readonly KeyAssessment[],
  pin?: string,
  affinity = 'root',
): SelectionContext {
  return { affinity, keys, pin, thresholdPercent: DEFAULT_THRESHOLD_PERCENT }
}

describe('selectKey', () => {
  it('keeps a pinned key that can still serve, however loaded the others are', () => {
    const selection = selectKey('threshold', context([key('a', 12), key('b', 1)], 'a'))

    expect(selection).toEqual({ keyId: 'a', pinned: true, avoided: [] })
  })

  it('keeps a pinned key above the threshold while it still serves', () => {
    const selection = selectKey('threshold', context([key('a', 95), key('b', 1)], 'a'))

    expect(selection?.keyId).toBe('a')
    expect(selection?.pinned).toBe(true)
  })

  it('starts an unpinned session off the keys above the threshold', () => {
    const selection = selectKey('sticky', context([key('a', 95), key('b', 1)]))

    expect(selection).toEqual({ keyId: 'b', pinned: false, avoided: ['a'] })
  })

  it('re-pins when the pinned key can no longer serve', () => {
    const selection = selectKey(
      'threshold',
      context([key('a', 100, 'rate-limited'), key('b', 5)], 'a'),
    )

    expect(selection).toEqual({ keyId: 'b', pinned: false, avoided: [] })
  })

  it('sticky fills the first configured key before touching the next', () => {
    const selection = selectKey('sticky', context([key('a', 10), key('b', 2)]))

    expect(selection?.keyId).toBe('a')
    expect(selection?.pinned).toBe(false)
  })

  it('threshold picks the least loaded key', () => {
    const selection = selectKey('threshold', context([key('a', 10), key('b', 2), key('c', 6)]))

    expect(selection?.keyId).toBe('b')
  })

  it('round-robin is stable for one affinity and spreads distinct ones', () => {
    const keys = [key('a', 1), key('b', 1), key('c', 1)]
    const first = selectKey('round-robin', context(keys, undefined, 'session-a'))
    const again = selectKey('round-robin', context(keys, undefined, 'session-a'))
    const chosen = new Set(
      Array.from({ length: 40 }, (_, index) =>
        selectKey('round-robin', context(keys, undefined, `session-${index}`)),
      ).map((selection) => selection?.keyId),
    )

    expect(first?.keyId).toBe(again?.keyId)
    expect(chosen.size).toBeGreaterThan(1)
  })

  it('prefers a key with a reading over one nobody polled', () => {
    const selection = selectKey('threshold', context([key('a', 85), key('b', null)]))

    expect(selection?.keyId).toBe('a')
  })

  it('still routes when every key is unobserved', () => {
    const selection = selectKey('sticky', context([key('a', null), key('b', null)]))

    expect(selection?.keyId).toBe('a')
  })

  it('falls back to a nearly spent key instead of refusing to serve', () => {
    const selection = selectKey('threshold', context([key('a', 95), key('b', 97)]))

    expect(selection?.keyId).toBe('a')
    expect(selection?.avoided).toEqual([])
  })

  it('returns null when no key can serve', () => {
    const selection = selectKey(
      'threshold',
      context([key('a', 100, 'rate-limited'), key('b', 100, 'rate-limited')]),
    )

    expect(selection).toBeNull()
  })

  it('treats a pin naming a key that no longer exists as unpinned', () => {
    const selection = selectKey('sticky', context([key('a', 10)], 'retired'))

    expect(selection).toEqual({ keyId: 'a', pinned: false, avoided: [] })
  })
})
