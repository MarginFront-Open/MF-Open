// Type definitions for pricing configuration
import type {
  PricingStrategy as ApiPricingStrategy,
  PricingPlan as ApiPricingPlan,
  PricingTier,
} from '@/lib/api/pricing'

// Re-export API types. PricingStrategy is widened with creditRates because the
// @/lib/api type has no creditRates field; the server action's own
// PricingStrategy (app/actions/pricing-plans.ts) is the wire contract.
export type PricingStrategy = ApiPricingStrategy & {
  creditRates?: Record<string, number> | null
}
export type PricingPlan = ApiPricingPlan
export type { PricingTier }

// All pricing models the UI can present. Mirrors the Prisma
// enum_pricing_strategies_pricingModel values (lowercase on the wire).
// Not every caller offers every option — seat-based pricing deliberately
// excludes CREDIT_POOL since a pool-of-seats flat fee with per-seat
// overage is not a business shape we support. The narrow SEAT union
// below enforces that.
export type PricingType = 'FLAT' | 'VOLUME' | 'GRADUATED' | 'CREDIT_POOL'

// Seat-based subset — kept intentionally narrow.
export type SeatPricingType = 'FLAT' | 'VOLUME' | 'GRADUATED'

export interface Signal {
  id: string
  name: string
  shortName?: string
  type?: 'ACTIVITY' | 'OUTCOME'
}

export interface PricingOption {
  id: string
  name: string
  enabled: boolean
  type: 'FIXED' | 'VARIABLE'
  billingCycle: 'ONE-TIME' | 'RECURRING'
  price?: number
  billingFrequency?: 'monthly' | 'yearly'
}

export interface SignalPricing {
  signalId: string
  signal?: Signal
  enabled: boolean
  pricingType: PricingType
  price: number
  billingFrequency: 'monthly' | 'yearly'
  tiers?: PricingTier[]
  minimumCommitment?: number | null
  /**
   * Credit-pool burn rates: {signalId: creditsPerUnit}. Undefined
   * on a row that has never held a pool, and then the field is left OUT of the
   * save so an unrated pool's stored NULL stays NULL. `{}` is the clear
   * spelling and IS sent — that's how switching off credit pool releases the
   * members instead of leaving orphan rates on a non-pool row.
   */
  creditRates?: Record<string, number>
}

export interface SeatBasedPricing {
  enabled: boolean
  pricingType: SeatPricingType
  price: number
  billingFrequency: 'monthly' | 'yearly'
  tiers: PricingTier[]
  minimumCommitment: number | null
}

export interface SetupFee {
  enabled: boolean
  price: number
}

export interface PlatformFee {
  enabled: boolean
  price: number
  billingFrequency: 'monthly' | 'yearly'
}
