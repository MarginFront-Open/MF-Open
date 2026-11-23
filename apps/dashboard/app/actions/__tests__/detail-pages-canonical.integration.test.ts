/**
 * Parity tests for the Customer + Subscription detail pages' canonical
 * metrics wiring.
 *
 * Three tests:
 *   1. getCanonicalCustomerMetrics totals match direct canonGetRevenueMetrics
 *      + canonGetCostMetrics recompute for the same customer + window.
 *   2. getCanonicalSubscriptionMetrics matches the canonical lib for
 *      { subscriptionId }.
 *   3. getCustomerShareOfRevenue matches an independent raw-invoice sum of
 *      (customer paid totals) / (org paid totals) * 100. Independent of
 *      the canonical library entirely; this one catches a wrong
 *      invoice filter (status, deletedAt, customerId scoping).
 *
 * Runs against the sample data seeded into the
 * scratch database named in packages/db/.env.
 */

import { PrismaClient } from '@prisma/client'
import {
  getRevenueMetrics as canonGetRevenueMetrics,
  getCostMetrics as canonGetCostMetrics,
} from '@marginfront/db'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type AnalyticsModule = typeof import('../analytics')
let actions: AnalyticsModule

const prisma = new PrismaClient()
const MS_PER_DAY = 24 * 60 * 60 * 1000
// Penny-level tolerance: both sides use the same canonical floats, so diffs
// beyond a cent are real errors rather than rounding noise.
const EPSILON = 0.01

beforeAll(async () => {
  const orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  actions = await import('../analytics')
})

afterAll(async () => {
  await prisma.$disconnect()
})

function resolveWindow(
  start?: string,
  end?: string
): { start: Date; end: Date } {
  const now = new Date()
  return {
    start: start ? new Date(start) : new Date(now.getTime() - 30 * MS_PER_DAY),
    end: end ? new Date(end) : now,
  }
}

/**
 * Pick a customer that actually has at least one active subscription with
 * some activity in the 30-day window. Tests that assert "action matches
 * canonical" are only meaningful when the canonical numbers aren't both
 * zero. Falls back to the first customer the test organization returns if no active
 * sub exists, which still exercises the code path.
 */
async function pickActiveCustomer(orgId: string): Promise<string> {
  const sub = await prisma.subscriptions.findFirst({
    where: {
      organizationId: orgId,
      status: 'active',
      deletedAt: null,
    },
    select: { customerId: true },
  })
  if (sub) return sub.customerId

  const anyCustomer = await prisma.customers.findFirst({
    where: { organizationId: orgId, deletedAt: null, isInternal: false },
    select: { id: true },
  })
  if (!anyCustomer) {
    throw new Error('No customers in the test organization')
  }
  return anyCustomer.id
}

async function pickActiveSubscription(orgId: string): Promise<string> {
  const sub = await prisma.subscriptions.findFirst({
    where: {
      organizationId: orgId,
      status: 'active',
      deletedAt: null,
    },
    select: { id: true },
  })
  if (!sub) {
    throw new Error('No active subscriptions in the test organization for parity testing')
  }
  return sub.id
}

describe('Detail-page canonical metrics — parity tests', () => {
  it('getCanonicalCustomerMetrics totals match direct canon recompute', async () => {
    const orgId = await getSampleOrgIdForTests()
    const customerId = await pickActiveCustomer(orgId)

    const actionResult = await actions.getCanonicalCustomerMetrics(customerId)
    expect(actionResult.success).toBe(true)
    expect(actionResult.data).toBeDefined()
    const data = actionResult.data!

    const window = resolveWindow(data.period.startDate, data.period.endDate)
    const [expectedRevenue, expectedCost] = await Promise.all([
      canonGetRevenueMetrics(prisma, orgId, window, { customerId }),
      canonGetCostMetrics(prisma, orgId, window, { customerId }),
    ])

    const revDiff = Math.abs(data.totals.revenue - expectedRevenue.revenue)
    const costDiff = Math.abs(data.totals.cost - expectedCost.cost)
    if (revDiff > EPSILON) {
      throw new Error(
        `Customer totals revenue: action=${data.totals.revenue.toFixed(4)}, expected=${expectedRevenue.revenue.toFixed(4)} (diff ${revDiff.toFixed(4)})`
      )
    }
    if (costDiff > EPSILON) {
      throw new Error(
        `Customer totals cost: action=${data.totals.cost.toFixed(4)}, expected=${expectedCost.cost.toFixed(4)} (diff ${costDiff.toFixed(4)})`
      )
    }

    // Per-sub breakdown: every row in the action output must match the
    // canonical lib called with { subscriptionId }.
    for (const row of data.bySubscription) {
      const [subRev, subCost] = await Promise.all([
        canonGetRevenueMetrics(prisma, orgId, window, {
          subscriptionId: row.subscriptionId,
        }),
        canonGetCostMetrics(prisma, orgId, window, {
          subscriptionId: row.subscriptionId,
        }),
      ])
      const rDiff = Math.abs(row.revenue - subRev.revenue)
      const cDiff = Math.abs(row.cost - subCost.cost)
      if (rDiff > EPSILON || cDiff > EPSILON) {
        throw new Error(
          `Per-sub ${row.subscriptionId}: revenue diff ${rDiff.toFixed(4)}, cost diff ${cDiff.toFixed(4)}`
        )
      }
    }
  })

  it('getCanonicalSubscriptionMetrics matches direct canon recompute', async () => {
    const orgId = await getSampleOrgIdForTests()
    const subscriptionId = await pickActiveSubscription(orgId)

    const actionResult =
      await actions.getCanonicalSubscriptionMetrics(subscriptionId)
    expect(actionResult.success).toBe(true)
    expect(actionResult.data).toBeDefined()
    const data = actionResult.data!

    const window = resolveWindow(data.period.startDate, data.period.endDate)
    const [expectedRevenue, expectedCost] = await Promise.all([
      canonGetRevenueMetrics(prisma, orgId, window, { subscriptionId }),
      canonGetCostMetrics(prisma, orgId, window, { subscriptionId }),
    ])

    const revDiff = Math.abs(data.revenue - expectedRevenue.revenue)
    const costDiff = Math.abs(data.cost - expectedCost.cost)
    if (revDiff > EPSILON) {
      throw new Error(
        `Sub revenue: action=${data.revenue.toFixed(4)}, expected=${expectedRevenue.revenue.toFixed(4)} (diff ${revDiff.toFixed(4)})`
      )
    }
    if (costDiff > EPSILON) {
      throw new Error(
        `Sub cost: action=${data.cost.toFixed(4)}, expected=${expectedCost.cost.toFixed(4)} (diff ${costDiff.toFixed(4)})`
      )
    }
  })

  /**
   * The subscription detail Metric-Level Breakdown table reads revenue
   * through canonGetRevenueMetrics (R1 per signal + a synthetic
   * "Subscription fees" row carrying R2 fees), not invoice line items,
   * which are $0 mid-cycle. This test asserts two invariants on that path:
   *
   *   1. summary.totalRevenue equals canon Revenue (full formula) for
   *      the same window — same source as the KPI tile.
   *   2. signalSummary rows sum to summary.totalRevenue within rounding.
   *      Per-signal rows are Agent-Earned (R1 per signalId), the
   *      "Subscription fees" row is R2 sub-level fees, and together they
   *      close to canon Revenue.
   */
  it('getSubscriptionAnalytics revenue reconciles with canon Revenue', async () => {
    const orgId = await getSampleOrgIdForTests()
    const subscriptionId = await pickActiveSubscription(orgId)

    // Use a 30-day window — same shape the tile would see.
    const now = new Date()
    const start = new Date(now.getTime() - 30 * MS_PER_DAY)
    const result = await actions.getSubscriptionAnalytics(subscriptionId, {
      billingPeriodStart: start.toISOString(),
      billingPeriodEnd: now.toISOString(),
    })
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    const data = result.data!

    const expected = await canonGetRevenueMetrics(
      prisma,
      orgId,
      { start, end: now },
      { subscriptionId }
    )

    const summaryDiff = Math.abs(data.summary.totalRevenue - expected.revenue)
    if (summaryDiff > EPSILON) {
      throw new Error(
        `summary.totalRevenue: action=${data.summary.totalRevenue.toFixed(4)}, canon=${expected.revenue.toFixed(4)} (diff ${summaryDiff.toFixed(4)})`
      )
    }

    const rowsSum = data.signalSummary.reduce(
      (s, row) => s + row.totalRevenue,
      0
    )
    const rowsDiff = Math.abs(rowsSum - data.summary.totalRevenue)
    if (rowsDiff > EPSILON) {
      throw new Error(
        `signalSummary rows do not reconcile with summary.totalRevenue: rows=${rowsSum.toFixed(4)}, summary=${data.summary.totalRevenue.toFixed(4)} (diff ${rowsDiff.toFixed(4)})`
      )
    }
  })

  it('getCustomerShareOfRevenue matches independent invoice-sum ratio NET of refunds', async () => {
    const orgId = await getSampleOrgIdForTests()
    const customerId = await pickActiveCustomer(orgId)

    const actionResult = await actions.getCustomerShareOfRevenue(customerId)
    expect(actionResult.success).toBe(true)
    expect(actionResult.data).toBeDefined()
    const data = actionResult.data!

    // Independent recompute: Collected is CASH-BASIS — the sum
    // of succeeded payments (each net of its refund) on non-void invoices, plus
    // an invoiceDate fallback for any paid invoice that has no payment row at
    // all. The window here is all-time, so every payment counts. This mirrors
    // canon getInvoiceTotals so a fault in either the action OR canon
    // surfaces as a diff, without calling canon itself.
    async function cashCollected(scope: { customerId?: string }): Promise<number> {
      const invoiceScope = {
        organizationId: orgId,
        deletedAt: null,
        status: { not: 'void' as any },
        ...(scope.customerId ? { customerId: scope.customerId } : {}),
      }
      const [payments, paidNoPaymentRow] = await Promise.all([
        prisma.invoice_payments.findMany({
          where: { status: 'succeeded', invoices: invoiceScope },
          select: { amount: true, refunded_amount: true },
        }),
        prisma.invoices.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            status: 'paid' as any,
            invoice_payments: { none: {} },
            ...(scope.customerId ? { customerId: scope.customerId } : {}),
          },
          select: { totalAmount: true },
        }),
      ])
      let total = 0
      for (const p of payments) {
        total += Number(p.amount) - Number(p.refunded_amount)
      }
      for (const inv of paidNoPaymentRow) {
        total += Number(inv.totalAmount)
      }
      return total
    }

    const expectedCustomer = await cashCollected({ customerId })
    const expectedOrg = await cashCollected({})
    const expectedShare =
      expectedOrg > 0 ? (expectedCustomer / expectedOrg) * 100 : null

    const custDiff = Math.abs(data.customerCollected - expectedCustomer)
    const orgDiff = Math.abs(data.orgCollected - expectedOrg)
    if (custDiff > EPSILON) {
      throw new Error(
        `customerCollected: action=${data.customerCollected.toFixed(4)}, expected=${expectedCustomer.toFixed(4)} (diff ${custDiff.toFixed(4)})`
      )
    }
    if (orgDiff > EPSILON) {
      throw new Error(
        `orgCollected: action=${data.orgCollected.toFixed(4)}, expected=${expectedOrg.toFixed(4)} (diff ${orgDiff.toFixed(4)})`
      )
    }
    if (expectedShare === null) {
      expect(data.sharePercent).toBeNull()
    } else {
      expect(data.sharePercent).not.toBeNull()
      const shareDiff = Math.abs((data.sharePercent as number) - expectedShare)
      if (shareDiff > EPSILON) {
        throw new Error(
          `sharePercent: action=${(data.sharePercent as number).toFixed(4)}, expected=${expectedShare.toFixed(4)} (diff ${shareDiff.toFixed(4)})`
        )
      }
    }
  })
})
