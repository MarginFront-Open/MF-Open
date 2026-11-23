/**
 * Pure date-range mapping for the page shell.
 *
 * ONE selection type, three modes, mapped onto the two shared window
 * helpers — never re-derived:
 *   - month  → monthPeriod() bounds (billing-period.ts, the source)
 *   - rolling→ {} (parseWindowFilter defaults to 30-days-back → now)
 *   - custom → bare YYYY-MM-DD start/end (parseWindowFilter's UI shape)
 *
 * The same {startDate?, endDate?} object is both the URL search-param shape
 * (?startDate=&endDate=, matching the protected /cost-management deep link)
 * and resolveMetrics' `period` input, so views stay shareable and saved views
 * round-trip intact.
 *
 * Rolling's period is {}. But {} alone
 * can't round-trip through the URL: selectionFromParams reads "no
 * startDate/endDate" as "no selection made, use the page default" — correct
 * on first load, wrong the moment a user explicitly picks Rolling on a page
 * whose default isn't rolling (Money defaults to month): clicking "Last 30
 * days" would round-trip straight back to Month. So an explicit, shareable
 * ?range=rolling URL marker sits on top of (not inside) the period shape
 * (selectionToUrlParams below), and resolveMetrics never sees it.
 */

import {
  monthPeriod,
  monthsAgoFromDates,
} from '@/features/_shared/billing-period'
import type { DateRangeConfig, DateRangeSelection } from './types'

export interface DateRangeParams {
  startDate?: string
  endDate?: string
}

/** URL round-trip shape: DateRangeParams plus the explicit rolling marker
 *  (see header). resolveMetrics never sees `range` — only
 *  selectionFromParams reads it. */
export interface DateRangeUrlParams extends DateRangeParams {
  range?: string
}

/** Selection → URL params / resolveMetrics period. Rolling emits {}. */
export function selectionToPeriod(
  selection: DateRangeSelection
): DateRangeParams {
  switch (selection.mode) {
    case 'month': {
      const { startDate, endDate } = monthPeriod(selection.monthsAgo)
      return { startDate, endDate }
    }
    case 'rolling':
      return {}
    case 'custom':
      return { startDate: selection.startDate, endDate: selection.endDate }
  }
}

/** Selection → the URL's actual query params: selectionToPeriod plus
 *  rolling's explicit marker (header). This is what DateRangeSelector
 *  writes to the URL on commit. */
export function selectionToUrlParams(
  selection: DateRangeSelection
): DateRangeUrlParams {
  const period = selectionToPeriod(selection)
  return selection.mode === 'rolling' ? { ...period, range: 'rolling' } : period
}

/**
 * The page's next URL when the window moves: the params it already carries,
 * with the date trio rewritten and every window-scoped param dropped. A param
 * the customer typed for one window is not stale against another, it is wrong.
 * Config-driven, so the shell never learns what any page's params mean.
 */
export function nextUrlParams(
  current: URLSearchParams,
  next: DateRangeSelection,
  config: DateRangeConfig
): URLSearchParams {
  const params = new URLSearchParams(current)
  const period = selectionToUrlParams(next)

  for (const key of ['startDate', 'endDate', 'range'] as const) {
    const value = period[key]
    if (value) params.set(key, value)
    else params.delete(key)
  }
  for (const key of config.windowScopedParams ?? []) {
    params.delete(key)
  }
  return params
}

/**
 * URL params → selection, honoring the page's allowed modes.
 * `range=rolling` wins outright — it's an explicit user choice, not an
 * absence. No params otherwise ⇒ the page default. Params that exactly
 * match a calendar month in the last 12 read back as month mode (monthPeriod
 * reverse-lookup); anything else with both bounds reads as custom. Params
 * the config doesn't allow fall back to the default rather than smuggling in
 * a forbidden mode (FinOps is month-locked).
 */
export function selectionFromParams(
  params: DateRangeUrlParams,
  config: DateRangeConfig
): DateRangeSelection | null {
  if (config.modes.length === 0) return null

  const { startDate, endDate, range } = params
  if (range === 'rolling' && config.modes.includes('rolling')) {
    return { mode: 'rolling' }
  }
  if (!startDate && !endDate) return config.default

  const monthsAgo = monthsAgoFromDates(startDate, endDate)
  if (monthsAgo !== null && config.modes.includes('month')) {
    return { mode: 'month', monthsAgo }
  }
  if (startDate && endDate && config.modes.includes('custom')) {
    return { mode: 'custom', startDate, endDate }
  }
  return config.default
}

/**
 * Display label. The rolling literal matches formatWindowLabel's no-dates
 * default (parse-window-filter.ts) — the date-range test pins the parity.
 */
export function selectionLabel(selection: DateRangeSelection): string {
  switch (selection.mode) {
    case 'month':
      return monthPeriod(selection.monthsAgo).monthLabel
    case 'rolling':
      return 'Last 30 days'
    case 'custom':
      return `${selection.startDate} → ${selection.endDate}`
  }
}
