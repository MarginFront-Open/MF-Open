/**
 * Canonical window-filter parser for Server Actions consuming
 * { startDate?: string, endDate?: string } from the dashboard UI.
 *
 * Why this exists: if each Server Action parsed UI date strings its own
 * way, an event timestamped after end-of-day UTC for "today" would
 * appear in some surfaces but not others, producing contradictory
 * numbers within the same view.
 *
 * Semantics this helper enforces:
 *   - startDate interpreted as start-of-day UTC (00:00:00.000Z)
 *   - endDate interpreted as end-of-day UTC (23:59:59.999Z)
 *   - windowEnd capped at `now`. If the parsed end-of-day is in the
 *     future (e.g. today's date selected), the window ends at the
 *     current moment so just-fired events are always included.
 *   - When no startDate is provided, default to 30 days back from now.
 *   - When no endDate is provided, default to now.
 *
 * Every Server Action consuming UI date filters should route through
 * this helper. breakdown-window-consistency.test.ts checks that the
 * breakdown table, its export and the tile resolve the same window.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface WindowFilter {
  /** ISO date string from the UI, e.g. "2026-04-27". Optional. */
  startDate?: string
  /** ISO date string from the UI, e.g. "2026-04-27". Optional. */
  endDate?: string
}

export interface ResolvedWindow {
  /** Start of the window in UTC. */
  windowStart: Date
  /** End of the window in UTC, never beyond the current moment. */
  windowEnd: Date
}

/**
 * Parse {startDate, endDate} from the dashboard UI into a consistent
 * UTC window. Caps windowEnd at `now` so events fired just now always
 * land inside a "today" window regardless of timezone.
 *
 * Optional `defaultLookbackDays` controls how far back the default
 * window reaches when startDate is omitted (default 30).
 */
export function parseWindowFilter(
  filter: WindowFilter | undefined,
  defaultLookbackDays = 30
): ResolvedWindow {
  const now = new Date()

  // Callers send either a "YYYY-MM-DD" date string from the UI date
  // picker OR a full ISO timestamp like "2026-04-27T18:23:41.000Z" from
  // server-side defaults (the customer detail "All-Time" toggle does
  // this). Detect the full-ISO shape via the presence of `T` and use it
  // verbatim; otherwise glue the time-of-day suffix on a bare date so
  // we still anchor to start/end of day UTC.
  const windowStart = filter?.startDate
    ? new Date(
        filter.startDate.includes('T')
          ? filter.startDate
          : filter.startDate + 'T00:00:00.000Z'
      )
    : new Date(now.getTime() - defaultLookbackDays * MS_PER_DAY)

  const parsedEnd = filter?.endDate
    ? new Date(
        filter.endDate.includes('T')
          ? filter.endDate
          : filter.endDate + 'T23:59:59.999Z'
      )
    : now

  // Cap at now so live-fired events are always inside a "today" window
  // and Western-timezone users see the same data as Eastern-timezone
  // users for the same UI date selection.
  const windowEnd = parsedEnd.getTime() > now.getTime() ? now : parsedEnd

  return { windowStart, windowEnd }
}

/**
 * Human-readable label for a resolved window. Returns the default
 * "Last 30 days" when the caller passed no explicit dates, and an ISO
 * date range ("2026-05-01 →
 * 2026-05-31") when a specific billing period was selected.
 */
export function formatWindowLabel(
  filter: WindowFilter | undefined,
  windowStart: Date,
  windowEnd: Date
): string {
  if (!filter?.startDate && !filter?.endDate) return 'Last 30 days'
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return `${fmt(windowStart)} → ${fmt(windowEnd)}`
}
