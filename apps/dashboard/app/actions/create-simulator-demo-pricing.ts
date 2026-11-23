'use server'

import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// This action creates real pricing_plans, pricing_strategies
// and subscriptions — the SAME money tables locked in pricing-plans.ts and
// subscriptions.ts. Without this gate it would be a parallel, member-reachable
// door to writing the books. Gate on owner/admin/finance, same set as its siblings.
import { assertMoneyManager } from './_shared/assert-money-manager'

/**
 * Server Action: one-click demo pricing setup for the SDK Simulator.
 *
 * Creates (or reuses) a pricing plan named "Simulator Demo Plan", a
 * flat-rate usage strategy for the given signal, and an active
 * subscription linking the customer to the plan. All four writes
 * (plan / agent-plan junction / strategy / subscription) happen in a
 * single transaction so partial failures can't leave orphan rows.
 *
 * Idempotent — running twice for the same (agent, customer, signal) tuple
 * reuses whatever already exists. If the strategy exists but the rate
 * differs from the input, the rate is updated (edit-rate flow).
 *
 * Why this exists: without a plan+strategy+subscription chain, the
 * dashboard's analytics tile computes $0 revenue for simulator events
 * and shows -100% margin, which looks broken. This gives the user a
 * transparent one-click way to create real, editable pricing entities
 * so the simulator can demonstrate the full cost → revenue → margin
 * flow end-to-end.
 */

const DEMO_PLAN_NAME = 'Simulator Demo Plan'
const DEMO_STRATEGY_NAME = 'Simulator Demo Strategy'

export interface CreateSimulatorDemoPricingResult {
  success: boolean
  data?: {
    agentId: string
    customerId: string
    planId: string
    strategyId: string
    subscriptionId: string
  }
  error?: string
}

/**
 * Either `agentId` or `agentCode` must be present; same for customer.
 * When the ID is present we use it directly (dropdown-picked case).
 * When only the code/externalId is present we resolve-or-create by
 * natural key — the simulator's "fully-fresh combo" flow where the
 * user typed a brand-new agent code or customer external ID that
 * doesn't exist yet. Everything happens inside a single transaction
 * so a partial setup can't leave orphan rows.
 */
export async function createSimulatorDemoPricing(input: {
  agentId?: string
  agentCode?: string
  customerId?: string
  customerExternalId?: string
  signalName: string
  ratePerUnit: number
}): Promise<CreateSimulatorDemoPricingResult> {
  try {
    // Role gate FIRST: a plain member must not be able to seed real pricing
    // plans + subscriptions by calling this action directly. assertMoneyManager
    // checks the caller's role in their active org and returns the org id we
    // write to here.
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    if (!Number.isFinite(input.ratePerUnit) || input.ratePerUnit <= 0) {
      return { success: false, error: 'Rate per unit must be greater than 0' }
    }

    // At least one of (agentId, agentCode) and (customerId, customerExternalId)
    // must be present — otherwise there's nothing to resolve.
    const agentCode = input.agentCode?.trim() ?? ''
    const customerExternalId = input.customerExternalId?.trim() ?? ''
    if (!input.agentId && !agentCode) {
      return { success: false, error: 'Agent code or agent is required' }
    }
    if (!input.customerId && !customerExternalId) {
      return {
        success: false,
        error: 'Customer external ID or customer is required',
      }
    }

    const now = new Date()
    const oneMonthFromNow = new Date(now)
    oneMonthFromNow.setMonth(oneMonthFromNow.getMonth() + 1)

    const result = await db.$transaction(async (tx) => {
      // Step A: resolve-or-create the agent. When an ID is passed we
      // still re-verify org membership (cross-org sanity check against
      // session hijack). When only a code is passed we look up by the
      // natural key @@unique([agentCode, orgId]) and create if absent.
      let agentId: string
      if (input.agentId) {
        const existing = await tx.agents.findFirst({
          where: { id: input.agentId, orgId, deletedAt: null },
          select: { id: true },
        })
        if (!existing) {
          throw new Error('AGENT_NOT_FOUND')
        }
        agentId = existing.id
      } else {
        const existing = await tx.agents.findFirst({
          where: { agentCode, orgId, deletedAt: null },
          select: { id: true },
        })
        if (existing) {
          agentId = existing.id
        } else {
          const created = await tx.agents.create({
            data: {
              id: crypto.randomUUID(),
              orgId,
              agentCode,
              name: agentCode,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          })
          agentId = created.id
        }
      }

      // Step B: resolve-or-create the customer. Natural key is
      // @@unique([externalId, organizationId]). Same pattern.
      let customerId: string
      let customerName: string
      if (input.customerId) {
        const existing = await tx.customers.findFirst({
          where: {
            id: input.customerId,
            organizationId: orgId,
            deletedAt: null,
          },
          select: { id: true, name: true },
        })
        if (!existing) {
          throw new Error('CUSTOMER_NOT_FOUND')
        }
        customerId = existing.id
        customerName = existing.name
      } else {
        const existing = await tx.customers.findFirst({
          where: {
            externalId: customerExternalId,
            organizationId: orgId,
            deletedAt: null,
          },
          select: { id: true, name: true },
        })
        if (existing) {
          customerId = existing.id
          customerName = existing.name
        } else {
          const created = await tx.customers.create({
            data: {
              id: crypto.randomUUID(),
              organizationId: orgId,
              externalId: customerExternalId,
              name: customerExternalId,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, name: true },
          })
          customerId = created.id
          customerName = created.name
        }
      }

      // Step 0: find-or-create the signal. Mirrors the NestJS SDK ingestion
      // path (sdk.service.ts upserts on agentId_name) — a typed-but-never-sent
      // signal name is valid here; the DB row only has to exist
      // before we link a strategy to it.
      const signal = await tx.signals.upsert({
        where: {
          agentId_name: {
            agentId,
            name: input.signalName,
          },
        },
        update: {},
        create: {
          id: crypto.randomUUID(),
          orgId,
          agentId,
          name: input.signalName,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })

      // Step 1: find-or-create the "Simulator Demo Plan" for this agent
      let plan = await tx.pricing_plans.findFirst({
        where: {
          orgId,
          name: DEMO_PLAN_NAME,
          deletedAt: null,
          agent_pricing_plans: {
            some: { agentId },
          },
        },
        select: { id: true },
      })

      if (!plan) {
        // Plan may exist in the org but not yet linked to this agent.
        // Fall back to org-level lookup so we don't create duplicates.
        const orgLevelPlan = await tx.pricing_plans.findFirst({
          where: { orgId, name: DEMO_PLAN_NAME, deletedAt: null },
          select: { id: true },
        })

        if (orgLevelPlan) {
          plan = orgLevelPlan
        } else {
          const created = await tx.pricing_plans.create({
            data: {
              id: crypto.randomUUID(),
              orgId,
              name: DEMO_PLAN_NAME,
              description: 'Auto-created by SDK Simulator. Safe to delete.',
              featuresList: {
                autoCreatedBySimulator: true,
              } as Prisma.InputJsonValue,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          })
          plan = created
        }

        // Link plan to agent via junction (unique on [agentId, planId])
        await tx.agent_pricing_plans.upsert({
          where: {
            agentId_planId: {
              agentId,
              planId: plan.id,
            },
          },
          create: {
            agentId,
            planId: plan.id,
          },
          update: {},
        })
      }

      // Step 2: find-or-create strategy for this signal on the plan
      let strategy = await tx.pricing_strategies.findFirst({
        where: {
          planId: plan.id,
          signalId: signal.id,
          deletedAt: null,
        },
        select: { id: true, rate: true },
      })

      if (!strategy) {
        const created = await tx.pricing_strategies.create({
          data: {
            id: crypto.randomUUID(),
            name: DEMO_STRATEGY_NAME,
            orgId,
            agentId,
            planId: plan.id,
            signalId: signal.id,
            chargeType: 'usage',
            pricingModel: 'flat',
            billingFrequency: 'monthly',
            rate: new Prisma.Decimal(input.ratePerUnit),
            tags: ['auto-created-by-simulator'] as Prisma.InputJsonValue,
            active: true,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true, rate: true },
        })
        strategy = created
      } else {
        // Always re-sync the rate on an existing demo strategy so the
        // edit-rate flow works even when the stored rate already matches
        // a prior value. Idempotent when rates are equal.
        const updated = await tx.pricing_strategies.update({
          where: { id: strategy.id },
          data: {
            rate: new Prisma.Decimal(input.ratePerUnit),
            updatedAt: now,
          },
          select: { id: true, rate: true },
        })
        strategy = updated
      }

      // Step 3: find-or-create active subscription for this customer/agent/plan
      let subscription = await tx.subscriptions.findFirst({
        where: {
          organizationId: orgId,
          customerId,
          agentId,
          planId: plan.id,
          status: 'active',
          deletedAt: null,
        },
        select: { id: true },
      })

      if (!subscription) {
        const created = await tx.subscriptions.create({
          data: {
            id: crypto.randomUUID(),
            organizationId: orgId,
            customerId,
            planId: plan.id,
            agentId,
            name: `Simulator Demo: ${customerName ?? 'customer'}`,
            status: 'active',
            startDate: now,
            isForever: true,
            billingCycle: 'monthly',
            billingModel: 'usage',
            metadata: {
              autoCreatedBySimulator: true,
            } as Prisma.InputJsonValue,
            timezone: 'UTC',
            // Required non-null fields on the schema — set to +1 month so
            // the invoice scheduler never fires spuriously for demo rows
            nextRecurringInvoiceAt: oneMonthFromNow,
            nextUsageInvoiceAt: oneMonthFromNow,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        })
        subscription = created
      }

      return {
        agentId,
        customerId,
        planId: plan.id,
        strategyId: strategy.id,
        subscriptionId: subscription.id,
      }
    })

    // Pricing Plans and Subscriptions pages need to re-render so the
    // user can see the new rows immediately after confirming
    revalidatePath('/pricing-plans')
    revalidatePath(`/agents/${result.agentId}/pricing-plans`)
    revalidatePath(`/agents/${result.agentId}/pricing-plans/${result.planId}`)
    revalidatePath('/subscriptions')

    return { success: true, data: result }
  } catch (error) {
    console.error('[createSimulatorDemoPricing] Error:', error)
    if (error instanceof Error) {
      if (error.message === 'AGENT_NOT_FOUND') {
        return {
          success: false,
          error: 'Agent not found in this organization',
        }
      }
      if (error.message === 'CUSTOMER_NOT_FOUND') {
        return {
          success: false,
          error: 'Customer not found in this organization',
        }
      }
    }
    return { success: false, error: 'Failed to set up demo pricing' }
  }
}
