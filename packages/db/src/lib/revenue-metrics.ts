/**
 * Revenue Metrics — the canonical source-of-truth library.
 *
 * Every $-valued surface in the MarginFront dashboard flows through one of
 * the three functions in this file: `getRevenueMetrics`, `getInvoiceTotals`,
 * `getMrr`. Duplicate revenue/cost/margin calculations in Server Actions or
 * NestJS modules are thin adapters around these — no surface owns its own
 * math.
 *
 * Canon rule citations (full text: packages/db/CANON.md):
 *   C1  — cost = SUM(signal_events.usageCost) by usageDate; null → 0 but still counted in eventCount
 *   C2  — cost window uses usageDate, not createdAt
 *   R1  — usage strategies: quantity × rate routed by pricingModel
 *   R2  — recurring/seat fees prorated to window; onetime only if startDate ∈ window
 *   R3  — tier math delegated to revenue-calc.ts primitives (one source)
 *   R4  — full-precision Numbers returned; UI layer rounds once
 *   M1  — marginPercent null when revenue === 0 (never NaN/Infinity/0%)
 *   I2  — invoice status canon: billed = issued+overdue (accrual); collected = cash (succeeded payments net of refunds); outstanding = current open A/R; no pending
 *   I3  — date fields: billed on invoiceDate; collected on payment paymentDate (cash-basis); neither uses createdAt/dueDate/cycle-overlap
 *   MRR1 — contracted monthly recurring revenue: active subs' recurring + seat strategies, monthly-normalized; usage/onetime excluded
 *   W1  — window computed once in UTC, threaded to every call
 *   A1  — attribution: subscriptionId first, then (customerId, agentId, signalId) fallback
 */

import type { PrismaClient } from "@prisma/client";
import type {
  AgentEarned,
  AgentEarnedStrategyRow,
  AgentEarnedSubscriptionRow,
  CommittedMrrBreakdownRow,
  CommittedMrrResult,
  CostByAgentRow,
  CostByBranchRow,
  CostByCostCategoryRow,
  CostByCustomerRow,
  CostByDayRow,
  CostByEnvironmentRow,
  CostByModelRow,
  CostByPlanRow,
  CostByRepoRow,
  CostBySignalRow,
  CostMetrics,
  InvoiceTotals,
  Mrr,
  MrrFilters,
  RevenueFilters,
  RevenueMetrics,
  RevenueWindow,
  RunRateMrrBreakdownRow,
  RunRateMrrResult,
  StrategyRevenue,
  SubscriptionRevenue,
} from "../schemas/revenue-metrics";
import {
  applyMinCommitment,
  calcOnetimeRevenue,
  calcProrationFactor,
  calcRecurringRevenue,
  calcRouted,
  calcSeatRevenue,
  calcUsageCharge,
  calcUsageRevenue,
  toNumber,
  type CalcStrategy,
  type CalcTier,
} from "./revenue-calc";
import { poolMemberRates } from "./credit-ledger";
import { gitBranchKey, gitRepoKey } from "./git-coordinates";

// ─── Helpers ───────────────────────────────────────────────────────────────

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

function cycleLengthDaysFor(
  billingCycle: string | null | undefined,
  customDays: number | null,
): number {
  if (customDays && customDays > 0) return customDays;
  switch (billingCycle) {
    case "yearly":
      return 365;
    case "weekly":
      return 7;
    case "daily":
      return 1;
    case "monthly":
    default:
      return 30;
  }
}

export function safeMarginPercent(
  revenue: number,
  margin: number,
): number | null {
  if (revenue === 0) return null;
  return (margin / revenue) * 100;
}

/**
 * A credit pool bills CREDITS, not raw units. Sum FIRST, then one
 * multiply per signal: the invoice calculator and the balance read use that
 * exact order, and float parity with the bill depends on it. A rate-less pool
 * is the single-member rate-1 case, identical to a raw-unit read.
 *
 * Quantities arrive through a callback because the two call sites key theirs
 * differently — members carry no strategy rows to read them off.
 */
function pooledCreditQuantity(
  strategy: { signalId: string | null; creditRates?: unknown },
  quantityFor: (signalId: string) => number,
): number {
  let credits = 0;
  for (const [signalId, rate] of poolMemberRates(strategy)) {
    credits += quantityFor(signalId) * rate;
  }
  return credits;
}

function toCalcStrategy(row: {
  id: string;
  chargeType: string;
  pricingModel: string | null;
  rate: unknown;
  tiers: unknown;
  minimumCommitment: number | null;
  signalId: string | null;
}): CalcStrategy {
  const tiers: CalcTier[] = Array.isArray(row.tiers)
    ? (row.tiers as CalcTier[]).filter(
        (t) => typeof t === "object" && t !== null && "lower" in t,
      )
    : [];
  return {
    id: row.id,
    chargeType: row.chargeType as CalcStrategy["chargeType"],
    pricingModel: (row.pricingModel as CalcStrategy["pricingModel"]) ?? null,
    rate:
      row.rate === null || row.rate === undefined ? null : toNumber(row.rate),
    tiers,
    minimumCommitment: row.minimumCommitment,
    signalId: row.signalId,
  };
}

// ─── getRevenueMetrics — the primary function ──────────────────────────────

/**
 * Compute revenue/cost/margin for an organization over a window, optionally
 * filtered to one customer/agent/signal/subscription.
 *
 * This is the ONLY place these numbers are computed. Dashboard Earned tiles,
 * Revenue-by-Type donuts, customer detail pages, agent pages — every surface
 * passes through here. Filter narrowing lets a customer-detail page request
 * "revenue for this customer only" without re-implementing the formula.
 */
export async function getRevenueMetrics(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  filters: RevenueFilters = {},
): Promise<RevenueMetrics> {
  // --- 1. Resolve subscriptions in scope ----------------------------------
  //
  // Date-overlap is the authoritative "was this sub alive in the window"
  // test. Status labels change over the lifecycle (upcoming → active →
  // ended/canceled/expired) and filtering by label would drop a sub that
  // was active during the window but has since been canceled. A sub that
  // started or ended inside the window correctly contributes its prorated
  // share of sub-level fees and any events it owned.
  const subs = await db.subscriptions.findMany({
    where: {
      customers: { organizationId: orgId },
      deletedAt: null,
      startDate: { lte: window.end },
      OR: [{ endDate: null }, { endDate: { gte: window.start } }],
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
      ...(filters.subscriptionId ? { id: filters.subscriptionId } : {}),
    },
    select: {
      id: true,
      customerId: true,
      agentId: true,
      planId: true,
      startDate: true,
      endDate: true,
      billingCycle: true,
      customCycleDays: true,
      seatsCount: true,
      pricing_plans: {
        select: {
          pricing_strategies: {
            where: { active: true, deletedAt: null },
            select: {
              id: true,
              chargeType: true,
              pricingModel: true,
              rate: true,
              tiers: true,
              minimumCommitment: true,
              signalId: true,
              creditRates: true,
            },
          },
        },
      },
    },
  });

  if (subs.length === 0) {
    return emptyMetrics();
  }

  // --- 2. Pull the window's signal_events per sub (for usage quantity + cost)
  //
  // One batched query keyed by subscriptionId — Prisma resolves the join
  // server-side. Null-cost events are preserved (counted in eventCount, not
  // in cost) per C1.
  const subIds = subs.map((s) => s.id);
  const eventRows = await db.signal_events.findMany({
    where: {
      organizationId: orgId,
      usageDate: { gte: window.start, lte: window.end },
      subscriptionId: { in: subIds },
      ...(filters.signalId ? { signalId: filters.signalId } : {}),
    },
    select: {
      subscriptionId: true,
      signalId: true,
      quantity: true,
      usageCost: true,
    },
  });

  // Per-subscription event aggregates, and per-strategy usage quantity.
  const eventsBySub = new Map<
    string,
    {
      cost: number;
      eventCount: number;
      nullCostCount: number;
      quantityBySignal: Map<string, number>;
    }
  >();
  for (const sub of subs) {
    eventsBySub.set(sub.id, {
      cost: 0,
      eventCount: 0,
      nullCostCount: 0,
      quantityBySignal: new Map(),
    });
  }
  for (const evt of eventRows) {
    if (!evt.subscriptionId) continue;
    const bucket = eventsBySub.get(evt.subscriptionId);
    if (!bucket) continue;
    bucket.eventCount += 1;
    if (evt.usageCost === null || evt.usageCost === undefined) {
      bucket.nullCostCount += 1;
    } else {
      bucket.cost += toNumber(evt.usageCost);
    }
    if (evt.signalId) {
      const prev = bucket.quantityBySignal.get(evt.signalId) ?? 0;
      bucket.quantityBySignal.set(evt.signalId, prev + toNumber(evt.quantity));
    }
  }

  // --- 3. Walk subs × strategies, apply canon rules -----------------------
  const bySubscription: SubscriptionRevenue[] = [];
  const byStrategyMap = new Map<string, StrategyRevenue>();

  let totalRevenue = 0;
  let totalCost = 0;
  let totalUsage = 0;
  let totalRecurring = 0;
  let totalSeat = 0;
  let totalOnetime = 0;
  let totalEventCount = 0;
  let totalNullCostCount = 0;

  for (const sub of subs) {
    const bucket = eventsBySub.get(sub.id)!;
    const cycleDays = cycleLengthDaysFor(sub.billingCycle, sub.customCycleDays);
    const proration = calcProrationFactor({
      windowStart: window.start,
      windowEnd: window.end,
      subscriptionStart: sub.startDate,
      subscriptionEnd: sub.endDate,
      cycleLengthDays: cycleDays,
    });

    let subUsage = 0;
    let subRecurring = 0;
    let subSeat = 0;
    let subOnetime = 0;

    const strategies = sub.pricing_plans?.pricing_strategies ?? [];
    for (const raw of strategies) {
      const strategy = toCalcStrategy(raw);

      // Signal filter narrows which strategies contribute.
      if (filters.signalId && strategy.signalId !== filters.signalId) continue;

      let contribution = 0;
      let usageQty = 0;

      switch (strategy.chargeType) {
        case "usage": {
          if (strategy.signalId) {
            usageQty =
              strategy.pricingModel === "credit_pool"
                ? // `raw`, not `strategy`: creditRates never reaches CalcStrategy.
                  pooledCreditQuantity(
                    raw,
                    (signalId) => bucket.quantityBySignal.get(signalId) ?? 0,
                  )
                : (bucket.quantityBySignal.get(strategy.signalId) ?? 0);
          }
          contribution = calcUsageRevenue(strategy, usageQty);
          subUsage += contribution;
          break;
        }
        case "recurring": {
          contribution = calcRecurringRevenue(strategy, proration);
          subRecurring += contribution;
          break;
        }
        case "seat_based": {
          contribution = calcSeatRevenue(
            strategy,
            sub.seatsCount ?? 0,
            proration,
          );
          subSeat += contribution;
          break;
        }
        case "onetime": {
          contribution = calcOnetimeRevenue(
            strategy,
            sub.startDate,
            window.start,
            window.end,
          );
          subOnetime += contribution;
          break;
        }
      }

      if (contribution !== 0 || usageQty !== 0) {
        const prior = byStrategyMap.get(strategy.id);
        byStrategyMap.set(strategy.id, {
          strategyId: strategy.id,
          chargeType: strategy.chargeType,
          pricingModel: strategy.pricingModel,
          signalId: strategy.signalId,
          revenue: (prior?.revenue ?? 0) + contribution,
          quantity: (prior?.quantity ?? 0) + usageQty,
        });
      }
    }

    const subRevenue = subUsage + subRecurring + subSeat + subOnetime;
    const subCost = bucket.cost;
    const subMargin = subRevenue - subCost;

    bySubscription.push({
      subscriptionId: sub.id,
      customerId: sub.customerId,
      agentId: sub.agentId,
      planId: sub.planId,
      revenue: subRevenue,
      cost: subCost,
      margin: subMargin,
      usageRevenue: subUsage,
      recurringRevenue: subRecurring,
      seatRevenue: subSeat,
      onetimeRevenue: subOnetime,
      eventCount: bucket.eventCount,
    });

    totalRevenue += subRevenue;
    totalCost += subCost;
    totalUsage += subUsage;
    totalRecurring += subRecurring;
    totalSeat += subSeat;
    totalOnetime += subOnetime;
    totalEventCount += bucket.eventCount;
    totalNullCostCount += bucket.nullCostCount;
  }

  const totalMargin = totalRevenue - totalCost;

  return {
    revenue: totalRevenue,
    cost: totalCost,
    margin: totalMargin,
    marginPercent: safeMarginPercent(totalRevenue, totalMargin),

    usageRevenue: totalUsage,
    recurringRevenue: totalRecurring,
    seatRevenue: totalSeat,
    onetimeRevenue: totalOnetime,

    eventCount: totalEventCount,
    eventCountWithNullCost: totalNullCostCount,

    bySubscription,
    byStrategy: Array.from(byStrategyMap.values()),
  };
}

function emptyMetrics(): RevenueMetrics {
  return {
    revenue: 0,
    cost: 0,
    margin: 0,
    marginPercent: null,
    usageRevenue: 0,
    recurringRevenue: 0,
    seatRevenue: 0,
    onetimeRevenue: 0,
    eventCount: 0,
    eventCountWithNullCost: 0,
    bySubscription: [],
    byStrategy: [],
  };
}

// ─── getInvoiceTotals ──────────────────────────────────────────────────────

/**
 * Billed / collected / outstanding / overdue for the window.
 *
 * Two clocks run here on purpose. Billed is ACCRUAL — "what we invoiced in
 * the window" — so it filters on invoiceDate. Collected is CASH — "what money
 * actually landed in the window" — so it filters on the PAYMENT date, not the
 * invoice date. They are different lenses and they answer different questions.
 *
 * Per I2 + I3:
 *   billed     = SUM(totalAmount) WHERE status IN ('issued','overdue') AND invoiceDate ∈ window  (accrual)
 *   collected  = SUM(invoice_payments.amount − refunded_amount)
 *                WHERE payment.status = 'succeeded' AND paymentDate ∈ window                     (cash)
 *   draft      = SUM(totalAmount) WHERE status = 'draft' AND invoiceDate ∈ window
 *   outstanding= SUM(totalAmount) WHERE status IN ('issued','overdue')  — CURRENT STATE, no window
 *   overdue    = SUM(totalAmount) WHERE status = 'overdue'              — CURRENT STATE, no window
 *
 * WHY collected is cash-basis: summing paid invoices by invoiceDate is wrong
 * two ways: a payment that landed inside the window but on an invoice dated
 * outside it would be invisible, and a future-dated invoice that was already
 * paid would pop into Collected a month after the cash actually arrived.
 * Counting by paymentDate puts money in the window the cash moved, which is
 * what "Collected" means everywhere the docs use the word.
 *
 * Why net-of-refunds falls out naturally: each invoice_payments row
 * carries `refunded_amount` (the running total refunded against that payment),
 * so a $100 payment with a $40 partial refund contributes $60. No second
 * query, no canon-I2 status dance — the cash row nets itself.
 *
 * WHY outstanding is current-state, not billed − collected:
 * Billed (accrual) and Collected (cash) are different bases, so
 * `billed − collected` could go negative inside a window (collect old cash,
 * bill nothing new → negative "outstanding", which is nonsense). Outstanding
 * is real open accounts-receivable RIGHT NOW: issued + overdue
 * not yet paid, no date window — the same current-state lens overdue uses.
 * Always ≥ 0, always ≥ overdueAmount (overdue is the past-due subset).
 *
 * `pending` is not counted in any total here.
 *
 * The optional `filters.customerId` narrows ALL totals to one customer
 * (including the cash-basis collected and the current-state overdue). This is
 * the single place the dashboard should look for per-customer billed/collected
 * so every "top customers by revenue" surface routes through the same math.
 */
export async function getInvoiceTotals(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  filters: RevenueFilters = {},
): Promise<InvoiceTotals> {
  // Scope filters. customerId + subscriptionId are direct on invoices.
  // agentId routes through the subscription relation (invoices.subscriptions.agentId).
  // signalId on RevenueFilters is intentionally ignored here — invoices don't
  // carry a signal; signal filtering belongs in getRevenueMetrics / getCostMetrics.
  const scopeFilter: Record<string, unknown> = {};
  if (filters.customerId) scopeFilter.customerId = filters.customerId;
  if (filters.subscriptionId)
    scopeFilter.subscriptionId = filters.subscriptionId;
  if (filters.agentId) scopeFilter.subscriptions = { agentId: filters.agentId };

  const [inWindow, openNow, windowPayments, paidNoPaymentRow] =
    await Promise.all([
      // (A) ACCRUAL side — Billed / Draft / invoicesSentCount, windowed on
      // invoiceDate (canon I3). 'paid' is selected so it counts toward
      // invoicesSentCount (a paid invoice was sent), but its dollar value is
      // NOT used for Collected; see (C).
      db.invoices.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          invoiceDate: { gte: window.start, lte: window.end },
          status: { in: ["issued", "paid", "overdue", "draft"] as any },
          ...scopeFilter,
        },
        select: {
          status: true,
          totalAmount: true,
        },
      }),
      // (B) CURRENT-STATE side — open accounts-receivable RIGHT NOW for
      // Outstanding + Overdue. No date window: this answers "what is open
      // today", not "what was billed in the window".
      db.invoices.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          status: { in: ["issued", "overdue"] as any },
          ...scopeFilter,
        },
        select: { status: true, totalAmount: true },
      }),
      // (C) CASH side — Collected. Sum succeeded payments whose cash LANDED in
      // the window (paymentDate ∈ window), net of refunds. This is the
      // Cash-basis Collected keyed to payment date, not invoice
      // date. Void invoices never count (canon I2); refunded-status invoices
      // are fine to include because their payment nets to ~$0 via
      // refunded_amount.
      db.invoice_payments.findMany({
        where: {
          status: "succeeded",
          paymentDate: { gte: window.start, lte: window.end },
          invoices: {
            organizationId: orgId,
            deletedAt: null,
            status: { not: "void" as any },
            ...scopeFilter,
          },
        },
        select: { amount: true, refunded_amount: true },
      }),
      // (D) FALLBACK — paid invoices that have NO payment row at all. `invoices`
      // has no paidAt column, so a status='paid' invoice without any
      // invoice_payments row has no cash date to window on. Rather than
      // silently drop it (undercount), it is windowed on invoiceDate and
      // LOGGED loudly below so the data gap is visible instead of quietly
      // reading $0.
      db.invoices.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          status: "paid" as any,
          invoiceDate: { gte: window.start, lte: window.end },
          invoice_payments: { none: {} },
          ...scopeFilter,
        },
        select: { invoiceNumber: true, totalAmount: true },
      }),
    ]);

  // ── ACCRUAL: Billed / Draft / invoicesSentCount (canon I2 + I3) ──
  let billed = 0;
  let draft = 0;
  let invoicesSentCount = 0;
  for (const inv of inWindow) {
    const amt = toNumber(inv.totalAmount);
    switch (inv.status) {
      case "issued":
      case "overdue":
        billed += amt;
        invoicesSentCount += 1;
        break;
      case "paid":
        // Counted as "sent" but NOT added to collected — collected is
        // cash-basis (query C below), keyed to payment date.
        invoicesSentCount += 1;
        break;
      case "draft":
        draft += amt;
        break;
      // `pending` and `void` excluded by the query's status IN filter.
    }
  }

  // ── CASH: Collected (cash-basis) ──
  // Each payment nets its own refund: a $100 payment with a $40 refund
  // contributes $60. `refunded` exposes the gross refund total that was
  // subtracted, for detail-page "Refunded: $X" callouts.
  let collected = 0;
  let totalRefunded = 0;
  for (const p of windowPayments) {
    collected += toNumber(p.amount) - toNumber(p.refunded_amount);
    totalRefunded += toNumber(p.refunded_amount);
  }

  // ── FALLBACK: paid invoices with no payment row (data gap) ──
  if (paidNoPaymentRow.length > 0) {
    let fallbackTotal = 0;
    for (const inv of paidNoPaymentRow)
      fallbackTotal += toNumber(inv.totalAmount);
    collected += fallbackTotal;
    console.warn(
      `[canon I3] getInvoiceTotals(org=${orgId}): ` +
        `${paidNoPaymentRow.length} paid invoice(s) have no invoice_payments row — ` +
        `counted $${fallbackTotal.toFixed(2)} toward Collected by invoiceDate as a fallback. ` +
        `Cash-basis Collected is exact only when every paid invoice has a payment row; ` +
        `invoices: ${paidNoPaymentRow.map((i) => i.invoiceNumber).join(", ")}.`,
    );
  }

  // ── CURRENT-STATE: Outstanding (open A/R now) + Overdue ──
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  for (const inv of openNow) {
    const amt = toNumber(inv.totalAmount);
    outstanding += amt;
    if (inv.status === "overdue") {
      overdueAmount += amt;
      overdueCount += 1;
    }
  }

  return {
    billed,
    collected,
    draft,
    outstanding,
    overdueAmount,
    overdueCount,
    invoicesSentCount,
    refunded: totalRefunded,
  };
}

// ─── getMrr ────────────────────────────────────────────────────────────────

/**
 * MRR (canon MRR1) — industry-standard "current active recurring contract
 * value." For every active subscription in scope, sum the monthly value of
 * each recurring or seat-based pricing strategy. Usage and one-time charges
 * are excluded — usage forecasts belong to getRunRateMrr (MRR2) and
 * contract floors to getCommittedMrr (MRR3).
 *
 * Yearly billing cycles divide by 12 so the dollar number is always
 * monthly-normalized. ARR = MRR × 12.
 *
 * MRR is not "sum of invoice totals for the prior complete calendar
 * month", because that would get two cases wrong:
 *   1. A brand-new active sub with a $50/mo recurring strategy would show
 *      $0 MRR until its first invoice landed at the end of its cycle.
 *   2. A sub paused or churned this month would still show last month's
 *      bill as MRR even though it generates nothing forward.
 * This definition matches what Stripe, Chargebee and Recurly mean by MRR:
 * contracted-monthly-recurring-revenue, today.
 */
export async function getMrr(
  db: PrismaClient,
  orgId: string,
  filters: MrrFilters = {},
): Promise<Mrr> {
  const result = await computeForwardMrr(
    db,
    orgId,
    filters,
    new Date(),
    "contract",
  );
  return { mrr: result.mrr, arr: result.mrr * 12 };
}

// ─── getRunRateMrr (MRR2) + getCommittedMrr (MRR3) ─────────────────────────
//
// MRR variants that sit alongside canon MRR1. All three are forward-looking.
// MRR1 (contract) counts recurring + seat commitments
// only; MRR2 + MRR3 add usage lenses:
//
//   MRR2 (Run-Rate) = "what would we bill per month if the last 30 days
//     of activity kept going?" Contract commitments plus actual 30-day
//     usage, monthly-normalized. Usage flows through calcUsageCharge so
//     tiered pricing lands on the right tier for the run-rate quantity, and
//     a credit pool projects the fee it bills even at zero usage.
//
//   MRR3 (Committed/CMRR) = "what is the contractual floor regardless of
//     usage?" Same shape as MRR2 but usage uses calcUsageCharge(strategy,
//     minimumCommitment), which is 0 with no minimum for every model except
//     a priced credit pool, whose fee IS a contractual floor.
//
// Both accept a { customerId } or { subscriptionId } filter for the
// customer + subscription detail pages. Both exclude onetime fees.

async function computeForwardMrr(
  db: PrismaClient,
  orgId: string,
  filters: MrrFilters,
  now: Date,
  mode: "run-rate" | "committed" | "contract",
): Promise<{ mrr: number; breakdown: RunRateMrrBreakdownRow[] }> {
  const subs = await db.subscriptions.findMany({
    where: {
      customers: { organizationId: orgId },
      deletedAt: null,
      status: { in: ["active", "pending"] as any },
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.subscriptionId ? { id: filters.subscriptionId } : {}),
    },
    select: {
      id: true,
      customerId: true,
      agentId: true,
      planId: true,
      billingCycle: true,
      seatsCount: true,
      pricing_plans: {
        select: {
          pricing_strategies: {
            where: { active: true, deletedAt: null },
            select: {
              id: true,
              chargeType: true,
              pricingModel: true,
              rate: true,
              tiers: true,
              minimumCommitment: true,
              signalId: true,
              creditRates: true,
            },
          },
        },
      },
    },
  });

  if (subs.length === 0) {
    return { mrr: 0, breakdown: [] };
  }

  // 30-day usage quantities per (subId, signalId) — only fetched for the
  // run-rate mode. Committed mode uses strategy minimums and never touches
  // signal_events.
  const qtyMap = new Map<string, number>();
  if (mode === "run-rate") {
    const windowEnd = now;
    const windowStart = new Date(now.getTime() - 30 * MILLISECONDS_PER_DAY);
    const subIds = subs.map((s) => s.id);
    const eventRows = await db.signal_events.findMany({
      where: {
        organizationId: orgId,
        subscriptionId: { in: subIds },
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: {
        subscriptionId: true,
        signalId: true,
        quantity: true,
      },
    });
    for (const ev of eventRows) {
      if (!ev.subscriptionId || !ev.signalId) continue;
      const key = `${ev.subscriptionId}:${ev.signalId}`;
      qtyMap.set(key, (qtyMap.get(key) ?? 0) + toNumber(ev.quantity));
    }
  }

  const breakdown: RunRateMrrBreakdownRow[] = [];
  let totalMrr = 0;

  for (const sub of subs) {
    // "Yearly cycles divide by 12" per canon MRR2/MRR3. Monthly is the
    // baseline; weekly/daily cycles are treated as monthly.
    const monthlyDivisor = sub.billingCycle === "yearly" ? 12 : 1;

    let recurring = 0;
    let seatBased = 0;
    let usage = 0;

    const strategies = sub.pricing_plans?.pricing_strategies ?? [];
    for (const raw of strategies) {
      const strategy = toCalcStrategy(raw);
      switch (strategy.chargeType) {
        case "recurring": {
          const rate = strategy.rate === null ? 0 : toNumber(strategy.rate);
          recurring += rate / monthlyDivisor;
          break;
        }
        case "seat_based": {
          const seats = applyMinCommitment(
            sub.seatsCount ?? 0,
            strategy.minimumCommitment,
          );
          const rate = strategy.rate === null ? 0 : toNumber(strategy.rate);
          seatBased += (rate * seats) / monthlyDivisor;
          break;
        }
        case "usage": {
          if (!strategy.signalId) break;
          if (mode === "contract") {
            // Canon MRR1 (active recurring contract value): usage is excluded
            // entirely. Run-Rate (MRR2) is the right place for usage-based
            // forecasts; CMRR (MRR3) uses contractual minimums.
            break;
          }
          if (mode === "run-rate") {
            // Run-Rate projects the bill, so a rated pool projects credits.
            const qty =
              strategy.pricingModel === "credit_pool"
                ? pooledCreditQuantity(
                    raw,
                    (signalId) => qtyMap.get(`${sub.id}:${signalId}`) ?? 0,
                  )
                : (qtyMap.get(`${sub.id}:${strategy.signalId}`) ?? 0);
            const applied = applyMinCommitment(qty, strategy.minimumCommitment);
            // What the bill says, not what the units cost: a priced pool with
            // no usage this period still invoices its fee.
            usage += calcUsageCharge(strategy, applied);
          } else {
            // mode === "committed"
            // A pool fee IS a contractual floor — it is owed whether or not the
            // customer shows up — so it belongs in CMRR even with no minimum
            // commitment set. calcUsageCharge returns 0 for every other model.
            const min = strategy.minimumCommitment ?? 0;
            usage += calcUsageCharge(strategy, min);
          }
          break;
        }
        case "onetime":
          // Excluded — onetime is not recurring by definition.
          break;
      }
    }

    const total = recurring + seatBased + usage;
    breakdown.push({
      subscriptionId: sub.id,
      customerId: sub.customerId,
      agentId: sub.agentId,
      planId: sub.planId,
      recurring,
      seatBased,
      usage,
      total,
    });
    totalMrr += total;
  }

  return { mrr: totalMrr, breakdown };
}

/**
 * MRR2 — Run-Rate MRR. Contract commitments plus actual last-30-days usage
 * activity, monthly-normalized. Used for the customer detail Run-Rate tile
 * and any forward-looking report that wants "trajectory if current pace
 * continues."
 */
export async function getRunRateMrr(
  db: PrismaClient,
  orgId: string,
  filters: MrrFilters = {},
  now: Date = new Date(),
): Promise<RunRateMrrResult> {
  return computeForwardMrr(db, orgId, filters, now, "run-rate");
}

/**
 * MRR3 — Committed MRR (CMRR). Contractual floor only: usage contributions
 * use calcUsageCharge(strategy, minimumCommitment), which is 0 when no minimum
 * is set — except for a priced credit pool, whose fee is owed whether or not
 * the customer shows up. Independent of actual activity. Not surfaced on the
 * dashboard by default; exposed for forecasting and sales-pipeline use cases.
 */
export async function getCommittedMrr(
  db: PrismaClient,
  orgId: string,
  filters: MrrFilters = {},
  now: Date = new Date(),
): Promise<CommittedMrrResult> {
  const { mrr, breakdown } = await computeForwardMrr(
    db,
    orgId,
    filters,
    now,
    "committed",
  );
  return { mrr, breakdown: breakdown as CommittedMrrBreakdownRow[] };
}

// ─── getAgentEarned ────────────────────────────────────────────────────────

/**
 * Agent-Earned revenue — pure activity only (canon R1).
 *
 * events × pricing-strategy rate, for every active subscription's usage
 * strategies, in the window. NO recurring fees, NO seat fees, NO proration,
 * NO onetime. This is what shows up in the Earned stage of the Earned →
 * Billed → Collected funnel on /home.
 *
 * Implemented as a thin slice over getRevenueMetrics — no duplicate query
 * logic. All the math runs once in getRevenueMetrics; this picks the
 * usage-only fields and drop the rest.
 */
export async function getAgentEarned(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  filters: RevenueFilters = {},
): Promise<AgentEarned> {
  const metrics = await getRevenueMetrics(db, orgId, window, filters);

  const byStrategy: AgentEarnedStrategyRow[] = metrics.byStrategy
    .filter((s) => s.chargeType === "usage")
    .map((s) => ({
      strategyId: s.strategyId,
      pricingModel: s.pricingModel,
      signalId: s.signalId,
      revenue: s.revenue,
      quantity: s.quantity,
    }));

  const bySubscription: AgentEarnedSubscriptionRow[] = metrics.bySubscription
    .filter((s) => s.usageRevenue > 0 || s.eventCount > 0)
    .map((s) => ({
      subscriptionId: s.subscriptionId,
      customerId: s.customerId,
      agentId: s.agentId,
      planId: s.planId,
      revenue: s.usageRevenue,
      eventCount: s.eventCount,
    }));

  return {
    revenue: metrics.usageRevenue,
    eventCount: metrics.eventCount,
    bySubscription,
    byStrategy,
  };
}

// ─── getCostMetrics ────────────────────────────────────────────────────────

/**
 * Cost for the window — canon C1 + C2.
 *
 * Wraps the org-wide cost aggregation: SUM(signal_events.usageCost) filtered
 * by organizationId + usageDate, with NO subscription filter. Orphan events
 * (signal_events without a subscriptionId, or whose sub was deleted) still
 * contribute to cost — that's a deliberate design choice per canon C1.
 *
 * Powers the Cost Tracking dashboard mode (which has no revenue surfaces).
 * Also the cost numerator for every margin computation across the dashboard.
 *
 * NULL usageCost contributes 0 to cost but counts in eventCount + the
 * eventCountWithNullCost "needs attention" indicator.
 */
/**
 * Single-window cost aggregation. Internal helper for {@link getCostMetrics}.
 *
 * Returns the full `CostMetrics` shape minus the optional `prior` field, which
 * the public function composes on top when trend comparison is requested.
 */
async function computeCostMetricsForWindow(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  filters: RevenueFilters,
): Promise<Omit<CostMetrics, "prior">> {
  const events = await db.signal_events.findMany({
    where: {
      organizationId: orgId,
      usageDate: { gte: window.start, lte: window.end },
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
      ...(filters.signalId ? { signalId: filters.signalId } : {}),
      ...(filters.subscriptionId
        ? { subscriptionId: filters.subscriptionId }
        : {}),
    },
    select: {
      customerId: true,
      agentId: true,
      signalId: true,
      usageDate: true,
      usageCost: true,
      // signal_events.environment. Read directly from the column rather than from raw_ingest_events.payload
      // to skip an extra JSON-extract per row.
      environment: true,
      // Carries the meter-stamped git coordinates (repo/branch/commitSha) for the
      // byRepo/byBranch groupings. Capped at 16KB by the ingest DTO.
      metadata: true,
      subscriptions: {
        select: { planId: true },
      },
      // costCategory lives on the parent signal — when null (orphan event with
      // no signal), bucket as UNCLASSIFIED so the row still contributes to total.
      signals: {
        select: { costCategory: true },
      },
      raw_ingest_events: {
        select: { payload: true },
      },
    },
  });

  let cost = 0;
  let eventCountWithNullCost = 0;
  const byAgent = new Map<string, { cost: number; eventCount: number }>();
  const byCustomer = new Map<string, { cost: number; eventCount: number }>();
  const bySignal = new Map<
    string | null,
    { cost: number; eventCount: number }
  >();
  // Integer day keys (UTC-day since epoch) so bucketing is timezone-safe per canon W1.
  const byDay = new Map<number, { cost: number; eventCount: number }>();
  const byPlan = new Map<string | null, { cost: number; eventCount: number }>();
  const byModel = new Map<
    string | null,
    { cost: number; eventCount: number }
  >();
  const byRepo = new Map<string | null, { cost: number; eventCount: number }>();
  const byBranch = new Map<
    string | null,
    { cost: number; eventCount: number }
  >();
  const byCostCategory = new Map<
    CostByCostCategoryRow["costCategory"],
    { cost: number; eventCount: number }
  >();
  const byEnvironment = new Map<
    CostByEnvironmentRow["environment"],
    { cost: number; eventCount: number }
  >();

  for (const ev of events) {
    const isNull = ev.usageCost === null || ev.usageCost === undefined;
    const amt = isNull ? 0 : toNumber(ev.usageCost);
    if (isNull) eventCountWithNullCost += 1;
    cost += amt;

    const a = byAgent.get(ev.agentId) ?? { cost: 0, eventCount: 0 };
    a.cost += amt;
    a.eventCount += 1;
    byAgent.set(ev.agentId, a);

    const c = byCustomer.get(ev.customerId) ?? { cost: 0, eventCount: 0 };
    c.cost += amt;
    c.eventCount += 1;
    byCustomer.set(ev.customerId, c);

    const sigKey = ev.signalId;
    const s = bySignal.get(sigKey) ?? { cost: 0, eventCount: 0 };
    s.cost += amt;
    s.eventCount += 1;
    bySignal.set(sigKey, s);

    const dayKey = Math.floor(ev.usageDate.getTime() / MILLISECONDS_PER_DAY);
    const d = byDay.get(dayKey) ?? { cost: 0, eventCount: 0 };
    d.cost += amt;
    d.eventCount += 1;
    byDay.set(dayKey, d);

    const planKey = ev.subscriptions?.planId ?? null;
    const p = byPlan.get(planKey) ?? { cost: 0, eventCount: 0 };
    p.cost += amt;
    p.eventCount += 1;
    byPlan.set(planKey, p);

    const payload = ev.raw_ingest_events?.payload as
      | { model?: unknown }
      | null
      | undefined;
    const rawModel = payload?.model;
    const modelKey =
      typeof rawModel === "string" && rawModel.length > 0 ? rawModel : null;
    const mm = byModel.get(modelKey) ?? { cost: 0, eventCount: 0 };
    mm.cost += amt;
    mm.eventCount += 1;
    byModel.set(modelKey, mm);

    // Both null-key buckets are real rows: events without git coordinates
    // (meters that send none, non-git sessions, and events from other sources) land
    // there rather than vanishing.
    const repoKey = gitRepoKey(ev.metadata);
    const rr = byRepo.get(repoKey) ?? { cost: 0, eventCount: 0 };
    rr.cost += amt;
    rr.eventCount += 1;
    byRepo.set(repoKey, rr);

    const branchKey = gitBranchKey(ev.metadata);
    const bb = byBranch.get(branchKey) ?? { cost: 0, eventCount: 0 };
    bb.cost += amt;
    bb.eventCount += 1;
    byBranch.set(branchKey, bb);

    // costCategory comes from the parent signal. Orphan events (signalId null
    // or signal soft-deleted) bucket as UNCLASSIFIED so they still aggregate
    // into the total — same fall-through pattern bySignal uses for sigKey null.
    const categoryKey =
      (ev.signals?.costCategory as
        | CostByCostCategoryRow["costCategory"]
        | undefined) ?? "UNCLASSIFIED";
    const cc = byCostCategory.get(categoryKey) ?? { cost: 0, eventCount: 0 };
    cc.cost += amt;
    cc.eventCount += 1;
    byCostCategory.set(categoryKey, cc);

    // Events without an environment are null; keep them as a distinct
    // bucket so the dashboard can flag "instrument these to classify".
    const envKey =
      (ev.environment as CostByEnvironmentRow["environment"] | null) ?? null;
    const ee = byEnvironment.get(envKey) ?? { cost: 0, eventCount: 0 };
    ee.cost += amt;
    ee.eventCount += 1;
    byEnvironment.set(envKey, ee);
  }

  // Nulls sort last so LLM-by-model / plan tables show named rows first.
  const sortNullLast = <T extends string | null>(
    [a]: [T, unknown],
    [b]: [T, unknown],
  ): number => {
    if (a === null) return 1;
    if (b === null) return -1;
    return (a as string).localeCompare(b as string);
  };

  return {
    cost,
    eventCount: events.length,
    eventCountWithNullCost,
    byAgent: Array.from(byAgent.entries()).map(([agentId, v]) => ({
      agentId,
      cost: v.cost,
      eventCount: v.eventCount,
    })) as CostByAgentRow[],
    byCustomer: Array.from(byCustomer.entries()).map(([customerId, v]) => ({
      customerId,
      cost: v.cost,
      eventCount: v.eventCount,
    })) as CostByCustomerRow[],
    bySignal: Array.from(bySignal.entries()).map(([signalId, v]) => ({
      signalId,
      cost: v.cost,
      eventCount: v.eventCount,
    })) as CostBySignalRow[],
    byDay: Array.from(byDay.entries())
      .sort(([a], [b]) => a - b)
      .map(([dayKey, v]) => ({
        date: new Date(dayKey * MILLISECONDS_PER_DAY),
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByDayRow[],
    byPlan: Array.from(byPlan.entries())
      .sort(sortNullLast)
      .map(([planId, v]) => ({
        planId,
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByPlanRow[],
    byModel: Array.from(byModel.entries())
      .sort(sortNullLast)
      .map(([model, v]) => ({
        model,
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByModelRow[],
    byRepo: Array.from(byRepo.entries())
      .sort(sortNullLast)
      .map(([repo, v]) => ({
        repo,
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByRepoRow[],
    byBranch: Array.from(byBranch.entries())
      .sort(sortNullLast)
      .map(([branch, v]) => ({
        branch,
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByBranchRow[],
    byCostCategory: (
      [
        "PRODUCTION_COGS",
        "DEVELOPMENT_RD",
        "SALES_SM",
        "GENERAL_GA",
        "INTERNAL_TOOL",
        "UNCLASSIFIED",
      ] as const
    )
      .filter((cat) => byCostCategory.has(cat))
      .map((costCategory) => {
        const v = byCostCategory.get(costCategory)!;
        return {
          costCategory,
          cost: v.cost,
          eventCount: v.eventCount,
        };
      }) as CostByCostCategoryRow[],
    byEnvironment: Array.from(byEnvironment.entries())
      .sort(sortNullLast)
      .map(([environment, v]) => ({
        environment,
        cost: v.cost,
        eventCount: v.eventCount,
      })) as CostByEnvironmentRow[],
  };
}

export async function getCostMetrics(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  filters: RevenueFilters = {},
  options: { priorWindow?: RevenueWindow } = {},
): Promise<CostMetrics> {
  const primary = await computeCostMetricsForWindow(db, orgId, window, filters);

  if (!options.priorWindow) {
    return primary;
  }

  // One extra DB query — only runs when a trend comparison was explicitly requested.
  const prior = await computeCostMetricsForWindow(
    db,
    orgId,
    options.priorWindow,
    filters,
  );

  return { ...primary, prior };
}

// ─── Ergonomic re-exports ──────────────────────────────────────────────────
export type { CalcStrategy, CalcTier } from "./revenue-calc";
export { toNumber } from "./revenue-calc";

// Keep these exported so the seed and NestJS services can call the pure calc
// primitives directly during invoice generation without re-implementing them.
export {
  applyMinCommitment,
  calcCreditPool,
  calcCreditPoolWithBreakdown,
  calcFlat,
  calcGraduated,
  calcGraduatedWithBreakdown,
  calcOnetimeRevenue,
  calcProrationFactor,
  calcRecurringRevenue,
  calcRouted,
  calcSeatRevenue,
  calcUsageCharge,
  calcUsageRevenue,
  calcVolume,
  calcVolumeWithBreakdown,
  creditPoolFee,
} from "./revenue-calc";
export type { TierBreakdownRow } from "./revenue-calc";

// Type re-export so consumers can `import { RevenueMetrics } from '@marginfront/db'`.
export type {
  AgentEarned,
  AgentEarnedStrategyRow,
  AgentEarnedSubscriptionRow,
  CostByAgentRow,
  CostByBranchRow,
  CostByRepoRow,
  CostByCostCategoryRow,
  CostByCustomerRow,
  CostByDayRow,
  CostByEnvironmentRow,
  CostByModelRow,
  CostByPlanRow,
  CostBySignalRow,
  CostMetrics,
  InvoiceTotals,
  Mrr,
  RevenueFilters,
  RevenueMetrics,
  RevenueWindow,
  StrategyRevenue,
  SubscriptionRevenue,
} from "../schemas/revenue-metrics";
