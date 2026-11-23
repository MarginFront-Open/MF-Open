import { useState } from 'react'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { displayRate, parseRateInput } from '../rate-input'
import type { PricingType } from '../types'

interface PricingTier {
  lower: number
  upper: number | null
  rate: number
}

interface PricingTierManagerProps {
  // Wide union so SignalPricingItem can pass its wide `PricingType` state
  // through without casting. At runtime the parent routes CREDIT_POOL to
  // CreditPoolInputs so this component never actually renders for it.
  pricingType: PricingType
  tiers: PricingTier[]
  billingFrequency: 'monthly' | 'yearly'
  minimumCommitment?: number | null
  currencySymbol: string
  unitLabel?: string
  onTierUpperChange: (index: number, upper: number | null) => void
  onTierRateChange: (index: number, rate: number) => void
  onAddTier: () => void
  onDeleteTier: (index: number) => void
  onBillingFrequencyChange: (frequency: 'monthly' | 'yearly') => void
  onMinimumCommitmentChange?: (commitment: number | null) => void
  canAddTier: boolean
}

export function PricingTierManager({
  pricingType,
  tiers,
  billingFrequency,
  minimumCommitment,
  currencySymbol,
  unitLabel = 'Units',
  onTierUpperChange,
  onTierRateChange,
  onAddTier,
  onDeleteTier,
  onBillingFrequencyChange,
  onMinimumCommitmentChange,
  canAddTier,
}: PricingTierManagerProps) {
  // Raw keystrokes per row, held locally so transient states ('', '0.')
  // survive the re-render instead of snapping back to the committed number.
  // A snap-back eats the decimal point (0.5 becomes 5) and makes the field
  // impossible to clear. Cleared on blur.
  const [rateDrafts, setRateDrafts] = useState<Record<number, string>>({})

  return (
    <div className='space-y-6'>
      {/* Tier rows */}
      <div className='space-y-3'>
        {/* Header */}
        <div className='grid grid-cols-[40px_1fr_1fr_40px] gap-3 px-1 text-xs font-medium text-muted-foreground'>
          <div>#</div>
          <div>Range</div>
          <div>Price per {unitLabel.toLowerCase()}</div>
          <div></div>
        </div>

        {tiers.map((tier, index) => (
          <div
            key={index}
            className='grid grid-cols-[40px_1fr_1fr_40px] items-center gap-3'
          >
            <div className='flex h-9 items-center justify-center rounded-md bg-muted text-sm font-medium'>
              {index + 1}
            </div>

            {/* Range column */}
            <div className='flex items-center gap-2 text-sm'>
              <span className='text-muted-foreground'>{tier.lower}</span>
              <span className='text-muted-foreground'>→</span>
              {pricingType === 'FLAT' ? (
                <span className='text-muted-foreground'>∞</span>
              ) : (
                <Input
                  type='number'
                  className='h-9 w-20'
                  value={
                    tier.upper === null || tier.upper === 0 ? '' : tier.upper
                  }
                  placeholder='∞'
                  min={tier.lower + 1}
                  onChange={(e) => {
                    const val =
                      e.target.value === ''
                        ? null
                        : parseInt(e.target.value, 10)
                    onTierUpperChange(index, isNaN(val as number) ? null : val)
                  }}
                />
              )}
            </div>

            {/* Price column */}
            <div className='flex items-center gap-1'>
              <span className='text-sm text-muted-foreground'>
                {currencySymbol}
              </span>
              <Input
                type='number'
                className='h-9 w-24'
                value={rateDrafts[index] ?? displayRate(tier.rate)}
                placeholder='0.00'
                min={0}
                step='any'
                onChange={(e) => {
                  const raw = e.target.value
                  setRateDrafts((prev) => ({ ...prev, [index]: raw }))
                  const parsed = parseRateInput(raw)
                  if (parsed !== null) {
                    onTierRateChange(index, parsed)
                  }
                }}
                onBlur={() => {
                  const draft = rateDrafts[index]
                  if (draft === undefined) return
                  if (draft.trim() === '') {
                    onTierRateChange(index, 0)
                  }
                  setRateDrafts((prev) => {
                    const next = { ...prev }
                    delete next[index]
                    return next
                  })
                }}
              />
            </div>

            {/* Delete button */}
            <div className='flex justify-center'>
              {index > 0 && pricingType !== 'FLAT' && (
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground hover:text-destructive'
                  onClick={() => onDeleteTier(index)}
                >
                  <IconTrash size={14} />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add tier button - only for VOLUME and GRADUATED */}
      {pricingType !== 'FLAT' && (
        <Button
          variant='ghost'
          size='sm'
          className='text-muted-foreground hover:text-foreground'
          onClick={onAddTier}
          disabled={!canAddTier}
        >
          <IconPlus size={14} className='mr-1' />
          Add tier
        </Button>
      )}

      {/* Options row */}
      <div className='flex items-center gap-6 pt-2'>
        {/* Billing frequency */}
        <div className='flex items-center gap-2'>
          <Label className='text-sm text-muted-foreground'>Billing:</Label>
          <Select
            value={billingFrequency}
            onValueChange={onBillingFrequencyChange}
          >
            <SelectTrigger className='h-9 w-[120px]'>
              <SelectValue placeholder='Monthly' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='monthly'>Monthly</SelectItem>
              <SelectItem value='yearly'>Yearly</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Minimum commitment - optional */}
        {onMinimumCommitmentChange && (
          <div className='flex items-center gap-2'>
            <Label className='text-sm text-muted-foreground'>
              Min. commitment:
            </Label>
            <Input
              type='number'
              className='h-9 w-20'
              value={
                minimumCommitment === 0 || minimumCommitment === null
                  ? ''
                  : minimumCommitment
              }
              placeholder='0'
              onChange={(e) => {
                const value =
                  e.target.value === '' ? null : parseInt(e.target.value, 10)
                onMinimumCommitmentChange(isNaN(value as number) ? null : value)
              }}
              min={0}
            />
          </div>
        )}
      </div>
    </div>
  )
}
