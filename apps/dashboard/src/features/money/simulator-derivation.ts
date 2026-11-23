/**
 * Money → Simulator: the client-safe contract
 * shared by the tab (builds the input) and the canon projection engine
 * (computes the numbers). Pure types + pure derivation only — NO `@marginfront/db`
 * import, so this file is safe to bundle into the 'use client' tab. The tier
 * math lives EXCLUSIVELY in app/actions/_shared/pricing-projection.ts, which
 * runs server-side through calcRouted; nothing in here does pricing math.
 *
 * This is a DRY-RUN projection surface. It never writes an event or an invoice
 * and is entirely separate from the SDK Simulator (/developer-zone/sdk-
 * simulator, recordSdkUsage), which fires REAL billed events.
 */

import type { PricingPlan, PricingStrategy } from '@/app/actions/pricing-plans'

export type ProjectionChargeType =
  | 'usage'
  | 'recurring'
  | 'seat_based'
  | 'onetime'

export type ProjectionPricingModel =
  | 'flat'
  | 'volume'
  | 'graduated'
  | 'credit_pool'
  | null

export interface ProjectionTier {
  lower: number
  upper: number | null
  rate: number
}

/** The narrowed pricing-strategy shape the projection engine needs — a plain
 * data object with no methods, so it serializes across the server-action
 * boundary. Built from a real `PricingStrategy` by `toProjectionPlanInput`. */
export interface ProjectionStrategyInput {
  id: string
  /** Human label for the results table: the metered signal's name for usage
   * strategies, the strategy's own name for recurring/seat/one-time fees. */
  label: string
  chargeType: ProjectionChargeType
  pricingModel: ProjectionPricingModel
  rate: number | null
  tiers: ProjectionTier[] | null
  minimumCommitment: number | null
  signalId: string | null
}

export interface ProjectionPlanInput {
  /** A saved plan's id, or null for a hypothetical not-yet-created plan
   * (the engine handles either; there is no ad-hoc plan BUILDER UI). */
  planId: string | null
  planName: string
  strategies: ProjectionStrategyInput[]
}

export interface SimActivity {
  /** signalId → projected event quantity for ONE billing window. A signal
   * absent from the map projects as 0 (never undefined). */
  eventsBySignal: Record<string, number>
  /** seats for any seat-based strategy; ignored by usage-only plans. */
  seats: number
}

export interface ProjectionLineItem {
  strategyId: string
  label: string
  chargeType: ProjectionChargeType
  quantity: number
  /** What the customer is actually billed for: max(quantity, the strategy's
   * minimum commitment). Emitted for SEAT lines only —
   * usage strategies with minimums clamp their dollars but don't surface
   * billedQuantity. */
  billedQuantity?: number
  projected: number
}

export interface PlanProjection {
  planId: string | null
  planName: string
  lineItems: ProjectionLineItem[]
  /** Σ of every line item's projected revenue for the window. */
  revenueTotal: number
  /** The REAL infra cost of the input volume, present ONLY when a customer's
   * actual volume was pulled; null for manual/hypothetical input — a
   * hypothetical event has no cost basis, so cost renders '—',
   * never a fabricated number. */
  actualCost: number | null
  /** margin % from canon safeMarginPercent(revenue, revenue − cost); null
   * whenever actualCost is null. */
  marginPct: number | null
}

/** One meter the projected-events input asks the user to fill in. */
export interface UsageSignalRow {
  signalId: string
  label: string
}

/**
 * Map a real pricing plan (with its strategies, from getPricingPlans) into the
 * serializable projection contract. A plan whose strategies weren't loaded
 * (includeStrategies:false) projects as an empty plan — no strategies, $0 —
 * rather than throwing.
 */
export function toProjectionPlanInput(plan: PricingPlan): ProjectionPlanInput {
  const strategies = (plan.pricingStrategies ?? [])
    .filter((strategy) => strategy.active)
    .map(toProjectionStrategyInput)
  return { planId: plan.id, planName: plan.name, strategies }
}

function toProjectionStrategyInput(
  strategy: PricingStrategy
): ProjectionStrategyInput {
  return {
    id: strategy.id,
    label:
      strategy.chargeType === 'usage'
        ? (strategy.signal?.name ?? strategy.name)
        : strategy.name,
    chargeType: strategy.chargeType,
    pricingModel: strategy.pricingModel,
    rate: strategy.rate,
    tiers: strategy.tiers
      ? strategy.tiers.map((tier) => ({
          lower: tier.lower,
          upper: tier.upper,
          rate: tier.rate,
        }))
      : null,
    minimumCommitment: strategy.minimumCommitment,
    signalId: strategy.signalId,
  }
}

/**
 * The union of usage signals priced across the selected plans, deduped by
 * signalId — one input row per meter the user needs to project. A signal
 * priced by more than one plan (plan-vs-plan mode) appears once; its single
 * projected quantity feeds every plan's projection so a comparison is
 * apples-to-apples.
 */
export function usageSignalRows(
  plans: ProjectionPlanInput[]
): UsageSignalRow[] {
  const seen = new Set<string>()
  const rows: UsageSignalRow[] = []
  for (const plan of plans) {
    for (const strategy of plan.strategies) {
      if (strategy.chargeType !== 'usage' || strategy.signalId === null)
        continue
      if (seen.has(strategy.signalId)) continue
      seen.add(strategy.signalId)
      rows.push({ signalId: strategy.signalId, label: strategy.label })
    }
  }
  return rows
}

/** True when any selected plan has a seat-based strategy — the tab shows the
 * seats input only then, so a usage-only plan isn't cluttered by it. */
export function plansHaveSeatStrategy(plans: ProjectionPlanInput[]): boolean {
  return plans.some((plan) =>
    plan.strategies.some((strategy) => strategy.chargeType === 'seat_based')
  )
}

/**
 * Turn the raw text a user typed into projected-event boxes into a numeric
 * eventsBySignal map. Blank / non-numeric / negative entries clamp to 0 so a
 * half-typed box never NaNs the whole projection.
 */
export function eventsBySignalFromText(
  text: Record<string, string>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [signalId, raw] of Object.entries(text)) {
    const parsed = Number(raw)
    out[signalId] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return out
}
