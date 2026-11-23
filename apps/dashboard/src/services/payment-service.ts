/**
 * Payment Service
 * React Query hooks for payment operations via Server Actions and API
 *
 * This service provides hooks for:
 * - Payment provider management (org settings)
 * - Checkout session creation (public invoice, through the API)
 * - Payment status checking (public, through the API)
 */
import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
} from '@tanstack/react-query'
import {
  getPaymentProviders as getPaymentProvidersAction,
  getPaymentProvider as getPaymentProviderAction,
  updatePaymentProvider as updatePaymentProviderAction,
  disconnectPaymentProvider as disconnectPaymentProviderAction,
  getDefaultPaymentProvider as getDefaultPaymentProviderAction,
  type PaymentProvider,
  type UpdatePaymentProviderParams,
} from '@/app/actions/payment-providers'
// =============================================================================
// HOOKS - API-BASED (OAuth, secrets and public endpoints)
// =============================================================================
import {
  paymentProvidersApi,
  publicPaymentApi,
  PaymentTransaction,
  CreateCheckoutRequest,
  ConnectProviderRequest,
  InvoicePaymentStatus,
} from '@/lib/api/payment-providers'
import { useToast } from '@/hooks/use-toast'

// Re-export types
export type { PaymentProvider, UpdatePaymentProviderParams }

// QUERY KEYS

export const PAYMENT_KEYS = {
  all: ['payments'] as const,
  providers: () => [...PAYMENT_KEYS.all, 'providers'] as const,
  providersList: () => [...PAYMENT_KEYS.providers(), 'list'] as const,
  providerDetail: (id: string) =>
    [...PAYMENT_KEYS.providers(), 'detail', id] as const,
  defaultProvider: () => [...PAYMENT_KEYS.providers(), 'default'] as const,
  transactions: () => [...PAYMENT_KEYS.all, 'transactions'] as const,
  invoiceTransactions: (invoiceId: string) =>
    [...PAYMENT_KEYS.transactions(), 'invoice', invoiceId] as const,
  publicPaymentStatus: (invoiceId: string) =>
    [...PAYMENT_KEYS.all, 'public', 'status', invoiceId] as const,
}

// =============================================================================
// HOOKS - PAYMENT PROVIDERS (Server Actions)
// =============================================================================

/**
 * Hook to fetch all payment providers for the organization
 */
export function usePaymentProviders(
  options?: Omit<UseQueryOptions<PaymentProvider[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: PAYMENT_KEYS.providersList(),
    queryFn: async () => {
      const result = await getPaymentProvidersAction()
      if (!result.success) {
        throw new Error(result.error || 'Failed to get payment providers')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  })
}

/**
 * Hook to fetch a specific payment provider
 */
export function usePaymentProvider(
  providerId: string,
  options?: Omit<UseQueryOptions<PaymentProvider>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: PAYMENT_KEYS.providerDetail(providerId),
    queryFn: async () => {
      const result = await getPaymentProviderAction(providerId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to get payment provider')
      }
      return result.data
    },
    enabled: !!providerId,
    staleTime: 5 * 60 * 1000,
    ...options,
  })
}

/**
 * Hook to get the default payment provider
 */
export function useDefaultPaymentProvider(
  options?: Omit<
    UseQueryOptions<PaymentProvider | null>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: PAYMENT_KEYS.defaultProvider(),
    queryFn: async () => {
      const result = await getDefaultPaymentProviderAction()
      if (!result.success) {
        throw new Error(
          result.error || 'Failed to get default payment provider'
        )
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000,
    ...options,
  })
}

/**
 * Hook to update a payment provider
 */
export function useUpdatePaymentProvider() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      providerId,
      data,
    }: {
      providerId: string
      data: UpdatePaymentProviderParams
    }) => {
      const result = await updatePaymentProviderAction(providerId, data)
      if (!result.success) {
        throw new Error(result.error || 'Failed to update payment provider')
      }
      return result.data
    },
    onSuccess: (_, variables) => {
      toast({
        title: 'Provider updated',
        description: 'Payment provider has been updated successfully',
      })
      queryClient.invalidateQueries({ queryKey: PAYMENT_KEYS.providersList() })
      queryClient.invalidateQueries({
        queryKey: PAYMENT_KEYS.providerDetail(variables.providerId),
      })
      queryClient.invalidateQueries({
        queryKey: PAYMENT_KEYS.defaultProvider(),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating provider',
        description: error.message || 'Failed to update payment provider',
      })
    },
  })
}

/**
 * Hook to disconnect (delete) a payment provider
 */
export function useDisconnectPaymentProvider() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (providerId: string) => {
      const result = await disconnectPaymentProviderAction(providerId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to disconnect payment provider')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Provider disconnected',
        description: 'Payment provider has been disconnected successfully',
      })
      queryClient.invalidateQueries({ queryKey: PAYMENT_KEYS.providersList() })
      queryClient.invalidateQueries({
        queryKey: PAYMENT_KEYS.defaultProvider(),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error disconnecting provider',
        description: error.message || 'Failed to disconnect payment provider',
      })
    },
  })
}

/**
 * Hook to check if organization has any active payment provider
 */
export function useHasActivePaymentProvider() {
  const { data: providers, isLoading } = usePaymentProviders()

  return {
    hasProvider: providers?.some((p) => p.isActive) ?? false,
    isLoading,
  }
}

// Re-export types for the operations that go through the API
export type {
  PaymentTransaction,
  CreateCheckoutRequest,
  ConnectProviderRequest,
  InvoicePaymentStatus,
}

/**
 * Hook to connect a new payment provider
 * Note: Uses API because it involves secret key encryption
 */
export function useConnectPaymentProvider() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: ConnectProviderRequest) =>
      paymentProvidersApi.connectProvider(data),
    onSuccess: () => {
      toast({
        title: 'Provider connected',
        description: 'Payment provider has been connected successfully',
      })
      queryClient.invalidateQueries({ queryKey: PAYMENT_KEYS.providersList() })
      queryClient.invalidateQueries({
        queryKey: PAYMENT_KEYS.defaultProvider(),
      })
    },
    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Error connecting provider',
        description:
          error.response?.data?.message || 'Failed to connect payment provider',
      })
    },
  })
}

// =============================================================================
// HOOKS - PAYMENT TRANSACTIONS (API-based)
// =============================================================================

/**
 * Hook to fetch payment transactions for an invoice
 */
export function useInvoicePayments(invoiceId: string) {
  return useQuery({
    queryKey: PAYMENT_KEYS.invoiceTransactions(invoiceId),
    queryFn: () => paymentProvidersApi.getInvoiceTransactions(invoiceId),
    enabled: !!invoiceId,
    staleTime: 30 * 1000, // 30 seconds - payments can update frequently
  })
}

// =============================================================================
// HOOKS - PUBLIC PAYMENT (API-based, No Auth)
// =============================================================================

/**
 * Hook to create a checkout session for a public invoice
 * Uses API because this is a public endpoint
 */
export function useCreateCheckoutSession() {
  return useMutation({
    mutationFn: ({
      invoiceId,
      data,
    }: {
      invoiceId: string
      data?: CreateCheckoutRequest
    }) => publicPaymentApi.createCheckoutSession(invoiceId, data),
    onSuccess: (response) => {
      // Redirect to checkout URL
      if (response.session?.url) {
        window.location.href = response.session.url
      }
    },
  })
}

/**
 * Hook to check payment status for a public invoice
 * Uses API because this is a public endpoint
 */
export function usePublicPaymentStatus(
  invoiceId: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: PAYMENT_KEYS.publicPaymentStatus(invoiceId),
    queryFn: () => publicPaymentApi.getPaymentStatus(invoiceId),
    enabled: options?.enabled !== false && !!invoiceId,
    staleTime: 10 * 1000, // 10 seconds - check frequently after payment
    refetchInterval: (query) => {
      // Auto-refetch every 3 seconds while payment is processing
      const data = query.state.data as InvoicePaymentStatus | undefined
      if (data?.status === 'processing' || data?.status === 'pending') {
        return 3000
      }
      return false
    },
  })
}
