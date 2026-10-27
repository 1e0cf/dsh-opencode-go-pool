/**
 * Plugin configuration: what the operator writes, validated once at mount.
 *
 * Everything here is plain data. The plugin refuses to start on a config it
 * cannot serve rather than failing on the first request, because a pool that
 * comes up half-configured looks healthy until a quota runs out — exactly when
 * the fallback is supposed to work.
 *
 * @module dsh-opencode-go-pool/config
 */

import { DEFAULT_THRESHOLD_PERCENT, type PolicyName } from './policy.ts'
import { DEFAULT_BASE_URL } from './usage.ts'
import { DEFAULT_INTERVAL_MS } from './poller.ts'

/** The route this plugin takes over; it must match the pi-ai provider id. */
export const ROUTE = 'opencode-go'

/** One account in the pool. */
export interface KeyConfig {
  /** Stable id used in pins and logs; never the key material. */
  readonly id: string
  /** Credential reference resolved through the harness credential seam. */
  readonly apiKeyEnv: string
  /** Organisation id the reference client sends alongside the key. */
  readonly orgId?: string
}

/** Raw configuration as written in the harness profile. */
export interface PoolConfig {
  /** Accounts, in preference order for the sticky policy. */
  readonly keys: readonly KeyConfig[]
  /** Strategy for conversations without a pin; `sticky` by default. */
  readonly policy?: PolicyName
  /** Consumed share above which an unpinned conversation avoids a key. */
  readonly thresholdPercent?: number
  /** Usage endpoint root. */
  readonly baseUrl?: string
  /** Background poll interval in milliseconds. */
  readonly pollIntervalMs?: number
}

/** Configuration with defaults applied. */
export interface ResolvedPoolConfig {
  readonly keys: readonly KeyConfig[]
  readonly policy: PolicyName
  readonly thresholdPercent: number
  readonly baseUrl: string
  readonly pollIntervalMs: number
}

/** A configuration problem, with a path naming the offending field. */
export class ConfigError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ConfigError'
    this.path = path
  }
}

const POLICIES: readonly PolicyName[] = ['sticky', 'threshold', 'round-robin']

/** Ids appear in pins and log lines, so they stay short and boring. */
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigError(path, 'must be an object')
  return value
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path}.${field}`, 'must be a non-empty string')
  }
  return value
}

function parseKey(value: unknown, index: number): KeyConfig {
  const path = `keys[${index}]`
  const record = requireRecord(value, path)

  const id = optionalString(record, 'id', path)
  if (id === undefined) throw new ConfigError(`${path}.id`, 'is required')
  if (!KEY_ID.test(id)) {
    throw new ConfigError(
      `${path}.id`,
      'must match [a-z0-9][a-z0-9-]* and be at most 32 characters',
    )
  }

  const apiKeyEnv = optionalString(record, 'apiKeyEnv', path)
  if (apiKeyEnv === undefined) throw new ConfigError(`${path}.apiKeyEnv`, 'is required')

  const orgId = optionalString(record, 'orgId', path)
  return { id, apiKeyEnv, ...(orgId === undefined ? {} : { orgId }) }
}

function percentage(record: Record<string, unknown>, fallback: number): number {
  const value = record.thresholdPercent
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new ConfigError('thresholdPercent', 'must be a number greater than 0 and at most 100')
  }
  return value
}

function interval(record: Record<string, unknown>): number {
  const value = record.pollIntervalMs
  if (value === undefined) return DEFAULT_INTERVAL_MS
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5_000) {
    throw new ConfigError('pollIntervalMs', 'must be an integer of at least 5000')
  }
  return value
}

/**
 * Validate and default a plugin configuration.
 *
 * @param raw - configuration as the harness resolved it.
 * @returns configuration with every default applied.
 * @throws {ConfigError} naming the first field that cannot be served.
 */
export function resolveConfig(raw: unknown): ResolvedPoolConfig {
  const record = requireRecord(raw, 'config')

  const rawKeys = record.keys
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    throw new ConfigError('keys', 'must be a non-empty list of accounts')
  }
  const keys = rawKeys.map((entry, index) => parseKey(entry, index))

  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key.id)) throw new ConfigError('keys', `duplicate account id "${key.id}"`)
    seen.add(key.id)
  }

  const policy = record.policy ?? 'sticky'
  if (typeof policy !== 'string' || !POLICIES.includes(policy as PolicyName)) {
    throw new ConfigError('policy', `must be one of ${POLICIES.join(', ')}`)
  }

  const baseUrl = record.baseUrl ?? DEFAULT_BASE_URL
  if (typeof baseUrl !== 'string') throw new ConfigError('baseUrl', 'must be a string')
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw new ConfigError('baseUrl', 'must be an http(s) URL')
  }

  return {
    keys,
    policy: policy as PolicyName,
    thresholdPercent: percentage(record, DEFAULT_THRESHOLD_PERCENT),
    baseUrl,
    pollIntervalMs: interval(record),
  }
}
