import type { PricingPlan } from '@/app/actions/pricing-plans'
import {
  eventsBySignalFromText,
  plansHaveSeatStrategy,
  toProjectionPlanInput,
  usageSignalRows,
  type ProjectionPlanInput,
} from '../simulator-derivation'

/**
 * The client-safe Simulator derivation. Pure
 * logic, real assertions (no DB, no @marginfront/db). Proves the tab feeds the
 * canon engine the right shape: active strategies only, usage meters deduped
 * across compared plans, and half-typed inputs clamped to a number.
 */

function plan(overrides: Partial<PricingPlan> = {}): PricingPlan {
  return {
    id: 'plan-1',
    name: 'Starter',
    description: null,
    featuresList: null,
    agentId: null,
    orgId: 'org-1',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    agents: [],
    pricingStrategies: [
      {
        id: 'strat-usage',
        name: 'API calls',
        agentId: 'a1',
        planId: 'plan-1',
        signalId: 'sig-calls',
        chargeType: 'usage',
        pricingModel: 'flat',
        billingFrequency: null,
        tiers: [{ lower: 0, upper: null, rate: 0.02 }],
        creditPool: null,
        rate: 0.02,
        minimumCommitment: null,
        tags: [],
        active: true,
        signal: {
          id: 'sig-calls',
          name: 'API Calls',
          shortName: 'calls',
          type: 'counter',
        },
      },
    ],
    ...overrides,
  }
}

describe('toProjectionPlanInput', () => {
  it('labels a usage strategy by its signal name, keeps its tiers + model', () => {
    const input = toProjectionPlanInput(plan())
    expect(input.planId).toBe('plan-1')
    expect(input.strategies).toHaveLength(1)
    const strategy = input.strategies[0]
    expect(strategy.label).toBe('API Calls')
    expect(strategy.chargeType).toBe('usage')
    expect(strategy.pricingModel).toBe('flat')
    expect(strategy.tiers).toEqual([{ lower: 0, upper: null, rate: 0.02 }])
    expect(strategy.signalId).toBe('sig-calls')
  })

  it('drops inactive strategies (they would not be billed)', () => {
    const p = plan()
    p.pricingStrategies![0].active = false
    expect(toProjectionPlanInput(p).strategies).toHaveLength(0)
  })

  it('labels a non-usage strategy by the strategy name', () => {
    const p = plan()
    p.pricingStrategies = [
      {
        id: 'strat-fee',
        name: 'Platform fee',
        agentId: 'a1',
        planId: 'plan-1',
        signalId: null,
        chargeType: 'recurring',
        pricingModel: null,
        billingFrequency: 'monthly',
        tiers: null,
        creditPool: null,
        rate: 500,
        minimumCommitment: null,
        tags: [],
        active: true,
        signal: null,
      },
    ]
    expect(toProjectionPlanInput(p).strategies[0].label).toBe('Platform fee')
  })

  it('treats a plan whose strategies were not loaded as an empty plan', () => {
    const p = plan({ pricingStrategies: undefined })
    expect(toProjectionPlanInput(p).strategies).toEqual([])
  })
})

describe('usageSignalRows', () => {
  it('lists one row per usage signal, deduped across compared plans', () => {
    const shared: ProjectionPlanInput = {
      planId: 'a',
      planName: 'A',
      strategies: [
        {
          id: 's1',
          label: 'Calls',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.02,
          tiers: null,
          minimumCommitment: null,
          signalId: 'sig-calls',
        },
      ],
    }
    const other: ProjectionPlanInput = {
      planId: 'b',
      planName: 'B',
      strategies: [
        {
          id: 's2',
          label: 'Calls (cheaper)',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.01,
          tiers: null,
          minimumCommitment: null,
          signalId: 'sig-calls',
        },
        {
          id: 's3',
          label: 'Tokens',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.0001,
          tiers: null,
          minimumCommitment: null,
          signalId: 'sig-tokens',
        },
      ],
    }
    const rows = usageSignalRows([shared, other])
    expect(rows.map((r) => r.signalId)).toEqual(['sig-calls', 'sig-tokens'])
  })

  it('ignores non-usage strategies and usage strategies with no signal', () => {
    const p: ProjectionPlanInput = {
      planId: 'a',
      planName: 'A',
      strategies: [
        {
          id: 'fee',
          label: 'Fee',
          chargeType: 'recurring',
          pricingModel: null,
          rate: 100,
          tiers: null,
          minimumCommitment: null,
          signalId: null,
        },
      ],
    }
    expect(usageSignalRows([p])).toEqual([])
  })
})

describe('plansHaveSeatStrategy', () => {
  it('is true only when a selected plan has a seat-based strategy', () => {
    const usageOnly: ProjectionPlanInput = {
      planId: 'a',
      planName: 'A',
      strategies: [
        {
          id: 's',
          label: 'Calls',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.02,
          tiers: null,
          minimumCommitment: null,
          signalId: 'sig',
        },
      ],
    }
    expect(plansHaveSeatStrategy([usageOnly])).toBe(false)
    const withSeat: ProjectionPlanInput = {
      ...usageOnly,
      strategies: [
        {
          id: 'seat',
          label: 'Seat',
          chargeType: 'seat_based',
          pricingModel: 'flat',
          rate: 10,
          tiers: null,
          minimumCommitment: null,
          signalId: null,
        },
      ],
    }
    expect(plansHaveSeatStrategy([withSeat])).toBe(true)
  })
})

describe('eventsBySignalFromText', () => {
  it('parses numbers and clamps blank / negative / non-numeric to 0', () => {
    expect(
      eventsBySignalFromText({ a: '1000', b: '', c: '-5', d: 'abc', e: '12.5' })
    ).toEqual({ a: 1000, b: 0, c: 0, d: 0, e: 12.5 })
  })
})
