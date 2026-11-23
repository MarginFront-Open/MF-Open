'use client'

// @ts-nocheck
import { useMemo, useState } from 'react'
import { IconArrowLeft } from '@tabler/icons-react'
import Link from 'next/link'
import { useOrgCurrency } from '@/hooks/use-org-currency'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Page } from '@/components/layouts/page'
// Components
import { PlanActivationToggle } from './components/PlanActivationToggle'
import { PlatformFeeSection } from './components/PlatformFeeSection'
import { SeatBasedPricingSection } from './components/SeatBasedPricingSection'
import { SetupFeeSection } from './components/SetupFeeSection'
import { SignalBasedPricingSection } from './components/SignalBasedPricingSection'
import { SignalPricingItem } from './components/SignalPricingItem'
import { usePlanActivation } from './hooks/usePlanActivation'
import { usePricingOperations } from './hooks/usePricingOperations'
// Hooks
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { usePricingState } from './hooks/usePricingState'
import { usePricingValidation } from './hooks/usePricingValidation'
import type { SignalPricing } from './types'

interface PricingConfigureProps {
  agentId: string
  planId: string
}

export function PricingConfigure({ agentId, planId }: PricingConfigureProps) {
  const { currencySymbol } = useOrgCurrency()

  // State management
  const {
    agent,
    pricingPlan,
    isLoading,
    isSaving,
    signals: _signals,
    originalStrategies,
    setupFee,
    platformFee,
    seatBasedPricing,
    signalPricing,
    pricingOptions,
    setIsSaving,
    setSetupFee,
    setPlatformFee,
    setSeatBasedPricing,
    setSignalPricing,
    setPricingOptions,
    setOriginalStrategies,
  } = usePricingState(agentId, planId)

  // Operations
  const {
    togglePricingOption,
    updateSetupFeePrice,
    updatePlatformFeePrice,
    updatePlatformFeeBillingFrequency,
    toggleSignalPricing,
    updateSignalPricingType,
    updateSignalTierRate,
    updateSignalTierUpper,
    addSignalTier,
    deleteSignalTier,
    updateSignalBillingFrequency,
    updateSignalMinimumCommitment,
    updateSignalPoolSize,
    updateSignalPoolFee,
    updateSignalOverageRate,
    addSignalPoolMember,
    removeSignalPoolMember,
    updateSignalCreditRate,
    updateSeatBasedPricingType,
    updateSeatBasedTierRate,
    updateSeatBasedTierUpper,
    addSeatBasedTier,
    deleteSeatBasedTier,
    updateSeatBasedBillingFrequency,
    updateSeatBasedMinimumCommitment,
    getPendingStrategyDeactivations,
    savePricingPlan,
  } = usePricingOperations({
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
  })

  // Validation
  const { canAddTier, validatePricingForm } = usePricingValidation()

  // Plan activation
  const {
    isPlanActive,
    showActivationDialog,
    activationPending,
    handleToggle,
    confirmActivation,
    cancelActivation,
    setIsPlanActive,
  } = usePlanActivation(planId, pricingPlan?.isActive || false)

  // Update plan active state when pricingPlan changes
  useMemo(() => {
    if (pricingPlan?.isActive !== undefined) {
      setIsPlanActive(pricingPlan.isActive)
    }
  }, [pricingPlan?.isActive, setIsPlanActive])

  // Get signal pricing entries filtered by classification.
  //
  // Signal types flow DB -> UI through two hops:
  //   1. getSignalsAction returns raw DB values ('volume' | 'usage').
  //   2. usePricingState.ts (the signals fetch) normalizes them to the internal UI enum
  //      ('ACTIVITY' | 'OUTCOME') before they land in signalPricing.
  //
  // By the time we compare here, sp.signal.type is already the internal UI
  // enum, so a direct equality check is safe. Mapping: ACTIVITY = volume =
  // "Usage-Based" (every event billed); OUTCOME = usage = "Outcome-Based"
  // (billed only on result).
  const getSignalsByType = (
    signalType: 'ACTIVITY' | 'OUTCOME'
  ): SignalPricing[] => {
    return signalPricing.filter((sp) => sp.signal?.type === signalType)
  }

  // One active credit pool per plan — client mirror of the server's
  // validateSinglePoolPerPlan (see usePricingValidation for why the ledger
  // allows only one). Once a signal holds the pool, gray the option out on
  // every OTHER row instead of letting the save fail server-side.
  //
  // savedLivePools mirrors the server's isLivePoolStrategy over what the
  // plan already has persisted: it drives the grandfather clause (an existing
  // plan carrying two pools stays savable; only ADDING one is blocked) and
  // catches pools on signals not loaded into this form (another agent's
  // signal on a shared plan). No deletedAt clause — the client
  // PricingStrategy type doesn't carry the field; deleted rows are filtered
  // out server-side (app/actions/pricing-plans.ts) before reaching state.
  const savedLivePools = Object.values(originalStrategies).filter(
    (s) =>
      s.pricingModel === 'credit_pool' && s.chargeType === 'usage' && s.active
  )
  const hiddenPoolHolder = savedLivePools.find(
    (s) =>
      !s.signalId || !signalPricing.some((sp) => sp.signalId === s.signalId)
  )
  const creditPoolHolder = signalPricing.find(
    (sp) => sp.enabled && sp.pricingType === 'CREDIT_POOL'
  )
  const creditPoolReasonFor = (signalId: string): string | null => {
    // Never disable the option on a row that currently holds it — a
    // grandfathered second pool must stay switchable to another model.
    const row = signalPricing.find((sp) => sp.signalId === signalId)
    if (row?.pricingType === 'CREDIT_POOL') return null
    if (creditPoolHolder && creditPoolHolder.signalId !== signalId) {
      return `A plan can have only one active credit pool, and "${creditPoolHolder.signal?.name ?? 'another signal'}" already uses it. Switch that signal off credit pool first, or put this one on its own plan.`
    }
    if (hiddenPoolHolder) {
      return `A plan can have only one active credit pool, and "${hiddenPoolHolder.name}" (not shown on this screen) already uses it. Deactivate it first, or put this signal on its own plan.`
    }
    return null
  }

  // Metrics offered to the pool's "What burns credits" table:
  // every OTHER signal on this plan. A signal whose own pricing is switched on
  // already bills per unit, so joining the pool would charge the customer
  // twice for one unit of work — the server rejects it (creditRateDoubleBilled)
  // and here it renders disabled with the reason rather than vanishing. Same
  // idiom as the CREDIT_POOL radio: a hidden option makes the rule invisible.
  const memberOptionsFor = (poolSignalId: string) =>
    signalPricing.flatMap((sp) =>
      sp.signalId === poolSignalId || !sp.signal
        ? []
        : [
            {
              id: sp.signalId,
              name: sp.signal.name,
              disabledReason: sp.enabled
                ? 'bills on its own, turn that off first'
                : null,
            },
          ]
    )

  // A pricing edit lands on the period that's already running, so the caution
  // is worth showing exactly when someone is being billed under this plan.
  const hasActiveSubscriptions = (pricingPlan?.activeSubscriptionCount ?? 0) > 0

  const [pendingDeactivations, setPendingDeactivations] = useState<
    string[] | null
  >(null)

  const handleSave = () => {
    if (
      !validatePricingForm(
        planId,
        pricingOptions,
        signalPricing,
        savedLivePools.length,
        hiddenPoolHolder?.name ?? null
      )
    )
      return
    const deactivations = getPendingStrategyDeactivations()
    if (deactivations.length > 0) {
      setPendingDeactivations(deactivations)
      return
    }
    savePricingPlan()
  }

  return (
    <Page
      title='Configure Pricing'
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Build', href: '/build' },
          { name: agent?.name || 'Agent', href: `/build?agent=${agentId}` },
          {
            name: 'Pricing Plans',
            href: `/agents/${agentId}/pricing-plans`,
          },
          { name: 'Configure' },
        ],
      }}
    >
      <div className='flex min-h-screen flex-col'>
        {/* Header */}
        <div className='px-6 py-4'>
          <div className='mx-auto flex max-w-5xl items-center justify-between'>
            <div className='space-y-1'>
              <h1 className='text-xl font-semibold'>
                {isLoading
                  ? 'Loading...'
                  : pricingPlan?.name || 'Pricing Configuration'}
              </h1>
              {agent && (
                <p className='text-sm text-muted-foreground'>
                  Configure pricing for {agent.name}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className='flex-1 px-6 py-8'>
          <div className='mx-auto max-w-5xl'>
            {isLoading ? (
              <div className='flex h-64 items-center justify-center'>
                <p className='text-muted-foreground'>Loading...</p>
              </div>
            ) : (
              <div className='space-y-8'>
                {/* Setup Fee */}
                <SetupFeeSection
                  enabled={
                    pricingOptions.find((opt) => opt.id === 'setup')?.enabled ||
                    false
                  }
                  price={setupFee.price}
                  currencySymbol={currencySymbol}
                  onToggle={() => togglePricingOption('setup')}
                  onPriceChange={updateSetupFeePrice}
                />

                {/* Platform Fee */}
                <PlatformFeeSection
                  enabled={
                    pricingOptions.find((opt) => opt.id === 'platform')
                      ?.enabled || false
                  }
                  price={platformFee.price}
                  billingFrequency={platformFee.billingFrequency}
                  currencySymbol={currencySymbol}
                  onToggle={() => togglePricingOption('platform')}
                  onPriceChange={updatePlatformFeePrice}
                  onBillingFrequencyChange={updatePlatformFeeBillingFrequency}
                />

                {/* Seat-based Pricing */}
                <SeatBasedPricingSection
                  enabled={
                    pricingOptions.find((opt) => opt.id === 'seat')?.enabled ||
                    false
                  }
                  pricingType={seatBasedPricing.pricingType}
                  tiers={seatBasedPricing.tiers}
                  billingFrequency={seatBasedPricing.billingFrequency}
                  minimumCommitment={seatBasedPricing.minimumCommitment}
                  currencySymbol={currencySymbol}
                  onToggle={() => togglePricingOption('seat')}
                  onPricingTypeChange={updateSeatBasedPricingType}
                  onTierUpperChange={updateSeatBasedTierUpper}
                  onTierRateChange={updateSeatBasedTierRate}
                  onAddTier={() =>
                    addSeatBasedTier(canAddTier(seatBasedPricing.tiers))
                  }
                  onDeleteTier={deleteSeatBasedTier}
                  onBillingFrequencyChange={updateSeatBasedBillingFrequency}
                  onMinimumCommitmentChange={updateSeatBasedMinimumCommitment}
                  canAddTier={canAddTier(seatBasedPricing.tiers)}
                />

                {/* Usage-Based Pricing (metric classification: every event billed) */}
                <SignalBasedPricingSection
                  title='Usage-Based'
                  tooltip={tooltipDefinitions.activityBased}
                  enabled={
                    pricingOptions.find((opt) => opt.id === 'activity')
                      ?.enabled || false
                  }
                  onToggle={() => togglePricingOption('activity')}
                >
                  {getSignalsByType('ACTIVITY').map((pricing) =>
                    pricing.signal ? (
                      <SignalPricingItem
                        key={pricing.signalId}
                        signal={pricing.signal}
                        enabled={pricing.enabled}
                        pricingType={pricing.pricingType}
                        price={pricing.price}
                        tiers={pricing.tiers || []}
                        billingFrequency={pricing.billingFrequency}
                        minimumCommitment={pricing.minimumCommitment || null}
                        currencySymbol={currencySymbol}
                        creditPoolDisabledReason={creditPoolReasonFor(
                          pricing.signalId
                        )}
                        creditRates={pricing.creditRates}
                        memberOptions={memberOptionsFor(pricing.signalId)}
                        showMidPeriodCaution={hasActiveSubscriptions}
                        onToggle={() => toggleSignalPricing(pricing.signalId)}
                        onPricingTypeChange={(type) =>
                          updateSignalPricingType(pricing.signalId, type)
                        }
                        onTierUpperChange={(index, upper) =>
                          updateSignalTierUpper(pricing.signalId, index, upper)
                        }
                        onTierRateChange={(index, rate) =>
                          updateSignalTierRate(pricing.signalId, index, rate)
                        }
                        onAddTier={() =>
                          addSignalTier(
                            pricing.signalId,
                            canAddTier(pricing.tiers || [])
                          )
                        }
                        onDeleteTier={(index) =>
                          deleteSignalTier(pricing.signalId, index)
                        }
                        onPoolSizeChange={(size) =>
                          updateSignalPoolSize(pricing.signalId, size)
                        }
                        onPoolFeeChange={(fee) =>
                          updateSignalPoolFee(pricing.signalId, fee)
                        }
                        onOverageRateChange={(rate) =>
                          updateSignalOverageRate(pricing.signalId, rate)
                        }
                        onCreditRateChange={(memberId, rate) =>
                          updateSignalCreditRate(
                            pricing.signalId,
                            memberId,
                            rate
                          )
                        }
                        onAddPoolMember={(memberId) =>
                          addSignalPoolMember(pricing.signalId, memberId)
                        }
                        onRemovePoolMember={(memberId) =>
                          removeSignalPoolMember(pricing.signalId, memberId)
                        }
                        onBillingFrequencyChange={(freq) =>
                          updateSignalBillingFrequency(pricing.signalId, freq)
                        }
                        onMinimumCommitmentChange={(commitment) =>
                          updateSignalMinimumCommitment(
                            pricing.signalId,
                            commitment
                          )
                        }
                        canAddTier={canAddTier(pricing.tiers || [])}
                      />
                    ) : null
                  )}
                </SignalBasedPricingSection>

                {/* Outcome-Based Pricing (metric classification: billed only on result) */}
                <SignalBasedPricingSection
                  title='Outcome-Based'
                  tooltip={tooltipDefinitions.outcomeBased}
                  enabled={
                    pricingOptions.find((opt) => opt.id === 'outcome')
                      ?.enabled || false
                  }
                  onToggle={() => togglePricingOption('outcome')}
                >
                  {getSignalsByType('OUTCOME').map((pricing) =>
                    pricing.signal ? (
                      <SignalPricingItem
                        key={pricing.signalId}
                        signal={pricing.signal}
                        enabled={pricing.enabled}
                        pricingType={pricing.pricingType}
                        price={pricing.price}
                        tiers={pricing.tiers || []}
                        billingFrequency={pricing.billingFrequency}
                        minimumCommitment={pricing.minimumCommitment || null}
                        currencySymbol={currencySymbol}
                        creditPoolDisabledReason={creditPoolReasonFor(
                          pricing.signalId
                        )}
                        creditRates={pricing.creditRates}
                        memberOptions={memberOptionsFor(pricing.signalId)}
                        showMidPeriodCaution={hasActiveSubscriptions}
                        onToggle={() => toggleSignalPricing(pricing.signalId)}
                        onPricingTypeChange={(type) =>
                          updateSignalPricingType(pricing.signalId, type)
                        }
                        onTierUpperChange={(index, upper) =>
                          updateSignalTierUpper(pricing.signalId, index, upper)
                        }
                        onTierRateChange={(index, rate) =>
                          updateSignalTierRate(pricing.signalId, index, rate)
                        }
                        onAddTier={() =>
                          addSignalTier(
                            pricing.signalId,
                            canAddTier(pricing.tiers || [])
                          )
                        }
                        onDeleteTier={(index) =>
                          deleteSignalTier(pricing.signalId, index)
                        }
                        onPoolSizeChange={(size) =>
                          updateSignalPoolSize(pricing.signalId, size)
                        }
                        onPoolFeeChange={(fee) =>
                          updateSignalPoolFee(pricing.signalId, fee)
                        }
                        onOverageRateChange={(rate) =>
                          updateSignalOverageRate(pricing.signalId, rate)
                        }
                        onCreditRateChange={(memberId, rate) =>
                          updateSignalCreditRate(
                            pricing.signalId,
                            memberId,
                            rate
                          )
                        }
                        onAddPoolMember={(memberId) =>
                          addSignalPoolMember(pricing.signalId, memberId)
                        }
                        onRemovePoolMember={(memberId) =>
                          removeSignalPoolMember(pricing.signalId, memberId)
                        }
                        onBillingFrequencyChange={(freq) =>
                          updateSignalBillingFrequency(pricing.signalId, freq)
                        }
                        onMinimumCommitmentChange={(commitment) =>
                          updateSignalMinimumCommitment(
                            pricing.signalId,
                            commitment
                          )
                        }
                        canAddTier={canAddTier(pricing.tiers || [])}
                      />
                    ) : null
                  )}
                </SignalBasedPricingSection>
              </div>
            )}

            <Separator className='my-8' />

            {/* Footer Actions */}
            <div className='flex items-center justify-between pb-8'>
              <Link href={`/agents/${agentId}/signals`}>
                <Button variant='ghost' className='text-muted-foreground'>
                  <IconArrowLeft size={16} className='mr-2' />
                  Back to Metrics
                </Button>
              </Link>
              <div className='flex items-center gap-4'>
                <PlanActivationToggle
                  isPlanActive={isPlanActive}
                  showActivationDialog={showActivationDialog}
                  activationPending={activationPending}
                  onToggle={handleToggle}
                  onConfirmActivation={confirmActivation}
                  onCancelActivation={cancelActivation}
                />
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog
        open={pendingDeactivations !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeactivations(null)
        }}
      >
        <AlertDialogContent className='max-w-md'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {`Turn off ${pendingDeactivations?.join(', ') || 'this pricing'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`Saving deactivates ${
                pendingDeactivations && pendingDeactivations.length > 1
                  ? 'these pricing strategies'
                  : 'this pricing strategy'
              } everywhere, including the past: revenue this plan already earned from ${
                pendingDeactivations && pendingDeactivations.length > 1
                  ? 'them'
                  : 'it'
              } disappears from every revenue report, past periods included. Turning the strategy back on later restores those numbers.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className='gap-2 sm:space-x-0'>
            <Button
              variant='outline'
              onClick={() => setPendingDeactivations(null)}
            >
              Keep it on
            </Button>
            <Button
              variant='destructive'
              onClick={() => {
                setPendingDeactivations(null)
                savePricingPlan()
              }}
            >
              Deactivate and save
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
