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
import { SessionPinStore, PIN_RECORD, type SessionPinPort } from './pins.ts'
import { UsagePoller } from './poller.ts'
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

/** Record type this plugin owns inside the session log. */
const PIN_RECORD_TYPE = `plugin:${name}/${PIN_RECORD}`

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
  readonly ignorable?: boolean
  readonly data?: unknown
}

interface PluginRecordLike {
  readonly type: string
  readonly data: unknown
}

interface SessionLike {
  ownEvents(): readonly SessionEventLike[]
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

/** Build the session-log port pins are stored through. */
async function pinPort(ctx: PluginContext): Promise<SessionPinPort> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  // Imported from the running harness: record helpers are versioned with it,
  // and the specifier is opaque so this package needs no dependency on it.
  const sessionModule = (await import(SESSION_MODULE)) as {
    appendPluginRecord(session: SessionLike, type: string, data: unknown): unknown
    pluginRecordOf(event: SessionEventLike): PluginRecordLike | undefined
  }

  return {
    read(affinity: string): unknown {
      const session = sessions?.get(affinity)
      if (session === undefined) return undefined
      const events = session.ownEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const record = sessionModule.pluginRecordOf(events[index]!)
        if (record?.type === PIN_RECORD_TYPE) return record.data
      }
      return undefined
    },
    append(affinity: string, data: { keyId: string }): void {
      const session = sessions?.get(affinity)
      if (session === undefined) throw new Error(`conversation "${affinity}" has no live session`)
      sessionModule.appendPluginRecord(session, PIN_RECORD_TYPE, data)
    },
  }
}

/** One pi-ai adapter per account, all sharing the same catalog. */
function buildAdapters(
  keys: readonly KeyConfig[],
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
    configuredMaxTokens: new Map<string, number>(),
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

/** Which conversation a dispatch belongs to. */
function affinityOf(options: AdapterCall): string {
  if (typeof options.sessionAffinity === 'string') return options.sessionAffinity
  if (typeof options.sessionId === 'string') return options.sessionId
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

    const pool = new KeyPool({
      keys: config.keys,
      policy: config.policy,
      thresholdPercent: config.thresholdPercent,
      pins: new SessionPinStore(await pinPort(ctx), {
        onError: (detail) =>
          logger.warn('opencode-go-pool: pin %s failed: %o', detail.operation, detail.error),
      }),
    })

    const provider = opencodeGoProvider()
    const adapters = buildAdapters(config.keys, PiAiAdapter, provider, llm, ctx)
    const catalog = adapters.get(config.keys[0]!.id)!
    const adapter = new PoolAdapter(
      {
        pool,
        adapters,
        catalog,
        affinityOf,
        onError: ({ keyId, error }) =>
          logger.warn('opencode-go-pool: key "%s" refused a request: %o', keyId, error),
      },
      [ROUTE],
    )

    const offRegistration = registerRoute(ctx, adapter)

    const poller = new UsagePoller({
      baseUrl: config.baseUrl,
      intervalMs: config.pollIntervalMs,
      targets: async () =>
        Promise.all(
          config.keys.map(async (key) => {
            const apiKey = await resolveSecret(ctx, key.apiKeyEnv)
            return {
              keyId: key.id,
              apiKey,
              ...(key.orgId === undefined ? {} : { orgId: key.orgId }),
            }
          }),
        ),
      onOutcome: (outcome) => {
        if (outcome.ok) {
          pool.observe(outcome.keyId, outcome.usage, outcome.at)
          return
        }
        // A rejected key is a configuration problem, not a quota one: it is
        // reported and left alone, so the request path keeps showing the truth.
        logger.warn(
          'opencode-go-pool: usage poll for key "%s" failed (%s): %s',
          outcome.keyId,
          outcome.code,
          outcome.message,
        )
      },
    })
    poller.start()

    ctx.on('dispose', () => {
      poller.stop()
      offRegistration?.()
    })
  })().catch((error) => {
    logger.error('opencode-go-pool: failed to start: %o', error)
  })
}

/** Reason a key may be blocked for, re-exported for diagnostics consumers. */
export type { KeyUnusableReason }
