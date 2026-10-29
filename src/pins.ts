/**
 * Pins kept in the conversation's own log, read incrementally.
 *
 * A pin has to outlive the process and travel with a resume, so it lives in the
 * harness session log as an ignorable plugin record. Reading it back must not
 * cost a full log scan per request, so the store keeps a per-session cursor and
 * folds only the events appended since the last read.
 *
 * The store also answers *whether* a pin is still meaningful. A compacted
 * session sends a rebuilt context, so its cache is paid for again either way —
 * a pin written before the last compaction is stale, and the session may as
 * well be re-chosen under the current load policy. Comparing two sequence
 * numbers makes that a fact of the log rather than a flag in memory: it
 * survives restarts and replays, and no event subscription is needed.
 *
 * The record API is experimental, so every operation degrades: a log that
 * refuses a read or a write costs at worst a re-pick, never a failed request.
 *
 * @module dsh-opencode-go-pool/pins
 */

import type { PinStore } from './pool.ts'

/** Record name; the harness scopes it under the plugin owner. */
export const PIN_RECORD = 'pin'

/** Record type this plugin owns inside the session log. */
export const PIN_RECORD_TYPE = 'plugin:opencode-go-pool/pin'

/**
 * Event that rebuilds a conversation's context.
 *
 * `compaction/summary` rather than `compaction/end`: the latter is also written
 * for a failed attempt, and a context that was not rebuilt leaves the cache —
 * and therefore the pin — intact.
 */
export const COMPACTION_EVENT = 'compaction/summary'

/** The facts this module needs from one session's log. */
export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** What {@link SessionPinStore} needs from the harness. */
export interface SessionScanPort {
  /**
   * Events of one session in `[fromSeq, toSeqExclusive)`, in log order, limited
   * to the two types this module folds.
   */
  read(sessionId: string, fromSeq: number, toSeqExclusive: number): readonly LogEvent[]
  /** Length of the session's event log, or `undefined` when it is not live. */
  endSeq(sessionId: string): number | undefined
  /**
   * First event this session owns: a fork-inherited prefix is not this
   * conversation's history, so reads never go below this.
   */
  floorSeq(sessionId: string): number
  /** Append one pin record and return its sequence number. */
  append(sessionId: string, data: { keyId: string }): number
}

/** Options for {@link SessionPinStore}. */
export interface SessionPinStoreOptions {
  /** Re-choose after compaction; when false, a pin survives it. */
  readonly repinOnCompaction?: boolean
  /** Observe a log failure the store chose to survive. */
  readonly onError?: (detail: {
    operation: 'read' | 'write'
    sessionId: string
    error: unknown
  }) => void
}

/** What one session's log says about its pin, as of `end`. */
export interface PinFacts {
  /** Latest pin, or `undefined` when the session has none that still applies. */
  readonly pinKey: string | undefined
  /** True when a context rebuild happened after the latest pin. */
  readonly stale: boolean
  /** Session length these facts cover. */
  readonly end: number
}

/** Nothing seen yet. */
export const EMPTY_FACTS: PinFacts = { pinKey: undefined, stale: false, end: 0 }

/** Narrow a stored payload to a key id. */
export function pinOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { keyId?: unknown }).keyId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/**
 * Fold newly seen events into the accumulated facts, in log order.
 *
 * Whichever of the two records comes last wins: a pin written after a
 * compaction applies, a compaction after a pin invalidates it.
 *
 * @param facts - facts before the new events.
 * @param events - events in log order, each newer than the previous read.
 * @param repinOnCompaction - whether a compaction invalidates a pin.
 * @returns the facts after the events.
 */
export function foldPinFacts(
  facts: PinFacts,
  events: readonly LogEvent[],
  repinOnCompaction = true,
): PinFacts {
  let pinKey = facts.pinKey
  let stale = facts.stale
  let end = facts.end

  for (const event of events) {
    if (event.type === PIN_RECORD_TYPE) {
      const keyId = pinOf(event.data)
      if (keyId !== undefined) {
        pinKey = keyId
        stale = false
      }
    } else if (repinOnCompaction && event.type === COMPACTION_EVENT) {
      stale = true
    }
    if (event.seq >= end) end = event.seq + 1
  }

  return { pinKey, stale, end }
}

/**
 * {@link PinStore} backed by the conversation log.
 *
 * A cold read takes the session's own range in one call and walks it backwards
 * until a record settles the question — a pin (it applies) or a context rebuild
 * (it does not). The whole log of a long conversation costs a fraction of a
 * millisecond to scan, so one bulk read beats a chunked walk in both code and
 * time. A warm read folds only what was appended since the last look, and a
 * session nobody touched costs nothing at all.
 */
export class SessionPinStore implements PinStore {
  readonly #port: SessionScanPort
  readonly #options: SessionPinStoreOptions
  readonly #facts = new Map<string, PinFacts>()

  constructor(port: SessionScanPort, options: SessionPinStoreOptions = {}) {
    this.#port = port
    this.#options = options
  }

  async get(sessionId: string): Promise<string | undefined> {
    try {
      const facts = this.#factsOf(sessionId)
      return facts.stale ? undefined : facts.pinKey
    } catch (error) {
      this.#options.onError?.({ operation: 'read', sessionId, error })
      return undefined
    }
  }

  async set(sessionId: string, keyId: string): Promise<void> {
    try {
      const seq = this.#port.append(sessionId, { keyId })
      const facts = this.#facts.get(sessionId) ?? EMPTY_FACTS
      this.#facts.set(sessionId, { pinKey: keyId, stale: false, end: Math.max(facts.end, seq + 1) })
    } catch (error) {
      // The pool keeps the pin in memory for this process, so a failed write
      // only costs the pin across a restart.
      this.#options.onError?.({ operation: 'write', sessionId, error })
    }
  }

  /** Facts for one session, reading only what the cache does not already cover. */
  #factsOf(sessionId: string): PinFacts {
    const end = this.#port.endSeq(sessionId)
    if (end === undefined) return this.#facts.get(sessionId) ?? EMPTY_FACTS

    const known = this.#facts.get(sessionId)
    if (known === undefined) {
      const facts = this.#scanBackwards(sessionId, end)
      this.#facts.set(sessionId, facts)
      return facts
    }
    if (end <= known.end) return known

    const events = this.#port.read(sessionId, known.end, end)
    const facts = foldPinFacts(known, events, this.#repin())
    this.#facts.set(sessionId, facts)
    return facts
  }

  /** Walk back until one record settles the pin, or the session's own history begins. */
  #scanBackwards(sessionId: string, end: number): PinFacts {
    const repin = this.#repin()
    const events = this.#port.read(sessionId, this.#port.floorSeq(sessionId), end)

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === PIN_RECORD_TYPE) {
        const keyId = pinOf(event.data)
        if (keyId !== undefined) return { pinKey: keyId, stale: false, end }
      } else if (repin && event.type === COMPACTION_EVENT) {
        return { pinKey: undefined, stale: true, end }
      }
    }

    return { pinKey: undefined, stale: false, end }
  }

  #repin(): boolean {
    return this.#options.repinOnCompaction ?? true
  }
}
