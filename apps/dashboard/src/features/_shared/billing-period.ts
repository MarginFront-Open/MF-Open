/**
 * WHAT THIS FILE DOES: the one place that turns a "billing period" into a
 *   calendar-month window. Both FinOps pages, Month-End Close and Cost
 *   Management, read their period bounds from here.
 *
 * WHY IT EXISTS: the two pages show the same labels ("COGS",
 *   "Unclassified"), so they must aggregate over the same window. If each page
 *   derived its own window, their totals would disagree. A window is computed
 *   once here and passed through; no page derives its own.
 *
 * CONNECTS TO:
 *   - src/features/month-end-close/index.tsx (the period selector + bounds)
 *   - src/features/cost-management/index.tsx (the period selector + bounds)
 *   - app/(dashboard)/cost-management/page.tsx (resolves a deep-link's dates)
 */

import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns'

/** A resolved calendar-month billing period. */
export interface MonthPeriod {
  /** First day of the month as "yyyy-MM-dd" (e.g. "2026-06-01"). */
  startDate: string
  /** Last day of the month as "yyyy-MM-dd" (e.g. "2026-06-30"). */
  endDate: string
  /** Human label, e.g. "June 2026". */
  monthLabel: string
}

/**
 * The calendar-month window for `monthsAgo` months back from today.
 * `monthsAgo = 0` is the current month, `1` is last month, and so on.
 *
 * The date portion ("yyyy-MM-dd") is timezone-stable — the 1st and last day of
 * a month format identically in any timezone — so the only thing "now" decides
 * is WHICH month is current. That's what lets the page route resolve a
 * deep-link's dates back to a selector position reliably.
 */
export function monthPeriod(monthsAgo: number): MonthPeriod {
  const monthDate = subMonths(new Date(), monthsAgo)
  return {
    startDate: format(startOfMonth(monthDate), 'yyyy-MM-dd'),
    endDate: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
    monthLabel: format(monthDate, 'MMMM yyyy'),
  }
}

/**
 * The last 12 months as selectable options (0 = current month). Drives the
 * "Billing period" dropdown on both FinOps pages.
 */
export const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  monthsAgo: i,
  label: monthPeriod(i).monthLabel,
}))

/**
 * Resolve a deep-link's `startDate`/`endDate` back to the matching selector
 * position. Returns the `monthsAgo` index whose month bounds EXACTLY equal the
 * passed dates, or `null` when the dates are absent or aren't a clean calendar
 * month inside the last 12 (the caller should fall back to the current month).
 *
 * This is the inverse of `monthPeriod`, so `monthsAgoFromDates(monthPeriod(n))`
 * round-trips to `n` — the property the unit test pins down. We match by
 * recomputing each month's bounds with the same function, which guarantees the
 * round-trip holds regardless of timezone.
 */
export function monthsAgoFromDates(
  startDate?: string,
  endDate?: string
): number | null {
  if (!startDate || !endDate) return null
  for (let i = 0; i < MONTH_OPTIONS.length; i++) {
    const period = monthPeriod(i)
    if (period.startDate === startDate && period.endDate === endDate) return i
  }
  return null
}
