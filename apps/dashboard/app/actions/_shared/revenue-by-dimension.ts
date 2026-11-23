/**
 * Per-bucket revenue for the Money breakdown, UUID-keyed
 * to line up with getCostBreakdown's BreakdownRow.key.
 *
 * WHY this exists separately from getCostBreakdown: cost is one REPEATABLE READ
 * SQL snapshot (packages/db cost-grouping.ts) returning cost-only rows. Revenue
 * is app-local canon composition — Earned by bucketing canon getAgentEarned
 * (agent, signal), Billed via a plain invoice SUM (customer, plan). It is a
 * SEPARATE read from the cost snapshot (a parity test guarantees the numbers equal the XLSX export's
 * getFullCommandCenterBreakdown for the same window + dimension).
 *
 * NOT 'use server': it takes an injected PrismaClient (no module-scope client)
 * so the pure aggregation below is unit-testable without a DB, and it exports
 * sync helpers a 'use server' file could not.
 *
 * NO fabrication: model / environment / day / costCategory return null here —
 * there is no honest per-bucket revenue for them (canon M2). This module never
 * cost-share-allocates revenue.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { getAgentEarned, type RevenueFilters, type RevenueWindow } from '@marginfront/db'
import type { Dimension } from '@/lib/component-catalog'
import { earnedBucketsFromAgentEarned } from './per-event-earned'
import { revenueBasisForDimension, type RevenueBasis } from '@/lib/revenue-basis'

export interface DimensionRevenue {
  basis: RevenueBasis
  /** bucket key (UUID string, identical to BreakdownRow.key) → revenue dollars.
   * Only non-zero buckets are stored; a missing key means $0, not "undefined"
   * (the caller reads `?? 0`). */
  byKey: Map<string, number>
  /** Σ of every bucket's revenue over the window — the reconciling total the
   * caller uses to derive the folded-away "Other" revenue. */
  total: number
}

export interface BilledInvoiceInput {
  customerId: string
  planId: string | null
  totalAmount: unknown
}

/**
 * Pure: sum invoice.totalAmount into the bucket named by `keyOf`. Invoices
 * with a null key (e.g. a one-off invoice with no plan) are not attributable
 * to that dimension and are dropped — matching getFullCommandCenterBreakdown,
 * whose revenueByPlanId only keys plan-bearing invoices. Summing a stored
 * canon column is not freelance math.
 */
export function aggregateBilled(
  invoices: BilledInvoiceInput[],
  keyOf: (invoice: BilledInvoiceInput) => string | null
): { byKey: Map<string, number>; total: number } {
  const byKey = new Map<string, number>()
  let total = 0
  for (const invoice of invoices) {
    const key = keyOf(invoice)
    if (key === null) continue
    const amount = Number(invoice.totalAmount ?? 0)
    byKey.set(key, (byKey.get(key) ?? 0) + amount)
    total += amount
  }
  return { byKey, total }
}

/**
 * Per-bucket revenue for one dimension over `window`, or null when the
 * dimension is not revenue-definable. Returns before touching the DB in the
 * null case, so callers can safely probe definability without a connection.
 *
 * Filter application mirrors the surfaces this must agree with:
 *   - Earned (agent/signal): canon getAgentEarned over org + window + the same
 *     filters, then bucketed by dimension. Canon prices each (sub, signal)'s
 *     window-aggregated quantity ONCE (tiers cross, floors apply) and resolves
 *     subs by date-overlap (cancelled subs included), NOT per-event.
 *   - Billed invoices: org + invoiceDate window + status issued/paid/overdue +
 *     customerId + agentId (via subscriptions), mirroring
 *     getFullCommandCenterBreakdown's invoicesWhere — the parity target.
 * The parity test only exercises customerId/agentId (all the XLSX path
 * accepts), under which both paths reduce to full-command-center's filters.
 */
export async function getRevenueByDimension(
  prisma: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  dimension: Dimension,
  filters: RevenueFilters = {}
): Promise<DimensionRevenue | null> {
  const basis = revenueBasisForDimension(dimension)
  if (basis === null) return null

  if (basis === 'earned') {
    // Canon Earned, bucket-priced. getAgentEarned aggregates each (sub, signal)
    // quantity over the window and prices it once, applies min-commitment
    // floors, and includes cancelled subs by date-overlap. Bucketing its rows
    // to agent/signal is exactly how canon attributes them — so this bucket
    // EQUALS getAgentEarned's number for the same key by construction.
    const agentEarned = await getAgentEarned(prisma, orgId, window, filters)
    const buckets = earnedBucketsFromAgentEarned(agentEarned)
    const dimensionBuckets =
      dimension === 'agent' ? buckets.byAgentId : buckets.bySignalId

    // Keep only non-zero buckets (DimensionRevenue contract) and reconcile
    // total from what we actually keyed.
    const byKey = new Map<string, number>()
    let total = 0
    for (const [key, value] of dimensionBuckets) {
      if (value === 0) continue
      byKey.set(key, value)
      total += value
    }
    return { basis, byKey, total }
  }

  // basis === 'billed' (customer, plan)
  const invoicesWhere: Prisma.invoicesWhereInput = {
    organizationId: orgId,
    invoiceDate: { gte: window.start, lte: window.end },
    status: { in: ['issued', 'paid', 'overdue'] },
  }
  if (filters.customerId) invoicesWhere.customerId = filters.customerId
  if (filters.agentId) invoicesWhere.subscriptions = { agentId: filters.agentId }

  // Billed honors only customerId/agentId: invoices carry no signalId, and
  // subscriptionId is not applied. A caller that passes a signal or subscription
  // filter gets filtered cost against unfiltered billed revenue, which inflates
  // per-bucket margin.
  const invoices = await prisma.invoices.findMany({
    where: invoicesWhere,
    select: {
      customerId: true,
      totalAmount: true,
      subscriptions: { select: { planId: true } },
    },
  })
  const billedInput: BilledInvoiceInput[] = invoices.map((invoice) => ({
    customerId: invoice.customerId,
    planId: invoice.subscriptions?.planId ?? null,
    totalAmount: invoice.totalAmount,
  }))
  const keyOf: (invoice: BilledInvoiceInput) => string | null =
    dimension === 'customer'
      ? (invoice) => invoice.customerId
      : (invoice) => invoice.planId
  const { byKey, total } = aggregateBilled(billedInput, keyOf)
  return { basis, byKey, total }
}
