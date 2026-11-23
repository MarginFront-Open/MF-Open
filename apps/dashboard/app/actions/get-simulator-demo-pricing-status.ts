'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'

/**
 * Server Action: does "Simulator Demo Plan" exist end-to-end for this
 * agent + customer + signal combo?
 *
 * The SDK Simulator's "Demo pricing" panel calls this to decide whether
 * to show "Set up demo pricing" (no chain) or "Edit rate / Manage plan"
 * (chain exists). We return the first missing link or the full triple
 * so the UI can render the right state. Read-only.
 */

export interface SimulatorDemoPricingStatus {
  exists: boolean
  ratePerUnit?: number
  planId?: string
  strategyId?: string
  subscriptionId?: string
  error?: string
}

export async function getSimulatorDemoPricingStatus(input: {
  agentId: string
  customerId: string
  signalName: string
}): Promise<SimulatorDemoPricingStatus> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { exists: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    // Resolve signalId from name + agent — the simulator only tracks
    // signalName, and signals have a unique constraint on (agentId, name)
    const signal = await db.signals.findFirst({
      where: {
        agentId: input.agentId,
        name: input.signalName,
        orgId,
      },
      select: { id: true },
    })

    // If the signal doesn't exist yet (auto-provisioned at first event),
    // there can't be a strategy for it — short-circuit as "not set up"
    if (!signal) {
      return { exists: false }
    }

    // Link 1: the plan named "Simulator Demo Plan" linked to this agent
    const plan = await db.pricing_plans.findFirst({
      where: {
        orgId,
        name: 'Simulator Demo Plan',
        deletedAt: null,
        agent_pricing_plans: {
          some: { agentId: input.agentId },
        },
      },
      select: { id: true },
    })

    if (!plan) {
      return { exists: false }
    }

    // Link 2: a strategy on that plan for this signal
    const strategy = await db.pricing_strategies.findFirst({
      where: {
        planId: plan.id,
        signalId: signal.id,
        deletedAt: null,
      },
      select: { id: true, rate: true },
    })

    if (!strategy) {
      return { exists: false }
    }

    // Link 3: an active subscription for this customer/agent/plan
    const subscription = await db.subscriptions.findFirst({
      where: {
        organizationId: orgId,
        customerId: input.customerId,
        agentId: input.agentId,
        planId: plan.id,
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
    })

    if (!subscription) {
      return { exists: false }
    }

    return {
      exists: true,
      ratePerUnit: Number(strategy.rate ?? 0),
      planId: plan.id,
      strategyId: strategy.id,
      subscriptionId: subscription.id,
    }
  } catch (error) {
    console.error('[getSimulatorDemoPricingStatus] Error:', error)
    return { exists: false, error: 'Failed to check demo pricing status' }
  }
}
