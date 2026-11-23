import { Label } from '@/components/ui/label'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import type { PricingType } from '../types'

// Display metadata for each pricing model. Centralized so the selector
// stays declarative and consumers just pick which options to surface.
const OPTION_META: Record<
  PricingType,
  {
    label: string
    tooltipTitle: string
    tooltipDescription: string
    tooltipDetails: string
  }
> = {
  FLAT: {
    label: 'Flat',
    tooltipTitle: 'Flat Pricing',
    tooltipDescription:
      'Every unit costs the same price, no matter how many are used.',
    tooltipDetails:
      'Example: 100 units at $5 each = $500. Simple and predictable.',
  },
  VOLUME: {
    label: 'Volume',
    tooltipTitle: 'Volume Pricing',
    tooltipDescription:
      'The total quantity determines one price that applies to ALL units. Higher volume = lower price for everything.',
    tooltipDetails:
      'Example: Tiers of $10 (1-100 units) and $7 (101+). If a customer uses 150 units, all 150 are charged at $7 = $1,050.',
  },
  GRADUATED: {
    label: 'Graduated',
    tooltipTitle: 'Graduated Pricing',
    tooltipDescription:
      'Each range of units is charged at its own rate, like tax brackets. Earlier units cost more, later units cost less.',
    tooltipDetails:
      'Example: Tiers of $10 (1-100) and $7 (101+). If a customer uses 150 units: first 100 at $10 = $1,000, next 50 at $7 = $350. Total = $1,350.',
  },
  CREDIT_POOL: {
    label: 'Credit Pool',
    tooltipTitle: 'Credit Pool Pricing',
    tooltipDescription:
      'A flat fee for a fixed pool of units, then a per-unit overage rate after the pool runs out. The flat fee is always charged, even if the customer uses zero units.',
    tooltipDetails:
      'Example: $99 for 5,000 API calls, then $0.03 per additional call. 3,000 calls = $99 (pool fee only). 6,000 calls = $99 + (1,000 × $0.03) = $129.',
  },
}

const DEFAULT_OPTIONS: readonly PricingType[] = ['FLAT', 'VOLUME', 'GRADUATED']

interface PricingTypeSelectorProps<T extends PricingType = PricingType> {
  name: string
  value: T
  onChange: (type: T) => void
  // Which options to render. Defaults to FLAT | VOLUME | GRADUATED so
  // callers that omit it (seat-based pricing) don't surface
  // CREDIT_POOL. Signal-based callers pass the full set explicitly.
  options?: readonly T[]
  // Options rendered but not selectable; the value is the reason, shown on
  // hover and to screen readers. Used for the one-active-credit-pool-per-plan
  // rule.
  disabledOptions?: Partial<Record<PricingType, string>>
}

export function PricingTypeSelector<T extends PricingType = PricingType>({
  name,
  value,
  onChange,
  options,
  disabledOptions,
}: PricingTypeSelectorProps<T>) {
  const effectiveOptions =
    options ?? (DEFAULT_OPTIONS as unknown as readonly T[])

  return (
    <div className='flex items-center space-x-4'>
      <div className='flex flex-wrap gap-4'>
        {effectiveOptions.map((opt) => {
          const meta = OPTION_META[opt]
          const id = `${name}-${opt.toLowerCase()}`
          const disabledReason = disabledOptions?.[opt]
          return (
            <div
              key={opt}
              className='flex items-center space-x-2'
              title={disabledReason}
            >
              <input
                type='radio'
                name={name}
                id={id}
                value={opt}
                checked={value === opt}
                disabled={!!disabledReason}
                aria-describedby={
                  disabledReason ? `${id}-disabled-reason` : undefined
                }
                onChange={() => onChange(opt)}
                className='h-4 w-4 text-primary disabled:cursor-not-allowed disabled:opacity-50'
              />
              {disabledReason && (
                <span id={`${id}-disabled-reason`} className='sr-only'>
                  {disabledReason}
                </span>
              )}
              <Label
                htmlFor={id}
                className={
                  disabledReason
                    ? 'text-muted-foreground opacity-60'
                    : undefined
                }
              >
                {meta.label}
              </Label>
              <InfoTooltip
                title={meta.tooltipTitle}
                description={meta.tooltipDescription}
                details={
                  disabledReason
                    ? `${disabledReason} ${meta.tooltipDetails}`
                    : meta.tooltipDetails
                }
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
