/**
 * API Configuration
 * This file contains all API-related configuration, including base URL,
 * timeout settings, and endpoint definitions.
 */

// API Base URL — requires NEXT_PUBLIC_API_BASE_URL to be set in .env
if (!process.env.NEXT_PUBLIC_API_BASE_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL is not set. Add it to your .env file (e.g. NEXT_PUBLIC_API_BASE_URL="http://localhost:4000/v1")'
  )
}
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL

// API Request Timeout (in milliseconds)
export const API_TIMEOUT = 30000

/**
 * API Endpoints
 * Centralized definition of all API endpoints used in the application
 */
export const API_ENDPOINTS = {
  // Authentication related endpoints
  AUTH: {
    LOGIN: '/auth/login',
    REGISTER: '/auth/register',
    REFRESH_TOKEN: '/auth/refresh-tokens',
    FORGOT_PASSWORD: '/auth/forgot-password',
    SEND_RESET_PASSWORD_OTP: '/auth/send-reset-password-otp',
    RESET_PASSWORD: '/auth/reset-password',
    VERIFY_OTP: '/auth/verify-email',
    LOGOUT: '/auth/logout',
    GOOGLE_LOGIN: '/auth/google',
    GOOGLE_CALLBACK: '/auth/google/callback',
  },

  // User related endpoints
  USER: {
    PROFILE: '/users/me',
    UPDATE_PROFILE: '/users/me',
  },

  // Organization related endpoints
  ORGANIZATION: {
    CURRENT: '/organizations/current',
    CREATE: '/organizations',
    UPDATE: '/organizations',
    DELETE: '/organizations',
  },

  // Agents related endpoints
  AGENTS: {
    BASE: '/org/:orgId/agents',
    DETAIL: '/org/:orgId/agents/:agentId',
    SIGNALS: '/org/:orgId/agents/:agentId/signals',
  },

  // API Keys related endpoints
  API_KEYS: {
    BASE: '/org/:orgId/developer/api-keys',
    DETAIL: '/org/:orgId/developer/api-keys/:keyId',
    REVOKE: '/org/:orgId/developer/api-keys/:keyId/revoke',
  },

  // Customers related endpoints
  CUSTOMERS: {
    BASE: '/org/:orgId/customers',
    DETAIL: '/org/:orgId/customers/:customerId',
  },

  // Pricing plans related endpoints
  PRICING_PLANS: {
    BASE: '/org/:orgId/pricing-plans',
    DETAIL: '/org/:orgId/pricing-plans/:planId',
    STRATEGIES: '/org/:orgId/pricing-plans/:planId/pricing-strategies',
    STRATEGY_DETAIL:
      '/org/:orgId/pricing-plans/:planId/pricing-strategies/:strategyId',
  },

  // Analytics related endpoints
  ANALYTICS: {
    USAGE: '/org/:orgId/analytics/usage',
    COSTS: '/org/:orgId/analytics/costs',
    SUBSCRIPTION: '/org/:orgId/analytics/subscription/:subscriptionId',
    CUSTOMER: '/org/:orgId/analytics/customer',
    AGENT: '/org/:orgId/analytics/agent',
    REVENUE: '/org/:orgId/analytics/revenue',
    PROFITABILITY: '/org/:orgId/analytics/profitability',
    EVENTS_AGGREGATE: '/org/:orgId/analytics/events/aggregate',
  },

  // Signal events related endpoints
  SIGNAL_EVENTS: {
    BASE: '/org/:orgId/events',
    DETAIL: '/org/:orgId/events/:eventId',
  },

  // Filters related endpoints
  FILTERS: {
    BASE: '/org/:orgId/filters',
  },

  // Invoices related endpoints
  INVOICES: {
    BASE: '/org/:orgId/invoices',
    DETAIL: '/org/:orgId/invoices/:invoiceId',
    PDF: '/org/:orgId/invoices/:invoiceId/pdf',
  },

  // Subscriptions related endpoints
  SUBSCRIPTIONS: {
    BASE: '/org/:orgId/subscriptions',
    DETAIL: '/org/:orgId/subscriptions/:subscriptionId',
    RENEW: '/org/:orgId/subscriptions/:subscriptionId/renew',
  },

  // Payment providers related endpoints
  PAYMENT_PROVIDERS: {
    BASE: '/org/:orgId/payment-providers',
    DETAIL: '/org/:orgId/payment-providers/:providerId',
  },

  // Payment transactions related endpoints
  PAYMENTS: {
    INVOICE_PAYMENTS: '/org/:orgId/invoices/:invoiceId/payments',
    REFUND: '/org/:orgId/payments/:transactionId/refund',
  },

  // Public payment endpoints (no auth)
  PUBLIC_PAYMENTS: {
    CHECKOUT: '/public/invoices/:invoiceId/checkout',
    STATUS: '/public/invoices/:invoiceId/payment-status',
  },

  // Webhook endpoints
  WEBHOOKS: {
    STRIPE: '/webhooks/stripe',
  },
}
