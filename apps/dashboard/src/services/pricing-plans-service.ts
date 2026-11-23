/**
 * Pricing Plans Service
 * React Query hooks for pricing plans via Server Actions
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPricingPlans as getPricingPlansAction,
  getAgentPricingPlans as getAgentPricingPlansAction,
  getPricingPlan as getPricingPlanAction,
  createPricingPlan as createPricingPlanAction,
  updatePricingPlan as updatePricingPlanAction,
  deletePricingPlan as deletePricingPlanAction,
  copyPricingPlan as copyPricingPlanAction,
  getPlanStrategies as getPlanStrategiesAction,
  addPlanStrategies as addPlanStrategiesAction,
  updatePlanStrategy as updatePlanStrategyAction,
  deletePlanStrategy as deletePlanStrategyAction,
  bulkUpdatePlanStrategies as bulkUpdatePlanStrategiesAction,
  type PricingPlan,
  type PricingPlansResponse,
  type CreatePricingPlanPayload,
  type UpdatePricingPlanPayload,
  type CopyPricingPlanPayload,
  type PricingStrategy,
  type CreatePricingStrategyPayload,
  type UpdatePricingStrategyPayload,
} from '@/app/actions/pricing-plans'
import { FILTERS_KEYS } from './filters-service'
import { useToast } from '@/hooks/use-toast'

// Re-export types for consumers
export type {
  PricingPlan,
  PricingPlansResponse,
  CreatePricingPlanPayload,
  UpdatePricingPlanPayload,
  CopyPricingPlanPayload,
  PricingStrategy,
  CreatePricingStrategyPayload,
  UpdatePricingStrategyPayload,
}

// Query key factory for consistent cache keys
export const pricingPlanKeys = {
  all: ['pricing-plans'] as const,
  lists: () => [...pricingPlanKeys.all, 'list'] as const,
  list: (params: { agentId?: string }) =>
    [...pricingPlanKeys.lists(), params] as const,
  details: () => [...pricingPlanKeys.all, 'detail'] as const,
  detail: (id: string) => [...pricingPlanKeys.details(), id] as const,
  byAgent: (agentId: string) =>
    [...pricingPlanKeys.all, 'agent', agentId] as const,
  strategies: (planId: string) =>
    [...pricingPlanKeys.all, 'strategies', planId] as const,
}

/**
 * Hook for fetching pricing plans with filters
 */
export const usePricingPlans = (
  params: {
    agentId?: string
    page?: number
    limit?: number
    search?: string
  } = {}
) => {
  return useQuery({
    queryKey: pricingPlanKeys.list(params),
    queryFn: async () => {
      const result = await getPricingPlansAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch pricing plans')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook for fetching pricing plans for a specific agent
 */
export const useAgentPricingPlans = (
  agentId: string,
  includeStrategies = true
) => {
  return useQuery({
    queryKey: [...pricingPlanKeys.byAgent(agentId), { includeStrategies }],
    queryFn: async () => {
      const result = await getAgentPricingPlansAction(
        agentId,
        includeStrategies
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch agent pricing plans')
      }
      return result.data
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook for fetching a single pricing plan by ID
 */
export const usePricingPlan = (planId: string, includeStrategies = true) => {
  return useQuery({
    queryKey: [...pricingPlanKeys.detail(planId), { includeStrategies }],
    queryFn: async () => {
      const result = await getPricingPlanAction(planId, includeStrategies)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch pricing plan')
      }
      return result.data
    },
    enabled: !!planId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Hook for creating a new pricing plan
 */
export const useCreatePricingPlan = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (payload: CreatePricingPlanPayload) => {
      const result = await createPricingPlanAction(payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create pricing plan')
      }
      return result.data
    },
    onSuccess: (newPlan) => {
      toast({
        title: 'Pricing plan created',
        description: 'Pricing plan has been created successfully',
      })
      // Invalidate agent's pricing plans list
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.byAgent(newPlan.agentId!),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.lists(),
      })
      // New plan should appear in filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating pricing plan',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for updating a pricing plan
 */
export const useUpdatePricingPlan = (planId: string) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (payload: UpdatePricingPlanPayload) => {
      const result = await updatePricingPlanAction(planId, payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update pricing plan')
      }
      return result.data
    },
    onSuccess: (updatedPlan) => {
      toast({
        title: 'Pricing plan updated',
        description: 'Pricing plan has been updated successfully',
      })
      // The reader keys with [...detail(planId), { includeStrategies }] so a
      // direct setQueryData on detail(planId) is a silent no-op. Invalidate so
      // every includeStrategies variant refetches.
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.detail(planId),
      })
      // Invalidate agent's list
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.byAgent(updatedPlan.agentId!),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.lists(),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating pricing plan',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for deleting a pricing plan
 */
export const useDeletePricingPlan = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      planId,
      agentId,
    }: {
      planId: string
      agentId: string
    }) => {
      const result = await deletePricingPlanAction(planId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete pricing plan')
      }
      return { planId, agentId }
    },
    onSuccess: (_, { planId, agentId }) => {
      toast({
        title: 'Pricing plan deleted',
        description: 'Pricing plan has been deleted successfully',
      })
      // Remove from cache
      queryClient.removeQueries({ queryKey: pricingPlanKeys.detail(planId) })
      // Invalidate agent's list
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.byAgent(agentId),
      })
      queryClient.invalidateQueries({ queryKey: pricingPlanKeys.lists() })
      // Removed plan should disappear from filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting pricing plan',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for copying a pricing plan
 */
export const useCopyPricingPlan = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      planId,
      ...payload
    }: CopyPricingPlanPayload & { planId: string }) => {
      const result = await copyPricingPlanAction(planId, payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to copy pricing plan')
      }
      return result.data
    },
    onSuccess: (newPlan) => {
      toast({
        title: 'Pricing plan copied',
        description: `Created new plan: ${newPlan.name}`,
      })
      // Invalidate agent's pricing plans list
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.byAgent(newPlan.agentId!),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.lists(),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error copying pricing plan',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for fetching strategies for a pricing plan
 */
export const usePlanStrategies = (planId: string) => {
  return useQuery({
    queryKey: pricingPlanKeys.strategies(planId),
    queryFn: async () => {
      const result = await getPlanStrategiesAction(planId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch pricing strategies')
      }
      return result.data
    },
    enabled: !!planId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Hook for adding strategies to a pricing plan
 */
export const useAddPlanStrategies = (planId: string, agentId: string) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (strategies: CreatePricingStrategyPayload[]) => {
      const result = await addPlanStrategiesAction(planId, agentId, strategies)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to add pricing strategies')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Strategies added',
        description: 'Pricing strategies have been added successfully',
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.strategies(planId),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.detail(planId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error adding strategies',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for updating a single pricing strategy
 */
export const useUpdatePlanStrategy = (planId: string) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      strategyId,
      ...data
    }: UpdatePricingStrategyPayload & { strategyId: string }) => {
      const result = await updatePlanStrategyAction(planId, strategyId, data)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update pricing strategy')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Strategy updated',
        description: 'Pricing strategy has been updated successfully',
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.strategies(planId),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.detail(planId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating strategy',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for deleting a pricing strategy
 */
export const useDeletePlanStrategy = (planId: string) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (strategyId: string) => {
      const result = await deletePlanStrategyAction(planId, strategyId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete pricing strategy')
      }
    },
    onSuccess: () => {
      toast({
        title: 'Strategy deleted',
        description: 'Pricing strategy has been deleted successfully',
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.strategies(planId),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.detail(planId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting strategy',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for bulk updating pricing strategies
 */
export const useBulkUpdatePlanStrategies = (
  planId: string,
  agentId: string
) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      newStrategies,
      updatedStrategies,
    }: {
      newStrategies: CreatePricingStrategyPayload[]
      updatedStrategies: (UpdatePricingStrategyPayload & { id: string })[]
    }) => {
      const result = await bulkUpdatePlanStrategiesAction(
        planId,
        agentId,
        newStrategies,
        updatedStrategies
      )
      if (!result.success || !result.data) {
        throw new Error(
          result.error || 'Failed to bulk update pricing strategies'
        )
      }
      return result.data
    },
    onSuccess: (data) => {
      const createdCount = data.created.length
      const updatedCount = data.updated.length
      toast({
        title: 'Strategies updated',
        description: `Created ${createdCount}, updated ${updatedCount} strategies`,
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.strategies(planId),
      })
      queryClient.invalidateQueries({
        queryKey: pricingPlanKeys.detail(planId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating strategies',
        description: error.message,
      })
    },
  })
}
