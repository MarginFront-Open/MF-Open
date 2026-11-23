import apiClient, { formatUrl, getOrgId } from './client'
import { PaginatedResponse } from './subscriptions'

// Check if mock data should be used
const _USE_MOCK_INVOICES = process.env.NEXT_PUBLIC_USE_MOCK_INVOICES === 'true'

// Types
export interface Invoice {
  id: string
  customerId: string
  subscriptionId: string
  invoiceDate: string
  dueDate: string
  billingPeriodStart: string
  billingPeriodEnd: string
  totalAmount: string
  subtotal: string
  taxAmount: string
  discountAmount: string
  amountPaid: string
  amountCredited: string
  amountDue: string
  status: 'pending' | 'paid' | 'overdue' | 'void' | 'draft' | 'issued'
  invoiceNumber: string
  pdfPath?: string
  pdfUrl?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
  // Reminder tracking fields
  reminderStage?:
    | 'none'
    | 'pre_due_1'
    | 'pre_due_2'
    | 'post_due_1'
    | 'post_due_2'
    | 'post_due_3'
    | 'escalated'
  reminderCount?: number
  lastReminderSentAt?: string
  nextReminderDate?: string
  reminderPaused?: boolean
  escalatedAt?: string
  escalationReason?: string
  // These fields are included only when includeDetails=true
  customer?: Customer
  subscription?: InvoiceSubscription
}

export interface Customer {
  id: string
  name: string
  email: string
  // other customer fields
}

export interface InvoiceSubscription {
  id: string
  name: string
  startDate: string
  endDate?: string
  status: 'active' | 'canceled' | 'expired' | 'pending'
  billingCycle: 'monthly' | 'yearly' | 'custom'
  // other subscription fields
  plan?: PricingPlan
  agent?: Agent
}

export interface PricingPlan {
  id: string
  name: string
  // other plan fields
}

export interface Agent {
  id: string
  name: string
  // other agent fields
}

export interface InvoiceQueryParams {
  // Filtering by IDs
  subscriptionId?: string
  planId?: string
  agentId?: string
  customerId?: string
  search?: string

  // Filtering by Status
  status?: 'pending' | 'paid' | 'overdue' | 'void'
  billingCycle?: 'monthly' | 'yearly' | 'custom'

  // Date Range Filters
  invoiceDateBefore?: string
  invoiceDateAfter?: string
  /** 'include-scheduled' lifts the default "dated today or earlier" bound. */
  dateScope?: 'include-scheduled'
  dueDateBefore?: string
  dueDateAfter?: string
  billingPeriodStartBefore?: string
  billingPeriodStartAfter?: string
  billingPeriodEndBefore?: string
  billingPeriodEndAfter?: string

  // Additional Options
  includeDetails?: boolean

  // Pagination & Sorting
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

// Payment data for mark as paid
export interface MarkPaidPayload {
  paymentMethod?: 'credit_card' | 'bank_transfer' | 'check' | 'cash' | 'other'
  reference?: string
  notes?: string
}

// Void invoice payload
export interface VoidInvoicePayload {
  reason?: string
}

// Line item for creating/updating invoices
export interface InvoiceLineItemPayload {
  id?: string // Only for updates
  description: string
  quantity: number
  unitPrice: number
  type?: 'recurring' | 'usage' | 'onetime' | 'tax' | 'discount' | 'seat_based'
  metadata?: Record<string, unknown>
}

// Create invoice payload
export interface CreateInvoicePayload {
  customerId: string
  subscriptionId?: string | null
  invoiceDate?: string
  dueDate: string
  billingPeriodStart?: string
  billingPeriodEnd?: string
  currency?: string
  taxAmount?: number
  discountAmount?: number
  memo?: string
  status?: 'draft' | 'issued'
  items: InvoiceLineItemPayload[]
}

// Update invoice payload
export interface UpdateInvoicePayload {
  customerId?: string
  invoiceDate?: string
  dueDate?: string
  billingPeriodStart?: string
  billingPeriodEnd?: string
  taxAmount?: number
  discountAmount?: number
  memo?: string
  items?: InvoiceLineItemPayload[]
}

// Send invoice email payload
export interface SendInvoicePayload {
  recipientEmail?: string
  subject?: string
  message?: string
}

// Send invoice email response
export interface SendInvoiceResponse {
  success: boolean
  emailId: string | null
  recipientEmail: string
}

// Reminder status response
export interface ReminderStatusResponse {
  invoiceId: string
  status: string
  dueDate: string
  daysFromDue: number
  isOverdue: boolean
  reminderStage: string
  reminderCount: number
  lastReminderSentAt: string | null
  nextReminderDate: string | null
  reminderPaused: boolean
  escalatedAt: string | null
  escalationReason: string | null
  pauseReason: string | null
  lastManualReminderAt: string | null
}

// Pause reminders payload
export interface PauseRemindersPayload {
  reason?: string
}

// Reminder action response
export interface ReminderActionResponse {
  success: boolean
  invoiceId: string
  reminderPaused?: boolean
  message: string
  emailSent?: boolean
  emailId?: string | null
  recipientEmail?: string
}

// Payment with enhanced details
export interface InvoicePayment {
  id: string
  invoiceId: string
  amount: string
  paymentDate: string
  paymentMethod: 'stripe' | 'ach' | 'wire' | 'check' | 'cash' | 'other'
  reference?: string
  notes?: string
  status: 'succeeded' | 'failed' | 'pending'
  currency: string
  providerTransactionId?: string
  providerCheckoutSessionId?: string
  cardLast4?: string
  cardBrand?: string
  receiptUrl?: string
  providerFee?: string
  netAmount?: string
  refundedAmount?: string
  refundStatus?: 'none' | 'partial' | 'full'
  createdAt: string
  refunds?: Refund[]
}

// Refund type
export interface Refund {
  id: string
  invoicePaymentId: string
  amount: string
  currency: string
  reason?: string
  status: 'pending' | 'succeeded' | 'failed' | 'canceled'
  providerRefundId?: string
  errorCode?: string
  errorMessage?: string
  processedAt?: string
  createdAt: string
}

// Enhanced payment history response
export interface EnhancedPaymentHistoryResponse {
  payments: InvoicePayment[]
  summary: {
    totalPaid: number
    totalRefunded: number
    netAmount: number
    paymentCount: number
    refundCount: number
  }
}

// Create refund payload
export interface CreateRefundPayload {
  amount?: number
  reason?: string
}

// Refund response
export interface RefundResponse {
  id: string
  amount: number
  currency: string
  status: string
  providerRefundId: string
  paymentId: string
  invoiceId: string
}

// Helper to clean params - removes empty strings, null, and undefined values
const cleanParams = <T extends object>(params?: T): Partial<T> | undefined => {
  if (!params) return undefined

  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    // Keep value if it's not empty string, null, or undefined
    if (value !== '' && value !== null && value !== undefined) {
      cleaned[key] = value
    }
  }
  return Object.keys(cleaned).length > 0 ? (cleaned as Partial<T>) : undefined
}

// API methods
export const invoicesApi = {
  // Get all invoices for an organization with filtering
  getInvoices: async (params?: InvoiceQueryParams) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/invoices`, {})
    // Clean params to remove empty strings before sending to API
    const response = await apiClient.get(url, { params: cleanParams(params) })
    return response.data as PaginatedResponse<Invoice>
  },

  // Get a specific invoice by ID
  getInvoice: async (invoiceId: string, includeDetails?: boolean) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}`, {})
    const response = await apiClient.get(url, {
      params: { includeDetails },
    })
    return response.data as Invoice
  },

  // Download invoice PDF
  downloadInvoicePdf: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/pdf`, {})
    const response = await apiClient.get(url, {
      responseType: 'blob',
    })
    return response.data
  },

  // Finalize a draft invoice
  finalize: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/finalize`, {})
    const response = await apiClient.post(url)
    return response.data as Invoice
  },

  // Mark invoice as paid
  markPaid: async (invoiceId: string, payload?: MarkPaidPayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/mark-paid`, {})
    const response = await apiClient.post(url, payload || {})
    return response.data as { invoice: Invoice; payment: unknown }
  },

  // Void an invoice
  voidInvoice: async (invoiceId: string, payload?: VoidInvoicePayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/void`, {})
    const response = await apiClient.post(url, payload || {})
    return response.data as Invoice
  },

  // Create a new invoice
  createInvoice: async (payload: CreateInvoicePayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/invoices`, {})
    const response = await apiClient.post(url, payload)
    return response.data as Invoice
  },

  // Update a draft invoice
  updateInvoice: async (invoiceId: string, payload: UpdateInvoicePayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}`, {})
    const response = await apiClient.put(url, payload)
    return response.data as Invoice
  },

  // Send invoice email to customer
  sendInvoiceEmail: async (invoiceId: string, payload?: SendInvoicePayload) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/send`, {})
    const response = await apiClient.post(url, payload || {})
    return response.data as SendInvoiceResponse
  },

  // Get reminder status for an invoice
  getReminderStatus: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/reminders`, {})
    const response = await apiClient.get(url)
    return response.data as ReminderStatusResponse
  },

  // Pause automated reminders for an invoice
  pauseReminders: async (
    invoiceId: string,
    payload?: PauseRemindersPayload
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/reminders/pause`,
      {}
    )
    const response = await apiClient.post(url, payload || {})
    return response.data as ReminderActionResponse
  },

  // Resume automated reminders for an invoice
  resumeReminders: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/reminders/resume`,
      {}
    )
    const response = await apiClient.post(url)
    return response.data as ReminderActionResponse
  },

  // Send a manual reminder for an invoice
  sendManualReminder: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/reminders/send`,
      {}
    )
    const response = await apiClient.post(url)
    return response.data as ReminderActionResponse
  },

  // Get enhanced payment history with card details and refunds
  getEnhancedPayments: async (invoiceId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/payments/enhanced`,
      {}
    )
    const response = await apiClient.get(url)
    return response.data as EnhancedPaymentHistoryResponse
  },

  // Get a single payment with details
  getPayment: async (invoiceId: string, paymentId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')
    if (!paymentId) throw new Error('Payment ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/payments/${paymentId}`,
      {}
    )
    const response = await apiClient.get(url)
    return response.data as InvoicePayment
  },

  // Create a refund for a payment
  createRefund: async (
    invoiceId: string,
    paymentId: string,
    payload?: CreateRefundPayload
  ) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')
    if (!paymentId) throw new Error('Payment ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/payments/${paymentId}/refund`,
      {}
    )
    const response = await apiClient.post(url, payload || {})
    return response.data as RefundResponse
  },

  // Get refunds for a payment
  getPaymentRefunds: async (invoiceId: string, paymentId: string) => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!invoiceId) throw new Error('Invoice ID is required')
    if (!paymentId) throw new Error('Payment ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoices/${invoiceId}/payments/${paymentId}/refunds`,
      {}
    )
    const response = await apiClient.get(url)
    return response.data as { refunds: Refund[] }
  },
}
