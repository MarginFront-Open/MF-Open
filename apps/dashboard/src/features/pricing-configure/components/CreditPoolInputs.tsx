import { useEffect, useState } from 'react'
import { IconTrash } from '@tabler/icons-react'
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
import type { PricingTier } from '../types'

export interface CreditPoolMemberOption {
  id: string
  name: string
  // Non-null when the metric can't join the pool because it already bills on
  // its own. The option still renders, disabled, with this as its reason.
  disabledReason?: string | null
}

/**
 * Credit Pool pricing inputs.
 *
 * Renders three dedicated fields — pool size, pool fee, overage rate —
 * that map onto the two-tier wire shape the backend expects:
 *
 *   tiers[0] = { lower: 0,       upper: poolSize, rate: poolFee }
 *   tiers[1] = { lower: poolSize, upper: null,    rate: overageRate }
 *
 * The generic PricingTierManager can't represent this cleanly because
 * tiers[0]'s rate is a FLAT POOL FEE (not per-unit) — a concept the
 * graduated/volume tier table doesn't understand. Rather than retrofit
 * that table, this component owns the two-row shape end-to-end.
 *
 * Consumer owns tier state + handlers. This component only reads/writes
 * via callbacks, so the same tiers array flows through usePricingOperations
 * → formatForApi() → bulkUpdatePlanStrategies like every other pricing
 * model. It uses the same wire format.
 *
 * It also owns the "What burns credits" member table, which
 * edits the pool strategy's creditRates map. Rate UX lives HERE, on the pool
 * card, not on each signal's own row: a burn rate is a property of the pool,
 * and a signal that burns pool credits has no pricing row of its own.
 */
interface CreditPoolInputsProps {
  tiers: PricingTier[]
  billingFrequency: 'monthly' | 'yearly'
  currencySymbol: string
  unitLabel?: string
  // The signal that owns the pool. Always the first member row, and always a
  // member whether or not creditRates names it (memberRate).
  poolSignalId: string
  poolSignalName: string
  // {signalId: creditsPerUnit}. Undefined on a pool that has never had rates.
  creditRates?: Record<string, number>
  // Every OTHER metric on this plan, eligible or not.
  memberOptions?: CreditPoolMemberOption[]
  // True when the plan has live subscriptions, which is what makes a rate edit
  // land on a bill that's already running.
  showMidPeriodCaution?: boolean
  onPoolSizeChange: (poolSize: number) => void
  onPoolFeeChange: (poolFee: number) => void
  onOverageRateChange: (overageRate: number) => void
  onBillingFrequencyChange: (frequency: 'monthly' | 'yearly') => void
  onCreditRateChange: (memberSignalId: string, rate: number) => void
  onAddPoolMember: (memberSignalId: string) => void
  onRemovePoolMember: (memberSignalId: string) => void
}

export function CreditPoolInputs({
  tiers,
  billingFrequency,
  currencySymbol,
  unitLabel = 'Units',
  poolSignalId,
  poolSignalName,
  creditRates,
  memberOptions = [],
  showMidPeriodCaution = false,
  onPoolSizeChange,
  onPoolFeeChange,
  onOverageRateChange,
  onBillingFrequencyChange,
  onCreditRateChange,
  onAddPoolMember,
  onRemovePoolMember,
}: CreditPoolInputsProps) {
  // Derive the three user-facing numeric values from the two-tier array.
  const poolSize = tiers[0]?.upper ?? 0
  const poolFee = tiers[0]?.rate ?? 0
  const overageRate = tiers[1]?.rate ?? 0

  // Local string state for each input so users can type partial decimals
  // like "0." or "0.0" without the controlled-input dance clobbering the
  // keystroke mid-type. We push the parsed number up to the parent as
  // soon as the string is a valid number; invalid / intermediate values
  // hold the prior parent number so nothing downstream breaks.
  // Binding `value={x === 0 ? '' : x}` straight to the parent would make
  // React reset the DOM to '' after each keystroke while the value is 0,
  // so typing "0.03" would land as $3.
  const [poolSizeStr, setPoolSizeStr] = useState(
    poolSize > 0 ? String(poolSize) : ''
  )
  const [poolFeeStr, setPoolFeeStr] = useState(
    poolFee > 0 ? String(poolFee) : ''
  )
  const [overageRateStr, setOverageRateStr] = useState(
    overageRate > 0 ? String(overageRate) : ''
  )

  // Resync local strings when parent numbers change from the outside
  // (switching pricing types, loading saved data). Only resync when the
  // string's parsed value differs from the new parent number — otherwise
  // we'd overwrite a mid-typed "0." with the parent's 0.
  useEffect(() => {
    const parsed = poolSizeStr === '' ? 0 : parseInt(poolSizeStr, 10)
    if (Number.isNaN(parsed) || parsed !== poolSize) {
      setPoolSizeStr(poolSize > 0 ? String(poolSize) : '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync the text field only when the numeric prop changes
  }, [poolSize])
  useEffect(() => {
    const parsed = poolFeeStr === '' ? 0 : parseFloat(poolFeeStr)
    if (Number.isNaN(parsed) || parsed !== poolFee) {
      setPoolFeeStr(poolFee > 0 ? String(poolFee) : '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync the text field only when the numeric prop changes
  }, [poolFee])
  useEffect(() => {
    const parsed = overageRateStr === '' ? 0 : parseFloat(overageRateStr)
    if (Number.isNaN(parsed) || parsed !== overageRate) {
      setOverageRateStr(overageRate > 0 ? String(overageRate) : '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync the text field only when the numeric prop changes
  }, [overageRate])

  const lowerUnitLabel = unitLabel.toLowerCase()

  // Membership: the pool's own signal, plus every creditRates key. An absent
  // key means rate 1, so the primary row shows 1 until someone edits it.
  const rates = creditRates ?? {}
  const memberIds = Object.keys(rates).filter((id) => id !== poolSignalId)
  const hasMembers = memberIds.length > 0
  const nameFor = (id: string) =>
    memberOptions.find((option) => option.id === id)?.name ?? id
  const addableOptions = memberOptions.filter(
    (option) => !(option.id in rates) && option.id !== poolSignalId
  )

  // The pool is denominated in CREDITS the moment any rate is in play, which
  // is not the same question as "does it have more than one metric." A
  // single-metric pool whose own rate is 4 sizes in credits too: 5,000 there
  // buys 1,250 reports, and labelling it "units" would have an operator size
  // the pool wrong by a factor of the rate.
  const hasRates = hasMembers || (rates[poolSignalId] ?? 1) !== 1
  const poolUnitLabel = hasRates ? 'credits' : lowerUnitLabel
  const overageUnitLabel = hasRates
    ? 'credit'
    : lowerUnitLabel.replace(/s$/, '')

  return (
    <div className='space-y-6'>
      <div className='rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground'>
        The customer pays the pool fee every billing cycle and gets a set number
        of {poolUnitLabel}. When the pool runs out, nothing stops. Each extra{' '}
        {overageUnitLabel} is billed at the overage rate. Every metric below
        draws from that one pool at the rate you set, so the customer watches a
        single countdown instead of one per metric.
      </div>

      <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
        {/* Pool size */}
        <div className='space-y-1.5'>
          <Label className='text-sm'>
            Pool size ({poolUnitLabel} per cycle)
          </Label>
          <Input
            type='number'
            className='h-9'
            value={poolSizeStr}
            placeholder='e.g. 5000'
            min={1}
            step={1}
            onChange={(e) => {
              const next = e.target.value
              setPoolSizeStr(next)
              if (next === '') {
                onPoolSizeChange(0)
                return
              }
              const val = parseInt(next, 10)
              if (Number.isFinite(val)) {
                onPoolSizeChange(val)
              }
            }}
          />
        </div>

        {/* Pool fee */}
        <div className='space-y-1.5'>
          <Label className='text-sm'>Pool fee (flat, per cycle)</Label>
          <div className='flex items-center gap-1'>
            <span className='text-sm text-muted-foreground'>
              {currencySymbol}
            </span>
            <Input
              type='number'
              className='h-9'
              value={poolFeeStr}
              placeholder='0.00'
              min={0}
              step='any'
              onChange={(e) => {
                const next = e.target.value
                setPoolFeeStr(next)
                if (next === '') {
                  onPoolFeeChange(0)
                  return
                }
                const val = parseFloat(next)
                if (Number.isFinite(val)) {
                  onPoolFeeChange(val)
                }
              }}
            />
          </div>
        </div>

        {/* Overage rate */}
        <div className='space-y-1.5'>
          <Label className='text-sm'>
            Overage rate (per {overageUnitLabel})
          </Label>
          <div className='flex items-center gap-1'>
            <span className='text-sm text-muted-foreground'>
              {currencySymbol}
            </span>
            <Input
              type='number'
              className='h-9'
              value={overageRateStr}
              placeholder='0.00'
              min={0}
              step='any'
              onChange={(e) => {
                const next = e.target.value
                setOverageRateStr(next)
                if (next === '') {
                  onOverageRateChange(0)
                  return
                }
                const val = parseFloat(next)
                if (Number.isFinite(val)) {
                  onOverageRateChange(val)
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* What burns credits — the pool's member metrics and their rates. */}
      <div className='space-y-3'>
        <div className='space-y-1'>
          <Label className='text-sm'>What burns credits</Label>
          <p className='text-xs text-muted-foreground'>
            Set how many credits one unit of each metric burns. A metric you
            don&apos;t list here doesn&apos;t touch the pool.
          </p>
        </div>

        <div className='space-y-2'>
          <div className='grid grid-cols-[1fr_140px_40px] items-center gap-3 text-xs text-muted-foreground'>
            <span>Metric</span>
            <span>Credits per unit</span>
            <span />
          </div>

          <MemberRateRow
            key={poolSignalId}
            name={poolSignalName}
            note='Pool metric'
            rate={rates[poolSignalId] ?? 1}
            onRateChange={(rate) => onCreditRateChange(poolSignalId, rate)}
          />

          {memberIds.map((memberId) => (
            <MemberRateRow
              key={memberId}
              name={nameFor(memberId)}
              rate={rates[memberId]}
              onRateChange={(rate) => onCreditRateChange(memberId, rate)}
              onRemove={() => onRemovePoolMember(memberId)}
            />
          ))}
        </div>

        {addableOptions.length > 0 && (
          <Select
            // Remounting on every pick resets the trigger to its placeholder,
            // so this reads as an action menu rather than a field holding the
            // last metric added.
            key={`add-member-${memberIds.length}`}
            onValueChange={onAddPoolMember}
          >
            <SelectTrigger className='h-9 w-[220px]'>
              <SelectValue placeholder='Add metric' />
            </SelectTrigger>
            <SelectContent>
              {addableOptions.map((option) => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  disabled={!!option.disabledReason}
                >
                  {option.name}
                  {option.disabledReason ? (
                    <span className='ml-2 text-xs text-muted-foreground'>
                      {option.disabledReason}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {showMidPeriodCaution && (
          <p className='text-xs text-muted-foreground'>
            This plan has active subscriptions. A rate change applies to the
            bill for the period that&apos;s running right now, not the next one.
            Change rates at a period boundary if you don&apos;t want them to
            land mid-cycle.
          </p>
        )}
      </div>

      {/* Matches PricingTierManager's bottom row, minus Min. commitment: the
          pool fee already IS the floor, and the server rejects a commitment on
          this model. Don't add that field here. */}
      <div className='flex items-center gap-6 pt-2'>
        <div className='flex items-center gap-2'>
          <Label className='text-sm text-muted-foreground'>Billing:</Label>
          <Select
            value={billingFrequency}
            onValueChange={(v) =>
              onBillingFrequencyChange(v as 'monthly' | 'yearly')
            }
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
      </div>
    </div>
  )
}

interface MemberRateRowProps {
  name: string
  rate: number
  note?: string
  onRateChange: (rate: number) => void
  onRemove?: () => void
}

/**
 * One member metric and its burn rate. Its own component because each row
 * needs the local-string-state treatment the pool fields get above — the same
 * partial-decimal foot-gun, and hooks can't be called in a loop.
 *
 * An emptied box commits 0, which is NOT a legal rate. That's deliberate: 0
 * reaches validatePricingForm, which names the metric and blocks the save.
 * Holding the last good number instead would leave the box and the state
 * disagreeing with nothing on screen to say so.
 */
function MemberRateRow({
  name,
  rate,
  note,
  onRateChange,
  onRemove,
}: MemberRateRowProps) {
  const [rateStr, setRateStr] = useState(rate > 0 ? String(rate) : '')

  useEffect(() => {
    const parsed = rateStr === '' ? 0 : parseFloat(rateStr)
    if (Number.isNaN(parsed) || parsed !== rate) {
      setRateStr(rate > 0 ? String(rate) : '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync the text field only when the numeric prop changes
  }, [rate])

  return (
    <div className='grid grid-cols-[1fr_140px_40px] items-center gap-3'>
      <div className='flex items-center gap-2'>
        <span className='truncate text-sm'>{name}</span>
        {note ? (
          <span className='text-xs text-muted-foreground'>{note}</span>
        ) : null}
      </div>
      <Input
        type='number'
        className='h-9'
        aria-label={`Credits per unit for ${name}`}
        value={rateStr}
        placeholder='1'
        min={0}
        step='any'
        onChange={(e) => {
          const next = e.target.value
          setRateStr(next)
          if (next === '') {
            onRateChange(0)
            return
          }
          const val = parseFloat(next)
          if (Number.isFinite(val)) {
            onRateChange(val)
          }
        }}
      />
      <div className='flex justify-center'>
        {onRemove ? (
          <Button
            variant='ghost'
            size='icon'
            aria-label={`Remove ${name} from the pool`}
            className='h-8 w-8 text-muted-foreground hover:text-destructive'
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
