// @ts-nocheck
import apiClient, { formatUrl, getOrgId } from './client'

// Types
export interface Subscription {
  id: string
  name: string
  status: string
  billingCycle: string
  startDate: string
  endDate: string | null
  renewalDate: string
  plan: {
    id: string
    name: string
    description: string
  }
  agent: {
    id: string
    name: string
    agentCode: string
  }
  currentBillingPeriod: {
    start: string
    end: string
  }
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[]
  count: number
  page: number
  totalPages: number
}

export interface GetSubscriptionsParams {
  status?: 'active' | 'cancelled' | 'pending'
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface Invoice {
  id: string
  invoiceNumber: string
  status: string
  totalAmount: number
  subtotal: number
  taxAmount: number
  discountAmount: number
  invoiceDate: string
  dueDate: string
  billingPeriodStart: string
  billingPeriodEnd: string
  pdfPath: string
  subscription: {
    id: string
    name: string
  }
}

export interface InvoicesResponse {
  invoices: Invoice[]
  count: number
  page: number
  totalPages: number
}

export interface GetInvoicesParams {
  status?: 'pending' | 'paid' | 'overdue' | 'void'
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface EventType {
  name: string
  count: number
  percentage: number
}

export interface SubscriptionUsage {
  id: string
  name: string
  status: string
  billingCycle: string
  currentPeriodUsage: {
    totalCost: number
    breakdown: Array<{
      name: string
      amount: number
    }>
  }
}

// Usage analytics types
export interface SignalMetadata {
  id: string
  name: string
  shortName: string
}

export interface CustomerMetadata {
  id: string
  name: string
  externalId: string
}

export interface AgentMetadata {
  id: string
  name: string
  agentCode: string
}

export interface SignalBreakdown {
  signalId: string
  name: string
  eventCount: number
  quantity: number
  cost: number
}

export interface TimeSeriesData {
  date: string
  eventCount: number
  totalQuantity: number
  totalCost: number
  signalBreakdown: SignalBreakdown[]
}

export interface UsageSummary {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  filters: Record<string, any>
  summary: {
    totalEvents: number
    totalQuantity: number
    totalCost: number
  }
  metadata: {
    signals: SignalMetadata[]
    customers: CustomerMetadata[]
    agents: AgentMetadata[]
  }
  timeSeriesData: TimeSeriesData[]
  subscriptions?: SubscriptionUsage[]
}

export interface DailyUsageData {
  date: string
  eventCount: number
  totalQuantity: number
  totalCost: number
  signalBreakdown: SignalBreakdown[]
}

export interface DailyUsageResponse {
  dailyUsage: DailyUsageData[]
}

export interface GetUsageParams {
  startDate?: string
  endDate?: string
  eventType?: string
  agentId?: string
  groupBy?: 'day' | 'week' | 'month'
}

// API methods
export const customerTabsApi = {
  // Subscriptions Tab APIs
  getCustomerSubscriptions: async (
    customerId: string,
    params?: GetSubscriptionsParams
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')

    const url = formatUrl(
      `/org/${orgId}/subscriptions/customer/${customerId}`,
      {}
    )
    const response = await apiClient.get(url, { params })
    return response.data as SubscriptionsResponse
  },

  getSubscription: async (subscriptionId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(`/org/${orgId}/subscriptions/${subscriptionId}`, {})
    const response = await apiClient.get(url)
    return response.data as Subscription
  },

  getSubscriptionBillingStatus: async (subscriptionId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoice-calculator/billing-status/${subscriptionId}`,
      {}
    )
    const response = await apiClient.get(url)
    return response.data
  },

  // Invoices Tab APIs
  getCustomerInvoices: async (
    customerId: string,
    params?: GetInvoicesParams
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/customer/${customerId}`, {})
    const response = await apiClient.get(url, { params })
    return response.data as InvoicesResponse
  },

  getInvoiceDetails: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}`, {})
    const response = await apiClient.get(url)
    return response.data
  },

  getInvoicePdf: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/pdf`, {})
    const response = await apiClient.get(url)
    return response.data
  },

  payInvoice: async (
    invoiceId: string,
    paymentData: { paymentMethod: string; paymentMethodId: string }
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/pay`, {})
    const response = await apiClient.post(url, paymentData)
    return response.data
  },

  // Usage Tab APIs
  getCustomerUsageSummary: async (
    customerId: string,
    params?: {
      startDate?: string
      endDate?: string
      groupBy?: 'daily' | 'weekly' | 'monthly'
    }
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')

    const url = formatUrl(`/org/${orgId}/analytics/usage`, {})
    const response = await apiClient.get(url, {
      params: {
        ...params,
        customerId,
      },
    })
    return response.data as UsageSummary
  },

  getCustomerDailyUsage: async (
    customerId: string,
    params: Pick<
      GetUsageParams,
      'startDate' | 'endDate' | 'eventType' | 'agentId'
    >
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')
    if (!params.startDate || !params.endDate) {
      throw new Error('Start date and end date are required')
    }

    const url = formatUrl(`/org/${orgId}/analytics/usage`, {})
    const response = await apiClient.get(url, {
      params: {
        ...params,
        customerId,
        groupBy: 'daily',
      },
    })

    // Map the response to the shape callers read
    const usageSummary = response.data as UsageSummary
    return {
      dailyUsage: usageSummary.timeSeriesData.map((item) => ({
        date: item.date,
        events: item.signalBreakdown.reduce(
          (acc, signal) => {
            acc[signal.name] = signal.eventCount
            return acc
          },
          {} as Record<string, number>
        ),
        total: item.eventCount,
      })),
    } as DailyUsageResponse
  },

  getCustomerEventBreakdown: async (
    customerId: string,
    params: Omit<GetUsageParams, 'eventType'>
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')
    if (!params.startDate || !params.endDate) {
      throw new Error('Start date and end date are required')
    }

    const url = formatUrl(
      `/org/${orgId}/usage/customer/${customerId}/events`,
      {}
    )
    const response = await apiClient.get(url, { params })
    return response.data
  },
}
