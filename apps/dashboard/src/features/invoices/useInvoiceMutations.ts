/**
 * Invoice Mutation Hooks
 *
 * TanStack Query mutations for invoice state transitions.
 * Uses Server Actions for all API calls.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  finalizeInvoice as finalizeInvoiceAction,
  markInvoicePaid as markInvoicePaidAction,
  voidInvoice as voidInvoiceAction,
  createInvoice as createInvoiceAction,
  updateInvoice as updateInvoiceAction,
  generateInvoice as generateInvoiceAction,
  type Invoice,
  type CreateInvoicePayload,
  type UpdateInvoicePayload,
  type GenerateInvoicePayload,
} from '@/app/actions/invoices'
import { INVOICES_KEYS } from '@/services/invoices-service'
import { analyticsKeys } from '@/services/analytics-service'
import { toast } from '@/hooks/use-toast'

export type {
  Invoice,
  CreateInvoicePayload,
  UpdateInvoicePayload,
  GenerateInvoicePayload,
}

interface MutationCallbacks {
  onSuccess?: (invoice: Invoice) => void
  onError?: (error: Error) => void
}

/**
 * Hook to mark an invoice as paid via Server Action
 */
export function useMarkInvoicePaid(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await markInvoicePaidAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to mark invoice as paid')
      }
      // markInvoicePaid returns { invoice, payment } - extract the invoice
      return result.data.invoice
    },
    onSuccess: (invoice) => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoice state changes affect revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.success({
        title: 'Invoice marked as paid',
        description: `Invoice ${invoice.invoiceNumber || invoice.id} has been marked as paid.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to mark invoice as paid',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}

/**
 * Hook to void an invoice via Server Action
 */
export function useVoidInvoice(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await voidInvoiceAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to void invoice')
      }
      return result.data
    },
    onSuccess: (invoice) => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoice state changes affect revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.warning({
        title: 'Invoice voided',
        description: `Invoice ${invoice.invoiceNumber || invoice.id} has been voided.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to void invoice',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}

/**
 * Hook to finalize a draft invoice via Server Action
 */
export function useFinalizeInvoice(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await finalizeInvoiceAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to finalize invoice')
      }
      return result.data
    },
    onSuccess: (invoice) => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoice state changes affect revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.success({
        title: 'Invoice finalized',
        description: `Invoice ${invoice.invoiceNumber} has been finalized and is ready for payment.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to finalize invoice',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}

/**
 * Hook to create a new invoice via Server Action
 */
export function useCreateInvoice(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: CreateInvoicePayload) => {
      const result = await createInvoiceAction(payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create invoice')
      }
      return result.data
    },
    onSuccess: (invoice) => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoice state changes affect revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.success({
        title: 'Invoice created',
        description: `Invoice ${invoice.invoiceNumber} has been created successfully.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to create invoice',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}

/**
 * Hook to generate a draft invoice from a subscription's usage events.
 *
 * Powers the "Generate from Subscription" button on /invoices.
 * Server Action calls api-nest's internal generate endpoint, which composes
 * createUsageDraftInvoice + updateUsageDraftInvoice (same composition the cron uses).
 */
export function useGenerateInvoice(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: GenerateInvoicePayload) => {
      const result = await generateInvoiceAction(payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to generate invoice')
      }
      return result.data
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.success({
        title: 'Invoice generated',
        description: `Draft ${invoice.invoiceNumber} created from subscription usage. Review and send when ready.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to generate invoice',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}

/**
 * Hook to update a draft invoice via Server Action
 */
export function useUpdateInvoice(callbacks?: MutationCallbacks) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      invoiceId,
      payload,
    }: {
      invoiceId: string
      payload: UpdateInvoicePayload
    }) => {
      const result = await updateInvoiceAction(invoiceId, payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update invoice')
      }
      return result.data
    },
    onSuccess: (invoice) => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoice state changes affect revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })

      toast.success({
        title: 'Invoice updated',
        description: `Invoice ${invoice.invoiceNumber} has been updated successfully.`,
      })

      callbacks?.onSuccess?.(invoice)
    },
    onError: (error: Error) => {
      toast.error({
        title: 'Failed to update invoice',
        description: error.message,
      })

      callbacks?.onError?.(error)
    },
  })
}
