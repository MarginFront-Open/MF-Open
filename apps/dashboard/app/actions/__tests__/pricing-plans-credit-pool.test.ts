/**
 * WHAT THIS FILE DOES: proves the credit-pool rule FIRES on all
 * four dashboard pricing-strategy write lanes, against a fully-mocked DB.
 *
 * Why these four matter as much as the api-nest four: the dashboard does NOT
 * call api-nest. Its save is a Server Action writing Prisma directly, so a
 * rule enforced only in api-nest would leave the dashboard free to create
 * exactly the pools the API refuses. These lanes are the other half of the
 * gate, and they must agree with the api-nest half — same shared rule, same
 * merged-state semantics, same wording.
 *
 * Also pinned here: the two null-tiers guards. Without them a `null`
 * tiers value reaches Prisma's `Json?` column and throws at runtime; the
 * pinned semantics on every lane are "null and undefined both mean leave the
 * tiers unchanged."
 *
 * WHY THE DB IS MOCKED (the chart-of-accounts-validation.test.ts approach):
 * what's under test is the action's branch decisions and the exact payload it
 * hands Prisma — including which keys are absent. That is strictly stronger
 * than checking a row landed, and it needs no database.
 *
 * Every assertion can fail: drop a validator call and the rejection tests see
 * a write; merge patch-only instead of merged-state and the PATCH tests pass
 * a bad row; drop a null guard and the guard tests see `tiers: null` in the
 * payload.
 */

export {}

const ORG = 'org-real-pricing'
const USER = 'user-pricing'
const PLAN = 'plan-uuid'
const AGENT = 'agent-uuid'
const STRATEGY = 'strategy-uuid'

const GOOD_TIERS = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
]
const SUGAR = { poolSize: 5000, poolPrice: 99, overageRate: 0.03 }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: USER },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
const plansFindFirst = jest.fn()
const strategiesFindFirst = jest.fn()
const strategiesFindMany = jest.fn()
const strategiesCreateMany = jest.fn()
const strategiesUpdate = jest.fn()
const signalsFindMany = jest.fn()
const transaction = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    // The money gate reads this; every test below runs as an owner, because
    // authz is proven elsewhere and these tests are about the pool rule.
    ba_member: { findFirst: async () => ({ role: 'owner' }) },
    pricing_plans: { findFirst: (a: unknown) => plansFindFirst(a) },
    pricing_strategies: {
      findFirst: (a: unknown) => strategiesFindFirst(a),
      findMany: (a: unknown) => strategiesFindMany(a),
      createMany: (a: unknown) => strategiesCreateMany(a),
      update: (a: unknown) => strategiesUpdate(a),
    },
    // The live-signal check; individual tests set the roster.
    signals: { findMany: (a: unknown) => signalsFindMany(a) },
    $transaction: (fn: unknown) => transaction(fn),
  },
  Prisma: { JsonNull: 'DbJsonNull', InputJsonValue: {} },
}))

type PricingPlansModule = typeof import('../pricing-plans')
let actions: PricingPlansModule

beforeAll(async () => {
  actions = await import('../pricing-plans')
})

const POOL_ROW = {
  id: STRATEGY,
  name: 'API Call Pool',
  orgId: ORG,
  planId: PLAN,
  agentId: AGENT,
  signalId: 'signal-uuid',
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  billingFrequency: 'monthly',
  tiers: GOOD_TIERS,
  rate: null,
  minimumCommitment: null,
  active: true,
  deletedAt: null,
  tags: [],
  signals: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  plansFindFirst.mockResolvedValue({ id: PLAN, orgId: ORG })
  strategiesFindFirst.mockResolvedValue(POOL_ROW)
  strategiesFindMany.mockResolvedValue([])
  strategiesCreateMany.mockResolvedValue({ count: 1 })
  strategiesUpdate.mockResolvedValue(POOL_ROW)
  signalsFindMany.mockResolvedValue([])
  transaction.mockImplementation(async (fn: any) =>
    fn({
      pricing_plans: { create: jest.fn() },
      agent_pricing_plans: { createMany: jest.fn() },
      pricing_strategies: { createMany: strategiesCreateMany },
    })
  )
})

function poolPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'API Call Pool',
    signalId: 'signal-uuid',
    chargeType: 'usage' as const,
    pricingModel: 'credit_pool' as const,
    ...overrides,
  }
}

describe('addPlanStrategies — lane 1', () => {
  it('compiles creditPool sugar into the canonical tiers', async () => {
    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR }),
    ])

    expect(res.success).toBe(true)
    const [{ data }] = strategiesCreateMany.mock.calls[0]
    expect(data[0].tiers).toEqual(GOOD_TIERS)
  })

  it('rejects a payload sending BOTH creditPool and tiers', async () => {
    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR, tiers: GOOD_TIERS }),
    ])

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not both/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('the RESPONSE carries the derived creditPool', async () => {
    // The sibling scan (select) and the read-back (include) both go through
    // findMany; only the read-back should return the created row.
    strategiesFindMany.mockImplementation(async (args: any) =>
      args?.include ? [POOL_ROW] : []
    )

    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR }),
    ])

    expect(res.success).toBe(true)
    expect(res.data?.[0].creditPool).toEqual(SUGAR)
  })

  it('rejects an incoherent pool and writes NOTHING', async () => {
    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({
        tiers: [
          { lower: 0, upper: 5000, rate: 99 },
          { lower: 4000, upper: null, rate: 0.03 },
        ],
      }),
    ])

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/start exactly where the pool ends/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('rejects a second live pool on the same plan', async () => {
    strategiesFindMany.mockResolvedValue([
      {
        id: 'other',
        name: 'Existing Pool',
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
      },
    ])

    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR }),
    ])

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/one active credit pool/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('leaves non-pool strategies alone; a usage write pays exactly one sibling scan', async () => {
    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({
        pricingModel: 'graduated',
        tiers: [{ lower: 0, upper: 0, rate: 0 }],
        minimumCommitment: 500,
      }),
    ])

    expect(res.success).toBe(true)
    // A live USAGE strategy can collide with a rated pool's member signals,
    // so this write pays exactly one plan-strategies scan (the double-billing
    // sweep) and no signals query.
    const poolScans = strategiesFindMany.mock.calls.filter(
      ([args]: any) => args?.select?.pricingModel
    )
    expect(poolScans).toHaveLength(1)
    expect(signalsFindMany).not.toHaveBeenCalled()
  })

  it('non-usage strategies still skip every plan-level query (cost discipline)', async () => {
    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({
        name: 'Platform fee',
        chargeType: 'recurring',
        pricingModel: 'flat',
        rate: 99,
        signalId: undefined,
      }),
    ])

    expect(res.success).toBe(true)
    const poolScans = strategiesFindMany.mock.calls.filter(
      ([args]: any) => args?.select?.pricingModel
    )
    expect(poolScans).toHaveLength(0)
    expect(signalsFindMany).not.toHaveBeenCalled()
  })
})

describe('updatePlanStrategy — lane 2', () => {
  it('compiles sugar on a PATCH', async () => {
    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      creditPool: { poolSize: 200, poolPrice: 10, overageRate: 1 },
    })

    expect(res.success).toBe(true)
    const [{ data }] = strategiesUpdate.mock.calls[0]
    expect(data.tiers).toEqual([
      { lower: 0, upper: 200, rate: 10 },
      { lower: 200, upper: null, rate: 1 },
    ])
  })

  it('rejects a PATCH sending BOTH creditPool and tiers', async () => {
    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      creditPool: SUGAR,
      tiers: GOOD_TIERS,
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not both/i)
    expect(strategiesUpdate).not.toHaveBeenCalled()
  })

  it('the PATCH RESPONSE carries the derived creditPool', async () => {
    strategiesUpdate.mockImplementation(async (args: any) => ({
      ...POOL_ROW,
      tiers: args.data.tiers,
    }))

    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      creditPool: { poolSize: 200, poolPrice: 10, overageRate: 1 },
    })

    expect(res.success).toBe(true)
    expect(res.data?.creditPool).toEqual({
      poolSize: 200,
      poolPrice: 10,
      overageRate: 1,
    })
  })

  it('PATCH {minimumCommitment} alone is rejected — merged state, not patch-only', async () => {
    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      minimumCommitment: 500,
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/minimum commitment/i)
    expect(strategiesUpdate).not.toHaveBeenCalled()
  })

  it('PATCH {pricingModel} onto a tierless flat row is rejected', async () => {
    strategiesFindFirst.mockResolvedValue({
      ...POOL_ROW,
      pricingModel: 'flat',
      tiers: null,
    })

    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      pricingModel: 'credit_pool',
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/creditPool block|two-tier/i)
    expect(strategiesUpdate).not.toHaveBeenCalled()
  })

  it('null-tiers guard: a null never reaches the Json column', async () => {
    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      name: 'Renamed',
      tiers: null as never,
    })

    expect(res.success).toBe(true)
    const [{ data }] = strategiesUpdate.mock.calls[0]
    expect(data.tiers).toBeUndefined()
  })

  it('a rename never runs the rule — a degenerate stored row stays editable', async () => {
    strategiesFindFirst.mockResolvedValue({
      ...POOL_ROW,
      tiers: [{ lower: 0, upper: 0, rate: 99 }],
    })

    const res = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      name: 'Renamed Pool',
    })

    expect(res.success).toBe(true)
    expect(strategiesUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('bulkUpdatePlanStrategies — lane 3 (both branches)', () => {
  it('compiles sugar on the NEW branch', async () => {
    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [poolPayload({ creditPool: SUGAR })],
      []
    )

    expect(res.success).toBe(true)
    const [{ data }] = strategiesCreateMany.mock.calls[0]
    expect(data[0].tiers).toEqual(GOOD_TIERS)
  })

  it('compiles sugar on the UPDATE branch, merged against the stored row', async () => {
    strategiesFindMany.mockResolvedValue([POOL_ROW])

    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [],
      [
        {
          id: STRATEGY,
          creditPool: { poolSize: 200, poolPrice: 10, overageRate: 1 },
        },
      ]
    )

    expect(res.success).toBe(true)
    const [{ data }] = strategiesUpdate.mock.calls[0]
    expect(data.tiers).toEqual([
      { lower: 0, upper: 200, rate: 10 },
      { lower: 200, upper: null, rate: 1 },
    ])
  })

  it('rejects the whole batch before writing ANY of it', async () => {
    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [
        poolPayload({ name: 'Fine', creditPool: SUGAR }),
        poolPayload({
          name: 'Broken',
          creditPool: { poolSize: 0, poolPrice: 5, overageRate: 1 },
        }),
      ],
      []
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/greater than zero/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('PATCH {pricingModel} on the update branch is validated against stored tiers', async () => {
    strategiesFindMany.mockResolvedValue([
      {
        ...POOL_ROW,
        pricingModel: 'graduated',
        tiers: [{ lower: 0, upper: null, rate: 1 }],
      },
    ])

    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [],
      [{ id: STRATEGY, pricingModel: 'credit_pool' }]
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/exactly 2 tiers/i)
    expect(strategiesUpdate).not.toHaveBeenCalled()
  })

  it('null-tiers guard: a null never reaches the Json column', async () => {
    strategiesFindMany.mockResolvedValue([POOL_ROW])

    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [],
      [{ id: STRATEGY, name: 'Renamed', tiers: null as never }]
    )

    expect(res.success).toBe(true)
    const [{ data }] = strategiesUpdate.mock.calls[0]
    expect(data).not.toHaveProperty('tiers')
  })
})

describe('copyPricingPlan — lane 4', () => {
  function mockPlanWithStrategies(strategies: unknown[]) {
    plansFindFirst.mockImplementation(async (args: any) => ({
      id: args?.where?.id ?? PLAN,
      orgId: ORG,
      name: 'Copy',
      description: 'orig',
      featuresList: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      deletedAt: null,
      pricing_strategies: strategies,
      agent_pricing_plans: [],
    }))
  }

  it('validates AFTER the discount rewrite and writes the discounted rows', async () => {
    mockPlanWithStrategies([POOL_ROW])

    const res = await actions.copyPricingPlan(PLAN, {
      newName: 'Copy',
      discount: 20,
    })

    expect(res.success).toBe(true)
    const [{ data }] = strategiesCreateMany.mock.calls[0]
    expect(data[0].tiers).toEqual([
      { lower: 0, upper: 5000, rate: 79.2 },
      { lower: 5000, upper: null, rate: 0.024 },
    ])
  })

  it('refuses to give a degenerate stored pool a fresh twin', async () => {
    // upper:0 — a degenerate shape a stored pool can carry.
    mockPlanWithStrategies([
      {
        ...POOL_ROW,
        tiers: [
          { lower: 0, upper: 0, rate: 99 },
          { lower: 0, upper: null, rate: 0.03 },
        ],
      },
    ])

    const res = await actions.copyPricingPlan(PLAN, { newName: 'Copy' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/greater than zero/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('refuses a copy that would wake a dormant second pool', async () => {
    // This lane forces every copy `active: true` — so a source plan that is
    // legal (one live pool, one dormant) becomes illegal once copied. The
    // api-nest copy lane preserves `active` and therefore allows this same
    // source; the lanes genuinely differ and both are pinned.
    mockPlanWithStrategies([
      POOL_ROW,
      { ...POOL_ROW, id: 'dormant', name: 'Old Pool', active: false },
    ])

    const res = await actions.copyPricingPlan(PLAN, { newName: 'Copy' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/one active credit pool/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })
})

describe('creditRates — the funnel wiring', () => {
  const MEMBER = 'member-signal-uuid'

  it('addPlanStrategies stores valid creditRates and checks keys against live org signals', async () => {
    signalsFindMany.mockResolvedValue([{ id: MEMBER }])

    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR, creditRates: { [MEMBER]: 4 } }),
    ])

    expect(res.success).toBe(true)
    const [{ data }] = strategiesCreateMany.mock.calls[0]
    expect(data[0].creditRates).toEqual({ [MEMBER]: 4 })
    expect(signalsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [MEMBER] },
          orgId: ORG,
          deletedAt: null,
        }),
      })
    )
  })

  it('addPlanStrategies rejects a creditRates key that is not a live org signal', async () => {
    signalsFindMany.mockResolvedValue([])

    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR, creditRates: { 'ghost-signal': 4 } }),
    ])

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/doesn't exist/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('addPlanStrategies rejects non-positive rates and rates on non-pool models', async () => {
    const zero = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR, creditRates: { [MEMBER]: 0 } }),
    ])
    expect(zero.success).toBe(false)
    expect(zero.error).toMatch(/greater than zero/i)

    const nonPool = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({
        pricingModel: 'flat',
        rate: 0.01,
        creditRates: { [MEMBER]: 4 },
      }),
    ])
    expect(nonPool.success).toBe(false)
    expect(nonPool.error).toMatch(/only applies/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('addPlanStrategies rejects a batch whose pool rates a signal the SAME batch prices per-unit', async () => {
    signalsFindMany.mockResolvedValue([{ id: MEMBER }])

    const res = await actions.addPlanStrategies(PLAN, AGENT, [
      poolPayload({ creditPool: SUGAR, creditRates: { [MEMBER]: 4 } }),
      poolPayload({
        name: 'Per-call',
        signalId: MEMBER,
        pricingModel: 'flat',
        rate: 0.01,
      }),
    ])

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/never both/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })

  it('updatePlanStrategy: creditRates null leaves rates alone; {} clears them', async () => {
    const nullRes = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      creditRates: null,
    })
    expect(nullRes.success).toBe(true)
    expect(strategiesUpdate.mock.calls[0][0].data.creditRates).toBeUndefined()

    const clearRes = await actions.updatePlanStrategy(PLAN, STRATEGY, {
      creditRates: {},
    })
    expect(clearRes.success).toBe(true)
    expect(strategiesUpdate.mock.calls[1][0].data.creditRates).toEqual({})
  })

  it('updatePlanStrategy: activating a usage strategy on a pool-member signal is rejected (back door)', async () => {
    const dormantRival = {
      ...POOL_ROW,
      id: 'rival',
      name: 'Per-call',
      pricingModel: 'flat',
      tiers: null,
      signalId: MEMBER,
      active: false,
    }
    strategiesFindFirst.mockResolvedValue(dormantRival)
    strategiesFindMany.mockResolvedValue([
      {
        id: STRATEGY,
        name: 'API Call Pool',
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
        signalId: 'signal-uuid',
        creditRates: { [MEMBER]: 4 },
      },
      {
        id: 'rival',
        name: 'Per-call',
        pricingModel: 'flat',
        chargeType: 'usage',
        active: false,
        deletedAt: null,
        signalId: MEMBER,
        creditRates: null,
      },
    ])

    const res = await actions.updatePlanStrategy(PLAN, 'rival', {
      active: true,
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/never both/i)
    expect(strategiesUpdate).not.toHaveBeenCalled()
  })

  it('bulkUpdatePlanStrategies: a creditRates patch is validated and written', async () => {
    signalsFindMany.mockResolvedValue([{ id: MEMBER }])
    strategiesFindMany.mockImplementation(async (args: any) =>
      args?.where?.id
        ? [POOL_ROW]
        : [
            {
              id: STRATEGY,
              name: POOL_ROW.name,
              pricingModel: 'credit_pool',
              chargeType: 'usage',
              active: true,
              deletedAt: null,
              signalId: 'signal-uuid',
              creditRates: null,
            },
          ]
    )

    const res = await actions.bulkUpdatePlanStrategies(
      PLAN,
      AGENT,
      [],
      [{ id: STRATEGY, creditRates: { [MEMBER]: 2 } }]
    )

    expect(res.success).toBe(true)
    expect(strategiesUpdate.mock.calls[0][0].data.creditRates).toEqual({
      [MEMBER]: 2,
    })
  })

  it('copyPricingPlan carries creditRates through UNSCALED by the discount', async () => {
    signalsFindMany.mockResolvedValue([{ id: MEMBER }])
    plansFindFirst.mockImplementation(async (args: any) => ({
      id: args?.where?.id ?? PLAN,
      orgId: ORG,
      name: 'Copy',
      description: 'orig',
      featuresList: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      deletedAt: null,
      pricing_strategies: [{ ...POOL_ROW, creditRates: { [MEMBER]: 4 } }],
      agent_pricing_plans: [],
    }))

    const res = await actions.copyPricingPlan(PLAN, {
      newName: 'Copy',
      discount: 20,
    })

    expect(res.success).toBe(true)
    const [{ data }] = strategiesCreateMany.mock.calls[0]
    // Tier rates are dollars and get the discount; burn rates are CREDITS
    // per unit and must ride through untouched.
    expect(data[0].tiers[0].rate).toBeCloseTo(79.2)
    expect(data[0].creditRates).toEqual({ [MEMBER]: 4 })
  })

  it('copyPricingPlan refuses a copy whose rates name a since-deleted signal', async () => {
    signalsFindMany.mockResolvedValue([])
    plansFindFirst.mockImplementation(async (args: any) => ({
      id: args?.where?.id ?? PLAN,
      orgId: ORG,
      name: 'Copy',
      description: 'orig',
      featuresList: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      deletedAt: null,
      pricing_strategies: [
        { ...POOL_ROW, creditRates: { 'deleted-signal': 4 } },
      ],
      agent_pricing_plans: [],
    }))

    const res = await actions.copyPricingPlan(PLAN, { newName: 'Copy' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/doesn't exist/i)
    expect(strategiesCreateMany).not.toHaveBeenCalled()
  })
})
