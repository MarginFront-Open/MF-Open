'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'

// Types
export interface AgentFilter {
  id: string
  name: string
  description: string
  agentCode: string
  isActive: boolean
  pricingPlans: PricingPlanBasic[]
}

export interface CustomerBasic {
  id: string
  name: string
  email: string
  externalId: string
  status: string
  // Carries the internal/external partition + default
  // GL so the Money → Users tab can split the first-class
  // "Internal" bucket out from real customers.
  isInternal: boolean
  defaultGlCodeId: string | null
}

export interface PricingPlanBasic {
  id: string
  name: string
  description: string
  isActive: boolean
}

export interface PricingPlan extends PricingPlanBasic {
  featuresList: {
    tags: string[]
  } | null
}

export interface Signal {
  id: string
  name: string
  shortName: string | null
  type?: 'volume' | 'usage' | null
}

export interface SubscriptionFilter {
  id: string
  name: string
  status: 'active' | 'canceled' | 'expired' | 'pending' | 'upcoming' | 'ended'
  planId: string
  agentId: string
  startDate: string
  endDate: string | null
  billingCycle: 'monthly' | 'yearly' | 'custom'
  // Required by GenerateInvoiceDialog's eligible-subs
  // filter. Without this field on the wire, the dialog filters all subs out
  // (.billingModel is undefined → never matches 'usage' or 'hybrid') so the
  // subscription dropdown stays disabled.
  billingModel: 'subscription' | 'usage' | 'hybrid'
  customerId: string
}

export interface FiltersResponse {
  agents: AgentFilter[]
  customers: CustomerBasic[]
  pricingPlans: PricingPlan[]
  signals: Signal[]
  subscriptions: SubscriptionFilter[]
}

/**
 * Server Action to get all filter data for dropdowns and forms
 */
export async function getFilters(): Promise<{
  success: boolean
  data?: FiltersResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    // Fetch all filter data in parallel
    const [agents, customers, pricingPlans, signals, subscriptions] =
      await Promise.all([
        getAgents(orgId),
        getCustomers(orgId),
        getPricingPlans(orgId),
        getSignals(orgId),
        getSubscriptions(orgId),
      ])

    return {
      success: true,
      data: {
        agents,
        customers,
        pricingPlans,
        signals,
        subscriptions,
      },
    }
  } catch (error) {
    console.error('[getFilters] Error:', error)
    return { success: false, error: 'Failed to fetch filters' }
  }
}

async function getAgents(orgId: string): Promise<AgentFilter[]> {
  const agents = await prisma.agents.findMany({
    where: {
      orgId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      description: true,
      agentCode: true,
      isActive: true,
      // Plans linked via junction table (many-to-many)
      agent_pricing_plans: {
        where: {
          pricing_plans: { deletedAt: null },
        },
        select: {
          pricing_plans: {
            select: {
              id: true,
              name: true,
              description: true,
              isActive: true,
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  // Flatten the junction table structure so the output shape stays
  // identical to what downstream components expect: agent.pricingPlans[]
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    agentCode: agent.agentCode,
    isActive: agent.isActive ?? true,
    pricingPlans: agent.agent_pricing_plans.map((link) => ({
      id: link.pricing_plans.id,
      name: link.pricing_plans.name,
      description: link.pricing_plans.description || '',
      isActive: link.pricing_plans.isActive ?? true,
    })),
  }))
}

async function getCustomers(orgId: string): Promise<CustomerBasic[]> {
  const customers = await prisma.customers.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      externalId: true,
      status: true,
      isInternal: true,
      defaultGlCodeId: true,
    },
    orderBy: { name: 'asc' },
  })

  return customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: customer.email || '',
    externalId: customer.externalId || '',
    status: customer.status || 'active',
    isInternal: customer.isInternal,
    defaultGlCodeId: customer.defaultGlCodeId,
  }))
}

async function getPricingPlans(orgId: string): Promise<PricingPlan[]> {
  const plans = await prisma.pricing_plans.findMany({
    where: {
      orgId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      featuresList: true,
    },
    orderBy: { name: 'asc' },
  })

  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description || '',
    isActive: plan.isActive ?? true,
    featuresList: plan.featuresList as { tags: string[] } | null,
  }))
}

async function getSignals(orgId: string): Promise<Signal[]> {
  const signals = await prisma.signals.findMany({
    where: {
      orgId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      shortName: true,
      type: true,
    },
    orderBy: { name: 'asc' },
  })

  return signals.map((signal) => ({
    id: signal.id,
    name: signal.name,
    shortName: signal.shortName,
    type: signal.type as 'volume' | 'usage' | null,
  }))
}

async function getSubscriptions(orgId: string): Promise<SubscriptionFilter[]> {
  const subscriptions = await prisma.subscriptions.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      status: true,
      planId: true,
      agentId: true,
      startDate: true,
      endDate: true,
      billingCycle: true,
      billingModel: true,
      customerId: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  return subscriptions.map((sub) => ({
    id: sub.id,
    name: sub.name,
    status: (sub.status || 'pending') as SubscriptionFilter['status'],
    planId: sub.planId,
    agentId: sub.agentId,
    startDate: sub.startDate.toISOString(),
    endDate: sub.endDate?.toISOString() ?? null,
    billingCycle: (sub.billingCycle ||
      'monthly') as SubscriptionFilter['billingCycle'],
    billingModel: (sub.billingModel ||
      'subscription') as SubscriptionFilter['billingModel'],
    customerId: sub.customerId,
  }))
}
