/**
 * API Keys Service
 * React Query hooks for API keys via Server Actions
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryOptions,
} from '@tanstack/react-query'
import {
  getApiKeys as getApiKeysAction,
  createApiKey as createApiKeyAction,
  createApiKeyPair as createApiKeyPairAction,
  revokeApiKey as revokeApiKeyAction,
  deleteApiKey as deleteApiKeyAction,
  type ApiKey,
  type CreateApiKeyParams,
  type ApiKeyCreatedResponse,
  type ApiKeyPairResponse,
} from '@/app/actions/api-keys'
import { useToast } from '@/hooks/use-toast'

// Re-export types for consumers
export type {
  ApiKey,
  CreateApiKeyParams,
  ApiKeyCreatedResponse,
  ApiKeyPairResponse,
}

// Query key factory
export const apiKeysKeys = {
  all: ['api-keys'] as const,
  lists: () => [...apiKeysKeys.all, 'list'] as const,
  list: () => [...apiKeysKeys.lists()] as const,
  details: () => [...apiKeysKeys.all, 'detail'] as const,
  detail: (id: string) => [...apiKeysKeys.details(), id] as const,
}

// React Query Hooks (Server Actions)

/**
 * Hook for getting a list of API keys
 */
export function useApiKeys(
  options?: Omit<UseQueryOptions<ApiKey[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: apiKeysKeys.list(),
    queryFn: async () => {
      const result = await getApiKeysAction()
      if (!result.success) {
        throw new Error(result.error || 'Failed to get API keys')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook for creating a new API key
 */
export function useCreateApiKey() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: CreateApiKeyParams) => {
      const result = await createApiKeyAction(params)
      if (!result.success) {
        throw new Error(result.error || 'Failed to create API key')
      }
      return result.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: apiKeysKeys.lists() })
      toast({
        title: 'API key created',
        description:
          "API key has been created successfully. Copy it now - it won't be shown again.",
      })
      return data
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating API key',
        description:
          error.message || 'Failed to create API key. Please try again.',
      })
    },
  })
}

/**
 * Hook for creating a key pair (secret + publishable). Prefer this over a
 * single key.
 */
export function useCreateApiKeyPair() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: CreateApiKeyParams) => {
      const result = await createApiKeyPairAction(params)
      if (!result.success) {
        throw new Error(result.error || 'Failed to create API key pair')
      }
      return result.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: apiKeysKeys.lists() })
      toast({
        title: 'API key pair created',
        description:
          'Both secret and publishable keys have been created. Copy your secret key now!',
      })
      return data
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating API key pair',
        description:
          error.message || 'Failed to create API key pair. Please try again.',
      })
    },
  })
}

/**
 * Hook for revoking an API key
 */
export function useRevokeApiKey() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (keyId: string) => {
      const result = await revokeApiKeyAction(keyId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to revoke API key')
      }
      return result.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: apiKeysKeys.lists() })
      toast({
        title: 'API key revoked',
        // Surface the real sign-out count so a key rotation that
        // ended live portal sessions never looks like a silent no-op.
        description:
          data.portalSessionsEnded > 0
            ? `API key revoked. Signed out ${data.portalSessionsEnded} active portal ${
                data.portalSessionsEnded === 1 ? 'session' : 'sessions'
              }.`
            : 'API key has been revoked successfully.',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error revoking API key',
        description:
          error.message || 'Failed to revoke API key. Please try again.',
      })
    },
  })
}

/**
 * Hook for deleting an API key
 */
export function useDeleteApiKey() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (keyId: string) => {
      const result = await deleteApiKeyAction(keyId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete API key')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeysKeys.lists() })
      toast({
        title: 'API key deleted',
        description: 'API key has been deleted successfully.',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting API key',
        description:
          error.message || 'Failed to delete API key. Please try again.',
      })
    },
  })
}
