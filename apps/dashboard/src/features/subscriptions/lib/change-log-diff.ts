/**
 * subscription_change_logs rows carry a
 * `previousValues`/`newValues` pair, but the two objects don't always cover
 * the same keys (updateSubscription logs 4 tracked fields as `previousValues`
 * against the WHOLE edit payload as `newValues`; cancelSubscription logs a
 * clean 1-key pair). This derives only the fields that were actually
 * TRACKED (present in `previousValues`) AND actually changed — never a
 * fabricated diff for a field the log never captured a "before" value for.
 */

export interface ChangeLogFieldDiff {
  field: string
  oldValue: unknown
  newValue: unknown
}

export function deriveChangeLogFieldDiffs(
  previousValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null
): ChangeLogFieldDiff[] {
  if (!previousValues) return []

  return Object.keys(previousValues)
    .filter((field) => {
      const oldValue = previousValues[field]
      const newValue = newValues ? newValues[field] : undefined
      return JSON.stringify(oldValue) !== JSON.stringify(newValue)
    })
    .map((field) => ({
      field,
      oldValue: previousValues[field],
      newValue: newValues ? (newValues[field] ?? null) : null,
    }))
}

/** Renders a diff value for display — never a raw "undefined" or "[object Object]". */
export function formatChangeLogValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return JSON.stringify(value)
}
