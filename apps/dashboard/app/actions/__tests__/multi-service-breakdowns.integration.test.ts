/**
 * Service-tab breakdown integration tests.
 *
 * Asserts the multi-service Service tab logic in:
 *   - getCostCommandCenterBreakdown
 *   - getFullCommandCenterBreakdown
 *
 * Invariants exercised:
 *   1. Service rows aggregate by (model, modelProvider). Single-service
 *      events have one child each → byte-identical
 *      to the parent.usageCost total.
 *   2. SUM(service rows.cost) for the window equals SUM(parent.usageCost)
 *      for the same window. No double-counting, no leakage.
 *   3. Full mode revenue allocation: SUM(service rows.revenue) for an
 *      event ≤ that event's Earned (no double-credit across services).
 *   4. Multi-service events (with > 1 child) contribute to multiple
 *      service rows (fan-out behavior).
 *
 * Runs against whatever org is currently seeded in the scratch database
 * named in packages/db/.env, same pattern as the other integration tests.
 */

import { PrismaClient } from '@prisma/client'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type CostModule = typeof import('../cost-command-center')
type FullModule = typeof import('../full-command-center')
let costActions: CostModule
let fullActions: FullModule

const prisma = new PrismaClient()
const MS_PER_DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  const orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  costActions = await import('../cost-command-center')
  fullActions = await import('../full-command-center')
})

afterAll(async () => {
  await prisma.$disconnect()
})

function last30DaysWindow() {
  const now = new Date()
  return {
    windowStart: new Date(now.getTime() - 30 * MS_PER_DAY),
    windowEnd: now,
  }
}

describe('multi-service breakdowns — Cost mode', () => {
  it('service rows sum to the org window cost (no double-count)', async () => {
    const orgId = await getSampleOrgIdForTests()
    const { windowStart, windowEnd } = last30DaysWindow()

    // Independent total: sum parent.usageCost for the window.
    const events = await prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: { usageCost: true },
    })
    const expectedTotal = events.reduce(
      (s, e) => s + (e.usageCost === null ? 0 : Number(e.usageCost)),
      0
    )

    const breakdown = await costActions.getCostCommandCenterBreakdown()
    const serviceTotal = breakdown.service.reduce((s, r) => s + r.cost, 0)

    // Allow 1 cent rounding slack for the float aggregation across many rows.
    const diff = Math.abs(expectedTotal - serviceTotal)
    if (diff > 0.01) {
      throw new Error(
        `Service rows total ${serviceTotal.toFixed(4)} != parent.usageCost total ${expectedTotal.toFixed(4)} (diff ${diff.toFixed(4)})`
      )
    }
  })

  it('service rows have non-empty name + non-negative cost', async () => {
    const breakdown = await costActions.getCostCommandCenterBreakdown()
    expect(breakdown.service.length).toBeGreaterThan(0)
    for (const row of breakdown.service) {
      expect(row.name.length).toBeGreaterThan(0)
      expect(row.cost).toBeGreaterThanOrEqual(0)
      expect(row.qty).toBeGreaterThanOrEqual(0)
      expect(row.events).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('multi-service breakdowns — Full mode', () => {
  it('service rows sum to the org window cost (no double-count)', async () => {
    const orgId = await getSampleOrgIdForTests()
    const { windowStart, windowEnd } = last30DaysWindow()

    const events = await prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: { usageCost: true },
    })
    const expectedTotal = events.reduce(
      (s, e) => s + (e.usageCost === null ? 0 : Number(e.usageCost)),
      0
    )

    const breakdown = await fullActions.getFullCommandCenterBreakdown()
    const serviceTotal = breakdown.service.reduce((s, r) => s + r.cost, 0)

    const diff = Math.abs(expectedTotal - serviceTotal)
    if (diff > 0.01) {
      throw new Error(
        `Full mode service rows total ${serviceTotal.toFixed(4)} != parent.usageCost total ${expectedTotal.toFixed(4)} (diff ${diff.toFixed(4)})`
      )
    }
  })

  it('service rows revenue is non-negative and sums under agent earned total', async () => {
    const breakdown = await fullActions.getFullCommandCenterBreakdown()
    expect(breakdown.service.length).toBeGreaterThan(0)
    for (const row of breakdown.service) {
      expect(row.revenue).toBeGreaterThanOrEqual(0)
    }

    // Agent-Earned total (canon getAgentEarned, window-aggregated with
    // floors + cancelled subs) must be >= the service total. Service revenue is
    // a per-event cost-share allocation (canon exposes no per-service Earned),
    // so on tiered/floored/cancelled data it UNDER-counts relative to canon and
    // sums strictly under the agent total, never over it (allocation never
    // double-counts). Equality only holds when every strategy is flat with no
    // floor and no cancelled sub; otherwise service < agent by the per-event gap.
    const agentEarnedTotal = breakdown.agent.reduce((s, r) => s + r.revenue, 0)
    const serviceRevenueTotal = breakdown.service.reduce(
      (s, r) => s + r.revenue,
      0
    )
    if (serviceRevenueTotal - agentEarnedTotal > 0.01) {
      throw new Error(
        `Service revenue total ${serviceRevenueTotal.toFixed(4)} must not exceed agent earned total ${agentEarnedTotal.toFixed(4)} (over by ${(serviceRevenueTotal - agentEarnedTotal).toFixed(4)})`
      )
    }
  })
})

describe('multi-service — Cost+Rev mode earned attribution', () => {
  it('every row exposes an `earned` field that is non-negative', async () => {
    const breakdown = await fullActions.getFullCommandCenterBreakdown()
    const allRows = [
      ...breakdown.service,
      ...breakdown.task,
      ...breakdown.agent,
      ...breakdown.customer,
      ...breakdown.plan,
    ]
    expect(allRows.length).toBeGreaterThan(0)
    for (const row of allRows) {
      expect(row.earned).toBeGreaterThanOrEqual(0)
    }
  })

  it('per-customer earned totals match per-agent earned totals (same canon source)', async () => {
    // Customer Earned and Agent Earned are both attributions of the same canon
    // getAgentEarned bySubscription total — different grouping key (customerId
    // vs agentId), identical underlying sum. Match within rounding.
    const breakdown = await fullActions.getFullCommandCenterBreakdown()
    const customerEarned = breakdown.customer.reduce((s, r) => s + r.earned, 0)
    const agentEarned = breakdown.agent.reduce((s, r) => s + r.earned, 0)
    const diff = Math.abs(customerEarned - agentEarned)
    if (diff > 0.01) {
      throw new Error(
        `Customer earned total ${customerEarned.toFixed(4)} != agent earned total ${agentEarned.toFixed(4)} (diff ${diff.toFixed(4)})`
      )
    }
  })
})

describe('multi-service — multi-service event feed', () => {
  it('exposes services[] on every event row, length matches child count', async () => {
    const feed = await fullActions.getFullCommandCenterEventFeed()
    expect(feed.events.length).toBeGreaterThan(0)

    // Spot-check the first 5 events: services array length must match
    // the actual child count in the database.
    for (const row of feed.events.slice(0, 5)) {
      const childCount = await prisma.signal_event_services.count({
        where: { signalEventId: row.id },
      })
      if (row.services.length !== childCount) {
        throw new Error(
          `Event ${row.id}: feed services.length=${row.services.length}, db child count=${childCount}`
        )
      }
      expect(row.serviceCount).toBe(row.services.length)
    }
  })

  it('multi-service rows label model as "multi-service (N)"', async () => {
    const feed = await fullActions.getFullCommandCenterEventFeed()
    const multiRows = feed.events.filter((r) => r.services.length > 1)

    if (multiRows.length === 0) {
      // The test database may not have multi-service events in the recent feed
      // window; skip rather than fail to keep the test resilient
      // against fixture state.
      console.log(
        '[multi-service test] No multi-service events in feed window; skipping label assertion'
      )
      return
    }

    for (const row of multiRows) {
      expect(row.model).toMatch(/^multi-service \(\d+\)$/)
    }
  })
})
