/**
 * WHAT THIS FILE DOES: proves the subscription write actions
 * keep history safe, against a fully-mocked DB.
 *
 *   1. cancelSubscription is gated the same as every other money write
 *      (owner/admin/finance only), requires a non-empty reason, refuses a
 *      double-cancel, and — the load-bearing assertion — sets status to
 *      'canceled' and NEVER touches deletedAt or status:'ended'. That is
 *      the exact distinction the revenue-accrual model cares about: cancel
 *      preserves history, delete/ended zeroes it.
 *   2. Every cancel writes a subscription_change_logs row carrying the
 *      reason, changeType 'status_change', and the customer-visible
 *      previous/next status.
 *   3. createSubscription and updateSubscription persist netTerms /
 *      billingDay / customCycleDays (and billingModel on create), the fields
 *      the form collects and sends.
 *   4. updateSubscription logs a reason to subscription_change_logs when
 *      one is passed.
 */

export {}

const ORG = 'org-real-subs'
const USER = 'user-subs'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
const baMemberFindFirst = jest.fn()
const subscriptionsFindFirst = jest.fn()
const subscriptionsCreate = jest.fn()
const subscriptionsUpdate = jest.fn()
const changeLogsCreate = jest.fn()
const customersFindFirst = jest.fn()
const pricingPlansFindFirst = jest.fn()
const agentsFindFirst = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    subscriptions: {
      findFirst: (a: unknown) => subscriptionsFindFirst(a),
      create: (a: unknown) => subscriptionsCreate(a),
      update: (a: unknown) => subscriptionsUpdate(a),
    },
    subscription_change_logs: {
      create: (a: unknown) => changeLogsCreate(a),
    },
    customers: { findFirst: (a: unknown) => customersFindFirst(a) },
    pricing_plans: { findFirst: (a: unknown) => pricingPlansFindFirst(a) },
    agents: { findFirst: (a: unknown) => agentsFindFirst(a) },
  },
  Prisma: { InputJsonValue: {} },
}))

type SubscriptionsModule = typeof import('../subscriptions')
let subs: SubscriptionsModule

beforeAll(async () => {
  subs = await import('../subscriptions')
})

const baseRow = {
  id: 'sub-1',
  organizationId: ORG,
  customerId: 'cust-1',
  planId: 'plan-1',
  agentId: 'agent-1',
  name: 'Sub One',
  status: 'active',
  billingCycle: 'monthly',
  startDate: new Date('2026-01-01'),
  endDate: null,
  isForever: true,
  metadata: {},
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
}

function mockedRow(overrides: Partial<typeof baseRow> = {}) {
  return { ...baseRow, ...overrides }
}

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    subscriptionsFindFirst,
    subscriptionsCreate,
    subscriptionsUpdate,
    changeLogsCreate,
    customersFindFirst,
    pricingPlansFindFirst,
    agentsFindFirst,
  ].forEach((m) => m.mockReset())

  subscriptionsCreate.mockResolvedValue(mockedRow())
  subscriptionsUpdate.mockResolvedValue(mockedRow({ status: 'canceled' }))
  changeLogsCreate.mockResolvedValue({})
  // Foreign-ID ownership checks pass by default; the org-scope suite is
  // where they get exercised.
  customersFindFirst.mockResolvedValue({ id: 'cust-1' })
  pricingPlansFindFirst.mockResolvedValue({ id: 'plan-1' })
  agentsFindFirst.mockResolvedValue({ id: 'agent-1' })
})

describe('cancelSubscription — the SAFE stop', () => {
  it.each(['member', 'developer', 'noRow'])(
    'denies %s and never touches the DB',
    async (r) => {
      baMemberFindFirst.mockResolvedValue(r === 'noRow' ? null : { role: r })
      subscriptionsFindFirst.mockResolvedValue(mockedRow())

      const res = await subs.cancelSubscription('sub-1', 'testing churn')
      expect(res.success).toBe(false)
      expect(subscriptionsUpdate).not.toHaveBeenCalled()
      expect(changeLogsCreate).not.toHaveBeenCalled()
    }
  )

  it.each(['owner', 'admin', 'finance'])(
    'allows %s through the gate',
    async (r) => {
      baMemberFindFirst.mockResolvedValue({ role: r })
      subscriptionsFindFirst.mockResolvedValue(mockedRow())

      const res = await subs.cancelSubscription('sub-1', 'testing churn')
      expect(res.success).toBe(true)
    }
  )

  it('refuses an empty or whitespace-only reason, without writing anything', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow())

    const res = await subs.cancelSubscription('sub-1', '   ')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/reason/i)
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
    expect(changeLogsCreate).not.toHaveBeenCalled()
  })

  it('refuses to cancel a subscription that is already canceled', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow({ status: 'canceled' }))

    const res = await subs.cancelSubscription('sub-1', 'testing churn')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/already canceled/i)
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })

  it("sets status to 'canceled' — NEVER 'ended', and NEVER touches deletedAt", async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow())

    await subs.cancelSubscription('sub-1', 'customer requested churn')

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1)
    const callArgs = subscriptionsUpdate.mock.calls[0][0]
    expect(callArgs.data.status).toBe('canceled')
    expect(callArgs.data.status).not.toBe('ended')
    expect(callArgs.data).not.toHaveProperty('deletedAt')
  })

  it('logs the cancel to subscription_change_logs with the reason and changeType status_change', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow({ status: 'active' }))

    await subs.cancelSubscription('sub-1', 'customer requested churn')

    expect(changeLogsCreate).toHaveBeenCalledTimes(1)
    const logArgs = changeLogsCreate.mock.calls[0][0].data
    expect(logArgs.subscriptionId).toBe('sub-1')
    expect(logArgs.changedBy).toBe(USER)
    expect(logArgs.changeType).toBe('status_change')
    expect(logArgs.changeReason).toBe('customer requested churn')
    expect(logArgs.previousValues).toEqual({ status: 'active' })
    expect(logArgs.newValues).toEqual({ status: 'canceled' })
  })

  it('returns not-found for a subscription outside the caller org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(null)

    const res = await subs.cancelSubscription('sub-999', 'reason')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })
})

describe('createSubscription — persists fields the form already sends', () => {
  it('writes billingModel, netTerms, billingDay, and customCycleDays through to the DB', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })

    await subs.createSubscription({
      name: 'Sub Two',
      planId: 'plan-1',
      agentId: 'agent-1',
      customerId: 'cust-1',
      startDate: '2026-01-01',
      billingCycle: 'custom',
      billingModel: 'usage',
      netTerms: 45,
      billingDay: 15,
      customCycleDays: 21,
    })

    expect(subscriptionsCreate).toHaveBeenCalledTimes(1)
    const callArgs = subscriptionsCreate.mock.calls[0][0].data
    expect(callArgs.billingModel).toBe('usage')
    expect(callArgs.netTerms).toBe(45)
    expect(callArgs.billingDay).toBe(15)
    expect(callArgs.customCycleDays).toBe(21)
  })
})

describe('updateSubscription — persists fields the form already sends, and logs a reason', () => {
  it('writes netTerms, billingDay, and customCycleDays through to the DB', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow())

    await subs.updateSubscription('sub-1', {
      netTerms: 60,
      billingDay: 3,
      customCycleDays: 10,
    })

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1)
    const callArgs = subscriptionsUpdate.mock.calls[0][0].data
    expect(callArgs.netTerms).toBe(60)
    expect(callArgs.billingDay).toBe(3)
    expect(callArgs.customCycleDays).toBe(10)
  })

  it('logs a subscription_change_logs row when a changeReason is passed', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow())

    await subs.updateSubscription(
      'sub-1',
      { netTerms: 60 },
      'net terms renegotiated'
    )

    expect(changeLogsCreate).toHaveBeenCalledTimes(1)
    const logArgs = changeLogsCreate.mock.calls[0][0].data
    expect(logArgs.changeReason).toBe('net terms renegotiated')
    expect(logArgs.changeType).toBe('updated')
  })

  it('does NOT write a change log when no reason is passed (back-compat)', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    subscriptionsFindFirst.mockResolvedValue(mockedRow())

    await subs.updateSubscription('sub-1', { netTerms: 60 })

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1)
    expect(changeLogsCreate).not.toHaveBeenCalled()
  })
})
