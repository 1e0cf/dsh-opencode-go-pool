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
 * How soon an empty sweep is retried while the pool still has no reading.
 *
 * A host mounts this plugin before the profile's services, so the first sweep can
 * legitimately find no credential yet. Retrying on the normal interval would
 * leave the pool blind for a minute — long enough for the first request of the
 * process to pin whatever account comes first.
 */
export const DEFAULT_READINESS_RETRY_MS = 1_000

/** Give up waiting for a usable sweep after this long, so routing never blocks. */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000

/** Empty sweeps tolerated before the retry cadence falls back to the interval. */
const EMPTY_SWEEP_LIMIT = 10

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
  /** Delay before retrying a sweep that produced no reading at all. */
  readonly readinessRetryMs?: number
  /** Longest wait for the pool's first reading before routing proceeds blind. */
  readonly readinessTimeoutMs?: number
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
  /** Settles when the pool has readings, or when waiting any longer is pointless. */
  #first: Promise<void> | undefined
  #settled: () => void = () => {}
  #readings = false
  #emptySweeps = 0

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
    this.#first = new Promise<void>((resolve) => {
      this.#settled = resolve
    })
    const timeout = setTimeout(
      () => this.#markReady(),
      this.#options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    )
    timeout.unref?.()
    void this.#sweep()
  }

  /**
   * Resolves once the pool has a reading it can choose on.
   *
   * Sweeps start without a delay, but the readings still arrive one HTTP round
   * trip later — and a request that needs a key meanwhile would have to choose
   * with an empty picture. A sweep that found no target at all proves nothing
   * either, so it is retried quickly instead of being treated as an answer.
   */
  whenSettled(): Promise<void> {
    return this.#first ?? Promise.resolve()
  }

  /** Stop after the sweep in flight, if any. */
  stop(): void {
    this.#stopped = true
    // Nobody can be served by a stopped poller; release whoever waits on it.
    this.#markReady()
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  async #sweep(): Promise<void> {
    let observed = 0
    try {
      observed = (await this.once()).length
    } catch (error) {
      // A throwing target resolver must not kill the loop; the next sweep retries.
      this.#options.onError?.(error)
    }
    if (observed > 0) {
      this.#emptySweeps = 0
      this.#markReady()
    } else if (!this.#readings && ++this.#emptySweeps > EMPTY_SWEEP_LIMIT) {
      // A host without usable credentials must still route, not hang forever.
      this.#markReady()
    }
    if (this.#stopped) return
    const interval = this.#options.intervalMs ?? DEFAULT_INTERVAL_MS
    const retry = this.#options.readinessRetryMs ?? DEFAULT_READINESS_RETRY_MS
    const delay = this.#readings ? interval : Math.min(interval, retry)
    this.#timer = setTimeout(() => void this.#sweep(), delay)
    this.#timer.unref?.()
  }

  #markReady(): void {
    if (this.#readings) return
    this.#readings = true
    this.#settled()
  }
}
