import { useCallback } from 'react'
import { bulkUpdatePlanStrategies as bulkUpdateAction } from '@/app/actions/pricing-plans'
import { useToast } from '@/hooks/use-toast'
import { creditRatesFingerprint } from '../credit-rates'
import type {
  PricingOption,
  SignalPricing,
  SeatBasedPricing,
  SetupFee,
  PlatformFee,
  PricingStrategy,
  PricingType,
  SeatPricingType,
} from '../types'

interface UsePricingOperationsProps {
  agentId: string
  planId: string
  pricingOptions: PricingOption[]
  signalPricing: SignalPricing[]
  seatBasedPricing: SeatBasedPricing
  setupFee: SetupFee
  platformFee: PlatformFee
  originalStrategies: Record<string, PricingStrategy>
  setPricingOptions: React.Dispatch<React.SetStateAction<PricingOption[]>>
  setSignalPricing: React.Dispatch<React.SetStateAction<SignalPricing[]>>
  setSeatBasedPricing: React.Dispatch<React.SetStateAction<SeatBasedPricing>>
  setSetupFee: React.Dispatch<React.SetStateAction<SetupFee>>
  setPlatformFee: React.Dispatch<React.SetStateAction<PlatformFee>>
  setOriginalStrategies: React.Dispatch<
    React.SetStateAction<Record<string, PricingStrategy>>
  >
  setIsSaving: React.Dispatch<React.SetStateAction<boolean>>
}

export function usePricingOperations({
  agentId,
  planId,
  pricingOptions,
  signalPricing,
  seatBasedPricing,
  setupFee,
  platformFee,
  originalStrategies,
  setPricingOptions,
  setSignalPricing,
  setSeatBasedPricing,
  setSetupFee,
  setPlatformFee,
  setOriginalStrategies,
  setIsSaving,
}: UsePricingOperationsProps) {
  const { toast } = useToast()

  // Toggle pricing option
  const togglePricingOption = useCallback(
    (id: string) => {
      setPricingOptions((prev) =>
        prev.map((option) =>
          option.id === id ? { ...option, enabled: !option.enabled } : option
        )
      )

      if (id === 'setup') {
        setSetupFee((prev) => ({ ...prev, enabled: !prev.enabled }))
      } else if (id === 'platform') {
        setPlatformFee((prev) => ({ ...prev, enabled: !prev.enabled }))
      } else if (id === 'seat') {
        setSeatBasedPricing((prev) => ({ ...prev, enabled: !prev.enabled }))
      }
    },
    [setPricingOptions, setSetupFee, setPlatformFee, setSeatBasedPricing]
  )

  // Update setup fee
  const updateSetupFeePrice = useCallback(
    (price: number) => {
      setSetupFee((prev) => ({ ...prev, price }))
      setPricingOptions((prev) =>
        prev.map((option) =>
          option.id === 'setup' ? { ...option, price } : option
        )
      )
    },
    [setSetupFee, setPricingOptions]
  )

  // Update platform fee
  const updatePlatformFeePrice = useCallback(
    (price: number) => {
      setPlatformFee((prev) => ({ ...prev, price }))
      setPricingOptions((prev) =>
        prev.map((option) =>
          option.id === 'platform' ? { ...option, price } : option
        )
      )
    },
    [setPlatformFee, setPricingOptions]
  )

  const updatePlatformFeeBillingFrequency = useCallback(
    (billingFrequency: 'monthly' | 'yearly') => {
      setPlatformFee((prev) => ({ ...prev, billingFrequency }))
      setPricingOptions((prev) =>
        prev.map((option) =>
          option.id === 'platform' ? { ...option, billingFrequency } : option
        )
      )
    },
    [setPlatformFee, setPricingOptions]
  )

  // Signal pricing operations
  const toggleSignalPricing = useCallback(
    (signalId: string) => {
      setSignalPricing((prev) =>
        prev.map((pricing) =>
          pricing.signalId === signalId
            ? { ...pricing, enabled: !pricing.enabled }
            : pricing
        )
      )
    },
    [setSignalPricing]
  )

  const updateSignalPricingType = useCallback(
    (signalId: string, type: PricingType) => {
      setSignalPricing((prev) =>
        prev.map((row) => {
          if (row.signalId !== signalId) return row

          // Leaving the pool model must SEND cleared rates, not omit them: the
          // server merges an omitted creditRates with what's stored, then
          // rejects rates sitting on a non-pool model. `{}` is the clear
          // spelling.
          const pricing =
            type !== 'CREDIT_POOL' && row.pricingType === 'CREDIT_POOL'
              ? { ...row, creditRates: {} }
              : row

          // CREDIT_POOL needs a specific two-tier shape:
          //   tiers[0] = pool   { lower: 0, upper: poolSize, rate: poolFee }
          //   tiers[1] = overage { lower: poolSize, upper: null, rate: overageRate }
          // Initialize with zeros; the user fills in the pool size,
          // pool fee, and overage rate via the CreditPoolInputs component.
          if (type === 'CREDIT_POOL') {
            return {
              ...pricing,
              pricingType: type,
              tiers: [
                { lower: 0, upper: 0, rate: 0 },
                { lower: 0, upper: null, rate: 0 },
              ],
            }
          }
          if (!pricing.tiers || pricing.tiers.length === 0) {
            return {
              ...pricing,
              pricingType: type,
              tiers: [{ lower: 0, upper: null, rate: pricing.price || 0 }],
            }
          }
          if (type === 'FLAT') {
            return {
              ...pricing,
              pricingType: type,
              tiers: [{ lower: 0, upper: null, rate: pricing.price || 0 }],
            }
          }
          // Switching away from CREDIT_POOL (whose tiers[1].lower ===
          // tiers[0].upper) back to VOLUME/GRADUATED — collapse to a
          // single open-ended tier at rate 0 so the generic tier manager
          // has a clean starting point.
          if (
            pricing.pricingType === 'CREDIT_POOL' &&
            (type === 'VOLUME' || type === 'GRADUATED')
          ) {
            return {
              ...pricing,
              pricingType: type,
              tiers: [{ lower: 0, upper: null, rate: 0 }],
            }
          }
          return { ...pricing, pricingType: type }
        })
      )
    },
    [setSignalPricing]
  )

  // Credit-pool-specific handlers. These map the user-facing fields
  // (pool size, pool fee, overage rate) onto the two-tier wire shape
  // without exposing the tiers array to the UI. Idempotent — the handler
  // updates BOTH tiers when the pool size changes so the overage tier's
  // lower bound stays in lockstep with the pool tier's upper.
  const updateSignalPoolSize = useCallback(
    (signalId: string, poolSize: number) => {
      if (poolSize < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Pool Size',
          description: 'Pool size cannot be negative',
        })
        return
      }
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (
            pricing.signalId === signalId &&
            pricing.tiers &&
            pricing.tiers.length >= 2
          ) {
            const updatedTiers = [...pricing.tiers]
            updatedTiers[0] = { ...updatedTiers[0], upper: poolSize }
            updatedTiers[1] = { ...updatedTiers[1], lower: poolSize }
            return { ...pricing, tiers: updatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  const updateSignalPoolFee = useCallback(
    (signalId: string, poolFee: number) => {
      if (poolFee < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Pool Fee',
          description: 'Pool fee cannot be negative',
        })
        return
      }
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (
            pricing.signalId === signalId &&
            pricing.tiers &&
            pricing.tiers.length >= 1
          ) {
            const updatedTiers = [...pricing.tiers]
            updatedTiers[0] = { ...updatedTiers[0], rate: poolFee }
            return { ...pricing, tiers: updatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  const updateSignalOverageRate = useCallback(
    (signalId: string, overageRate: number) => {
      if (overageRate < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Overage Rate',
          description: 'Overage rate cannot be negative',
        })
        return
      }
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (
            pricing.signalId === signalId &&
            pricing.tiers &&
            pricing.tiers.length >= 2
          ) {
            const updatedTiers = [...pricing.tiers]
            updatedTiers[1] = { ...updatedTiers[1], rate: overageRate }
            return { ...pricing, tiers: updatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  // Pool membership. creditRates maps a member signal id to how
  // many pool credits one of its units burns; the pool's own signal is a
  // member at rate 1 whether or not it appears in the map, so an untouched
  // pool keeps an undefined map and its stored NULL.
  const addSignalPoolMember = useCallback(
    (signalId: string, memberSignalId: string) => {
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (pricing.signalId !== signalId) return pricing
          const rates = pricing.creditRates ?? {}
          if (memberSignalId in rates) return pricing
          return { ...pricing, creditRates: { ...rates, [memberSignalId]: 1 } }
        })
      )
    },
    [setSignalPricing]
  )

  const removeSignalPoolMember = useCallback(
    (signalId: string, memberSignalId: string) => {
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (pricing.signalId !== signalId || !pricing.creditRates) {
            return pricing
          }
          const rates = { ...pricing.creditRates }
          delete rates[memberSignalId]
          return { ...pricing, creditRates: rates }
        })
      )
    },
    [setSignalPricing]
  )

  // No negative/zero guard here, deliberately: the sibling pool handlers
  // reject and drop a bad number, which would leave the input showing a value
  // the state doesn't hold. A burn rate has to be STORABLE to be reportable,
  // so validatePricingForm is the single gate and names the metric at save.
  const updateSignalCreditRate = useCallback(
    (signalId: string, memberSignalId: string, rate: number) => {
      setSignalPricing((prev) =>
        prev.map((pricing) =>
          pricing.signalId === signalId
            ? {
                ...pricing,
                creditRates: {
                  ...(pricing.creditRates ?? {}),
                  [memberSignalId]: rate,
                },
              }
            : pricing
        )
      )
    },
    [setSignalPricing]
  )

  const updateSignalTierRate = useCallback(
    (signalId: string, tierIndex: number, rate: number) => {
      if (rate < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Rate',
          description: 'Rate cannot be negative',
        })
        return
      }

      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (pricing.signalId === signalId && pricing.tiers) {
            const updatedTiers = [...pricing.tiers]
            updatedTiers[tierIndex] = { ...updatedTiers[tierIndex], rate }
            return { ...pricing, tiers: updatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  const updateSignalTierUpper = useCallback(
    (signalId: string, tierIndex: number, upper: number | null) => {
      if (upper !== null && upper < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Upper Bound',
          description: 'Upper bound cannot be negative',
        })
        return
      }

      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (pricing.signalId === signalId && pricing.tiers) {
            const updatedTiers = [...pricing.tiers]
            updatedTiers[tierIndex] = { ...updatedTiers[tierIndex], upper }
            // Update the next tier's lower bound to be upper + 1
            if (upper !== null && tierIndex + 1 < updatedTiers.length) {
              updatedTiers[tierIndex + 1] = {
                ...updatedTiers[tierIndex + 1],
                lower: upper + 1,
              }
            }
            return { ...pricing, tiers: updatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  const addSignalTier = useCallback(
    (signalId: string, canAdd: boolean) => {
      if (!canAdd) {
        toast({
          variant: 'destructive',
          title: 'Cannot Add Tier',
          description:
            'Please fill in both the "to" value and price for the current tier',
        })
        return
      }

      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (pricing.signalId === signalId && pricing.tiers) {
            const lastTier = pricing.tiers[pricing.tiers.length - 1]
            const newTier = {
              lower:
                lastTier.upper !== null
                  ? lastTier.upper + 1
                  : lastTier.lower + 1,
              upper: null,
              rate: 0,
            }
            return { ...pricing, tiers: [...pricing.tiers, newTier] }
          }
          return pricing
        })
      )
    },
    [setSignalPricing, toast]
  )

  const deleteSignalTier = useCallback(
    (signalId: string, tierIndex: number) => {
      setSignalPricing((prev) =>
        prev.map((pricing) => {
          if (
            pricing.signalId === signalId &&
            pricing.tiers &&
            pricing.tiers.length > 1
          ) {
            const filteredTiers = pricing.tiers.filter(
              (_, i) => i !== tierIndex
            )
            // Recalculate lower bounds after deletion
            const recalculatedTiers = filteredTiers.map((tier, index) => {
              if (index === 0) {
                return { ...tier, lower: 0 }
              }
              const prevTier = filteredTiers[index - 1]
              const newLower =
                prevTier.upper !== null ? prevTier.upper + 1 : tier.lower
              return { ...tier, lower: newLower }
            })
            return { ...pricing, tiers: recalculatedTiers }
          }
          return pricing
        })
      )
    },
    [setSignalPricing]
  )

  const updateSignalBillingFrequency = useCallback(
    (signalId: string, frequency: 'monthly' | 'yearly') => {
      setSignalPricing((prev) =>
        prev.map((pricing) =>
          pricing.signalId === signalId
            ? { ...pricing, billingFrequency: frequency }
            : pricing
        )
      )
    },
    [setSignalPricing]
  )

  const updateSignalMinimumCommitment = useCallback(
    (signalId: string, commitment: number | null) => {
      setSignalPricing((prev) =>
        prev.map((pricing) =>
          pricing.signalId === signalId
            ? { ...pricing, minimumCommitment: commitment }
            : pricing
        )
      )
    },
    [setSignalPricing]
  )

  // Seat-based pricing operations
  const updateSeatBasedPricingType = useCallback(
    (type: SeatPricingType) => {
      if (type === 'FLAT') {
        setSeatBasedPricing((prev) => ({
          ...prev,
          pricingType: type,
          tiers: [{ lower: 0, upper: null, rate: prev.price || 0 }],
        }))
      } else {
        setSeatBasedPricing((prev) => ({ ...prev, pricingType: type }))
      }
    },
    [setSeatBasedPricing]
  )

  const updateSeatBasedTierRate = useCallback(
    (tierIndex: number, rate: number) => {
      if (rate < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Rate',
          description: 'Rate cannot be negative',
        })
        return
      }

      setSeatBasedPricing((prev) => {
        if (prev.tiers) {
          const updatedTiers = [...prev.tiers]
          updatedTiers[tierIndex] = { ...updatedTiers[tierIndex], rate }
          return { ...prev, tiers: updatedTiers }
        }
        return prev
      })
    },
    [setSeatBasedPricing, toast]
  )

  const updateSeatBasedTierUpper = useCallback(
    (tierIndex: number, upper: number | null) => {
      if (upper !== null && upper < 0) {
        toast({
          variant: 'destructive',
          title: 'Invalid Upper Bound',
          description: 'Upper bound cannot be negative',
        })
        return
      }

      setSeatBasedPricing((prev) => {
        if (prev.tiers) {
          const updatedTiers = [...prev.tiers]
          updatedTiers[tierIndex] = { ...updatedTiers[tierIndex], upper }
          // Update the next tier's lower bound to be upper + 1
          if (upper !== null && tierIndex + 1 < updatedTiers.length) {
            updatedTiers[tierIndex + 1] = {
              ...updatedTiers[tierIndex + 1],
              lower: upper + 1,
            }
          }
          return { ...prev, tiers: updatedTiers }
        }
        return prev
      })
    },
    [setSeatBasedPricing, toast]
  )

  const addSeatBasedTier = useCallback(
    (canAdd: boolean) => {
      if (!canAdd) {
        toast({
          variant: 'destructive',
          title: 'Cannot Add Tier',
          description:
            'Please fill in both the "to" value and price for the current tier',
        })
        return
      }

      setSeatBasedPricing((prev) => {
        if (prev.tiers) {
          const lastTier = prev.tiers[prev.tiers.length - 1]
          const newTier = {
            lower:
              lastTier.upper !== null ? lastTier.upper + 1 : lastTier.lower + 1,
            upper: null,
            rate: 0,
          }
          return { ...prev, tiers: [...prev.tiers, newTier] }
        }
        return prev
      })
    },
    [setSeatBasedPricing, toast]
  )

  const deleteSeatBasedTier = useCallback(
    (tierIndex: number) => {
      setSeatBasedPricing((prev) => {
        if (prev.tiers && prev.tiers.length > 1) {
          const filteredTiers = prev.tiers.filter((_, i) => i !== tierIndex)
          // Recalculate lower bounds after deletion
          const recalculatedTiers = filteredTiers.map((tier, index) => {
            if (index === 0) {
              return { ...tier, lower: 0 }
            }
            const prevTier = filteredTiers[index - 1]
            const newLower =
              prevTier.upper !== null ? prevTier.upper + 1 : tier.lower
            return { ...tier, lower: newLower }
          })
          return { ...prev, tiers: recalculatedTiers }
        }
        return prev
      })
    },
    [setSeatBasedPricing]
  )

  const updateSeatBasedBillingFrequency = useCallback(
    (frequency: 'monthly' | 'yearly') => {
      setSeatBasedPricing((prev) => ({ ...prev, billingFrequency: frequency }))
    },
    [setSeatBasedPricing]
  )

  const updateSeatBasedMinimumCommitment = useCallback(
    (commitment: number | null) => {
      setSeatBasedPricing((prev) => ({
        ...prev,
        minimumCommitment: commitment,
      }))
    },
    [setSeatBasedPricing]
  )

  // active:false only ever comes from formatForApi's disabled-toggle handling
  // (enabled strategies are always built active:true), so this filter is
  // exactly the set of deactivations. Each one retroactively zeroes revenue
  // already earned: revenue metrics keep only active strategies
  // (packages/db/src/lib/revenue-metrics.ts), hence the warning before save.
  const getPendingStrategyDeactivations = useCallback((): string[] => {
    const { updatedStrategies } = formatForApi(
      agentId,
      pricingOptions,
      setupFee,
      platformFee,
      seatBasedPricing,
      signalPricing,
      originalStrategies
    )
    return updatedStrategies
      .filter((strategy) => strategy.active === false)
      .map((strategy) => strategy.name ?? 'unnamed strategy')
  }, [
    agentId,
    pricingOptions,
    setupFee,
    platformFee,
    seatBasedPricing,
    signalPricing,
    originalStrategies,
  ])

  // Save pricing plan
  const savePricingPlan = useCallback(async () => {
    try {
      setIsSaving(true)

      const { newStrategies, updatedStrategies } = formatForApi(
        agentId,
        pricingOptions,
        setupFee,
        platformFee,
        seatBasedPricing,
        signalPricing,
        originalStrategies
      )

      // Save directly to the database via Server Action.
      // formatForApi always includes id on updated strategies, but TypeScript
      // can't prove that from the Partial type, so we cast to satisfy the
      // Server Action's stricter type signature.
      const result = await bulkUpdateAction(
        planId,
        agentId,
        newStrategies as Parameters<typeof bulkUpdateAction>[2],
        updatedStrategies as Parameters<typeof bulkUpdateAction>[3]
      )

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to save pricing plan')
      }

      // Update original strategies so the UI knows what's been saved.
      // The server action's PricingStrategy uses null for optional fields
      // while the frontend type uses undefined — cast to bridge the gap.
      const updatedOriginalStrategies = { ...originalStrategies }
      result.data.created.forEach((strategy) => {
        if (strategy.id)
          updatedOriginalStrategies[strategy.id] =
            strategy as unknown as PricingStrategy
      })
      result.data.updated.forEach((strategy) => {
        if (strategy.id)
          updatedOriginalStrategies[strategy.id] =
            strategy as unknown as PricingStrategy
      })
      setOriginalStrategies(updatedOriginalStrategies)

      toast({
        title: 'Pricing plan saved',
        description:
          'Next step: create a subscription to connect a customer to this plan.',
        duration: 8000,
      })
    } catch (error) {
      console.error('Error saving pricing plan:', error)
      // Server rejections are actionable (they name the conflict and the
      // fix) — surface them, don't bury them in the console.
      toast({
        variant: 'destructive',
        title: "Couldn't save pricing plan",
        description:
          error instanceof Error && error.message
            ? error.message
            : 'Failed to save pricing plan',
      })
    } finally {
      setIsSaving(false)
    }
  }, [
    agentId,
    planId,
    pricingOptions,
    setupFee,
    platformFee,
    seatBasedPricing,
    signalPricing,
    originalStrategies,
    setIsSaving,
    setOriginalStrategies,
    toast,
  ])

  return {
    // Pricing option operations
    togglePricingOption,
    updateSetupFeePrice,
    updatePlatformFeePrice,
    updatePlatformFeeBillingFrequency,

    // Signal pricing operations
    toggleSignalPricing,
    updateSignalPricingType,
    updateSignalTierRate,
    updateSignalTierUpper,
    addSignalTier,
    deleteSignalTier,
    updateSignalBillingFrequency,
    updateSignalMinimumCommitment,
    // Credit-pool-specific signal handlers
    updateSignalPoolSize,
    updateSignalPoolFee,
    updateSignalOverageRate,
    addSignalPoolMember,
    removeSignalPoolMember,
    updateSignalCreditRate,

    // Seat-based pricing operations
    updateSeatBasedPricingType,
    updateSeatBasedTierRate,
    updateSeatBasedTierUpper,
    addSeatBasedTier,
    deleteSeatBasedTier,
    updateSeatBasedBillingFrequency,
    updateSeatBasedMinimumCommitment,

    // Save
    getPendingStrategyDeactivations,
    savePricingPlan,
  }
}

// Helper function to format data for API
function formatForApi(
  agentId: string,
  pricingOptions: PricingOption[],
  setupFee: SetupFee,
  platformFee: PlatformFee,
  seatBasedPricing: SeatBasedPricing,
  signalPricing: SignalPricing[],
  originalStrategies: Record<string, PricingStrategy>
) {
  const newStrategies: PricingStrategy[] = []
  const updatedStrategies: Partial<PricingStrategy>[] = []
  const allStrategies: PricingStrategy[] = []

  // Add setup fee
  if (pricingOptions.find((option) => option.id === 'setup')?.enabled) {
    allStrategies.push({
      name: 'setup_fee',
      agentId,
      tags: ['fixed', 'onetime'],
      chargeType: 'onetime',
      rate: setupFee.price,
      active: true,
    })
  }

  // Add platform fee
  if (pricingOptions.find((option) => option.id === 'platform')?.enabled) {
    allStrategies.push({
      name: 'platform_fee',
      agentId,
      tags: ['fixed', 'recurring'],
      chargeType: 'recurring',
      billingFrequency: platformFee.billingFrequency,
      rate: platformFee.price,
      active: true,
    })
  }

  // Add seat-based pricing
  if (pricingOptions.find((option) => option.id === 'seat')?.enabled) {
    const strategy: PricingStrategy = {
      name: 'seat_based_fee',
      agentId,
      tags: ['seat', 'recurring'],
      chargeType: 'seat_based',
      pricingModel: seatBasedPricing.pricingType.toLowerCase() as
        | 'flat'
        | 'volume'
        | 'graduated',
      billingFrequency: seatBasedPricing.billingFrequency,
      tiers: seatBasedPricing.tiers,
      active: true,
    }
    if (seatBasedPricing.minimumCommitment !== null) {
      strategy.minimumCommitment = seatBasedPricing.minimumCommitment
    }
    allStrategies.push(strategy)
  }

  // Add signal-based pricing
  signalPricing.forEach((pricing) => {
    if (pricing.enabled && pricing.signal) {
      // For flat pricing, set the top-level rate so the backend and reload logic
      // both find the price in the same place. Tiers still get saved for tiered models.
      const flatRate =
        pricing.pricingType === 'FLAT' && pricing.tiers?.length
          ? pricing.tiers[0].rate
          : undefined

      const strategy: PricingStrategy = {
        name:
          pricing.signal.shortName ||
          pricing.signal.name.toLowerCase().replace(/\s+/g, '_'),
        agentId,
        signalId: pricing.signalId,
        tags: ['usage', 'recurring'],
        chargeType: 'usage',
        billingFrequency: pricing.billingFrequency,
        pricingModel: pricing.pricingType.toLowerCase() as
          | 'flat'
          | 'volume'
          | 'graduated'
          | 'credit_pool',
        rate: flatRate,
        tiers: pricing.tiers,
        active: true,
      }
      // A credit pool can't carry a minimum commitment. The form does not
      // offer the field, but a saved row loaded into state can hold a
      // value, and sending it back would reject the whole save.
      if (
        pricing.minimumCommitment !== null &&
        pricing.pricingType !== 'CREDIT_POOL'
      ) {
        strategy.minimumCommitment = pricing.minimumCommitment
      }
      // Undefined = this row never held a pool, so the field stays out of the
      // payload and a NULL column stays NULL. `{}` is a real value that clears
      // the stored map.
      if (pricing.creditRates !== undefined) {
        strategy.creditRates = pricing.creditRates
      }
      allStrategies.push(strategy)
    }
  })

  // Categorize as new or updated
  allStrategies.forEach((strategy) => {
    const existingStrategy =
      strategy.name === 'setup_fee' || strategy.name === 'platform_fee'
        ? Object.values(originalStrategies).find(
            (orig) => orig.name === strategy.name
          )
        : Object.values(originalStrategies).find(
            (orig) =>
              (strategy.id && orig.id === strategy.id) ||
              (orig.name === strategy.name &&
                orig.chargeType === strategy.chargeType)
          )

    if (existingStrategy?.id) {
      if (hasStrategyChanged(existingStrategy, strategy)) {
        updatedStrategies.push({ ...strategy, id: existingStrategy.id })
      }
    } else {
      newStrategies.push(strategy)
    }
  })

  // Handle disabled strategies
  Object.values(originalStrategies).forEach((origStrategy) => {
    if (origStrategy.name === 'setup_fee') {
      const isEnabled = pricingOptions.find(
        (opt) => opt.id === 'setup'
      )?.enabled
      if (!isEnabled && origStrategy.active && origStrategy.id) {
        updatedStrategies.push({
          id: origStrategy.id,
          name: origStrategy.name,
          active: false,
        })
      }
    } else if (origStrategy.name === 'platform_fee') {
      const isEnabled = pricingOptions.find(
        (opt) => opt.id === 'platform'
      )?.enabled
      if (!isEnabled && origStrategy.active && origStrategy.id) {
        updatedStrategies.push({
          id: origStrategy.id,
          name: origStrategy.name,
          active: false,
        })
      }
    } else if (origStrategy.signalId) {
      const signalPricingItem = signalPricing.find(
        (sp) => sp.signalId === origStrategy.signalId
      )
      if (
        ((signalPricingItem && !signalPricingItem.enabled) ||
          !signalPricingItem) &&
        origStrategy.active &&
        origStrategy.id
      ) {
        updatedStrategies.push({
          id: origStrategy.id,
          name: origStrategy.name,
          active: false,
        })
      }
    } else if (origStrategy.chargeType === 'seat_based' && origStrategy.id) {
      const isEnabled = pricingOptions.find((opt) => opt.id === 'seat')?.enabled
      if (!isEnabled && origStrategy.active) {
        updatedStrategies.push({
          id: origStrategy.id,
          name: origStrategy.name,
          active: false,
        })
      }
    }
  })

  return { newStrategies, updatedStrategies }
}

function hasStrategyChanged(
  originalStrategy: PricingStrategy,
  currentStrategy: PricingStrategy
): boolean {
  const simpleFieldsChanged =
    originalStrategy.name !== currentStrategy.name ||
    originalStrategy.chargeType !== currentStrategy.chargeType ||
    originalStrategy.pricingModel !== currentStrategy.pricingModel ||
    originalStrategy.billingFrequency !== currentStrategy.billingFrequency ||
    originalStrategy.rate !== currentStrategy.rate ||
    originalStrategy.active !== currentStrategy.active ||
    creditRatesFingerprint(originalStrategy.creditRates) !==
      creditRatesFingerprint(currentStrategy.creditRates)

  if (simpleFieldsChanged) return true

  if (
    (!originalStrategy.tiers && currentStrategy.tiers) ||
    (originalStrategy.tiers && !currentStrategy.tiers) ||
    originalStrategy.tiers?.length !== currentStrategy.tiers?.length
  ) {
    return true
  }

  if (originalStrategy.tiers && currentStrategy.tiers) {
    for (let i = 0; i < originalStrategy.tiers.length; i++) {
      const origTier = originalStrategy.tiers[i]
      const currTier = currentStrategy.tiers[i]
      if (
        origTier.lower !== currTier.lower ||
        origTier.upper !== currTier.upper ||
        origTier.rate !== currTier.rate
      ) {
        return true
      }
    }
  }

  return false
}
