/**
 * Signal Service
 * Service layer for handling signal-related API operations with React Query hooks
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSignals as getSignalsAction,
  getAgentSignals as getAgentSignalsAction,
  getSignal as getSignalAction,
  createSignal as createSignalAction,
  updateSignal as updateSignalAction,
  bulkUpsertSignals as bulkUpsertSignalsAction,
  deleteSignal as deleteSignalAction,
  type Signal as ServerSignal,
  type GetSignalsParams,
} from '@/app/actions/signals'
import { FILTERS_KEYS } from './filters-service'
import { useToast } from '@/hooks/use-toast'

// Types
export interface Signal {
  id: string
  name: string
  shortName: string | null
  type?: 'ACTIVITY' | 'OUTCOME'
  agentId: string
  orgId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  agent?: {
    id: string
    name: string
    agentCode: string
  }
}

export interface CreateSignalPayload {
  name: string
  shortName?: string
  agentId: string
}

export interface UpdateSignalPayload {
  name?: string
  shortName?: string
}

export interface UiSignal {
  id: string
  name: string
  shortName?: string | null
  type?: 'ACTIVITY' | 'OUTCOME'
  agentId?: string
  orgId?: string
  createdAt?: string
  updatedAt?: string
  deletedAt?: string | null
  agent?: {
    id: string
    name: string
    agentCode: string
  }
}

export interface BulkSignalRequest {
  id?: string
  name: string
  shortName?: string
  agentId: string
  isNew: boolean
}

export interface SignalsResponse {
  results: Signal[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export { GetSignalsParams }

// Helper function to convert API signal to UI signal
export const convertApiSignalToUiSignal = (
  apiSignal: Signal | ServerSignal
): UiSignal => ({
  id: apiSignal.id,
  name: apiSignal.name,
  shortName: apiSignal.shortName,
  // Map DB values (volume/usage) to UI labels (ACTIVITY/OUTCOME)
  type:
    'type' in apiSignal && apiSignal.type
      ? apiSignal.type === 'volume'
        ? 'ACTIVITY'
        : 'OUTCOME'
      : 'ACTIVITY',
  agentId: apiSignal.agentId,
  orgId: apiSignal.orgId,
  createdAt: apiSignal.createdAt,
  updatedAt: apiSignal.updatedAt,
  deletedAt: apiSignal.deletedAt,
  agent: apiSignal.agent,
})

// Helper function to generate shortName from signal name
export const generateShortName = (name: string): string => {
  return name.toLowerCase().replace(/\s+/g, '_')
}

// Query key factory
export const signalKeys = {
  all: ['signals'] as const,
  lists: () => [...signalKeys.all, 'list'] as const,
  list: (params: GetSignalsParams) => [...signalKeys.lists(), params] as const,
  agentList: (agentId: string) => [...signalKeys.lists(), { agentId }] as const,
  details: () => [...signalKeys.all, 'detail'] as const,
  detail: (id: string) => [...signalKeys.details(), id] as const,
}

// React Query Hooks

/**
 * Hook for getting a list of signals via Server Action
 * Uses React Query's useQuery for state management and caching
 */
export const useSignals = (params: GetSignalsParams = {}) => {
  return useQuery({
    queryKey: signalKeys.list(params),
    queryFn: async () => {
      const result = await getSignalsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch signals')
      }
      return {
        ...result.data,
        results: result.data.results.map(convertApiSignalToUiSignal),
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook for getting signals for a specific agent via Server Action
 * Uses React Query's useQuery for state management and caching
 */
export const useAgentSignals = (agentId: string) => {
  return useQuery({
    queryKey: signalKeys.agentList(agentId),
    queryFn: async () => {
      const result = await getAgentSignalsAction(agentId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch agent signals')
      }
      return {
        ...result.data,
        results: result.data.results.map(convertApiSignalToUiSignal),
      }
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Hook for getting a single signal by ID via Server Action
 * Uses React Query's useQuery for state management and caching
 */
export const useSignal = (signalId: string) => {
  return useQuery({
    queryKey: signalKeys.detail(signalId),
    queryFn: async () => {
      const result = await getSignalAction(signalId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch signal')
      }
      return convertApiSignalToUiSignal(result.data)
    },
    enabled: !!signalId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Hook for creating a new signal via Server Action
 * Uses React Query's useMutation for state management
 */
export const useCreateSignal = () => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: CreateSignalPayload) => {
      const result = await createSignalAction(payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create signal')
      }
      return result.data
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalKeys.lists() })
      // New signal should appear in filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
      toast({
        title: 'Signal created',
        description: 'Signal has been created successfully',
      })
    },

    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating signal',
        description:
          error.message || 'Failed to create signal. Please try again later.',
      })
    },
  })
}

/**
 * Hook for updating an existing signal via Server Action
 * Uses React Query's useMutation for state management
 */
export const useUpdateSignal = (signalId: string) => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: UpdateSignalPayload) => {
      const result = await updateSignalAction(signalId, payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update signal')
      }
      return result.data
    },

    onSuccess: (updatedSignal) => {
      queryClient.invalidateQueries({ queryKey: signalKeys.detail(signalId) })
      queryClient.invalidateQueries({ queryKey: signalKeys.lists() })

      // Update the cache with the new data
      queryClient.setQueryData(
        signalKeys.detail(signalId),
        convertApiSignalToUiSignal(updatedSignal)
      )

      toast({
        title: 'Signal updated',
        description: 'Signal has been updated successfully',
      })
    },

    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating signal',
        description:
          error.message || 'Failed to update signal. Please try again later.',
      })
    },
  })
}

/**
 * Hook for bulk creating or updating signals via Server Action
 * Uses React Query's useMutation for state management
 */
export const useBulkUpsertSignals = () => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (signals: BulkSignalRequest[]) => {
      const result = await bulkUpsertSignalsAction(signals)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to bulk upsert signals')
      }
      return result.data
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalKeys.lists() })
      toast({
        title: 'Signals updated',
        description: 'Signals have been updated successfully',
      })
    },

    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating signals',
        description:
          error.message || 'Failed to update signals. Please try again later.',
      })
    },
  })
}

/**
 * Hook for deleting a signal via Server Action
 * Uses React Query's useMutation for state management
 */
export const useDeleteSignal = () => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (signalId: string) => {
      const result = await deleteSignalAction(signalId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete signal')
      }
      return signalId
    },

    onSuccess: (signalId) => {
      queryClient.invalidateQueries({ queryKey: signalKeys.lists() })
      queryClient.removeQueries({ queryKey: signalKeys.detail(signalId) })
      // Removed signal should disappear from filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
      toast({
        title: 'Signal deleted',
        description: 'Signal has been deleted successfully',
      })
    },

    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting signal',
        description:
          error.message || 'Failed to delete signal. Please try again later.',
      })
    },
  })
}
