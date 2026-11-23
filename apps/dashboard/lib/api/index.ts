// Barrel file for @/lib/api exports
// Using explicit exports to avoid naming conflicts

// Client and config (no conflicts)
export * from './client'
export * from './config'
export * from './user'
export * from './analytics'

// Invoice calculator - exports invoiceCalculatorApi and its types
export * from './invoice-calculator'

// Invoices - export api and Invoice type (Agent conflicts with subscriptions)
export {
  invoicesApi,
  type Invoice,
  type InvoiceQueryParams,
  type CreateInvoicePayload,
} from './invoices'

// Pricing - conflicts with PricingTier from invoice-calculator
// Export all except PricingTier (use the one from invoice-calculator)
export {
  pricingPlansApi,
  pricingStrategiesApi,
  type Signal,
  type PricingStrategy,
  type PricingPlan,
  type PricingPlansResponse,
  type GetPricingPlansParams,
  type CreatePricingPlanPayload,
  type CopyPricingPlanPayload,
} from './pricing'

// Subscriptions - has Agent type, export explicitly
export {
  subscriptionsApi,
  type Subscription,
  type CreateSubscriptionPayload,
  type Agent,
} from './subscriptions'

// Payment providers
export * from './payment-providers'
