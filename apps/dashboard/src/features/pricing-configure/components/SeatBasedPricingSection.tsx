import { IconChevronDown, IconUsers } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { PricingTierManager } from './PricingTierManager'
import { PricingTypeSelector } from './PricingTypeSelector'

interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

interface SeatBasedPricingSectionProps {
  enabled: boolean
  pricingType: 'FLAT' | 'VOLUME' | 'GRADUATED'
  tiers: PricingTier[]
  billingFrequency: 'monthly' | 'yearly'
  minimumCommitment: number | null
  currencySymbol: string
  onToggle: () => void
  onPricingTypeChange: (type: 'FLAT' | 'VOLUME' | 'GRADUATED') => void
  onTierUpperChange: (index: number, upper: number | null) => void
  onTierRateChange: (index: number, rate: number) => void
  onAddTier: () => void
  onDeleteTier: (index: number) => void
  onBillingFrequencyChange: (frequency: 'monthly' | 'yearly') => void
  onMinimumCommitmentChange: (commitment: number | null) => void
  canAddTier: boolean
}

export function SeatBasedPricingSection({
  enabled,
  pricingType,
  tiers,
  billingFrequency,
  minimumCommitment,
  currencySymbol,
  onToggle,
  onPricingTypeChange,
  onTierUpperChange,
  onTierRateChange,
  onAddTier,
  onDeleteTier,
  onBillingFrequencyChange,
  onMinimumCommitmentChange,
  canAddTier,
}: SeatBasedPricingSectionProps) {
  return (
    <Card className='border shadow-sm'>
      <CardContent className='p-0'>
        <div className='flex items-center justify-between p-4'>
          <div className='flex items-center gap-2'>
            <IconUsers size={16} className='text-primary' />
            <span className='font-medium'>Seat-based</span>
            <InfoTooltip {...tooltipDefinitions.seatBasedPricing} />
          </div>
          <div className='flex items-center gap-4'>
            <Badge variant='outline' className='font-normal'>
              VARIABLE
            </Badge>
            <Badge variant='outline' className='font-normal'>
              RECURRING
            </Badge>
            <Switch checked={enabled} onCheckedChange={onToggle} />
            <IconChevronDown size={16} />
          </div>
        </div>

        {enabled && (
          <Collapsible defaultOpen>
            <CollapsibleContent className='mt-4 space-y-6 p-4 pt-0'>
              <PricingTypeSelector
                name='seat-pricing-type'
                value={pricingType}
                onChange={onPricingTypeChange}
              />

              <PricingTierManager
                pricingType={pricingType}
                tiers={tiers}
                billingFrequency={billingFrequency}
                minimumCommitment={minimumCommitment}
                currencySymbol={currencySymbol}
                unitLabel='Seats'
                onTierUpperChange={onTierUpperChange}
                onTierRateChange={onTierRateChange}
                onAddTier={onAddTier}
                onDeleteTier={onDeleteTier}
                onBillingFrequencyChange={onBillingFrequencyChange}
                onMinimumCommitmentChange={onMinimumCommitmentChange}
                canAddTier={canAddTier}
              />
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}
