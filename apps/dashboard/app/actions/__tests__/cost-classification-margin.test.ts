/**
 * WHAT THIS FILE DOES: Proves the "uncategorized is its own bucket" rule for
 * the AI gross margin headline. It drives getCostClassificationBreakdown with
 * controlled per-category costs (a non-zero UNCLASSIFIED bucket alongside a
 * PRODUCTION_COGS bucket) and asserts the margin is computed on CLASSIFIED COGS
 * only — never on cogsCost + unclassifiedCost.
 *
 * WHY IT EXISTS: margin never folds uncategorized cost into COGS
 * (`effectiveCogsCost = cogsCost + unclassifiedCost`). These assertions are
 * written so they would FAIL under such a fold: with cogsCost=X and
 * unclassifiedCost=Y>0, a fold returns revenue − (X+Y); the code returns
 * revenue − X. Uncategorized stays its own visible line and surfaces
 * via hasUnclassifiedCost.
 *
 * CONNECTS TO: app/actions/cost-command-center.ts (getCostClassificationBreakdown,
 * the function under test) and @marginfront/db (canonGetCostMetrics /
 * canonGetRevenueMetrics, which we mock here so we can control category costs
 * without seeding the test database).
 *
 * Unlike cost-command-center.integration.test.ts (which runs against the live
 * seeded DB), this file mocks the canon library so the per-category split is
 * fully controlled.
 */

import { buildAuthMock, buildHeadersMock } from './_helpers/mock-session'

// Mock the canon library so we control exactly what cost + revenue come back.
// The action only reads `cost.byCostCategory`, `cost.byEnvironment`,
// `cost.cost`, and `revenueMetrics.revenue` — we provide those shapes.
const getCostMetricsMock = jest.fn()
const getRevenueMetricsMock = jest.fn()
jest.mock('@marginfront/db', () => ({
  getCostMetrics: (...args: unknown[]) => getCostMetricsMock(...args),
  getRevenueMetrics: (...args: unknown[]) => getRevenueMetricsMock(...args),
}))

// This suite exercises the LIVE recompute path, so the period
// is never locked here. The lock guard itself is covered by period-lock-*.test.ts.
jest.mock('../_shared/period-lock-store', () => ({
  findLockedPeriod: async () => null,
}))

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type CostCommandCenterModule = typeof import('../cost-command-center')
let actions: CostCommandCenterModule

// Controlled inputs. cogsCost (X) is classified COGS; unclassifiedCost (Y>0)
// is the uncategorized bucket that must NOT be folded into COGS; revenue (R).
const X_COGS = 100
const Y_UNCLASSIFIED = 40
const R_REVENUE = 500

beforeAll(async () => {
  authMock.__setSessionOrgId('org-test-d8')
  actions = await import('../cost-command-center')
})

beforeEach(() => {
  getCostMetricsMock.mockReset()
  getRevenueMetricsMock.mockReset()

  // byCostCategory carries a classified COGS row AND a non-zero UNCLASSIFIED
  // row. cost.cost is the canonical total (X + Y) used only by the blended
  // margin. byEnvironment is irrelevant to this test but must be an array.
  getCostMetricsMock.mockResolvedValue({
    cost: X_COGS + Y_UNCLASSIFIED,
    byCostCategory: [
      { costCategory: 'PRODUCTION_COGS', cost: X_COGS, eventCount: 3 },
      { costCategory: 'UNCLASSIFIED', cost: Y_UNCLASSIFIED, eventCount: 2 },
    ],
    byEnvironment: [],
  })
  getRevenueMetricsMock.mockResolvedValue({ revenue: R_REVENUE })
})

describe('getCostClassificationBreakdown — classified-COGS-only margin', () => {
  it('computes aiGrossMargin on classified COGS only (revenue − cogsCost), never folding in uncategorized', async () => {
    const breakdown = await actions.getCostClassificationBreakdown()

    // R − X. A fold would give R − (X + Y).
    expect(breakdown.aiGrossMargin).toBe(R_REVENUE - X_COGS)
    expect(breakdown.aiGrossMargin).not.toBe(R_REVENUE - (X_COGS + Y_UNCLASSIFIED))
  })

  it('aiGrossMarginPercent uses classified COGS only (canon M1: ratio of classified margin)', async () => {
    const breakdown = await actions.getCostClassificationBreakdown()

    expect(breakdown.aiGrossMarginPercent).toBe((R_REVENUE - X_COGS) / R_REVENUE)
  })

  it('aiCogsAsPercentOfRevenue uses cogsCost only, excluding the uncategorized bucket', async () => {
    const breakdown = await actions.getCostClassificationBreakdown()

    expect(breakdown.aiCogsAsPercentOfRevenue).toBe(X_COGS / R_REVENUE)
    // A fold would give (X + Y) / R; assert it does not.
    expect(breakdown.aiCogsAsPercentOfRevenue).not.toBe(
      (X_COGS + Y_UNCLASSIFIED) / R_REVENUE,
    )
  })

  it('keeps uncategorized as its own visible bucket and flags it via hasUnclassifiedCost', async () => {
    const breakdown = await actions.getCostClassificationBreakdown()

    // Uncategorized survives as its own line, never folded into COGS.
    expect(breakdown.unclassifiedCost).toBe(Y_UNCLASSIFIED)
    expect(breakdown.unclassifiedEventCount).toBe(2)
    expect(breakdown.hasUnclassifiedCost).toBe(true)
    // cogsCost on the return is the classified COGS alone.
    expect(breakdown.cogsCost).toBe(X_COGS)
  })

  it('returns null margin percents on zero revenue (canon M1), never 0% or NaN%', async () => {
    getRevenueMetricsMock.mockResolvedValue({ revenue: 0 })

    const breakdown = await actions.getCostClassificationBreakdown()

    expect(breakdown.aiGrossMarginPercent).toBeNull()
    expect(breakdown.aiCogsAsPercentOfRevenue).toBeNull()
  })
})
