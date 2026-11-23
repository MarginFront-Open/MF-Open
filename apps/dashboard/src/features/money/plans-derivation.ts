/**
 * Pure derivation behind the Money → Plans
 * tab. Everything here derives from the SAME getFilters() response the
 * Users tab already reuses — no second query for the list, and
 * no second query for the deactivate dialog's "what's linked" numbers.
 *
 * The active/pending subscription count uses the exact same predicate as
 * deletePricingPlan's block check (app/actions/pricing-plans.ts:
 * `status: { in: ['active', 'pending'] }, deletedAt: null`) — every row
 * getFilters().subscriptions returns already has `deletedAt: null` applied
 * upstream (get-filters.ts getSubscriptions), so filtering by status here
 * reproduces that count without a second DB round trip.
 */

import type {
  AgentFilter,
  PricingPlan,
  SubscriptionFilter,
} from '@/app/actions/get-filters'

export interface LinkedAgent {
  id: string
  name: string
  agentCode: string
}

export interface PlansTabRow {
  id: string
  name: string
  description: string
  isActive: boolean
  linkedAgents: LinkedAgent[]
  totalSubscriptionCount: number
  activeOrPendingSubscriptionCount: number
}

const ACTIVE_OR_PENDING = new Set(['active', 'pending'])

/** Inverts agents[].pricingPlans[] (getFilters' shape) into planId -> the
 * agents that offer it — the junction table's other direction, without a
 * second query. */
export function buildPlanAgentIndex(
  agents: ReadonlyArray<AgentFilter>
): Map<string, LinkedAgent[]> {
  const index = new Map<string, LinkedAgent[]>()
  for (const agent of agents) {
    for (const plan of agent.pricingPlans) {
      const linked = index.get(plan.id) ?? []
      linked.push({
        id: agent.id,
        name: agent.name,
        agentCode: agent.agentCode,
      })
      index.set(plan.id, linked)
    }
  }
  return index
}

/** The Plans tab table's rows — every org plan, paired with its linked
 * agents and subscription counts. Every input plan lands in exactly one
 * output row (a plan with zero links or zero subscriptions still appears,
 * just with empty/zero fields — never silently dropped). */
export function buildPlansTabRows(
  plans: ReadonlyArray<PricingPlan>,
  agents: ReadonlyArray<AgentFilter>,
  subscriptions: ReadonlyArray<SubscriptionFilter>
): PlansTabRow[] {
  const agentIndex = buildPlanAgentIndex(agents)
  return plans.map((plan) => {
    const planSubscriptions = subscriptions.filter(
      (sub) => sub.planId === plan.id
    )
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      isActive: plan.isActive,
      linkedAgents: agentIndex.get(plan.id) ?? [],
      totalSubscriptionCount: planSubscriptions.length,
      activeOrPendingSubscriptionCount: planSubscriptions.filter((sub) =>
        ACTIVE_OR_PENDING.has(sub.status)
      ).length,
    }
  })
}

/** Agents this plan isn't linked to yet — the choices offered by the
 * per-row "+ Link agent" control. */
export function agentsAvailableToLink(
  row: Pick<PlansTabRow, 'linkedAgents'>,
  agents: ReadonlyArray<AgentFilter>
): LinkedAgent[] {
  const linkedIds = new Set(row.linkedAgents.map((agent) => agent.id))
  return agents
    .filter((agent) => !linkedIds.has(agent.id))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      agentCode: agent.agentCode,
    }))
}

/** The plan detail/configure routes are agent-scoped
 * (`/agents/[agentId]/pricing-plans/[planId]`), but that page's own fetch
 * (getPricingPlan(planId)) doesn't filter by the agentId in the URL — any
 * linked agent's id works. Returns `null` when the plan has no agent link
 * at all (created without one, or every link since removed): there's no
 * agent segment to route through until it's linked to at least one agent. */
export function firstLinkedAgentId(
  row: Pick<PlansTabRow, 'linkedAgents'>
): string | null {
  return row.linkedAgents[0]?.id ?? null
}

/** True when deactivating this plan would affect something a manager should
 * know about before confirming — it's linked to at least one agent, or has
 * at least one active/pending subscription. Drives the destructive styling
 * on the deactivate confirmation (plan-activation-dialog.tsx). */
export function planHasLinkedRecords(
  row: Pick<PlansTabRow, 'linkedAgents' | 'activeOrPendingSubscriptionCount'>
): boolean {
  return row.linkedAgents.length > 0 || row.activeOrPendingSubscriptionCount > 0
}

/** The "linked to X agents and Y active subscriptions" clause of the
 * deactivate warning — pure string-building so it's unit-tested directly
 * rather than only via source-scanning the dialog's JSX. */
export function linkedRecordsSummary(
  row: Pick<PlansTabRow, 'linkedAgents' | 'activeOrPendingSubscriptionCount'>
): string {
  const parts: string[] = []
  if (row.linkedAgents.length > 0) {
    parts.push(
      `${row.linkedAgents.length} agent${row.linkedAgents.length === 1 ? '' : 's'}`
    )
  }
  if (row.activeOrPendingSubscriptionCount > 0) {
    parts.push(
      `${row.activeOrPendingSubscriptionCount} active or pending subscription${row.activeOrPendingSubscriptionCount === 1 ? '' : 's'}`
    )
  }
  return parts.join(' and ')
}
