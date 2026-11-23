/**
 * WHAT THIS FILE DOES: proves the load-bearing guarantee of the period lock
 * ("the close must close"). Two things must be true and both
 * are proven here against a fully-mocked DB:
 *
 *   1. IMMUTABILITY: when a period is CLOSED, getJournalExport returns the
 *      FROZEN snapshot and does NOT touch live signal/event data. This is what
 *      stops a reclassification from silently rewriting a posted journal CSV.
 *
 *   2. OPEN PERIODS STAY LIVE: when a period is NOT closed, getJournalExport
 *      recomputes from live data, so closing one month must not
 *      freeze every other month.
 *
 * We mock the lock store's findLockedPeriod to flip between "closed" and "open"
 * and assert both the returned value AND whether the live queries ran.
 *
 * CONNECTS TO: app/actions/journal-export.ts (under test),
 * app/actions/_shared/period-lock-store.ts (mocked).
 */

// Mark this file a module so its top-level test fixtures don't collide in the
// global scope with the sibling journal-export test (which uses the same names).
export {}

const ACTIVE_ORG = 'org-active-unit4'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ACTIVE_ORG },
        user: { id: 'user-1' },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
// Live-data spies — must NOT fire when a period is locked.
// journal-export.ts reads from @/app/lib/db (signals / signal_events, plus
// chart_of_accounts for the category fallback).
const signalsFindMany = jest.fn()
const eventsFindMany = jest.fn()
const chartFindMany = jest.fn()
const agentsFindMany = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    agents: { findMany: (args: unknown) => agentsFindMany(args) },
    signals: { findMany: (args: unknown) => signalsFindMany(args) },
    signal_events: { findMany: (args: unknown) => eventsFindMany(args) },
    chart_of_accounts: { findMany: (args: unknown) => chartFindMany(args) },
    ba_member: { findFirst: async () => ({ role: 'finance' }) },
  },
}))

// getProductLineMargins' live path (canon revenue lib, then agents.findMany) must
// never run for a locked period; the canon spy proves it.
const getRevenueMetricsMock = jest.fn()
const getCostMetricsMock = jest.fn()
jest.mock('@marginfront/db', () => ({
  MANAGE_MONEY_ROLES: ['owner', 'admin', 'finance'],
  getRevenueMetrics: (...args: unknown[]) => getRevenueMetricsMock(...args),
  getCostMetrics: (...args: unknown[]) => getCostMetricsMock(...args),
}))

// The lock store — we control whether the window is "closed".
const findLockedPeriod = jest.fn()
jest.mock('../_shared/period-lock-store', () => ({
  findLockedPeriod: (...args: unknown[]) => findLockedPeriod(...args),
}))

type JournalExportModule = typeof import('../journal-export')
type FinanceMetricsModule = typeof import('../finance-metrics')
let mod: JournalExportModule
let metrics: FinanceMetricsModule

beforeAll(async () => {
  mod = await import('../journal-export')
  metrics = await import('../finance-metrics')
})

beforeEach(() => {
  signalsFindMany.mockReset()
  eventsFindMany.mockReset()
  chartFindMany.mockReset()
  getRevenueMetricsMock.mockReset()
  getCostMetricsMock.mockReset()
  agentsFindMany.mockReset()
  findLockedPeriod.mockReset()
})

const PERIOD = { startDate: '2026-05-01', endDate: '2026-05-31' }

describe('getJournalExport — period lock guard', () => {
  it('serves the FROZEN snapshot and never queries live data when the period is closed', async () => {
    const frozenJournal = {
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-05-31T23:59:59.999Z',
      periodLabel: 'May 2026',
      rows: [
        {
          glCode: '5100',
          glName: 'AI Inference',
          accountingType: 'COGS',
          amount: 100,
          eventCount: 3,
        },
      ],
      totalAmount: 100,
      unmappedAmount: 0,
      hasUnmapped: false,
    }
    findLockedPeriod.mockResolvedValue({
      lockedAt: '2026-06-01T00:00:00.000Z',
      lockedByUserId: 'user-1',
      periodLabel: 'May 2026',
      snapshot: {
        version: 1,
        journal: frozenJournal,
        audit: {},
        breakdown: {},
        score: {},
      },
    })

    const result = await mod.getJournalExport(PERIOD)

    // Returned the frozen artifact verbatim...
    expect(result).toEqual(frozenJournal)
    // ...and did NOT recompute from live signals/events. THIS is the close
    // staying closed: a later reclassification can't change this number.
    expect(signalsFindMany).not.toHaveBeenCalled()
    expect(eventsFindMany).not.toHaveBeenCalled()
    // The category fallback runs BELOW the lock guard, so a closed
    // period never even reads the chart of accounts — the snapshot is frozen.
    expect(chartFindMany).not.toHaveBeenCalled()
  })

  it('recomputes live (open period) when there is no lock — closing one month does not freeze others', async () => {
    findLockedPeriod.mockResolvedValue(null)
    signalsFindMany.mockResolvedValue([
      {
        id: 'sig-a',
        glCodeId: 'gl-cogs',
        costCategory: 'PRODUCTION_COGS',
        chart_of_accounts: {
          glCode: '5100',
          glName: 'AI Inference',
          accountingType: 'COGS',
        },
      },
    ])
    eventsFindMany.mockResolvedValue([
      { signalId: 'sig-a', usageCost: 7 },
      { signalId: 'sig-a', usageCost: 5 },
    ])
    // sig-a is directly mapped, so the fallback is never consulted; an empty
    // chart keeps this assertion about the live total (12) intact.
    chartFindMany.mockResolvedValue([])

    const result = await mod.getJournalExport(PERIOD)

    // Live path ran and produced a recomputed total from current data.
    expect(signalsFindMany).toHaveBeenCalledTimes(1)
    expect(eventsFindMany).toHaveBeenCalledTimes(1)
    expect(result?.totalAmount).toBe(12)
    // And the live query was org-scoped (IDOR belt).
    expect(signalsFindMany.mock.calls[0][0].where).toMatchObject({
      orgId: ACTIVE_ORG,
      deletedAt: null,
    })
  })
})

describe('getProductLineMargins — period lock guard', () => {
  it('serves the FROZEN snapshot and never recomputes margins live when the period is closed', async () => {
    // This panel must not recompute live on a closed period; it serves the
    // frozen value verbatim.
    const frozenMargins = {
      periodLabel: 'May 2026',
      rows: [
        {
          agentId: 'agent-1',
          agentName: 'Support Bot',
          revenue: 1000,
          cost: 300,
          margin: 700,
          marginPercent: 0.7,
          customerCount: 4,
          subscriptionCount: 6,
        },
      ],
      blendedMarginPercent: 0.7,
      totalRevenue: 1000,
      totalCost: 300,
    }
    findLockedPeriod.mockResolvedValue({
      lockedAt: '2026-06-01T00:00:00.000Z',
      lockedByUserId: 'user-1',
      periodLabel: 'May 2026',
      snapshot: {
        version: 2,
        journal: {},
        audit: {},
        breakdown: {},
        score: {},
        productLineMargins: frozenMargins,
      },
    })

    const result = await metrics.getProductLineMargins(PERIOD)

    // Returned the frozen artifact verbatim...
    expect(result).toEqual(frozenMargins)
    // ...and did NOT recompute from live revenue/agent data. THIS is the close
    // staying closed for the margin table — a later reclassification can't move it.
    expect(getRevenueMetricsMock).not.toHaveBeenCalled()
    expect(agentsFindMany).not.toHaveBeenCalled()
  })

  it('recomputes live (open period) when there is no lock — closing one month does not freeze others', async () => {
    findLockedPeriod.mockResolvedValue(null)
    getRevenueMetricsMock.mockResolvedValue({
      bySubscription: [
        {
          agentId: 'agent-1',
          customerId: 'cust-1',
          revenue: 1000,
          // usageRevenue (canon Agent-Earned, R1) is the usage slice of the
          // 1000 total — the rest (300) is recurring/seat/one-time fees.
          usageRevenue: 700,
          cost: 300,
        },
      ],
    })
    agentsFindMany.mockResolvedValue([{ id: 'agent-1', name: 'Support Bot' }])

    const result = await metrics.getProductLineMargins(PERIOD)

    // Live path ran and produced a recomputed margin from current data.
    expect(getRevenueMetricsMock).toHaveBeenCalledTimes(1)
    expect(result?.totalRevenue).toBe(1000)
    expect(result?.rows[0]?.margin).toBe(700)
    // Earned (canon R1) rolls up from usageRevenue, beside total.
    expect(result?.rows[0]?.earned).toBe(700)
    expect(result?.totalEarned).toBe(700)
    // And the agent-name join was org-scoped (IDOR belt).
    expect(agentsFindMany.mock.calls[0][0].where).toMatchObject({
      orgId: ACTIVE_ORG,
    })
  })
})
