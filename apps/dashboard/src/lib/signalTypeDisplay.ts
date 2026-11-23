/**
 * Canonical metric-classification display + mapping helpers.
 *
 * Background
 * ----------
 * The DB stores `signals.type` as an enum with two values: `volume` and
 * `usage` (see `enum_signals_type` in `packages/db/prisma/schema.prisma`).
 * The names run opposite to industry terminology:
 *
 *   - DB `volume` = industry "Usage-Based" (every event billed; the default
 *     usage-billing model, e.g. API calls, tokens, attempts)
 *   - DB `usage`  = industry "Outcome-Based" (billed only when the action
 *     produced a result, e.g. deal closed, contract signed, meeting booked)
 *
 * Internally the dashboard uses a second enum `'ACTIVITY' | 'OUTCOME'` to
 * avoid comparing raw DB values in JSX. Service-layer mapping
 * normalizes API responses to that internal form (see
 * `apps/dashboard/src/services/signal-service.ts` and
 * `apps/dashboard/src/features/pricing-configure/hooks/usePricingState.ts`).
 *
 * What this module provides
 * -------------------------
 * Two tiny pure helpers:
 *
 *   - `signalTypeDisplay(dbType)`: returns the user-facing label. This
 *     is the ONLY function that should produce "Usage-Based" /
 *     "Outcome-Based" strings for rendering. Centralizing the copy here
 *     keeps a label change to one file.
 *   - `signalTypeFromDb(dbType)`: maps the DB value to the internal
 *     `'ACTIVITY' | 'OUTCOME'` enum. Use this at every read boundary where
 *     raw DB values cross into UI code. The service-layer mappers in
 *     signal-service.ts and usePricingState.ts carry their own inline
 *     branch with the same mapping.
 *
 * Why two helpers, not one
 * ------------------------
 * The internal enum is load-bearing: many components compare against
 * `'ACTIVITY'` / `'OUTCOME'` literals for filter/bucket logic, not display.
 * Renaming those to `'USAGE_BASED'` / `'OUTCOME_BASED'` would ripple into
 * dozens of files with no functional win. Keep the internal enum stable;
 * change only the DISPLAY via `signalTypeDisplay`.
 */

export type DbSignalType = 'volume' | 'usage'
export type UiSignalClassification = 'ACTIVITY' | 'OUTCOME'
export type SignalTypeDisplayLabel = 'Usage-Based' | 'Outcome-Based'

/**
 * Convert a DB `signals.type` value into the user-facing display label.
 *
 * "Usage-Based" and "Outcome-Based" are the industry-standard terms the
 * dashboard renders to users. See module header for the DB -> industry
 * mapping (it's intentionally reversed from the literal enum names).
 */
export function signalTypeDisplay(
  dbType: DbSignalType
): SignalTypeDisplayLabel {
  return dbType === 'volume' ? 'Usage-Based' : 'Outcome-Based'
}

/**
 * Convert a DB `signals.type` value into the internal UI classification
 * enum (`'ACTIVITY' | 'OUTCOME'`).
 *
 * Use this at read boundaries where raw DB values enter UI code paths.
 * The internal enum drives filter / bucket logic; only the DISPLAY layer
 * (`signalTypeDisplay`) produces the industry-standard labels.
 */
export function signalTypeFromDb(dbType: DbSignalType): UiSignalClassification {
  return dbType === 'volume' ? 'ACTIVITY' : 'OUTCOME'
}

/**
 * Convert the internal UI classification enum to the user-facing display
 * label. Useful when a component already holds the normalized
 * `'ACTIVITY' | 'OUTCOME'` value (e.g. after service-layer mapping) and
 * needs to render the label.
 */
export function uiClassificationDisplay(
  classification: UiSignalClassification
): SignalTypeDisplayLabel {
  return classification === 'ACTIVITY' ? 'Usage-Based' : 'Outcome-Based'
}
