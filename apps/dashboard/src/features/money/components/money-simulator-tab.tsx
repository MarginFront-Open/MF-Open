'use client'

/**
 * Money → Simulator: a DRY-RUN pricing
 * projector. "If this customer's usage ran on this plan, what would it earn,
 * and at what margin?" — with numbers that update in REAL TIME as you type
 * (no Run button) and NEVER write an event or invoice.
 *
 * The projection math is canon and lives server-side: every dollar comes from
 * `projectPricing` (→ calcRouted + the @marginfront/db tier engine). This file only
 * gathers inputs and renders the answer. It is entirely separate from the SDK
 * Simulator (/developer-zone/sdk-simulator), which fires REAL billed events.
 *
 * Two modes: a single plan, and plan-vs-plan. There is no agent-vs-agent
 * mode and no builder for an unsaved plan, though the engine accepts a
 * hypothetical plan.
 */

import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { getFilters, type CustomerBasic } from '@/app/actions/get-filters'
import { getPricingPlans, type PricingPlan } from '@/app/actions/pricing-plans'
import { getEventAnalytics } from '@/app/actions/signal-events'
import { projectPricing } from '@/app/actions/simulate-pricing'
import {
  parseWindowFilter,
  type WindowFilter,
} from '@/app/actions/_shared/parse-window-filter'
import {
  eventsBySignalFromText,
  plansHaveSeatStrategy,
  toProjectionPlanInput,
  usageSignalRows,
  type PlanProjection,
  type ProjectionPlanInput,
  type SimActivity,
} from '../simulator-derivation'
import { formatCurrency, formatCost, formatPct } from '@/lib/canon-format'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  TileFrame,
  type TileState,
} from '@/features/dashboard-shell/tiles/tile-frame'

type SimMode = 'single' | 'compare'
type InputSource = 'manual' | 'customer'

interface CustomerVolume {
  eventsBySignal: Record<string, number>
  actualCost: number
  eventTotal: number
}

const NONE = '__none__'

function chargeTypeLabel(chargeType: string): string {
  switch (chargeType) {
    case 'usage':
      return 'Usage'
    case 'recurring':
      return 'Recurring'
    case 'seat_based':
      return 'Per-seat'
    case 'onetime':
      return 'One-time'
    default:
      return chargeType
  }
}

export function MoneySimulatorTab({ period }: { period: WindowFilter }) {
  const [plans, setPlans] = useState<PricingPlan[] | null>(null)
  const [customers, setCustomers] = useState<CustomerBasic[]>([])
  const [loadState, setLoadState] = useState<TileState>('loading')

  const [mode, setMode] = useState<SimMode>('single')
  const [planAId, setPlanAId] = useState<string>('')
  const [planBId, setPlanBId] = useState<string>('')

  const [inputSource, setInputSource] = useState<InputSource>('manual')
  const [manualEvents, setManualEvents] = useState<Record<string, string>>({})
  const [seats, setSeats] = useState<number>(1)

  const [customerId, setCustomerId] = useState<string>('')
  const [customerVolume, setCustomerVolume] = useState<CustomerVolume | null>(
    null
  )
  const [volumeState, setVolumeState] = useState<TileState>('ready')

  const [projections, setProjections] = useState<PlanProjection[] | null>(null)
  const [computeError, setComputeError] = useState<string | null>(null)

  // One-time load: plans WITH strategies (drives the pickers + the projection)
  // and the customer list (for pulling actual volume). limit:100 so the pickers
  // aren't silently truncated at the default page size.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      getPricingPlans({ includeStrategies: true, limit: 100, page: 1 }),
      getFilters(),
    ]).then(([plansResult, filtersResult]) => {
      if (cancelled) return
      if (plansResult.success && plansResult.data) {
        setPlans(plansResult.data.results)
      } else {
        setPlans([])
      }
      if (filtersResult.success && filtersResult.data) {
        setCustomers(filtersResult.data.customers)
      }
      setLoadState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const plansById = useMemo(() => {
    const map = new Map<string, PricingPlan>()
    for (const plan of plans ?? []) map.set(plan.id, plan)
    return map
  }, [plans])

  const selectedPlans: ProjectionPlanInput[] = useMemo(() => {
    const result: ProjectionPlanInput[] = []
    const a = plansById.get(planAId)
    if (a) result.push(toProjectionPlanInput(a))
    if (mode === 'compare') {
      const b = plansById.get(planBId)
      if (b) result.push(toProjectionPlanInput(b))
    }
    return result
  }, [plansById, planAId, planBId, mode])

  const signalRows = useMemo(
    () => usageSignalRows(selectedPlans),
    [selectedPlans]
  )
  const showSeats = useMemo(
    () => plansHaveSeatStrategy(selectedPlans),
    [selectedPlans]
  )

  const activity: SimActivity = useMemo(() => {
    const eventsBySignal =
      inputSource === 'customer'
        ? (customerVolume?.eventsBySignal ?? {})
        : eventsBySignalFromText(manualEvents)
    return { eventsBySignal, seats: showSeats ? seats : 0 }
  }, [inputSource, customerVolume, manualEvents, seats, showSeats])

  const actualCost =
    inputSource === 'customer' ? (customerVolume?.actualCost ?? null) : null

  // `period` is a fresh object every render (the parent rebuilds it from the
  // URL), so we depend on its bare-string fields — not the object identity —
  // to keep this effect from refetching on every render.
  const periodStart = period.startDate
  const periodEnd = period.endDate

  // Pull a customer's ACTUAL volume for the page's current date range.
  // Bare-date bounds keep this window identical to the rest of the Money page
  // (parseWindowFilter is the same helper every breakdown call uses).
  useEffect(() => {
    if (inputSource !== 'customer' || !customerId) return
    let cancelled = false
    void (async () => {
      setVolumeState('loading')
      const { windowStart, windowEnd } = parseWindowFilter({
        startDate: periodStart,
        endDate: periodEnd,
      })
      const res = await getEventAnalytics({
        customerId,
        startDate: windowStart.toISOString().slice(0, 10),
        endDate: windowEnd.toISOString().slice(0, 10),
      })
      if (cancelled) return
      if (res.success && res.data) {
        const eventsBySignal: Record<string, number> = {}
        for (const dist of res.data.signalDistribution) {
          eventsBySignal[dist.signalId] = dist.totalQuantity
        }
        setCustomerVolume({
          eventsBySignal,
          actualCost: res.data.totalUsageCost,
          eventTotal: res.data.totalQuantity,
        })
        setVolumeState('ready')
      } else {
        setCustomerVolume(null)
        setVolumeState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [inputSource, customerId, periodStart, periodEnd])

  // REAL-TIME recompute: every input change re-projects through canon,
  // debounced so a fast typist fires one server round-trip, not ten. No button.
  // All state writes live inside the debounce callback so the recompute never
  // cascades synchronously off this effect.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(() => {
      if (selectedPlans.length === 0) {
        setProjections(null)
        setComputeError(null)
        return
      }
      projectPricing({ plans: selectedPlans, activity, actualCost }).then(
        (res) => {
          // A newer keystroke may have superseded this request; an out-of-order
          // resolve must not overwrite the current projection with a stale one.
          if (cancelled) return
          if (res.success && res.data) {
            setProjections(res.data)
            setComputeError(null)
          } else {
            setProjections(null)
            setComputeError(
              res.error ?? 'Could not compute the projection. Try again.'
            )
          }
        }
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [selectedPlans, activity, actualCost])

  const planOptions = plans ?? []

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Calculator className='h-4 w-4 text-mf-tx3' />
            Pricing simulator
          </CardTitle>
          <CardDescription>
            A dry run. Project what a level of activity would earn under a plan.
            Nothing is billed and no events are recorded.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid gap-4 md:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Mode</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as SimMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='single'>Single plan</SelectItem>
                  <SelectItem value='compare'>Compare two plans</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-2'>
              <Label>Volume source</Label>
              <Select
                value={inputSource}
                onValueChange={(value) => setInputSource(value as InputSource)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='manual'>Enter projected volume</SelectItem>
                  <SelectItem value='customer'>
                    Use a customer&apos;s actual volume
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-2'>
              <Label>{mode === 'compare' ? 'Plan A' : 'Plan'}</Label>
              <Select value={planAId} onValueChange={setPlanAId}>
                <SelectTrigger>
                  <SelectValue placeholder='Select a plan' />
                </SelectTrigger>
                <SelectContent>
                  {planOptions.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {mode === 'compare' && (
              <div className='space-y-2'>
                <Label>Plan B</Label>
                <Select value={planBId} onValueChange={setPlanBId}>
                  <SelectTrigger>
                    <SelectValue placeholder='Select a plan to compare' />
                  </SelectTrigger>
                  <SelectContent>
                    {planOptions.map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {inputSource === 'customer' && (
              <div className='space-y-2'>
                <Label>Customer</Label>
                <Select
                  value={customerId || NONE}
                  onValueChange={(value) =>
                    setCustomerId(value === NONE ? '' : value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder='Select a customer' />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {customerId && volumeState === 'loading' && (
                  <p className='text-xs text-mf-tx3'>Loading their volume…</p>
                )}
                {customerId &&
                  volumeState === 'ready' &&
                  customerVolume !== null && (
                    <p className='text-xs text-mf-tx3'>
                      {customerVolume.eventTotal.toLocaleString()} units of
                      usage across the current date range · cost{' '}
                      {formatCost(customerVolume.actualCost)}
                    </p>
                  )}
                {customerId && volumeState === 'error' && (
                  <p className='text-xs text-mf-red'>
                    Couldn&apos;t load this customer&apos;s volume. Pick another
                    customer or switch to entering volume by hand.
                  </p>
                )}
              </div>
            )}
          </div>

          {selectedPlans.length > 0 && signalRows.length > 0 && (
            <div className='space-y-2'>
              <Label>Projected volume by meter</Label>
              {inputSource === 'customer' ? (
                <div className='rounded-md border border-mf-bd p-3'>
                  {customerVolume === null ? (
                    <p className='text-sm text-mf-tx3'>
                      Pick a customer above to pull their real usage.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Meter</TableHead>
                          <TableHead className='text-right'>
                            Actual units
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {signalRows.map((row) => (
                          <TableRow key={row.signalId}>
                            <TableCell>{row.label}</TableCell>
                            <TableCell className='text-right'>
                              {(
                                customerVolume.eventsBySignal[row.signalId] ?? 0
                              ).toLocaleString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ) : (
                <div className='grid gap-3 sm:grid-cols-2'>
                  {signalRows.map((row) => (
                    <div key={row.signalId} className='space-y-1'>
                      <Label className='text-xs font-normal text-mf-tx3'>
                        {row.label}
                      </Label>
                      <Input
                        type='number'
                        min={0}
                        inputMode='numeric'
                        value={manualEvents[row.signalId] ?? ''}
                        placeholder='0'
                        onChange={(event) =>
                          setManualEvents((prev) => ({
                            ...prev,
                            [row.signalId]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {showSeats && (
            <div className='max-w-[200px] space-y-1'>
              <Label>Seats</Label>
              <Input
                type='number'
                min={1}
                value={seats}
                onChange={(event) =>
                  setSeats(Math.max(1, Number(event.target.value) || 1))
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      <div className='space-y-2'>
        <h2 className='text-sm font-semibold text-mf-tx'>Projection</h2>
        <TileFrame
          state={
            loadState === 'loading'
              ? 'loading'
              : selectedPlans.length === 0
                ? 'empty'
                : computeError
                  ? 'error'
                  : 'ready'
          }
          errorMessage={computeError ?? undefined}
          emptyMessage='Select a plan to see a projection.'
        >
          <div className='grid gap-4 md:grid-cols-2'>
            {(projections ?? []).map((projection) => (
              <ProjectionCard
                key={projection.planId ?? projection.planName}
                projection={projection}
              />
            ))}
          </div>
        </TileFrame>
      </div>
    </div>
  )
}

function ProjectionCard({ projection }: { projection: PlanProjection }) {
  return (
    <Card>
      <CardHeader className='pb-3'>
        <CardTitle className='text-sm font-medium'>
          {projection.planName}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='grid grid-cols-3 gap-2'>
          <Stat
            label='Projected revenue'
            value={formatCurrency(projection.revenueTotal)}
          />
          <Stat
            label='Actual cost'
            value={
              projection.actualCost === null
                ? '—'
                : formatCost(projection.actualCost)
            }
          />
          <Stat label='Margin' value={formatPct(projection.marginPct)} />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Charge</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className='text-right'>Quantity</TableHead>
              <TableHead className='text-right'>Projected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projection.lineItems.map((item) => (
              <TableRow key={item.strategyId}>
                <TableCell>{item.label}</TableCell>
                <TableCell>
                  <Badge variant='secondary'>
                    {chargeTypeLabel(item.chargeType)}
                  </Badge>
                </TableCell>
                <TableCell className='text-right'>
                  {item.billedQuantity !== undefined &&
                  item.billedQuantity !== item.quantity ? (
                    <>
                      {item.billedQuantity.toLocaleString()}
                      <span className='block text-xs text-mf-tx3'>
                        minimum commitment; {item.quantity.toLocaleString()}{' '}
                        entered
                      </span>
                    </>
                  ) : (
                    item.quantity.toLocaleString()
                  )}
                </TableCell>
                <TableCell className='text-right font-medium'>
                  {formatCurrency(item.projected)}
                </TableCell>
              </TableRow>
            ))}
            {projection.lineItems.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className='text-center text-mf-tx3'>
                  This plan has no active pricing strategies to project.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='text-[11px] uppercase tracking-wide text-mf-tx3'>
        {label}
      </div>
      <div className='text-lg font-semibold text-mf-tx'>{value}</div>
    </div>
  )
}
