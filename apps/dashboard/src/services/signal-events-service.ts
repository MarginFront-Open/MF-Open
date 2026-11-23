/**
 * Signal Events Service
 * React Query hooks for signal events via Server Actions
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSignalEvents as getSignalEventsAction,
  getSignalEvent as getSignalEventAction,
  bulkDeleteEvents as bulkDeleteEventsAction,
  getEventAnalytics as getEventAnalyticsAction,
  type SignalEvent,
  type SignalEventsResponse,
  type GetSignalEventsParams,
  type EventsAnalyticsResponse,
  type GetEventsAnalyticsParams,
} from '@/app/actions/signal-events'
import { analyticsKeys } from './analytics-service'
import { useToast } from '@/hooks/use-toast'

// Re-export types for consumers
export type {
  SignalEvent,
  SignalEventsResponse,
  GetSignalEventsParams,
  EventsAnalyticsResponse,
  GetEventsAnalyticsParams,
}

// Query key factory
export const signalEventsKeys = {
  all: ['signal-events'] as const,
  lists: () => [...signalEventsKeys.all, 'list'] as const,
  list: (params: GetSignalEventsParams) =>
    [...signalEventsKeys.lists(), params] as const,
  detail: (id: string) => [...signalEventsKeys.all, 'detail', id] as const,
  analytics: () => [...signalEventsKeys.all, 'analytics'] as const,
  analyticsParams: (params: GetEventsAnalyticsParams) =>
    [...signalEventsKeys.analytics(), params] as const,
}

/**
 * Hook for getting a list of signal events
 */
export const useSignalEvents = (params: GetSignalEventsParams = {}) => {
  return useQuery({
    queryKey: signalEventsKeys.list(params),
    queryFn: async () => {
      const result = await getSignalEventsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch signal events')
      }
      return result.data
    },
    staleTime: 60000, // 1 minute
  })
}

/**
 * Hook for getting a single signal event
 */
export const useSignalEvent = (eventId: string) => {
  return useQuery({
    queryKey: signalEventsKeys.detail(eventId),
    queryFn: async () => {
      const result = await getSignalEventAction(eventId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch signal event')
      }
      return result.data
    },
    enabled: !!eventId,
    staleTime: 60000,
  })
}

/**
 * Hook for getting events analytics
 */
export const useEventsAnalytics = (params: GetEventsAnalyticsParams = {}) => {
  return useQuery({
    queryKey: signalEventsKeys.analyticsParams(params),
    queryFn: async () => {
      const result = await getEventAnalyticsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch events analytics')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - analytics data changes less frequently
  })
}

/**
 * Hook for bulk deleting signal events
 */
export const useBulkDeleteEvents = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (eventIds: string[]) => {
      const result = await bulkDeleteEventsAction(eventIds)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to delete events')
      }
      return result.data
    },
    onSuccess: (data) => {
      toast({
        title: 'Events deleted',
        description: `Successfully deleted ${data.deletedCount} event(s)`,
      })
      // Invalidate all signal events queries
      queryClient.invalidateQueries({ queryKey: signalEventsKeys.lists() })
      queryClient.invalidateQueries({ queryKey: signalEventsKeys.analytics() })
      // Charts on analytics / revenue / cost-management dashboards read events
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting events',
        description: error.message,
      })
    },
  })
}
