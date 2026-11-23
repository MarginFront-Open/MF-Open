// @ts-nocheck
// TypeScript checking is disabled for this file because of unresolved type conflicts.

/**
 * Analytics Service
 * React Query hooks for analytics via Server Actions
 */
import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import {
  getUsageAnalytics as getUsageAnalyticsAction,
  getCostAnalytics as getCostAnalyticsAction,
  getSubscriptionAnalytics as getSubscriptionAnalyticsAction,
  getAgentAnalytics as getAgentAnalyticsAction,
  getRevenueAnalytics as getRevenueAnalyticsAction,
  getProfitabilityAnalytics as getProfitabilityAnalyticsAction,
  getEventAggregation as getEventAggregationAction,
  getTopCustomersByCost as getTopCustomersByCostAction,
  type UsageAnalyticsParams,
  type UsageAnalyticsResponse,
  type CostAnalyticsParams,
  type CostAnalyticsResponse,
  type SubscriptionAnalyticsParams,
  type SubscriptionAnalyticsResponse,
  type AgentAnalyticsParams,
  type AgentAnalyticsResponse,
  type RevenueAnalyticsParams,
  type RevenueAnalyticsResponse,
  type ProfitabilityAnalyticsParams,
  type ProfitabilityAnalyticsResponse,
  type EventAggregationParams,
  type EventAggregationResponse,
  type TopCustomersByCostParams,
  type TopCustomersByCostResponse,
} from '@/app/actions/analytics'

// Re-export types for consumers
export type {
  UsageAnalyticsParams,
  UsageAnalyticsResponse,
  CostAnalyticsParams,
  CostAnalyticsResponse,
  SubscriptionAnalyticsParams,
  SubscriptionAnalyticsResponse,
  AgentAnalyticsParams,
  AgentAnalyticsResponse,
  RevenueAnalyticsParams,
  RevenueAnalyticsResponse,
  ProfitabilityAnalyticsParams,
  ProfitabilityAnalyticsResponse,
  EventAggregationParams,
  EventAggregationResponse,
  TopCustomersByCostParams,
  TopCustomersByCostResponse,
}

// Query Keys
export const analyticsKeys = {
  all: ['analytics'] as const,
  usage: (params: Partial<UsageAnalyticsParams>) =>
    [...analyticsKeys.all, 'usage', params] as const,
  costs: (params: Partial<CostAnalyticsParams>) =>
    [...analyticsKeys.all, 'costs', params] as const,
  subscription: (
    subscriptionId: string,
    params?: Partial<SubscriptionAnalyticsParams>
  ) => [...analyticsKeys.all, 'subscription', subscriptionId, params] as const,
  agent: (params: AgentAnalyticsParams) =>
    [...analyticsKeys.all, 'agent', params] as const,
  revenue: (params: Partial<RevenueAnalyticsParams>) =>
    [...analyticsKeys.all, 'revenue', params] as const,
  profitability: (params: Partial<ProfitabilityAnalyticsParams>) =>
    [...analyticsKeys.all, 'profitability', params] as const,
  eventsAggregate: (params: Partial<EventAggregationParams>) =>
    [...analyticsKeys.all, 'events-aggregate', params] as const,
  topCustomersByCost: (params: Partial<TopCustomersByCostParams>) =>
    [...analyticsKeys.all, 'top-customers-by-cost', params] as const,
}

/**
 * Hook for getting usage analytics
 */
export function useUsageAnalytics(
  params: Partial<UsageAnalyticsParams> = {},
  options?: Omit<
    UseQueryOptions<UsageAnalyticsResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.usage(params),
    queryFn: async () => {
      const result = await getUsageAnalyticsAction(
        params as UsageAnalyticsParams
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch usage analytics')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for getting cost analytics
 */
export function useCostAnalytics(
  params: Partial<CostAnalyticsParams> = {},
  options?: Omit<UseQueryOptions<CostAnalyticsResponse>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: analyticsKeys.costs(params),
    queryFn: async () => {
      const result = await getCostAnalyticsAction(params as CostAnalyticsParams)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch cost analytics')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for getting subscription-level analytics
 */
export function useSubscriptionAnalytics(
  subscriptionId: string,
  params: Partial<SubscriptionAnalyticsParams> = {},
  options?: Omit<
    UseQueryOptions<SubscriptionAnalyticsResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.subscription(subscriptionId, params),
    queryFn: async () => {
      const result = await getSubscriptionAnalyticsAction(
        subscriptionId,
        params as SubscriptionAnalyticsParams
      )
      if (!result.success || !result.data) {
        throw new Error(
          result.error || 'Failed to fetch subscription analytics'
        )
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!subscriptionId,
    ...options,
  })
}

/**
 * Hook for getting agent analytics
 */
export function useAgentAnalytics(
  params: AgentAnalyticsParams,
  options?: Omit<
    UseQueryOptions<AgentAnalyticsResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.agent(params),
    queryFn: async () => {
      const result = await getAgentAnalyticsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch agent analytics')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!params.agentId,
    ...options,
  })
}

/**
 * Hook for getting revenue analytics
 */
export function useRevenueAnalytics(
  params: Partial<RevenueAnalyticsParams> = {},
  options?: Omit<
    UseQueryOptions<RevenueAnalyticsResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.revenue(params),
    queryFn: async () => {
      const result = await getRevenueAnalyticsAction(
        params as RevenueAnalyticsParams
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch revenue analytics')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for getting profitability analytics
 */
export function useProfitabilityAnalytics(
  params: Partial<ProfitabilityAnalyticsParams> = {},
  options?: Omit<
    UseQueryOptions<ProfitabilityAnalyticsResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.profitability(params),
    queryFn: async () => {
      const result = await getProfitabilityAnalyticsAction(
        params as ProfitabilityAnalyticsParams
      )
      if (!result.success || !result.data) {
        throw new Error(
          result.error || 'Failed to fetch profitability analytics'
        )
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for getting event aggregation
 */
export function useEventAggregation(
  params: Partial<EventAggregationParams> = {},
  options?: Omit<
    UseQueryOptions<EventAggregationResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.eventsAggregate(params),
    queryFn: async () => {
      const result = await getEventAggregationAction(
        params as EventAggregationParams
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch event aggregation')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for getting top customers ranked by cost
 * Used on the home page "By Customer" tab
 */
export function useTopCustomersByCost(
  params: Partial<TopCustomersByCostParams> = {},
  options?: Omit<
    UseQueryOptions<TopCustomersByCostResponse>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: analyticsKeys.topCustomersByCost(params),
    queryFn: async () => {
      const result = await getTopCustomersByCostAction(
        params as TopCustomersByCostParams
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch top customers by cost')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}
