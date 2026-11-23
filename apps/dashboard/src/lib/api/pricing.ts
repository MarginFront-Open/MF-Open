// @ts-nocheck
// Deprecated: use Server Actions for new code.
import { API_ENDPOINTS } from '@/lib/api/config'
import apiClient from './client'
import { formatUrl, getOrgId } from './client'

// Pricing Plan types
export interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

export interface Signal {
  id: string
  name: string
  shortName: string
  // Matches the DB enum `enum_signals_type` (packages/db/prisma/schema.prisma).
  // DB value -> industry display mapping lives in
  // apps/dashboard/src/lib/signalTypeDisplay.ts:
  //   'volume' -> "Usage-Based" (every event billed)
  //   'usage'  -> "Outcome-Based" (billed only on result)
  type: 'volume' | 'usage'
}

export interface PricingStrategy {
  id?: string
  name: string
  agentId: string
  signalId?: string
  chargeType: 'onetime' | 'recurring' | 'usage' | 'seat_based'
  pricingModel?: 'flat' | 'volume' | 'graduated' | 'credit_pool'
  billingFrequency?: 'monthly' | 'yearly'
  tiers?: PricingTier[]
  rate?: number
  minimumCommitment?: number
  tags: string[]
  active: boolean
  signal?: Signal | null
}

export interface PricingPlan {
  id: string
  name: string
  description?: string
  featuresList?: { tags: string[] }
  agentId: string
  orgId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  agent?: {
    id: string
    name: string
    agentCode: string
  }
  pricingStrategies?: PricingStrategy[]
  // Live subscriptions on the plan. Filled by getPricingPlan only; see the
  // server action's PricingPlan for why (app/actions/pricing-plans.ts).
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
}

export interface CreatePricingPlanPayload {
  name: string
  description?: string
  featuresList?: { tags: string[] }
  agentId: string
  isActive: boolean
}

export interface CopyPricingPlanPayload {
  newName: string
  newDescription?: string
  discount: number
  requestedYearly: boolean
}

// Pricing Plans API functions
export const pricingPlansApi = {
  // Get list of pricing plans
  getPricingPlans: async (
    params: GetPricingPlansParams = {}
  ): Promise<PricingPlansResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.BASE, { orgId })

    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get a single pricing plan by ID
  getPricingPlan: async (
    planId: string,
    includeStrategies: boolean = true
  ): Promise<PricingPlan> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.DETAIL, { orgId, planId })

    const response = await apiClient.get(url, {
      params: { includeStrategies },
    })
    return response.data
  },

  // Get pricing plans for a specific agent
  getAgentPricingPlans: async (
    agentId: string,
    includeStrategies: boolean = true
  ): Promise<PricingPlansResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.BASE, { orgId })

    const response = await apiClient.get(url, {
      params: { agentId, includeStrategies },
    })
    return response.data
  },

  // Create a new pricing plan
  createPricingPlan: async (
    planData: CreatePricingPlanPayload
  ): Promise<PricingPlan> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.BASE, { orgId })

    const response = await apiClient.post(url, planData)
    return response.data
  },

  // Update an existing pricing plan
  updatePricingPlan: async (
    planId: string,
    planData: Partial<CreatePricingPlanPayload>
  ): Promise<PricingPlan> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.DETAIL, { orgId, planId })

    const response = await apiClient.patch(url, planData)
    return response.data
  },

  // Delete a pricing plan
  deletePricingPlan: async (planId: string): Promise<void> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.PRICING_PLANS.DETAIL, { orgId, planId })

    await apiClient.delete(url)
  },

  // Copy a pricing plan
  copyPricingPlan: async (
    planId: string,
    copyData: CopyPricingPlanPayload
  ): Promise<PricingPlan> => {
    const orgId = await getOrgId()
    const url = formatUrl(`${API_ENDPOINTS.PRICING_PLANS.DETAIL}/copy`, {
      orgId,
      planId,
    })

    const response = await apiClient.post(url, copyData)
    return response.data
  },
}

// Pricing Strategies API functions
export const pricingStrategiesApi = {
  // Get pricing strategies for a plan
  getPlanStrategies: async (planId: string): Promise<PricingStrategy[]> => {
    const orgId = await getOrgId()
    const url = formatUrl(
      `${API_ENDPOINTS.PRICING_PLANS.DETAIL}/pricing-strategies`,
      { orgId, planId }
    )

    const response = await apiClient.get(url)
    return response.data.results
  },

  // Add pricing strategies to a plan
  addPlanStrategies: async (
    planId: string,
    strategies: PricingStrategy[]
  ): Promise<PricingStrategy[]> => {
    const orgId = await getOrgId()
    const url = formatUrl(
      `${API_ENDPOINTS.PRICING_PLANS.DETAIL}/pricing-strategies`,
      { orgId, planId }
    )

    const response = await apiClient.post(url, { strategies })
    return response.data
  },

  // Update a pricing strategy
  updatePlanStrategy: async (
    planId: string,
    strategyId: string,
    strategyData: Partial<PricingStrategy>
  ): Promise<PricingStrategy> => {
    const orgId = await getOrgId()
    const url = formatUrl(
      `${API_ENDPOINTS.PRICING_PLANS.DETAIL}/pricing-strategies/${strategyId}`,
      { orgId, planId }
    )

    const response = await apiClient.put(url, strategyData)
    return response.data
  },

  // Bulk update pricing strategies - creates new ones and updates existing ones
  bulkUpdatePlanStrategies: async (
    planId: string,
    newStrategies: PricingStrategy[],
    updatedStrategies: Partial<PricingStrategy>[]
  ): Promise<{
    updated: { count: number; ids: string[]; strategies: PricingStrategy[] }
    created: { count: number; strategies: PricingStrategy[] }
  }> => {
    const orgId = await getOrgId()
    const url = formatUrl(
      `${API_ENDPOINTS.PRICING_PLANS.DETAIL}/pricing-strategies`,
      {
        orgId,
        planId,
      }
    )

    const payload = {
      strategies: {
        new: newStrategies,
        update: updatedStrategies,
      },
    }

    const response = await apiClient.patch(url, payload)
    return response.data.result
  },

  // Delete a pricing strategy
  deletePlanStrategy: async (
    planId: string,
    strategyId: string
  ): Promise<void> => {
    const orgId = await getOrgId()
    const url = formatUrl(
      `${API_ENDPOINTS.PRICING_PLANS.DETAIL}/pricing-strategies/${strategyId}`,
      { orgId, planId }
    )

    await apiClient.delete(url)
  },
}
