// @ts-nocheck
// Deprecated: use Server Actions for new code.
import { API_ENDPOINTS } from '@/lib/api/config'
import apiClient, { formatUrl, getOrgId } from './client'

// Types for Cost Analytics
export interface CostAnalyticsParams {
  // Required parameters
  startDate: string
  endDate: string

  // Optional parameters
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  agentId?: string
  signalId?: string
  includeServiceBreakdown?: boolean
  breakdownBy?: 'signal' | 'agent' | 'customer'
  includeAllDimensions?: boolean
}

export interface CostBreakdown {
  serviceName: string
  provider: string
  cost: number
  percentage: number
}

export interface CostTimeSeries {
  date: string
  totalCost: number
  breakdown: Record<string, number> // service name -> cost
}

export interface DimensionData {
  dimensionType: 'signal' | 'agent' | 'customer'
  summary: Array<{
    id: string
    name: string
    totalCost: number
    totalQuantity?: number
    eventCount: number
    percentage: number
    avgCostPerEvent: number
    avgCostPerUnit?: number
    topServices: Array<{
      serviceName: string
      cost: number
      units: number
      percentage: number
    }>
  }>
  timeline: Array<{
    date: string
    items: Array<{
      id: string
      name: string
      cost: number
      events: number
      avgCostPerEvent: number
    }>
  }>
}

export interface CostAnalyticsResponse {
  // Date range information
  dateRange: {
    start: string
    end: string
    groupBy: string
    totalDays: number
    uniquePeriods: number
  }

  // Applied filters
  filters: {
    customerId: string | null
    agentId: string | null
    signalId: string | null
    breakdownBy: string | null
    organizationId: string | null
  }

  // Basic stats
  stats: {
    totalCost: number
    totalEvents: number
    avgCostPerEvent: number
  }

  // Detailed cost summary and metrics
  costSummary: {
    overall: {
      avgCostPerEvent: number
      avgDailyCost: number
      avgPeriodCost: number
      totalCost: number
      totalEvents: number
      periodOverPeriodGrowth: number
      eventGrowthRate: number
      standardDeviation: number
      volatility: 'low' | 'medium' | 'high'
      trend: {
        direction: 'increasing' | 'decreasing' | 'stable'
        slope: number
      }
    }

    services: {
      highest: {
        name: string
        cost: number
        units: number
      }
      mostExpensivePerUnit: {
        name: string
        costPerUnit: number
      }
      topByAvgCost: Array<{
        serviceName: string
        avgCost: number
        totalCost: number
        eventCount: number
        volatility: 'low' | 'medium' | 'high'
        costPerUnit: number
      }>
    }

    providers: {
      highest: {
        name: string
        cost: number
        units: number
      }
    }

    unitTypes: {
      highest: {
        name: string
        cost: number
        units: number
      }
    }

    runRate: {
      monthly: number
      quarterly: number
      annual: number
      dailyAverage: number
      daysInPeriod: number
    }
  }

  // Time series data for charts
  timeSeriesData: Array<{
    date: string
    totalCost: number
    eventCount: number
    avgCostPerEvent: number
  }>

  // Service breakdown
  serviceBreakdown?: {
    summary: Array<{
      serviceName: string
      totalCost: number
      totalUnits: number
      percentage: number
      avgCostPerEvent: number
      volatility: 'low' | 'medium' | 'high'
      topProviders: Array<{
        name: string
        cost: number
        units: number
      }>
    }>

    timeline: Array<{
      date: string
      services: Record<
        string,
        {
          cost: number
          units: number
        }
      >
    }>
  }

  // Dimension breakdown
  dimensionBreakdown?: DimensionData

  // All dimensions data when includeAllDimensions is true
  dimensions?: {
    signal?: DimensionData
    agent?: DimensionData
    customer?: DimensionData
  }

  // Reference metadata
  metadata?: {
    signals?: Array<{
      id: string
      name: string
      shortName: string
    }>
    services?: Array<{
      name: string
      providers: string[]
      unitType: string
    }>
    customers?: Array<{
      id: string
      name: string
      externalId: string
    }>
    agents?: Array<{
      id: string
      name: string
      agentCode: string
    }>
  }
}

// Subscription Analytics Types
export interface SubscriptionDetailsParams {
  billingPeriodStart?: string
  billingPeriodEnd?: string
}

export interface SubscriptionAnalyticsResponse {
  subscription: {
    id: string
    name: string
    status: string
    billingCycle: string
    startDate: string
    endDate: string | null
    currentBillingPeriodStart: string
    currentBillingPeriodEnd: string
  }
  agent: {
    id: string
    name: string
    agentCode: string
  }
  customer: {
    id: string
    name: string
    externalId: string
  }
  plan: {
    id: string
    name: string
    signalDetails: Array<{
      id: string
      name: string
      shortName: string
      pricingModel: string
      chargeType: string
    }>
  }
  billingPeriod: {
    start: string
    end: string
  }
  summary: {
    totalRevenue: number
    totalCost: number
    totalMargin: number
    totalCustomerValue: number
  }
  costBreakdown?: {
    byService: Array<{
      serviceName: string
      cost: number
      units: number
      costPerUnit: number
    }>
    byProvider: Array<{
      providerName: string
      cost: number
      units: number
    }>
    byUnitType: Array<{
      unitType: string
      cost: number
      units: number
    }>
    avgCostPerEvent?: number
    avgDailyCost?: number
    totalEvents?: number
    costTrend?: 'increasing' | 'decreasing' | 'stable'
    highestService?: {
      name: string
      cost: number
      units: number
    }
    highestProvider?: {
      name: string
      cost: number
      units: number
    }
    highestUnitType?: {
      name: string
      cost: number
      units: number
    }
    highestCostPerUnitService?: {
      name: string
      costPerUnit: number
    }
    serviceAvgCosts?: Array<{
      serviceName: string
      avgCost: number
      totalCost: number
      eventCount: number
    }>
  }
  pricingBreakdown: Array<{
    description: string
    quantity: number
    unitPrice: number
    effectiveUnitPrice: number
    amount: number
    usageCost: number
    pricingStrategyId: string
    pricingStrategyName: string
    chargeType: string
    pricingModel: string | null
    minimumCommitment: number | null
    tiersUsed: Array<{
      lower: number
      upper: number | null
      rate: number
      quantity: number
      subtotal: number
    }>
  }>
  signalSummary: Array<{
    signalId: string
    signalName: string
    totalQuantity: number
    totalCost: number
    totalRevenue: number
    totalMargin: number
    totalCustomerValue: number
    unitPrice: number
    costBreakdown?: {
      byService: Array<{
        serviceName: string
        cost: number
        units: number
        costPerUnit: number
      }>
      byProvider: Array<{
        providerName: string
        cost: number
        units: number
      }>
      byUnitType: Array<{
        unitType: string
        cost: number
        units: number
      }>
    }
  }>
  dailyBreakdown: Array<{
    date: string
    signalId: string
    signalName: string
    quantity: number
    cost: number
    revenue: number
    margin: number
    price: number
    customerValue: number
    costBreakdown?: {
      byService: Array<{
        serviceName: string
        cost: number
        units: number
        costPerUnit: number
      }>
      byProvider: Array<{
        providerName: string
        cost: number
        units: number
      }>
      byUnitType: Array<{
        unitType: string
        cost: number
        units: number
      }>
    }
  }>
  dateBreakdowns?: Array<{
    date: string
    signalBreakdown: Array<{
      signalId: string
      signalName: string
      quantity: number
      cost: number
      revenue: number
      margin: number
    }>
    costBreakdown?: {
      byService: Array<{
        serviceName: string
        cost: number
        units: number
        costPerUnit: number
      }>
      byProvider: Array<{
        providerName: string
        cost: number
        units: number
      }>
      byUnitType: Array<{
        unitType: string
        cost: number
        units: number
      }>
    }
  }>
}

// Usage Analytics Types
export interface UsageAnalyticsParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  agentId?: string
  signalId?: string
}

export interface UsageAnalyticsResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalEvents: number
    avgEventsPerDay: number
  }
  timeSeriesData: Array<{
    date: string
    totalEvents: number
    signalBreakdown?: Record<string, number>
  }>
}

// Agent Analytics Types
export interface AgentAnalyticsParams {
  agentId: string
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
}

export interface AgentAnalyticsResponse {
  agent: {
    id: string
    name: string
    agentCode: string
  }
  stats: {
    totalRevenue: number
    totalCustomers: number
    totalSubscriptions: number
  }
  performanceMetrics: Array<{
    date: string
    revenue: number
    customers: number
  }>
}

// Revenue Analytics Types
export interface RevenueAnalyticsParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  agentId?: string
}

export interface RevenueAnalyticsResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalRevenue: number
    mrr: number
    arr: number
    avgRevenuePerCustomer: number
  }
  timeSeriesData: Array<{
    date: string
    revenue: number
    mrr?: number
  }>
  breakdown: {
    byAgent?: Array<{
      agentId: string
      agentName: string
      revenue: number
      percentage: number
    }>
    byCustomer?: Array<{
      customerId: string
      customerName: string
      revenue: number
      percentage: number
    }>
  }
}

// Profitability Analytics Types
export interface ProfitabilityAnalyticsParams {
  startDate: string
  endDate: string
  customerId?: string
  agentId?: string
}

export interface ProfitabilityAnalyticsResponse {
  dateRange: {
    start: string
    end: string
  }
  stats: {
    totalRevenue: number
    totalCost: number
    totalProfit: number
    profitMargin: number
  }
  breakdown: {
    bySignal: Array<{
      signalId: string
      signalName: string
      revenue: number
      cost: number
      profit: number
      margin: number
    }>
  }
}

// Event Aggregation Types
export interface EventAggregationParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  customerExternalId?: string
  agentId?: string
  signalId?: string
  dimension?: string
}

export interface EventAggregationResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalEvents: number
    uniqueDimensions: number
  }
  aggregatedData: Array<{
    date: string
    totalEvents: number
    dimensions?: Record<string, number>
  }>
}

// Analytics API
export const analyticsApi = {
  // Get usage analytics
  getUsageAnalytics: async (
    params: UsageAnalyticsParams
  ): Promise<UsageAnalyticsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.USAGE, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get cost analytics
  getCostAnalytics: async (
    params: CostAnalyticsParams
  ): Promise<CostAnalyticsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.COSTS, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get subscription analytics details
  getSubscriptionAnalytics: async (
    subscriptionId: string,
    params?: SubscriptionDetailsParams
  ): Promise<SubscriptionAnalyticsResponse> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(API_ENDPOINTS.ANALYTICS.SUBSCRIPTION, {
      orgId,
      subscriptionId,
    })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get agent analytics
  getAgentAnalytics: async (
    params: AgentAnalyticsParams
  ): Promise<AgentAnalyticsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.AGENT, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get revenue analytics
  getRevenueAnalytics: async (
    params: RevenueAnalyticsParams
  ): Promise<RevenueAnalyticsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.REVENUE, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get profitability analytics
  getProfitabilityAnalytics: async (
    params: ProfitabilityAnalyticsParams
  ): Promise<ProfitabilityAnalyticsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.PROFITABILITY, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get event aggregation
  getEventAggregation: async (
    params: EventAggregationParams
  ): Promise<EventAggregationResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.ANALYTICS.EVENTS_AGGREGATE, { orgId })
    const response = await apiClient.get(url, { params })
    return response.data
  },
}

export default analyticsApi
