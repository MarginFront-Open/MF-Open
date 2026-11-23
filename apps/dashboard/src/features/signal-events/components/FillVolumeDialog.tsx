'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  fillMissingVolume,
  type MissingVolumeGroup,
} from '@/app/actions/signal-events'
import { formatCost } from '@/lib/canon-format'
import {
  classifyBackfillOutcome,
  type BackfillOutcome,
} from '../lib/classify-backfill-outcome'
import { describeMissingCacheRates } from '../lib/find-missing-cache-rates'

interface FillVolumeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: MissingVolumeGroup[]
  onSuccess: () => void
}

// Twin of MapSuccessResult in MapModelDialog, plus the volume the user
// entered — captured at click time, since the parent drops the filled rows.
interface FillSuccessResult {
  groupsFilledCount: number
  groupsFailedCount: number
  totalBackfilled: number
  totalCostUsd: number
  // Feeds the zero_cost outcome (see classify-backfill-outcome.ts).
  targetHasPaidRates: boolean
  // Guard-refused children. NOT in totalBackfilled — they are still unpriced.
  totalRefused: number
  refusedRates: string[]
  sourceGroups: { model: string; provider: string; count: number }[]
  volume: {
    isLlm: boolean
    inputTokens?: number
    outputTokens?: number
    quantity?: number
    unitLabel: string
  }
  // Deep-link target for "View in Ingestion Log". undefined when no group
  // carried samples.
  representativeEventId?: string
}

export const FillVolumeDialog = ({
  open,
  onOpenChange,
  groups,
  onSuccess,
}: FillVolumeDialogProps) => {
  const router = useRouter()
  const [inputTokens, setInputTokens] = useState('')
  const [outputTokens, setOutputTokens] = useState('')
  const [quantity, setQuantity] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [successResult, setSuccessResult] = useState<FillSuccessResult | null>(
    null
  )

  // Assumes every group in one call shares a service type, which is how the
  // caller groups them.
  const firstGroup = groups[0]
  if (!firstGroup) return null

  const isLlm = firstGroup.costUnit === '1M tokens'
  const totalEvents = groups.reduce((sum, g) => sum + g.count, 0)

  // costUnit is like "1K pages" → "pages", or "request" → "requests"
  const nonLlmUnitLabel = !isLlm
    ? (firstGroup.costUnit?.replace(/^1K /, '') ?? 'units')
    : 'units'

  const canSubmit = isLlm
    ? inputTokens !== '' && outputTokens !== ''
    : quantity !== ''

  const handleConfirm = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)

    let totalBackfilled = 0
    let totalCostUsd = 0
    let targetHasPaidRates = false
    let failures = 0
    let totalRefused = 0
    const refusedRates = new Set<string>()

    for (const group of groups) {
      const result = await fillMissingVolume(
        group.model,
        group.provider,
        isLlm ? Number(inputTokens) : undefined,
        isLlm ? Number(outputTokens) : undefined,
        !isLlm ? Number(quantity) : undefined
      )

      if (result.success && result.data) {
        totalBackfilled += result.data.backfilled
        totalCostUsd += result.data.totalCostUsd
        // One paid-rate group is enough to make an all-$0.00 run suspicious.
        targetHasPaidRates =
          targetHasPaidRates || result.data.targetHasPaidRates
        totalRefused += result.data.refused
        for (const rate of result.data.refusedRates) refusedRates.add(rate)
      } else {
        failures++
        console.error(
          `[FillVolumeDialog] Failed for ${group.model}:`,
          result.error
        )
      }
    }

    setIsSubmitting(false)

    // Deliberately does not close the dialog — Done or View events does.
    setSuccessResult({
      groupsFilledCount: groups.length - failures,
      groupsFailedCount: failures,
      totalBackfilled,
      totalCostUsd,
      targetHasPaidRates,
      totalRefused,
      refusedRates: [...refusedRates],
      sourceGroups: groups.map((g) => ({
        model: g.model,
        provider: g.provider,
        count: g.count,
      })),
      volume: {
        isLlm,
        inputTokens: isLlm ? Number(inputTokens) : undefined,
        outputTokens: isLlm ? Number(outputTokens) : undefined,
        quantity: !isLlm ? Number(quantity) : undefined,
        unitLabel: nonLlmUnitLabel,
      },
      representativeEventId: groups[0]?.samples?.[0]?.eventId,
    })

    // No success toast on purpose: the panel is the sole confirmation
    // surface, so it cannot vanish before the user clicks through it.
  }

  // onSuccess fires only when closing OUT of the success state, so closing
  // via X or Cancel before the run never drops groups off the parent's list.
  const handleClose = () => {
    const wasSuccess = successResult !== null
    setInputTokens('')
    setOutputTokens('')
    setQuantity('')
    setSuccessResult(null)
    onOpenChange(false)
    if (wasSuccess) onSuccess()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose()
        else onOpenChange(next)
      }}
    >
      <DialogContent className='flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-md'>
        {successResult ? (
          <FillSuccessView
            result={successResult}
            onDone={handleClose}
            onViewEvents={() => {
              // The eventId param makes the Ingestion Log auto-open that
              // event's sidebar, so the user lands on proof, not a list.
              const eventId = successResult.representativeEventId
              handleClose()
              router.push(
                eventId
                  ? `/metrics-events/raw-events?eventId=${eventId}`
                  : '/metrics-events/raw-events'
              )
            }}
            formatCostUsd={formatCost}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Fill volume data</DialogTitle>
              <DialogDescription>
                Provide the {isLlm ? 'token counts' : 'quantity'} for{' '}
                <span className='font-medium text-foreground'>
                  {firstGroup.model}
                </span>{' '}
                ({firstGroup.provider}).
                {totalEvents > 1 && (
                  <>
                    {' '}
                    These values will be applied to all {totalEvents} events.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className='flex-1 space-y-4 overflow-y-auto py-2 pr-1'>
              <div className='rounded-md border bg-muted/30 px-3 py-2 text-sm'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>Model</span>
                  <span className='font-mono'>{firstGroup.model}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>Provider</span>
                  <span>{firstGroup.provider}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>Events</span>
                  <span className='font-medium'>{totalEvents}</span>
                </div>
              </div>

              {isLlm && (
                <>
                  <div className='space-y-2'>
                    <Label htmlFor='inputTokens'>
                      Input tokens <span className='text-destructive'>*</span>
                    </Label>
                    <Input
                      id='inputTokens'
                      type='number'
                      min={0}
                      placeholder='e.g. 500'
                      value={inputTokens}
                      onChange={(e) => setInputTokens(e.target.value)}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='outputTokens'>
                      Output tokens <span className='text-destructive'>*</span>
                    </Label>
                    <Input
                      id='outputTokens'
                      type='number'
                      min={0}
                      placeholder='e.g. 100'
                      value={outputTokens}
                      onChange={(e) => setOutputTokens(e.target.value)}
                    />
                  </div>
                </>
              )}

              {!isLlm && (
                <div className='space-y-2'>
                  <Label htmlFor='quantity'>
                    Quantity ({nonLlmUnitLabel}){' '}
                    <span className='text-destructive'>*</span>
                  </Label>
                  <Input
                    id='quantity'
                    type='number'
                    min={0}
                    placeholder='e.g. 5'
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                  <p className='text-xs text-muted-foreground'>
                    Each event will be costed as this many {nonLlmUnitLabel}.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant='outline' onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                Fill &amp; recalculate
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Twin of MapSuccessView, minus the "future events auto-map" note: volume is
// written straight onto the events, with no org_model_mappings equivalent to
// carry it forward. Green is earned only by events actually getting priced,
// composing with the hasFailures amber path for thrown errors.
function FillSuccessView({
  result,
  onDone,
  onViewEvents,
  formatCostUsd,
}: {
  result: FillSuccessResult
  onDone: () => void
  onViewEvents: () => void
  formatCostUsd: (n: number) => string
}) {
  const hasFailures = result.groupsFailedCount > 0
  const outcome: BackfillOutcome = classifyBackfillOutcome({
    backfilled: result.totalBackfilled,
    totalCostUsd: result.totalCostUsd,
    targetHasPaidRates: result.targetHasPaidRates,
    refused: result.totalRefused,
  })
  const isWarning = outcome !== 'success' || hasFailures
  const first = result.sourceGroups[0]

  return (
    <>
      <DialogHeader>
        <div className='flex items-center gap-3'>
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              isWarning
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            )}
          >
            {isWarning ? (
              <AlertTriangle className='h-5 w-5' />
            ) : (
              <CheckCircle2 className='h-5 w-5' />
            )}
          </div>
          <div className='flex-1 space-y-0.5'>
            <DialogTitle>
              {hasFailures
                ? 'Filled with errors'
                : outcome === 'all_refused'
                  ? 'Nothing could be priced'
                  : outcome === 'partial_refused'
                    ? `Filled, ${result.totalRefused.toLocaleString()} still unpriced`
                    : outcome === 'zero_match'
                      ? 'No events matched'
                      : outcome === 'zero_cost'
                        ? 'Filled, but nothing was priced'
                        : 'Volume filled'}
            </DialogTitle>
            <DialogDescription>
              {outcome === 'all_refused'
                ? 'None of these events could be priced, so none of them were billed.'
                : outcome === 'partial_refused'
                  ? 'Some events were priced; the rest could not be, and were left alone.'
                  : outcome === 'zero_match'
                    ? 'This fill matched 0 events, so nothing changed.'
                    : outcome === 'zero_cost'
                      ? 'The volume was applied, but every matched event priced to $0.00.'
                      : 'All matching events are now priced and moved to PROCESSED.'}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className='flex-1 space-y-4 overflow-y-auto pr-1'>
        <div className='rounded-lg border bg-muted/30 px-4 py-3'>
          <p className='mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
            Applied to {first.model}
            {first.provider ? (
              <span className='normal-case text-muted-foreground'>
                {' '}
                · {first.provider}
              </span>
            ) : null}
          </p>
          {result.volume.isLlm ? (
            <div className='flex items-baseline gap-4 text-sm'>
              <div>
                <span className='font-mono font-medium tabular-nums'>
                  {result.volume.inputTokens?.toLocaleString() ?? '0'}
                </span>
                <span className='ml-1 text-xs text-muted-foreground'>
                  input tokens
                </span>
              </div>
              <div>
                <span className='font-mono font-medium tabular-nums'>
                  {result.volume.outputTokens?.toLocaleString() ?? '0'}
                </span>
                <span className='ml-1 text-xs text-muted-foreground'>
                  output tokens
                </span>
              </div>
            </div>
          ) : (
            <div className='text-sm'>
              <span className='font-mono font-medium tabular-nums'>
                {result.volume.quantity?.toLocaleString() ?? '0'}
              </span>
              <span className='ml-1 text-xs text-muted-foreground'>
                {result.volume.unitLabel}
              </span>
            </div>
          )}
        </div>

        <div className='grid grid-cols-2 gap-3'>
          <div className='rounded-lg border bg-background px-4 py-3'>
            <p className='text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
              Events backfilled
            </p>
            <p className='mt-1 text-2xl font-semibold tabular-nums'>
              {result.totalBackfilled.toLocaleString()}
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              {result.totalBackfilled > 0
                ? 'status → PROCESSED'
                : 'no status changes'}
            </p>
          </div>
          {/* The hardcoded 0 is correct: queued events always start with a
              null cost, and the framing is what makes a $0.00 → $0.00 no-op
              run read as a no-op. */}
          <div className='rounded-lg border bg-background px-4 py-3'>
            <p className='text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
              Cost before → after
            </p>
            <p className='mt-1 text-xl font-semibold tabular-nums'>
              {formatCostUsd(0)}
              <ArrowRight className='mx-1 inline h-4 w-4 text-muted-foreground' />
              {formatCostUsd(result.totalCostUsd)}
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              sum of new usageCost
            </p>
          </div>
        </div>

        {(outcome === 'all_refused' || outcome === 'partial_refused') && (
          <div className='rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm'>
            <p className='font-medium text-amber-900 dark:text-amber-400'>
              {result.totalRefused.toLocaleString()} event
              {result.totalRefused === 1 ? '' : 's'} left unpriced
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              These events spend money{' '}
              {describeMissingCacheRates(result.refusedRates)}, and the model
              they are priced against has no rate for that. Charging $0.00 for
              it would bill less than was actually spent, so they were left
              alone and stay on this list. Run the pricing sync to fill the rate
              in.
            </p>
          </div>
        )}

        {outcome === 'zero_match' && (
          <div className='rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm'>
            <p className='font-medium text-amber-900 dark:text-amber-400'>
              0 events matched this fill
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              The events may already be priced, or someone else filled them
              first. Refresh the queue to see its current state.
            </p>
          </div>
        )}

        {outcome === 'zero_cost' && (
          <div className='rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm'>
            <p className='font-medium text-amber-900 dark:text-amber-400'>
              Matched {result.totalBackfilled.toLocaleString()} event
              {result.totalBackfilled === 1 ? '' : 's'} but priced $0.00 against
              a paid rate
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              Check the volume you entered. Filling with zero volume prices
              every event at $0.00.
            </p>
          </div>
        )}

        {hasFailures && (
          <div className='rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm'>
            <p className='font-medium text-amber-900 dark:text-amber-400'>
              {result.groupsFailedCount} group
              {result.groupsFailedCount === 1 ? '' : 's'} failed
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              Check the browser console for error details. The rest landed.
            </p>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant='outline' onClick={onViewEvents}>
          View in Ingestion Log
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  )
}
