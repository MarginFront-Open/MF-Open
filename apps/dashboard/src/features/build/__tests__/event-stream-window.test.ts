/**
 * The event stream's window
 * derivation contract. The wrapper calls parseWindowFilter CLIENT-SIDE so
 * getSignalEvents always receives concrete bounds: in rolling mode the
 * page period is {}, and a raw passthrough would make the action skip its
 * usageDate predicate entirely (see getSignalEvents), giving an all-time,
 * unindexed totalResults under a "this window" header.
 *
 * parseWindowFilter reads the clock internally (no now-reference param),
 * so these pins assert presence + ordering + approximate span, never
 * exact instants.
 */

import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'

const MS_PER_DAY = 24 * 60 * 60 * 1000

describe('empty period → concrete 30-day window', () => {
  const { windowStart, windowEnd } = parseWindowFilter({})

  it('yields two real dates, ordered', () => {
    expect(Number.isNaN(windowStart.getTime())).toBe(false)
    expect(Number.isNaN(windowEnd.getTime())).toBe(false)
    expect(windowEnd.getTime()).toBeGreaterThan(windowStart.getTime())
  })

  it('spans ~30 days and ends ~now — bounded, never all-time', () => {
    const spanDays = (windowEnd.getTime() - windowStart.getTime()) / MS_PER_DAY
    expect(spanDays).toBeGreaterThan(29.9)
    expect(spanDays).toBeLessThan(30.1)
    expect(Math.abs(windowEnd.getTime() - Date.now())).toBeLessThan(10_000)
  })
})

describe('full-ISO round-trip is idempotent — the wrapper ≡ server re-parse', () => {
  it('re-parsing the derived bounds returns the identical window', () => {
    const first = parseWindowFilter({})
    // The wrapper sends these exact strings; getSignalEvents re-parses
    // them through the same helper, whose includes('T') branch uses
    // full-ISO values verbatim — so both sides hold the same window.
    const second = parseWindowFilter({
      startDate: first.windowStart.toISOString(),
      endDate: first.windowEnd.toISOString(),
    })
    expect(second.windowStart.getTime()).toBe(first.windowStart.getTime())
    expect(second.windowEnd.getTime()).toBe(first.windowEnd.getTime())
  })
})
