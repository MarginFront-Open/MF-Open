/**
 * WHAT THIS FILE GUARDS: the pool line's NOUN. A rated credit pool's
 * quantity is credits, not units, so a simulator line saying "(14 units)"
 * would tell the customer the opposite of what the pool bills, on the exact
 * surface burn rates exist to make legible.
 *
 * TWO files construct the same sentence: this Server Action and api-nest's
 * InvoiceCalculatorService.simulateRevenue. Changing one alone is how they
 * drift, so the last describe reads both sources and pins the branch in each.
 *
 * The assertions here are deliberately about the DENOMINATION, not the
 * quantity — the rated quantity is pinned in
 * invoice-calculator-credit-pool.test.ts, and pinning a number here would
 * couple the two files. Rate-less
 * quantities are pinned exactly, because those must never move at all.
 *
 * WHY THE DB IS MOCKED: what's under test is one string the action builds,
 * and that needs no database.
 */

export {}

const ORG = 'org-denomination'
const PLAN_ID = 'plan-pool'
const SIGNAL_REPORT = 'signal-report-uuid'
const SIGNAL_NOTE = 'signal-note-uuid'

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

// 5,000 credits for $99, then $0.03 per credit past the pool.
const POOL_TIERS = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
]

const poolStrategy = (creditRates: unknown) => ({
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

const givenPlan = (strategies: any[]) => {
  plansFindFirst.mockResolvedValue({
    id: PLAN_ID,
    name: 'Pool Plan',
    description: 'denomination fixture',
    orgId: ORG,
    agents: null,
    pricing_strategies: strategies,
  })
}

const usageLineOf = (data: any) =>
  data.recurringCharges.lineItems.find(
    (item: any) => item.chargeType === 'usage'
  )

beforeEach(() => {
  plansFindFirst.mockReset()
  signalsFindMany.mockReset()
  signalsFindMany.mockResolvedValue([
    { id: SIGNAL_NOTE, name: 'Note', shortName: 'note' },
  ])
})

describe('simulateRevenue — the pool line says what it bills', () => {
  it('a rated pool quotes CREDITS', async () => {
    givenPlan([poolStrategy({ [SIGNAL_REPORT]: 4, [SIGNAL_NOTE]: 2 })])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 2, note: 3 },
      billingCycle: 'monthly',
    })
    expect(res.success).toBe(true)
    expect(usageLineOf(res.data).description).toMatch(
      /^Content Pool \([\d.]+ credits\)$/
    )
  })

  it('a rate-less pool keeps the unrated sentence, character for character', async () => {
    for (const rateless of [null, undefined, {}]) {
      givenPlan([poolStrategy(rateless)])
      const res = await simulateRevenue({
        pricingPlanId: PLAN_ID,
        projectedEvents: { report: 1250 },
        billingCycle: 'monthly',
      })
      expect(usageLineOf(res.data).description).toBe(
        'Content Pool (1250 units)'
      )
    }
  })

  it('degenerate creditRates never promotes the pool to credits', async () => {
    // Rotten JSON reads as "no rate stored", so the quantity is still raw
    // units. The label follows the arithmetic, never the mere presence of a
    // creditRates column.
    for (const rotten of [
      { [SIGNAL_REPORT]: 'four' },
      { [SIGNAL_REPORT]: 0 },
      { [SIGNAL_REPORT]: -4 },
      [4, 2],
      'rates',
    ]) {
      givenPlan([poolStrategy(rotten)])
      const res = await simulateRevenue({
        pricingPlanId: PLAN_ID,
        projectedEvents: { report: 1250 },
        billingCycle: 'monthly',
      })
      expect(usageLineOf(res.data).description).toBe(
        'Content Pool (1250 units)'
      )
    }
  })

  it('a non-pool usage strategy says units even carrying stray rates', async () => {
    givenPlan([
      {
        ...poolStrategy({ [SIGNAL_REPORT]: 4 }),
        id: 'strategy-flat',
        name: 'Flat Usage',
        pricingModel: 'flat',
        tiers: [],
        rate: 0.5,
      },
    ])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 10 },
      billingCycle: 'monthly',
    })
    expect(usageLineOf(res.data).description).toBe('Flat Usage (10 units)')
  })

  it('seat and recurring lines are untouched by any of this', async () => {
    givenPlan([
      {
        id: 'strategy-seat',
        name: 'Seats',
        chargeType: 'seat_based',
        pricingModel: 'flat',
        billingFrequency: 'monthly',
        signalId: null,
        signals: null,
        tiers: [],
        creditRates: { [SIGNAL_REPORT]: 4 },
        rate: 12,
        minimumCommitment: null,
      },
    ])
    const res = await simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 3,
    })
    expect(res.data.recurringCharges.lineItems[0].description).toBe(
      'Seats (3 seats)'
    )
  })
})

import { readFileSync } from 'fs'
import path from 'path'

/**
 * The behavioral tests above can only see the dashboard copy. The api-nest
 * simulator builds the same sentence from its own code, and a customer who
 * quotes through the API and the dashboard has to read the same noun. Pin
 * the branch in both files so fixing one alone fails here.
 */
describe('denomination drift guard — dashboard action vs api-nest service', () => {
  const actionSource = readFileSync(
    path.join(__dirname, '../invoice-calculator.ts'),
    'utf-8'
  )
  const serviceSource = readFileSync(
    path.join(
      __dirname,
      '../../../../api-nest/src/modules/invoice-calculator/invoice-calculator.service.ts'
    ),
    'utf-8'
  )

  it.each([
    ['dashboard action', () => actionSource],
    ['api-nest service', () => serviceSource],
  ])('%s asks poolIsRated, not a local rate-presence test', (_label, src) => {
    // Canon R1c's shape: ONE answer to "is this pool rated", imported. A local
    // `Object.keys(creditRates).length` here would be a second rule free to
    // disagree with the one the arithmetic uses.
    expect(src()).toMatch(/poolIsRated\(/)
    expect(src()).not.toMatch(/Object\.keys\([^)]*creditRates[^)]*\)\.length/)
  })

  it.each([
    ['dashboard action', () => actionSource],
    ['api-nest service', () => serviceSource],
  ])('%s gates the credits noun on the pool model too', (_label, src) => {
    expect(src()).toMatch(/pricingModel === 'credit_pool' && poolIsRated\(/)
  })

  it.each([
    ['dashboard action', () => actionSource],
    ['api-nest service', () => serviceSource],
  ])('%s hardcodes the units noun nowhere in the usage line', (_label, src) => {
    // A literal ` units)` in the template means that side ignores the
    // denomination.
    expect(src()).not.toMatch(/\$\{quantity\} units\)/)
  })
})
