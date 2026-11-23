// @ts-nocheck
'use client'

import { useState, useEffect } from 'react'
import { IconUsers } from '@tabler/icons-react'
import { simulateRevenue } from '@/app/actions/invoice-calculator'
import { useAgent } from '@/services/agent-service'
import { useAgentPricingPlans } from '@/services/pricing-plans-service'
import { useSignals } from '@/services/signal-service'
import { Loader2, Pin, X } from 'lucide-react'
import { useParams } from 'next/navigation'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'
import { useOrgCurrency } from '@/hooks/use-org-currency'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Separator } from '@/components/ui/separator'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// @ts-nocheck

// Event type definitions
interface ProjectedEvent {
  name: string
  humanName: string
  value: number
  max: number
}

// API response interfaces
interface PricingPlan {
  id: string
  name: string
  description: string
}

interface SimulationPayload {
  pricingPlanId: string
  projectedEvents: Record<string, number>
  billingCycle: string
  seatsCount?: number
}

interface PricingTier {
  lower: number
  upper: number | null
  rate: number
  quantity?: number
  subtotal?: number
}

interface ChargeDetail {
  description: string
  quantity: number
  unitPrice: number
  effectiveUnitPrice: number
  amount: number
  pricingStrategyId: string
  pricingStrategyName: string
  chargeType: string
  pricingModel: string | null
  minimumCommitment: number | null
  tiersUsed: PricingTier[]
}

interface ChargeGroup {
  lineItems: ChargeDetail[]
  subtotal: number
  total: number
}

interface StrategyCharge {
  quantity: number
  unitPrice: number
  effectiveUnitPrice: number
  amount: number
  tiersUsed: PricingTier[]
}

interface StrategyBreakdownItem {
  id: string
  name: string
  chargeType: string
  pricingModel: string | null
  rate: number | null
  billingFrequency: string | null
  minimumCommitment: number | null
  tiers: PricingTier[] | null
  charge: StrategyCharge
}

interface StrategyBreakdown {
  recurring: StrategyBreakdownItem[]
  usage: StrategyBreakdownItem[]
  onetime: StrategyBreakdownItem[]
  seatBased: StrategyBreakdownItem[]
}

interface SimulationSummary {
  setupCosts: number
  recurringCosts: number
  usageBasedCosts: number
  seatBasedCosts: number
  totalUsageCost: number
  firstInvoiceTotal: number
  typicalInvoiceTotal: number
  yearlyTotal: number
}

interface SimulationResponse {
  pricingPlan: PricingPlan
  agent: {
    id: string
    name: string
    agentCode: string
  }
  billingCycle: string
  seatsCount: number
  projectedUsage: Record<string, number>
  initialCharges: ChargeGroup
  recurringCharges: ChargeGroup
  strategyBreakdown: StrategyBreakdown
  annualProjection: number
  simulationSummary: SimulationSummary
}

export default function RevenueSimulator() {
  const params = useParams()
  const agentId = params.agentId as string
  const { toast } = useToast()
  const { orgCurrency, currencySymbol: _currencySymbol } = useOrgCurrency()

  // React Query hooks - data is cached, instant loading on tab switch
  const { data: agent } = useAgent(agentId)
  const { data: plansData, isLoading: plansLoading } =
    useAgentPricingPlans(agentId)
  const { data: signalsData, isLoading: signalsLoading } = useSignals({
    agentId,
  })

  const pricingPlans = plansData?.results || []
  const isLoading = plansLoading || signalsLoading

  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [isSimulating, setIsSimulating] = useState(false)
  const [simulationResults, setSimulationResults] =
    useState<SimulationResponse | null>(null)
  const [seats, setSeats] = useState(5) // Default to 5 seats
  const [_selectedPlan, setSelectedPlan] = useState<PricingPlan | null>(null)
  const [hasSeatBasedPricing, setHasSeatBasedPricing] = useState(false)

  // Initialize with empty events array instead of hardcoded events
  const [projectedEvents, setProjectedEvents] = useState<ProjectedEvent[]>([])

  // ── Pin & Compare ──
  // Holds snapshots of simulation results so you can compare pricing plans side by side
  const [pinnedResults, setPinnedResults] = useState<SimulationResponse[]>([])

  // Set default selected plan when data loads
  useEffect(() => {
    if (pricingPlans.length > 0 && !selectedPlanId) {
      setSelectedPlanId(pricingPlans[0].id)
    }
  }, [pricingPlans, selectedPlanId])

  // Convert signals to projected events when data loads.
  //
  // signal.type is the internal UI classification ('ACTIVITY' | 'OUTCOME'),
  // normalized from the DB enum by convertApiSignalToUiSignal. Outcome-Based
  // metrics get a lower default slider ceiling (1000) than Usage-Based (2000)
  // because result-counts are typically smaller than attempt-counts.
  useEffect(() => {
    if (signalsData?.results && signalsData.results.length > 0) {
      const events = signalsData.results.map((signal) => ({
        name: signal.shortName,
        humanName: signal.name,
        value: 0,
        max: signal.type === 'OUTCOME' ? 1000 : 2000,
      }))
      setProjectedEvents(events)
    } else if (
      !signalsLoading &&
      (!signalsData?.results || signalsData.results.length === 0)
    ) {
      // Fallback to default signals if none are defined
      setProjectedEvents([
        {
          name: 'document_summarized',
          humanName: 'Document Summarized',
          value: 500,
          max: 1000,
        },
        {
          name: 'ticket_resolved',
          humanName: 'Ticket Resolved',
          value: 200,
          max: 500,
        },
        {
          name: 'meeting_scheduled',
          humanName: 'Meeting Scheduled',
          value: 200,
          max: 500,
        },
        {
          name: 'report_generated',
          humanName: 'Report Generated',
          value: 100,
          max: 300,
        },
        {
          name: 'record_verified',
          humanName: 'Record Verified',
          value: 20,
          max: 100,
        },
      ])
    }
  }, [signalsData, signalsLoading])

  const handleEventChange = (name: string, value: number) => {
    setProjectedEvents((prev) =>
      prev.map((event) => (event.name === name ? { ...event, value } : event))
    )
  }

  const handleSliderChange = (name: string, value: number[]) => {
    handleEventChange(name, value[0])
  }

  const handleInputChange = (name: string, value: string) => {
    // Parse the numeric value, removing any leading zeros
    const numValue = value === '' ? 0 : parseInt(value, 10)
    if (isNaN(numValue)) return
    const event = projectedEvents.find((e) => e.name === name)
    if (event) {
      const boundedValue = Math.min(Math.max(0, numValue), event.max)
      handleEventChange(name, boundedValue)
    }
  }

  // Update the selected plan and check for seat-based pricing
  useEffect(() => {
    if (selectedPlanId && pricingPlans.length > 0) {
      const plan = pricingPlans.find((plan) => plan.id === selectedPlanId)
      setSelectedPlan(plan || null)

      // Check if plan has seat-based pricing
      if (plan) {
        const hasSeatPricing = plan.pricingStrategies?.some(
          (strategy) =>
            strategy.chargeType === 'seat_based' ||
            strategy.name === 'seat_based_fee'
        )
        setHasSeatBasedPricing(hasSeatPricing || false)
      } else {
        setHasSeatBasedPricing(false)
      }
    }
  }, [selectedPlanId, pricingPlans])

  // Build the event/seat payload that both simulation functions share
  const buildPayload = (planId: string): SimulationPayload => {
    const eventData: Record<string, number> = {}
    projectedEvents.forEach((event) => {
      eventData[event.name] = event.value
    })
    return {
      pricingPlanId: planId,
      projectedEvents: eventData,
      billingCycle: 'monthly',
      // Always include seats — the backend ignores it for plans without seat
      // pricing, and 0 is exactly the case where the minimum-commitment
      // clamp answer matters.
      seatsCount: seats,
    }
  }

  // Run simulation for a single plan
  const runSimulation = async () => {
    if (!selectedPlanId) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select a pricing plan',
      })
      return
    }

    try {
      setIsSimulating(true)

      const result = await simulateRevenue(buildPayload(selectedPlanId))
      if (!result.success) throw new Error(result.error || 'Simulation failed')

      if (!result.data?.simulationSummary) {
        throw new Error(
          result.data?.message || 'Simulation returned incomplete data'
        )
      }

      setSimulationResults(result.data)

      toast({
        title: 'Success',
        description: 'Revenue simulation completed',
      })
    } catch (error) {
      console.error('Error simulating revenue:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to simulate revenue',
      })
    } finally {
      setIsSimulating(false)
    }
  }

  // Run simulation for ALL plans at once, using the same slider/seat values
  // This is the main way users discover comparison — one button, full picture
  const compareAllPlans = async () => {
    if (pricingPlans.length === 0) return

    try {
      setIsSimulating(true)

      // Fire all simulations in parallel — same inputs, different plans
      const results = await Promise.all(
        pricingPlans.map((plan) => simulateRevenue(buildPayload(plan.id)))
      )

      // Keep only the ones that came back successfully
      const successfulResults = results
        .filter((r) => r.success && r.data?.simulationSummary)
        .map((r) => r.data as SimulationResponse)

      if (successfulResults.length === 0) {
        throw new Error('No plans simulated successfully')
      }

      // Store all results for the comparison grid
      setPinnedResults(successfulResults)
      // Show the first plan's full details by default
      setSimulationResults(successfulResults[0])

      toast({
        title: 'Comparison ready',
        description: `Compared ${successfulResults.length} pricing plan${successfulResults.length > 1 ? 's' : ''}`,
      })
    } catch (error) {
      console.error('Error comparing plans:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to compare plans',
      })
    } finally {
      setIsSimulating(false)
    }
  }

  // ── Pin & Compare helpers ──

  // Is the current live result already in the pinned list?
  const isCurrentResultPinned = simulationResults
    ? pinnedResults.some(
        (r) => r.pricingPlan.id === simulationResults.pricingPlan.id
      )
    : false

  // Save the current result so it stays visible when you switch plans
  const pinCurrentResult = () => {
    if (!simulationResults) return
    if (isCurrentResultPinned) return
    if (pinnedResults.length >= 4) {
      toast({
        variant: 'destructive',
        title: 'Limit reached',
        description: 'Unpin a plan before pinning another (max 4)',
      })
      return
    }
    setPinnedResults((prev) => [...prev, simulationResults])
  }

  // Remove a pinned result by its plan ID
  const unpinResult = (planId: string) => {
    setPinnedResults((prev) => prev.filter((r) => r.pricingPlan.id !== planId))
  }

  // Wipe all pinned results
  const clearAllPinned = () => {
    setPinnedResults([])
  }

  // Everything we want to show in the comparison grid:
  // pinned snapshots + the live result (if it isn't already pinned)
  const allComparisonResults = [
    ...pinnedResults,
    ...(simulationResults && !isCurrentResultPinned ? [simulationResults] : []),
  ]

  // Find the best (highest) value for each metric so we can highlight winners
  const bestValues =
    allComparisonResults.length > 1
      ? {
          firstInvoice: Math.max(
            ...allComparisonResults.map(
              (r) => r.simulationSummary.firstInvoiceTotal
            )
          ),
          monthly: Math.max(
            ...allComparisonResults.map(
              (r) => r.simulationSummary.typicalInvoiceTotal
            )
          ),
          yearly: Math.max(
            ...allComparisonResults.map((r) => r.simulationSummary.yearlyTotal)
          ),
        }
      : null // Don't highlight anything when there's only one result

  // Format currency for display
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: orgCurrency,
      minimumFractionDigits: 2,
    }).format(amount)
  }

  // Prepare data for charts
  const preparePieChartData = () => {
    if (!simulationResults) return []

    return [
      {
        name: 'Setup Fees',
        value: simulationResults.simulationSummary.setupCosts,
      },
      {
        name: 'Recurring Fees',
        value: simulationResults.simulationSummary.recurringCosts,
      },
      {
        name: 'Usage-Based Charges',
        value: simulationResults.simulationSummary.usageBasedCosts,
      },
      {
        name: 'Seat-Based Charges',
        value: simulationResults.simulationSummary.seatBasedCosts,
      },
    ].filter((item) => item.value > 0)
  }

  const prepareBarChartData = () => {
    if (!simulationResults) return []

    return projectedEvents.map((event) => {
      const item = simulationResults.initialCharges.lineItems.find(
        (item) => item.pricingStrategyName === event.name
      )
      return {
        name: event.humanName,
        value: item ? item.amount : 0,
      }
    })
  }

  const COLORS = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))',
  ]

  if (isLoading) {
    return (
      <div className='space-y-6'>
        <Card>
          <CardHeader>
            <Skeleton className='h-6 w-48' />
            <Skeleton className='mt-2 h-4 w-72' />
          </CardHeader>
          <CardContent className='space-y-6'>
            {/* Pricing Plan Skeleton */}
            <div className='space-y-2'>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-10 w-full' />
            </div>
            {/* Projected Events Skeleton */}
            <div className='space-y-4'>
              <Skeleton className='h-6 w-40' />
              <div className='grid gap-6 md:grid-cols-2'>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className='space-y-2'>
                    <div className='flex justify-between'>
                      <Skeleton className='h-4 w-32' />
                      <Skeleton className='h-4 w-20' />
                    </div>
                    <Skeleton className='h-5 w-full' />
                  </div>
                ))}
              </div>
            </div>
            {/* Button Skeleton */}
            <div className='flex justify-end'>
              <Skeleton className='h-10 w-32' />
            </div>
          </CardContent>
        </Card>
        {/* Results Skeleton */}
        <Card>
          <CardContent className='flex h-40 items-center justify-center'>
            <Skeleton className='h-4 w-48' />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className='overflow-y-auto pb-6'>
      <div className='space-y-6'>
        {/* Inputs Panel */}
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-1.5'>
              Revenue Simulator
              <InfoTooltip {...tooltipDefinitions.revenueSimulator} />
            </CardTitle>
            <CardDescription>
              Simulate revenue based on event projections for {agent?.name}
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-6'>
            <div>
              <Label htmlFor='pricing-plan'>Pricing Plan</Label>
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger id='pricing-plan' className='w-full'>
                  <SelectValue placeholder='Select a pricing plan' />
                </SelectTrigger>
                <SelectContent>
                  {pricingPlans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Show which plans you've pinned for comparison */}
              {pinnedResults.length > 0 && (
                <div className='mt-2 flex flex-wrap gap-2'>
                  {pinnedResults.map((r) => (
                    <Badge
                      key={r.pricingPlan.id}
                      variant='secondary'
                      className='gap-1'
                    >
                      <Pin className='h-3 w-3' />
                      {r.pricingPlan.name}
                      <button
                        onClick={() => unpinResult(r.pricingPlan.id)}
                        className='ml-1 hover:text-destructive'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Seats input for seat-based pricing */}
            {hasSeatBasedPricing && (
              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <Label htmlFor='seats' className='flex items-center'>
                    <IconUsers size={18} className='mr-2' />
                    Number of Seats
                  </Label>
                  <span className='text-sm text-muted-foreground'>
                    {seats} seats
                  </span>
                </div>
                <div className='flex items-center gap-4'>
                  <div className='flex-1'>
                    <Slider
                      id='seats'
                      max={100}
                      min={1}
                      step={1}
                      value={[seats]}
                      onValueChange={(value) => setSeats(value[0])}
                    />
                  </div>
                  <div className='w-20'>
                    <Input
                      type='text'
                      inputMode='numeric'
                      pattern='[0-9]*'
                      placeholder='1'
                      value={seats.toString()}
                      onChange={(e) => {
                        const val =
                          e.target.value === ''
                            ? 1
                            : parseInt(e.target.value, 10)
                        if (!isNaN(val)) {
                          setSeats(Math.min(100, Math.max(1, val)))
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className='space-y-6'>
              <h3 className='flex items-center gap-1.5 text-lg font-semibold'>
                Projected Events
                <InfoTooltip {...tooltipDefinitions.projectedEvents} />
              </h3>
              <div className='grid gap-6 md:grid-cols-2'>
                {projectedEvents.map((event) => (
                  <div key={event.name} className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label htmlFor={event.name}>{event.humanName}</Label>
                      <span className='text-sm text-muted-foreground'>
                        {event.value} events
                      </span>
                    </div>
                    <div className='flex items-center gap-4'>
                      <div className='flex-1'>
                        <Slider
                          id={event.name}
                          max={event.max}
                          step={1}
                          value={[event.value]}
                          onValueChange={(value) =>
                            handleSliderChange(event.name, value)
                          }
                        />
                      </div>
                      <div className='w-20'>
                        <Input
                          type='text'
                          inputMode='numeric'
                          pattern='[0-9]*'
                          placeholder='0'
                          value={
                            event.value === 0 ? '' : event.value.toString()
                          }
                          onChange={(e) =>
                            handleInputChange(event.name, e.target.value)
                          }
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className='flex justify-end gap-3'>
              <Button
                variant='outline'
                onClick={runSimulation}
                disabled={isSimulating || !selectedPlanId}
              >
                {isSimulating ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    Simulating...
                  </>
                ) : (
                  'Run Simulation'
                )}
              </Button>
              {/* Compare All Plans — the primary way to start a comparison */}
              {/* Only shows when there are 2+ plans to compare */}
              {pricingPlans.length > 1 && (
                <Button onClick={compareAllPlans} disabled={isSimulating}>
                  {isSimulating ? (
                    <>
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                      Comparing...
                    </>
                  ) : (
                    `Compare All ${pricingPlans.length} Plans`
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Plan Comparison Card ── */}
        {/* Shows pinned results side-by-side so you can see which plan wins */}
        {pinnedResults.length > 0 && (
          <Card>
            <CardHeader>
              <div className='flex items-center justify-between'>
                <CardTitle className='text-base'>Plan Comparison</CardTitle>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={clearAllPinned}
                  className='text-muted-foreground'
                >
                  Clear All
                </Button>
              </div>
              <CardDescription>
                Comparing {pinnedResults.length} pinned plan
                {pinnedResults.length > 1 ? 's' : ''}
                {simulationResults && !isCurrentResultPinned
                  ? ' with current results'
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className={`grid grid-cols-1 gap-4 ${
                  allComparisonResults.length === 2
                    ? 'md:grid-cols-2'
                    : allComparisonResults.length === 3
                      ? 'md:grid-cols-3'
                      : allComparisonResults.length >= 4
                        ? 'md:grid-cols-4'
                        : ''
                }`}
              >
                {allComparisonResults.map((result) => {
                  const isPinned = pinnedResults.some(
                    (r) => r.pricingPlan.id === result.pricingPlan.id
                  )
                  const isCurrent =
                    simulationResults?.pricingPlan.id === result.pricingPlan.id

                  // Helper to render a single metric row, highlighted green if it's the best
                  const MetricRow = ({
                    label,
                    value,
                    bestValue,
                  }: {
                    label: string
                    value: number
                    bestValue: number | null
                  }) => {
                    const isBest = bestValue !== null && value === bestValue
                    return (
                      <div
                        className={`flex justify-between rounded px-2 py-1 ${
                          isBest ? 'bg-green-50 dark:bg-green-950' : ''
                        }`}
                      >
                        <span className='text-muted-foreground'>{label}</span>
                        <span
                          className={
                            isBest
                              ? 'font-semibold text-green-700 dark:text-green-400'
                              : ''
                          }
                        >
                          {formatCurrency(value)}
                        </span>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={result.pricingPlan.id}
                      className={`space-y-3 rounded-lg border p-4 ${
                        isCurrent && !isPinned
                          ? 'border-primary/30 bg-primary/5'
                          : ''
                      }`}
                    >
                      {/* Plan name + unpin button */}
                      <div className='flex items-center justify-between'>
                        <div className='flex items-center gap-2'>
                          <span className='text-sm font-semibold'>
                            {result.pricingPlan.name}
                          </span>
                          {isCurrent && !isPinned && (
                            <Badge variant='secondary' className='text-xs'>
                              Current
                            </Badge>
                          )}
                        </div>
                        {isPinned && (
                          <button
                            onClick={() => unpinResult(result.pricingPlan.id)}
                            className='text-muted-foreground hover:text-destructive'
                          >
                            <X className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>

                      {/* Key metrics. Revenue-only: the simulator has
                          no cost input, so it shows no margin. */}
                      <div className='space-y-1 text-sm'>
                        <MetricRow
                          label='First Invoice'
                          value={result.simulationSummary.firstInvoiceTotal}
                          bestValue={bestValues?.firstInvoice ?? null}
                        />
                        <MetricRow
                          label='Monthly'
                          value={result.simulationSummary.typicalInvoiceTotal}
                          bestValue={bestValues?.monthly ?? null}
                        />
                        <MetricRow
                          label='Annual Total'
                          value={result.simulationSummary.yearlyTotal}
                          bestValue={bestValues?.yearly ?? null}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Panel */}
        {simulationResults ? (
          <div className='space-y-6'>
            {/* ── Plan Detail Tabs ── */}
            {/* When comparing multiple plans, these tabs let you flip between  */}
            {/* each plan's full detailed breakdown (charts, tables, tiers)     */}
            {allComparisonResults.length > 1 && (
              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-sm font-medium text-muted-foreground'>
                  Viewing details for:
                </span>
                {allComparisonResults.map((result) => (
                  <Button
                    key={result.pricingPlan.id}
                    variant={
                      simulationResults.pricingPlan.id === result.pricingPlan.id
                        ? 'default'
                        : 'outline'
                    }
                    size='sm'
                    onClick={() => setSimulationResults(result)}
                  >
                    {result.pricingPlan.name}
                  </Button>
                ))}
              </div>
            )}

            <Card>
              <CardHeader>
                <div className='flex items-center justify-between'>
                  <div>
                    <CardTitle>Simulation Results</CardTitle>
                    {/* Show which plan you're looking at when in comparison mode */}
                    {allComparisonResults.length > 1 && (
                      <p className='mt-1 text-sm font-medium text-primary'>
                        {simulationResults.pricingPlan.name}
                      </p>
                    )}
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={pinCurrentResult}
                    disabled={
                      isCurrentResultPinned || pinnedResults.length >= 4
                    }
                  >
                    <Pin className='mr-1.5 h-4 w-4' />
                    {isCurrentResultPinned ? 'Pinned' : 'Pin This Result'}
                  </Button>
                </div>
                <CardDescription>
                  Projected revenue based on your usage inputs
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* Summary Cards. Revenue-only: the simulator has no
                    cost input, so it shows no margin. */}
                <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
                  <div className='rounded-lg border p-3'>
                    <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                      First Invoice
                      <InfoTooltip {...tooltipDefinitions.firstInvoice} />
                    </p>
                    <p className='mt-1 text-xl font-bold'>
                      {formatCurrency(
                        simulationResults.simulationSummary.firstInvoiceTotal
                      )}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      One-time charges + first month&apos;s fees
                    </p>
                  </div>
                  <div className='rounded-lg border p-3'>
                    <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                      Recurring Monthly
                      <InfoTooltip {...tooltipDefinitions.recurringMonthly} />
                    </p>
                    <p className='mt-1 text-xl font-bold'>
                      {formatCurrency(
                        simulationResults.simulationSummary.typicalInvoiceTotal
                      )}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      Monthly charges after first invoice
                    </p>
                  </div>
                  <div className='rounded-lg border p-3'>
                    <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                      Annual Total
                      <InfoTooltip {...tooltipDefinitions.annualTotal} />
                    </p>
                    <p className='mt-1 text-xl font-bold'>
                      {formatCurrency(
                        simulationResults.simulationSummary.yearlyTotal
                      )}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      One-time fees + 12 months of recurring charges
                    </p>
                  </div>
                </div>

                {/* Cost Breakdown Summary */}
                {(simulationResults.simulationSummary.setupCosts > 0 ||
                  simulationResults.simulationSummary.recurringCosts > 0 ||
                  simulationResults.simulationSummary.usageBasedCosts > 0 ||
                  simulationResults.simulationSummary.seatBasedCosts > 0) && (
                  <div className='mt-6 rounded-lg border p-4'>
                    <h3 className='mb-3 text-sm font-medium'>
                      Revenue Breakdown
                    </h3>
                    <div className='grid gap-2'>
                      {simulationResults.simulationSummary.setupCosts > 0 && (
                        <div className='flex justify-between'>
                          <span className='text-sm text-muted-foreground'>
                            One-time Setup Fees:
                          </span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary.setupCosts
                            )}
                          </span>
                        </div>
                      )}
                      {simulationResults.simulationSummary.recurringCosts >
                        0 && (
                        <div className='flex justify-between'>
                          <span className='text-sm text-muted-foreground'>
                            Monthly Fixed Fees:
                          </span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary.recurringCosts
                            )}
                          </span>
                        </div>
                      )}
                      {simulationResults.simulationSummary.seatBasedCosts >
                        0 && (
                        <div className='flex justify-between'>
                          <span className='text-sm text-muted-foreground'>
                            <div className='flex items-center'>
                              <IconUsers size={15} className='mr-1.5' />
                              Seat-Based Charges ({
                                simulationResults.seatsCount
                              }{' '}
                              seats):
                            </div>
                          </span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary.seatBasedCosts
                            )}
                          </span>
                        </div>
                      )}
                      {simulationResults.simulationSummary.usageBasedCosts >
                        0 && (
                        <div className='flex justify-between'>
                          <span className='text-sm text-muted-foreground'>
                            Usage-Based Charges:
                          </span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary
                                .usageBasedCosts
                            )}
                          </span>
                        </div>
                      )}
                      <div className='mt-2 border-t pt-2'>
                        <div className='flex justify-between font-medium'>
                          <span>First Invoice Total:</span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary
                                .firstInvoiceTotal
                            )}
                          </span>
                        </div>
                        <div className='flex justify-between'>
                          <span>Subsequent Monthly Total:</span>
                          <span>
                            {formatCurrency(
                              simulationResults.simulationSummary
                                .typicalInvoiceTotal
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Charts */}
            <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-1.5'>
                    Revenue Distribution
                    <InfoTooltip {...tooltipDefinitions.revenueDistribution} />
                  </CardTitle>
                </CardHeader>
                <CardContent className='h-[300px]'>
                  <ResponsiveContainer width='100%' height='100%'>
                    <PieChart>
                      <Pie
                        data={preparePieChartData()}
                        dataKey='value'
                        nameKey='name'
                        cx='50%'
                        cy='50%'
                        outerRadius={100}
                        fill='#8884d8'
                        label={({ name, percent }) =>
                          `${name}: ${(percent * 100).toFixed(0)}%`
                        }
                      >
                        {preparePieChartData().map((_entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={COLORS[index % COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => formatCurrency(value as number)}
                      />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-1.5'>
                    Revenue by Event
                    <InfoTooltip {...tooltipDefinitions.revenueByEvent} />
                  </CardTitle>
                </CardHeader>
                <CardContent className='h-[300px]'>
                  <ResponsiveContainer width='100%' height='100%'>
                    <BarChart data={prepareBarChartData()}>
                      <XAxis dataKey='name' />
                      <YAxis tickFormatter={(value) => formatCurrency(value)} />
                      <Tooltip
                        formatter={(value) => formatCurrency(value as number)}
                      />
                      <Bar
                        dataKey='value'
                        fill='var(--chart-1)'
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* Cost Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-1.5'>
                  Charge Breakdown
                  <InfoTooltip {...tooltipDefinitions.chargeBreakdown} />
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-6'>
                <div className='space-y-4'>
                  <h4 className='text-sm font-medium'>One-time Charges</h4>
                  <div className='overflow-auto'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Description</TableHead>
                          <TableHead>Quantity</TableHead>
                          <TableHead>Unit Price</TableHead>
                          <TableHead>Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {simulationResults.initialCharges.lineItems
                          .filter(
                            (item) =>
                              item.chargeType === 'onetime' ||
                              item.chargeType === 'one-time'
                          )
                          .map((item, index) => (
                            <TableRow key={index}>
                              <TableCell>
                                {item.description}
                                <Badge variant='outline' className='ml-2'>
                                  {item.chargeType}
                                </Badge>
                              </TableCell>
                              <TableCell>{item.quantity}</TableCell>
                              <TableCell>
                                {formatCurrency(item.effectiveUnitPrice)}
                              </TableCell>
                              <TableCell>
                                {formatCurrency(item.amount)}
                              </TableCell>
                            </TableRow>
                          ))}
                        {simulationResults.initialCharges.lineItems.filter(
                          (item) =>
                            item.chargeType === 'onetime' ||
                            item.chargeType === 'one-time'
                        ).length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={4}
                              className='text-center text-muted-foreground'
                            >
                              No one-time charges
                            </TableCell>
                          </TableRow>
                        )}
                        <TableRow className='font-bold'>
                          <TableCell>Total (One-time)</TableCell>
                          <TableCell></TableCell>
                          <TableCell></TableCell>
                          <TableCell>
                            {formatCurrency(
                              simulationResults.initialCharges.lineItems
                                .filter(
                                  (item) =>
                                    item.chargeType === 'onetime' ||
                                    item.chargeType === 'one-time'
                                )
                                .reduce((sum, item) => sum + item.amount, 0)
                            )}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>

                <Separator />

                <div className='space-y-4'>
                  <h4 className='text-sm font-medium'>
                    Monthly Recurring Charges
                  </h4>
                  <div className='overflow-auto'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Description</TableHead>
                          <TableHead>Quantity</TableHead>
                          <TableHead>Unit Price</TableHead>
                          <TableHead>Revenue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {simulationResults.recurringCharges.lineItems
                          .filter(
                            (item) =>
                              item.chargeType !== 'onetime' &&
                              item.chargeType !== 'one-time'
                          )
                          .map((item, index) => (
                            <TableRow key={index}>
                              <TableCell>
                                {item.description}
                                <Badge variant='outline' className='ml-2'>
                                  {item.chargeType}
                                </Badge>
                              </TableCell>
                              <TableCell>{item.quantity}</TableCell>
                              <TableCell>
                                {formatCurrency(item.effectiveUnitPrice)}
                              </TableCell>
                              <TableCell>
                                {formatCurrency(item.amount)}
                              </TableCell>
                            </TableRow>
                          ))}
                        <TableRow className='font-bold'>
                          <TableCell>Total (Monthly)</TableCell>
                          <TableCell></TableCell>
                          <TableCell></TableCell>
                          <TableCell>
                            {formatCurrency(
                              simulationResults.recurringCharges.total
                            )}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Tier Details */}
            <Card>
              <CardHeader>
                <CardTitle>Pricing Tier Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className='space-y-6'>
                  {/* Seat-based pricing section */}
                  {simulationResults.strategyBreakdown.seatBased &&
                    simulationResults.strategyBreakdown.seatBased.length >
                      0 && (
                      <>
                        <h3 className='text-lg font-medium'>
                          Seat-Based Pricing
                        </h3>
                        {simulationResults.strategyBreakdown.seatBased.map(
                          (strategy) => (
                            <div
                              key={strategy.id}
                              className='space-y-4 rounded-lg border p-4'
                            >
                              <div>
                                <h3 className='text-md flex items-center font-semibold'>
                                  <IconUsers size={18} className='mr-2' />
                                  {strategy.name} ({strategy.chargeType})
                                </h3>
                                <p className='text-sm text-muted-foreground'>
                                  Pricing Model:{' '}
                                  {strategy.pricingModel || 'N/A'}
                                  {strategy.billingFrequency && (
                                    <span className='ml-2'>
                                      •{' '}
                                      {strategy.billingFrequency === 'yearly'
                                        ? 'Yearly'
                                        : 'Monthly'}{' '}
                                      billing
                                    </span>
                                  )}
                                </p>
                              </div>
                              <div>
                                <p className='text-sm'>
                                  Seats: {strategy.charge.quantity}
                                </p>
                                <p className='text-sm'>
                                  Per Seat:{' '}
                                  {formatCurrency(strategy.charge.unitPrice)}
                                </p>
                                <p className='text-sm font-medium'>
                                  Total:{' '}
                                  {formatCurrency(strategy.charge.amount)}
                                </p>
                              </div>

                              {strategy.tiers && strategy.tiers.length > 0 && (
                                <div>
                                  <h4 className='text-sm font-semibold'>
                                    Pricing Tiers
                                  </h4>
                                  <div className='overflow-auto'>
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead>Range</TableHead>
                                          <TableHead>Rate per Seat</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {strategy.tiers.map((tier, index) => (
                                          <TableRow key={index}>
                                            <TableCell>
                                              {tier.lower} -{' '}
                                              {tier.upper === null
                                                ? 'unlimited'
                                                : tier.upper}
                                            </TableCell>
                                            <TableCell>
                                              {formatCurrency(tier.rate)}
                                            </TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </div>
                                </div>
                              )}

                              {strategy.charge.tiersUsed &&
                                strategy.charge.tiersUsed.length > 0 && (
                                  <div>
                                    <h4 className='text-sm font-semibold'>
                                      Tiers Used in Calculation
                                    </h4>
                                    <div className='overflow-auto'>
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead>Range</TableHead>
                                            <TableHead>Rate per Seat</TableHead>
                                            <TableHead>Seats</TableHead>
                                            <TableHead>Subtotal</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {strategy.charge.tiersUsed.map(
                                            (tier, index) => (
                                              <TableRow key={index}>
                                                <TableCell>
                                                  {tier.lower} -{' '}
                                                  {tier.upper === null
                                                    ? 'unlimited'
                                                    : tier.upper}
                                                </TableCell>
                                                <TableCell>
                                                  {formatCurrency(tier.rate)}
                                                </TableCell>
                                                <TableCell>
                                                  {tier.quantity}
                                                </TableCell>
                                                <TableCell>
                                                  {formatCurrency(
                                                    tier.subtotal || 0
                                                  )}
                                                </TableCell>
                                              </TableRow>
                                            )
                                          )}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  </div>
                                )}
                            </div>
                          )
                        )}
                        <Separator />
                      </>
                    )}

                  {/* Usage-based pricing section */}
                  {simulationResults.strategyBreakdown.usage &&
                    simulationResults.strategyBreakdown.usage.length > 0 && (
                      <>
                        <h3 className='text-lg font-medium'>
                          Usage-Based Pricing
                        </h3>
                        {simulationResults.strategyBreakdown.usage.map(
                          (strategy) => (
                            <div
                              key={strategy.id}
                              className='space-y-4 rounded-lg border p-4'
                            >
                              <div>
                                <h3 className='text-md font-semibold'>
                                  {strategy.name} ({strategy.chargeType})
                                </h3>
                                <p className='text-sm text-muted-foreground'>
                                  Pricing Model:{' '}
                                  {strategy.pricingModel || 'N/A'}
                                </p>
                              </div>
                              <div>
                                <p className='text-sm'>
                                  Quantity: {strategy.charge.quantity}
                                </p>
                                <p className='text-sm'>
                                  Total:{' '}
                                  {formatCurrency(strategy.charge.amount)}
                                </p>
                              </div>

                              {strategy.tiers && strategy.tiers.length > 0 && (
                                <div>
                                  <h4 className='text-sm font-semibold'>
                                    Pricing Tiers
                                  </h4>
                                  <div className='overflow-auto'>
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead>Range</TableHead>
                                          <TableHead>Rate</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {strategy.tiers.map((tier, index) => (
                                          <TableRow key={index}>
                                            <TableCell>
                                              {tier.lower} -{' '}
                                              {tier.upper === null
                                                ? 'unlimited'
                                                : tier.upper}
                                            </TableCell>
                                            <TableCell>
                                              {formatCurrency(tier.rate)}
                                            </TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </div>
                                </div>
                              )}

                              {strategy.charge.tiersUsed &&
                                strategy.charge.tiersUsed.length > 0 && (
                                  <div>
                                    <h4 className='text-sm font-semibold'>
                                      Tiers Used in Calculation
                                    </h4>
                                    <div className='overflow-auto'>
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead>Range</TableHead>
                                            <TableHead>Rate</TableHead>
                                            <TableHead>Quantity</TableHead>
                                            <TableHead>Subtotal</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {strategy.charge.tiersUsed.map(
                                            (tier, index) => (
                                              <TableRow key={index}>
                                                <TableCell>
                                                  {tier.lower} -{' '}
                                                  {tier.upper === null
                                                    ? 'unlimited'
                                                    : tier.upper}
                                                </TableCell>
                                                <TableCell>
                                                  {formatCurrency(tier.rate)}
                                                </TableCell>
                                                <TableCell>
                                                  {tier.quantity}
                                                </TableCell>
                                                <TableCell>
                                                  {formatCurrency(
                                                    tier.subtotal || 0
                                                  )}
                                                </TableCell>
                                              </TableRow>
                                            )
                                          )}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  </div>
                                )}
                            </div>
                          )
                        )}
                      </>
                    )}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className='flex h-40 flex-col items-center justify-center gap-2'>
              <p className='text-muted-foreground'>
                Run a simulation to see results
              </p>
              {pricingPlans.length > 1 && (
                <p className='text-sm text-muted-foreground'>
                  or use <span className='font-medium'>Compare All Plans</span>{' '}
                  to see which pricing model wins
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
