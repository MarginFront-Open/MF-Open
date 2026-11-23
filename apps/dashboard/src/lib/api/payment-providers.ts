/**
 * Payment Providers API
 *
 * Client for the payment provider endpoints. Stripe is the one provider.
 */
import apiClient, { formatUrl, getOrgId } from './client'
import { API_BASE_URL } from './config'

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Supported payment provider types. Add a provider here when you add its
 * adapter to the API.
 */
export type PaymentProviderType = 'stripe'

/**
 * Normalized payment status across all providers
 * Maps provider-specific statuses to these unified values
 */
export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'refunded'
  | 'disputed'

/**
 * Refund status
 */
export type RefundStatus = 'pending' | 'succeeded' | 'failed'

/**
 * Payment provider configuration stored per organization
 */
export interface PaymentProvider {
  id: string
  organizationId: string
  type: PaymentProviderType
  code: string // User-defined identifier (e.g., 'stripe_us', 'stripe_eu')
  name: string // Display name
  isDefault: boolean
  isActive: boolean
  settings: PaymentProviderSettings
  // Note: secrets are never returned to frontend
  createdAt: string
  updatedAt: string
}

/**
 * Non-sensitive provider settings
 */
export interface PaymentProviderSettings {
  webhookId?: string
  successRedirectUrl?: string
  cancelRedirectUrl?: string
  supports3ds?: boolean
  /**
   * How the provider was connected. 'oauth' means the connect-flow handled
   * webhook registration on the merchant's behalf (Stripe Connect).
   * Anything else ('api_keys', or unset) means the merchant pasted
   * credentials manually and must set up the webhook themselves.
   */
  source?: 'oauth' | 'api_keys'
  [key: string]: unknown
}

/**
 * Payment transaction record
 */
export interface PaymentTransaction {
  id: string
  organizationId: string
  paymentProviderId: string
  invoiceId: string
  customerId: string
  amountCents: number
  currency: string
  status: PaymentStatus
  providerTransactionId?: string
  providerCustomerId?: string
  errorCode?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
  processedAt?: string
}

/**
 * Checkout session for hosted payment pages (Stripe Checkout, etc.)
 */
export interface CheckoutSession {
  sessionId: string
  url: string
  expiresAt: string
}

/**
 * Response from creating a checkout session
 */
export interface CreateCheckoutResponse {
  success: boolean
  session: CheckoutSession
}

/**
 * Request to create a checkout session for an invoice
 */
export interface CreateCheckoutRequest {
  successUrl?: string
  cancelUrl?: string
}

/**
 * Payment provider connection request (for settings)
 */
export interface ConnectProviderRequest {
  type: PaymentProviderType
  code?: string
  name?: string
  apiKey: string
  secretKey?: string
  webhookSecret?: string
  isDefault?: boolean
}

/**
 * Payment provider update request
 */
export interface UpdateProviderRequest {
  name?: string
  isDefault?: boolean
  isActive?: boolean
  settings?: Partial<PaymentProviderSettings>
}

/**
 * Payment status for public invoice
 */
export interface InvoicePaymentStatus {
  invoiceId: string
  isPaid: boolean
  status: PaymentStatus
  lastPaymentAttempt?: PaymentTransaction
  paymentEnabled: boolean // Whether org has payment provider configured
}

// =============================================================================
// API METHODS - AUTHENTICATED (Organization)
// =============================================================================

export const paymentProvidersApi = {
  /**
   * Get all payment providers for the organization
   */
  getProviders: async (): Promise<PaymentProvider[]> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/payment-providers`, {})
    const response = await apiClient.get(url)
    return response.data
  },

  /**
   * Get a specific payment provider
   */
  getProvider: async (providerId: string): Promise<PaymentProvider> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/payment-providers/${providerId}`, {})
    const response = await apiClient.get(url)
    return response.data
  },

  /**
   * Connect a new payment provider (e.g., add Stripe API keys)
   */
  connectProvider: async (
    data: ConnectProviderRequest
  ): Promise<PaymentProvider> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/payment-providers`, {})
    const response = await apiClient.post(url, data)
    return response.data
  },

  /**
   * Update a payment provider
   */
  updateProvider: async (
    providerId: string,
    data: UpdateProviderRequest
  ): Promise<PaymentProvider> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/payment-providers/${providerId}`, {})
    const response = await apiClient.patch(url, data)
    return response.data
  },

  /**
   * Disconnect (delete) a payment provider
   */
  disconnectProvider: async (providerId: string): Promise<void> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/payment-providers/${providerId}`, {})
    await apiClient.delete(url)
  },

  /**
   * Get payment transactions for an invoice
   */
  getInvoiceTransactions: async (
    invoiceId: string
  ): Promise<PaymentTransaction[]> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/invoices/${invoiceId}/payments`, {})
    const response = await apiClient.get(url)
    return response.data
  },
}

// =============================================================================
// API METHODS - PUBLIC (No Auth Required)
// =============================================================================

export const publicPaymentApi = {
  /**
   * Create a checkout session for a public invoice
   * This is called from the public invoice page (/i/:invoiceId)
   * No authentication required - uses invoice ID as identifier
   */
  createCheckoutSession: async (
    invoiceId: string,
    data?: CreateCheckoutRequest
  ): Promise<CreateCheckoutResponse> => {
    const response = await fetch(
      `${API_BASE_URL}/public/invoices/${invoiceId}/checkout`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data || {}),
      }
    )

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: 'Payment not available' }))
      throw new Error(error.message || 'Failed to create checkout session')
    }

    return response.json()
  },

  /**
   * Get payment status for a public invoice
   * Used to check if invoice is paid after redirect from payment
   */
  getPaymentStatus: async (
    invoiceId: string
  ): Promise<InvoicePaymentStatus> => {
    const response = await fetch(
      `${API_BASE_URL}/public/invoices/${invoiceId}/payment-status`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.ok) {
      throw new Error('Failed to get payment status')
    }

    return response.json()
  },
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get display name for payment provider type
 */
export function getProviderDisplayName(type: PaymentProviderType): string {
  const names: Record<PaymentProviderType, string> = {
    stripe: 'Stripe',
  }
  return names[type] || type
}

/**
 * Get status display info
 */
export function getPaymentStatusInfo(status: PaymentStatus): {
  label: string
  color: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  const statusMap: Record<
    PaymentStatus,
    {
      label: string
      color: 'default' | 'secondary' | 'destructive' | 'outline'
    }
  > = {
    pending: { label: 'Pending', color: 'outline' },
    processing: { label: 'Processing', color: 'secondary' },
    requires_action: { label: 'Action Required', color: 'secondary' },
    succeeded: { label: 'Succeeded', color: 'default' },
    failed: { label: 'Failed', color: 'destructive' },
    canceled: { label: 'Canceled', color: 'outline' },
    refunded: { label: 'Refunded', color: 'outline' },
    disputed: { label: 'Disputed', color: 'destructive' },
  }
  return statusMap[status] || { label: status, color: 'outline' }
}

/**
 * Check if a payment provider type is currently supported
 */
export function isProviderSupported(type: string): type is PaymentProviderType {
  const supported: PaymentProviderType[] = ['stripe']
  return supported.includes(type as PaymentProviderType)
}

/**
 * Get list of supported providers
 */
export function getSupportedProviders(): {
  type: PaymentProviderType
  name: string
  available: boolean
}[] {
  return [{ type: 'stripe', name: 'Stripe', available: true }]
}
