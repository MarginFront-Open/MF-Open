/**
 * Filters Service
 * Provides filters data for various entities like agents, customers, pricing plans, and signals
 */
import { useQuery } from '@tanstack/react-query'
import { getFilters as getFiltersAction } from '@/app/actions/get-filters'

// Query Keys
export const FILTERS_KEYS = {
  all: ['filters'] as const,
}

// Types
export interface Agent {
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
  email: string | null
  externalId?: string | null
  status?: string
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
  }
}

export interface Signal {
  id: string
  name: string
  shortName: string
  type?: 'volume' | 'usage' | null
}

export interface Subscription {
  id: string
  name: string
  status: 'active' | 'canceled' | 'expired' | 'pending'
  planId: string
  agentId: string
  startDate: string
  endDate?: string
  billingCycle: 'monthly' | 'yearly' | 'custom'
  // GenerateInvoiceDialog reads this to filter
  // usage/hybrid-billable subscriptions. Without the field, the dialog's
  // subscription dropdown stays disabled.
  billingModel: 'subscription' | 'usage' | 'hybrid'
  customerId: string
}

export interface FiltersResponse {
  agents: Agent[]
  customers: CustomerBasic[]
  pricingPlans: PricingPlan[]
  signals: Signal[]
  subscriptions: Subscription[]
}

/**
 * Hook to fetch all filters via Server Action
 */
export const useFilters = () => {
  return useQuery({
    queryKey: FILTERS_KEYS.all,
    queryFn: async () => {
      const result = await getFiltersAction()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch filters')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}
