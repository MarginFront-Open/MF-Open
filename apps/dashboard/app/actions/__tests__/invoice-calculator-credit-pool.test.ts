/**
 * WHAT THIS FILE GUARDS: the dashboard's RevenueSimulator runs its OWN copy
 * of the invoice math (a Server Action, not an api-nest call), and the two
 * must not drift. On rated credit pools, reading projectedEvents for the
 * pool's own signal only would quote the reports and silently drop the notes
 * for a pool whose members burn 4 and 2 credits. Under-quoting a pool is the
 * quoted-vs-billed confusion burn rates exist to prevent.
 *
 * Two kinds of pin, because one alone is not enough:
 *
 *  1. BEHAVIORAL. The same four fixtures the api-nest side pins (14-credit,
 *     1,300-credit overage, the 618.5 fractional hand pin, and the rate-less
 *     pool) pushed through the real action, with expected amounts written as
 *     literals, never re-derived from the code under test, so a
 *     wrong rate sum shows up as a wrong number rather than a
 *     matching wrong number.
 *  2. DRIFT GUARD. The behavioral fixtures can't see the api-nest twin, so
 *     they'd stay green while the two implementations diverged. The last
 *     describe reads BOTH source files and pins the invariants they share.
 *
 * WHY THE DB IS MOCKED: same approach as pricing-plans-credit-pool.test.ts.
 * What's under test is the action's arithmetic and which rows it asks for,
 * and that needs no database.
 */

export {}

const ORG = 'org-simulator'
const PLAN_ID = 'plan-rated-pool'
const SIGNAL_REPORT = 'signal-report-uuid'
const SIGNAL_NOTE = 'signal-note-uuid'
const SIGNAL_HALF = 'signal-half-uuid'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const plansFindFirst = jest.fn()
const signalsFindMany = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    pricing_plans: { findFirst: (...a: unknown[]) => plansFindFirst(...a) },
    signals: { findMany: (...a: unknown[]) => signalsFindMany(...a) },
  },
}))

import { simulateRevenue } from '../invoice-calculator'

// 1,000 credits for $99, then $0.03 per credit past the pool. The pool size
// matches the api-nest spec's RATED_POOL_TIERS exactly, which is what makes the shared
// fixtures below comparable on AMOUNT and not only on quantity.
const POOL_TIERS = [
  { lower: 0, upper: 1000, rate: 99 },
  { lower: 1000, upper: null, rate: 0.03 },
]

// The member signals that carry no strategy row of their own — the whole
// reason the action has to resolve names before it can read projectedEvents.
const MEMBER_SIGNALS = [
  { id: SIGNAL_NOTE, name: 'Note', shortName: 'note' },
  { id: SIGNAL_HALF, name: 'Half', shortName: 'half' },
]

const ratedPoolStrategy = (creditRates: Record<string, number> | null) => ({
  id: 'strategy-pool',
  name: 'Content Pool',
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  billingFrequency: 'monthly',
  signalId: SIGNAL_REPORT,
  signals: { id: SIGNAL_REPORT, name: 'Report', shortName: 'report' },
  tiers: POOL_TIERS,
  creditRates,
  rate: null,
  minimumCommitment: null,
})

const poolLineOf = (data: any) =>
  data.recurringCharges.lineItems.find(
    (item: any) => item.pricingModel === 'credit_pool'
  )

beforeEach(() => {
  plansFindFirst.mockReset()
  signalsFindMany.mockReset()
  signalsFindMany.mockImplementation(({ where }: any) =>
    Promise.resolve(
      MEMBER_SIGNALS.filter(
        (s) => where.id.in.includes(s.id) && where.orgId === ORG
      )
    )
  )
})

const givenPlan = (strategies: any[]) => {
  plansFindFirst.mockResolvedValue({
    id: PLAN_ID,
    name: 'Rated Pool Plan',
    description: 'parity fixture',
    orgId: ORG,
    agents: null,
    pricing_strategies: strategies,
  })
}

describe('simulateRevenue — rated pools quote CREDITS', () => {
  const parityCases: Array<{
    label: string
    creditRates: Record<string, number> | null
    projectedEvents: Record<string, number>
    quantity: number
    amount: number
  }> = [
    {
      label: 'inside the pool: 2 x 4 + 3 x 2 = 14 credits',
      creditRates: { [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 },
      projectedEvents: { report: 2, note: 3 },
      quantity: 14,
      amount: 99,
    },
    {
      label: 'credits overage: 800 + 500 = 1,300 → $99 + 300 x $0.03',
      creditRates: { [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 },
      projectedEvents: { report: 200, note: 250 },
      quantity: 1300,
      amount: 99 + 300 * 0.03,
    },
    {
      label: 'fractional rate hand pin: 113 x 4 + 75 x 2 + 33 x 0.5 = 618.5',
      creditRates: {
        [SIGNAL_REPORT]: 4,
        [SIGNAL_NOTE]: 2,
        [SIGNAL_HALF]: 0.5,
      },
      projectedEvents: { report: 113, note: 75, half: 33 },
      quantity: 618.5,
      amount: 99,
    },
    {
      label: 'rate-less pool: raw units, unrated arithmetic',
      creditRates: null,
      projectedEvents: { report: 1250 },
      quantity: 1250,
      amount: 99 + 250 * 0.03,
    },
  ]

  it.each(parityCases)(
    'quotes the pool line the invoice bills — $label',
    async ({ creditRates, projectedEvents, quantity, amount }) => {
      givenPlan([ratedPoolStrategy(creditRates)])

      const res = await simulateRevenue({
        pricingPlanId: PLAN_ID,
        projectedEvents,
        billingCycle: 'monthly',
      })

      expect(res.success).toBe(true)
      const line = poolLineOf(res.data)
      expect(line.quantity).toBe(quantity)
      expect(line.amount).toBe(amount)
    }
  )

  it('rating is what pushes a pool into overage, not the raw event count', async () => {
    // 300 reports + 100 notes is 400 events, comfortably inside a 1,000 pool
    // to a units-only reader, which would quote a flat $99. Rated, it's 1,400
    // credits and 400 of them are overage. The overage is the part a broken
    // rate sum hides completely.
    givenPlan([ratedPoolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 300, note: 100 },
      billingCycle: 'monthly',
    })
    const line = poolLineOf(res.data)
    expect(line.quantity).toBe(1400)
    expect(line.amount).toBe(99 + 400 * 0.03)
    expect(line.amount).not.toBe(99)
  })

  it('quotes neither the raw event count nor the pool signal alone', async () => {
    // The two wrong answers this line can give, named so neither can
    // hide behind a plausible number: 2 is the pool's own projected events
    // with no rate applied at all and 8 is reports rated
    // correctly while the member's 6 credits go missing.
    givenPlan([ratedPoolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 2, note: 3 },
      billingCycle: 'monthly',
    })
    const { quantity } = poolLineOf(res.data)
    expect(quantity).not.toBe(2)
    expect(quantity).not.toBe(8)
    expect(quantity).toBe(14)
  })

  it('ignores a projected metric that is not a pool member', async () => {
    givenPlan([ratedPoolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 2, note: 3, unrelated: 9999 },
      billingCycle: 'monthly',
    })
    expect(poolLineOf(res.data).quantity).toBe(14)
  })

  it("resolves member names scoped to the plan's own org", async () => {
    givenPlan([ratedPoolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 1 },
      billingCycle: 'monthly',
    })
    expect(signalsFindMany).toHaveBeenCalledTimes(1)
    const { where } = signalsFindMany.mock.calls[0][0]
    expect(where.orgId).toBe(ORG)
    // The pool's OWN signal already has a strategy row carrying its name.
    expect(where.id.in).toEqual([SIGNAL_NOTE])
  })

  it('a foreign member id resolves to nothing, never another tenant name', async () => {
    givenPlan([
      ratedPoolStrategy({ [SIGNAL_REPORT]: 4, 'signal-other-tenant': 100 }),
    ])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 2, note: 3 },
      billingCycle: 'monthly',
    })
    // Only the pool's own 2 x 4. The unresolvable member contributes nothing
    // rather than matching some other org's signal name.
    expect(poolLineOf(res.data).quantity).toBe(8)
  })

  it('never queries signals for a plan with no rated pool', async () => {
    givenPlan([ratedPoolStrategy(null)])
    await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 10 },
      billingCycle: 'monthly',
    })
    expect(signalsFindMany).not.toHaveBeenCalled()
  })
})

/**
 * The quote follows the plan's CONFIGURATION, not the usage the
 * operator typed in. A pool with a fee quotes that fee at zero projected
 * events, because that is what the invoice bills. A simulator guarded on
 * `quantity > 0` alone would quote $0 against a $99 bill, which is the
 * quoted-vs-billed confusion the whole credit-pool feature exists to kill.
 *
 * A pool priced at $0 stays at $0: the pool exists and still counts down, it
 * costs nothing to hold.
 */

/** Same 1,000-credit pool, priced at nothing. */
const freePoolStrategy = () => ({
  ...ratedPoolStrategy(null),
  tiers: [
    { lower: 0, upper: 1000, rate: 0 },
    { lower: 1000, upper: null, rate: 0.03 },
  ],
})

const platformFeeStrategy = () => ({
  id: 'strategy-platform',
  name: 'Monthly Platform Fee',
  chargeType: 'recurring',
  pricingModel: 'flat',
  billingFrequency: 'monthly',
  signalId: null,
  signals: null,
  tiers: [],
  creditRates: null,
  rate: 50,
  minimumCommitment: null,
})

describe('simulateRevenue — the pool fee follows configuration', () => {
  it('quotes the pool fee on ZERO projected events (rate-less pool)', async () => {
    givenPlan([ratedPoolStrategy(null)])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
    })
    const line = poolLineOf(res.data)
    expect(line.quantity).toBe(0)
    expect(line.amount).toBe(99)
    expect(res.data.simulationSummary.typicalInvoiceTotal).toBe(99)
  })

  it('quotes the pool fee on ZERO projected events (rated pool)', async () => {
    givenPlan([ratedPoolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
    })
    const line = poolLineOf(res.data)
    expect(line.quantity).toBe(0)
    expect(line.amount).toBe(99)
    // The noun still matches what the number IS.
    expect(line.description).toBe('Content Pool (0 credits)')
  })

  it('a pool priced at $0 quotes $0 — the pool is free to hold', async () => {
    givenPlan([freePoolStrategy()])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
    })
    expect(poolLineOf(res.data).amount).toBe(0)
    expect(res.data.simulationSummary.typicalInvoiceTotal).toBe(0)
  })

  it('overage is still usage-driven — the fee never inflates it', async () => {
    givenPlan([ratedPoolStrategy(null)])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 1250 },
      billingCycle: 'monthly',
    })
    const line = poolLineOf(res.data)
    expect(line.amount).toBe(99 + 250 * 0.03)
    expect(line.tiersUsed.find((t: any) => t.lower === 1000).quantity).toBe(250)
  })

  it('a platform fee beside a zero-usage pool quotes both, independently', async () => {
    givenPlan([ratedPoolStrategy(null), platformFeeStrategy()])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
    })
    expect(poolLineOf(res.data).amount).toBe(99)
    expect(res.data.simulationSummary.recurringCosts).toBe(50)
    expect(res.data.simulationSummary.typicalInvoiceTotal).toBe(149)
  })

  it('a NON-pool usage strategy with zero projected events still quotes $0', async () => {
    // The rule is about pools. A guard relaxed one notch too wide would
    // start charging for flat usage nobody generated.
    givenPlan([
      {
        ...ratedPoolStrategy(null),
        id: 'strategy-flat',
        name: 'Per Report',
        pricingModel: 'flat',
        tiers: [],
        rate: 0.5,
      },
    ])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
    })
    const line = res.data.recurringCharges.lineItems[0]
    expect(line.pricingModel).toBe('flat')
    expect(line.amount).toBe(0)
  })
})

import { readFileSync } from 'fs'
import path from 'path'

const actionSource = readFileSync(
  path.join(__dirname, '../invoice-calculator.ts'),
  'utf-8'
)
const API_NEST_TWIN = path.join(
  __dirname,
  '../../../../api-nest/src/modules/invoice-calculator/invoice-calculator.service.ts'
)

// The shapes the two implementations have to keep in common. Each is a thing
// that, changed on one side only, silently re-opens a quoted-vs-billed bug:
// the first four guard against under-quoting rated pools, the last against a
// zero-usage $0 quote.
const SHARED_INVARIANTS: Array<[string, RegExp]> = [
  [
    'pool usage line branches to a pooled projection',
    /pooledProjectedCredits\(/,
  ],
  ['membership comes from memberRate', /memberRate\(/],
  ['member names resolve org-scoped', /orgId: pricingPlan\.orgId/],
  [
    'the lookup is skipped when nothing to resolve',
    /memberSignalIdsToResolve\.size > 0/,
  ],
  [
    'the pool fee follows configuration, not usage',
    /quantity > 0 \|\| creditPoolFee\(strategy\) > 0/,
  ],
]

/**
 * The behavioral fixtures above can only see the dashboard copy, so they'd stay
 * green while the api-nest original moved on without it.
 *
 * Both sides are asserted unconditionally. Arming the api-nest half only when
 * it already carries the branch would let a revert or rename of the twin
 * DISARM the guard instead of failing it, and a guard that goes green on a
 * fully diverged pair is worse than no guard. If this file
 * fails because the twin moved, re-point API_NEST_TWIN; do not soften it.
 */
describe('simulator drift guard — dashboard action vs api-nest service', () => {
  const serviceSource = readFileSync(API_NEST_TWIN, 'utf-8')

  it.each(SHARED_INVARIANTS)(
    'the dashboard action keeps: %s',
    (_label, pattern) => {
      expect(actionSource).toMatch(pattern)
    }
  )

  it('keeps the rate default in memberRate, never a second copy', () => {
    // Canon R1c: one membership answer. A local `creditRates[x] ?? 1` would be
    // a second copy of the rule that could drift on its own.
    expect(actionSource).not.toMatch(/creditRates\[[^\]]+\]\s*\?\?\s*1/)
  })

  it.each(SHARED_INVARIANTS)(
    'the api-nest twin agrees on: %s',
    (_label, pattern) => {
      expect(serviceSource).toMatch(pattern)
    }
  )
})
