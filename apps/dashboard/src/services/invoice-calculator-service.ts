import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  UseMutationOptions,
} from '@tanstack/react-query'
import {
  invoiceCalculatorApi,
  type CalculateInvoicePayload,
  type SimulationPayload,
  type BillingStatusResponse,
} from '@/lib/api/invoice-calculator'
import { useToast } from '@/hooks/use-toast'

// Query Keys
export const INVOICE_CALCULATOR_KEYS = {
  all: ['invoice-calculator'] as const,
  billingStatus: (subscriptionId: string) =>
    ['invoice-calculator', 'billing-status', subscriptionId] as const,
}

// Billing Status Hook
export function useBillingStatus(
  subscriptionId: string,
  options?: Omit<UseQueryOptions<BillingStatusResponse>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: INVOICE_CALCULATOR_KEYS.billingStatus(subscriptionId),
    queryFn: () => invoiceCalculatorApi.getBillingStatus(subscriptionId),
    staleTime: 2 * 60 * 1000, // 2 minutes
    enabled: !!subscriptionId,
    ...options,
  })
}

// Calculate Invoice Mutation
export function useCalculateInvoice(
  options?: UseMutationOptions<any, Error, CalculateInvoicePayload>
) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: CalculateInvoicePayload) =>
      invoiceCalculatorApi.calculateInvoice(payload),
    onSuccess: (_data, variables) => {
      toast({
        title: 'Invoice Calculated',
        description: 'Invoice calculation completed successfully',
      })
      // Invalidate billing status for the subscription
      queryClient.invalidateQueries({
        queryKey: INVOICE_CALCULATOR_KEYS.billingStatus(
          variables.subscriptionId
        ),
      })
    },
    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Calculation Failed',
        description:
          error?.response?.data?.message || 'Failed to calculate invoice',
      })
    },
    ...options,
  })
}

// Simulate Revenue Mutation
export function useSimulateRevenue(
  options?: UseMutationOptions<any, Error, SimulationPayload>
) {
  const { toast } = useToast()

  return useMutation({
    mutationFn: (payload: SimulationPayload) =>
      invoiceCalculatorApi.simulateRevenue(payload),
    onSuccess: () => {
      toast({
        title: 'Simulation Complete',
        description: 'Revenue simulation completed successfully',
      })
    },
    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Simulation Failed',
        description:
          error?.response?.data?.message || 'Failed to simulate revenue',
      })
    },
    ...options,
  })
}
