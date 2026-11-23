/**
 * The canon dry-run pricing PROJECTION engine.
 *
 * "Given this pricing plan and this level of activity, what would it earn?" —
 * computed with ZERO writes, purely through the canonical revenue library
 * (calcUsageRevenue / calcRecurringRevenue / calcSeatRevenue / calcOnetime-
 * Revenue → calcRouted + the R3 tier engine in @marginfront/db). There is no tier
 * or rate math in this file; every dollar comes back from a canon call, so a
 * projection can never disagree with what the billing pipeline would actually
 * charge.
 *
 * NOT 'use server' and it imports the Prisma-backed @marginfront/db barrel, so it
 * is SERVER-ONLY (never bundle into a client) — the same shape as
 * per-event-earned.ts. The 'use server' wrapper is simulate-pricing.ts. It
 * takes only caller-supplied numbers (no DB, no I/O), which is what makes the
 * dry-run guarantee trivially auditable: a module that never touches `db`
 * cannot write.
 *
 * This is entirely separate from the SDK Simulator (recordSdkUsage), which
 * fires REAL billed events. Nothing here records anything.
 */

import {
  applyMinCommitment,
  calcUsageRevenue,
  calcRecurringRevenue,
  calcSeatRevenue,
  calcOnetimeRevenue,
  safeMarginPercent,
  type CalcStrategy,
} from '@marginfront/db'
import type {
  PlanProjection,
  ProjectionLineItem,
  ProjectionPlanInput,
  ProjectionStrategyInput,
  SimActivity,
} from '@/features/money/simulator-derivation'

// Recurring / seat / one-time fees are projected for ONE billing period. In
// MANUAL mode the entered volume IS a per-window quantity, so a factor of 1
// keeps the whole projection on one "billing window" basis. CAVEAT for
// customer-actual mode: pulled volume + cost span the page date window
// (default 30d ~= one monthly cycle, coherent); on a 7d/90d window the usage
// basis and this one-cycle recurring/seat basis diverge.
const ONE_BILLING_PERIOD = 1

// One-time (setup) fees only charge when the subscription's start date lands
// inside the reporting window (canon calcOnetimeRevenue). A projection assumes
// "this subscription starts inside the window", so we hand the canon fee
// function a window that straddles a fixed synthetic start — routing the fee
// through the exact canon path instead of re-deriving "charge it once".
const SYNTHETIC_SUB_START = new Date(0)
const OPEN_WINDOW_START = new Date(0)
const OPEN_WINDOW_END = new Date(8640000000000000)

function toCalcStrategy(strategy: ProjectionStrategyInput): CalcStrategy {
  return {
    id: strategy.id,
    chargeType: strategy.chargeType,
    pricingModel: strategy.pricingModel,
    rate: strategy.rate,
    tiers: (strategy.tiers ?? []).map((tier) => ({
      lower: tier.lower,
      upper: tier.upper,
      rate: tier.rate,
    })),
    minimumCommitment: strategy.minimumCommitment,
    signalId: strategy.signalId,
  }
}

/** Route one strategy through its canon fee function by charge type. */
function projectStrategy(
  strategy: ProjectionStrategyInput,
  activity: SimActivity
): { quantity: number; billedQuantity?: number; projected: number } {
  const calc = toCalcStrategy(strategy)
  switch (strategy.chargeType) {
    case 'usage': {
      const quantity =
        strategy.signalId !== null
          ? (activity.eventsBySignal[strategy.signalId] ?? 0)
          : 0
      return { quantity, projected: calcUsageRevenue(calc, quantity) }
    }
    case 'recurring':
      return {
        quantity: ONE_BILLING_PERIOD,
        projected: calcRecurringRevenue(calc, ONE_BILLING_PERIOD),
      }
    case 'seat_based':
      // billedQuantity is the same clamp calcSeatRevenue applies to the
      // dollars (canon R2) — surfaced so the UI can show WHY 5 entered
      // seats project at the 10-seat minimum's price.
      return {
        quantity: activity.seats,
        billedQuantity: applyMinCommitment(
          activity.seats,
          calc.minimumCommitment
        ),
        projected: calcSeatRevenue(calc, activity.seats, ONE_BILLING_PERIOD),
      }
    case 'onetime':
      return {
        quantity: 1,
        projected: calcOnetimeRevenue(
          calc,
          SYNTHETIC_SUB_START,
          OPEN_WINDOW_START,
          OPEN_WINDOW_END
        ),
      }
    default:
      // Every charge type must have a case above. If a new one is added to the
      // enum, this fails at compile — a projection must never silently drop a
      // fee to $0.
      strategy.chargeType satisfies never
      return { quantity: 0, projected: 0 }
  }
}

/**
 * Project one plan's revenue for the given activity, plus margin against a
 * REAL cost when one was supplied (customer-actual mode).
 *
 * @param actualCost the measured infra cost of the input volume, or null for
 *   manual/hypothetical input. Margin is only meaningful against a real cost,
 *   so it stays null otherwise (canon M2 — never a fabricated percent).
 */
export function projectPlanRevenue(
  plan: ProjectionPlanInput,
  activity: SimActivity,
  actualCost: number | null
): PlanProjection {
  const lineItems: ProjectionLineItem[] = plan.strategies.map((strategy) => {
    const { quantity, billedQuantity, projected } = projectStrategy(
      strategy,
      activity
    )
    return {
      strategyId: strategy.id,
      label: strategy.label,
      chargeType: strategy.chargeType,
      quantity,
      billedQuantity,
      projected,
    }
  })

  const revenueTotal = lineItems.reduce((sum, item) => sum + item.projected, 0)

  // Margin dollars = revenue − cost is the canon definition safeMarginPercent
  // consumes (its 2nd arg is margin, not cost — see revenue-metrics.ts, which
  // calls it the same way with revenue − totalCost).
  const marginPct =
    actualCost === null
      ? null
      : safeMarginPercent(revenueTotal, revenueTotal - actualCost)

  return {
    planId: plan.planId,
    planName: plan.planName,
    lineItems,
    revenueTotal,
    actualCost,
    marginPct,
  }
}
