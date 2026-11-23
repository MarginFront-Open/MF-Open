/**
 * Subscriptions Service
 * Handles all subscription-related API operations with React Query integration
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSubscriptions as getSubscriptionsAction,
  getSubscription as getSubscriptionAction,
  createSubscription as createSubscriptionAction,
  updateSubscription as updateSubscriptionAction,
  deleteSubscription as deleteSubscriptionAction,
  type Subscription,
  type PaginatedResponse,
  type CreateSubscriptionPayload,
  type UpdateSubscriptionPayload,
  type SubscriptionQueryParams,
} from '@/app/actions/subscriptions'
import { analyticsKeys } from './analytics-service'
import { useToast } from '@/hooks/use-toast'

// Re-export types for consumers
export type {
  Subscription,
  PaginatedResponse,
  CreateSubscriptionPayload,
  UpdateSubscriptionPayload,
  SubscriptionQueryParams,
}

// Query Keys
export const SUBSCRIPTIONS_KEYS = {
  all: ['subscriptions'] as const,
  lists: () => [...SUBSCRIPTIONS_KEYS.all, 'list'] as const,
  list: (filters: any) => [...SUBSCRIPTIONS_KEYS.lists(), filters] as const,
  details: () => [...SUBSCRIPTIONS_KEYS.all, 'detail'] as const,
  detail: (id: string) => [...SUBSCRIPTIONS_KEYS.details(), id] as const,
}

/**
 * Hook to fetch subscriptions with pagination and filters via Server Action
 */
export const useSubscriptions = (
  params: SubscriptionQueryParams = {},
  options?: { enabled?: boolean }
) => {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEYS.list(params),
    queryFn: async () => {
      const result = await getSubscriptionsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch subscriptions')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: options?.enabled,
  })
}

/**
 * Hook to fetch a single subscription by ID via Server Action
 */
export const useSubscription = (
  subscriptionId: string,
  includeDetails?: boolean
) => {
  return useQuery({
    queryKey: [
      ...SUBSCRIPTIONS_KEYS.detail(subscriptionId),
      { includeDetails },
    ],
    queryFn: async () => {
      const result = await getSubscriptionAction(subscriptionId, includeDetails)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch subscription')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!subscriptionId,
  })
}

/**
 * Hook to create a new subscription via Server Action
 */
export const useCreateSubscription = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: CreateSubscriptionPayload) => {
      const result = await createSubscriptionAction(data)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create subscription')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Subscription created',
        description: 'Subscription has been created successfully',
      })
      queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEYS.lists() })
      // New subscription affects revenue / MRR / profitability charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating subscription',
        description: error.message || 'Failed to create subscription',
      })
    },
  })
}

/**
 * Hook to update a subscription via Server Action
 */
export const useUpdateSubscription = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      subscriptionId,
      data,
      changeReason,
    }: {
      subscriptionId: string
      data: UpdateSubscriptionPayload
      changeReason?: string
    }) => {
      const result = await updateSubscriptionAction(
        subscriptionId,
        data,
        changeReason
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update subscription')
      }
      return { data: result.data, subscriptionId }
    },
    onSuccess: ({ subscriptionId }) => {
      toast({
        title: 'Subscription updated',
        description: 'Subscription has been updated successfully',
      })
      // The reader keys with [...detail(id), { includeDetails }] so a direct
      // setQueryData on detail(id) is a silent no-op. Invalidate so all
      // includeDetails variants refetch.
      queryClient.invalidateQueries({
        queryKey: SUBSCRIPTIONS_KEYS.detail(subscriptionId),
      })
      queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEYS.lists() })
      // Subscription edits change billing-cycle / status which feed revenue charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating subscription',
        description: error.message || 'Failed to update subscription',
      })
    },
  })
}

/**
 * Hook to delete a subscription via Server Action
 */
export const useDeleteSubscription = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const result = await deleteSubscriptionAction(subscriptionId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete subscription')
      }
      return subscriptionId
    },
    onSuccess: (subscriptionId) => {
      toast({
        title: 'Subscription deleted',
        description: 'Subscription has been deleted successfully',
      })
      queryClient.removeQueries({
        queryKey: SUBSCRIPTIONS_KEYS.detail(subscriptionId),
      })
      queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEYS.lists() })
      // Removing a subscription drops MRR / revenue figures on charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting subscription',
        description: error.message || 'Failed to delete subscription',
      })
    },
  })
}
