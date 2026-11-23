'use server'

/**
 * Customer MRR/ARR — thin wrapper over the canonical MRR library.
 *
 * canonGetMrr (MRR1, contracted monthly recurring revenue today) and
 * canonGetRunRateMrr (MRR2, contract commitments plus actual last-30-days
 * usage, monthly-normalized) own all the math, so both tiles are
 * deterministic.
 *
 *   - Response carries a per-sub breakdown (enriched with sub name, plan
 *     name, status, billing cycle) so the customer detail collapsible
 *     shows "MRR breakdown by subscription" without a second fetch.
 *   - revenueTypeSplit (recurring / seat-based / usage) totals on
 *     the Run-Rate MRR basis (MRR2).
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getMrr as canonGetMrr,
  getRunRateMrr as canonGetRunRateMrr,
} from '@marginfront/db'

// ─── Types ────────────────────────────────────────────────────────────────

export interface SubscriptionMrrBreakdown {
  subscriptionId: string
  subscriptionName: string
  customerId: string
  agentId: string
  planId: string
  planName: string
  status: string
  billingCycle: string
  /** Monthly-normalized recurring fees for this sub. */
  recurring: number
  /** Monthly-normalized seat fees: max(seatsCount, minCommit) × rate. */
  seatBased: number
  /** Last-30-days actual usage through calcRouted(strategy, qty). */
  usage: number
  /** Sum of the three above = this sub's Run-Rate MRR contribution. */
  total: number
}

export interface CustomerMrrArrResponse {
  customerId: string
  customerName: string
  /** Canon MRR1: contracted monthly recurring value (recurring + seat; usage/onetime excluded). */
  mrr: number
  /** mrr × 12. */
  arr: number
  /** Canon MRR2: 30-day run-rate (contract floors + actual usage). */
  runRateMrr: number
  /** runRateMrr × 12. */
  runRateArr: number
  /** Totals on the Run-Rate basis, by charge type. */
  revenueTypeSplit: {
    recurring: number
    seatBased: number
    usage: number
  }
  breakdown: SubscriptionMrrBreakdown[]
  activeSubscriptionCount: number
  calculatedAt: string
}

// ─── Main Server Action ───────────────────────────────────────────────────

export async function getCustomerMrrArr(customerId: string): Promise<{
  success: boolean
  data?: CustomerMrrArrResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const customer = await prisma.customers.findFirst({
      where: { id: customerId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!customer) {
      return { success: false, error: 'Customer not found' }
    }

    const [mrrResult, runRateResult, activeSubscriptionCount, enrichmentSubs] =
      await Promise.all([
        canonGetMrr(prisma, orgId, { customerId }),
        canonGetRunRateMrr(prisma, orgId, { customerId }),
        prisma.subscriptions.count({
          where: {
            customerId,
            organizationId: orgId,
            deletedAt: null,
            status: 'active',
          },
        }),
        // One pass to collect the display-only metadata the UI needs
        // for the "MRR breakdown by subscription" collapsible. Status
        // filter mirrors the canonical library (active + pending).
        prisma.subscriptions.findMany({
          where: {
            customerId,
            organizationId: orgId,
            deletedAt: null,
            status: { in: ['active', 'pending'] },
          },
          select: {
            id: true,
            name: true,
            status: true,
            billingCycle: true,
            pricing_plans: { select: { name: true } },
          },
        }),
      ])

    const enrichmentById = new Map(enrichmentSubs.map((s) => [s.id, s]))

    const breakdown: SubscriptionMrrBreakdown[] = runRateResult.breakdown.map(
      (row) => {
        const meta = enrichmentById.get(row.subscriptionId)
        return {
          subscriptionId: row.subscriptionId,
          subscriptionName: meta?.name ?? 'Unknown subscription',
          customerId: row.customerId,
          agentId: row.agentId,
          planId: row.planId,
          planName: meta?.pricing_plans?.name ?? 'No plan',
          status: meta?.status ?? 'unknown',
          billingCycle: meta?.billingCycle ?? 'monthly',
          recurring: row.recurring,
          seatBased: row.seatBased,
          usage: row.usage,
          total: row.total,
        }
      }
    )

    const revenueTypeSplit = breakdown.reduce(
      (acc, row) => {
        acc.recurring += row.recurring
        acc.seatBased += row.seatBased
        acc.usage += row.usage
        return acc
      },
      { recurring: 0, seatBased: 0, usage: 0 }
    )

    return {
      success: true,
      data: {
        customerId,
        customerName: customer.name,
        mrr: mrrResult.mrr,
        arr: mrrResult.arr,
        runRateMrr: runRateResult.mrr,
        runRateArr: runRateResult.mrr * 12,
        revenueTypeSplit,
        breakdown,
        activeSubscriptionCount,
        calculatedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    console.error('[getCustomerMrrArr] Error:', error)
    return { success: false, error: 'Failed to calculate MRR/ARR' }
  }
}
