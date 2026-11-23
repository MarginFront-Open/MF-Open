'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Pricing plans + their strategies set what customers are charged —
// every create/update/delete/copy/link here is a money write. Gate on
// owner/admin/finance; reads (getPricingPlans/getPlanStrategies/...) stay open.
import { assertMoneyManager } from './_shared/assert-money-manager'
// The dashboard writes Prisma directly (it does NOT go through api-nest), so
// these four lanes are four of the eight places a credit pool can be born and
// must run the same shared rule. Server-only file, so value-import.
import {
  creditPoolErrorMessage,
  deriveCreditPool,
  isLivePoolStrategy,
  validateCreditPoolInput,
  validateCreditPoolTiers,
  validateCreditRatesReferences,
  validateSinglePoolPerPlan,
  type CreditPoolSugar,
  type PlanStrategyState,
} from '@marginfront/db'

// Types
export interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

export interface PricingStrategy {
  id: string
  name: string
  agentId: string
  planId: string
  signalId: string | null
  chargeType: 'onetime' | 'recurring' | 'usage' | 'seat_based'
  pricingModel: 'flat' | 'volume' | 'graduated' | 'credit_pool' | null
  billingFrequency: 'monthly' | 'yearly' | null
  tiers: PricingTier[] | null
  /**
   * The three-number view of a credit pool's tiers. Null on every non-pool
   * strategy AND on any pool whose stored tiers aren't a clean two-tier shape —
   * an honest null beats a fabricated pool that disagrees with the invoice.
   */
  creditPool: CreditPoolSugar | null
  /**
   * Per-metric burn rates: {signalId: creditsPerUnit}. Null or
   * absent = single-metric pool. Only ever set on credit_pool strategies.
   * Optional so fixtures and callers without it stay valid; reads always come
   * through mapPricingStrategy, which fills it.
   */
  creditRates?: Record<string, number> | null
  rate: number | null
  minimumCommitment: number | null
  tags: string[]
  active: boolean
  signal?: {
    id: string
    name: string
    shortName: string | null
    type?: string
  } | null
}

export interface PricingPlan {
  id: string
  name: string
  description: string | null
  featuresList: { tags: string[] } | null
  agentId: string | null
  orgId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  // Linked agents via junction table (many-to-many)
  agents?: {
    id: string
    name: string
    agentCode: string
  }[]
  pricingStrategies?: PricingStrategy[]
  /**
   * Live subscriptions sitting on this plan. Only getPricingPlan counts them;
   * the list lane leaves it 0 rather than paying for the count on every row.
   * Drives the mid-period caution in pricing-configure: a pricing
   * edit lands on the CURRENT period's bill, so a plan nobody is subscribed to
   * gets no warning and a plan with customers on it does.
   */
  activeSubscriptionCount?: number
}

export interface PricingPlansResponse {
  results: PricingPlan[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface GetPricingPlansParams {
  page?: number
  limit?: number
  agentId?: string
  includeStrategies?: boolean
  search?: string
}

export interface CreatePricingPlanPayload {
  name: string
  description?: string
  featuresList?: { tags: string[] }
  agentId?: string // Optional — plans are org-level, linked to agents via junction table
  isActive?: boolean
}

export interface UpdatePricingPlanPayload {
  name?: string
  description?: string
  featuresList?: { tags: string[] }
  isActive?: boolean
}

export interface CopyPricingPlanPayload {
  newName: string
  newDescription?: string
  discount?: number
  requestedYearly?: boolean
}

export interface CreatePricingStrategyPayload {
  name: string
  signalId?: string
  chargeType: 'onetime' | 'recurring' | 'usage' | 'seat_based'
  pricingModel?: 'flat' | 'volume' | 'graduated' | 'credit_pool'
  billingFrequency?: 'monthly' | 'yearly'
  tiers?: PricingTier[]
  /** Credit-pool shortcut; compiled into tiers server-side. Wins over `tiers`. */
  creditPool?: CreditPoolSugar
  /**
   * Per-metric burn rates: {signalId: creditsPerUnit}. {} clears;
   * null/omitted leaves stored rates alone. credit_pool strategies only.
   */
  creditRates?: Record<string, number> | null
  rate?: number
  minimumCommitment?: number
  tags?: string[]
  active?: boolean
}

export interface UpdatePricingStrategyPayload {
  name?: string
  signalId?: string
  chargeType?: 'onetime' | 'recurring' | 'usage' | 'seat_based'
  pricingModel?: 'flat' | 'volume' | 'graduated' | 'credit_pool'
  billingFrequency?: 'monthly' | 'yearly'
  tiers?: PricingTier[]
  /** Credit-pool shortcut; compiled into tiers server-side. Wins over `tiers`. */
  creditPool?: CreditPoolSugar
  /**
   * Per-metric burn rates: {signalId: creditsPerUnit}. {} clears;
   * null/omitted leaves stored rates alone. credit_pool strategies only.
   */
  creditRates?: Record<string, number> | null
  rate?: number
  minimumCommitment?: number
  tags?: string[]
  active?: boolean
}

/**
 * The dashboard twin of the api-nest credit-pool adapter. Returns
 * the tiers to store, or an error string — these actions return
 * {success:false, error} instead of throwing, so the shared rule's structured
 * result is translated here rather than in the shared module.
 */
type PoolCheck =
  | { ok: true; tiers: PricingTier[] | null }
  | { ok: false; error: string }

function checkCreditPool(
  merged: {
    pricingModel?: unknown
    tiers?: unknown
    creditPool?: unknown
    creditRates?: unknown
    minimumCommitment?: unknown
  },
  label?: string
): PoolCheck {
  const result = validateCreditPoolTiers({ ...merged, label })
  if (!result.ok) {
    return { ok: false, error: creditPoolErrorMessage(result) }
  }
  return { ok: true, tiers: result.compiledTiers }
}

/**
 * Rejects a payload carrying BOTH creditPool and tiers. Runs on the RAW payload,
 * before any merge: after merging, a sugar-only patch always has stored tiers
 * too, so this can only be asked of the payload as it arrived.
 */
function checkCreditPoolInput(
  patch: { creditPool?: unknown; tiers?: unknown },
  label?: string
): { ok: true } | { ok: false; error: string } {
  const result = validateCreditPoolInput(patch, label)
  return result.ok
    ? { ok: true }
    : { ok: false, error: creditPoolErrorMessage(result) }
}

/** `undefined` means "leave unchanged" on every lane. Pinned here, once. */
function mergeStrategyState(
  existing: {
    pricingModel?: unknown
    chargeType?: unknown
    tiers?: unknown
    minimumCommitment?: unknown
    active?: unknown
    creditRates?: unknown
  },
  patch: UpdatePricingStrategyPayload
) {
  return {
    pricingModel:
      patch.pricingModel !== undefined
        ? patch.pricingModel
        : existing.pricingModel,
    chargeType:
      patch.chargeType !== undefined ? patch.chargeType : existing.chargeType,
    // tiers and creditRates are the fields where null ALSO means "leave
    // unchanged" — see touchesCreditPoolFields. Everywhere else null is a
    // real value. (creditRates has a real clear spelling: `{}`.)
    tiers: patch.tiers != null ? patch.tiers : existing.tiers,
    creditRates:
      patch.creditRates != null ? patch.creditRates : existing.creditRates,
    minimumCommitment:
      patch.minimumCommitment !== undefined
        ? patch.minimumCommitment
        : existing.minimumCommitment,
    active: patch.active !== undefined ? patch.active : existing.active,
    creditPool: patch.creditPool,
  }
}

/**
 * The five fields whose arrival makes a write a credit-pool write. `tiers: null`
 * is NOT one — pinned on all eight lanes, null and undefined both mean "leave
 * the tiers alone" (and a null would throw on Prisma's Json? column anyway).
 * Same for creditRates: `{}` clears, null leaves.
 */
function touchesCreditPoolFields(patch: UpdatePricingStrategyPayload): boolean {
  return (
    patch.tiers != null ||
    patch.creditPool != null ||
    patch.creditRates != null ||
    patch.pricingModel !== undefined ||
    patch.minimumCommitment !== undefined
  )
}

/**
 * Plus the three that can flip a dormant pool back into contention. signalId
 * is one because re-pointing a live usage strategy onto a signal a
 * pool's creditRates name is a membership change too.
 */
function touchesPoolMembership(patch: UpdatePricingStrategyPayload): boolean {
  return (
    touchesCreditPoolFields(patch) ||
    patch.chargeType !== undefined ||
    patch.active !== undefined ||
    patch.signalId !== undefined
  )
}

/**
 * Rejects a write that would leave the plan with more live credit pools than it
 * started with. Queries only when the write could actually change that count.
 */
async function checkPlanPoolLimit(
  planId: string,
  mergedById: Map<string, PlanStrategyState>,
  createdRows: PlanStrategyState[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const changed = [...mergedById.values(), ...createdRows]
  if (!changed.some(isLivePoolStrategy)) return { ok: true }

  const siblings = (await db.pricing_strategies.findMany({
    where: { planId, deletedAt: null },
    select: {
      id: true,
      name: true,
      pricingModel: true,
      chargeType: true,
      active: true,
      deletedAt: true,
    },
  })) as PlanStrategyState[]

  const afterWrite = siblings
    .map((row) =>
      row.id && mergedById.has(row.id) ? mergedById.get(row.id)! : row
    )
    .concat(createdRows)

  const result = validateSinglePoolPerPlan(afterWrite, siblings)
  return result.ok
    ? { ok: true }
    : { ok: false, error: creditPoolErrorMessage(result) }
}

/** A patch/row actually carries rates (null, undefined, and {} all don't). */
function carriesRates(creditRates: unknown): boolean {
  return (
    creditRates != null &&
    typeof creditRates === 'object' &&
    !Array.isArray(creditRates) &&
    Object.keys(creditRates as object).length > 0
  )
}

/**
 * The dashboard twin of the api-nest assertCreditRatesRules.
 * `patchRates` are the maps THIS request writes (patch-carried only — stored
 * rates are exempt from the live-signal check so a since-deleted member
 * signal can't brick the pool's edits). The double-billing half runs against
 * the post-write plan state, so the back door — activating or re-pointing a
 * usage strategy onto a signal an existing pool's rates already name — gets
 * the same rejection as writing the rates themselves.
 */
async function checkCreditRatesRules(
  orgId: string,
  planId: string,
  patchRates: Array<{ creditRates?: unknown; label?: string }>,
  mergedById: Map<string, PlanStrategyState>,
  createdRows: PlanStrategyState[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ratedWrites = patchRates.filter((w) => carriesRates(w.creditRates))
  const changed = [...mergedById.values(), ...createdRows]
  const changesLiveUsage = changed.some(
    (row) =>
      row.chargeType === 'usage' &&
      row.active === true &&
      (row.deletedAt === null || row.deletedAt === undefined)
  )
  if (ratedWrites.length === 0 && !changesLiveUsage) return { ok: true }

  const keys = [
    ...new Set(
      ratedWrites.flatMap((w) => Object.keys(w.creditRates as object))
    ),
  ]
  const [signals, siblings] = await Promise.all([
    keys.length > 0
      ? db.signals.findMany({
          where: { id: { in: keys }, orgId, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
    db.pricing_strategies.findMany({
      where: { planId, deletedAt: null },
      select: {
        id: true,
        name: true,
        pricingModel: true,
        chargeType: true,
        active: true,
        deletedAt: true,
        signalId: true,
        creditRates: true,
      },
    }) as Promise<PlanStrategyState[]>,
  ])

  const afterWrite = siblings
    .map((row) =>
      row.id && mergedById.has(row.id) ? mergedById.get(row.id)! : row
    )
    .concat(createdRows)

  const result = validateCreditRatesReferences({
    writes: ratedWrites,
    orgLiveSignalIds: signals.map((s) => s.id),
    planStrategies: afterWrite,
  })
  return result.ok
    ? { ok: true }
    : { ok: false, error: creditPoolErrorMessage(result) }
}

// Helper to map Prisma pricing strategy to our type
const mapPricingStrategy = (strategy: any): PricingStrategy => ({
  id: strategy.id,
  name: strategy.name,
  agentId: strategy.agentId,
  planId: strategy.planId,
  signalId: strategy.signalId,
  chargeType: strategy.chargeType as PricingStrategy['chargeType'],
  pricingModel: strategy.pricingModel as PricingStrategy['pricingModel'],
  billingFrequency:
    strategy.billingFrequency as PricingStrategy['billingFrequency'],
  tiers: strategy.tiers as PricingTier[] | null,
  creditPool: deriveCreditPool(strategy.tiers),
  creditRates: (strategy.creditRates as Record<string, number> | null) ?? null,
  rate: strategy.rate ? Number(strategy.rate) : null,
  minimumCommitment: strategy.minimumCommitment
    ? Number(strategy.minimumCommitment)
    : null,
  tags: (strategy.tags as string[]) || [],
  active: strategy.active ?? true,
  signal: strategy.signals
    ? {
        id: strategy.signals.id,
        name: strategy.signals.name,
        shortName: strategy.signals.shortName,
        type: strategy.signals.type,
      }
    : null,
})

// Helper to map Prisma pricing plan to our type.
// Agents come from the junction table (agent_pricing_plans), not from the
// nullable pricing_plans.agentId FK, which is never written.
const mapPricingPlan = (plan: any, includeStrategies = false): PricingPlan => ({
  id: plan.id,
  name: plan.name,
  description: plan.description,
  featuresList: plan.featuresList as { tags: string[] } | null,
  agentId: plan.agentId ?? null,
  orgId: plan.orgId,
  isActive: plan.isActive ?? true,
  createdAt: plan.createdAt.toISOString(),
  updatedAt: plan.updatedAt.toISOString(),
  deletedAt: plan.deletedAt?.toISOString() ?? null,
  agents: plan.agent_pricing_plans
    ? plan.agent_pricing_plans.map((link: any) => ({
        id: link.agents.id,
        name: link.agents.name,
        agentCode: link.agents.agentCode,
      }))
    : plan.agents
      ? [
          {
            id: plan.agents.id,
            name: plan.agents.name,
            agentCode: plan.agents.agentCode,
          },
        ]
      : [],
  pricingStrategies:
    includeStrategies && plan.pricing_strategies
      ? plan.pricing_strategies
          .filter((s: any) => !s.deletedAt)
          .map(mapPricingStrategy)
      : undefined,
  activeSubscriptionCount: plan._count?.subscriptions ?? 0,
})

/**
 * Get pricing plans with pagination and filtering
 */
export async function getPricingPlans(
  params: GetPricingPlansParams = {}
): Promise<{
  success: boolean
  data?: PricingPlansResponse
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
      agentId,
      includeStrategies = true,
      search,
    } = params

    // Build where clause
    const where: Prisma.pricing_plansWhereInput = {
      orgId,
      deletedAt: null,
    }

    // Filter by agent through the junction table, not pricing_plans.agentId
    if (agentId) {
      where.agent_pricing_plans = { some: { agentId } }
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ]
    }

    // Get total count
    const total = await db.pricing_plans.count({ where })

    // Get pricing plans with linked agents from junction table
    const plans = await db.pricing_plans.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        agent_pricing_plans: {
          include: {
            agents: {
              select: { id: true, name: true, agentCode: true },
            },
          },
        },
        pricing_strategies: includeStrategies
          ? {
              where: { deletedAt: null },
              include: {
                signals: {
                  select: { id: true, name: true, shortName: true, type: true },
                },
              },
            }
          : false,
      },
    })

    const results = plans.map((plan) => mapPricingPlan(plan, includeStrategies))

    return {
      success: true,
      data: {
        results,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        totalResults: total,
      },
    }
  } catch (error) {
    console.error('[getPricingPlans] Error:', error)
    return { success: false, error: 'Failed to fetch pricing plans' }
  }
}

/**
 * Get pricing plans for a specific agent
 */
export async function getAgentPricingPlans(
  agentId: string,
  includeStrategies: boolean = true
): Promise<{
  success: boolean
  data?: PricingPlansResponse
  error?: string
}> {
  return getPricingPlans({ agentId, includeStrategies, limit: 100, page: 1 })
}

/**
 * Get a single pricing plan by ID
 */
export async function getPricingPlan(
  planId: string,
  includeStrategies: boolean = true
): Promise<{
  success: boolean
  data?: PricingPlan
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

    const plan = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            subscriptions: { where: { status: 'active', deletedAt: null } },
          },
        },
        agent_pricing_plans: {
          include: {
            agents: {
              select: { id: true, name: true, agentCode: true },
            },
          },
        },
        pricing_strategies: includeStrategies
          ? {
              where: { deletedAt: null },
              include: {
                signals: {
                  select: { id: true, name: true, shortName: true, type: true },
                },
              },
            }
          : false,
      },
    })

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    return {
      success: true,
      data: mapPricingPlan(plan, includeStrategies),
    }
  } catch (error) {
    console.error('[getPricingPlan] Error:', error)
    return { success: false, error: 'Failed to fetch pricing plan' }
  }
}

/**
 * Create a new pricing plan
 */
export async function createPricingPlan(
  data: CreatePricingPlanPayload
): Promise<{
  success: boolean
  data?: PricingPlan
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // If linking to an agent, verify the agent belongs to this org
    if (data.agentId) {
      const agent = await db.agents.findFirst({
        where: {
          id: data.agentId,
          orgId,
          deletedAt: null,
        },
      })

      if (!agent) {
        return { success: false, error: 'Agent not found' }
      }
    }

    const now = new Date()
    const planId = crypto.randomUUID()

    // Create the plan (org-level, no agentId on the plan itself) and
    // the junction entry in one transaction so they succeed or fail together
    const plan = await db.$transaction(async (tx) => {
      const created = await tx.pricing_plans.create({
        data: {
          id: planId,
          orgId,
          name: data.name,
          description: data.description,
          featuresList: data.featuresList as Prisma.InputJsonValue,
          isActive: data.isActive ?? true,
          createdAt: now,
          updatedAt: now,
        },
      })

      // Link to the agent if one was provided
      if (data.agentId) {
        await tx.agent_pricing_plans.create({
          data: {
            agentId: data.agentId,
            planId: created.id,
          },
        })
      }

      // Re-fetch with junction data for the response
      return tx.pricing_plans.findFirstOrThrow({
        where: { id: created.id },
        include: {
          agent_pricing_plans: {
            include: {
              agents: {
                select: { id: true, name: true, agentCode: true },
              },
            },
          },
        },
      })
    })

    revalidatePath('/pricing-plans')
    if (data.agentId) {
      revalidatePath(`/agents/${data.agentId}`)
    }

    return {
      success: true,
      data: mapPricingPlan(plan, false),
    }
  } catch (error) {
    console.error('[createPricingPlan] Error:', error)
    return { success: false, error: 'Failed to create pricing plan' }
  }
}

/**
 * Update a pricing plan
 */
export async function updatePricingPlan(
  planId: string,
  data: UpdatePricingPlanPayload
): Promise<{
  success: boolean
  data?: PricingPlan
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify plan belongs to org
    const existing = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Pricing plan not found' }
    }

    const plan = await db.pricing_plans.update({
      where: { id: planId },
      data: {
        name: data.name,
        description: data.description,
        featuresList: data.featuresList as Prisma.InputJsonValue,
        isActive: data.isActive,
        updatedAt: new Date(),
      },
      include: {
        agents: {
          select: { id: true, name: true, agentCode: true },
        },
        pricing_strategies: {
          where: { deletedAt: null },
          include: {
            signals: {
              select: { id: true, name: true, shortName: true, type: true },
            },
          },
        },
      },
    })

    revalidatePath('/pricing-plans')
    revalidatePath(`/pricing-plans/${planId}`)

    return {
      success: true,
      data: mapPricingPlan(plan, true),
    }
  } catch (error) {
    console.error('[updatePricingPlan] Error:', error)
    return { success: false, error: 'Failed to update pricing plan' }
  }
}

/**
 * Delete a pricing plan (soft delete)
 */
export async function deletePricingPlan(planId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify plan belongs to org, and grab linked agents for cache invalidation
    const existing = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
      include: {
        agent_pricing_plans: { select: { agentId: true } },
      },
    })

    if (!existing) {
      return { success: false, error: 'Pricing plan not found' }
    }

    // Check if plan has active subscriptions
    const activeSubscriptions = await db.subscriptions.count({
      where: {
        planId,
        deletedAt: null,
        status: { in: ['active', 'pending'] },
      },
    })

    if (activeSubscriptions > 0) {
      return {
        success: false,
        error: 'Cannot delete plan with active subscriptions',
      }
    }

    // Soft delete plan and its strategies
    const now = new Date()

    await db.$transaction([
      db.pricing_plans.update({
        where: { id: planId },
        data: { deletedAt: now },
      }),
      db.pricing_strategies.updateMany({
        where: { planId },
        data: { deletedAt: now },
      }),
    ])

    // Revalidate all linked agents so their plan lists update
    revalidatePath('/pricing-plans')
    for (const link of existing.agent_pricing_plans) {
      revalidatePath(`/agents/${link.agentId}`)
    }

    return { success: true }
  } catch (error) {
    console.error('[deletePricingPlan] Error:', error)
    return { success: false, error: 'Failed to delete pricing plan' }
  }
}

/**
 * Copy a pricing plan
 */
export async function copyPricingPlan(
  planId: string,
  data: CopyPricingPlanPayload
): Promise<{
  success: boolean
  data?: PricingPlan
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Get original plan with strategies and linked agents
    const original = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
      include: {
        pricing_strategies: {
          where: { deletedAt: null },
        },
        agent_pricing_plans: { select: { agentId: true } },
      },
    })

    if (!original) {
      return { success: false, error: 'Pricing plan not found' }
    }

    const now = new Date()
    const newPlanId = crypto.randomUUID()
    const discount = data.discount || 0

    // The discounted copies are built ONCE, here, so the rows that get
    // validated are byte-for-byte the rows that get written.
    const copies = original.pricing_strategies.map((strategy) => {
      const rate = strategy.rate ? Number(strategy.rate) : null
      const discountedRate = rate ? rate * (1 - discount / 100) : null

      let tiers = strategy.tiers as PricingTier[] | null
      if (tiers && discount > 0) {
        tiers = tiers.map((tier) => ({
          ...tier,
          // eslint-disable-next-line no-restricted-syntax -- discounting a stored tier rate when cloning a plan, not computing a price from quantity; calcRouted has no rate-transform operation
          rate: tier.rate * (1 - discount / 100),
        }))
      }

      const billingFrequency = data.requestedYearly
        ? 'yearly'
        : strategy.billingFrequency

      return {
        id: crypto.randomUUID(),
        orgId,
        agentId: strategy.agentId,
        planId: newPlanId,
        name: strategy.name,
        signalId: strategy.signalId,
        chargeType: strategy.chargeType,
        pricingModel: strategy.pricingModel,
        billingFrequency,
        tiers: tiers as unknown as Prisma.InputJsonValue,
        // Burn rates ride the copy untouched: they're CREDITS per unit, not
        // dollars, so the discount must never scale them. Conditional because
        // a literal null throws on Prisma's Json? column.
        ...(strategy.creditRates !== null
          ? { creditRates: strategy.creditRates as Prisma.InputJsonValue }
          : {}),
        rate: discountedRate,
        minimumCommitment: strategy.minimumCommitment,
        tags: strategy.tags as unknown as Prisma.InputJsonValue,
        active: true,
        createdAt: now,
        updatedAt: now,
      }
    })

    // The discount rewrite above rewrites every tier rate, including
    // a credit pool's flat pool fee, so a copy is a tier write. Without this check a
    // degenerate stored row would get a fresh twin.
    for (const copy of copies) {
      const check = checkCreditPool(
        {
          pricingModel: copy.pricingModel,
          tiers: copy.tiers,
          creditRates: (copy as { creditRates?: unknown }).creditRates,
          minimumCommitment: copy.minimumCommitment,
        },
        copy.name
      )
      if (!check.ok) return { success: false, error: check.error }
    }
    // Every copy lands ACTIVE on a brand-new plan: nothing to grandfather, and
    // a source whose second pool was merely inactive becomes two live pools.
    const copyPoolLimit = validateSinglePoolPerPlan(
      copies as PlanStrategyState[],
      []
    )
    if (!copyPoolLimit.ok) {
      return { success: false, error: creditPoolErrorMessage(copyPoolLimit) }
    }
    // Copied burn rates re-checked against today's signals — a
    // member signal deleted since the original write must not ride into a
    // fresh plan. The copies ARE the whole plan state for the pair rule.
    const copyRates = await checkCreditRatesRules(
      orgId,
      newPlanId,
      copies.map((copy) => ({
        creditRates: (copy as { creditRates?: unknown }).creditRates,
        label: copy.name,
      })),
      new Map(),
      copies as PlanStrategyState[]
    )
    if (!copyRates.ok) return { success: false, error: copyRates.error }

    // Create new plan (org-level, no agentId) + copy junction links + strategies
    await db.$transaction(async (tx) => {
      await tx.pricing_plans.create({
        data: {
          id: newPlanId,
          orgId,
          name: data.newName,
          description: data.newDescription || original.description,
          featuresList: original.featuresList as Prisma.InputJsonValue,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      })

      // Copy all agent links from the original plan to the new plan
      if (original.agent_pricing_plans.length > 0) {
        await tx.agent_pricing_plans.createMany({
          data: original.agent_pricing_plans.map((link) => ({
            agentId: link.agentId,
            planId: newPlanId,
          })),
        })
      }

      if (copies.length > 0) {
        await tx.pricing_strategies.createMany({ data: copies })
      }
    })

    // Fetch the complete new plan with junction data
    const result = await db.pricing_plans.findFirst({
      where: { id: newPlanId },
      include: {
        agent_pricing_plans: {
          include: {
            agents: {
              select: { id: true, name: true, agentCode: true },
            },
          },
        },
        pricing_strategies: {
          where: { deletedAt: null },
          include: {
            signals: {
              select: { id: true, name: true, shortName: true, type: true },
            },
          },
        },
      },
    })

    revalidatePath('/pricing-plans')
    for (const link of original.agent_pricing_plans) {
      revalidatePath(`/agents/${link.agentId}`)
    }

    return {
      success: true,
      data: result ? mapPricingPlan(result, true) : undefined,
    }
  } catch (error) {
    console.error('[copyPricingPlan] Error:', error)
    return { success: false, error: 'Failed to copy pricing plan' }
  }
}

/**
 * Get pricing strategies for a plan
 */
export async function getPlanStrategies(planId: string): Promise<{
  success: boolean
  data?: PricingStrategy[]
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

    // Verify plan belongs to org
    const plan = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    const strategies = await db.pricing_strategies.findMany({
      where: {
        planId,
        deletedAt: null,
      },
      include: {
        signals: {
          select: { id: true, name: true, shortName: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return {
      success: true,
      data: strategies.map(mapPricingStrategy),
    }
  } catch (error) {
    console.error('[getPlanStrategies] Error:', error)
    return { success: false, error: 'Failed to fetch pricing strategies' }
  }
}

/**
 * Add pricing strategies to a plan.
 * Strategies are per-agent (they reference agent-specific signals), so the
 * caller must specify which agent these strategies are for.
 */
export async function addPlanStrategies(
  planId: string,
  agentId: string,
  strategies: CreatePricingStrategyPayload[]
): Promise<{
  success: boolean
  data?: PricingStrategy[]
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify plan belongs to org
    const plan = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    // Check every incoming strategy before writing any of them.
    const compiledTiers = new Map<number, PricingTier[]>()
    for (const [index, strategy] of strategies.entries()) {
      const input = checkCreditPoolInput(strategy, strategy.name)
      if (!input.ok) return { success: false, error: input.error }
      const check = checkCreditPool(
        {
          pricingModel: strategy.pricingModel,
          tiers: strategy.tiers,
          creditPool: strategy.creditPool,
          creditRates: strategy.creditRates,
          minimumCommitment: strategy.minimumCommitment,
        },
        strategy.name
      )
      if (!check.ok) return { success: false, error: check.error }
      if (check.tiers) compiledTiers.set(index, check.tiers)
    }
    const incomingRows: PlanStrategyState[] = strategies.map((strategy) => ({
      name: strategy.name,
      pricingModel: strategy.pricingModel,
      chargeType: strategy.chargeType,
      active: strategy.active ?? true,
      deletedAt: null,
      signalId: strategy.signalId ?? null,
      creditRates: strategy.creditRates,
    }))
    const poolLimit = await checkPlanPoolLimit(planId, new Map(), incomingRows)
    if (!poolLimit.ok) return { success: false, error: poolLimit.error }
    const ratesCheck = await checkCreditRatesRules(
      orgId,
      planId,
      strategies.map((strategy) => ({
        creditRates: strategy.creditRates,
        label: strategy.name,
      })),
      new Map(),
      incomingRows
    )
    if (!ratesCheck.ok) return { success: false, error: ratesCheck.error }

    const now = new Date()
    const createdIds: string[] = []

    await db.pricing_strategies.createMany({
      data: strategies.map((strategy, index) => {
        const id = crypto.randomUUID()
        createdIds.push(id)
        const tiers = compiledTiers.get(index) ?? strategy.tiers
        return {
          id,
          orgId,
          agentId,
          planId,
          name: strategy.name,
          signalId: strategy.signalId,
          chargeType: strategy.chargeType as any,
          pricingModel: strategy.pricingModel as any,
          billingFrequency: strategy.billingFrequency as any,
          tiers: tiers as unknown as Prisma.InputJsonValue,
          ...(strategy.creditRates != null
            ? { creditRates: strategy.creditRates as Prisma.InputJsonValue }
            : {}),
          rate: strategy.rate,
          minimumCommitment: strategy.minimumCommitment,
          tags: (strategy.tags || []) as unknown as Prisma.InputJsonValue,
          active: strategy.active ?? true,
          createdAt: now,
          updatedAt: now,
        }
      }),
    })

    // Fetch created strategies
    const created = await db.pricing_strategies.findMany({
      where: { id: { in: createdIds } },
      include: {
        signals: {
          select: { id: true, name: true, shortName: true },
        },
      },
    })

    revalidatePath(`/pricing-plans/${planId}`)

    return {
      success: true,
      data: created.map(mapPricingStrategy),
    }
  } catch (error) {
    console.error('[addPlanStrategies] Error:', error)
    return { success: false, error: 'Failed to add pricing strategies' }
  }
}

/**
 * Update a pricing strategy
 */
export async function updatePlanStrategy(
  planId: string,
  strategyId: string,
  data: UpdatePricingStrategyPayload
): Promise<{
  success: boolean
  data?: PricingStrategy
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify strategy belongs to org and plan
    const existing = await db.pricing_strategies.findFirst({
      where: {
        id: strategyId,
        planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Pricing strategy not found' }
    }

    // Validate the MERGED state: a patch that only flips
    // pricingModel or only adds minimumCommitment breaks a pool while touching
    // nothing the patch alone would flag.
    const input = checkCreditPoolInput(data, existing.name)
    if (!input.ok) return { success: false, error: input.error }

    let compiledTiers: PricingTier[] | null = null
    if (touchesPoolMembership(data)) {
      const merged = mergeStrategyState(existing, data)
      if (touchesCreditPoolFields(data)) {
        const check = checkCreditPool(merged, existing.name)
        if (!check.ok) return { success: false, error: check.error }
        compiledTiers = check.tiers
      }
      const mergedRow: PlanStrategyState = {
        id: strategyId,
        name: existing.name,
        signalId:
          data.signalId !== undefined ? data.signalId : existing.signalId,
        ...merged,
      }
      const poolLimit = await checkPlanPoolLimit(
        planId,
        new Map([[strategyId, mergedRow]]),
        []
      )
      if (!poolLimit.ok) return { success: false, error: poolLimit.error }
      const ratesCheck = await checkCreditRatesRules(
        orgId,
        planId,
        data.creditRates != null
          ? [{ creditRates: data.creditRates, label: existing.name }]
          : [],
        new Map([[strategyId, mergedRow]]),
        []
      )
      if (!ratesCheck.ok) return { success: false, error: ratesCheck.error }
    }

    const nextTiers = compiledTiers ?? data.tiers

    const strategy = await db.pricing_strategies.update({
      where: { id: strategyId },
      data: {
        name: data.name,
        signalId: data.signalId,
        chargeType: data.chargeType as any,
        pricingModel: data.pricingModel as any,
        billingFrequency: data.billingFrequency as any,
        // null would reach the Json? column and throw; both null and undefined
        // mean "leave the tiers alone" on every lane. Same deal
        // for creditRates, whose real clear spelling is {}.
        tiers: (nextTiers ?? undefined) as unknown as Prisma.InputJsonValue,
        creditRates: (data.creditRates ??
          undefined) as unknown as Prisma.InputJsonValue,
        rate: data.rate,
        minimumCommitment: data.minimumCommitment,
        tags: data.tags as unknown as Prisma.InputJsonValue,
        active: data.active,
        updatedAt: new Date(),
      },
      include: {
        signals: {
          select: { id: true, name: true, shortName: true },
        },
      },
    })

    revalidatePath(`/pricing-plans/${planId}`)

    return {
      success: true,
      data: mapPricingStrategy(strategy),
    }
  } catch (error) {
    console.error('[updatePlanStrategy] Error:', error)
    return { success: false, error: 'Failed to update pricing strategy' }
  }
}

/**
 * Delete a pricing strategy (soft delete)
 */
export async function deletePlanStrategy(
  planId: string,
  strategyId: string
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify strategy belongs to org and plan
    const existing = await db.pricing_strategies.findFirst({
      where: {
        id: strategyId,
        planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Pricing strategy not found' }
    }

    await db.pricing_strategies.update({
      where: { id: strategyId },
      data: { deletedAt: new Date() },
    })

    revalidatePath(`/pricing-plans/${planId}`)

    return { success: true }
  } catch (error) {
    console.error('[deletePlanStrategy] Error:', error)
    return { success: false, error: 'Failed to delete pricing strategy' }
  }
}

/**
 * Bulk update pricing strategies - creates new ones and updates existing ones.
 * Strategies are per-agent, so agentId is required for creating new strategies.
 */
export async function bulkUpdatePlanStrategies(
  planId: string,
  agentId: string,
  newStrategies: CreatePricingStrategyPayload[],
  updatedStrategies: (UpdatePricingStrategyPayload & { id: string })[]
): Promise<{
  success: boolean
  data?: {
    created: PricingStrategy[]
    updated: PricingStrategy[]
  }
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify plan belongs to org
    const plan = await db.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId,
        deletedAt: null,
      },
    })

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    // Both branches are tier writes, so both are validated, and
    // BEFORE anything is written, so a bad row can't land half a batch.
    // The updates need their stored state to merge against; the ids are
    // already in hand, so one findMany covers it.
    const existingById = new Map<
      string,
      {
        name: string
        pricingModel: unknown
        chargeType: unknown
        tiers: unknown
        minimumCommitment: unknown
        active: unknown
        signalId: unknown
        creditRates: unknown
      }
    >()
    if (updatedStrategies.length > 0) {
      const rows = await db.pricing_strategies.findMany({
        where: {
          id: { in: updatedStrategies.map((s) => s.id) },
          planId,
          orgId,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          pricingModel: true,
          chargeType: true,
          tiers: true,
          minimumCommitment: true,
          active: true,
          signalId: true,
          creditRates: true,
        },
      })
      for (const row of rows) existingById.set(row.id, row)
    }

    const compiledNewTiers = new Map<number, PricingTier[]>()
    for (const [index, strategy] of newStrategies.entries()) {
      const input = checkCreditPoolInput(strategy, strategy.name)
      if (!input.ok) return { success: false, error: input.error }
      const check = checkCreditPool(
        {
          pricingModel: strategy.pricingModel,
          tiers: strategy.tiers,
          creditPool: strategy.creditPool,
          creditRates: strategy.creditRates,
          minimumCommitment: strategy.minimumCommitment,
        },
        strategy.name
      )
      if (!check.ok) return { success: false, error: check.error }
      if (check.tiers) compiledNewTiers.set(index, check.tiers)
    }

    const compiledUpdateTiers = new Map<string, PricingTier[]>()
    const mergedById = new Map<string, PlanStrategyState>()
    const patchRates: Array<{ creditRates?: unknown; label?: string }> = []
    for (const strategy of updatedStrategies) {
      const existing = existingById.get(strategy.id)
      const input = checkCreditPoolInput(strategy, existing?.name)
      if (!input.ok) return { success: false, error: input.error }
      if (strategy.creditRates != null) {
        patchRates.push({
          creditRates: strategy.creditRates,
          label: existing?.name,
        })
      }
      // An id the plan doesn't own falls through to the update below, which
      // fails loudly on its own — this lane only validates what it can see.
      if (!existing || !touchesPoolMembership(strategy)) continue
      const merged = mergeStrategyState(existing, strategy)
      if (touchesCreditPoolFields(strategy)) {
        const check = checkCreditPool(merged, existing.name)
        if (!check.ok) return { success: false, error: check.error }
        if (check.tiers) compiledUpdateTiers.set(strategy.id, check.tiers)
      }
      mergedById.set(strategy.id, {
        id: strategy.id,
        name: existing.name,
        signalId:
          strategy.signalId !== undefined
            ? strategy.signalId
            : existing.signalId,
        ...merged,
      })
    }

    const incomingRows: PlanStrategyState[] = newStrategies.map((strategy) => ({
      name: strategy.name,
      pricingModel: strategy.pricingModel,
      chargeType: strategy.chargeType,
      active: strategy.active ?? true,
      deletedAt: null,
      signalId: strategy.signalId ?? null,
      creditRates: strategy.creditRates,
    }))
    const poolLimit = await checkPlanPoolLimit(planId, mergedById, incomingRows)
    if (!poolLimit.ok) return { success: false, error: poolLimit.error }
    const ratesCheck = await checkCreditRatesRules(
      orgId,
      planId,
      [
        ...patchRates,
        ...newStrategies.map((strategy) => ({
          creditRates: strategy.creditRates,
          label: strategy.name,
        })),
      ],
      mergedById,
      incomingRows
    )
    if (!ratesCheck.ok) return { success: false, error: ratesCheck.error }

    const now = new Date()
    const createdIds: string[] = []
    const updatedIds: string[] = []

    // Create new strategies.
    // Prisma's createMany() rejects undefined fields; pass null or omit.

    if (newStrategies.length > 0) {
      await db.pricing_strategies.createMany({
        data: newStrategies.map((strategy, index) => {
          const id = crypto.randomUUID()
          createdIds.push(id)
          const tiers = compiledNewTiers.get(index) ?? strategy.tiers
          return {
            id,
            orgId,
            agentId,
            planId,
            name: strategy.name,
            signalId: strategy.signalId ?? null,
            chargeType: strategy.chargeType as any,
            pricingModel: (strategy.pricingModel as any) ?? null,
            billingFrequency: (strategy.billingFrequency as any) ?? null,
            tiers: tiers
              ? (tiers as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            creditRates:
              strategy.creditRates != null
                ? (strategy.creditRates as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            rate: strategy.rate ?? null,
            minimumCommitment: strategy.minimumCommitment ?? null,
            tags: (strategy.tags || []) as unknown as Prisma.InputJsonValue,
            active: strategy.active ?? true,
            createdAt: now,
            updatedAt: now,
          }
        }),
      })
    }

    // Update existing strategies
    // Only touch fields that were explicitly provided in the payload.
    // If a field is undefined it means "don't change this" — sending
    // undefined to Prisma would overwrite the existing value with null,
    // which silently erases prices and tiers.
    for (const strategy of updatedStrategies) {
      const updateData: Record<string, unknown> = { updatedAt: now }

      if (strategy.name !== undefined) updateData.name = strategy.name
      if (strategy.signalId !== undefined)
        updateData.signalId = strategy.signalId
      if (strategy.chargeType !== undefined)
        updateData.chargeType = strategy.chargeType as any
      if (strategy.pricingModel !== undefined)
        updateData.pricingModel = strategy.pricingModel as any
      if (strategy.billingFrequency !== undefined)
        updateData.billingFrequency = strategy.billingFrequency as any
      // null would reach the Json? column and throw; both null and undefined
      // mean "leave the tiers alone" on every lane. A compiled
      // creditPool wins over raw tiers, same as everywhere else.
      const nextTiers = compiledUpdateTiers.get(strategy.id) ?? strategy.tiers
      if (nextTiers !== undefined && nextTiers !== null)
        updateData.tiers = nextTiers as unknown as Prisma.InputJsonValue
      if (strategy.creditRates !== undefined && strategy.creditRates !== null)
        updateData.creditRates = strategy.creditRates as Prisma.InputJsonValue
      if (strategy.rate !== undefined) updateData.rate = strategy.rate
      if (strategy.minimumCommitment !== undefined)
        updateData.minimumCommitment = strategy.minimumCommitment
      if (strategy.tags !== undefined)
        updateData.tags = strategy.tags as unknown as Prisma.InputJsonValue
      if (strategy.active !== undefined) updateData.active = strategy.active

      await db.pricing_strategies.update({
        where: { id: strategy.id },
        data: updateData,
      })
      updatedIds.push(strategy.id)
    }

    // Fetch all affected strategies
    const allIds = [...createdIds, ...updatedIds]
    const strategies = await db.pricing_strategies.findMany({
      where: { id: { in: allIds } },
      include: {
        signals: {
          select: { id: true, name: true, shortName: true },
        },
      },
    })

    const mappedStrategies = strategies.map(mapPricingStrategy)

    revalidatePath(`/pricing-plans/${planId}`)

    return {
      success: true,
      data: {
        created: mappedStrategies.filter((s) => createdIds.includes(s.id)),
        updated: mappedStrategies.filter((s) => updatedIds.includes(s.id)),
      },
    }
  } catch (error) {
    console.error('[bulkUpdatePlanStrategies] Error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: `Failed to bulk update pricing strategies: ${message}`,
    }
  }
}

/**
 * Link an existing pricing plan to an agent.
 * This is the "use an existing plan" flow — the plan already exists,
 * and the link says "this agent also offers this plan."
 */
export async function linkPlanToAgent(
  planId: string,
  agentId: string
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify both the plan and agent belong to this org
    const [plan, agent] = await Promise.all([
      db.pricing_plans.findFirst({
        where: { id: planId, orgId, deletedAt: null },
      }),
      db.agents.findFirst({
        where: { id: agentId, orgId, deletedAt: null },
      }),
    ])

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }
    if (!agent) {
      return { success: false, error: 'Agent not found' }
    }

    // Check if already linked (the unique constraint would catch this too,
    // but a clear error message is better than a database error)
    const existing = await db.agent_pricing_plans.findFirst({
      where: { planId, agentId },
    })

    if (existing) {
      return { success: false, error: 'Plan is already linked to this agent' }
    }

    await db.agent_pricing_plans.create({
      data: { planId, agentId },
    })

    revalidatePath('/pricing-plans')
    revalidatePath(`/agents/${agentId}`)

    return { success: true }
  } catch (error) {
    console.error('[linkPlanToAgent] Error:', error)
    return { success: false, error: 'Failed to link plan to agent' }
  }
}

/**
 * Unlink a pricing plan from an agent.
 * The plan still exists; this agent stops offering it.
 * Refuses to unlink if there are active subscriptions using this plan+agent combo.
 */
export async function unlinkPlanFromAgent(
  planId: string,
  agentId: string
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify the plan belongs to this org
    const plan = await db.pricing_plans.findFirst({
      where: { id: planId, orgId, deletedAt: null },
    })

    if (!plan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    // Check for active subscriptions using this plan+agent combination —
    // can't pull the rug out from under paying customers
    const activeSubscriptions = await db.subscriptions.count({
      where: {
        planId,
        agentId,
        deletedAt: null,
        status: { in: ['active', 'pending'] },
      },
    })

    if (activeSubscriptions > 0) {
      return {
        success: false,
        error: `Cannot unlink: ${activeSubscriptions} active subscription${activeSubscriptions > 1 ? 's' : ''} use this plan with this agent`,
      }
    }

    // Delete the junction entry
    await db.agent_pricing_plans.deleteMany({
      where: { planId, agentId },
    })

    revalidatePath('/pricing-plans')
    revalidatePath(`/agents/${agentId}`)

    return { success: true }
  } catch (error) {
    console.error('[unlinkPlanFromAgent] Error:', error)
    return { success: false, error: 'Failed to unlink plan from agent' }
  }
}
