// @ts-nocheck
// Prefer Server Actions over these REST helpers.
import { API_ENDPOINTS } from '@/lib/api/config'
import apiClient from './client'
import { formatUrl, getOrgId } from './client'

// Base entity types
export interface Agent {
  id: string
  name: string
  description: string
  agentCode: string
  isActive: boolean
  pricingPlans?: PricingPlan[]
}

export interface Customer {
  id: string
  name: string
  email: string
  externalId: string
  status: string
}

export interface PricingPlan {
  id: string
  name: string
  description: string
  featuresList?: Record<string, any>
  isActive: boolean
}

export interface Signal {
  id: string
  name: string
  shortName: string
  type: string
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
}

// Filter response types
export interface FiltersResponse {
  agents?: Agent[]
  customers?: Customer[]
  pricingPlans?: PricingPlan[]
  signals?: Signal[]
  subscriptions?: Subscription[]
  errors?: Record<string, string>
}

// Filter params type with flexible options
export interface FilterParams {
  dataTypes?: Array<
    'agents' | 'customers' | 'pricingPlans' | 'signals' | 'subscriptions'
  >
  agentId?: string
  customerId?: string
  sortBy?: string
  limit?: number
  page?: number
}

// Filters API functions
export const filtersApi = {
  /**
   * Get filtered data for an organization
   *
   * @param params - Filter parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with filtered data
   */
  getFilters: async (
    params: FilterParams = {},
    customOrgId?: string
  ): Promise<FiltersResponse> => {
    const orgId = customOrgId || getOrgId()
    const url = formatUrl(API_ENDPOINTS.FILTERS.BASE, { orgId })

    // Transform dataTypes array to query params format if needed
    const queryParams: Record<string, any> = { ...params }

    // Handle array parameters like dataTypes
    if (params.dataTypes && params.dataTypes.length > 0) {
      // Remove the original dataTypes to replace with the proper format
      delete queryParams.dataTypes

      // Add each dataType as a separate query parameter
      params.dataTypes.forEach((type, index) => {
        queryParams[`dataTypes[${index}]`] = type
      })
    }

    const response = await apiClient.get(url, { params: queryParams })
    return response.data
  },

  /**
   * Get only agent data
   *
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with agents data
   */
  getAgents: async (
    params: Omit<FilterParams, 'dataTypes'> = {},
    customOrgId?: string
  ): Promise<Agent[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['agents'] },
      customOrgId
    )
    return response.agents || []
  },

  /**
   * Get only customer data
   *
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with customers data
   */
  getCustomers: async (
    params: Omit<FilterParams, 'dataTypes'> = {},
    customOrgId?: string
  ): Promise<Customer[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['customers'] },
      customOrgId
    )
    return response.customers || []
  },

  /**
   * Get only pricing plan data
   *
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with pricing plans data
   */
  getPricingPlans: async (
    params: Omit<FilterParams, 'dataTypes'> = {},
    customOrgId?: string
  ): Promise<PricingPlan[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['pricingPlans'] },
      customOrgId
    )
    return response.pricingPlans || []
  },

  /**
   * Get only signal data
   *
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with signals data
   */
  getSignals: async (
    params: Omit<FilterParams, 'dataTypes'> = {},
    customOrgId?: string
  ): Promise<Signal[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['signals'] },
      customOrgId
    )
    return response.signals || []
  },

  /**
   * Get only subscription data
   *
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with subscriptions data
   */
  getSubscriptions: async (
    params: Omit<FilterParams, 'dataTypes'> = {},
    customOrgId?: string
  ): Promise<Subscription[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['subscriptions'] },
      customOrgId
    )
    return response.subscriptions || []
  },

  /**
   * Get customers for a specific agent
   *
   * @param agentId - Agent ID to filter customers by
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with customers data
   */
  getCustomersByAgent: async (
    agentId: string,
    params: Omit<FilterParams, 'dataTypes' | 'agentId'> = {},
    customOrgId?: string
  ): Promise<Customer[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['customers'], agentId },
      customOrgId
    )
    return response.customers || []
  },

  /**
   * Get signals for a specific agent
   *
   * @param agentId - Agent ID to filter signals by
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with signals data
   */
  getSignalsByAgent: async (
    agentId: string,
    params: Omit<FilterParams, 'dataTypes' | 'agentId'> = {},
    customOrgId?: string
  ): Promise<Signal[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['signals'], agentId },
      customOrgId
    )
    return response.signals || []
  },

  /**
   * Get agents for a specific customer
   *
   * @param customerId - Customer ID to filter agents by
   * @param params - Optional additional parameters
   * @param customOrgId - Optional organization ID override
   * @returns Promise with agents data
   */
  getAgentsByCustomer: async (
    customerId: string,
    params: Omit<FilterParams, 'dataTypes' | 'customerId'> = {},
    customOrgId?: string
  ): Promise<Agent[]> => {
    const response = await filtersApi.getFilters(
      { ...params, dataTypes: ['agents'], customerId },
      customOrgId
    )
    return response.agents || []
  },
}
