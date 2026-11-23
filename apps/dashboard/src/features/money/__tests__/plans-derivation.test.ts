import type {
  AgentFilter,
  PricingPlan,
  SubscriptionFilter,
} from '@/app/actions/get-filters'
import {
  agentsAvailableToLink,
  buildPlanAgentIndex,
  buildPlansTabRows,
  firstLinkedAgentId,
  linkedRecordsSummary,
  planHasLinkedRecords,
} from '../plans-derivation'

/**
 * Pure derivation behind the Money → Plans
 * tab. Real assertions (not source-scanning), same idiom as
 * users-derivation.test.ts, since this module has no JSX.
 */

function agent(id: string, name: string, planIds: string[]): AgentFilter {
  return {
    id,
    name,
    description: '',
    agentCode: id,
    isActive: true,
    pricingPlans: planIds.map((planId) => ({
      id: planId,
      name: `plan-${planId}`,
      description: '',
      isActive: true,
    })),
  }
}

function plan(id: string, overrides: Partial<PricingPlan> = {}): PricingPlan {
  return {
    id,
    name: `Plan ${id}`,
    description: '',
    isActive: true,
    featuresList: null,
    ...overrides,
  }
}

function subscription(
  planId: string,
  status: SubscriptionFilter['status']
): SubscriptionFilter {
  return {
    id: `sub-${planId}-${status}-${Math.random()}`,
    name: 'sub',
    status,
    planId,
    agentId: 'agent-x',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: null,
    billingCycle: 'monthly',
    billingModel: 'usage',
    customerId: 'cust-1',
  }
}

describe('buildPlanAgentIndex', () => {
  it('inverts agents[].pricingPlans[] into planId -> linked agents', () => {
    const agents = [
      agent('a1', 'Agent One', ['p1', 'p2']),
      agent('a2', 'Agent Two', ['p1']),
    ]
    const index = buildPlanAgentIndex(agents)
    expect(
      index
        .get('p1')
        ?.map((a) => a.id)
        .sort()
    ).toEqual(['a1', 'a2'])
    expect(index.get('p2')?.map((a) => a.id)).toEqual(['a1'])
  })

  it('a plan linked to no agent has no entry', () => {
    const agents = [agent('a1', 'Agent One', ['p1'])]
    const index = buildPlanAgentIndex(agents)
    expect(index.has('p2')).toBe(false)
  })
})

describe('buildPlansTabRows', () => {
  it('every input plan lands in exactly one output row', () => {
    const plans = [plan('p1'), plan('p2'), plan('p3')]
    const rows = buildPlansTabRows(plans, [], [])
    expect(rows.map((row) => row.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('an unlinked plan gets an empty linkedAgents array, not dropped', () => {
    const rows = buildPlansTabRows([plan('p1')], [], [])
    expect(rows[0].linkedAgents).toEqual([])
  })

  it('counts total subscriptions and active/pending subscriptions separately', () => {
    const subs = [
      subscription('p1', 'active'),
      subscription('p1', 'pending'),
      subscription('p1', 'canceled'),
      subscription('p1', 'expired'),
      subscription('p2', 'active'),
    ]
    const rows = buildPlansTabRows([plan('p1'), plan('p2')], [], subs)
    const p1 = rows.find((row) => row.id === 'p1')!
    const p2 = rows.find((row) => row.id === 'p2')!
    expect(p1.totalSubscriptionCount).toBe(4)
    // Matches deletePricingPlan's exact predicate: status in ('active','pending').
    expect(p1.activeOrPendingSubscriptionCount).toBe(2)
    expect(p2.totalSubscriptionCount).toBe(1)
    expect(p2.activeOrPendingSubscriptionCount).toBe(1)
  })

  it('a plan with zero subscriptions gets zero counts, not undefined', () => {
    const rows = buildPlansTabRows([plan('p1')], [], [])
    expect(rows[0].totalSubscriptionCount).toBe(0)
    expect(rows[0].activeOrPendingSubscriptionCount).toBe(0)
  })

  it('upcoming/ended/canceled/expired subscriptions never count as active-or-pending', () => {
    const subs = (['upcoming', 'ended', 'canceled', 'expired'] as const).map(
      (status) => subscription('p1', status)
    )
    const rows = buildPlansTabRows([plan('p1')], [], subs)
    expect(rows[0].activeOrPendingSubscriptionCount).toBe(0)
    expect(rows[0].totalSubscriptionCount).toBe(4)
  })

  it('carries isActive/name/description through verbatim', () => {
    const rows = buildPlansTabRows(
      [
        plan('p1', {
          name: 'Starter',
          description: 'Entry plan',
          isActive: false,
        }),
      ],
      [],
      []
    )
    expect(rows[0]).toMatchObject({
      name: 'Starter',
      description: 'Entry plan',
      isActive: false,
    })
  })
})

describe('agentsAvailableToLink', () => {
  it('excludes agents already linked to the plan', () => {
    const agents = [
      agent('a1', 'Agent One', ['p1']),
      agent('a2', 'Agent Two', []),
    ]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    const available = agentsAvailableToLink(rows[0], agents)
    expect(available.map((a) => a.id)).toEqual(['a2'])
  })

  it('offers every agent when none are linked yet', () => {
    const agents = [agent('a1', 'Agent One', []), agent('a2', 'Agent Two', [])]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    const available = agentsAvailableToLink(rows[0], agents)
    expect(available.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
  })

  it('offers nothing once every agent is linked', () => {
    const agents = [agent('a1', 'Agent One', ['p1'])]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    expect(agentsAvailableToLink(rows[0], agents)).toEqual([])
  })
})

describe('firstLinkedAgentId', () => {
  it('returns the first linked agent id, for building the detail-route URL', () => {
    const agents = [
      agent('a1', 'Agent One', ['p1']),
      agent('a2', 'Agent Two', ['p1']),
    ]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    expect(firstLinkedAgentId(rows[0])).toBe('a1')
  })

  it('returns null for a plan with no agent link (no route to view/edit it yet)', () => {
    const rows = buildPlansTabRows([plan('p1')], [], [])
    expect(firstLinkedAgentId(rows[0])).toBeNull()
  })
})

/**
 * These two functions drive the deactivate confirmation's destructive
 * messaging (plan-activation-dialog.tsx), which has to reproduce
 * deletePricingPlan's "what's linked" semantics
 * (app/actions/pricing-plans.ts) without hand-rolling a second check.
 */
describe('planHasLinkedRecords — the deactivate-warning trigger', () => {
  it('is false for a plan with no agents and no active/pending subscriptions', () => {
    const rows = buildPlansTabRows([plan('p1')], [], [])
    expect(planHasLinkedRecords(rows[0])).toBe(false)
  })

  it('is true when the plan has a linked agent, even with zero subscriptions', () => {
    const agents = [agent('a1', 'Agent One', ['p1'])]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    expect(planHasLinkedRecords(rows[0])).toBe(true)
  })

  it('is true when the plan has an active subscription, even with zero linked agents', () => {
    const rows = buildPlansTabRows(
      [plan('p1')],
      [],
      [subscription('p1', 'active')]
    )
    expect(planHasLinkedRecords(rows[0])).toBe(true)
  })

  it('stays false for a plan whose only subscriptions are canceled/expired/ended', () => {
    const subs = (['canceled', 'expired', 'ended'] as const).map((status) =>
      subscription('p1', status)
    )
    const rows = buildPlansTabRows([plan('p1')], [], subs)
    expect(planHasLinkedRecords(rows[0])).toBe(false)
  })
})

describe('linkedRecordsSummary', () => {
  it('names agent count and subscription count together, correctly pluralized', () => {
    const agents = [
      agent('a1', 'Agent One', ['p1']),
      agent('a2', 'Agent Two', ['p1']),
    ]
    const subs = [subscription('p1', 'active'), subscription('p1', 'pending')]
    const rows = buildPlansTabRows([plan('p1')], agents, subs)
    expect(linkedRecordsSummary(rows[0])).toBe(
      '2 agents and 2 active or pending subscriptions'
    )
  })

  it('singularizes a count of exactly one', () => {
    const agents = [agent('a1', 'Agent One', ['p1'])]
    const subs = [subscription('p1', 'active')]
    const rows = buildPlansTabRows([plan('p1')], agents, subs)
    expect(linkedRecordsSummary(rows[0])).toBe(
      '1 agent and 1 active or pending subscription'
    )
  })

  it('omits the agent clause entirely when there are none linked', () => {
    const subs = [subscription('p1', 'pending')]
    const rows = buildPlansTabRows([plan('p1')], [], subs)
    expect(linkedRecordsSummary(rows[0])).toBe(
      '1 active or pending subscription'
    )
  })

  it('omits the subscription clause entirely when there are none active/pending', () => {
    const agents = [agent('a1', 'Agent One', ['p1'])]
    const rows = buildPlansTabRows([plan('p1')], agents, [])
    expect(linkedRecordsSummary(rows[0])).toBe('1 agent')
  })
})
