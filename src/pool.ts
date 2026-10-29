/**
 * The pool: what each configured key currently looks like, and which key is
 * pinned to a conversation.
 *
 * The pool is deliberately transport-free and harness-free. It owns three
 * pieces of state — the last usage reading per key, a local block mark, and the
 * session ⇒ key pins — and answers one question: what should serve this
 * conversation now. Writing a pin is delegated to {@link PinStore}, because the
 * place a pin lives is the caller's decision (the harness session log).
 *
 * Pins belong to the session that made the request, and a session inherits the
 * pin of the nearest ancestor that has one — a subagent or a fork starts where
 * its parent is, which is what keeps the whole conversation inside one
 * provider-side cache bucket. The inherited pin is then written into the
 * session's own log, so a later change on the ancestor (a compaction re-pin)
 * does not drag a running child along with it.
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

/**
 * Where session pins are persisted.
 *
 * A store answers with the pin that still applies, or nothing — deciding that a
 * pin was invalidated (a compaction in between) is the store's business, so the
 * pool never has to reason about staleness.
 */
export interface PinStore {
  /** The pin that still applies to one session, or `undefined`. */
  get(sessionId: string): Promise<string | undefined>
  /** Persist a pin; a session may be written more than once over its life. */
  set(sessionId: string, keyId: string): Promise<void>
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
  /**
   * Live ancestor chain of one session, nearest first and including the
   * session itself. Used to inherit a pin; without it every session starts
   * unattached.
   */
  readonly lineageOf?: (sessionId: string) => Promise<readonly string[]>
  /**
   * Resolves when the first usage readings are in, if they ever come.
   *
   * Right after a process start no key has been polled yet, so every account
   * looks equally free and the choice falls back to configuration order — which
   * can pin a conversation to the account that is nearly spent. An unattached
   * conversation waits for this before choosing, once per process.
   */
  readonly ready?: () => Promise<void>
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

  async get(sessionId: string): Promise<string | undefined> {
    return this.#pins.get(sessionId)
  }

  async set(sessionId: string, keyId: string): Promise<void> {
    this.#pins.set(sessionId, keyId)
  }
}

/** The pool itself. All methods are safe to call concurrently. */
export class KeyPool {
  readonly #entries: Map<string, Entry>
  readonly #order: readonly string[]
  readonly #policy: PolicyName
  readonly #thresholdPercent: number
  readonly #pins: PinStore | undefined
  readonly #lineageOf: ((sessionId: string) => Promise<readonly string[]>) | undefined
  readonly #ready: (() => Promise<void>) | undefined
  /** Session ⇒ key, so a pin is read from storage at most once per process. */
  readonly #known = new Map<string, string>()
  /** First reading gate, memoised so the wait happens at most once. */
  #readings: Promise<void> | undefined

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
    this.#lineageOf = options.lineageOf
    this.#ready = options.ready
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
  async resolve(conversation: string): Promise<Selection | null> {
    const pin = await this.#pinOf(conversation)
    // An attached conversation is already decided; only a fresh choice needs
    // the readings, and choosing without them pins whatever comes first.
    if (pin === undefined) await this.#firstReading()
    const selection = selectKey(this.#policy, {
      affinity: conversation,
      keys: this.report().map((report) => report.assessment),
      pin,
      thresholdPercent: this.#thresholdPercent,
    })

    if (selection === null) return null
    if (!selection.pinned) await this.#pin(conversation, selection.keyId)
    return selection
  }

  /** The key currently pinned to one session, from memory or storage. */
  async pinned(conversation: string): Promise<string | undefined> {
    return this.#pinOf(conversation)
  }

  /**
   * Wait for the process's first usage readings, at most once.
   *
   * Only a pool with nothing observed waits, and a failing or hanging source is
   * never allowed to block routing: an error is swallowed and the choice falls
   * back to what the pool knows, which is the pre-existing behaviour.
   */
  async #firstReading(): Promise<void> {
    if (this.#ready === undefined) return
    if (this.#order.some((id) => this.#entries.get(id)!.usage !== null)) return
    this.#readings ??= this.#ready().catch(() => {})
    await this.#readings
  }

  async #pinOf(conversation: string): Promise<string | undefined> {
    // The store answers, memory only remembers. A pin can stop applying while
    // the process runs — a compaction rebuilds the context, and with it the
    // gateway cache — so a memoised key must never short-circuit the question:
    // the session would keep an account the log has already released it from.
    if (this.#pins === undefined) return this.#known.get(conversation)

    const own = await this.#pins.get(conversation)
    if (own !== undefined) {
      this.#known.set(conversation, own)
      return own
    }

    const lineage = (await this.#lineageOf?.(conversation)) ?? [conversation]
    for (const ancestor of lineage.slice(1)) {
      const inherited = await this.#pins?.get(ancestor)
      if (inherited === undefined) continue
      // Adoption, not a lookup: writing it here is what insulates this session
      // from a later re-pin of the ancestor.
      await this.#pin(conversation, inherited)
      return inherited
    }
    return undefined
  }

  async #pin(conversation: string, keyId: string): Promise<void> {
    this.#known.set(conversation, keyId)
    await this.#pins?.set(conversation, keyId)
  }
}
