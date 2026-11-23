/**
 * Agent Service
 * Service layer for handling agent-related API operations with React Query hooks
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAgents as getAgentsAction,
  getAgent as getAgentAction,
  createAgent as createAgentAction,
  updateAgent as updateAgentAction,
  deleteAgent as deleteAgentAction,
  type CreateAgentPayload as CreatePayload,
  type UpdateAgentPayload as UpdatePayload,
} from '@/app/actions/agents'
import { FILTERS_KEYS } from './filters-service'
import { useToast } from '@/hooks/use-toast'

// Types
export interface Agent {
  id: string
  name: string
  description: string
  agentCode: string
  orgId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  activeSubscriptionsCount?: number
  signalsCount?: number
  activePlansCount?: number
}

export interface CreateAgentPayload {
  name: string
  description: string
  agentCode: string
  isActive: boolean
}

export interface AgentsResponse {
  results: Agent[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface GetAgentsParams {
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  isActive?: boolean
  search?: string
}

// Query key factory
export const agentKeys = {
  all: ['agents'] as const,
  lists: () => [...agentKeys.all, 'list'] as const,
  list: (params: GetAgentsParams) => [...agentKeys.lists(), params] as const,
  details: () => [...agentKeys.all, 'detail'] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
}

// React Query Hooks

/**
 * Hook for getting a list of agents via Server Action
 */
export const useAgents = (params: GetAgentsParams = {}) => {
  return useQuery({
    queryKey: agentKeys.list(params),
    queryFn: async () => {
      const result = await getAgentsAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch agents')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook for getting a single agent by ID via Server Action
 */
export const useAgent = (agentId: string) => {
  return useQuery({
    queryKey: agentKeys.detail(agentId),
    queryFn: async () => {
      const result = await getAgentAction(agentId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch agent')
      }
      return result.data
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Hook for creating a new agent via Server Action
 */
export const useCreateAgent = () => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: CreateAgentPayload) => {
      const result = await createAgentAction(payload as CreatePayload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create agent')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Agent created',
        description: 'Agent has been created successfully',
      })
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() })
      // New agent should appear in filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating agent',
        description: error.message || 'Failed to create agent',
      })
    },
  })
}

/**
 * Hook for updating an existing agent via Server Action
 */
export const useUpdateAgent = (agentId: string) => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: Partial<CreateAgentPayload>) => {
      const result = await updateAgentAction(agentId, payload as UpdatePayload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update agent')
      }
      return result.data
    },
    onSuccess: (updatedAgent) => {
      toast({
        title: 'Agent updated',
        description: 'Agent has been updated successfully',
      })
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) })
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() })
      queryClient.setQueryData(agentKeys.detail(agentId), updatedAgent)
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating agent',
        description: error.message || 'Failed to update agent',
      })
    },
  })
}

/**
 * Hook for deleting an agent via Server Action
 */
export const useDeleteAgent = () => {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (agentId: string) => {
      const result = await deleteAgentAction(agentId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete agent')
      }
      return agentId
    },
    onSuccess: (agentId) => {
      toast({
        title: 'Agent deleted',
        description: 'Agent has been deleted successfully',
      })
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() })
      queryClient.removeQueries({ queryKey: agentKeys.detail(agentId) })
      // Removed agent should disappear from filter dropdowns immediately
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting agent',
        description: error.message || 'Failed to delete agent',
      })
    },
  })
}
