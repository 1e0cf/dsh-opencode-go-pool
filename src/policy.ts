/**
 * Key decisions, as pure functions over plain data: no clock, no network, no
 * harness types, so every rule is unit-testable and the caller keeps all I/O.
 *
 * Two different questions live here and must not be conflated:
 *
 * 1. *Can this key serve right now?* — {@link assessKey}. The gateway reports
 *    its own verdict per usage window, and that verdict beats any arithmetic on
 *    percentages: `rate-limited` is authoritative.
 * 2. *Which key should serve this session?* — {@link selectKey}. A session
 *    already pinned to a key that can still serve keeps it, whatever the load
 *    policy prefers: moving a live session between accounts throws away the
 *    gateway's prompt cache for the whole conversation prefix.
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
export type KeyUnusableReason = 'rate-limited' | 'exhausted' | 'unauthorized'

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

/** Strategies for choosing the key of a session that has no pin yet. */
export type PolicyName = 'sticky' | 'threshold' | 'round-robin'

/**
 * Consumed share above which an unpinned session avoids a key. Chosen well
 * below 100 so a session does not *start* on a key that is about to block
 * mid-conversation, where moving away costs the cache.
 */
export const DEFAULT_THRESHOLD_PERCENT = 90

/** Everything a policy may look at; the caller resolves it beforehand. */
export interface SelectionContext {
  /** Conversation affinity id; the unit a key is pinned to. */
  readonly affinity: string
  /** Assessments in configuration order. */
  readonly keys: readonly KeyAssessment[]
  /** Key already serving {@link affinity}, if any. */
  readonly pin: string | undefined
  /** Consumed share above which an unpinned session avoids a key. */
  readonly thresholdPercent: number
}

/** Outcome of {@link selectKey}. */
export interface Selection {
  readonly keyId: string
  /** True when the existing pin was kept, so the caller need not rewrite it. */
  readonly pinned: boolean
  /** Keys skipped only because they sit above the threshold, for diagnostics. */
  readonly avoided: readonly string[]
}

/** FNV-1a over the affinity, so spreading needs no persisted counter. */
function affinityHash(affinity: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < affinity.length; index += 1) {
    hash ^= affinity.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Consumed share used for ordering; an unobserved key sorts as empty. */
function consumedOf(assessment: KeyAssessment): number {
  return assessment.consumed ?? 0
}

/**
 * Choose the key that should serve one affinity.
 *
 * A pinned key that can still serve always wins, for every policy: the pin
 * exists to protect the gateway prompt cache, and no load preference justifies
 * moving a healthy conversation to another account. When the pin is gone or
 * dead, the choice is made among usable keys — first avoiding keys above the
 * threshold, then falling back to any usable key so a nearly-spent pool still
 * serves instead of failing outright.
 *
 * @param policy - strategy for the unpinned case.
 * @param context - assessments, current pin, and threshold.
 * @returns the chosen key, or `null` when nothing can serve.
 */
export function selectKey(policy: PolicyName, context: SelectionContext): Selection | null {
  const pinned =
    context.pin === undefined ? undefined : context.keys.find((key) => key.id === context.pin)

  if (pinned && pinned.usable) {
    return { keyId: pinned.id, pinned: true, avoided: [] }
  }

  const usable = context.keys.filter((key) => key.usable)
  if (usable.length === 0) return null

  // A key nobody has polled yet could be spent or rejected, so an unpinned
  // conversation prefers keys with a reading. The unobserved ones stay in play
  // when they are all there is — a fresh install must still route.
  const observed = usable.filter((key) => key.observed)
  const preferred = observed.length > 0 ? observed : usable
  const belowThreshold = preferred.filter((key) => consumedOf(key) < context.thresholdPercent)
  const candidates = belowThreshold.length > 0 ? belowThreshold : preferred
  const avoided = usable.filter((key) => !candidates.includes(key)).map((key) => key.id)

  return {
    keyId: pick(policy, candidates, context.affinity),
    pinned: false,
    avoided,
  }
}

/** Apply the strategy to a non-empty candidate list. */
function pick(policy: PolicyName, candidates: readonly KeyAssessment[], affinity: string): string {
  if (policy === 'round-robin') {
    // Balanced hashing rather than a cursor: stable across restarts, spreads
    // concurrent sessions, and leaves nothing to persist or repair.
    return candidates[affinityHash(affinity) % candidates.length]!.id
  }

  if (policy === 'threshold') {
    // Least loaded wins; configuration order breaks ties.
    let best = candidates[0]!
    for (const candidate of candidates) {
      if (consumedOf(candidate) < consumedOf(best)) best = candidate
    }
    return best.id
  }

  // sticky: fill the first configured key before touching the next one.
  return candidates[0]!.id
}
