import apiClient, { formatUrl, getOrgId } from './client'

// Types
export interface Subscription {
  id: string
  customerId: string
  organizationId: string
  name: string
  status: 'active' | 'canceled' | 'expired' | 'pending'
  planId: string
  agentId: string
  startDate: string
  endDate?: string
  isForever: boolean
  billingCycle: 'monthly' | 'yearly' | 'custom'
  billingAmount?: number
  renewalDate?: string
  canceledAt?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

export interface PricingPlan {
  id: string
  name: string
  description?: string
  price: number
  billingCycle: 'monthly' | 'yearly' | 'custom'
}

export interface Agent {
  id: string
  name: string
}

export interface CreateSubscriptionPayload {
  name: string
  planId: string
  agentId: string
  customerId: string
  startDate: string
  endDate?: string
  isForever: boolean
  billingCycle: 'monthly' | 'yearly' | 'custom'
  billingAmount?: number
  seatsCount?: number
  metadata?: Record<string, any>
}

export interface UpdateSubscriptionPayload {
  name?: string
  planId?: string
  agentId?: string
  startDate?: string
  endDate?: string
  isForever?: boolean
  status?: 'active' | 'canceled' | 'expired' | 'pending'
  billingCycle?: 'monthly' | 'yearly' | 'custom'
  billingAmount?: number
  metadata?: Record<string, any>
}

export interface RenewSubscriptionPayload {
  renewalDate: string
  endDate?: string
  isForever?: boolean
  changeReason: string
}

export interface SubscriptionQueryParams {
  limit?: number
  page?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  status?: 'active' | 'canceled' | 'expired' | 'pending'
  planId?: string
  agentId?: string
  customerId?: string
  startDate?: string
  endDate?: string
  billingCycle?: 'monthly' | 'yearly' | 'custom'
  search?: string
  includeDetails?: boolean
}

export interface PaginatedResponse<T> {
  results: T[]
  total: number
  page: number
  limit: number
  totalPages: number
  totalResults?: number
  currentPage?: number
}

// API methods
export const subscriptionsApi = {
  // Get all subscriptions for an organization with filtering
  getSubscriptions: async (params?: SubscriptionQueryParams) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/subscriptions`, {})
    const response = await apiClient.get(url, { params })
    return response.data as PaginatedResponse<Subscription>
  },

  // Get subscription by ID
  getSubscription: async (
    subscriptionId: string,
    includeDetails?: boolean,
    customerId?: string
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(`/org/${orgId}/subscriptions/${subscriptionId}`, {})
    const response = await apiClient.get(url, {
      params: {
        includeDetails: includeDetails ? true : undefined,
        customerId,
      },
    })
    return response.data as Subscription
  },

  // Create a new subscription
  createSubscription: async (subscriptionData: CreateSubscriptionPayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/subscriptions`, {})
    const response = await apiClient.post(url, subscriptionData)
    return response.data as Subscription
  },

  // Update subscription
  updateSubscription: async (
    subscriptionId: string,
    subscriptionData: UpdateSubscriptionPayload,
    changeReason: string
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')
    if (!changeReason) throw new Error('Change reason is required')

    const url = formatUrl(`/org/${orgId}/subscriptions/${subscriptionId}`, {})
    const response = await apiClient.patch(url, {
      ...subscriptionData,
      changeReason,
    })
    return response.data as Subscription
  },

  // Renew subscription
  renewSubscription: async (
    subscriptionId: string,
    renewalData: RenewSubscriptionPayload
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(
      `/org/${orgId}/subscriptions/${subscriptionId}/renew`,
      {}
    )
    const response = await apiClient.post(url, renewalData)
    return response.data as Subscription
  },
}
