/**
 * The pool: what each configured key currently looks like, and which key is
 * pinned to a conversation.
 *
 * The pool is deliberately transport-free and harness-free. It owns three
 * pieces of state — the last usage reading per key, a local block mark, and the
 * affinity ⇒ key pins — and answers one question: what should serve this
 * conversation now. Writing a pin is delegated to {@link PinStore}, because the
 * place a pin lives is the caller's decision (the harness session log).
 *
 * A local block mark matters because the usage endpoint lags: a request can
 * fail with an exhausted quota while the poll a minute ago still reports a
 * healthy key. The mark keeps the pool off that key until a fresh reading
 * clears it, so a session does not bounce back onto the key that just refused
 * it.
 *
 * @module dsh-opencode-go-pool/pool
 */

import {
  assessKey,
  DEFAULT_THRESHOLD_PERCENT,
  selectKey,
  type KeyAssessment,
  type KeyState,
  type KeyUnusableReason,
  type PolicyName,
  type Selection,
  type UsageReading,
} from './policy.ts'

/** One configured key. */
export interface PoolKey {
  /** Stable id used in pins and diagnostics. */
  readonly id: string
  /** Credential reference the caller resolves on dispatch. */
  readonly apiKeyEnv?: string
  /** Organisation id sent alongside the key, when the account has one. */
  readonly orgId?: string
}

/** Where affinity pins are persisted. */
export interface PinStore {
  /** The key pinned to `affinity`, or `undefined`. */
  get(affinity: string): Promise<string | undefined>
  /** Persist a pin; `affinity` may be written more than once over its life. */
  set(affinity: string, keyId: string): Promise<void>
}

/** Pool configuration, all of it fixed at construction. */
export interface PoolOptions {
  readonly keys: readonly PoolKey[]
  /** Strategy for conversations that have no pin yet. */
  readonly policy: PolicyName
  /** Consumed share above which an unpinned conversation avoids a key. */
  readonly thresholdPercent?: number
  /** Pin persistence; without one pins live only in memory. */
  readonly pins?: PinStore
}

/** Per-key view for diagnostics and logging. */
export interface KeyReport {
  readonly id: string
  readonly assessment: KeyAssessment
  /** Local block mark, cleared by the next successful poll. */
  readonly blocked: KeyUnusableReason | null
  readonly observedAt: number | null
}

/** Snapshot of the whole pool. */
export interface PoolStatus {
  readonly keys: readonly KeyReport[]
  /** How many affinities currently carry a pin. */
  readonly pinCount: number
}

interface Entry {
  readonly key: PoolKey
  usage: UsageReading | null
  observedAt: number | null
  blocked: KeyUnusableReason | null
}

/** Pins held in memory only, for callers without a session log to write to. */
export class MemoryPinStore implements PinStore {
  readonly #pins = new Map<string, string>()

  async get(affinity: string): Promise<string | undefined> {
    return this.#pins.get(affinity)
  }

  async set(affinity: string, keyId: string): Promise<void> {
    this.#pins.set(affinity, keyId)
  }
}

/** The pool itself. All methods are safe to call concurrently. */
export class KeyPool {
  readonly #entries: Map<string, Entry>
  readonly #order: readonly string[]
  readonly #policy: PolicyName
  readonly #thresholdPercent: number
  readonly #pins: PinStore | undefined
  /** Affinity ⇒ key, so a pin is read from storage at most once per process. */
  readonly #known = new Map<string, string>()

  constructor(options: PoolOptions) {
    const entries = new Map<string, Entry>()
    for (const key of options.keys) {
      if (entries.has(key.id)) throw new Error(`duplicate pool key id: ${key.id}`)
      entries.set(key.id, { key, usage: null, observedAt: null, blocked: null })
    }
    if (entries.size === 0) throw new Error('pool needs at least one key')

    this.#entries = entries
    this.#order = options.keys.map((key) => key.id)
    this.#policy = options.policy
    this.#thresholdPercent = options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT
    this.#pins = options.pins
  }

  /** Configured keys in configuration order. */
  keys(): readonly PoolKey[] {
    return this.#order.map((id) => this.#entries.get(id)!.key)
  }

  /** The configured key with this id, if any. */
  key(keyId: string): PoolKey | undefined {
    return this.#entries.get(keyId)?.key
  }

  /**
   * Record a successful usage poll for one key.
   *
   * A fresh reading is the strongest evidence available, so it clears any local
   * block mark for that key.
   *
   * @param keyId - configured key the reading belongs to.
   * @param usage - decoded windows.
   * @param at - when the reading was taken, epoch milliseconds.
   */
  observe(keyId: string, usage: UsageReading, at: number): void {
    const entry = this.#entries.get(keyId)
    if (!entry) return
    entry.usage = usage
    entry.observedAt = at
    entry.blocked = null
  }

  /**
   * Mark a key as unable to serve, from a failed request rather than a poll.
   *
   * @param keyId - configured key that refused.
   * @param reason - `rate-limited` for an exhausted quota, `exhausted` when the
   *   gateway reports the allowance as spent without naming a window.
   */
  block(keyId: string, reason: KeyUnusableReason): void {
    const entry = this.#entries.get(keyId)
    if (!entry) return
    entry.blocked = reason
  }

  /** Per-key reports in configuration order. */
  report(): readonly KeyReport[] {
    return this.#order.map((id) => {
      const entry = this.#entries.get(id)!
      const basis: KeyState = {
        id,
        usage: entry.usage,
        observedAt: entry.observedAt,
      }
      const base = assessKey(basis)
      const assessment: KeyAssessment =
        entry.blocked === null
          ? base
          : {
              ...base,
              usable: false,
              reason: entry.blocked,
            }
      return {
        id,
        assessment,
        blocked: entry.blocked,
        observedAt: entry.observedAt,
      }
    })
  }

  /** Snapshot for diagnostics. */
  status(): PoolStatus {
    return { keys: this.report(), pinCount: this.#known.size }
  }

  /**
   * Pick the key that should serve one conversation.
   *
   * An existing pin that can still serve is returned as-is. Otherwise a key is
   * chosen by policy and persisted, so the next request of the same
   * conversation — or a subagent sharing its affinity — lands on the same
   * account.
   *
   * @param affinity - conversation affinity id.
   * @returns the chosen key, or `null` when nothing can serve.
   */
  async resolve(affinity: string): Promise<Selection | null> {
    const pin = await this.#pinOf(affinity)
    const selection = selectKey(this.#policy, {
      affinity,
      keys: this.report().map((report) => report.assessment),
      pin,
      thresholdPercent: this.#thresholdPercent,
    })

    if (selection === null) return null
    if (!selection.pinned) await this.#pin(affinity, selection.keyId)
    return selection
  }

  /** The key currently pinned to one affinity, from memory or storage. */
  async pinned(affinity: string): Promise<string | undefined> {
    return this.#pinOf(affinity)
  }

  async #pinOf(affinity: string): Promise<string | undefined> {
    const known = this.#known.get(affinity)
    if (known !== undefined) return known
    const stored = await this.#pins?.get(affinity)
    if (stored !== undefined) this.#known.set(affinity, stored)
    return stored
  }

  async #pin(affinity: string, keyId: string): Promise<void> {
    this.#known.set(affinity, keyId)
    await this.#pins?.set(affinity, keyId)
  }
}
