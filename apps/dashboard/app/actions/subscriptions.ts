'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Subscriptions drive recurring billing, so create/update/delete are
// money writes. Gate them on owner/admin/finance; reads need only a session in the org.
import { assertMoneyManager } from './_shared/assert-money-manager'

// Types
type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'expired'
  | 'pending'
  | 'upcoming'
  | 'ended'
type BillingCycle = 'monthly' | 'yearly' | 'custom'

export interface Subscription {
  id: string
  customerId: string
  organizationId: string
  name: string
  status: SubscriptionStatus
  planId: string
  agentId: string
  startDate: string
  endDate: string | null
  isForever: boolean
  billingCycle: BillingCycle
  seatsCount: number
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  // Related data
  customer?: {
    id: string
    name: string
    email: string | null
  }
  agent?: {
    id: string
    name: string
  }
  pricingPlan?: {
    id: string
    name: string
    description: string | null
  }
}

export interface SubscriptionQueryParams {
  limit?: number
  page?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  status?: string
  planId?: string
  agentId?: string
  customerId?: string
  billingCycle?: string
  search?: string
  includeDetails?: boolean
  startDate?: string
  endDate?: string
}

export interface PaginatedResponse<T> {
  results: T[]
  total: number
  totalResults: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateSubscriptionPayload {
  name: string
  planId: string
  agentId: string
  customerId: string
  startDate: string
  endDate?: string
  isForever?: boolean
  billingCycle?: 'monthly' | 'yearly' | 'custom'
  billingModel?: 'subscription' | 'usage' | 'hybrid'
  netTerms?: number
  billingDay?: number
  customCycleDays?: number
  seatsCount?: number
  metadata?: Record<string, unknown>
}

export interface UpdateSubscriptionPayload {
  name?: string
  planId?: string
  agentId?: string
  startDate?: string
  endDate?: string
  isForever?: boolean
  status?: string
  billingCycle?: string
  netTerms?: number
  billingDay?: number
  customCycleDays?: number
  seatsCount?: number
  metadata?: Record<string, unknown>
}

// Helper to map subscription data
const mapSubscription = (s: any): Subscription => ({
  id: s.id,
  customerId: s.customerId,
  organizationId: s.organizationId || '',
  name: s.name,
  status: (s.status || 'pending') as SubscriptionStatus,
  planId: s.planId,
  agentId: s.agentId,
  startDate: s.startDate.toISOString(),
  endDate: s.endDate?.toISOString() ?? null,
  isForever: s.isForever ?? false,
  billingCycle: (s.billingCycle || 'monthly') as BillingCycle,
  seatsCount: s.seatsCount ?? 0,
  metadata: s.metadata as Record<string, unknown> | null,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  customer: s.customers
    ? {
        id: s.customers.id,
        name: s.customers.name,
        email: s.customers.email,
      }
    : undefined,
  agent: s.agents
    ? {
        id: s.agents.id,
        name: s.agents.name,
      }
    : undefined,
  pricingPlan: s.pricing_plans
    ? {
        id: s.pricing_plans.id,
        name: s.pricing_plans.name,
        description: s.pricing_plans.description,
      }
    : undefined,
})

/**
 * Get subscriptions with pagination and filtering
 */
export async function getSubscriptions(
  params: SubscriptionQueryParams = {}
): Promise<{
  success: boolean
  data?: PaginatedResponse<Subscription>
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
    const {
      limit = 10,
      page = 1,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status,
      planId,
      agentId,
      customerId,
      billingCycle,
      search,
      includeDetails = true,
    } = params

    // Build where clause
    const where: Prisma.subscriptionsWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    }

    if (status) {
      where.status = status as any
    }

    if (planId) {
      where.planId = planId
    }

    if (agentId) {
      where.agentId = agentId
    }

    if (customerId) {
      where.customerId = customerId
    }

    if (billingCycle) {
      where.billingCycle = billingCycle as any
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { customers: { name: { contains: search, mode: 'insensitive' } } },
      ]
    }

    // Get total count
    const total = await db.subscriptions.count({ where })

    // Get subscriptions with optional related data
    const subscriptions = await db.subscriptions.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
      include: includeDetails
        ? {
            customers: {
              select: { id: true, name: true, email: true },
            },
            agents: {
              select: { id: true, name: true },
            },
            pricing_plans: {
              select: { id: true, name: true, description: true },
            },
          }
        : undefined,
    })

    const results: Subscription[] = subscriptions.map(mapSubscription)

    return {
      success: true,
      data: {
        results,
        total,
        totalResults: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    }
  } catch (error) {
    console.error('[getSubscriptions] Error:', error)
    return { success: false, error: 'Failed to fetch subscriptions' }
  }
}

/**
 * Get a single subscription by ID
 */
export async function getSubscription(
  subscriptionId: string,
  includeDetails: boolean = true
): Promise<{
  success: boolean
  data?: Subscription
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

    const subscription = await db.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId: orgId,
        deletedAt: null,
      },
      include: includeDetails
        ? {
            customers: {
              select: { id: true, name: true, email: true },
            },
            agents: {
              select: { id: true, name: true },
            },
            pricing_plans: {
              select: { id: true, name: true, description: true },
            },
          }
        : undefined,
    })

    if (!subscription) {
      return { success: false, error: 'Subscription not found' }
    }

    return {
      success: true,
      data: mapSubscription(subscription),
    }
  } catch (error) {
    console.error('[getSubscription] Error:', error)
    return { success: false, error: 'Failed to fetch subscription' }
  }
}

/**
 * Create a new subscription
 */
export async function createSubscription(
  data: CreateSubscriptionPayload
): Promise<{
  success: boolean
  data?: Subscription
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Each foreign ID must live in the caller's org — otherwise org A could
    // bill with org B's plan. Cross-org and nonexistent IDs share the same
    // 'not found' so the response can't confirm another org's ID exists.
    const [customer, plan, agent] = await Promise.all([
      db.customers.findFirst({
        where: { id: data.customerId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      }),
      db.pricing_plans.findFirst({
        where: { id: data.planId, orgId, deletedAt: null },
        select: { id: true },
      }),
      db.agents.findFirst({
        where: { id: data.agentId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ])
    if (!customer) return { success: false, error: 'Customer not found' }
    if (!plan) return { success: false, error: 'Pricing plan not found' }
    if (!agent) return { success: false, error: 'Agent not found' }

    const now = new Date()

    const subscription = await db.subscriptions.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: orgId,
        customerId: data.customerId,
        planId: data.planId,
        agentId: data.agentId,
        name: data.name,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
        isForever: data.isForever ?? false,
        billingCycle: data.billingCycle || 'monthly',
        billingModel: data.billingModel,
        netTerms: data.netTerms,
        billingDay: data.billingDay,
        customCycleDays: data.customCycleDays,
        seatsCount: Math.max(0, Math.trunc(data.seatsCount ?? 0)),
        metadata: data.metadata as Prisma.InputJsonValue,
        status: 'active',
        nextRecurringInvoiceAt: now,
        nextUsageInvoiceAt: now,
        createdAt: now,
        updatedAt: now,
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        agents: {
          select: { id: true, name: true },
        },
        pricing_plans: {
          select: { id: true, name: true, description: true },
        },
      },
    })

    revalidatePath('/subscriptions')

    return {
      success: true,
      data: mapSubscription(subscription),
    }
  } catch (error) {
    console.error('[createSubscription] Error:', error)
    return { success: false, error: 'Failed to create subscription' }
  }
}

/**
 * Update a subscription
 */
export async function updateSubscription(
  subscriptionId: string,
  data: UpdateSubscriptionPayload,
  changeReason?: string
): Promise<{
  success: boolean
  data?: Subscription
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify subscription belongs to org
    const existing = await db.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Subscription not found' }
    }

    // Same org-ownership rule as create for the foreign IDs an update can
    // swap (customerId is not updatable here).
    if (data.planId) {
      const plan = await db.pricing_plans.findFirst({
        where: { id: data.planId, orgId, deletedAt: null },
        select: { id: true },
      })
      if (!plan) return { success: false, error: 'Pricing plan not found' }
    }
    if (data.agentId) {
      const agent = await db.agents.findFirst({
        where: { id: data.agentId, orgId, deletedAt: null },
        select: { id: true },
      })
      if (!agent) return { success: false, error: 'Agent not found' }
    }

    const now = new Date()

    const subscription = await db.subscriptions.update({
      where: { id: subscriptionId },
      data: {
        name: data.name,
        planId: data.planId,
        agentId: data.agentId,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        isForever: data.isForever,
        status: data.status as any,
        billingCycle: data.billingCycle as any,
        netTerms: data.netTerms,
        billingDay: data.billingDay,
        customCycleDays: data.customCycleDays,
        // undefined = leave unchanged (Prisma skips undefined fields), so
        // callers that don't know about seats can't zero a real count.
        seatsCount:
          data.seatsCount == null
            ? undefined
            : Math.max(0, Math.trunc(data.seatsCount)),
        metadata: data.metadata as Prisma.InputJsonValue,
        updatedAt: now,
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        agents: {
          select: { id: true, name: true },
        },
        pricing_plans: {
          select: { id: true, name: true, description: true },
        },
      },
    })

    // The reason is optional: only edits that carry one get logged.
    if (changeReason?.trim()) {
      await db.subscription_change_logs.create({
        data: {
          id: crypto.randomUUID(),
          subscriptionId,
          changedBy: gate.userId,
          changeType: 'updated',
          previousValues: {
            planId: existing.planId,
            agentId: existing.agentId,
            status: existing.status,
            billingCycle: existing.billingCycle,
          } as Prisma.InputJsonValue,
          newValues: data as unknown as Prisma.InputJsonValue,
          changeReason,
          createdAt: now,
          updatedAt: now,
        },
      })
    }

    revalidatePath('/subscriptions')
    revalidatePath(`/subscriptions/${subscriptionId}`)

    return {
      success: true,
      data: mapSubscription(subscription),
    }
  } catch (error) {
    console.error('[updateSubscription] Error:', error)
    return { success: false, error: 'Failed to update subscription' }
  }
}

/**
 * Delete a subscription (soft delete — sets status:'ended' and deletedAt).
 * This zeros the subscription out of history-preserving revenue surfaces.
 * A "stop this subscription" UI flow must call cancelSubscription() below
 * instead — never this — or past revenue on it silently disappears.
 */
export async function deleteSubscription(subscriptionId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify subscription belongs to org
    const existing = await db.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Subscription not found' }
    }

    // Soft delete
    await db.subscriptions.update({
      where: { id: subscriptionId },
      data: {
        deletedAt: new Date(),
        status: 'ended',
      },
    })

    revalidatePath('/subscriptions')

    return { success: true }
  } catch (error) {
    console.error('[deleteSubscription] Error:', error)
    return { success: false, error: 'Failed to delete subscription' }
  }
}

/**
 * Cancel a subscription — the SAFE stop (status:'canceled'). Never routes
 * through deleteSubscription (status:'ended' + deletedAt): unlike cancel, a
 * hard delete or a pricing-strategy deactivation both silently zero a
 * subscription's revenue history. Logs to subscription_change_logs with the
 * required reason, same table updateSubscription's edit-reason feeds.
 */
export async function cancelSubscription(
  subscriptionId: string,
  changeReason: string
): Promise<{
  success: boolean
  data?: Subscription
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    if (!changeReason?.trim()) {
      return {
        success: false,
        error: 'A reason is required to cancel a subscription',
      }
    }

    const orgId = gate.orgId

    const existing = await db.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Subscription not found' }
    }

    if (existing.status === 'canceled') {
      return {
        success: false,
        error: 'This subscription is already canceled',
      }
    }

    const now = new Date()

    const subscription = await db.subscriptions.update({
      where: { id: subscriptionId },
      data: {
        status: 'canceled',
        updatedAt: now,
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        agents: {
          select: { id: true, name: true },
        },
        pricing_plans: {
          select: { id: true, name: true, description: true },
        },
      },
    })

    await db.subscription_change_logs.create({
      data: {
        id: crypto.randomUUID(),
        subscriptionId,
        changedBy: gate.userId,
        changeType: 'status_change',
        previousValues: { status: existing.status } as Prisma.InputJsonValue,
        newValues: { status: 'canceled' } as Prisma.InputJsonValue,
        changeReason,
        createdAt: now,
        updatedAt: now,
      },
    })

    revalidatePath('/subscriptions')
    revalidatePath(`/subscriptions/${subscriptionId}`)

    return {
      success: true,
      data: mapSubscription(subscription),
    }
  } catch (error) {
    console.error('[cancelSubscription] Error:', error)
    return { success: false, error: 'Failed to cancel subscription' }
  }
}

/**
 * Fetch a single subscription with its related agent, customer, and plan
 * directly from Prisma. Used by the subscription detail page instead of
 * the NestJS API (which doesn't have a subscription-details endpoint and
 * would recalculate billing periods at runtime instead of returning the
 * stored values).
 */
export async function getSubscriptionDetail(subscriptionId: string) {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })
    if (!session?.session?.activeOrganizationId) {
      return { success: false as const, error: 'Not authenticated' }
    }
    const orgId = session.session.activeOrganizationId

    const sub = await db.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId: orgId },
      include: {
        agents: { select: { id: true, name: true, agentCode: true } },
        customers: {
          select: { id: true, name: true, externalId: true, email: true },
        },
        pricing_plans: {
          select: { id: true, name: true, description: true },
        },
      },
    })

    if (!sub) {
      return { success: false as const, error: 'Subscription not found' }
    }

    // Pull pricing strategies for this plan so the detail page can
    // show the pricing breakdown structure.
    const strategies = sub.pricing_plans
      ? await db.pricing_strategies.findMany({
          where: { planId: sub.pricing_plans.id, orgId, active: true },
          select: {
            id: true,
            name: true,
            chargeType: true,
            pricingModel: true,
            rate: true,
            tiers: true,
            signals: {
              select: { id: true, name: true, shortName: true },
            },
          },
        })
      : []

    return {
      success: true as const,
      data: {
        subscription: {
          id: sub.id,
          name: sub.name,
          status: sub.status,
          billingCycle: sub.billingCycle,
          startDate: sub.startDate?.toISOString() ?? '',
          endDate: sub.endDate?.toISOString() ?? null,
          currentBillingPeriodStart:
            sub.currentBillingPeriodStart?.toISOString() ?? '',
          currentBillingPeriodEnd:
            sub.currentBillingPeriodEnd?.toISOString() ?? '',
          seatsCount: sub.seatsCount,
        },
        agent: sub.agents
          ? {
              id: sub.agents.id,
              name: sub.agents.name,
              agentCode: sub.agents.agentCode,
            }
          : null,
        customer: sub.customers
          ? {
              id: sub.customers.id,
              name: sub.customers.name,
              externalId: sub.customers.externalId,
            }
          : null,
        plan: sub.pricing_plans
          ? {
              id: sub.pricing_plans.id,
              name: sub.pricing_plans.name,
              signalDetails: strategies.map((s) => ({
                id: s.id,
                name: s.name,
                shortName: s.signals?.shortName ?? s.name,
                pricingModel: s.pricingModel ?? 'flat',
                chargeType: s.chargeType,
              })),
            }
          : null,
      },
    }
  } catch (error) {
    console.error('[getSubscriptionDetail] Error:', error)
    return { success: false as const, error: 'Failed to load subscription' }
  }
}

export interface SubscriptionChangeLogEntry {
  id: string
  changeType: string
  previousValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  changeReason: string | null
  createdAt: string
  actor: { id: string; name: string } | null
}

/**
 * Read-only history for a subscription's change log.
 * updateSubscription and cancelSubscription write to
 * subscription_change_logs; this is the reader. No write path.
 */
export async function getSubscriptionChangeLogs(
  subscriptionId: string
): Promise<{
  success: boolean
  data?: SubscriptionChangeLogEntry[]
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

    // Org-scope check (same IDOR guard as getSubscription) before reading
    // its change history — subscription_change_logs has no organizationId
    // column of its own.
    const subscription = await db.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId: orgId },
      select: { id: true },
    })
    if (!subscription) {
      return { success: false, error: 'Subscription not found' }
    }

    const logs = await db.subscription_change_logs.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
      include: {
        users: { select: { id: true, name: true } },
      },
    })

    return {
      success: true,
      data: logs.map((log) => ({
        id: log.id,
        changeType: log.changeType,
        previousValues: (log.previousValues ?? null) as Record<
          string,
          unknown
        > | null,
        newValues: (log.newValues ?? null) as Record<string, unknown> | null,
        changeReason: log.changeReason,
        createdAt: log.createdAt.toISOString(),
        actor: log.users ? { id: log.users.id, name: log.users.name } : null,
      })),
    }
  } catch (error) {
    console.error('[getSubscriptionChangeLogs] Error:', error)
    return {
      success: false,
      error: 'Failed to load subscription change history',
    }
  }
}
