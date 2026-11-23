/**
 * Service Pricing Types
 *
 * Shared type definition used by the API route and the frontend hook.
 * The actual data lives in the service_pricing database table,
 * populated by: packages/db/scripts/sync-service-pricing.ts
 */

export interface ServicePricingEntry {
  id: string
  canonicalName: string
  displayName: string
  provider: string
  serviceType: string
  inputCost: number | null
  outputCost: number | null
  // Null means NO published rate, which is not a free one — the guard refuses
  // the first and prices the second.
  cacheReadCost: number | null
  cacheWriteCost: number | null
  costUnit: string
  contextWindow: number | null
  isApi: boolean
}
