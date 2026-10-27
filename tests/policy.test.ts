import { describe, expect, it } from 'bun:test'

import { assessKey, type KeyState, type MeterReading, type UsageReading } from '../src/policy.ts'

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
