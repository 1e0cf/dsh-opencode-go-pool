/**
 * Background usage polling: keep every key's reading fresh without a UI.
 *
 * Polling is what makes preemption possible. A pool that only learns about an
 * exhausted key from a failed request cannot move a conversation before it
 * starts, which is the whole point: the switch has to happen at a session
 * boundary, not in the middle of one. So the readings are refreshed on a timer,
 * and a failed request only ever confirms what the poll already said.
 *
 * Failures are reported per key and never abort the sweep: one rejected key
 * must not stop the others from being observed.
 *
 * @module dsh-opencode-go-pool/poller
 */

import type { UsageReading } from './policy.ts'
import { fetchUsage, type UsageErrorCode } from './usage.ts'

/** One key to poll; credentials are resolved by the caller before each sweep. */
export interface PollTarget {
  readonly keyId: string
  readonly apiKey: string
  readonly orgId?: string
}

/** Transport knobs shared by every key in a sweep. */
export interface PollDeps {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** Result for a single key in a sweep. */
export type PollOutcome =
  | {
      readonly keyId: string
      readonly ok: true
      readonly usage: UsageReading
      readonly at: number
    }
  | {
      readonly keyId: string
      readonly ok: false
      readonly code: UsageErrorCode
      readonly message: string
    }

/** Default sweep interval; the windows move slowly and each sweep is 3 requests. */
export const DEFAULT_INTERVAL_MS = 60_000

/**
 * Poll every target once, concurrently.
 *
 * @param targets - keys to poll in this sweep.
 * @param deps - endpoint and transport overrides.
 * @returns one outcome per target, in the order given.
 */
export async function pollUsage(
  targets: readonly PollTarget[],
  deps: PollDeps = {},
): Promise<readonly PollOutcome[]> {
  const at = (deps.now ?? Date.now)()

  return Promise.all(
    targets.map(async (target): Promise<PollOutcome> => {
      try {
        const usage = await fetchUsage({
          apiKey: target.apiKey,
          ...(target.orgId === undefined ? {} : { orgId: target.orgId }),
          ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        })
        return { keyId: target.keyId, ok: true, usage, at }
      } catch (cause) {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause
            ? (cause as { code: UsageErrorCode }).code
            : 'unreachable'
        return {
          keyId: target.keyId,
          ok: false,
          code,
          message: cause instanceof Error ? cause.message : String(cause),
        }
      }
    }),
  )
}

/** Options for {@link UsagePoller}. */
export interface PollerOptions extends PollDeps {
  /** Resolve the current targets; called before every sweep. */
  readonly targets: () => readonly PollTarget[] | Promise<readonly PollTarget[]>
  /** Applied to every outcome of every sweep. */
  readonly onOutcome: (outcome: PollOutcome) => void
  /** Observe a sweep that failed before it produced outcomes. */
  readonly onError?: (error: unknown) => void
  /** Sweep interval, {@link DEFAULT_INTERVAL_MS} by default. */
  readonly intervalMs?: number
}

/**
 * A timer that keeps polling until stopped.
 *
 * Sweeps are chained rather than put on a fixed interval: a slow gateway delays
 * the next sweep instead of stacking requests on top of each other. The timer is
 * unreferenced, so a running poller never keeps a process alive on its own.
 */
export class UsagePoller {
  readonly #options: PollerOptions
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopped = true
  /** The first sweep, so a caller can wait for readings instead of guessing. */
  #first: Promise<void> | undefined

  constructor(options: PollerOptions) {
    this.#options = options
  }

  /** One sweep, regardless of whether the timer is running. */
  async once(): Promise<readonly PollOutcome[]> {
    const targets = await this.#options.targets()
    if (targets.length === 0) return []
    const outcomes = await pollUsage(targets, this.#options)
    for (const outcome of outcomes) this.#options.onOutcome(outcome)
    return outcomes
  }

  /** Begin sweeping; a running poller is left alone. */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#first = this.#sweep()
    void this.#first
  }

  /**
   * Resolves once the first sweep has settled.
   *
   * Sweeps start without a delay, but the readings still arrive one HTTP round
   * trip later — and a request that needs a key meanwhile would have to choose
   * with an empty picture. Waiting here costs one round trip, once per process.
   */
  whenSettled(): Promise<void> {
    return this.#first ?? Promise.resolve()
  }

  /** Stop after the sweep in flight, if any. */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  async #sweep(): Promise<void> {
    try {
      await this.once()
    } catch (error) {
      // A throwing target resolver must not kill the loop; the next sweep retries.
      this.#options.onError?.(error)
    }
    if (this.#stopped) return
    const interval = this.#options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.#timer = setTimeout(() => void this.#sweep(), interval)
    this.#timer.unref?.()
  }
}
