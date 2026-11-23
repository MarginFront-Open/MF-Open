/**
 * Pure derivation of the MF IQ score.
 * Framework-free and node-testable: takes MfiqFacts (the five composed reads,
 * any fact group of which may be null after a source failure) plus `now`,
 * returns everything the page renders — the six scored rules, the fixes list,
 * the recommendations, the needs-attention items, and the subtitle.
 *
 * Honesty contract: a rule whose facts are null is
 * 'unknown' — its chip renders 'No data', it loses no points, emits no fix,
 * and the SCORE goes null (a partially-computed score is a lie of precision;
 * the rules list stays fully honest). An unknown is NEVER a fake Pass.
 */

import { formatCost } from '@/lib/canon-format'
import type { MfiqFacts } from '@/app/actions/mfiq-status'
import type { AlertListItem } from '@/features/dashboard-shell/tiles/alert-list'
import {
  mismatchedSignalsItem,
  costBackfillItem,
  missingVolumeItem,
  creditPoolItem,
} from '@/features/dashboard-shell/needs-attention'
import { closeDeadline } from '@/features/finops/close-derivation'

export type IqRuleStatus = 'pass' | 'review' | 'fail' | 'unknown'

export type IqRuleId =
  | 'eventsCosted'
  | 'glMapped'
  | 'categorized'
  | 'accountTypes'
  | 'closeSignedOff'
  | 'agentsProfitable'

export interface IqRule {
  id: IqRuleId
  /** Window-honest copy (money strings via canon-format). */
  text: string
  status: IqRuleStatus
  /** The pinned weight — what a fail costs. */
  points: number
}

/** Maps onto GaugeFix, href included. */
export interface IqFix {
  label: string
  points: number
  href: string
}

export interface DerivedIq {
  /** 10 − Σ points(fail); null when any rule is 'unknown'. */
  score: number | null
  maxScore: 10
  /** Always all 6, table order. */
  rules: IqRule[]
  /** Fail rules only; points DESC, then table order. */
  fixes: IqFix[]
  recommendations: AlertListItem[]
  needsAttention: AlertListItem[]
  subtitle: string | undefined
  unknownCount: number
}

/**
 * THE PINNED SCORING TABLE's weights (Σ = 10). Product
 * conventions, not derived truths — same class as CLOSE_WINDOW_DAYS. A
 * retune is a one-line diff here that deliberately breaks the
 * weight tripwire in iq-derivation.test.ts.
 */
export const IQ_RULE_POINTS: Record<IqRuleId, number> = {
  eventsCosted: 2,
  glMapped: 2,
  categorized: 2,
  accountTypes: 1,
  closeSignedOff: 2,
  agentsProfitable: 1,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

interface RuleEval {
  id: IqRuleId
  text: string
  status: IqRuleStatus
  fix?: { label: string; href: string }
}

export function deriveIqScore(facts: MfiqFacts, now: Date): DerivedIq {
  const {
    books,
    prevMonth,
    agents,
    backfillEvents,
    backfillModels = null,
    missingVolumeEvents,
    missingVolumeModels = null,
    lowCreditPools = null,
  } = facts

  const evals: RuleEval[] = []

  // R1 eventsCosted — current state ("right now"), both fix-loop queues.
  if (backfillEvents === null || missingVolumeEvents === null) {
    evals.push({
      id: 'eventsCosted',
      text: 'Every usage event has a cost',
      status: 'unknown',
    })
  } else {
    const uncostedEvents = backfillEvents + missingVolumeEvents
    evals.push({
      id: 'eventsCosted',
      text: 'Every usage event has a cost',
      status: uncostedEvents === 0 ? 'pass' : 'fail',
      fix:
        uncostedEvents === 0
          ? undefined
          : {
              label: `Backfill costs for ${uncostedEvents.toLocaleString()} event${uncostedEvents === 1 ? '' : 's'}`,
              href: '/build',
            },
    })
  }

  // R2 glMapped — current month. Fix label prefers the signal count; falls
  // back to the dollar amount on frozen snapshots that carry no count.
  if (books === null) {
    evals.push({
      id: 'glMapped',
      text: "This month's costs are mapped to GL codes",
      status: 'unknown',
    })
  } else {
    evals.push({
      id: 'glMapped',
      text: `${books.monthLabel} costs are mapped to GL codes`,
      status: books.unmappedAmount === 0 ? 'pass' : 'fail',
      fix:
        books.unmappedAmount === 0
          ? undefined
          : {
              label:
                books.unmappedSignalCount !== null
                  ? `Map ${books.unmappedSignalCount.toLocaleString()} unmapped signal${books.unmappedSignalCount === 1 ? '' : 's'}`
                  : `Map ${formatCost(books.unmappedAmount)} of unmapped cost`,
              href: '/finops',
            },
    })
  }

  // R3 categorized — current month.
  if (books === null) {
    evals.push({
      id: 'categorized',
      text: "This month's costs are categorized (COGS / R&D)",
      status: 'unknown',
    })
  } else {
    evals.push({
      id: 'categorized',
      text: `${books.monthLabel} costs are categorized (COGS / R&D)`,
      status: books.unclassifiedCost === 0 ? 'pass' : 'fail',
      fix:
        books.unclassifiedCost === 0
          ? undefined
          : {
              label: `Categorize ${formatCost(books.unclassifiedCost)} of cost`,
              href: '/finops',
            },
    })
  }

  // R4 accountTypes — current state (no window in copy).
  if (books === null) {
    evals.push({
      id: 'accountTypes',
      text: 'Signals are booked to the right account type',
      status: 'unknown',
    })
  } else {
    evals.push({
      id: 'accountTypes',
      text: 'Signals are booked to the right account type',
      status: books.mismatchedSignalCount === 0 ? 'pass' : 'fail',
      fix:
        books.mismatchedSignalCount === 0
          ? undefined
          : {
              label: `Fix ${books.mismatchedSignalCount.toLocaleString()} account-type mismatch${books.mismatchedSignalCount === 1 ? '' : 'es'}`,
              href: '/finops',
            },
    })
  }

  // R5 closeSignedOff — previous month. review = unlocked but still inside
  // the close window (closeDeadline + 1 day — the shared close-derivation
  // arithmetic); fail = unlocked and past it.
  if (prevMonth === null) {
    evals.push({
      id: 'closeSignedOff',
      text: "The previous month's close is signed off",
      status: 'unknown',
    })
  } else if (prevMonth.locked) {
    evals.push({
      id: 'closeSignedOff',
      text: `The ${prevMonth.monthLabel} close is signed off`,
      status: 'pass',
    })
  } else if (
    now.getTime() <
    closeDeadline(prevMonth.periodEndIso) + MS_PER_DAY
  ) {
    evals.push({
      id: 'closeSignedOff',
      text: `The ${prevMonth.monthLabel} close is signed off`,
      status: 'review',
    })
  } else {
    evals.push({
      id: 'closeSignedOff',
      text: `The ${prevMonth.monthLabel} close is signed off`,
      status: 'fail',
      fix: {
        label: `Sign off the ${prevMonth.monthLabel} close`,
        href: '/finops',
      },
    })
  }

  // R6 agentsProfitable — rolling 30 days. Live rows only: the agentId-null
  // 'Deleted agents' catch-all is excluded (you can't reprice a deleted
  // agent). review = recording cost but billing nothing (advisory only).
  if (agents === null) {
    evals.push({
      id: 'agentsProfitable',
      text: 'Agents are priced above cost',
      status: 'unknown',
    })
  } else {
    const liveRows = agents.rows.filter((row) => row.agentId !== null)
    const negativeMarginRows = liveRows.filter(
      (row) =>
        row.earned > 0 && row.marginPercent !== null && row.marginPercent < 0
    )
    const costWithoutEarningsRows = liveRows.filter(
      (row) => row.cost > 0 && row.earned === 0
    )
    evals.push({
      id: 'agentsProfitable',
      text: `Agents are priced above cost (${agents.windowLabel})`,
      status:
        negativeMarginRows.length > 0
          ? 'fail'
          : costWithoutEarningsRows.length > 0
            ? 'review'
            : 'pass',
      fix:
        negativeMarginRows.length === 0
          ? undefined
          : {
              label:
                negativeMarginRows.length === 1
                  ? `Reprice ${negativeMarginRows[0].name}`
                  : `Reprice ${negativeMarginRows.length.toLocaleString()} agents earning less than they cost`,
              href: '/build',
            },
    })
  }

  const rules: IqRule[] = evals.map((ruleEval) => ({
    id: ruleEval.id,
    text: ruleEval.text,
    status: ruleEval.status,
    points: IQ_RULE_POINTS[ruleEval.id],
  }))

  const unknownCount = rules.filter((rule) => rule.status === 'unknown').length

  const score =
    unknownCount > 0
      ? null
      : 10 -
        rules
          .filter((rule) => rule.status === 'fail')
          .reduce((lost, rule) => lost + rule.points, 0)

  // Array.prototype.sort is stable, so equal-point fixes keep table order.
  const fixes: IqFix[] = evals
    .filter(
      (
        ruleEval
      ): ruleEval is RuleEval & { fix: { label: string; href: string } } =>
        ruleEval.status === 'fail' && ruleEval.fix !== undefined
    )
    .map((ruleEval) => ({
      label: ruleEval.fix.label,
      points: IQ_RULE_POINTS[ruleEval.id],
      href: ruleEval.fix.href,
    }))
    .sort((a, b) => b.points - a.points)

  // Derived, never fabricated. Item 1 is the wrong-side-of-
  // margin warning (the same guard chart-of-accounts.ts applies); item 2
  // says what unmapped GL truly breaks (the P&L category split, NOT org
  // margin, which reconciles by construction). There is no week-over-week
  // spike recommendation.
  const recommendations: AlertListItem[] = []
  if (books !== null && books.mismatchedSignalCount > 0) {
    const mismatched = books.mismatchedSignalCount
    recommendations.push({
      severity: 'amber',
      text: `${mismatched.toLocaleString()} signal${mismatched === 1 ? '' : 's'} booked to the wrong account type ${mismatched === 1 ? 'puts' : 'put'} real cost on the wrong side of the gross-margin line.`,
      href: '/finops',
    })
  }
  if (books !== null && books.unmappedAmount > 0) {
    recommendations.push({
      severity: 'amber',
      text: `${formatCost(books.unmappedAmount)} of ${books.monthLabel} cost is sitting in the Unmapped clearing bucket with no GL code.`,
      href: '/finops',
    })
  }

  // The needs-attention items. Copy comes from the ONE
  // shared builder per item (never forked); only the href is overridden to
  // the OWNING page.
  const needsAttention: AlertListItem[] = []
  if (books !== null && books.mismatchedSignalCount > 0) {
    needsAttention.push({
      ...mismatchedSignalsItem(books.mismatchedSignalCount),
      href: '/finops',
    })
  }
  if (
    backfillEvents !== null &&
    backfillModels !== null &&
    backfillModels > 0
  ) {
    needsAttention.push({
      ...costBackfillItem(backfillModels, backfillEvents),
      href: '/build',
    })
  }
  if (
    missingVolumeEvents !== null &&
    missingVolumeModels !== null &&
    missingVolumeModels > 0
  ) {
    needsAttention.push({
      ...missingVolumeItem(missingVolumeModels, missingVolumeEvents),
      href: '/build',
    })
  }
  // The one row with no href override: its owning page IS the
  // credit-pool tab, already the builder's default.
  if (lowCreditPools !== null && lowCreditPools > 0) {
    needsAttention.push(creditPoolItem(lowCreditPools))
  }

  // A fixes count, not a "last updated" line: the score is computed per
  // request, so it is never stale.
  const subtitle =
    fixes.length > 0
      ? `${fixes.length} fix${fixes.length === 1 ? '' : 'es'} available`
      : score === 10
        ? 'All rules passing'
        : undefined

  return {
    score,
    maxScore: 10,
    rules,
    fixes,
    recommendations,
    needsAttention,
    subtitle,
    unknownCount,
  }
}
