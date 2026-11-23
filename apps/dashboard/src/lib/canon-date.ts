import { format } from 'date-fns'

// The ONE UTC-safe display-date formatter for the
// dashboard. Sibling to canon-format.ts (money/percent) — same "one canon
// formatter, no scattered copies" doctrine, for calendar dates.
//
// The trap it removes: invoice / subscription / usage dates are stored as UTC
// date or timestamp strings ("2026-07-03" or "2026-07-03T00:00:00.000Z"), and
// the naive `format(new Date(value), fmt)` parses them as a UTC instant then
// renders in the VIEWER's local zone — one calendar day early in any
// negative-offset zone (a Jul 3 invoice shows "Jul 2" in UTC-4). This rebuilds
// the date from its UTC calendar parts as a local Date, so date-fns prints the
// stored calendar day in every timezone.
//
// DISPLAY ONLY. Never route date math / comparisons / "is it overdue" through
// this — those must keep the real instant (`new Date(value)`).

/**
 * Format a stored UTC date/timestamp as its calendar date, timezone-stable.
 * Null / empty / unparseable input renders the em-dash placeholder.
 */
export function formatDisplayDate(
  value: string | Date | null | undefined,
  fmt = 'MMM d, yyyy'
): string {
  if (!value) return '—'
  const instant = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(instant.getTime())) return '—'
  const calendarDate = new Date(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate()
  )
  return format(calendarDate, fmt)
}
