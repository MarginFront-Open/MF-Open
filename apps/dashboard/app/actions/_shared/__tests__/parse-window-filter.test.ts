/**
 * Unit tests for the canonical window-filter parser.
 *
 * Every Server Action parses UI date strings through this one helper, so
 * every surface agrees on the same window. `new Date(endDate)` alone gives
 * UTC midnight and cuts off the whole end day; an uncapped UTC end-of-day
 * shows an event on some surfaces and not others.
 *
 * Tests below lock in the canonical semantics.
 */

import { parseWindowFilter } from '../parse-window-filter'

describe('parseWindowFilter', () => {
  it('returns last-30-days window when no filter provided', () => {
    const before = Date.now()
    const { windowStart, windowEnd } = parseWindowFilter(undefined)
    const after = Date.now()

    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before)
    expect(windowEnd.getTime()).toBeLessThanOrEqual(after)

    const expectedStart = before - 30 * 24 * 60 * 60 * 1000
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(expectedStart - 100)
    expect(windowStart.getTime()).toBeLessThanOrEqual(expectedStart + 100)
  })

  it('respects defaultLookbackDays when provided', () => {
    const { windowStart, windowEnd } = parseWindowFilter(undefined, 7)
    const diff = windowEnd.getTime() - windowStart.getTime()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(diff).toBeGreaterThanOrEqual(sevenDays - 100)
    expect(diff).toBeLessThanOrEqual(sevenDays + 100)
  })

  it('parses startDate as start-of-day UTC', () => {
    const { windowStart } = parseWindowFilter({ startDate: '2026-04-01' })
    expect(windowStart.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('parses past endDate as end-of-day UTC (no cap needed)', () => {
    const { windowEnd } = parseWindowFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    })
    expect(windowEnd.toISOString()).toBe('2025-12-31T23:59:59.999Z')
  })

  it('caps endDate at `now` when the parsed end-of-day is in the future', () => {
    // Today's date — the parsed end-of-day will be later in the day
    // than `now`, so the helper caps at `now`:
    // events fired at 1 PM today must be inside a "today" window even
    // though UTC end-of-day is hours away.
    const todayIso = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    const before = Date.now()
    const { windowEnd } = parseWindowFilter({ endDate: todayIso })
    const after = Date.now()

    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before)
    expect(windowEnd.getTime()).toBeLessThanOrEqual(after)
  })

  it('caps endDate at `now` even when endDate is a future date', () => {
    const future = '2099-12-31'
    const before = Date.now()
    const { windowEnd } = parseWindowFilter({ endDate: future })
    const after = Date.now()

    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before)
    expect(windowEnd.getTime()).toBeLessThanOrEqual(after)
  })

  // The customer detail page "All-Time" toggle passes
  // new Date(...).toISOString() (a full ISO timestamp like
  // "2026-04-27T18:23:41.000Z") into Server Actions that call
  // parseWindowFilter. A full ISO timestamp must be used verbatim:
  // appending 'T00:00:00.000Z' / 'T23:59:59.999Z' to it produces
  // "2026-04-27T18:23:41.000ZT00:00:00.000Z" → Invalid Date.
  it('handles full ISO timestamp inputs without double-suffixing', () => {
    const startIso = '2025-04-01T18:23:41.000Z'
    const endIso = '2025-12-31T18:23:41.000Z'
    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: startIso,
      endDate: endIso,
    })

    expect(windowStart.toISOString()).toBe(startIso)
    expect(windowEnd.toISOString()).toBe(endIso)
    expect(Number.isNaN(windowStart.getTime())).toBe(false)
    expect(Number.isNaN(windowEnd.getTime())).toBe(false)
  })

  it('mixed inputs (date string + ISO timestamp) both parse cleanly', () => {
    const before = Date.now()
    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: '2025-04-01',
      endDate: '2025-12-31T18:23:41.000Z',
    })
    const after = Date.now()

    expect(windowStart.toISOString()).toBe('2025-04-01T00:00:00.000Z')
    expect(windowEnd.toISOString()).toBe('2025-12-31T18:23:41.000Z')
    // Past endDate isn't capped at now (only today/future endDate is).
    expect(windowEnd.getTime()).toBeLessThan(before)
    expect(windowEnd.getTime()).toBeLessThan(after)
  })

  it('produces consistent windows for the same input (within ms precision)', () => {
    const a = parseWindowFilter({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    const b = parseWindowFilter({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    expect(a.windowStart.toISOString()).toBe(b.windowStart.toISOString())
    expect(a.windowEnd.toISOString()).toBe(b.windowEnd.toISOString())
  })

  it('handles startDate without endDate (defaults end to now)', () => {
    const before = Date.now()
    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: '2026-04-01',
    })
    const after = Date.now()

    expect(windowStart.toISOString()).toBe('2026-04-01T00:00:00.000Z')
    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before)
    expect(windowEnd.getTime()).toBeLessThanOrEqual(after)
  })

  it('handles endDate without startDate (defaults start to 30 days back)', () => {
    const { windowStart, windowEnd } = parseWindowFilter({
      endDate: '2025-12-31',
    })
    expect(windowEnd.toISOString()).toBe('2025-12-31T23:59:59.999Z')

    const expectedDiff = 30 * 24 * 60 * 60 * 1000
    const actualDiff = Date.now() - windowStart.getTime()
    // windowStart is 30 days back from `now`, not from windowEnd
    expect(actualDiff).toBeGreaterThanOrEqual(expectedDiff - 100)
    expect(actualDiff).toBeLessThanOrEqual(expectedDiff + 100)
  })
})
