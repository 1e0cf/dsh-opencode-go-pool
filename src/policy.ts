/**
 * Key health: the question "can this key serve right now", answered as a pure
 * function over the last usage reading. No clock, no network, no harness types,
 * so every rule here is unit-testable and the caller keeps all the I/O.
 *
 * The gateway reports its own verdict per usage window, and that verdict beats
 * any arithmetic on percentages: `rate-limited` is authoritative. Percentages
 * are only used to rank the keys that are still serving.
 *
 * @module dsh-opencode-go-pool/policy
 */

/** One usage window the gateway accounts for. */
export type MeterName = 'rolling' | 'weekly' | 'monthly'

/** Window order is fixed so diagnostics and tie-breaks stay deterministic. */
export const METERS: readonly MeterName[] = ['rolling', 'weekly', 'monthly']

/** One window reading as reported by the usage endpoint. */
export interface MeterReading {
  /** Gateway verdict; `rate-limited` means this window is exhausted. */
  readonly status: string | null
  /** Share of this window's allowance consumed, 0..100. */
  readonly percent: number | null
  /** When this window frees up, ISO 8601. */
  readonly resetsAt: string | null
}

/** All windows for one key; a window the gateway omitted stays `null`. */
export type UsageReading = { readonly [M in MeterName]: MeterReading | null }

/** Last known state of one configured key. */
export interface KeyState {
  readonly id: string
  /** `null` until the first successful poll. */
  readonly usage: UsageReading | null
  /** Epoch milliseconds of {@link usage}; `null` when never observed. */
  readonly observedAt: number | null
}

/** Why a key cannot serve, independent of any policy. */
export type KeyUnusableReason = 'rate-limited' | 'exhausted'

/** Verdict for one key, plus the numbers a policy needs. */
export interface KeyAssessment {
  readonly id: string
  /** False when the gateway says a window is spent. */
  readonly usable: boolean
  readonly reason: KeyUnusableReason | null
  /** Highest consumed share across windows; `null` when never observed. */
  readonly consumed: number | null
  /** Window that produced {@link consumed}. */
  readonly worstMeter: MeterName | null
  /** Reset time of the blocking window (unusable) or of {@link worstMeter}. */
  readonly resetsAt: string | null
  readonly observed: boolean
}

/** Numeric reading or `null`; tolerates string percentages from JSON. */
function percentOf(reading: MeterReading | null | undefined): number | null {
  if (!reading) return null
  const value = typeof reading.percent === 'number' ? reading.percent : Number(reading.percent)
  if (!Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/**
 * Decide whether one key can serve, from its usage reading alone.
 *
 * A key is unusable when any window reports `rate-limited` — the gateway's own
 * word, ahead of any percentage. A key whose worst window reads 100% is also
 * unusable even if the status has not caught up yet, because the next request
 * is guaranteed to fail. A key never polled is assumed usable: an unobserved
 * key is not evidence of a spent one, and refusing it would leave a fresh
 * install unable to route anything.
 *
 * @param state - last known state of one key.
 * @returns verdict with the numbers a policy compares.
 */
export function assessKey(state: KeyState): KeyAssessment {
  const observed = state.usage !== null

  if (!state.usage) {
    return {
      id: state.id,
      usable: true,
      reason: null,
      consumed: null,
      worstMeter: null,
      resetsAt: null,
      observed,
    }
  }

  let consumed: number | null = null
  let worstMeter: MeterName | null = null
  let blockedMeter: MeterName | null = null

  for (const meter of METERS) {
    const reading = state.usage[meter]
    if (!reading) continue
    if (reading.status === 'rate-limited' && blockedMeter === null) blockedMeter = meter
    const percent = percentOf(reading)
    if (percent === null) continue
    if (consumed === null || percent > consumed) {
      consumed = percent
      worstMeter = meter
    }
  }

  const blocking = blockedMeter ?? (consumed !== null && consumed >= 100 ? worstMeter : null)
  if (blocking !== null) {
    return {
      id: state.id,
      usable: false,
      reason: blockedMeter !== null ? 'rate-limited' : 'exhausted',
      consumed,
      worstMeter: blocking,
      resetsAt: state.usage[blocking]?.resetsAt ?? null,
      observed,
    }
  }

  return {
    id: state.id,
    usable: true,
    reason: null,
    consumed,
    worstMeter,
    resetsAt: worstMeter === null ? null : (state.usage[worstMeter]?.resetsAt ?? null),
    observed,
  }
}
