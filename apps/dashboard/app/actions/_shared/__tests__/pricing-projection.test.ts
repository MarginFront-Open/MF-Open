import { readFileSync } from 'fs'
import { join } from 'path'
import {
  calcUsageRevenue,
  calcRecurringRevenue,
  calcSeatRevenue,
  calcOnetimeRevenue,
  type CalcStrategy,
} from '@marginfront/db'
import { projectPlanRevenue } from '../pricing-projection'
import type {
  ProjectionPlanInput,
  ProjectionStrategyInput,
  SimActivity,
} from '@/features/money/simulator-derivation'

/**
 * The dry-run pricing PROJECTION engine.
 *
 * Two things this suite pins:
 *   1. The projected dollars are canon-correct — every number is cross-checked
 *      against the SAME @marginfront/db fee function the billing pipeline uses, so
 *      the engine cannot silently re-implement (and drift from) tier math.
 *   2. It is a DRY RUN — a source scan proves the engine and its 'use server'
 *      wrapper never touch the DB or any ingest/record path.
 */

const SIG_A = 'signal-a'
const SIG_B = 'signal-b'

function usage(
  id: string,
  signalId: string,
  overrides: Partial<ProjectionStrategyInput> = {}
): ProjectionStrategyInput {
  return {
    id,
    label: id,
    chargeType: 'usage',
    pricingModel: 'flat',
    rate: 0.03,
    tiers: null,
    minimumCommitment: null,
    signalId,
    ...overrides,
  }
}

function toCalc(strategy: ProjectionStrategyInput): CalcStrategy {
  return {
    id: strategy.id,
    chargeType: strategy.chargeType,
    pricingModel: strategy.pricingModel,
    rate: strategy.rate,
    tiers: strategy.tiers ?? [],
    minimumCommitment: strategy.minimumCommitment,
    signalId: strategy.signalId,
  }
}

describe('projectPlanRevenue — canon-correct dollars', () => {
  it('a flat usage strategy projects rate × quantity (== canon calcUsageRevenue)', () => {
    const strategy = usage('flat', SIG_A) // $0.03/unit
    const plan: ProjectionPlanInput = {
      planId: 'p1',
      planName: 'Flat',
      strategies: [strategy],
    }
    const activity: SimActivity = { eventsBySignal: { [SIG_A]: 1000 }, seats: 0 }

    const result = projectPlanRevenue(plan, activity, null)

    // Pinned canon-correct value: 1000 × $0.03.
    expect(result.revenueTotal).toBeCloseTo(30, 6)
    // And it equals the exact canon function, not a lookalike.
    expect(result.lineItems[0].projected).toBe(
      calcUsageRevenue(toCalc(strategy), 1000)
    )
  })

  it('a graduated usage strategy matches the canon tier engine exactly', () => {
    const strategy = usage('grad', SIG_A, {
      pricingModel: 'graduated',
      rate: null,
      tiers: [
        { lower: 0, upper: 20, rate: 1 },
        { lower: 20, upper: 70, rate: 0.5 },
        { lower: 70, upper: null, rate: 0.25 },
      ],
    })
    const plan: ProjectionPlanInput = {
      planId: 'p2',
      planName: 'Graduated',
      strategies: [strategy],
    }
    const activity: SimActivity = { eventsBySignal: { [SIG_A]: 100 }, seats: 0 }

    const result = projectPlanRevenue(plan, activity, null)

    // 20×$1 + 50×$0.50 + 30×$0.25 = $52.50 (canon calcGraduated).
    expect(result.revenueTotal).toBeCloseTo(52.5, 6)
    expect(result.lineItems[0].projected).toBe(
      calcUsageRevenue(toCalc(strategy), 100)
    )
  })

  it('sums usage + recurring + seat + one-time, each via its canon fee function', () => {
    const usageStrategy = usage('u', SIG_A) // 1000 × $0.03 = $30
    const recurring: ProjectionStrategyInput = {
      id: 'r',
      label: 'Platform fee',
      chargeType: 'recurring',
      pricingModel: null,
      rate: 500,
      tiers: null,
      minimumCommitment: null,
      signalId: null,
    }
    const seat: ProjectionStrategyInput = {
      id: 's',
      label: 'Per seat',
      chargeType: 'seat_based',
      pricingModel: 'flat',
      rate: 10,
      tiers: null,
      minimumCommitment: null,
      signalId: null,
    }
    const onetime: ProjectionStrategyInput = {
      id: 'o',
      label: 'Setup',
      chargeType: 'onetime',
      pricingModel: null,
      rate: 99,
      tiers: null,
      minimumCommitment: null,
      signalId: null,
    }
    const plan: ProjectionPlanInput = {
      planId: 'p3',
      planName: 'Everything',
      strategies: [usageStrategy, recurring, seat, onetime],
    }
    const activity: SimActivity = { eventsBySignal: { [SIG_A]: 1000 }, seats: 4 }

    const result = projectPlanRevenue(plan, activity, null)

    const expected =
      calcUsageRevenue(toCalc(usageStrategy), 1000) + // 30
      calcRecurringRevenue(toCalc(recurring), 1) + // 500
      calcSeatRevenue(toCalc(seat), 4, 1) + // 40
      calcOnetimeRevenue(
        toCalc(onetime),
        new Date(0),
        new Date(0),
        new Date(8640000000000000)
      ) // 99
    // Pinned: 30 + 500 + 40 + 99.
    expect(result.revenueTotal).toBeCloseTo(669, 6)
    expect(result.revenueTotal).toBeCloseTo(expected, 6)
  })

  it('a signal with no projected volume contributes $0, not undefined', () => {
    const plan: ProjectionPlanInput = {
      planId: 'p4',
      planName: 'Two meters',
      strategies: [usage('a', SIG_A), usage('b', SIG_B)],
    }
    const activity: SimActivity = { eventsBySignal: { [SIG_A]: 500 }, seats: 0 }

    const result = projectPlanRevenue(plan, activity, null)

    expect(result.revenueTotal).toBeCloseTo(15, 6) // 500 × $0.03, SIG_B = $0
    expect(result.lineItems[1].projected).toBe(0)
  })
})

describe('projectPlanRevenue — margin against a real cost', () => {
  const plan: ProjectionPlanInput = {
    planId: 'p5',
    planName: 'Flat',
    strategies: [usage('u', SIG_A)],
  }
  const activity: SimActivity = { eventsBySignal: { [SIG_A]: 1000 }, seats: 0 }

  it('computes margin via canon safeMarginPercent when a cost is supplied', () => {
    const result = projectPlanRevenue(plan, activity, 10)
    // revenue 30, cost 10 → margin 20 → 20/30 = 66.67%.
    expect(result.actualCost).toBe(10)
    expect(result.marginPct).toBeCloseTo(66.6667, 3)
  })

  it('leaves margin null (never 0) when no real cost is known', () => {
    const result = projectPlanRevenue(plan, activity, null)
    expect(result.actualCost).toBeNull()
    expect(result.marginPct).toBeNull()
  })
})

describe('dry-run guarantee — no write or ingest path exists in the source', () => {
  // Strip comments so the scan judges executable CODE, not the doc-comments
  // that (deliberately) name recordSdkUsage/ingest to contrast against them.
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const ENGINE = code(
    readFileSync(join(__dirname, '..', 'pricing-projection.ts'), 'utf8')
  )
  const ACTION = code(
    readFileSync(join(__dirname, '..', '..', 'simulate-pricing.ts'), 'utf8')
  )
  const WRITE_OR_INGEST =
    /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|executeRaw|\bingest\b|recordSdkUsage|revalidatePath/

  it('the projection engine never writes and never queries the DB', () => {
    expect(ENGINE).not.toMatch(WRITE_OR_INGEST)
    expect(ENGINE).not.toMatch(/\bdb\.|\bprisma\./)
  })

  it("the 'use server' wrapper never writes and never queries the DB", () => {
    expect(ACTION).not.toMatch(WRITE_OR_INGEST)
    expect(ACTION).not.toMatch(/\bdb\.|\bprisma\./)
  })

  it('the engine calls the canon fee functions (does not re-implement rate math)', () => {
    expect(ENGINE).toMatch(/calcUsageRevenue\(/)
    expect(ENGINE).toMatch(/calcRecurringRevenue\(/)
    expect(ENGINE).toMatch(/calcSeatRevenue\(/)
    expect(ENGINE).toMatch(/calcOnetimeRevenue\(/)
    // No inline "quantity × rate" pricing math — that must live in @marginfront/db.
    expect(ENGINE).not.toMatch(/rate\s*\*/)
    expect(ENGINE).not.toMatch(/\*\s*[\w.]*rate/i)
  })
})

describe('seat minimum-commitment clamp is visible, not just priced in', () => {
  // Canon R1b: the regression fixture includes a minimum-commitment floor.
  const seatWithFloor: ProjectionStrategyInput = {
    id: 's-floor',
    label: 'Per seat',
    chargeType: 'seat_based',
    pricingModel: 'flat',
    rate: 10,
    tiers: null,
    minimumCommitment: 10,
    signalId: null,
  }
  const plan: ProjectionPlanInput = {
    planId: 'p6',
    planName: 'Seat floor',
    strategies: [seatWithFloor],
  }
  const noEvents: SimActivity['eventsBySignal'] = {}

  it('5 entered seats against a 10-seat minimum: dollars clamp AND billedQuantity says 10', () => {
    const result = projectPlanRevenue(
      plan,
      { eventsBySignal: noEvents, seats: 5 },
      null
    )
    // max(5, 10) × $10 — and it equals the exact canon function.
    expect(result.revenueTotal).toBeCloseTo(100, 6)
    expect(result.lineItems[0].projected).toBe(
      calcSeatRevenue(toCalc(seatWithFloor), 5, 1)
    )
    expect(result.lineItems[0].quantity).toBe(5)
    expect(result.lineItems[0].billedQuantity).toBe(10)
  })

  it('0 entered seats still bill the minimum', () => {
    const result = projectPlanRevenue(
      plan,
      { eventsBySignal: noEvents, seats: 0 },
      null
    )
    expect(result.revenueTotal).toBeCloseTo(100, 6)
    expect(result.lineItems[0].quantity).toBe(0)
    expect(result.lineItems[0].billedQuantity).toBe(10)
  })

  it('above the minimum, billedQuantity tracks the real count', () => {
    const result = projectPlanRevenue(
      plan,
      { eventsBySignal: noEvents, seats: 12 },
      null
    )
    expect(result.revenueTotal).toBeCloseTo(120, 6)
    expect(result.lineItems[0].quantity).toBe(12)
    expect(result.lineItems[0].billedQuantity).toBe(12)
  })
})
