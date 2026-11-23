/**
 * WHAT THIS FILE DOES: proves createSubscription and updateSubscription
 * verify every supplied foreign ID (customerId, planId, agentId) belongs to
 * the caller's org before writing. Otherwise a money manager of org A
 * passing org B's plan UUID would create a subscription in org A that bills
 * with org B's plan and echoes B's plan name back in the response.
 * Fully mocked, no DB.
 *
 *   - create: all three ownership lookups carry the caller's org
 *   - create: a cross-org customer/plan/agent ID -> 'not found', no write
 *   - create: same-org happy path still writes, bound to the caller's org
 *   - update: a swapped-in cross-org planId/agentId -> 'not found', no write
 *   - update: a payload with no foreign IDs runs no ownership lookups
 */

export {}

const ORG = 'org-real-fk'
const USER = 'user-fk'

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
    subscription_change_logs: { create: jest.fn() },
    customers: { findFirst: (a: unknown) => customersFindFirst(a) },
    pricing_plans: { findFirst: (a: unknown) => pricingPlansFindFirst(a) },
    agents: { findFirst: (a: unknown) => agentsFindFirst(a) },
  },
  Prisma: { InputJsonValue: {} },
}))

type SubscriptionsModule = typeof import('../subscriptions')
let subs: SubscriptionsModule

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  subs = await import('../subscriptions')
})

const CREATE_PAYLOAD = {
  name: 'Sub FK',
  planId: 'plan-1',
  agentId: 'agent-1',
  customerId: 'cust-1',
  startDate: '2026-01-01',
}

const existingRow = {
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

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    subscriptionsFindFirst,
    subscriptionsCreate,
    subscriptionsUpdate,
    customersFindFirst,
    pricingPlansFindFirst,
    agentsFindFirst,
  ].forEach((m) => m.mockReset())

  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  subscriptionsFindFirst.mockResolvedValue(existingRow)
  subscriptionsCreate.mockResolvedValue(existingRow)
  subscriptionsUpdate.mockResolvedValue(existingRow)
  customersFindFirst.mockResolvedValue({ id: 'cust-1' })
  pricingPlansFindFirst.mockResolvedValue({ id: 'plan-1' })
  agentsFindFirst.mockResolvedValue({ id: 'agent-1' })
})

describe('createSubscription — foreign IDs must belong to the caller org', () => {
  it('runs all three ownership lookups WITH the caller org in the where clause', async () => {
    await subs.createSubscription(CREATE_PAYLOAD)

    expect(customersFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'cust-1',
      organizationId: ORG,
      deletedAt: null,
    })
    expect(pricingPlansFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'plan-1',
      orgId: ORG,
      deletedAt: null,
    })
    expect(agentsFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'agent-1',
      orgId: ORG,
      deletedAt: null,
    })
  })

  it("cross-org customerId -> 'Customer not found', nothing written", async () => {
    customersFindFirst.mockResolvedValue(null)
    const res = await subs.createSubscription(CREATE_PAYLOAD)
    expect(res.success).toBe(false)
    expect(res.error).toBe('Customer not found')
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it("cross-org planId -> 'Pricing plan not found', nothing written", async () => {
    pricingPlansFindFirst.mockResolvedValue(null)
    const res = await subs.createSubscription(CREATE_PAYLOAD)
    expect(res.success).toBe(false)
    expect(res.error).toBe('Pricing plan not found')
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it("cross-org agentId -> 'Agent not found', nothing written", async () => {
    agentsFindFirst.mockResolvedValue(null)
    const res = await subs.createSubscription(CREATE_PAYLOAD)
    expect(res.success).toBe(false)
    expect(res.error).toBe('Agent not found')
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('same-org happy path writes, bound to the caller org', async () => {
    const res = await subs.createSubscription(CREATE_PAYLOAD)
    expect(res.success).toBe(true)
    expect(subscriptionsCreate).toHaveBeenCalledTimes(1)
    expect(subscriptionsCreate.mock.calls[0][0].data.organizationId).toBe(
      ORG
    )
  })
})

describe('updateSubscription — swapped foreign IDs must belong to the caller org', () => {
  it("cross-org planId -> 'Pricing plan not found', nothing written", async () => {
    pricingPlansFindFirst.mockResolvedValue(null)
    const res = await subs.updateSubscription('sub-1', { planId: 'plan-evil' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('Pricing plan not found')
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })

  it("cross-org agentId -> 'Agent not found', nothing written", async () => {
    agentsFindFirst.mockResolvedValue(null)
    const res = await subs.updateSubscription('sub-1', { agentId: 'agent-evil' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('Agent not found')
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('a payload with no foreign IDs runs no ownership lookups', async () => {
    const res = await subs.updateSubscription('sub-1', { netTerms: 30 })
    expect(res.success).toBe(true)
    expect(pricingPlansFindFirst).not.toHaveBeenCalled()
    expect(agentsFindFirst).not.toHaveBeenCalled()
    expect(customersFindFirst).not.toHaveBeenCalled()
  })

  it('an owned planId passes the check and the update fires with it', async () => {
    const res = await subs.updateSubscription('sub-1', { planId: 'plan-1' })
    expect(res.success).toBe(true)
    expect(pricingPlansFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'plan-1',
      orgId: ORG,
      deletedAt: null,
    })
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1)
    expect(subscriptionsUpdate.mock.calls[0][0].data.planId).toBe('plan-1')
  })
})
