import { useToast } from '@/hooks/use-toast'
import type { PricingType } from '../types'

interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

interface SignalPricing {
  signalId: string
  signal?: {
    id: string
    name: string
    shortName?: string
    type?: 'ACTIVITY' | 'OUTCOME'
  }
  enabled: boolean
  pricingType: PricingType
  price: number
  billingFrequency: 'monthly' | 'yearly'
  tiers?: PricingTier[]
  minimumCommitment?: number | null
  creditRates?: Record<string, number>
}

interface PricingOption {
  id: string
  name: string
  enabled: boolean
  type: 'FIXED' | 'VARIABLE'
  billingCycle: 'ONE-TIME' | 'RECURRING'
  price?: number
  billingFrequency?: 'monthly' | 'yearly'
}

export function usePricingValidation() {
  const { toast } = useToast()

  const validateNonNegative = (value: number, fieldName: string): boolean => {
    if (value < 0) {
      toast({
        variant: 'destructive',
        title: `Invalid ${fieldName}`,
        description: `${fieldName} cannot be negative`,
      })
      return false
    }
    return true
  }

  const validateTierStructure = (
    tiers: PricingTier[],
    signalName?: string
  ): boolean => {
    if (!tiers || tiers.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Invalid Tiers',
        description: `${signalName || 'Pricing'} needs at least one tier`,
      })
      return false
    }

    // Check for valid tier structure (increasing lower bounds)
    for (let i = 1; i < tiers.length; i++) {
      const prevTier = tiers[i - 1]
      const currTier = tiers[i]
      if (prevTier.upper === null || currTier.lower <= prevTier.lower) {
        toast({
          variant: 'destructive',
          title: 'Invalid Tier Structure',
          description: `${signalName || 'Pricing'} has invalid tier structure`,
        })
        return false
      }
    }

    return true
  }

  const canAddTier = (tiers: PricingTier[]): boolean => {
    if (!tiers || tiers.length === 0) return false

    const lastTier = tiers[tiers.length - 1]
    // Allow zero price - only require valid tier bounds
    return (
      lastTier.upper !== null &&
      lastTier.upper > lastTier.lower &&
      lastTier.rate >= 0
    )
  }

  const validatePricingForm = (
    planId: string,
    pricingOptions: PricingOption[],
    signalPricing: SignalPricing[],
    // Live pools the plan ALREADY has saved (server grandfather clause): a
    // plan already carrying two pools stays savable; only ADDING one is blocked.
    savedLivePoolCount: number = 0,
    // Name of a saved live pool held by a signal NOT loaded into this form
    // (another agent's signal on a shared plan). Such a pool never appears in
    // signalPricing, so enabling any visible pool alongside it must fail
    // here, not at the server round-trip.
    hiddenPoolName: string | null = null
  ): boolean => {
    if (!planId) {
      toast({
        variant: 'destructive',
        title: 'Missing Plan ID',
        description: 'Please enter a Pricing Plan ID',
      })
      return false
    }

    // Check that at least one pricing option is enabled
    const hasEnabledOption = pricingOptions.some((option) => option.enabled)
    if (!hasEnabledOption) {
      toast({
        variant: 'destructive',
        title: 'No Pricing Enabled',
        description: 'Please enable at least one pricing option',
      })
      return false
    }

    // One active credit pool per plan — same rule the server enforces
    // (validateSinglePoolPerPlan): the ledger mints one pool balance per
    // subscription, so a second pool would bill separately while drawing
    // from the same balance. Catch it here before the round-trip.
    const poolSignals = signalPricing.filter(
      (p) => p.enabled && p.pricingType === 'CREDIT_POOL'
    )
    if (poolSignals.length > 0 && hiddenPoolName) {
      toast({
        variant: 'destructive',
        title: 'One Credit Pool Per Plan',
        description: `This plan's active credit pool lives on "${hiddenPoolName}", which isn't shown on this screen. Remove that pool first, or put this signal on its own plan.`,
      })
      return false
    }
    if (
      poolSignals.length > 1 &&
      poolSignals.length > Math.max(1, savedLivePoolCount)
    ) {
      const names = poolSignals
        .map((p) => `"${p.signal?.name ?? 'unnamed signal'}"`)
        .join(', ')
      toast({
        variant: 'destructive',
        title: 'One Credit Pool Per Plan',
        description:
          poolSignals.length === 2
            ? `${names.replace(', ', ' and ')} are both set to credit pool. Keep one, or move the other to its own plan.`
            : `${names} are all set to credit pool. Keep one, and move the others to their own plans.`,
      })
      return false
    }

    // Validate tier configurations for signal pricing
    for (const pricing of signalPricing) {
      if (!pricing.enabled) continue

      if (
        pricing.pricingType === 'VOLUME' ||
        pricing.pricingType === 'GRADUATED'
      ) {
        if (!validateTierStructure(pricing.tiers || [], pricing.signal?.name)) {
          return false
        }
      }

      // CREDIT_POOL uses a dedicated two-tier shape whose bounds overlap
      // intentionally (tiers[1].lower === tiers[0].upper). validateTierStructure
      // would flag that as an error, so we validate separately.
      if (pricing.pricingType === 'CREDIT_POOL') {
        const t = pricing.tiers
        if (!t || t.length !== 2) {
          toast({
            variant: 'destructive',
            title: 'Invalid Credit Pool',
            description: `${pricing.signal?.name ?? 'Credit pool'} is missing its pool + overage tiers`,
          })
          return false
        }
        const poolSize = t[0].upper ?? 0
        const poolFee = t[0].rate
        const overageRate = t[1].rate
        if (poolSize <= 0) {
          toast({
            variant: 'destructive',
            title: 'Invalid Pool Size',
            description: `${pricing.signal?.name ?? 'Credit pool'} needs a pool size greater than zero`,
          })
          return false
        }
        if (poolFee < 0 || overageRate < 0) {
          toast({
            variant: 'destructive',
            title: 'Invalid Rate',
            description: `${pricing.signal?.name ?? 'Credit pool'} rates cannot be negative`,
          })
          return false
        }

        // Burn rates — the friendly front door to the two rules the
        // server enforces on creditRates: every rate is a real number above
        // zero, and no member metric also bills on its own.
        const poolName = pricing.signal?.name ?? 'Credit pool'
        const rates = pricing.creditRates ?? {}
        const metricName = (signalId: string) =>
          signalPricing.find((sp) => sp.signalId === signalId)?.signal?.name ??
          signalId

        for (const [memberSignalId, rate] of Object.entries(rates)) {
          if (!Number.isFinite(rate) || rate <= 0) {
            // The pool's OWN metric can't leave its own pool, and row 1 has no
            // remove button, so "take it out" is not an escape it has. Its only
            // way out is a real rate.
            const escape =
              memberSignalId === pricing.signalId
                ? 'The pool metric always burns its own pool, so give it a rate greater than zero.'
                : 'To make it free, remove it from the pool instead of setting zero.'
            toast({
              variant: 'destructive',
              title: 'Invalid Burn Rate',
              description: `"${metricName(memberSignalId)}" needs a burn rate greater than zero, because that's how many credits one unit of it takes out of ${poolName}. ${escape}`,
            })
            return false
          }
        }

        for (const memberSignalId of Object.keys(rates)) {
          if (memberSignalId === pricing.signalId) continue
          const rival = signalPricing.find(
            (sp) => sp.signalId === memberSignalId && sp.enabled
          )
          if (rival) {
            toast({
              variant: 'destructive',
              title: 'Metric Priced Twice',
              description: `"${metricName(memberSignalId)}" burns credits from ${poolName} and has its own pricing switched on, so the customer would pay twice for one unit of work. A metric either burns pool credits or bills per unit. Switch its own pricing off, or take it out of the pool.`,
            })
            return false
          }
        }
      }
    }

    return true
  }

  return {
    validateNonNegative,
    validateTierStructure,
    canAddTier,
    validatePricingForm,
  }
}
