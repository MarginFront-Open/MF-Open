/**
 * WHAT THIS FILE DOES: locks down the pure decision logic of the period lock
 *Three small functions decide whether a period can be
 * closed and whether a stored snapshot is usable — get any of them wrong and
 * either a posted close silently un-freezes, or the current (unfinished) month
 * gets "closed" against a window that keeps moving. All three are pure, so we
 * test them directly with no DB.
 *
 * CONNECTS TO: app/actions/_shared/period-lock-store.ts.
 */

// The store imports the Prisma client at module load; stub it so importing the
// pure helpers stays hermetic (these helpers never touch the DB).
jest.mock('@/app/lib/db', () => ({ db: {} }))

import {
  isPeriodClosable,
  windowsMatch,
  parseSnapshot,
  PERIOD_SNAPSHOT_VERSION,
} from '../_shared/period-lock-store'

// 2026-06-16T12:00:00Z — a fixed "now" so the tests don't depend on a clock.
const NOW = Date.parse('2026-06-16T12:00:00.000Z')

describe('isPeriodClosable', () => {
  it('allows closing a period that has fully ended', () => {
    // May 2026 ended weeks before NOW.
    expect(isPeriodClosable('2026-05-31', NOW)).toBe(true)
  })

  it('refuses the current / in-progress month', () => {
    // June 2026 has not ended yet at NOW.
    expect(isPeriodClosable('2026-06-30', NOW)).toBe(false)
  })

  it('refuses a future month', () => {
    expect(isPeriodClosable('2026-12-31', NOW)).toBe(false)
  })

  it('refuses an unparseable date instead of throwing', () => {
    expect(isPeriodClosable('not-a-date', NOW)).toBe(false)
  })
})

describe('windowsMatch', () => {
  const start = new Date('2026-05-01T00:00:00.000Z')
  const end = new Date('2026-05-31T23:59:59.999Z')

  it('matches identical window bounds', () => {
    expect(windowsMatch(start, end, new Date(start), new Date(end))).toBe(true)
  })

  it('rejects a window off by even one millisecond', () => {
    const endPlus1ms = new Date(end.getTime() + 1)
    expect(windowsMatch(start, end, new Date(start), endPlus1ms)).toBe(false)
  })
})

describe('parseSnapshot', () => {
  const validSnapshot = {
    version: PERIOD_SNAPSHOT_VERSION,
    journal: { totalAmount: 12.01 },
    audit: { glLines: [] },
    breakdown: { totalCost: 12.01 },
    score: { scorePercent: 90 },
    // Product-line margins freeze too, so a usable snapshot must carry this
    // payload — parseSnapshot rejects one without it.
    productLineMargins: { totalRevenue: 1000, rows: [] },
  }

  it('round-trips a well-formed snapshot at the current version', () => {
    const json = JSON.parse(JSON.stringify(validSnapshot))
    const parsed = parseSnapshot(json, PERIOD_SNAPSHOT_VERSION)
    expect(parsed).not.toBeNull()
    // snapshot payloads are typed `unknown` by the store (cycle-break); narrow
    // for the assertion the same way the read-path guards cast at their return.
    expect((parsed?.journal as { totalAmount: number }).totalAmount).toBe(12.01)
  })

  it('rejects a stored version that no longer matches (safe-degrade to live)', () => {
    expect(parseSnapshot(validSnapshot, PERIOD_SNAPSHOT_VERSION + 1)).toBeNull()
  })

  it('rejects a snapshot missing any of the five frozen payloads', () => {
    const { score: _omitScore, ...missingScore } = validSnapshot
    expect(parseSnapshot(missingScore, PERIOD_SNAPSHOT_VERSION)).toBeNull()
    // Product-line margins is a required payload too.
    const { productLineMargins: _omitMargins, ...missingMargins } = validSnapshot
    expect(parseSnapshot(missingMargins, PERIOD_SNAPSHOT_VERSION)).toBeNull()
  })

  it('rejects a non-object blob', () => {
    expect(parseSnapshot(null, PERIOD_SNAPSHOT_VERSION)).toBeNull()
    expect(parseSnapshot('garbage', PERIOD_SNAPSHOT_VERSION)).toBeNull()
  })
})
