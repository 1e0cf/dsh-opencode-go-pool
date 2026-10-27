import { describe, expect, it } from 'bun:test'

import { pinOf, SessionPinStore, type SessionPinPort } from '../src/pins.ts'

/** In-memory stand-in for the session log. */
function logPort(seed: Record<string, unknown> = {}): SessionPinPort & { appends: string[] } {
  const records = new Map<string, unknown[]>(
    Object.entries(seed).map(([key, value]) => [key, [value]]),
  )
  const appends: string[] = []
  return {
    appends,
    read: (affinity: string) => records.get(affinity)?.at(-1),
    append: (affinity: string, data: { keyId: string }) => {
      appends.push(`${affinity}=${data.keyId}`)
      const existing = records.get(affinity) ?? []
      existing.push(data)
      records.set(affinity, existing)
    },
  }
}

describe('pinOf', () => {
  it('accepts only a non-empty string key id', () => {
    expect(pinOf({ keyId: 'primary' })).toBe('primary')
    expect(pinOf({ keyId: '' })).toBeUndefined()
    expect(pinOf({ keyId: 42 })).toBeUndefined()
    expect(pinOf(null)).toBeUndefined()
    expect(pinOf('primary')).toBeUndefined()
  })
})

describe('SessionPinStore', () => {
  it('reads a pin the log already holds', async () => {
    const store = new SessionPinStore(logPort({ root: { keyId: 'secondary' } }))

    expect(await store.get('root')).toBe('secondary')
    expect(await store.get('other')).toBeUndefined()
  })

  it('writes a pin the next read sees', async () => {
    const port = logPort()
    const store = new SessionPinStore(port)

    await store.set('root', 'primary')

    expect(port.appends).toEqual(['root=primary'])
    expect(await store.get('root')).toBe('primary')
  })

  it('survives a log that refuses to read, reporting it', async () => {
    const reported: string[] = []
    const store = new SessionPinStore(
      {
        read: () => {
          throw new Error('log closed')
        },
        append: () => {},
      },
      { onError: (detail) => reported.push(detail.operation) },
    )

    expect(await store.get('root')).toBeUndefined()
    expect(reported).toEqual(['read'])
  })

  it('survives a log that refuses to write, reporting it', async () => {
    const reported: string[] = []
    const store = new SessionPinStore(
      {
        read: () => undefined,
        append: () => {
          throw new Error('read only')
        },
      },
      { onError: (detail) => reported.push(detail.operation) },
    )

    await expect(store.set('root', 'primary')).resolves.toBeUndefined()
    expect(reported).toEqual(['write'])
  })
})
