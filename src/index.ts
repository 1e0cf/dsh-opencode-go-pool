/**
 * Plugin entry: wire the pool into the harness.
 *
 * Everything above this file is harness-free and unit-tested. This file is the
 * seam, and it touches three harness facts worth spelling out:
 *
 * - The adapter claims the `opencode-go` route. The route must be vacated by
 *   `llm-pi-ai` first (drop the `opencode-go` entry from its `providers`), and
 *   `DUPLICATE_ADAPTER` while it is still occupied is expected, not fatal.
 * - Credentials are resolved through the harness credential seam on every use,
 *   so rotating a stored key reaches the next request without a restart.
 * - Pins live in the conversation log. The record API is experimental, hence
 *   the defensive reads and writes in `pins.ts`.
 *
 * The harness packages are imported dynamically rather than as build-time
 * dependencies: this plugin must use the very `pi-ai` and adapter the running
 * harness installed (including its patches), never a private copy.
 *
 * @module dsh-opencode-go-pool
 */

import { PoolAdapter, type AdapterCall, type InnerAdapter } from './adapter.ts'
import { resolveConfig, ROUTE, type KeyConfig, type ResolvedPoolConfig } from './config.ts'
import {
  COMPACTION_EVENT,
  PIN_RECORD_TYPE,
  SessionPinStore,
  type LogEvent,
  type SessionScanPort,
} from './pins.ts'
import { UsagePoller, type PollTarget } from './poller.ts'
import { KeyPool } from './pool.ts'
import type { KeyUnusableReason } from './policy.ts'

/** Cordis plugin name, also the owner segment of the pin record. */
export const name = 'opencode-go-pool'

/** The plugin cannot work without the LLM registry. */
export const inject = ['llm']

/**
 * Harness packages, named through opaque constants so this package compiles
 * without them present while still importing whatever the harness installed.
 */
const SESSION_MODULE: string = '@deepseek-ai/dsh-session'
const LLM_MODULE: string = '@deepseek-ai/dsh-llm'
const PI_AI_PLUGIN: string = '@deepseek-ai/dsh-llm-pi-ai'
const PI_AI_PROVIDER: string = '@earendil-works/pi-ai/providers/opencode-go'

/** Provider code that means "this account is spent", not "retry later". */
const QUOTA_CODE = 'QUOTA_EXCEEDED'

/**
 * Retry policy for the route.
 *
 * `QUOTA_EXCEEDED` is retryable here, unlike the harness default: the retry
 * resolves the pin again, finds the spent account blocked, and lands on the
 * other one. Without it a mid-conversation quota failure would end the turn
 * instead of failing over.
 */
const RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 5,
  retryableCodes: Object.freeze([
    'EMPTY_RESPONSE',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    QUOTA_CODE,
  ]),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/** Limits pi-ai needs from a provider profile; the defaults match `llm-pi-ai`. */
const PROFILE_DEFAULTS = {
  streamIdleTimeoutMs: 300_000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
}

// ---------------------------------------------------------------------------
// Harness shapes, described structurally so this package builds without them.
// ---------------------------------------------------------------------------

interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly ignorable?: boolean
  readonly data?: unknown
}

interface PluginRecordLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface SessionLike {
  readonly id?: string
  readonly header?: { readonly parentSession?: string }
  /** Number of leading events inherited from a fork parent. */
  readonly inheritedEventCount?: number
  /** Length of this session's event log. */
  readonly seq: number
  snapshotEvents(fromSeq: number, toSeqExclusive?: number): readonly SessionEventLike[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface LlmLike {
  registerAdapter(routes: string[], adapter: unknown): unknown
}

/** The slice of the Cordis context this plugin uses. */
export interface PluginContext {
  readonly llm: LlmLike
  readonly logger: LoggerLike
  get(service: string): unknown
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/** Provider factory and adapter class as the running harness exports them. */
interface PiAiPluginModule {
  PiAiAdapter: new (options: {
    profiles: () => ReadonlyMap<string, unknown>
    resolveApiKey: () => Promise<string | undefined>
    auth: unknown
    resolveAttachments?: () => unknown
    resolveImageAccess?: (attachments: unknown, ref: unknown) => unknown
  }) => InnerAdapter
}

interface LlmModule {
  resolveImageAttachmentAccess(
    attachments: unknown,
    processPathFromHostPath: (hostPath: string) => string | undefined,
    ref: unknown,
  ): unknown
}

interface FsLike {
  processPathFromHostPath(hostPath: string): string | undefined
}

interface ProviderModule {
  opencodeGoProvider: () => { readonly id: string; readonly name?: string }
}

// ---------------------------------------------------------------------------
// Harness services, resolved lazily and tolerated when absent.
// ---------------------------------------------------------------------------

function loggerOf(ctx: PluginContext): LoggerLike {
  return (
    ctx.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const own = Object.getOwnPropertyDescriptor(error, 'code')
  return own !== undefined && 'value' in own && typeof own.value === 'string'
    ? own.value
    : undefined
}

/** Resolve one credential reference, through the seam and then the process env. */
async function resolveSecret(ctx: PluginContext, reference: string): Promise<string> {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(reference)
      if (hit?.value !== undefined && hit.value !== '') return hit.value
    } catch (error) {
      loggerOf(ctx).warn(
        `opencode-go-pool: credential "${reference}" could not be resolved: %o`,
        error,
      )
    }
  }
  const ambient = process.env[reference]
  if (ambient !== undefined && ambient !== '') return ambient
  throw new Error(
    `opencode-go-pool: credential "${reference}" is not stored and not in the environment`,
  )
}

/**
 * The log port pins are stored and read through.
 *
 * Reads are incremental: the caller passes the sequence it has already folded,
 * and only the tail comes back, limited to the two record types that matter —
 * a pin and a context rebuild. Events inherited from a fork parent are skipped,
 * because a fork starts as its own conversation (the harness itself records no
 * parent for an ordinary fork).
 */
async function scanPort(ctx: PluginContext): Promise<SessionScanPort> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  // Imported from the running harness: record helpers are versioned with it,
  // and the specifier is opaque so this package needs no dependency on it.
  const sessionModule = (await import(SESSION_MODULE)) as {
    appendPluginRecord(session: SessionLike, type: string, data: unknown): number
    pluginRecordOf(event: SessionEventLike): PluginRecordLike | undefined
  }

  const live = (sessionId: string): SessionLike | undefined => sessions?.get(sessionId)

  return {
    read(sessionId: string, fromSeq: number, toSeqExclusive: number): readonly LogEvent[] {
      const session = live(sessionId)
      if (session === undefined) return []
      const start = Math.max(fromSeq, session.inheritedEventCount ?? 0)
      if (start >= toSeqExclusive) return []

      const events: LogEvent[] = []
      for (const event of session.snapshotEvents(start, toSeqExclusive)) {
        const record = sessionModule.pluginRecordOf(event)
        if (record?.type === PIN_RECORD_TYPE) {
          events.push({ type: PIN_RECORD_TYPE, seq: Number(record.seq), data: record.data })
        } else if (event.type === COMPACTION_EVENT) {
          events.push({ type: COMPACTION_EVENT, seq: Number(event.seq), data: event.data })
        }
      }
      return events
    },
    endSeq(sessionId: string): number | undefined {
      return live(sessionId)?.seq
    },
    floorSeq(sessionId: string): number {
      return live(sessionId)?.inheritedEventCount ?? 0
    },
    append(sessionId: string, data: { keyId: string }): number {
      const session = live(sessionId)
      if (session === undefined) throw new Error(`conversation "${sessionId}" has no live session`)
      return Number(sessionModule.appendPluginRecord(session, PIN_RECORD_TYPE, data))
    },
  }
}

/**
 * Live ancestry of one session, nearest first.
 *
 * A conversation's key travels down the parent chain, so a subagent or a fork
 * starts on the account its parent uses. Only live ancestors are followed: a
 * resumed session whose parent is gone stands alone, exactly as the harness
 * resolves lineage for the cache header.
 */
function lineageOf(ctx: PluginContext): (sessionId: string) => Promise<readonly string[]> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  return async (sessionId: string) => {
    const chain: string[] = [sessionId]
    if (sessions === undefined) return chain
    let current = sessions.get(sessionId)
    const seen = new Set<string>([sessionId])
    while (current !== undefined) {
      const parent = current.header?.parentSession
      if (parent === undefined || seen.has(parent)) break
      const live = sessions.get(parent)
      if (live === undefined) break
      seen.add(parent)
      chain.push(parent)
      current = live
    }
    return chain
  }
}

/** One pi-ai adapter per account, all sharing the same catalog. */
function buildAdapters(
  keys: readonly KeyConfig[],
  configuredMaxTokens: ReadonlyMap<string, number>,
  PiAiAdapter: PiAiPluginModule['PiAiAdapter'],
  provider: { readonly name?: string },
  llm: LlmModule,
  ctx: PluginContext,
): Map<string, InnerAdapter> {
  const profile = {
    provider: ROUTE,
    displayName: provider.name ?? 'OpenCode Go',
    ...PROFILE_DEFAULTS,
    retryPolicy: RETRY_POLICY,
    configuredMaxTokens,
    modelErrors: new Map<string, string>(),
    piProvider: provider,
  }

  const adapters = new Map<string, InnerAdapter>()
  for (const key of keys) {
    const profiles = new Map<string, unknown>([[ROUTE, profile]])
    adapters.set(
      key.id,
      new PiAiAdapter({
        profiles: () => profiles,
        // Credential per account: the only thing that differs between these
        // adapters is which stored secret they hand pi-ai.
        resolveApiKey: () => resolveSecret(ctx, key.apiKeyEnv),
        // Image input needs the durable attachment service, as in `llm-pi-ai`.
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) =>
          llm.resolveImageAttachmentAccess(
            attachments,
            (hostPath) => (ctx.get('fs') as FsLike | undefined)?.processPathFromHostPath(hostPath),
            ref,
          ),
        // Unused while every call carries an explicit key, but required by the
        // adapter contract.
        auth: {
          credentials: {
            read: async () => undefined,
            list: async () => [],
            modify: async () => undefined,
            delete: async () => {},
          },
          authContext: { env: async () => undefined, fileExists: async () => false },
        },
      }),
    )
  }
  return adapters
}

/**
 * Which session a dispatch belongs to.
 *
 * The raw session id, deliberately: pins are per session, while
 * `sessionAffinity` stays the harness's business of routing the provider-side
 * cache bucket.
 */
function conversationOf(options: AdapterCall): string {
  if (typeof options.sessionId === 'string') return options.sessionId
  if (typeof options.sessionAffinity === 'string') return options.sessionAffinity
  return 'unattributed'
}

/**
 * Register the adapter, retrying while `llm-pi-ai` still owns the route.
 *
 * @returns a disposer for the retry listener, when one was installed.
 */
function registerRoute(ctx: PluginContext, adapter: PoolAdapter): (() => void) | undefined {
  const logger = loggerOf(ctx)

  const attempt = (): boolean => {
    try {
      ctx.llm.registerAdapter([ROUTE], adapter)
      logger.info('opencode-go-pool: route "%s" is served by the pool', ROUTE)
      return true
    } catch (error) {
      if (errorCode(error) !== 'DUPLICATE_ADAPTER') throw error
      return false
    }
  }

  if (attempt()) return undefined

  logger.warn(
    'opencode-go-pool: route "%s" is still owned by llm-pi-ai; remove it from that provider list and the pool takes over',
    ROUTE,
  )

  const off = ctx.on('llm/adapters-updated', () => {
    try {
      if (attempt()) off()
    } catch (error) {
      logger.error('opencode-go-pool: route registration failed: %o', error)
    }
  })
  return off
}

/**
 * Mount the pool.
 *
 * @param ctx - the Cordis context, with `llm` present.
 * @param raw - plugin configuration; validated before anything is started.
 */
export function apply(ctx: PluginContext, raw: unknown): void {
  const config: ResolvedPoolConfig = resolveConfig(raw)
  const logger = loggerOf(ctx)

  void (async () => {
    const [{ PiAiAdapter }, { opencodeGoProvider }, llm] = await Promise.all([
      import(PI_AI_PLUGIN) as Promise<PiAiPluginModule>,
      import(PI_AI_PROVIDER) as Promise<ProviderModule>,
      import(LLM_MODULE) as Promise<LlmModule>,
    ])

    // Declared ahead of the pool so the pool can wait for the first readings,
    // while the poller itself needs the pool to record them.
    let poller: UsagePoller | undefined

    const pool = new KeyPool({
      keys: config.keys,
      policy: config.policy,
      thresholdPercent: config.thresholdPercent,
      pins: new SessionPinStore(await scanPort(ctx), {
        repinOnCompaction: config.repinOnCompaction,
        onError: (detail) =>
          logger.warn('opencode-go-pool: pin %s failed: %o', detail.operation, detail.error),
      }),
      lineageOf: lineageOf(ctx),
      // A process that has just booted has no readings yet; choosing then means
      // choosing by configuration order, which may be the nearly spent account.
      ready: () => poller?.whenSettled() ?? Promise.resolve(),
    })

    const provider = opencodeGoProvider()
    const adapters = buildAdapters(
      config.keys,
      config.maxTokensByModel,
      PiAiAdapter,
      provider,
      llm,
      ctx,
    )
    const catalog = adapters.get(config.keys[0]!.id)!
    const adapter = new PoolAdapter(
      {
        pool,
        adapters,
        catalog,
        conversationOf,
        onError: ({ keyId, error }) =>
          logger.warn('opencode-go-pool: key "%s" refused a request: %o', keyId, error),
      },
      [ROUTE],
    )

    /** Keys already reported as missing a credential, so the log stays readable. */
    const unpollable = new Set<string>()

    poller = new UsagePoller({
      baseUrl: config.baseUrl,
      intervalMs: config.pollIntervalMs,
      // One account without a stored secret must not stop the others from
      // being observed: the whole point of the pool is to keep serving.
      targets: async () => {
        const targets: PollTarget[] = []
        for (const key of config.keys) {
          try {
            const apiKey = await resolveSecret(ctx, key.apiKeyEnv)
            targets.push({
              keyId: key.id,
              apiKey,
              ...(key.orgId === undefined ? {} : { orgId: key.orgId }),
            })
            unpollable.delete(key.id)
          } catch (error) {
            if (!unpollable.has(key.id)) {
              unpollable.add(key.id)
              logger.warn(
                'opencode-go-pool: key "%s" has no usable credential (%s); polling serves the other accounts',
                key.id,
                error instanceof Error ? error.message : String(error),
              )
            }
          }
        }
        return targets
      },
      onError: (error) => logger.warn('opencode-go-pool: usage sweep failed: %o', error),
      onOutcome: (outcome) => {
        if (outcome.ok) {
          pool.observe(outcome.keyId, outcome.usage, outcome.at)
          return
        }
        // A key the gateway refuses cannot serve, so it leaves the rotation
        // until the credential changes: polling it again keeps it blocked.
        if (outcome.code === 'unauthorized') pool.block(outcome.keyId, 'unauthorized')
        logger.warn(
          'opencode-go-pool: usage poll for key "%s" failed (%s): %s',
          outcome.keyId,
          outcome.code,
          outcome.message,
        )
      },
    })
    // Registered last: the route must not take traffic before there is a poller
    // to wait for, or the first request would still choose without readings.
    const offRegistration = registerRoute(ctx, adapter)
    poller.start()

    ctx.on('dispose', () => {
      poller?.stop()
      offRegistration?.()
    })
  })().catch((error) => {
    logger.error('opencode-go-pool: failed to start: %o', error)
  })
}

/** Reason a key may be blocked for, re-exported for diagnostics consumers. */
export type { KeyUnusableReason }
