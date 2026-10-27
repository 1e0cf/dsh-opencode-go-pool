/**
 * Pins kept in the conversation's own log.
 *
 * A pin has to outlive the process, travel with a fork, and disappear with the
 * conversation. The harness session log already does all three, so a pin is an
 * ignorable plugin record on the session that owns the affinity — no sidecar
 * file, no cleanup, and a copy of a conversation carries its account with it.
 *
 * The record API is marked experimental, so every operation here degrades: a
 * log that refuses a read or a write costs at worst a re-pick, never a failed
 * request.
 *
 * @module dsh-opencode-go-pool/pins
 */

import type { PinStore } from './pool.ts'

/** Record name; the harness scopes it under the plugin owner. */
export const PIN_RECORD = 'pin'

/** The surface the harness session log has to offer. */
export interface SessionPinPort {
  /** Latest pin payload appended to this session, if the log has one. */
  read(affinity: string): unknown
  /** Append a pin payload to this session's log. */
  append(affinity: string, data: { keyId: string }): void
}

/** Narrow a stored payload to a key id. */
export function pinOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { keyId?: unknown }).keyId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/** Options for {@link SessionPinStore}. */
export interface SessionPinStoreOptions {
  /** Observe a log failure the store chose to survive. */
  readonly onError?: (detail: {
    operation: 'read' | 'write'
    affinity: string
    error: unknown
  }) => void
}

/** {@link PinStore} backed by the conversation log. */
export class SessionPinStore implements PinStore {
  readonly #port: SessionPinPort
  readonly #options: SessionPinStoreOptions

  constructor(port: SessionPinPort, options: SessionPinStoreOptions = {}) {
    this.#port = port
    this.#options = options
  }

  async get(affinity: string): Promise<string | undefined> {
    try {
      return pinOf(this.#port.read(affinity))
    } catch (error) {
      this.#options.onError?.({ operation: 'read', affinity, error })
      return undefined
    }
  }

  async set(affinity: string, keyId: string): Promise<void> {
    try {
      this.#port.append(affinity, { keyId })
    } catch (error) {
      // The pool keeps the pin in memory for this process, so a failed write
      // only costs the pin across a restart.
      this.#options.onError?.({ operation: 'write', affinity, error })
    }
  }
}
