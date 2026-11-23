/**
 * Cost-grouping (getCostBreakdown) — Zod schemas + TS types.
 *
 * SQL twin of CostMetrics (./revenue-metrics.ts): same totals semantics
 * (canon C1/C2), but grouping happens in Postgres and one dimension is
 * returned per call instead of all eight.
 *
 * Rollup seam: nothing in this shape names signal_events or carries
 * raw-event fields (no event ids, no payload passthrough), so the SQL source
 * can change (to a daily rollup table, say) without touching these types or
 * any consumer.
 */
import { z } from "zod";
import { CostByDayRowSchema } from "./revenue-metrics";

/**
 * The eight groupable dimensions. Keys mirror the by* arrays on CostMetrics
 * (byAgent → 'agent', byCostCategory → 'costCategory', ...). Used as lookup
 * keys into the closed SQL-fragment registry in lib/cost-grouping.ts —
 * never spliced into SQL.
 */
export const DimensionSchema = z.enum([
  "agent",
  "customer",
  "signal",
  "day",
  "plan",
  "model",
  "costCategory",
  "environment",
]);
export type Dimension = z.infer<typeof DimensionSchema>;

/**
 * One grouped bucket. `key` is the dimension value rendered as text:
 *   - agent/customer/signal/plan → the UUID
 *   - day → 'YYYY-MM-DD' (UTC day)
 *   - model → raw_ingest_events.payload.model
 *   - costCategory → enum value ('UNCLASSIFIED' covers orphan events)
 *   - environment → enum value
 * `key: null` is a real bucket (orphan signal/plan, missing model,
 * missing environment), same null-bucket semantics as CostMetrics.
 */
export const BreakdownRowSchema = z.object({
  key: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  /** Present only when asked for; see the same field on the totals below. */
  eventCountFinishedWork: z.number().int().nonnegative().optional(),
});
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;

/** Window totals — same C1 semantics as CostMetrics' top-level fields. */
export const CostBreakdownTotalsSchema = z.object({
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  /** Events with usageCost IS NULL — counted in eventCount, 0 in cost. Per C1. */
  eventCountWithNullCost: z.number().int().nonnegative(),
  /**
   * The subset of eventCount a customer recorded as a finished thing. ABSENT,
   * not zero, unless the caller passed the finishedWork option: a caller who
   * did not ask gets no finished-work fields.
   */
  eventCountFinishedWork: z.number().int().nonnegative().optional(),
});
export type CostBreakdownTotals = z.infer<typeof CostBreakdownTotalsSchema>;

/**
 * The group key case-folds and trims; `name` is the casing the EARLIEST record
 * used, so "Contract summarized" and "contract summarized" are one row shown one way.
 * `label` '' is a real bucket (work done outside a work item), not a missing
 * value; it is the work item resolved for the event, falling back to
 * the raw tag the client sent when nothing resolved.
 */
export const FinishedThingRowSchema = z.object({
  name: z.string(),
  agentId: z.string().nullable(),
  customerExternalId: z.string(),
  label: z.string(),
  /** SUM(quantity), never COUNT(*): one record can carry a count of five. */
  howMany: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type FinishedThingRow = z.infer<typeof FinishedThingRowSchema>;

/**
 * The CODING-TURN spend a bucket of finished things is split across. The bucket
 * is (developer, work-item label); `agentId` is the slice, so the caller sums
 * the slices in scope and one bucket can arrive as several rows. Coding-turn
 * only is what keeps these rows and the named ones below disjoint.
 *
 * `eventCount` 0 is the load-bearing case — it renders a dash, never a $0 and
 * never a share of the org total.
 */
export const FinishedWorkBucketRowSchema = z.object({
  customerExternalId: z.string(),
  label: z.string(),
  agentId: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  eventCountWithNullCost: z.number().int().nonnegative(),
});
export type FinishedWorkBucketRow = z.infer<typeof FinishedWorkBucketRowSchema>;

/**
 * A named signal from an integration that is not the coding meter. Count and
 * cost are both measured, so it needs no attribution — it shares the table
 * with recorded finished things because a customer asking "what did we
 * finish" means both.
 */
export const NamedUsageRowSchema = z.object({
  name: z.string(),
  agentId: z.string().nullable(),
  howMany: z.number(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  eventCountWithNullCost: z.number().int().nonnegative(),
});
export type NamedUsageRow = z.infer<typeof NamedUsageRowSchema>;

/** The three finished-work lists, read in the same snapshot as the Cost tile. */
export const CostBreakdownFinishedWorkSchema = z.object({
  things: z.array(FinishedThingRowSchema),
  buckets: z.array(FinishedWorkBucketRowSchema),
  namedUsage: z.array(NamedUsageRowSchema),
});
export type CostBreakdownFinishedWork = z.infer<
  typeof CostBreakdownFinishedWorkSchema
>;

/** Aggregate of every grouped bucket NOT on the returned page ("Other"). */
export const CostBreakdownOtherSchema = z.object({
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});
export type CostBreakdownOther = z.infer<typeof CostBreakdownOtherSchema>;

/**
 * One matter-scoped cost bucket (getMatterCostRollups). `matterId: null` is
 * the Unassigned bucket — events with no matter — not a missing value.
 * C1 semantics: null usageCost adds 0 to `cost`, still counts in
 * `eventCount`, and surfaces in `eventsMissingCost`; never silently zeroed.
 */
export const MatterCostRollupSchema = z.object({
  matterId: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  eventsMissingCost: z.number().int().nonnegative(),
});
export type MatterCostRollup = z.infer<typeof MatterCostRollupSchema>;

/**
 * getCostBreakdown's return shape. Invariant by construction (one WHERE
 * fragment, one transaction snapshot):
 *   totals.cost === Σ series[].cost === Σ rows[].cost + (other?.cost ?? 0)
 * and the same for eventCount.
 */
export const CostBreakdownSchema = z.object({
  totals: CostBreakdownTotalsSchema,
  /** Always day-grain regardless of `dimension` — feeds the chart. */
  series: z.array(CostByDayRowSchema),
  /** One page of GROUP BY <dimension> buckets, ORDER BY cost DESC. */
  rows: z.array(BreakdownRowSchema),
  /** Total bucket count across all pages. */
  totalRowCount: z.number().int().nonnegative(),
  /** Null when every bucket fit on the returned page (or rollup was declined). */
  other: CostBreakdownOtherSchema.nullable(),
  /** Absent unless the caller passed the finishedWork option. */
  finishedWork: CostBreakdownFinishedWorkSchema.optional(),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
