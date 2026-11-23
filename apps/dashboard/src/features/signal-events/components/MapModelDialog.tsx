'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useServicePricing } from '@/hooks/use-service-pricing'
import {
  mapModelAndBackfill,
  type BackfillGroup,
} from '@/app/actions/signal-events'
import { formatCost } from '@/lib/canon-format'
import {
  classifyBackfillOutcome,
  type BackfillOutcome,
} from '../lib/classify-backfill-outcome'
import {
  findMissingCacheRates,
  describeMissingCacheRates,
} from '../lib/find-missing-cache-rates'

interface MapModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: BackfillGroup[]
  onSuccess: () => void
}

function formatPrice(cost: number | null): string {
  return cost === null ? '—' : formatCost(cost)
}

// Everything the success panel needs, captured at click time — the parent
// removes the mapped rows once the run finishes, so the panel cannot read
// them back off `groups`.
interface MapSuccessResult {
  groupsMappedCount: number
  groupsFailedCount: number
  totalBackfilled: number
  totalCostUsd: number
  sourceGroups: { model: string; provider: string; count: number }[]
  target: {
    displayName: string
    provider: string
  }
  // Feeds the zero_cost outcome (see classify-backfill-outcome.ts).
  targetHasPaidRates: boolean
  // Guard-refused children. NOT in totalBackfilled — they are still unpriced.
  totalRefused: number
  refusedRates: string[]
  // Deep-link target for "View in Ingestion Log". undefined when no group
  // carried samples.
  representativeEventId?: string
}

export function MapModelDialog({
  open,
  onOpenChange,
  groups,
  onSuccess,
}: MapModelDialogProps) {
  const router = useRouter()
  const { entries, isLoading: pricingLoading } = useServicePricing()
  const [selectedPricingId, setSelectedPricingId] = useState('')
  const [search, setSearch] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [successResult, setSuccessResult] = useState<MapSuccessResult | null>(
    null
  )

  const isBatch = groups.length > 1
  const totalEvents = groups.reduce((sum, g) => sum + g.count, 0)

  const filtered = useMemo(() => {
    if (!search.trim()) return entries.slice(0, 50)
    const lower = search.toLowerCase()
    return entries
      .filter(
        (e) =>
          e.displayName.toLowerCase().includes(lower) ||
          e.id.toLowerCase().includes(lower) ||
          e.provider.toLowerCase().includes(lower)
      )
      .slice(0, 50)
  }, [entries, search])

  const selected = entries.find((e) => e.id === selectedPricingId)

  // Asked BEFORE the run so the operator can still pick a different row.
  // Summed across groups because "Map all" commits them together.
  const cacheRatesMissing = useMemo(() => {
    if (!selected) return []
    return findMissingCacheRates({
      costUnit: selected.costUnit,
      cacheReadCost: selected.cacheReadCost,
      cacheWriteCost: selected.cacheWriteCost,
      cacheReadTokens: groups.reduce(
        (sum, g) => sum + (g.cacheReadTokens ?? 0),
        0
      ),
      cacheWriteTokens: groups.reduce(
        (sum, g) => sum + (g.cacheWriteTokens ?? 0),
        0
      ),
    })
  }, [selected, groups])

  const handleConfirm = async () => {
    if (!selectedPricingId) {
      toast({ title: 'Pick a model to map to', variant: 'warning' })
      return
    }

    setIsSubmitting(true)
    try {
      let totalBackfilled = 0
      let totalCostUsd = 0
      let failures = 0
      let totalRefused = 0
      const refusedRates = new Set<string>()

      for (const group of groups) {
        const result = await mapModelAndBackfill(
          group.model,
          group.provider,
          selectedPricingId
        )
        if (result.success && result.data) {
          totalBackfilled += result.data.backfilled
          totalCostUsd += result.data.totalCostUsd
          totalRefused += result.data.refused
          for (const rate of result.data.refusedRates) refusedRates.add(rate)
        } else {
          failures++
          console.error(
            `[MapModelDialog] Failed to map ${group.model}/${group.provider}:`,
            result.error
          )
        }
      }

      // Deliberately does not close the dialog — Done or View events does.
      setSuccessResult({
        groupsMappedCount: groups.length - failures,
        groupsFailedCount: failures,
        totalBackfilled,
        totalCostUsd,
        sourceGroups: groups.map((g) => ({
          model: g.model,
          provider: g.provider,
          count: g.count,
        })),
        target: selected
          ? { displayName: selected.displayName, provider: selected.provider }
          : { displayName: 'selected model', provider: '' },
        targetHasPaidRates:
          (selected?.inputCost ?? 0) > 0 || (selected?.outputCost ?? 0) > 0,
        totalRefused,
        refusedRates: [...refusedRates],
        representativeEventId: groups[0]?.samples?.[0]?.eventId,
      })

      // No success toast on purpose: the panel is the sole confirmation
      // surface, so it cannot vanish before the user clicks through it.
    } catch (error) {
      console.error('[MapModelDialog] Error:', error)
      toast({
        title: 'Something went wrong',
        description: 'Check the console for details',
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // onSuccess fires only when closing OUT of the success state, so closing
  // via X or Cancel before the run never drops groups off the parent's list.
  const handleClose = () => {
    const wasSuccess = successResult !== null
    setSelectedPricingId('')
    setSearch('')
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
      <DialogContent className='flex max-h-[85vh] flex-col gap-4 overflow-hidden'>
        {successResult ? (
          <MapSuccessView
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
              <DialogTitle>
                {isBatch
                  ? `Map ${groups.length} unknown models`
                  : 'Map unknown model'}
              </DialogTitle>
              <DialogDescription>
                {isBatch
                  ? `Pick one known model to use as the cost basis for all ${groups.length} unknown models (${totalEvents} events total).`
                  : 'Pick a known model for cost calculation.'}
              </DialogDescription>
            </DialogHeader>

            <div className='flex-1 space-y-3 overflow-y-auto pr-1'>
              {/* Source — single model or batch summary */}
              <div className='rounded-md border border-border/50 bg-muted/50 px-3 py-2'>
                <p className='text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
                  {isBatch ? 'Mapping these models' : 'Mapping from'}
                </p>
                {isBatch ? (
                  <ul className='mt-1 space-y-0.5'>
                    {groups.map((g) => (
                      <li
                        key={`${g.model}-${g.provider}`}
                        className='truncate text-sm'
                      >
                        <span className='font-medium'>{g.model}</span>
                        <span className='ml-1 text-muted-foreground'>
                          ({g.provider}) · {g.count} event
                          {g.count === 1 ? '' : 's'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <p className='truncate text-sm font-medium'>
                      {groups[0].model}
                      <span className='ml-1 font-normal text-muted-foreground'>
                        ({groups[0].provider})
                      </span>
                    </p>
                    <p className='mt-0.5 text-xs text-muted-foreground'>
                      Will backfill {groups[0].count.toLocaleString()} event
                      {groups[0].count === 1 ? '' : 's'}
                    </p>
                  </>
                )}
              </div>

              {/* Selected target preview — click to change */}
              {selected ? (
                <button
                  type='button'
                  className='w-full rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left'
                  onClick={() => setSelectedPricingId('')}
                >
                  <p className='text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
                    Map to{' '}
                    <span className='normal-case'>(click to change)</span>
                  </p>
                  <p className='truncate text-sm font-medium'>
                    {selected.displayName}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    {selected.provider} · {formatPrice(selected.inputCost)}
                    {!selected.isApi &&
                      ` / ${formatPrice(selected.outputCost)}`}{' '}
                    per {selected.costUnit}
                  </p>
                </button>
              ) : null}

              {/* The row above shows input and output prices, which reads as
                  "fully priced" even when the row prices no cache at all. */}
              {selected && cacheRatesMissing.length > 0 && (
                <div className='rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm'>
                  <p className='font-medium text-amber-900 dark:text-amber-400'>
                    {selected.displayName} has no price for prompt caching
                  </p>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    These events spend money{' '}
                    {describeMissingCacheRates(cacheRatesMissing)}, and this
                    model has no rate for that. Charging $0.00 for it would bill
                    less than was actually spent, so those events will be left
                    unpriced and stay on this list. Pick a model that prices
                    caching, or run the pricing sync and try again.
                  </p>
                </div>
              )}

              {!selected && (
                <Command
                  shouldFilter={false}
                  className='overflow-hidden rounded-md border'
                >
                  <CommandInput
                    placeholder={
                      pricingLoading ? 'Loading...' : 'Search models...'
                    }
                    value={search}
                    onValueChange={setSearch}
                  />
                  <CommandList className='max-h-[200px]'>
                    {filtered.length === 0 && (
                      <CommandEmpty>
                        {pricingLoading ? 'Loading...' : 'No results.'}
                      </CommandEmpty>
                    )}
                    {filtered.length > 0 && (
                      <CommandGroup>
                        {filtered.map((entry) => (
                          <CommandItem
                            key={entry.id}
                            value={entry.id}
                            onSelect={() => {
                              setSelectedPricingId(
                                entry.id === selectedPricingId ? '' : entry.id
                              )
                            }}
                            className='overflow-hidden'
                          >
                            <Check
                              className={cn(
                                'mr-2 h-4 w-4 shrink-0',
                                selectedPricingId === entry.id
                                  ? 'opacity-100'
                                  : 'opacity-0'
                              )}
                            />
                            <span className='truncate text-sm'>
                              {entry.displayName}
                            </span>
                            <span className='ml-auto shrink-0 pl-2 text-xs text-muted-foreground'>
                              {formatPrice(entry.inputCost)}
                              {!entry.isApi &&
                                ` / ${formatPrice(entry.outputCost)}`}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              )}
            </div>

            <DialogFooter>
              <Button
                variant='outline'
                onClick={handleClose}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!selectedPricingId || isSubmitting}
              >
                {isSubmitting ? 'Mapping...' : 'Map & backfill'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Green is earned only by events actually getting priced. The
// outcome states compose with, rather than replace, the hasFailures amber
// path that covers thrown per-group errors in batch runs.
function MapSuccessView({
  result,
  onDone,
  onViewEvents,
  formatCostUsd,
}: {
  result: MapSuccessResult
  onDone: () => void
  onViewEvents: () => void
  formatCostUsd: (n: number) => string
}) {
  const isBatch = result.sourceGroups.length > 1
  const hasFailures = result.groupsFailedCount > 0
  const outcome: BackfillOutcome = classifyBackfillOutcome({
    backfilled: result.totalBackfilled,
    totalCostUsd: result.totalCostUsd,
    targetHasPaidRates: result.targetHasPaidRates,
    refused: result.totalRefused,
  })
  const isWarning = outcome !== 'success' || hasFailures
  const summarySource = isBatch
    ? `${result.sourceGroups.length} models`
    : `${result.sourceGroups[0].model}`
  const summaryProvider =
    !isBatch && result.sourceGroups[0].provider
      ? result.sourceGroups[0].provider
      : null

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
                ? `Mapped ${result.groupsMappedCount} of ${result.sourceGroups.length}`
                : outcome === 'all_refused'
                  ? 'Mapping saved, nothing could be priced'
                  : outcome === 'partial_refused'
                    ? `Mapped, ${result.totalRefused.toLocaleString()} still unpriced`
                    : outcome === 'zero_match'
                      ? 'Mapping saved, no events matched'
                      : outcome === 'zero_cost'
                        ? 'Mapped, but nothing was priced'
                        : isBatch
                          ? `Mapped ${result.groupsMappedCount} models`
                          : 'Model mapped'}
            </DialogTitle>
            <DialogDescription>
              {outcome === 'all_refused'
                ? 'Your mapping is saved. None of these events could be priced, so none of them were billed.'
                : outcome === 'partial_refused'
                  ? 'Your mapping is saved. Some events were priced; the rest could not be, and were left alone.'
                  : outcome === 'zero_match'
                    ? 'Your mapping is saved, but it matched 0 events.'
                    : outcome === 'zero_cost'
                      ? 'Your mapping is saved, but every matched event priced to $0.00.'
                      : 'Your mapping is saved and all matching events are now priced.'}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className='flex-1 space-y-4 overflow-y-auto pr-1'>
        <div className='rounded-lg border bg-muted/30 px-4 py-3'>
          <p className='mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
            Mapping
          </p>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span className='font-mono font-medium'>{summarySource}</span>
            {summaryProvider && (
              <span className='text-xs text-muted-foreground'>
                · {summaryProvider}
              </span>
            )}
            <ArrowRight className='h-4 w-4 shrink-0 text-muted-foreground' />
            <span className='font-medium'>{result.target.displayName}</span>
            <span className='text-xs text-muted-foreground'>
              · {result.target.provider}
            </span>
          </div>
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
              {result.target.displayName} has no price for prompt caching, and
              these events spend money{' '}
              {describeMissingCacheRates(result.refusedRates)}. Charging $0.00
              for that would bill less than was actually spent, so they were
              left alone and stay on this list. Run the pricing sync to fill the
              rate in, or map them to a model that prices caching.
            </p>
          </div>
        )}

        {outcome === 'zero_match' && (
          <div className='rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm'>
            <p className='font-medium text-amber-900 dark:text-amber-400'>
              0 events matched this mapping
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              Check the model name, or the events may already be priced. Nothing
              was repriced by this run.
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
              Check that these events carry token counts and that{' '}
              {result.target.displayName} is the rate you meant.
            </p>
          </div>
        )}

        {/* Gated to real successes: under zero_match, "no more manual
            mapping needed" would bless a mapping that may point at a name
            nothing uses. */}
        {outcome === 'success' && !hasFailures && (
          <div className='flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm'>
            <Sparkles className='mt-0.5 h-4 w-4 shrink-0 text-primary' />
            <div>
              <p className='font-medium'>Future events auto-map</p>
              <p className='mt-0.5 text-muted-foreground'>
                Any new event with this model + provider will be priced against{' '}
                <span className='font-medium text-foreground'>
                  {result.target.displayName}
                </span>{' '}
                from here on. No more manual mapping needed.
              </p>
            </div>
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
