import { IconBolt, IconChevronDown } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { PricingTierManager } from './PricingTierManager'
import { PricingTypeSelector } from './PricingTypeSelector'
import { CreditPoolInputs } from './CreditPoolInputs'
import type { CreditPoolMemberOption } from './CreditPoolInputs'
import type { PricingType } from '../types'

interface Signal {
  id: string
  name: string
  shortName?: string
  type?: 'ACTIVITY' | 'OUTCOME'
}

interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

// Signal-based pricing surfaces all four models (incl. CREDIT_POOL).
// Seat-based keeps the narrower 3-option set (see SeatBasedPricingSection).
const SIGNAL_PRICING_OPTIONS: readonly PricingType[] = [
  'FLAT',
  'VOLUME',
  'GRADUATED',
  'CREDIT_POOL',
]

interface SignalPricingItemProps {
  signal: Signal
  enabled: boolean
  pricingType: PricingType
  price: number
  tiers: PricingTier[]
  billingFrequency: 'monthly' | 'yearly'
  minimumCommitment: number | null
  currencySymbol: string
  // Non-null when another signal on this plan already holds the one allowed
  // active credit pool; the CREDIT_POOL option renders disabled with this text.
  creditPoolDisabledReason?: string | null
  // Credit-pool membership. Only read when this row holds the pool.
  creditRates?: Record<string, number>
  memberOptions?: CreditPoolMemberOption[]
  showMidPeriodCaution?: boolean
  onToggle: () => void
  onPricingTypeChange: (type: PricingType) => void
  // Generic tier handlers — used by FLAT/VOLUME/GRADUATED.
  onTierUpperChange: (index: number, upper: number | null) => void
  onTierRateChange: (index: number, rate: number) => void
  onAddTier: () => void
  onDeleteTier: (index: number) => void
  // Credit-pool-specific handlers — map to the two-tier shape internally.
  onPoolSizeChange: (poolSize: number) => void
  onPoolFeeChange: (poolFee: number) => void
  onOverageRateChange: (overageRate: number) => void
  onCreditRateChange: (memberSignalId: string, rate: number) => void
  onAddPoolMember: (memberSignalId: string) => void
  onRemovePoolMember: (memberSignalId: string) => void
  onBillingFrequencyChange: (frequency: 'monthly' | 'yearly') => void
  onMinimumCommitmentChange: (commitment: number | null) => void
  canAddTier: boolean
}

export function SignalPricingItem({
  signal,
  enabled,
  pricingType,
  price: _price,
  tiers,
  billingFrequency,
  minimumCommitment,
  currencySymbol,
  creditPoolDisabledReason,
  creditRates,
  memberOptions,
  showMidPeriodCaution,
  onToggle,
  onPricingTypeChange,
  onTierUpperChange,
  onTierRateChange,
  onAddTier,
  onDeleteTier,
  onPoolSizeChange,
  onPoolFeeChange,
  onOverageRateChange,
  onCreditRateChange,
  onAddPoolMember,
  onRemovePoolMember,
  onBillingFrequencyChange,
  onMinimumCommitmentChange,
  canAddTier,
}: SignalPricingItemProps) {
  return (
    <div className='mt-4 border-t pt-4'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <IconBolt size={16} className='text-primary' />
          <span className='font-medium'>{signal.name}</span>
        </div>
        <div className='flex items-center'>
          {enabled && pricingType === 'FLAT' && tiers?.[0]?.rate > 0 && (
            <Badge variant='outline' className='mr-2'>
              {currencySymbol}
              {tiers[0].rate}
            </Badge>
          )}
          <Switch checked={enabled} onCheckedChange={onToggle} />
          <IconChevronDown size={16} className='ml-2' />
        </div>
      </div>

      {enabled && (
        <Collapsible defaultOpen>
          <CollapsibleContent className='mt-4 space-y-4'>
            <PricingTypeSelector<PricingType>
              name={`pricing-type-${signal.id}`}
              value={pricingType}
              onChange={onPricingTypeChange}
              options={SIGNAL_PRICING_OPTIONS}
              disabledOptions={
                creditPoolDisabledReason
                  ? { CREDIT_POOL: creditPoolDisabledReason }
                  : undefined
              }
            />

            {pricingType === 'CREDIT_POOL' ? (
              <CreditPoolInputs
                tiers={tiers}
                billingFrequency={billingFrequency}
                currencySymbol={currencySymbol}
                unitLabel='Units'
                poolSignalId={signal.id}
                poolSignalName={signal.name}
                creditRates={creditRates}
                memberOptions={memberOptions}
                showMidPeriodCaution={showMidPeriodCaution}
                onPoolSizeChange={onPoolSizeChange}
                onPoolFeeChange={onPoolFeeChange}
                onOverageRateChange={onOverageRateChange}
                onCreditRateChange={onCreditRateChange}
                onAddPoolMember={onAddPoolMember}
                onRemovePoolMember={onRemovePoolMember}
                onBillingFrequencyChange={onBillingFrequencyChange}
              />
            ) : (
              <PricingTierManager
                pricingType={pricingType}
                tiers={tiers}
                billingFrequency={billingFrequency}
                minimumCommitment={minimumCommitment}
                currencySymbol={currencySymbol}
                unitLabel='Units'
                onTierUpperChange={onTierUpperChange}
                onTierRateChange={onTierRateChange}
                onAddTier={onAddTier}
                onDeleteTier={onDeleteTier}
                onBillingFrequencyChange={onBillingFrequencyChange}
                onMinimumCommitmentChange={onMinimumCommitmentChange}
                canAddTier={canAddTier}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
