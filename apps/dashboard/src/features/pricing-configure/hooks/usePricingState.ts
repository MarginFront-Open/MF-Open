// @ts-nocheck
import { useState, useEffect, useCallback } from 'react'
import { getAgent as getAgentAction } from '@/app/actions/agents'
import { getPricingPlan as getPricingPlanAction } from '@/app/actions/pricing-plans'
import { getSignals as getSignalsAction } from '@/app/actions/signals'
import { useOrgId } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'
import type {
  Signal,
  PricingStrategy,
  PricingPlan,
  PricingOption,
  SignalPricing,
  SeatBasedPricing,
  SetupFee,
  PlatformFee,
} from '../types'

export function usePricingState(agentId: string, planId: string) {
  const { toast } = useToast()
  const organizationId = useOrgId()

  // Core state
  const [agent, setAgent] = useState<{
    name: string
    description: string
  } | null>(null)
  const [pricingPlan, setPricingPlan] = useState<PricingPlan | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [signals, setSignals] = useState<Signal[]>([])
  const [originalStrategies, setOriginalStrategies] = useState<
    Record<string, PricingStrategy>
  >({})

  // Pricing state
  const [setupFee, setSetupFee] = useState<SetupFee>({
    enabled: false,
    price: 0,
  })
  const [platformFee, setPlatformFee] = useState<PlatformFee>({
    enabled: false,
    price: 0,
    billingFrequency: 'monthly',
  })
  const [seatBasedPricing, setSeatBasedPricing] = useState<SeatBasedPricing>({
    enabled: false,
    pricingType: 'FLAT',
    price: 0,
    billingFrequency: 'monthly',
    tiers: [{ lower: 0, upper: null, rate: 0 }],
    minimumCommitment: null,
  })
  const [signalPricing, setSignalPricing] = useState<SignalPricing[]>([])
  const [pricingOptions, setPricingOptions] = useState<PricingOption[]>([
    {
      id: 'setup',
      name: 'Setup fee',
      enabled: false,
      type: 'FIXED',
      billingCycle: 'ONE-TIME',
      price: 0,
    },
    {
      id: 'platform',
      name: 'Platform fee',
      enabled: false,
      type: 'FIXED',
      billingCycle: 'RECURRING',
      price: 0,
      billingFrequency: 'monthly',
    },
    {
      id: 'seat',
      name: 'Seat-based',
      enabled: false,
      type: 'VARIABLE',
      billingCycle: 'RECURRING',
    },
    {
      // id stays 'activity' because togglePricingOption call sites key on
      // it; the display name is "Usage-Based".
      id: 'activity',
      name: 'Usage-Based',
      enabled: true,
      type: 'VARIABLE',
      billingCycle: 'RECURRING',
    },
    {
      // Same rationale: 'outcome' id is load-bearing; display gets the
      // industry-standard "Outcome-Based" label.
      id: 'outcome',
      name: 'Outcome-Based',
      enabled: true,
      type: 'VARIABLE',
      billingCycle: 'RECURRING',
    },
  ])

  // Fetch signals
  const fetchSignals = useCallback(async () => {
    try {
      if (!organizationId) throw new Error('Organization ID is required')

      const planResult = await getPricingPlanAction(planId, true)
      const existingStrategies =
        planResult.success && planResult.data?.pricingStrategies
          ? planResult.data.pricingStrategies
          : []

      const signalsResult = await getSignalsAction({
        agentId,
        limit: 100,
        page: 1,
      })

      if (signalsResult.success && signalsResult.data?.results) {
        const fetchedSignals = signalsResult.data.results.map(
          (apiSignal: any) => ({
            id: apiSignal.id,
            name: apiSignal.name,
            shortName: apiSignal.shortName,
            // Map DB values (volume/usage) to UI labels (ACTIVITY/OUTCOME)
            type: apiSignal.type === 'usage' ? 'OUTCOME' : 'ACTIVITY',
          })
        )

        setSignals(fetchedSignals)

        const initialSignalPricing: SignalPricing[] = fetchedSignals.map(
          (signal: Signal) => {
            let existingStrategy = existingStrategies.find(
              (s: PricingStrategy) => s.signalId === signal.id
            )

            if (!existingStrategy && signal.shortName) {
              existingStrategy = existingStrategies.find(
                (s: PricingStrategy) => s.name === signal.shortName
              )
            }

            if (existingStrategy) {
              const pricingType = existingStrategy.pricingModel
                ? (existingStrategy.pricingModel.toUpperCase() as
                    | 'FLAT'
                    | 'VOLUME'
                    | 'GRADUATED')
                : 'FLAT'

              let price = 0
              if (
                existingStrategy.rate !== null &&
                existingStrategy.rate !== undefined
              ) {
                price = existingStrategy.rate
              } else if (
                existingStrategy.tiers?.length &&
                pricingType === 'FLAT'
              ) {
                price = existingStrategy.tiers[0].rate
              }

              return {
                signalId: signal.id,
                signal,
                enabled: existingStrategy.active,
                pricingType,
                price,
                billingFrequency:
                  existingStrategy.billingFrequency || 'monthly',
                tiers:
                  existingStrategy.tiers && existingStrategy.tiers.length > 0
                    ? JSON.parse(JSON.stringify(existingStrategy.tiers))
                    : [{ lower: 0, upper: null, rate: price }],
                minimumCommitment: existingStrategy.minimumCommitment || null,
                // A stored NULL becomes undefined, not {} — undefined is what
                // keeps an unrated pool's rates OUT of the save payload, so its
                // column stays NULL and its draws stay unrated
                creditRates: existingStrategy.creditRates
                  ? { ...existingStrategy.creditRates }
                  : undefined,
              }
            }

            return {
              signalId: signal.id,
              signal,
              enabled: true,
              pricingType: 'FLAT',
              price: 0,
              billingFrequency: 'monthly',
              tiers: [{ lower: 0, upper: null, rate: 0 }],
              minimumCommitment: null,
            }
          }
        )

        setSignalPricing(initialSignalPricing)
      }
    } catch (error) {
      console.error('Error fetching signals:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load signals',
      })
    }
  }, [agentId, planId, organizationId, toast])

  // Initial data load
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true)

        const agentResult = await getAgentAction(agentId)
        if (agentResult.success && agentResult.data) {
          setAgent({
            name: agentResult.data.name,
            description: agentResult.data.description,
          })
        }

        if (!organizationId) throw new Error('Organization ID is required')

        const planResult = await getPricingPlanAction(planId, true)

        if (planResult.success && planResult.data) {
          setPricingPlan(planResult.data as any)

          if (planResult.data.pricingStrategies) {
            const strategiesMap = planResult.data.pricingStrategies.reduce(
              (
                acc: Record<string, PricingStrategy>,
                strategy: PricingStrategy
              ) => {
                if (strategy.id) acc[strategy.id] = { ...strategy }
                return acc
              },
              {}
            )
            setOriginalStrategies(strategiesMap)

            // Initialize setup fee — match by chargeType, not name string
            const setupFeeStrategy = planResult.data.pricingStrategies.find(
              (s: PricingStrategy) => s.chargeType === 'onetime'
            )
            if (setupFeeStrategy) {
              setSetupFee({
                enabled: setupFeeStrategy.active,
                price: setupFeeStrategy.rate || 0,
              })
              setPricingOptions((prev) =>
                prev.map((opt) =>
                  opt.id === 'setup'
                    ? {
                        ...opt,
                        enabled: setupFeeStrategy.active,
                        price: setupFeeStrategy.rate || 0,
                      }
                    : opt
                )
              )
            }

            // Initialize platform fee — recurring strategy with no signal = platform fee
            const platformFeeStrategy = planResult.data.pricingStrategies.find(
              (s: PricingStrategy) =>
                s.chargeType === 'recurring' && !s.signalId
            )
            if (platformFeeStrategy) {
              setPlatformFee({
                enabled: platformFeeStrategy.active,
                price: platformFeeStrategy.rate || 0,
                billingFrequency:
                  platformFeeStrategy.billingFrequency || 'monthly',
              })
              setPricingOptions((prev) =>
                prev.map((opt) =>
                  opt.id === 'platform'
                    ? {
                        ...opt,
                        enabled: platformFeeStrategy.active,
                        price: platformFeeStrategy.rate || 0,
                        billingFrequency:
                          platformFeeStrategy.billingFrequency || 'monthly',
                      }
                    : opt
                )
              )
            }

            // Initialize seat-based pricing.
            const seatBasedStrategy = planResult.data.pricingStrategies.find(
              (s: PricingStrategy) => s.chargeType === 'seat_based'
            )
            if (seatBasedStrategy) {
              const pricingType = seatBasedStrategy.pricingModel
                ? (seatBasedStrategy.pricingModel.toUpperCase() as
                    | 'FLAT'
                    | 'VOLUME'
                    | 'GRADUATED')
                : 'FLAT'

              let price = 0
              if (
                seatBasedStrategy.rate !== null &&
                seatBasedStrategy.rate !== undefined
              ) {
                price = seatBasedStrategy.rate
              } else if (
                seatBasedStrategy.tiers?.length &&
                pricingType === 'FLAT'
              ) {
                price = seatBasedStrategy.tiers[0].rate
              }

              setSeatBasedPricing({
                enabled: seatBasedStrategy.active,
                pricingType,
                price,
                billingFrequency:
                  seatBasedStrategy.billingFrequency || 'monthly',
                tiers:
                  seatBasedStrategy.tiers && seatBasedStrategy.tiers.length > 0
                    ? JSON.parse(JSON.stringify(seatBasedStrategy.tiers))
                    : [{ lower: 0, upper: null, rate: price }],
                minimumCommitment: seatBasedStrategy.minimumCommitment || null,
              })
              setPricingOptions((prev) =>
                prev.map((opt) =>
                  opt.id === 'seat'
                    ? { ...opt, enabled: seatBasedStrategy.active }
                    : opt
                )
              )
            }
          }
        }

        await fetchSignals()
      } catch (error) {
        console.error('Error fetching data:', error)
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load data',
        })
      } finally {
        setIsLoading(false)
      }
    }

    if (agentId && planId) fetchData()
  }, [agentId, planId, organizationId, toast, fetchSignals])

  return {
    // State
    agent,
    pricingPlan,
    isLoading,
    isSaving,
    signals,
    originalStrategies,
    setupFee,
    platformFee,
    seatBasedPricing,
    signalPricing,
    pricingOptions,

    // Setters
    setIsSaving,
    setSetupFee,
    setPlatformFee,
    setSeatBasedPricing,
    setSignalPricing,
    setPricingOptions,
    setOriginalStrategies,
  }
}
