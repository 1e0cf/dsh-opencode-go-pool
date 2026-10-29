/**
 * The adapter the harness sees: one route, several accounts behind it.
 *
 * The harness dispatches a call and gets a stream; this layer decides which
 * account serves that call and then hands the request to the adapter built for
 * that account. Model metadata, pricing, and retry policy are account-neutral,
 * so they come from a single catalog source and are answered without touching
 * the pool.
 *
 * The adapters are structural here on purpose. This module is the whole
 * decision surface and stays free of harness imports, so it is tested against
 * fakes; the wiring that imports real adapters lives in the plugin entry.
 *
 * @module dsh-opencode-go-pool/adapter
 */

import type { KeyPool } from './pool.ts'
import type { KeyUnusableReason } from './policy.ts'

/** One model descriptor as the harness seam passes it around. */
export interface AdapterModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly [extra: string]: unknown
}

/** One dispatch request; unknown harness fields are carried through untouched. */
export interface AdapterCall {
  readonly provider: string
  readonly model: string
  /** Raw session id, for providers that want it. */
  readonly sessionId?: unknown
  /** Lineage root, the id that routes the provider-side cache. */
  readonly sessionAffinity?: unknown
  readonly signal?: AbortSignal
  readonly [extra: string]: unknown
}

/** A dispatch bound to one adapter generation. */
export interface PreparedCallLike {
  readonly model: AdapterModelInfo
  stream(options: AdapterCall): AsyncIterable<unknown>
}

/** The adapter surface this plugin drives; a harness adapter satisfies it. */
export interface InnerAdapter {
  providerInfo?(provider: string): AdapterModelInfo
  providerRetryPolicy?(provider: string): unknown
  imageRequestPricing?(provider: string, model: string): unknown
  imageRequestTarget?(provider: string, model: string, image: unknown): unknown
  listModels?(provider: string): Promise<readonly AdapterModelInfo[]>
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<AdapterModelInfo>
  prepareCall?(provider: string, model: string, signal?: AbortSignal): Promise<PreparedCallLike>
  stream(options: AdapterCall): AsyncIterable<unknown>
}

/** Provider codes that mean "this account is out of allowance", not "retry later". */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'USAGE_LIMIT',
  'USAGE_LIMIT_REACHED',
])

/** Provider codes that mean the account's own credential is refused. */
const AUTH_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'UNAUTHORIZED',
  'MISSING_CREDENTIAL',
])

/** Raised when every configured key is unable to serve. */
export class PoolExhaustedError extends Error {
  /** Counts as a quota failure for retry and reporting purposes. */
  readonly code = 'QUOTA_EXCEEDED'
  /** Keys that were tried and their blocking reason, for diagnostics. */
  readonly blocked: readonly { keyId: string; reason: KeyUnusableReason }[]

  constructor(affinity: string, blocked: readonly { keyId: string; reason: KeyUnusableReason }[]) {
    const detail = blocked.map((entry) => `${entry.keyId} (${entry.reason})`).join(', ')
    super(
      `no OpenCode Go key can serve conversation "${affinity}"${detail === '' ? '' : `: ${detail}`}`,
    )
    this.name = 'PoolExhaustedError'
    this.blocked = blocked
  }
}

/** Pool the adapter draws from plus the pieces it does not own. */
export interface PoolAdapterOptions {
  readonly pool: KeyPool
  /** One adapter per configured key id. */
  readonly adapters: ReadonlyMap<string, InnerAdapter>
  /** Account-neutral source for model metadata and the retry policy. */
  readonly catalog: InnerAdapter
  /**
   * Which session a call belongs to — the raw session id, not the lineage
   * root: pins are per session so that a compaction re-pin in a parent leaves
   * a running child where its cache is.
   */
  readonly conversationOf: (options: AdapterCall) => string
  /** Observe a failed dispatch, after the pool has reacted to it. */
  readonly onError?: (detail: { keyId: string; error: unknown }) => void
}

/**
 * Read the provider code off a thrown value.
 *
 * The harness normalizes adapter failures by reading an own `code` property, so
 * anything carrying one keeps its meaning; the shape is checked rather than
 * assumed because adapters throw provider SDK errors too.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const own = Object.getOwnPropertyDescriptor(error, 'code')
  if (own !== undefined && 'value' in own && typeof own.value === 'string') return own.value
  const failure = Object.getOwnPropertyDescriptor(error, 'failure')
  if (failure !== undefined && 'value' in failure) {
    const nested = failure.value as { code?: unknown } | undefined
    if (typeof nested?.code === 'string') return nested.code
  }
  return undefined
}

/** Whether a failure means the account itself is spent. */
export function blockReasonOf(error: unknown): KeyUnusableReason | null {
  const code = codeOf(error)
  if (code === undefined) return null
  if (QUOTA_CODES.has(code)) return 'rate-limited'
  if (AUTH_CODES.has(code)) return 'unauthorized'
  return null
}

/**
 * A harness adapter that routes each call to the account pinned to its
 * conversation.
 */
export class PoolAdapter implements InnerAdapter {
  readonly #options: PoolAdapterOptions
  readonly #providers: readonly string[]

  constructor(options: PoolAdapterOptions, providers: readonly string[]) {
    if (providers.length === 0) throw new Error('pool adapter needs at least one route')
    this.#options = options
    this.#providers = providers
  }

  /** Routes claimed by this adapter, as registered with the harness. */
  providers(): readonly string[] {
    return this.#providers
  }

  providerInfo(provider: string): AdapterModelInfo {
    return (
      this.#options.catalog.providerInfo?.(provider) ?? { provider, id: provider, name: provider }
    )
  }

  providerRetryPolicy(provider: string): unknown {
    return this.#options.catalog.providerRetryPolicy?.(provider)
  }

  imageRequestPricing(provider: string, model: string): unknown {
    return this.#options.catalog.imageRequestPricing?.(provider, model)
  }

  imageRequestTarget(provider: string, model: string, image: unknown): unknown {
    return this.#options.catalog.imageRequestTarget?.(provider, model, image)
  }

  listModels(provider: string): Promise<readonly AdapterModelInfo[]> {
    return this.#options.catalog.listModels?.(provider) ?? Promise.resolve([])
  }

  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<AdapterModelInfo> {
    return (
      this.#options.catalog.resolveModel?.(provider, model, signal) ??
      Promise.resolve({ provider, id: model, name: model })
    )
  }

  /**
   * Bind metadata and dispatch to the current pool state.
   *
   * The harness pins metadata and dispatch per step; the account is chosen at
   * dispatch, so a key that died between preparation and the call is still
   * replaced rather than failing the step.
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedCallLike> {
    const info = await this.resolveModel(provider, model, signal)
    return { model: info, stream: (options) => this.stream(options) }
  }

  stream(options: AdapterCall): AsyncIterable<unknown> {
    return this.#dispatch(options)
  }

  async *#dispatch(options: AdapterCall): AsyncIterable<unknown> {
    const conversation = this.#options.conversationOf(options)
    const selection = await this.#options.pool.resolve(conversation)
    if (selection === null) throw new PoolExhaustedError(conversation, this.#blocked())

    const inner = this.#options.adapters.get(selection.keyId)
    if (inner === undefined) {
      throw new Error(`no adapter for pooled key "${selection.keyId}" (session "${conversation}")`)
    }

    try {
      yield* inner.stream(options)
    } catch (error) {
      const reason = blockReasonOf(error)
      if (reason !== null) this.#options.pool.block(selection.keyId, reason)
      this.#options.onError?.({ keyId: selection.keyId, error })
      throw error
    }
  }

  #blocked(): readonly { keyId: string; reason: KeyUnusableReason }[] {
    return this.#options.pool
      .report()
      .filter((entry) => !entry.assessment.usable)
      .map((entry) => ({ keyId: entry.id, reason: entry.assessment.reason ?? 'exhausted' }))
  }
}
