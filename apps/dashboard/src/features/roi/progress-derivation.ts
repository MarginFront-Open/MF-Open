/**
 * Pure derivation of the ROI page's progress,
 * health, and card copy. Framework-free and node-testable: takes the facts
 * getRoiOverview composes (targets + canon actuals + optional manual
 * baselines) and returns everything the cards render. NO fetching, NO money
 * math beyond canon-format display strings; null per canon M2
 * (undefined-for-window renders "—", never 0 and never an invented bar).
 */

import { formatCost, formatPct } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  WORK_ITEM_NOUN,
  WORK_ITEM_NOUN_SENTENCE_CASE,
} from '@/lib/work-item-noun'
import type {
  InitiativeMetric,
  InitiativeStatus,
  InitiativeTargetDirection,
} from '@/app/actions/initiatives'
import type { RoiTargetView } from '@/app/actions/roi-overview'

export type InitiativeHealth =
  | 'on-track'
  | 'at-risk'
  | 'achieved'
  | 'not-started'
  | 'no-data'
  | 'archived'

/**
 * Pace grace: an initiative is at-risk only when its slowest target trails
 * the elapsed-time expectation by more than this many points. A MarginFront
 * CONVENTION, not schema truth — no pace concept exists anywhere in the data
 * model (the same pattern as CLOSE_WINDOW_DAYS).
 */
export const ROI_PACE_GRACE_PTS = 10

export type InitiativeMetricFormat = 'cost' | 'pct' | 'count'

/**
 * What a metric IS over a goal's window, which decides what progress means.
 * A 'cumulative' one adds up across it, so a quarter of the way in it holds
 * a quarter of the window and cannot yet have passed a whole previous
 * window's figure. A 'level' one exists whole at any instant, so the
 * distance travelled from where it started IS the progress.
 */
export type GoalMetricKind = 'cumulative' | 'level'

/**
 * TOTAL over InitiativeMetric on purpose: growing the union without a label
 * here is a compile error (the status-map pattern). Labels reuse the
 * RESOLVER_TILE_METRICS registry's where an entry exists.
 *
 * Three kinds a reader could argue with: unmappedCount is a backlog burned
 * down by mapping signals, and mrr/arr are point-in-time snapshots (canon
 * MRR1). Nothing summed over a window, so all three are levels.
 */
export const INITIATIVE_METRIC_META: Record<
  InitiativeMetric,
  { label: string; format: InitiativeMetricFormat; kind: GoalMetricKind }
> = {
  cost: { label: 'Cost', format: 'cost', kind: 'cumulative' },
  revenue: { label: 'Revenue', format: 'cost', kind: 'cumulative' },
  margin: { label: 'Margin ($)', format: 'cost', kind: 'cumulative' },
  // Not "Net margin": the number is subscription-scoped on both sides, so
  // "net" would claim a precision it does not have.
  marginPercent: { label: 'Margin %', format: 'pct', kind: 'level' },
  costPerTask: {
    label: 'Avg cost / usage event',
    format: 'cost',
    kind: 'level',
  },
  eventCount: { label: 'Usage events', format: 'count', kind: 'cumulative' },
  unmappedCount: { label: 'Unmapped GL items', format: 'count', kind: 'level' },
  // No separate "cost saved" metric: pair internalCost /
  // externalCost with a baseline + "Keep under" and goalProgressSentence names
  // last window's figure. Never the difference: mid-window that subtracts a
  // whole previous window from a partial running total, which flatters.
  mrr: { label: 'MRR', format: 'cost', kind: 'level' },
  arr: { label: 'ARR', format: 'cost', kind: 'level' },
  newCustomers: { label: 'New customers', format: 'count', kind: 'cumulative' },
  internalCost: { label: 'Internal cost', format: 'cost', kind: 'cumulative' },
  externalCost: { label: 'External cost', format: 'cost', kind: 'cumulative' },
}

export interface TargetProgress {
  /** 0-100 clamped; null = not computable (canon M2 — renders '—'). */
  progressPct: number | null
  /** null when the actual is null. */
  met: boolean | null
}

/** Which side of the clock a target is on. null = no pace to keep. */
export type GoalPace = 'ahead' | 'behind'

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * The share of a goal's window already spent, 0-100; null with no end date
 * and therefore no pace to keep. endDate === startDate is legal (the write
 * action allows it), and a started zero-length window is fully elapsed.
 */
export function windowElapsedPct(
  startDate: string,
  endDate: string | null,
  now: Date
): number | null {
  if (!endDate) return null
  const startMs = new Date(startDate).getTime()
  const endMs = new Date(endDate).getTime()
  if (!(endMs > startMs)) return 100
  return clampPct(((now.getTime() - startMs) / (endMs - startMs)) * 100)
}

/** True when a level goal has moved AWAY from where it started. */
function movedWrongWay(target: {
  metric: InitiativeMetric
  direction: InitiativeTargetDirection
  actual: number | null
  baseline: number | null
}): boolean {
  const { metric, direction, actual, baseline } = target
  if (actual === null || baseline === null) return false
  if (INITIATIVE_METRIC_META[metric].kind !== 'level') return false
  return direction === 'gte' ? actual < baseline : actual > baseline
}

/**
 * Progress toward one target, by metric kind. Cumulative reads
 * the running total against the target, because the starting value is last
 * window's total and not this window's zero point. Level reads from the
 * starting value where one exists, and is null where no formula is
 * meaningful (lte-to-zero without a baseline is unmeasurable).
 */
export function targetProgress(
  target: {
    metric: InitiativeMetric
    direction: InitiativeTargetDirection
    targetValue: number
  },
  actual: number | null,
  baseline: number | null,
  elapsedPct: number | null = null
): TargetProgress {
  if (actual === null) return { progressPct: null, met: null }

  const { metric, direction, targetValue } = target

  if (INITIATIVE_METRIC_META[metric].kind === 'cumulative') {
    // A running total under a cap has not KEPT it, only not broken it yet:
    // met on day one would read Achieved for a goal with months left to run.
    const met =
      direction === 'gte'
        ? actual >= targetValue
        : elapsedPct !== null && elapsedPct >= 100 && actual <= targetValue
    if (met) return { progressPct: 100, met: true }
    if (targetValue > 0) {
      return { progressPct: clampPct((actual / targetValue) * 100), met: false }
    }
    return { progressPct: null, met: false }
  }

  const met =
    direction === 'lte' ? actual <= targetValue : actual >= targetValue
  if (met) return { progressPct: 100, met: true }

  if (baseline !== null) {
    if (baseline === targetValue) return { progressPct: null, met: false }
    const fraction =
      direction === 'lte'
        ? (baseline - actual) / (baseline - targetValue)
        : (actual - baseline) / (targetValue - baseline)
    return { progressPct: clampPct(fraction * 100), met: false }
  }

  if (direction === 'gte' && targetValue > 0) {
    return { progressPct: clampPct((actual / targetValue) * 100), met: false }
  }
  if (direction === 'lte' && targetValue > 0 && actual > 0) {
    return { progressPct: clampPct((targetValue / actual) * 100), met: false }
  }
  return { progressPct: null, met: false }
}

/**
 * Which side of the clock one target sits on (the pace rule), by kind.
 * A cumulative cap inverts the comparison: spending is kept by staying under
 * the target PRO-RATED to the days gone by, so a low number is the good one.
 *
 * The grace buys TIME inside a running window. It never buys room above a cap,
 * and it buys nothing at all once the window is spent, or a goal already lost
 * reads on pace for the stretch a customer is most likely to check it. A cap
 * with no end date has no clock and still has a verdict, for the same reason.
 */
export function targetPace(
  target: {
    metric: InitiativeMetric
    direction: InitiativeTargetDirection
    targetValue: number
    actual: number | null
    baseline: number | null
    progressPct: number | null
  },
  elapsedPct: number | null
): GoalPace | null {
  const { metric, direction, targetValue, actual, progressPct } = target
  if (actual === null) return null

  if (
    INITIATIVE_METRIC_META[metric].kind === 'cumulative' &&
    direction === 'lte'
  ) {
    // A running total past its cap can never come back under it, dates or not.
    if (actual > targetValue) return 'behind'
    if (elapsedPct === null) return null
    const allowedSoFar = Math.min(
      targetValue,
      (targetValue * (elapsedPct + ROI_PACE_GRACE_PTS)) / 100
    )
    return actual <= allowedSoFar ? 'ahead' : 'behind'
  }

  // Every other kind needs the clock: nothing else is lost before its dates.
  if (elapsedPct === null) return null

  // A number moving AWAY from where it started has no pace to be ahead of.
  if (movedWrongWay(target)) return 'behind'

  if (progressPct === null) return null
  const grace = elapsedPct >= 100 ? 0 : ROI_PACE_GRACE_PTS
  return progressPct < elapsedPct - grace ? 'behind' : 'ahead'
}

/**
 * Health from lifecycle + per-target pace (the pace rule):
 * archived > not-started > no-data > achieved, then at-risk iff any
 * measurable target is behind its own kind's pace. No end date = no pace
 * expectation = on-track.
 */
export function deriveInitiativeHealth(
  initiative: {
    status: InitiativeStatus
    startDate: string
    endDate: string | null
  },
  targets: Array<
    Pick<
      RoiTargetView,
      | 'metric'
      | 'direction'
      | 'targetValue'
      | 'actual'
      | 'baseline'
      | 'progressPct'
      | 'met'
    >
  >,
  now: Date
): InitiativeHealth {
  if (initiative.status === 'archived') return 'archived'

  const startMs = new Date(initiative.startDate).getTime()
  if (now.getTime() < startMs) return 'not-started'

  if (targets.length === 0) return 'no-data'
  if (targets.every((t) => t.met === true)) return 'achieved'

  const measurable = targets.filter((t) => t.progressPct !== null)
  if (measurable.length === 0) return 'no-data'

  const elapsedPct = windowElapsedPct(
    initiative.startDate,
    initiative.endDate,
    now
  )
  if (measurable.some((t) => targetPace(t, elapsedPct) === 'behind')) {
    return 'at-risk'
  }
  return 'on-track'
}

/** One metric value as card copy — canon-format only, null renders '—'. */
export function formatMetricValue(
  metric: InitiativeMetric,
  value: number | null
): string {
  if (value === null) return '—'
  const { format } = INITIATIVE_METRIC_META[metric]
  if (format === 'cost') return formatCost(value)
  if (format === 'pct') return formatPct(value)
  return value.toLocaleString()
}

/** What the stored starting value IS, per kind: on a running total it holds
 * the PREVIOUS window's figure, and "starting value" there reads as though
 * this window begins from it. With no end date there is no window to mirror
 * (the auto value is a flat lookback), so the plain name is the honest one. */
export function baselineLabel(
  metric: InitiativeMetric,
  endDate: string | null
): string {
  return INITIATIVE_METRIC_META[metric].kind === 'cumulative' &&
    endDate !== null
    ? 'Last window'
    : 'Starting value'
}

/**
 * The dates a goal measures, for the card and the print alike. A goal with no
 * end date is still running, and the line says so rather than inventing one.
 */
export function formatGoalWindow(
  startDate: string,
  endDate: string | null
): string {
  const start = formatDisplayDate(startDate)
  if (!endDate) return `Started ${start}, ongoing`
  return `${start} to ${formatDisplayDate(endDate)}`
}

/**
 * The scope subtitle — one builder for card, detail and print. A
 * work item reads all-time on the Matters page while a goal reads its own
 * window, so the scoped line names the window out loud; the deleted line
 * exists because SET NULL widens those numbers back to org-wide when the work
 * item is deleted, and the card must not pretend otherwise.
 */
export function matterScopeLabel(scope: {
  matterId: string | null
  matterNumber: string | null
  scopedMatterNumber: string | null
}): string | null {
  if (scope.matterId && scope.matterNumber) {
    return `${WORK_ITEM_NOUN_SENTENCE_CASE} ${scope.matterNumber}, this goal's window`
  }
  if (scope.scopedMatterNumber) {
    return `Whole organization (the ${WORK_ITEM_NOUN} this goal pointed at was deleted)`
  }
  return null
}

/** The dialog's two sentences live here, with the other copy builders,
 * because node jest cannot mount the client component that renders them. */
export const SCOPE_SUMMARY_COPY = `Narrow to one ${WORK_ITEM_NOUN} (optional)`

/** Nine of the twelve metrics have no per-work-item grain to read, so the
 * scope is a trade the customer is told about before saving, not after. */
export const SCOPE_HELPER_COPY = `Narrowed to one ${WORK_ITEM_NOUN}, you get that ${WORK_ITEM_NOUN}'s cost, usage events and average cost per usage event. Everything else, including revenue, margin, MRR, customer counts, unmapped items and the internal/external cost split, can't be broken out per ${WORK_ITEM_NOUN}, so it shows a dash.`

/** Whole-percent progress as card copy (92.857 renders "93%"); null renders '—'. */
export function progressLabel(progressPct: number | null): string {
  return progressPct === null ? '—' : `${Math.round(progressPct)}%`
}

/** The percent a surface may show. A level goal that moved AWAY from its
 * start scores a floored 0, and "0%" reads as "nothing yet" rather than
 * "backwards"; the sentence says which, so the pill shows nothing. */
export function displayProgressPct(target: {
  metric: InitiativeMetric
  direction: InitiativeTargetDirection
  actual: number | null
  baseline: number | null
  progressPct: number | null
}): number | null {
  return movedWrongWay(target) ? null : target.progressPct
}

/** Goal line: 'Keep {label} at or under {target}' / 'Reach {label} of at least {target}'. */
export function goalSentence(target: {
  metric: InitiativeMetric
  direction: InitiativeTargetDirection
  targetValue: number
}): string {
  const { label } = INITIATIVE_METRIC_META[target.metric]
  const formatted = formatMetricValue(target.metric, target.targetValue)
  return target.direction === 'lte'
    ? `Keep ${label} at or under ${formatted}`
    : `Reach ${label} of at least ${formatted}`
}

/**
 * Where a goal stands, in one sentence, for the card, the goal page and the
 * print alike. Two clauses at most: where the number is, then which side of
 * the clock it is on. A cap says "on pace to stay under" rather than
 * "ahead", because ahead of a spending target is the ambiguous direction.
 */
export function goalProgressSentence(
  target: {
    metric: InitiativeMetric
    direction: InitiativeTargetDirection
    targetValue: number
    actual: number | null
    baseline: number | null
    progressPct: number | null
    met: boolean | null
  },
  elapsedPct: number | null
): string {
  const { metric, direction, targetValue, actual, baseline, progressPct, met } =
    target
  // Deliberately neutral: an archived goal skips its reads, so "nothing was
  // measured" would be a claim about a window that simply stopped computing.
  if (actual === null) return 'No number for this window.'

  const cumulative = INITIATIVE_METRIC_META[metric].kind === 'cumulative'
  const value = formatMetricValue(metric, actual)
  const goal = formatMetricValue(metric, targetValue)
  // The same split baselineLabel makes, or this clause names a window the Stat
  // label above it says was never mirrored.
  const against =
    cumulative && direction === 'lte' && baseline !== null
      ? elapsedPct === null
        ? ` against a starting value of ${formatMetricValue(metric, baseline)}`
        : ` against last window's ${formatMetricValue(metric, baseline)}`
      : ''
  const standing = cumulative ? `${value} so far${against}` : `${value} now`
  const goalNoun = direction === 'lte' ? 'limit' : 'target'

  if (met) {
    return direction === 'lte'
      ? `${standing}, under the ${goal} ${goalNoun}.`
      : `${standing}, past the ${goal} ${goalNoun}.`
  }

  // The clause names a clock, and a goal with no end date has none, even where
  // its broken cap makes the verdict behind.
  const pace =
    elapsedPct === null
      ? null
      : targetPace(
          { metric, direction, targetValue, actual, baseline, progressPct },
          elapsedPct
        )
  const paceClause =
    pace === null
      ? ''
      : cumulative && direction === 'lte'
        ? pace === 'ahead'
          ? ' On pace to stay under.'
          : ' Over pace.'
        : pace === 'ahead'
          ? ' Ahead of pace.'
          : ' Behind pace.'
  const elapsedClause =
    elapsedPct === null
      ? ''
      : ` with ${progressLabel(elapsedPct)} of the window elapsed`

  if (cumulative) {
    if (direction === 'lte' && actual > targetValue) {
      return `${standing}, over the ${goal} limit${elapsedClause}.${paceClause}`
    }
    if (progressPct === null) {
      return `${standing} against a ${goal} ${goalNoun}.${paceClause}`
    }
    const share =
      direction === 'lte'
        ? `${progressLabel(progressPct)} of the limit`
        : `${progressLabel(progressPct)} of target`
    return `${standing}, ${share}${elapsedClause}.${paceClause}`
  }

  if (movedWrongWay({ metric, direction, actual, baseline })) {
    const way = direction === 'gte' ? 'down' : 'up'
    const from = formatMetricValue(metric, baseline)
    return `${standing}, ${way} from ${from} at the start.${paceClause}`
  }
  if (progressPct === null) {
    return `${standing} against a ${goal} ${goalNoun}.${paceClause}`
  }
  const journey = `${progressLabel(progressPct)} of the way to ${goal}`
  if (baseline !== null && actual !== baseline) {
    const way = direction === 'gte' ? 'up' : 'down'
    const from = formatMetricValue(metric, baseline)
    return `${standing}, ${way} from ${from} at the start, ${journey}.${paceClause}`
  }
  return `${standing}, ${journey}.${paceClause}`
}
