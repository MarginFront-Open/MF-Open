import {
  clientIpFromHeaders,
  consumeThrottle,
  resetThrottleSweepForTests,
  throttleKey,
  type ThrottleStore,
} from '../app-throttle'

interface Row {
  key: string
  count: number
  windowStart: Date
  lastEventAt: Date
}

beforeEach(() => resetThrottleSweepForTests())

/** In-memory stand-in for the app_throttle table that honours the same filters. */
function fakeStore(): ThrottleStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  return {
    rows,
    app_throttle: {
      async updateMany({ where, data }) {
        const w = where as {
          key: string
          windowStart?: { gt?: Date; lte?: Date }
          count?: { lt: number }
        }
        const row = rows.get(w.key)
        if (!row) return { count: 0 }
        if (w.windowStart?.gt && !(row.windowStart > w.windowStart.gt)) {
          return { count: 0 }
        }
        if (w.windowStart?.lte && !(row.windowStart <= w.windowStart.lte)) {
          return { count: 0 }
        }
        if (w.count && !(row.count < w.count.lt)) return { count: 0 }
        const d = data as {
          count: number | { increment: number }
          windowStart?: Date
          lastEventAt: Date
        }
        row.count =
          typeof d.count === 'number' ? d.count : row.count + d.count.increment
        if (d.windowStart) row.windowStart = d.windowStart
        row.lastEventAt = d.lastEventAt
        return { count: 1 }
      },
      async create({ data }) {
        const d = data as unknown as Row
        if (rows.has(d.key)) {
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          })
        }
        rows.set(d.key, {
          key: d.key,
          count: d.count,
          windowStart: d.windowStart,
          lastEventAt: d.lastEventAt,
        })
      },
      async deleteMany({ where }) {
        const cutoff = (where as { lastEventAt: { lt: Date } }).lastEventAt.lt
        for (const [key, row] of rows) {
          if (row.lastEventAt < cutoff) rows.delete(key)
        }
      },
    },
  }
}

const LIMIT = { max: 3, windowMs: 60_000 }

describe('consumeThrottle', () => {
  it('allows requests up to the limit and turns away the next one', async () => {
    const store = fakeStore()
    const now = new Date('2026-01-01T00:00:00Z')
    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await consumeThrottle(store, 'k', LIMIT, now))
    }
    expect(results).toEqual([true, true, true, false, false])
    expect(store.rows.get('k')?.count).toBe(3)
  })

  it('starts a fresh window once the old one has passed', async () => {
    const store = fakeStore()
    const start = new Date('2026-01-01T00:00:00Z')
    for (let i = 0; i < 4; i++) await consumeThrottle(store, 'k', LIMIT, start)

    const later = new Date(start.getTime() + LIMIT.windowMs + 1)
    expect(await consumeThrottle(store, 'k', LIMIT, later)).toBe(true)
    expect(store.rows.get('k')?.count).toBe(1)
  })

  it('counts each key separately', async () => {
    const store = fakeStore()
    const now = new Date()
    for (let i = 0; i < 3; i++) await consumeThrottle(store, 'a', LIMIT, now)
    expect(await consumeThrottle(store, 'a', LIMIT, now)).toBe(false)
    expect(await consumeThrottle(store, 'b', LIMIT, now)).toBe(true)
  })

  it('rethrows a database failure instead of letting the request through', async () => {
    const store: ThrottleStore = {
      app_throttle: {
        updateMany: async () => ({ count: 0 }),
        create: async () => {
          throw new Error('connection refused')
        },
        deleteMany: async () => undefined,
      },
    }
    await expect(consumeThrottle(store, 'k', LIMIT)).rejects.toThrow(
      'connection refused'
    )
  })
})

describe('stale rows', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('removes rows untouched for more than a day when a new key arrives, and keeps recent ones', async () => {
    const store = fakeStore()
    const start = new Date('2026-01-01T00:00:00Z')
    await consumeThrottle(store, 'old', LIMIT, start)
    resetThrottleSweepForTests()
    const recent = new Date(start.getTime() + DAY_MS)
    await consumeThrottle(store, 'recent', LIMIT, recent)
    resetThrottleSweepForTests()

    const now = new Date(start.getTime() + DAY_MS + 60_000)
    await consumeThrottle(store, 'new', LIMIT, now)

    expect([...store.rows.keys()].sort()).toEqual(['new', 'recent'])
  })

  it('sweeps at most once an hour, so a flood of made-up keys does not add a delete to every request', async () => {
    const store = fakeStore()
    const deleteMany = jest.spyOn(store.app_throttle, 'deleteMany')
    const start = new Date('2026-01-01T00:00:00Z')
    for (let i = 0; i < 50; i++) {
      await consumeThrottle(store, `made-up-${i}`, LIMIT, start)
    }
    expect(deleteMany).toHaveBeenCalledTimes(1)

    const anHourLater = new Date(start.getTime() + 60 * 60 * 1000)
    await consumeThrottle(store, 'later', LIMIT, anHourLater)
    expect(deleteMany).toHaveBeenCalledTimes(2)
  })

  it('a failed sweep never turns the request away', async () => {
    const store = fakeStore()
    store.app_throttle.deleteMany = async () => {
      throw new Error('connection refused')
    }
    expect(await consumeThrottle(store, 'k', LIMIT)).toBe(true)
  })
})

describe('throttleKey', () => {
  it('never contains the value it was built from', () => {
    const key = throttleKey('portal-magic-link:email', 'person@example.com')
    expect(key).not.toContain('person')
    expect(key).not.toContain('example.com')
    expect(key.length).toBeLessThanOrEqual(255)
  })

  it('is stable for the same value and different for another', () => {
    expect(throttleKey('s', 'a')).toBe(throttleKey('s', 'a'))
    expect(throttleKey('s', 'a')).not.toBe(throttleKey('s', 'b'))
  })
})

describe('clientIpFromHeaders', () => {
  it('uses the first forwarded address, then x-real-ip, then "unknown"', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))
    ).toBe('1.1.1.1')
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '3.3.3.3' }))).toBe(
      '3.3.3.3'
    )
    expect(clientIpFromHeaders(new Headers())).toBe('unknown')
  })
})
