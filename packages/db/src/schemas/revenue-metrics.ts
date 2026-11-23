/**
 * Revenue Metrics — Zod schemas + TS types for the canonical revenue library.
 *
 * Every dollar-valued surface in the dashboard ultimately passes data shaped
 * by these schemas. This is the only place {revenue, cost, margin, billed,
 * collected, mrr} types are defined across the monorepo.
 *
 * Why Zod and not bare TS interfaces:
 *   - Server Actions serialize to JSON across the client boundary. When the
 *     client re-parses, `z.infer<typeof RevenueMetricsSchema>` gives the same
 *     static type, AND calling `.parse(payload)` catches drift at runtime.
 *   - A dashboard ESLint rule (no-restricted-syntax) stops action files from
 *     hand-building {earned, billed, collected} literals, so they compose
 *     these canonical shapes and no "similar-enough" shape gets invented.
 *
 * Dollar amounts are plain numbers (full precision, not rounded). Formatters
 * at the UI layer round to 2 decimals exactly once per R4.
 */
import { z } from "zod";

/**
 * Charge types. Must match Prisma enum `enum_pricing_strategies_chargeType`.
 * Snake_case end to end: DB, Prisma, HTTP, SDK, MCP, dashboard all use
 * the same `seat_based` form.
 */
export const ChargeTypeSchema = z.enum([
  "usage",
  "recurring",
  "seat_based",
  "onetime",
]);
export type ChargeType = z.infer<typeof ChargeTypeSchema>;

export const PricingModelSchema = z.enum([
  "flat",
  "graduated",
  "volume",
  "credit_pool",
]);
export type PricingModel = z.infer<typeof PricingModelSchema>;

/**
 * Per-subscription breakdown — one entry per active subscription in scope.
 * Callers that need customer/subscription detail pages slice this array.
 */
export const SubscriptionRevenueSchema = z.object({
  subscriptionId: z.string().uuid(),
  customerId: z.string().uuid(),
  agentId: z.string().uuid(),
  planId: z.string().uuid(),
  revenue: z.number(),
  cost: z.number(),
  margin: z.number(),
  usageRevenue: z.number(),
  recurringRevenue: z.number(),
  seatRevenue: z.number(),
  onetimeRevenue: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type SubscriptionRevenue = z.infer<typeof SubscriptionRevenueSchema>;

/**
 * Per-strategy breakdown — one entry per pricing strategy that contributed
 * revenue in the window. Feeds the revenue-by-type donut (usage/recurring/
 * seat/onetime slices) and the revenue simulator's strategy-level detail.
 */
export const StrategyRevenueSchema = z.object({
  strategyId: z.string().uuid(),
  chargeType: ChargeTypeSchema,
  pricingModel: PricingModelSchema.nullable(),
  signalId: z.string().uuid().nullable(),
  revenue: z.number(),
  /** For usage strategies: SUM(quantity) in the window. 0 for non-usage. */
  quantity: z.number(),
});
export type StrategyRevenue = z.infer<typeof StrategyRevenueSchema>;

/**
 * The single canonical return shape. Every Earned / Revenue-by-type / Margin
 * / Gross-margin-% surface in the dashboard is fed by this object.
 *
 * marginPercent is nullable (rendered as "—") when revenue === 0, never 0%,
 * never NaN%, never Infinity% — per canon M1.
 */
export const RevenueMetricsSchema = z.object({
  revenue: z.number(),
  cost: z.number(),
  margin: z.number(),
  marginPercent: z.number().nullable(),

  usageRevenue: z.number(),
  recurringRevenue: z.number(),
  seatRevenue: z.number(),
  onetimeRevenue: z.number(),

  eventCount: z.number().int().nonnegative(),
  /** Events with `usageCost IS NULL` — counted in eventCount, excluded from cost, surface "needs attention". Per C1. */
  eventCountWithNullCost: z.number().int().nonnegative(),

  bySubscription: z.array(SubscriptionRevenueSchema),
  byStrategy: z.array(StrategyRevenueSchema),
});
export type RevenueMetrics = z.infer<typeof RevenueMetricsSchema>;

/**
 * Invoice totals for the window. Separate from RevenueMetrics because these
 * are realized (invoice-materialized) amounts, not the revenue formula.
 * Per I1, non-draft invoices reconcile to RevenueMetrics by construction —
 * so billed/collected/outstanding are consumable directly without re-deriving
 * from the revenue formula.
 */
export const InvoiceTotalsSchema = z.object({
  /** I2 + I3 (ACCRUAL): SUM(totalAmount) WHERE status IN ('issued','overdue') AND invoiceDate ∈ window */
  billed: z.number(),
  /** I3 payment-date variant (CASH): SUM(invoice_payments.amount − refunded_amount) WHERE payment.status = 'succeeded' AND paymentDate ∈ window. Counts cash by the day it actually landed, not by invoice date. */
  collected: z.number(),
  /** I2: SUM(totalAmount) WHERE status = 'draft' AND invoiceDate ∈ window (inventory only, never billed) */
  draft: z.number(),
  /** CURRENT-STATE open A/R: SUM(totalAmount) WHERE status IN ('issued','overdue'), no date window. NOT billed − collected (those use different bases, accrual vs cash, so the subtraction can go negative). Always ≥ 0 and ≥ overdueAmount. */
  outstanding: z.number(),
  /** Current-state (no date filter). SUM(totalAmount) WHERE status = 'overdue'. Subset of `outstanding`. */
  overdueAmount: z.number(),
  overdueCount: z.number().int().nonnegative(),
  /** COUNT WHERE status IN ('issued','paid','overdue') AND invoiceDate ∈ window */
  invoicesSentCount: z.number().int().nonnegative(),
  /** SUM(invoice_payments.refunded_amount) for the succeeded payments counted in `collected` this window. The gross refund amount that was netted out of `collected`. Used by detail pages to render "Refunded: $X" callouts. */
  refunded: z.number(),
});
export type InvoiceTotals = z.infer<typeof InvoiceTotalsSchema>;

/**
 * MRR per canon MRR1 — industry-standard "current active recurring contract
 * value." Sum of (rate / monthlyDivisor) across every active subscription's
 * recurring + seat-based pricing strategies. Excludes usage (see MRR2) and
 * one-time fees. ARR = MRR × 12.
 *
 * It is not a "prior-calendar-month invoice total", which would be wrong
 * for any sub whose billing cycle hasn't closed yet and for any sub that
 * churned this month.
 */
export const MrrSchema = z.object({
  mrr: z.number(),
  arr: z.number(),
});
export type Mrr = z.infer<typeof MrrSchema>;

// ─── Agent-Earned ──────────────────────────────────────────────────────────
//
// "Agent-Earned" = pure activity per canon R1: events × pricing-strategy rate.
// No recurring fees, no seat fees, no prorations, no onetime. This is what
// shows up in the Earned stage of the Earned → Billed → Collected funnel.

/** Per-strategy breakdown for Agent-Earned. One row per usage strategy that produced revenue in the window. */
export const AgentEarnedStrategyRowSchema = z.object({
  strategyId: z.string().uuid(),
  pricingModel: PricingModelSchema.nullable(),
  signalId: z.string().uuid().nullable(),
  /** Events × rate routed through pricingModel (flat/graduated/volume). */
  revenue: z.number(),
  /** SUM(signal_events.quantity) for this strategy's signal in the window. */
  quantity: z.number(),
});
export type AgentEarnedStrategyRow = z.infer<
  typeof AgentEarnedStrategyRowSchema
>;

/** Per-subscription breakdown for Agent-Earned — activity revenue per sub. */
export const AgentEarnedSubscriptionRowSchema = z.object({
  subscriptionId: z.string().uuid(),
  customerId: z.string().uuid(),
  agentId: z.string().uuid(),
  planId: z.string().uuid(),
  revenue: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type AgentEarnedSubscriptionRow = z.infer<
  typeof AgentEarnedSubscriptionRowSchema
>;

export const AgentEarnedSchema = z.object({
  /** Total activity-only revenue for the window. Canon R1. */
  revenue: z.number(),
  /** Events that produced revenue (usage events attributable to a usage strategy). */
  eventCount: z.number().int().nonnegative(),
  bySubscription: z.array(AgentEarnedSubscriptionRowSchema),
  byStrategy: z.array(AgentEarnedStrategyRowSchema),
});
export type AgentEarned = z.infer<typeof AgentEarnedSchema>;

// ─── Cost Metrics ──────────────────────────────────────────────────────────
//
// Cost is independent of subscription attribution per canon C1 — an event has
// a customerId + agentId + signalId + usageCost, and that's all we need. The
// Cost Tracking dashboard mode works off this data alone; no pricing plan
// required.

export const CostByAgentRowSchema = z.object({
  agentId: z.string().uuid(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByAgentRow = z.infer<typeof CostByAgentRowSchema>;

export const CostByCustomerRowSchema = z.object({
  customerId: z.string().uuid(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByCustomerRow = z.infer<typeof CostByCustomerRowSchema>;

export const CostBySignalRowSchema = z.object({
  signalId: z.string().uuid().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostBySignalRow = z.infer<typeof CostBySignalRowSchema>;

/**
 * Daily cost bucket — one row per UTC day that had activity in the window.
 * `date` is UTC midnight (the day boundary), enforced by Math.floor(ms / MS_PER_DAY)
 * bucketing in getCostMetrics per canon W1 (UTC-based windowing).
 */
export const CostByDayRowSchema = z.object({
  date: z.date(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByDayRow = z.infer<typeof CostByDayRowSchema>;

/**
 * Cost grouped by pricing plan. `planId: null` captures orphan events — events
 * without a subscription (or whose sub was deleted) — which still contribute
 * to cost per canon C1. Null rows sort last.
 */
export const CostByPlanRowSchema = z.object({
  planId: z.string().uuid().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByPlanRow = z.infer<typeof CostByPlanRowSchema>;

/**
 * Cost grouped by LLM model name (from raw_ingest_events.payload.model).
 * `model: null` covers non-LLM events and LLM events missing the model field.
 * Null rows sort last.
 */
export const CostByModelRowSchema = z.object({
  model: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByModelRow = z.infer<typeof CostByModelRowSchema>;

/**
 * Cost grouped by git repo ("owner/repo", from signal_events.metadata.repo —
 * stamped by the code-cost-clarity meter on internal coding events). `repo: null`
 * covers events with no repo recorded: meters that send none, non-git sessions,
 * and events from other sources. Null rows sort last.
 */
export const CostByRepoRowSchema = z.object({
  repo: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByRepoRow = z.infer<typeof CostByRepoRowSchema>;

/**
 * Cost grouped by git branch. `branch` is the COMPOSITE key
 * "<repo>#<branch>" (see lib/git-coordinates.ts) so 'main' in two repos stays
 * two rows; an event with a branch but no repo keys as "#<branch>".
 * `branch: null` covers events with no branch recorded (meters that send none,
 * detached HEAD, non-git sessions). Null rows sort last.
 */
export const CostByBranchRowSchema = z.object({
  branch: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByBranchRow = z.infer<typeof CostByBranchRowSchema>;

/**
 * Cost grouped by accounting classification (signals.costCategory). Drives
 * the COGS vs R&D split on the Cost Management dashboard. The category
 * values are the four `enum_signals_costCategory` members; events whose
 * signal is gone (orphan) bucket to `UNCLASSIFIED`.
 */
export const CostByCostCategoryRowSchema = z.object({
  costCategory: z.enum([
    "PRODUCTION_COGS",
    "DEVELOPMENT_RD",
    "SALES_SM",
    "GENERAL_GA",
    "INTERNAL_TOOL",
    "UNCLASSIFIED",
  ]),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByCostCategoryRow = z.infer<typeof CostByCostCategoryRowSchema>;

/**
 * Cost grouped by event environment (signal_events.environment). `environment:
 * null` covers events sent without the field. Drives
 * environment-scoped filtering on the Cost Management dashboard.
 */
export const CostByEnvironmentRowSchema = z.object({
  environment: z
    .enum(["production", "staging", "development", "testing"])
    .nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostByEnvironmentRow = z.infer<typeof CostByEnvironmentRowSchema>;

/**
 * CostMetrics is self-referential via the optional `prior` field used for
 * trend computation. A named interface plus `z.lazy` is the standard pattern
 * for expressing recursion to both TypeScript and Zod — raw `z.infer` on a
 * recursive schema does not work cleanly.
 */
export interface CostMetrics {
  cost: number;
  eventCount: number;
  eventCountWithNullCost: number;
  byAgent: CostByAgentRow[];
  byCustomer: CostByCustomerRow[];
  bySignal: CostBySignalRow[];
  byDay: CostByDayRow[];
  byPlan: CostByPlanRow[];
  byModel: CostByModelRow[];
  byRepo: CostByRepoRow[];
  byBranch: CostByBranchRow[];
  byCostCategory: CostByCostCategoryRow[];
  byEnvironment: CostByEnvironmentRow[];
  /** Populated only when the caller passes `options.priorWindow` to getCostMetrics. */
  prior?: Omit<CostMetrics, "prior">;
}

const CostMetricsBaseSchema = z.object({
  /** SUM(signal_events.usageCost) for the window. Null contributions count as 0 but surface in eventCountWithNullCost. */
  cost: z.number(),
  /** All events in window, including those with NULL usageCost. */
  eventCount: z.number().int().nonnegative(),
  /** Events with usageCost IS NULL — "needs attention" indicator. Per C1. */
  eventCountWithNullCost: z.number().int().nonnegative(),
  byAgent: z.array(CostByAgentRowSchema),
  byCustomer: z.array(CostByCustomerRowSchema),
  bySignal: z.array(CostBySignalRowSchema),
  byDay: z.array(CostByDayRowSchema),
  byPlan: z.array(CostByPlanRowSchema),
  byModel: z.array(CostByModelRowSchema),
  byRepo: z.array(CostByRepoRowSchema),
  byBranch: z.array(CostByBranchRowSchema),
  byCostCategory: z.array(CostByCostCategoryRowSchema),
  byEnvironment: z.array(CostByEnvironmentRowSchema),
});

export const CostMetricsSchema: z.ZodType<CostMetrics> =
  CostMetricsBaseSchema.extend({
    prior: z.lazy(() => CostMetricsBaseSchema).optional(),
  });

/**
 * Window inputs. Computed ONCE per request in UTC (canon W1) and threaded
 * to every call — callers never re-derive inside tiles.
 */
export const RevenueWindowSchema = z.object({
  start: z.date(),
  end: z.date(),
});
export type RevenueWindow = z.infer<typeof RevenueWindowSchema>;

export const RevenueFiltersSchema = z.object({
  customerId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  signalId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
});
export type RevenueFilters = z.infer<typeof RevenueFiltersSchema>;

// ─── Run-Rate MRR (MRR2) + Committed MRR (MRR3) ────────────────────────────
//
// MRR1 (canon MRR) is the contracted recurring floor — active subs'
// recurring + seat strategies, monthly-normalized. MRR2 + MRR3 layer usage
// lenses on top.
//
//   MRR2 (Run-Rate): "what would we bill per month if the last 30 days of
//     activity kept going?" — contract commitments plus actual 30-day usage,
//     monthly-normalized.
//   MRR3 (Committed CMRR): "what is the contractual floor regardless of
//     usage?" — same shape as MRR2 but usage is replaced with
//     strategy.minimumCommitment × rate (0 when no minimum is set).
//
// Both accept a { customerId } or { subscriptionId } filter so the customer
// detail page can scope to one customer's subs and the subscription detail
// page can scope to one sub.

export const RunRateMrrBreakdownRowSchema = z.object({
  subscriptionId: z.string().uuid(),
  customerId: z.string().uuid(),
  agentId: z.string().uuid(),
  planId: z.string().uuid(),
  /** Recurring fees monthly-normalized (divide by 12 if sub is yearly). */
  recurring: z.number(),
  /** Seat fees: max(seatsCount, minCommit) × rate, monthly-normalized. */
  seatBased: z.number(),
  /** Usage: actual last-30-days events through calcRouted(strategy, qty). */
  usage: z.number(),
  /** Sum of the three above — this sub's run-rate MRR contribution. */
  total: z.number(),
});
export type RunRateMrrBreakdownRow = z.infer<
  typeof RunRateMrrBreakdownRowSchema
>;

export const RunRateMrrResultSchema = z.object({
  mrr: z.number(),
  breakdown: z.array(RunRateMrrBreakdownRowSchema),
});
export type RunRateMrrResult = z.infer<typeof RunRateMrrResultSchema>;

export const CommittedMrrBreakdownRowSchema = z.object({
  subscriptionId: z.string().uuid(),
  customerId: z.string().uuid(),
  agentId: z.string().uuid(),
  planId: z.string().uuid(),
  recurring: z.number(),
  seatBased: z.number(),
  /** Usage floor: calcRouted(strategy, minimumCommitment) — 0 when no min. */
  usage: z.number(),
  total: z.number(),
});
export type CommittedMrrBreakdownRow = z.infer<
  typeof CommittedMrrBreakdownRowSchema
>;

export const CommittedMrrResultSchema = z.object({
  mrr: z.number(),
  breakdown: z.array(CommittedMrrBreakdownRowSchema),
});
export type CommittedMrrResult = z.infer<typeof CommittedMrrResultSchema>;

/** Filters accepted by getRunRateMrr + getCommittedMrr. */
export const MrrFiltersSchema = z.object({
  customerId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
});
export type MrrFilters = z.infer<typeof MrrFiltersSchema>;
