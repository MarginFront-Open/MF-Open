/**
 * Pure rules for the
 * auto-derived starting value. Framework-free and node-testable, the
 * progress-derivation.ts pattern: no fetching, no Prisma, no '@marginfront/db'
 * (this module is imported by client components). The DB-touching half
 * (reading the org's numbers over the window this module derives) lives in
 * app/actions/_shared/initiative-actuals.ts.
 */

import type {
  InitiativeMetric,
  InitiativeBaselineSource,
} from '@/app/actions/initiatives'

/**
 * Which metrics the app can honestly measure over the window before the start date.
 * getMrr is a point-in-time snapshot with no historical mode (canon MRR1 —
 * as-of new Date() inside the getter), so mrr/arr stay manual-only rather
 * than fake a past value from today's book. TOTAL over InitiativeMetric on
 * purpose — growing the union without deciding is a compile error (the
 * INITIATIVE_METRIC_META pattern).
 */
export const AUTO_BASELINE_SUPPORTED: Record<InitiativeMetric, boolean> = {
  cost: true,
  revenue: true,
  margin: true,
  marginPercent: true,
  costPerTask: true,
  eventCount: true,
  unmappedCount: true,
  mrr: false,
  arr: false,
  newCustomers: true,
  internalCost: true,
  externalCost: true,
}

/**
 * Lookback for an open-ended initiative (no end date = no window length to
 * mirror): the 30 days before the start, parseWindowFilter's own default
 * lookback convention.
 */
export const BASELINE_FALLBACK_LOOKBACK_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

function toUtcDayMs(bareOrIsoDate: string): number {
  return new Date(bareOrIsoDate.slice(0, 10) + 'T00:00:00.000Z').getTime()
}

function toBareDate(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10)
}

/**
 * The window a starting value is measured over: the same number of days as
 * the initiative's own window, ending the day BEFORE the start date — the
 * mirror of how actuals read ("last quarter" is the starting point for a
 * quarterly goal). No end date mirrors the 30-day default lookback instead.
 * Bare YYYY-MM-DD in and out, the exact shape parseWindowFilter's
 * end-of-day branch needs to count the final day.
 */
export function baselineWindowFor(
  startDate: string,
  endDate: string | null
): { startDate: string; endDate: string } {
  const startMs = toUtcDayMs(startDate)
  const windowDays = endDate
    ? Math.round((toUtcDayMs(endDate) - startMs) / MS_PER_DAY) + 1
    : BASELINE_FALLBACK_LOOKBACK_DAYS
  const baselineEndMs = startMs - MS_PER_DAY
  const baselineStartMs = baselineEndMs - (windowDays - 1) * MS_PER_DAY
  return {
    startDate: toBareDate(baselineStartMs),
    endDate: toBareDate(baselineEndMs),
  }
}

export interface BaselineSubmissionInput {
  /** The starting-value field, trimmed. Empty = the user left it blank. */
  fieldValue: string
  /** True once the user typed in the field this session. */
  touched: boolean
  /** The stored baseline on the target being edited; null in create mode. */
  storedValue: number | null
  /** How the stored baseline was written; null = create mode or a row with no recorded source. */
  storedSource: InitiativeBaselineSource | null
  /** True when this dialog session changed the initiative's start date. */
  startDateChanged: boolean
  /** True when this dialog session changed the matter scope —
   * a measured value read the OLD scope, so it no longer compares. */
  scopeChanged: boolean
  isEdit: boolean
}

/**
 * What the dialog submits for one target's baseline (the rules):
 * a typed value is a manual override; a cleared field asks the server to
 * measure again; an untouched auto baseline is carried forward UNLESS the
 * start date or the matter scope moved, in which case the server re-measures;
 * a manual value (including one with no recorded source, storedSource null)
 * is never silently replaced.
 */
export function resolveBaselineSubmission(input: BaselineSubmissionInput): {
  baselineValue: number | null
  baselineSource: InitiativeBaselineSource
} {
  const {
    fieldValue,
    touched,
    storedValue,
    storedSource,
    startDateChanged,
    scopeChanged,
    isEdit,
  } = input

  if (touched) {
    return fieldValue === ''
      ? { baselineValue: null, baselineSource: 'auto' }
      : { baselineValue: Number(fieldValue), baselineSource: 'manual' }
  }

  if (isEdit && storedValue !== null && storedSource !== 'auto') {
    return { baselineValue: storedValue, baselineSource: 'manual' }
  }

  if (
    isEdit &&
    storedValue !== null &&
    storedSource === 'auto' &&
    !startDateChanged &&
    !scopeChanged
  ) {
    return { baselineValue: storedValue, baselineSource: 'auto' }
  }

  return { baselineValue: null, baselineSource: 'auto' }
}
