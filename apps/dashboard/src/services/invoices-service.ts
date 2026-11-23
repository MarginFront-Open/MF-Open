/**
 * Invoices Service
 * Handles all invoice-related API operations with React Query integration
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getInvoices as getInvoicesAction,
  getInvoice as getInvoiceAction,
  createInvoice as createInvoiceAction,
  updateInvoice as updateInvoiceAction,
  finalizeInvoice as finalizeInvoiceAction,
  markInvoicePaid as markInvoicePaidAction,
  voidInvoice as voidInvoiceAction,
  getInvoicePayments as getInvoicePaymentsAction,
  getReminderStatus as getReminderStatusAction,
  pauseReminders as pauseRemindersAction,
  resumeReminders as resumeRemindersAction,
  deleteInvoice as deleteInvoiceAction,
  type Invoice,
  type CreateInvoicePayload,
  type UpdateInvoicePayload,
  type MarkPaidPayload,
  type InvoicePayment,
} from '@/app/actions/invoices'
import {
  Invoice as LegacyInvoice,
  InvoiceQueryParams,
} from '@/lib/api/invoices'
import { analyticsKeys } from './analytics-service'
import { useToast } from '@/hooks/use-toast'

// Query Keys
export const INVOICES_KEYS = {
  all: ['invoices'] as const,
  lists: () => [...INVOICES_KEYS.all, 'list'] as const,
  list: (filters?: InvoiceQueryParams) =>
    [...INVOICES_KEYS.lists(), filters] as const,
  details: () => [...INVOICES_KEYS.all, 'detail'] as const,
  detail: (id: string, includeDetails?: boolean) =>
    [...INVOICES_KEYS.details(), id, includeDetails] as const,
  payments: (id: string) => [...INVOICES_KEYS.all, 'payments', id] as const,
  reminders: (id: string) => [...INVOICES_KEYS.all, 'reminders', id] as const,
}

/**
 * React Query Hooks
 */

/**
 * Hook to fetch invoices with pagination and filters via Server Action
 * Uses React Query's useQuery for state management and caching
 */
export const useInvoices = (params: InvoiceQueryParams = {}) => {
  return useQuery({
    queryKey: INVOICES_KEYS.list(params),
    queryFn: async () => {
      const result = await getInvoicesAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch invoices')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook to fetch a single invoice by ID via Server Action
 * Uses React Query's useQuery for state management and caching
 */
export const useInvoice = (invoiceId: string, includeDetails?: boolean) => {
  return useQuery({
    queryKey: INVOICES_KEYS.detail(invoiceId, includeDetails),
    queryFn: async () => {
      const result = await getInvoiceAction(invoiceId, includeDetails)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch invoice')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!invoiceId,
  })
}

/**
 * Hook to create a new invoice via Server Action
 */
export const useCreateInvoice = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: CreateInvoicePayload) => {
      const result = await createInvoiceAction(data)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create invoice')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Invoice created',
        description: 'Invoice has been created successfully',
      })
      // Use INVOICES_KEYS.all to prefix-match list, detail variants,
      // payments, and reminders keys in one call. Detail page reader
      // uses detail(id, true) which only the broad prefix catches.
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating invoice',
        description: error.message || 'Failed to create invoice',
      })
    },
  })
}

/**
 * Hook to update an invoice via Server Action
 */
export const useUpdateInvoice = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      invoiceId,
      data,
    }: {
      invoiceId: string
      data: UpdateInvoicePayload
    }) => {
      const result = await updateInvoiceAction(invoiceId, data)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update invoice')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: () => {
      toast({
        title: 'Invoice updated',
        description: 'Invoice has been updated successfully',
      })
      // Detail page reader uses INVOICES_KEYS.detail(id, true) — the
      // shape with includeDetails appended. detail(id) doesn't prefix-match
      // it; the broad .all does.
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Invoices feed revenue / billed / collected charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating invoice',
        description: error.message || 'Failed to update invoice',
      })
    },
  })
}

/**
 * Hook to finalize a draft invoice via Server Action
 */
export const useFinalizeInvoice = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await finalizeInvoiceAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to finalize invoice')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: () => {
      toast({
        title: 'Invoice finalized',
        description: 'Invoice has been finalized and issued',
      })
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Finalize moves invoice into billed totals — refresh charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error finalizing invoice',
        description: error.message || 'Failed to finalize invoice',
      })
    },
  })
}

/**
 * Hook to mark invoice as paid via Server Action
 */
export const useMarkInvoicePaid = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      invoiceId,
      payload,
    }: {
      invoiceId: string
      payload?: MarkPaidPayload
    }) => {
      const result = await markInvoicePaidAction(invoiceId, payload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to mark invoice as paid')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: () => {
      toast({
        title: 'Invoice marked as paid',
        description: 'Payment has been recorded successfully',
      })
      // INVOICES_KEYS.all prefix-matches detail variants AND
      // payments(id) AND reminders(id) in one call. PaymentHistoryPanel
      // reads from the canonical payments key, so the panel
      // refreshes through this prefix invalidation.
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Payment moves invoice into collected totals — refresh charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error marking invoice as paid',
        description: error.message || 'Failed to mark invoice as paid',
      })
    },
  })
}

/**
 * Hook to void an invoice via Server Action
 */
export const useVoidInvoice = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      invoiceId,
      reason,
    }: {
      invoiceId: string
      reason?: string
    }) => {
      const result = await voidInvoiceAction(invoiceId, reason)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to void invoice')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: () => {
      toast({
        title: 'Invoice voided',
        description: 'Invoice has been voided successfully',
      })
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.all })
      // Voiding pulls invoice out of billed/collected totals
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error voiding invoice',
        description: error.message || 'Failed to void invoice',
      })
    },
  })
}

/**
 * Hook to delete an invoice via Server Action
 */
export const useDeleteInvoice = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await deleteInvoiceAction(invoiceId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete invoice')
      }
      return invoiceId
    },
    onSuccess: (invoiceId) => {
      toast({
        title: 'Invoice deleted',
        description: 'Invoice has been deleted successfully',
      })
      // Scope removeQueries to the specific deleted invoice so other
      // invoice detail tabs open in the browser don't flash a loading
      // spinner. Both detail(id) and detail(id, true) shapes get
      // cleared so any reader (with or without includeDetails) loses
      // its cache for the deleted row.
      queryClient.removeQueries({
        queryKey: INVOICES_KEYS.detail(invoiceId, true),
      })
      queryClient.removeQueries({ queryKey: INVOICES_KEYS.detail(invoiceId) })
      queryClient.invalidateQueries({ queryKey: INVOICES_KEYS.lists() })
      // Deletion changes billed / collected totals on charts
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting invoice',
        description: error.message || 'Failed to delete invoice',
      })
    },
  })
}

/**
 * Hook to fetch invoice payments via Server Action
 */
export const useInvoicePayments = (invoiceId: string) => {
  return useQuery({
    queryKey: INVOICES_KEYS.payments(invoiceId),
    queryFn: async () => {
      const result = await getInvoicePaymentsAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch invoice payments')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!invoiceId,
  })
}

/**
 * Hook to fetch reminder status via Server Action
 */
export const useReminderStatus = (invoiceId: string) => {
  return useQuery({
    queryKey: INVOICES_KEYS.reminders(invoiceId),
    queryFn: async () => {
      const result = await getReminderStatusAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch reminder status')
      }
      return result.data
    },
    staleTime: 60 * 1000, // 1 minute
    enabled: !!invoiceId,
  })
}

/**
 * Hook to pause reminders via Server Action
 */
export const usePauseReminders = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      invoiceId,
      reason,
    }: {
      invoiceId: string
      reason?: string
    }) => {
      const result = await pauseRemindersAction(invoiceId, reason)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to pause reminders')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: ({ invoiceId }) => {
      toast({
        title: 'Reminders paused',
        description: 'Automated reminders have been paused',
      })
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.reminders(invoiceId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error pausing reminders',
        description: error.message || 'Failed to pause reminders',
      })
    },
  })
}

/**
 * Hook to resume reminders via Server Action
 */
export const useResumeReminders = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const result = await resumeRemindersAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to resume reminders')
      }
      return { data: result.data, invoiceId }
    },
    onSuccess: ({ invoiceId }) => {
      toast({
        title: 'Reminders resumed',
        description: 'Automated reminders have been resumed',
      })
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.reminders(invoiceId),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error resuming reminders',
        description: error.message || 'Failed to resume reminders',
      })
    },
  })
}

// Re-export types for convenience
export type {
  Invoice,
  InvoiceQueryParams,
  CreateInvoicePayload,
  UpdateInvoicePayload,
  MarkPaidPayload,
  InvoicePayment,
}
export type { LegacyInvoice }
