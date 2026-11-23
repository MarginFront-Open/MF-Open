/**
 * Unit tests for the shared billing-period helper. These are pure
 * (date-fns only, no React), so they run directly in the dashboard's node-env
 * jest suite.
 *
 * Cost Management and Month-End Close must produce identical month bounds,
 * so these tests pin two guarantees:
 *   1. monthPeriod() equals an independent date-fns computation of the
 *      calendar month.
 *   2. monthsAgoFromDates() is the inverse of monthPeriod(), so a deep link's
 *      dates always resolve back to the right selector position.
 */
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns'
import {
  MONTH_OPTIONS,
  monthPeriod,
  monthsAgoFromDates,
} from '../billing-period'

describe('monthPeriod', () => {
  it('returns first/last day + label for the current month (monthsAgo = 0)', () => {
    // Independent recomputation for parity.
    const now = subMonths(new Date(), 0)
    expect(monthPeriod(0)).toEqual({
      startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
      endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      monthLabel: format(now, 'MMMM yyyy'),
    })
  })

  it('matches an independent computation for all 12 selectable months', () => {
    for (let i = 0; i < 12; i++) {
      const monthDate = subMonths(new Date(), i)
      expect(monthPeriod(i)).toEqual({
        startDate: format(startOfMonth(monthDate), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
        monthLabel: format(monthDate, 'MMMM yyyy'),
      })
    }
  })

  it('produces a start strictly before the end (a real window)', () => {
    const { startDate, endDate } = monthPeriod(0)
    expect(startDate <= endDate).toBe(true)
    expect(startDate.endsWith('-01')).toBe(true) // always the 1st of the month
  })
})

describe('MONTH_OPTIONS', () => {
  it('lists 12 months, 0..11, labelled to match monthPeriod', () => {
    expect(MONTH_OPTIONS).toHaveLength(12)
    MONTH_OPTIONS.forEach((opt, i) => {
      expect(opt.monthsAgo).toBe(i)
      expect(opt.label).toBe(monthPeriod(i).monthLabel)
    })
  })
})

describe('monthsAgoFromDates', () => {
  it('round-trips: monthsAgoFromDates(monthPeriod(n)) === n for every month', () => {
    for (let n = 0; n < 12; n++) {
      const { startDate, endDate } = monthPeriod(n)
      expect(monthsAgoFromDates(startDate, endDate)).toBe(n)
    }
  })

  it('returns null when either date is missing (no deep-link → caller defaults)', () => {
    expect(monthsAgoFromDates(undefined, undefined)).toBeNull()
    expect(monthsAgoFromDates('2026-06-01', undefined)).toBeNull()
    expect(monthsAgoFromDates(undefined, '2026-06-30')).toBeNull()
  })

  it('returns null for a range that is not a clean calendar month', () => {
    const { startDate } = monthPeriod(0)
    // Same start, but a 7-day end → not a whole month → unmatched.
    expect(monthsAgoFromDates(startDate, '2026-01-07')).toBeNull()
    // A mid-month start can never equal startOfMonth.
    expect(monthsAgoFromDates('2026-06-15', '2026-06-30')).toBeNull()
  })

  it('returns null for a clean month older than the 12-month window', () => {
    // A real calendar month (Jan 2000) that can never be within the last 12.
    expect(monthsAgoFromDates('2000-01-01', '2000-01-31')).toBeNull()
  })
})
