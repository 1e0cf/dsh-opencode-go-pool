import { describe, expect, it } from 'bun:test'

import { ConfigError, resolveConfig, ROUTE } from '../src/config.ts'
import { DEFAULT_THRESHOLD_PERCENT } from '../src/policy.ts'

const KEYS = [
  { id: 'primary', apiKeyEnv: 'OPENCODE_API_KEY' },
  { id: 'secondary', apiKeyEnv: 'OPENCODE_API_KEY_2' },
]

describe('resolveConfig', () => {
  it('defaults everything that has a safe default', () => {
    const config = resolveConfig({ keys: KEYS })

    expect(config.policy).toBe('sticky')
    expect(config.thresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT)
    expect(config.baseUrl).toBe('https://opencode.ai/zen/go/v1')
    expect(config.pollIntervalMs).toBe(60_000)
    expect(config.keys.map((key) => key.id)).toEqual(['primary', 'secondary'])
  })

  it('keeps an organisation id when one is configured', () => {
    const config = resolveConfig({ keys: [{ id: 'a', apiKeyEnv: 'K', orgId: 'org_1' }] })

    expect(config.keys[0]?.orgId).toBe('org_1')
  })

  it('accepts every policy', () => {
    for (const policy of ['sticky', 'threshold', 'round-robin'] as const) {
      expect(resolveConfig({ keys: KEYS, policy }).policy).toBe(policy)
    }
  })

  it('names the route the plugin takes over', () => {
    expect(ROUTE).toBe('opencode-go')
  })

  it('rejects an empty account list', () => {
    expect(() => resolveConfig({ keys: [] })).toThrow(ConfigError)
    expect(() => resolveConfig({})).toThrow(ConfigError)
    expect(() => resolveConfig(undefined)).toThrow(ConfigError)
  })

  it('rejects duplicated account ids', () => {
    expect(() =>
      resolveConfig({
        keys: [
          { id: 'a', apiKeyEnv: 'K1' },
          { id: 'a', apiKeyEnv: 'K2' },
        ],
      }),
    ).toThrow(/duplicate/)
  })

  it('rejects an id that cannot appear in a pin', () => {
    expect(() => resolveConfig({ keys: [{ id: 'Primary Key', apiKeyEnv: 'K' }] })).toThrow(/id/)
    expect(() => resolveConfig({ keys: [{ id: '-lead', apiKeyEnv: 'K' }] })).toThrow(/id/)
  })

  it('requires a credential reference per account', () => {
    expect(() => resolveConfig({ keys: [{ id: 'a' }] })).toThrow(/apiKeyEnv/)
    expect(() => resolveConfig({ keys: [{ id: 'a', apiKeyEnv: '  ' }] })).toThrow(/apiKeyEnv/)
  })

  it('rejects an unknown policy instead of falling back', () => {
    expect(() => resolveConfig({ keys: KEYS, policy: 'random' })).toThrow(/policy/)
  })

  it('rejects a threshold outside 0..100', () => {
    expect(() => resolveConfig({ keys: KEYS, thresholdPercent: 0 })).toThrow(/thresholdPercent/)
    expect(() => resolveConfig({ keys: KEYS, thresholdPercent: 140 })).toThrow(/thresholdPercent/)
  })

  it('rejects a non-http endpoint and a poll interval that would hammer it', () => {
    expect(() => resolveConfig({ keys: KEYS, baseUrl: 'ftp://example.test' })).toThrow(/baseUrl/)
    expect(() => resolveConfig({ keys: KEYS, baseUrl: 'nope' })).toThrow(/baseUrl/)
    expect(() => resolveConfig({ keys: KEYS, pollIntervalMs: 1_000 })).toThrow(/pollIntervalMs/)
  })
})
