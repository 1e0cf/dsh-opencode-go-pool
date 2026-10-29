import { describe, expect, it } from 'bun:test'

import {
  COMPACTION_EVENT,
  foldPinFacts,
  PIN_RECORD_TYPE,
  pinOf,
  EMPTY_FACTS,
  SessionPinStore,
  type LogEvent,
  type SessionScanPort,
} from '../src/pins.ts'

/** A session log that records what the store asked for. */
function logPort(seed: LogEvent[] = []) {
  const events = [...seed]
  const reads: Array<[number, number]> = []
  const port: SessionScanPort & { events: LogEvent[]; reads: Array<[number, number]> } = {
    events,
    reads,
    read: (_sessionId: string, fromSeq: number, toSeqExclusive: number) => {
      reads.push([fromSeq, toSeqExclusive])
      return events.filter((event) => event.seq >= fromSeq && event.seq < toSeqExclusive)
    },
    endSeq: () => events.length,
    floorSeq: () => 0,
    append: (_sessionId: string, data: { keyId: string }) => {
      const seq = events.length
      events.push({ type: PIN_RECORD_TYPE, seq, data })
      return seq
    },
  }
  return port
}

function pinEvent(seq: number, keyId: string): LogEvent {
  return { type: PIN_RECORD_TYPE, seq, data: { keyId } }
}

function compactionEvent(seq: number): LogEvent {
  return { type: COMPACTION_EVENT, seq, data: {} }
}

describe('pinOf', () => {
  it('accepts only a non-empty string key id', () => {
    expect(pinOf({ keyId: 'primary' })).toBe('primary')
    expect(pinOf({ keyId: '' })).toBeUndefined()
    expect(pinOf({ keyId: 42 })).toBeUndefined()
    expect(pinOf(null)).toBeUndefined()
  })
})

describe('foldPinFacts', () => {
  it('lets the last of the two records decide', () => {
    const pinned = foldPinFacts(EMPTY_FACTS, [pinEvent(1, 'a')])
    expect(pinned.pinKey).toBe('a')
    expect(pinned.stale).toBe(false)

    const repaired = foldPinFacts(pinned, [compactionEvent(2)])
    expect(repaired.pinKey).toBe('a')
    expect(repaired.stale).toBe(true)

    const again = foldPinFacts(repaired, [pinEvent(3, 'b')])
    expect(again.pinKey).toBe('b')
    expect(again.stale).toBe(false)
  })

  it('can be told to ignore compaction', () => {
    const facts = foldPinFacts(EMPTY_FACTS, [compactionEvent(1), pinEvent(2, 'a')], false)
    expect(facts.pinKey).toBe('a')
    expect(facts.stale).toBe(false)
  })
})

describe('SessionPinStore', () => {
  it('finds a pin that still applies', async () => {
    const store = new SessionPinStore(logPort([pinEvent(0, 'primary')]))
    expect(await store.get('s')).toBe('primary')
  })

  it('ignores a pin written before the last compaction', async () => {
    const store = new SessionPinStore(logPort([pinEvent(0, 'primary'), compactionEvent(1)]))
    expect(await store.get('s')).toBeUndefined()
  })

  it('honours a pin written after a compaction', async () => {
    const store = new SessionPinStore(logPort([compactionEvent(0), pinEvent(1, 'secondary')]))
    expect(await store.get('s')).toBe('secondary')
  })

  it('keeps a pin across a compaction when re-pinning is disabled', async () => {
    const store = new SessionPinStore(logPort([pinEvent(0, 'primary'), compactionEvent(1)]), {
      repinOnCompaction: false,
    })
    expect(await store.get('s')).toBe('primary')
  })

  it('reads a session without a pin as unpinned', async () => {
    const store = new SessionPinStore(logPort([{ type: 'user/message', seq: 0 }]))
    expect(await store.get('s')).toBeUndefined()
  })

  it('reads only what was appended after the previous look', async () => {
    const port = logPort([pinEvent(0, 'primary')])
    const store = new SessionPinStore(port)

    expect(await store.get('s')).toBe('primary')
    expect(port.reads).toEqual([[0, 1]])

    port.events.push(compactionEvent(1))
    expect(await store.get('s')).toBeUndefined()
    expect(port.reads).toEqual([
      [0, 1],
      [1, 2],
    ])

    await store.set('s', 'secondary')
    expect(await store.get('s')).toBe('secondary')
    expect(port.reads).toHaveLength(2)
  })

  it('writes a pin that the next read sees without touching the log reader', async () => {
    const port = logPort()
    const store = new SessionPinStore(port)

    await store.set('s', 'primary')

    expect(port.events.map((event) => event.type)).toEqual([PIN_RECORD_TYPE])
    expect(await store.get('s')).toBe('primary')
    // The write already told the store what the log now says, so no read.
    expect(port.reads).toHaveLength(0)
  })

  it('survives a log that refuses to read or write, and reports it', async () => {
    const reported: string[] = []
    const broken: SessionScanPort = {
      read: () => {
        throw new Error('closed')
      },
      endSeq: () => 1,
      floorSeq: () => 0,
      append: () => {
        throw new Error('read only')
      },
    }
    const store = new SessionPinStore(broken, {
      onError: (detail) => reported.push(detail.operation),
    })

    expect(await store.get('s')).toBeUndefined()
    await expect(store.set('s', 'primary')).resolves.toBeUndefined()
    expect(reported).toEqual(['read', 'write'])
  })
})
