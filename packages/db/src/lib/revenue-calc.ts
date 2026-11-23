/**
 * Revenue Calc — pure math functions, no Prisma, no I/O.
 *
 * These are the math primitives the canonical revenue library composes. Split
 * from the query layer so unit tests can exercise every rule (R1/R2/R3/R4)
 * without spinning up a database.
 *
 * Canon rule anchors for the reader:
 *   R1 — usage strategies: quantity × rate (flat) / graduated / volume
 *   R2 — sub-level fees: recurring/seat/onetime with window proration
 *   R3 — tier math lives in ONE place (this file IS the single source of truth)
 *   R4 — intermediate sums keep full precision; presentation layer rounds once
 */

import type { ChargeType, PricingModel } from "../schemas/revenue-metrics";

/**
 * Convert any numeric-ish value (Prisma Decimal, string, number, null) to a
 * plain JS number. Prisma returns Decimal values that are NOT plain numbers;
 * they're decimal.js instances that serialize to strings. Passing a Decimal
 * directly into arithmetic silently stringifies it.
 *
 * Returns 0 for null/undefined/NaN — callers that need to distinguish "no
 * data" from "zero" must check the raw value before calling this.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  // Prisma.Decimal and similar — rely on their toString()/toNumber() contract
  if (typeof value === "object" && value !== null) {
    const obj = value as { toNumber?: () => number; toString?: () => string };
    if (typeof obj.toNumber === "function") {
      const n = obj.toNumber();
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof obj.toString === "function") {
      const parsed = parseFloat(obj.toString());
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return 0;
}

/**
 * A tier on a pricing strategy. Matches `pricing_strategies.tiers` JSON shape.
 * `upper: null` means "no upper bound" (the top tier).
 */
export interface CalcTier {
  lower: number;
  upper: number | null;
  rate: number | string;
}

/**
 * Minimal strategy shape the calc functions need. A narrower contract than the
 * full Prisma row — callers translate their rows (NestJS service inputs, seed
 * fixtures, etc.) into this shape.
 */
export interface CalcStrategy {
  id: string;
  chargeType: ChargeType;
  pricingModel: PricingModel | null;
  rate: number | string | null;
  tiers: CalcTier[];
  minimumCommitment: number | null;
  /** For usage strategies only. */
  signalId: string | null;
}

// ─── Tier-math primitives ──────────────────────────────────────────────────
// These are the R3 "ONE file" canonical versions. All pricing math in the
// monorepo imports from here. They return
// full-precision numbers (no rounding per R4). They do not apply
// minimumCommitment — callers do that first.

/**
 * Flat pricing. Canon behavior for `flat` with empty tiers: use strategy.rate.
 * With populated tiers: use tiers[0].rate. When both are present they must
 * match; mismatched input logs a warning but does not throw, because bad
 * stored data should not crash the dashboard mid-render.
 */
export function calcFlat(strategy: CalcStrategy, quantity: number): number {
  if (quantity <= 0) return 0;

  const hasTiers = strategy.tiers && strategy.tiers.length > 0;
  const tierRate = hasTiers ? toNumber(strategy.tiers[0].rate) : null;
  const flatRate = toNumber(strategy.rate);

  if (tierRate !== null && strategy.rate !== null) {
    // Both present — they must match.
    if (Math.abs(tierRate - flatRate) > 1e-9) {
      // eslint-disable-next-line no-console -- warns the operator about a data problem
      console.warn(
        `[revenue-calc] strategy ${strategy.id}: tiers[0].rate (${tierRate}) ≠ strategy.rate (${flatRate}). Using strategy.rate.`,
      );
    }
    return quantity * flatRate;
  }

  const rate = tierRate !== null ? tierRate : flatRate;
  return quantity * rate;
}

/**
 * Graduated pricing — each tier is billed at its own rate up to its `upper`
 * bound (INCLUSIVE). `lower` is display-only and does not affect math.
 *
 * Example: tiers [{upper:20, rate:$1}, {upper:70, rate:$0.50}, {upper:null, rate:$0.25}]
 *   quantity = 20   → 20 × $1 = $20           (first 20 units, tier 1)
 *   quantity = 21   → 20 × $1 + 1 × $0.50     (20 in tier 1, unit 21 rolls to tier 2)
 *   quantity = 100  → 20 × $1 + 50 × $0.50 + 30 × $0.25
 *
 * This matches the human-intuitive UI: a user who types "this tier covers
 * 0-20" means "units 1 through 20, inclusive — 20 billable units in this
 * tier." Unit 21 is the first unit of the next tier.
 *
 * Math is tier-iteration-by-cumulative-cap. We sort by `upper` ascending
 * and advance a `billedSoFar` counter. Each tier accepts quantity up to
 * its `upper` bound MINUS whatever was already billed by prior tiers.
 * `lower` is ignored entirely.
 */
export function calcGraduated(
  strategy: CalcStrategy,
  quantity: number,
): number {
  if (quantity <= 0 || !strategy.tiers || strategy.tiers.length === 0) return 0;

  const sorted = [...strategy.tiers].sort((a, b) => {
    const au = a.upper === null ? Infinity : a.upper;
    const bu = b.upper === null ? Infinity : b.upper;
    return au - bu;
  });

  let remaining = quantity;
  let billedSoFar = 0;
  let total = 0;

  for (const tier of sorted) {
    const tierUpper = tier.upper === null ? Infinity : tier.upper;
    const availableInTier = tierUpper - billedSoFar;
    if (availableInTier <= 0) continue;
    const take = Math.min(remaining, availableInTier);
    total += take * toNumber(tier.rate);
    billedSoFar += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  return total;
}

/**
 * Breakdown row describing how a tier contributed to a calculation.
 * Used by the invoice generator to render "this many units in this tier."
 */
export interface TierBreakdownRow {
  lower: number;
  upper: number | null;
  rate: number;
  quantity: number;
  subtotal: number;
}

/**
 * Graduated with per-tier breakdown. Same math as calcGraduated but also
 * returns which tiers contributed what. Used by invoice-calculator to
 * render the detailed "X units in tier 1 at $Y, Z units in tier 2 at $W"
 * line-item breakdown on generated invoices.
 *
 * Returns total + array of TierBreakdownRow. Total ≡ sum of row.subtotal.
 */
export function calcGraduatedWithBreakdown(
  strategy: CalcStrategy,
  quantity: number,
): { total: number; tiersUsed: TierBreakdownRow[] } {
  if (quantity <= 0 || !strategy.tiers || strategy.tiers.length === 0) {
    return { total: 0, tiersUsed: [] };
  }

  const sorted = [...strategy.tiers].sort((a, b) => {
    const au = a.upper === null ? Infinity : a.upper;
    const bu = b.upper === null ? Infinity : b.upper;
    return au - bu;
  });

  let remaining = quantity;
  let billedSoFar = 0;
  let total = 0;
  const tiersUsed: TierBreakdownRow[] = [];

  for (const tier of sorted) {
    const tierUpper = tier.upper === null ? Infinity : tier.upper;
    const availableInTier = tierUpper - billedSoFar;
    if (availableInTier <= 0) continue;
    const take = Math.min(remaining, availableInTier);
    const tierRate = toNumber(tier.rate);
    const subtotal = take * tierRate;
    total += subtotal;
    tiersUsed.push({
      lower: tier.lower,
      upper: tier.upper,
      rate: tierRate,
      quantity: take,
      subtotal,
    });
    billedSoFar += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  return { total, tiersUsed };
}

/**
 * Volume pricing — the entire quantity is billed at ONE tier's rate, picked
 * by which tier the total quantity falls into.
 */
export function calcVolume(strategy: CalcStrategy, quantity: number): number {
  if (quantity <= 0 || !strategy.tiers || strategy.tiers.length === 0) return 0;

  // Highest tier whose lower bound the quantity meets or exceeds.
  const sortedDesc = [...strategy.tiers].sort((a, b) => b.lower - a.lower);
  const applicable = sortedDesc.find((t) => quantity >= t.lower);
  if (!applicable) return 0;
  return quantity * toNumber(applicable.rate);
}

/**
 * Volume with per-tier breakdown. Same math as calcVolume, also surfaces
 * which tier drove the whole-quantity rate. Used by invoice-calculator.
 */
export function calcVolumeWithBreakdown(
  strategy: CalcStrategy,
  quantity: number,
): { total: number; tiersUsed: TierBreakdownRow[]; unitPrice: number } {
  if (quantity <= 0 || !strategy.tiers || strategy.tiers.length === 0) {
    return { total: 0, tiersUsed: [], unitPrice: 0 };
  }
  const sortedDesc = [...strategy.tiers].sort((a, b) => b.lower - a.lower);
  const applicable = sortedDesc.find((t) => quantity >= t.lower);
  if (!applicable) return { total: 0, tiersUsed: [], unitPrice: 0 };
  const unitPrice = toNumber(applicable.rate);
  const total = quantity * unitPrice;
  return {
    total,
    tiersUsed: [
      {
        lower: applicable.lower,
        upper: applicable.upper,
        rate: unitPrice,
        quantity,
        subtotal: total,
      },
    ],
    unitPrice,
  };
}

/**
 * Credit-pool pricing: flat fee for a pool of units, then per-unit overage.
 *
 * Tier layout expected by callers:
 *   tiers[0] = pool tier:  { lower: 0, upper: poolSize, rate: poolPrice }
 *              rate is a FLAT fee (not per-unit) — you pay it whether you
 *              use 1 unit or all poolSize units.
 *   tiers[1] = overage:    { lower: poolSize, upper: null, rate: overageRate }
 *              rate is per-unit, kicks in only after pool is exceeded.
 *
 * Examples (pool of 5,000 calls for $99, overage at $0.03/call):
 *   quantity = 3000 → $99         (pool covers it)
 *   quantity = 6000 → $99 + $30   (1,000 units of overage × $0.03)
 *   quantity = 0    → $99         (the fee follows the plan's CONFIGURATION,
 *                                 not the customer's activity)
 *
 * calcRouted still short-circuits every model at 0, because it prices UNITS and
 * zero units cost nothing. What a subscription is BILLED at zero usage is a
 * different question, and calcUsageCharge is the one that answers it.
 */
export function calcCreditPool(
  strategy: CalcStrategy,
  quantity: number,
): number {
  // No tiers = fall back to simple rate × quantity
  if (!strategy.tiers || strategy.tiers.length === 0) {
    return quantity * toNumber(strategy.rate);
  }

  const sorted = [...strategy.tiers].sort((a, b) => a.lower - b.lower);
  const poolTier = sorted[0];
  const poolSize = poolTier.upper ?? Infinity;
  const poolPrice = toNumber(poolTier.rate);

  // Pool fee is always charged — you bought the pool
  let total = poolPrice;

  // Overage: anything beyond the pool size billed per-unit
  const overageQuantity = Math.max(0, quantity - poolSize);
  if (overageQuantity > 0 && sorted.length > 1) {
    const overageRate = toNumber(sorted[1].rate);
    total += overageQuantity * overageRate;
  }

  return total;
}

/**
 * Credit-pool with per-tier breakdown. Same total as calcCreditPool, plus
 * the structured breakdown that invoice-calculator needs to render line
 * items. Returns one row for the pool tier (always, since the pool fee is
 * always charged) plus a second row for overage when qty > poolSize.
 *
 * Invariant: total === sum(tiersUsed[i].subtotal).
 *
 * Used by the invoice-calculator service and the dashboard simulator so
 * credit_pool math lives in exactly one place (R3).
 */
export function calcCreditPoolWithBreakdown(
  strategy: CalcStrategy,
  quantity: number,
): { total: number; tiersUsed: TierBreakdownRow[]; unitPrice: number } {
  // No tiers = fall back to simple rate × quantity (matches calcCreditPool)
  if (!strategy.tiers || strategy.tiers.length === 0) {
    const total = quantity * toNumber(strategy.rate);
    return {
      total,
      tiersUsed: [],
      unitPrice: quantity > 0 ? total / quantity : 0,
    };
  }

  const sorted = [...strategy.tiers].sort((a, b) => a.lower - b.lower);
  const poolTier = sorted[0];
  const poolSize = poolTier.upper ?? Infinity;
  const poolPrice = toNumber(poolTier.rate);

  let total = poolPrice;
  const tiersUsed: TierBreakdownRow[] = [
    {
      lower: poolTier.lower,
      upper: poolTier.upper,
      rate: poolPrice,
      quantity: Math.min(quantity, poolSize),
      subtotal: poolPrice,
    },
  ];

  const overageQuantity = Math.max(0, quantity - poolSize);
  if (overageQuantity > 0 && sorted.length > 1) {
    const overageRate = toNumber(sorted[1].rate);
    const overageAmount = overageQuantity * overageRate;
    total += overageAmount;
    tiersUsed.push({
      lower: sorted[1].lower,
      upper: sorted[1].upper,
      rate: overageRate,
      quantity: overageQuantity,
      subtotal: overageAmount,
    });
  }

  return {
    total,
    tiersUsed,
    unitPrice: quantity > 0 ? total / quantity : 0,
  };
}

/**
 * The flat per-cycle fee a credit pool charges, or 0 when it charges none.
 *
 * THE question every billing surface asks before it lets a zero-quantity line
 * through: the fee follows the plan's configuration, not the customer's
 * activity. A pool priced at zero owes nothing — it still exists
 * and still counts down, it costs nothing to hold, so callers emit no
 * line rather than a $0 one.
 *
 * Structural on `pricingModel` / `tiers` so a raw Prisma row (tiers is JSON)
 * and a CalcStrategy both satisfy it with no cast. The sort matches
 * calcCreditPool's exactly, or guard and math would disagree about which tier
 * is the pool.
 */
export function creditPoolFee(strategy: {
  pricingModel?: unknown;
  tiers?: unknown;
}): number {
  if (strategy.pricingModel !== "credit_pool") return 0;
  const tiers = Array.isArray(strategy.tiers)
    ? (strategy.tiers as CalcTier[])
    : [];
  if (tiers.length === 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.lower - b.lower);
  const fee = toNumber(sorted[0].rate);
  return fee > 0 ? fee : 0;
}

/**
 * Route a strategy + quantity through the right pricing model per R1/R2.
 * This is the ONE place callers should pick which math to run.
 */
export function calcRouted(strategy: CalcStrategy, quantity: number): number {
  if (quantity <= 0) return 0;
  switch (strategy.pricingModel) {
    case "flat":
      return calcFlat(strategy, quantity);
    case "graduated":
      return calcGraduated(strategy, quantity);
    case "volume":
      return calcVolume(strategy, quantity);
    case "credit_pool":
      return calcCreditPool(strategy, quantity);
    case null:
      // Strategies without a pricingModel (recurring fixed fee, onetime fixed
      // fee with no tiers) bill strategy.rate × quantity.
      return quantity * toNumber(strategy.rate);
    default:
      // Every Prisma enum value must have a case above. If this fires, a new
      // value was added to the schema but not to the calculator. A billing
      // platform must never silently bill $0 — throw so it gets caught.
      throw new Error(
        `[revenue-calc] Unrecognized pricingModel "${strategy.pricingModel}" ` +
          `on strategy ${strategy.id}. Add a case to calcRouted() or fix the data.`,
      );
  }
}

/**
 * What a usage strategy BILLS for `quantity` units in a period.
 *
 * calcRouted prices units, and zero units cost nothing. That is the right
 * answer to "what did this usage cost" and the wrong one to "what does the
 * invoice say", because a credit pool's fee follows the plan's configuration
 * rather than the customer's activity: the invoice charges $99 for a $99 pool
 * in a period with no usage at all (invoice-calculator.service.ts).
 *
 * Without it, revenue reporting would count a zero-usage pool subscription
 * as $0 while the invoice bills $99.
 *
 * Deliberately NOT folded into calcRouted. Per-event attribution calls that
 * one once per event (per-event-earned.ts), and a pool fee returned for a
 * zero-quantity event would be attributed once per event on top of the
 * multiplication that already happens there.
 */
export function calcUsageCharge(
  strategy: CalcStrategy,
  quantity: number,
): number {
  if (quantity <= 0) return creditPoolFee(strategy);
  return calcRouted(strategy, quantity);
}

/**
 * Apply minimum commitment: billed quantity = max(actual, minimumCommitment).
 * R1/R2 both require this BEFORE tier math runs.
 */
export function applyMinCommitment(
  actualQuantity: number,
  minimumCommitment: number | null,
): number {
  if (!minimumCommitment || minimumCommitment <= 0) return actualQuantity;
  return Math.max(actualQuantity, minimumCommitment);
}

// ─── R1: usage strategies ──────────────────────────────────────────────────

/**
 * Revenue contribution from ONE usage strategy, given the event-sum quantity
 * in the window. Does not touch the database — caller supplies the quantity.
 */
export function calcUsageRevenue(
  strategy: CalcStrategy,
  quantityInWindow: number,
): number {
  if (strategy.chargeType !== "usage") return 0;
  const billable = applyMinCommitment(
    quantityInWindow,
    strategy.minimumCommitment,
  );
  return calcUsageCharge(strategy, billable);
}

// ─── R2: sub-level fees with window proration ──────────────────────────────

/**
 * Proration factor for a recurring/seat fee against a window.
 *
 * Definition (verbatim from canon R2):
 *   contribution = rate × (cycles_overlapping_window / cycle_length_in_days)
 *
 * Practically: a 30-day window over a monthly cycle (30 days) = 1.0. A sub
 * that started halfway through the window contributes only the portion of
 * cycle days that fell inside the window.
 *
 * Inputs:
 *   windowStart/windowEnd    — the window we're reporting on (UTC, W1)
 *   subscriptionStart/End    — when the sub was live (End null = still active)
 *   cycleLengthDays          — 30 for monthly, 365 for yearly, customCycleDays for custom
 *
 * Returns a factor in [0, 1] for a single cycle window. For multi-cycle
 * windows (e.g. 90d window over a monthly cycle) it can exceed 1.0 — that's
 * correct: three cycles of rent = 3× the rate.
 */
export function calcProrationFactor(params: {
  windowStart: Date;
  windowEnd: Date;
  subscriptionStart: Date;
  subscriptionEnd: Date | null;
  cycleLengthDays: number;
}): number {
  const {
    windowStart,
    windowEnd,
    subscriptionStart,
    subscriptionEnd,
    cycleLengthDays,
  } = params;
  if (cycleLengthDays <= 0) return 0;

  // Clamp the sub's active interval into the window.
  const activeStart =
    subscriptionStart > windowStart ? subscriptionStart : windowStart;
  const subEnd = subscriptionEnd ?? windowEnd;
  const activeEnd = subEnd < windowEnd ? subEnd : windowEnd;
  if (activeEnd <= activeStart) return 0;

  const activeDays =
    (activeEnd.getTime() - activeStart.getTime()) / (1000 * 60 * 60 * 24);
  return activeDays / cycleLengthDays;
}

/**
 * Recurring fee (flat monthly/yearly rent) contribution for one strategy.
 * Per R2: `rate × proration`. pricingModel is normally null for recurring,
 * but if a plan uses a pricing model here (weird but supported) we route.
 */
export function calcRecurringRevenue(
  strategy: CalcStrategy,
  prorationFactor: number,
): number {
  if (strategy.chargeType !== "recurring") return 0;
  if (prorationFactor <= 0) return 0;
  // Recurring is a fixed fee, not quantity-based — proration IS the quantity.
  return calcRouted(strategy, 1) * prorationFactor;
}

/**
 * Seat-based fee contribution for one strategy.
 * Per R2: `max(seatsCount, minCommitment) via pricingModel router × proration`.
 */
export function calcSeatRevenue(
  strategy: CalcStrategy,
  seatsCount: number,
  prorationFactor: number,
): number {
  if (strategy.chargeType !== "seat_based") return 0;
  if (prorationFactor <= 0) return 0;
  const billable = applyMinCommitment(seatsCount, strategy.minimumCommitment);
  return calcRouted(strategy, billable) * prorationFactor;
}

/**
 * One-time fee contribution for one strategy.
 * Per R2: `rate` if subscription.startDate ∈ window, else 0. No proration.
 */
export function calcOnetimeRevenue(
  strategy: CalcStrategy,
  subscriptionStart: Date,
  windowStart: Date,
  windowEnd: Date,
): number {
  if (strategy.chargeType !== "onetime") return 0;
  if (subscriptionStart < windowStart || subscriptionStart > windowEnd)
    return 0;
  return calcRouted(strategy, 1);
}
