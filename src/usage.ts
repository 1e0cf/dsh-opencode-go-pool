/**
 * The usage endpoint: one GET per key, and a parser that survives the endpoint
 * being undocumented.
 *
 * The response shape is community-verified rather than contractual, so a drifted
 * payload degrades window by window instead of failing the whole poll. Only the
 * envelope is strict: without a `usage` object there is nothing to read, and
 * silently reporting "no limits" would make the pool route onto a spent account.
 *
 * @module dsh-opencode-go-pool/usage
 */

import type { MeterName, MeterReading, UsageReading } from './policy.ts'

/** OpenCode Go gateway root; the usage resource hangs off it. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** How long one usage poll may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Stable failure classification, so callers can act without matching text. */
export type UsageErrorCode = 'unauthorized' | 'http' | 'unreachable' | 'shape'

/** A usage poll that produced no reading. */
export class UsageError extends Error {
  readonly code: UsageErrorCode
  /** HTTP status when one was received. */
  readonly status: number | undefined

  constructor(code: UsageErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.status = status
  }
}

/** Everything one poll needs; `fetch` is injectable for tests. */
export interface UsageRequest {
  readonly apiKey: string
  /** Gateway root, {@link DEFAULT_BASE_URL} by default. */
  readonly baseUrl?: string
  /** Organisation id the reference client sends alongside the key. */
  readonly orgId?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number, a numeric string, or `null`; the payload is untyped. */
function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** One window, or `null` when it is absent or unusable. */
function parseMeter(value: unknown): MeterReading | null {
  if (!isRecord(value)) return null
  return {
    status: typeof value.status === 'string' ? value.status : null,
    percent: numberOf(value.percent),
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
  }
}

/**
 * Read a usage payload into the three accounted windows.
 *
 * @param payload - decoded JSON body, any shape.
 * @returns one reading per window; omitted windows stay `null`.
 * @throws {UsageError} `shape` when the envelope carries no `usage` object.
 */
export function parseUsage(payload: unknown): UsageReading {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new UsageError('shape', 'usage payload has no usage object')
  }

  const usage = payload.usage
  const meters: MeterName[] = ['rolling', 'weekly', 'monthly']
  const reading: Record<MeterName, MeterReading | null> = {
    rolling: null,
    weekly: null,
    monthly: null,
  }
  for (const meter of meters) reading[meter] = parseMeter(usage[meter])
  return reading
}

/** `baseUrl` without a trailing slash, so path joining cannot double it. */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Poll the usage endpoint for one key once.
 *
 * @param request - key, endpoint, and transport knobs.
 * @returns the decoded reading.
 * @throws {UsageError} classified failure; never a partial reading.
 */
export async function fetchUsage(request: UsageRequest): Promise<UsageReading> {
  const url = `${trimBase(request.baseUrl ?? DEFAULT_BASE_URL)}/usage`
  const doFetch = request.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout

  const headers: Record<string, string> = {
    authorization: `Bearer ${request.apiKey}`,
    accept: 'application/json',
  }
  if (request.orgId !== undefined && request.orgId !== '') {
    headers['x-opencode-org-id'] = request.orgId
  }

  let response: Response
  try {
    response = await doFetch(url, { method: 'GET', headers, signal })
  } catch (cause) {
    throw new UsageError('unreachable', `usage request failed: ${String(cause)}`)
  }

  if (!response.ok) {
    const status = response.status
    const code: UsageErrorCode = status === 401 || status === 403 ? 'unauthorized' : 'http'
    throw new UsageError(code, `usage request returned ${status}`, status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new UsageError('shape', `usage response is not JSON: ${String(cause)}`)
  }

  return parseUsage(payload)
}
