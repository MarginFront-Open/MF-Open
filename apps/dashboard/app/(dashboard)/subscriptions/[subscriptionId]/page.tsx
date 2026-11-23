// @ts-nocheck
'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import {
  format,
  differenceInDays,
  addMonths,
  subMonths,
  getDate,
  isAfter,
  isBefore,
  subDays,
} from 'date-fns'
import { Loader2, RefreshCw, XCircle } from 'lucide-react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { SubscriptionAnalyticsResponse } from '@/lib/api/analytics'
import {
  getSubscriptionAnalytics as getSubscriptionAnalyticsAction,
  getCanonicalSubscriptionMetrics,
  type CanonicalSubscriptionMetricsResponse,
} from '@/app/actions/analytics'
import { cancelSubscription } from '@/app/actions/subscriptions'
import { getCreditBalancesAction } from '@/app/actions/credit-pools'
import type { CreditPoolBalanceView } from '@/features/money/credit-pool-types'
import { CreditPoolResolveDialog } from '@/features/money/components/credit-pool-resolve-dialog'
import type { CreditPoolPermission } from '@/features/money/credit-pool-types'
import {
  formatCurrency,
  formatPct,
  safeMarginPercent,
} from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { Page } from '@/components/layouts/page'
import { DetailPageSkeleton } from '@/components/ui/detail-page-skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { InvoicesTable } from '@/features/invoices/InvoicesTable'
import { CancelSubscriptionDialog } from '@/features/subscriptions/components/cancel-subscription-dialog'
import { SubscriptionHistorySection } from '@/features/subscriptions/components/subscription-history'
import { docsLink } from '@/config/operator'

const CREDIT_BALANCES_DOCS = docsLink('/api-reference/credit-balances')

// Brand colors for charts using CSS variables
const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
]

interface _SubscriptionDetails {
  subscription: {
    id: string
    name: string
    status: string
    billingCycle: string
    startDate: string
    endDate: string | null
    currentBillingPeriodStart: string
    currentBillingPeriodEnd: string
  }
  agent: {
    id: string
    name: string
    agentCode: string
  }
  customer: {
    id: string
    name: string
    externalId: string
  }
  plan: {
    id: string
    name: string
    signalDetails: Array<{
      id: string
      name: string
      shortName: string
      pricingModel: string
      chargeType: string
    }>
  }
  billingPeriod: {
    start: string
    end: string
  }
  summary: {
    totalRevenue: number
    totalCost: number
    totalMargin: number
    totalCustomerValue: number
  }
  pricingBreakdown: Array<{
    description: string
    quantity: number
    unitPrice: number
    effectiveUnitPrice: number
    amount: number
    usageCost: number
    pricingStrategyId: string
    pricingStrategyName: string
    chargeType: string
    pricingModel: string | null
    minimumCommitment: number | null
    tiersUsed: Array<{
      lower: number
      upper: number | null
      rate: number
      quantity: number
      subtotal: number
    }>
  }>
  signalSummary: Array<{
    signalId: string
    signalName: string
    totalQuantity: number
    totalCost: number
    totalRevenue: number
    totalMargin: number
    totalCustomerValue: number
    unitPrice: number
  }>
  dailyBreakdown: Array<{
    date: string
    signalId: string
    signalName: string
    quantity: number
    cost: number
    revenue: number
    margin: number
    price: number
    customerValue: number
  }>
}

export default function SubscriptionDetailComponent() {
  const params = useParams()
  const subscriptionId = params.subscriptionId as string
  const router = useRouter()

  const [subscriptionDetails, setSubscriptionDetails] =
    useState<SubscriptionAnalyticsResponse | null>(null)
  // Canonical metrics power the KPI tiles (revenue/cost/margin) per the
  // 4-label canon. The Metric-Level Breakdown table also reads canon
  // (events × pricing per signal, R1) plus a synthetic "Subscription fees"
  // row carrying R2 sub-level fees, so tile + rows share both the window
  // and the underlying canonical source. They reconcile by construction.
  const [canonicalMetrics, setCanonicalMetrics] =
    useState<CanonicalSubscriptionMetricsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // null when the plan sells no pool: the readout is not rendered at all.
  const [creditPool, setCreditPool] = useState<CreditPoolBalanceView | null>(
    null
  )
  const [creditPoolPermission, setCreditPoolPermission] =
    useState<CreditPoolPermission>({ canManage: false, whoCanChange: '' })
  const [creditPoolDialogOpen, setCreditPoolDialogOpen] = useState(false)
  const [billingPeriod, setBillingPeriod] = useState<string>('current')
  const [billingCycles, setBillingCycles] = useState<
    Array<{
      id: string
      label: string
      start: Date
      end: Date
      isCurrent: boolean
    }>
  >([])

  const [displayType, setDisplayType] = useState<
    'units' | 'cost' | 'revenue' | 'costVsRevenue' | 'unitType'
  >('units')
  const [selectedUnitType, setSelectedUnitType] = useState<string>('all')
  const [chartView, setChartView] = useState<'periodic' | 'cumulative'>(
    'periodic'
  )
  const [chartType, setChartType] = useState<'area' | 'bar'>('bar')

  // Cancel-subscription dialog state.
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [isCanceling, setIsCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  /**
   * Generate a list of billing cycles based on subscription start date.
   * Billing cycles follow the day-of-month pattern from the start date.
   * @param {Object} subscriptionDetails
   * @param {Object} subscriptionDetails.subscription
   * @returns {Array<{id:string,label:string,start:Date,end:Date,isCurrent:boolean}>}
   */
  const getBillingCycles = (
    subscriptionDetails: SubscriptionAnalyticsResponse
  ) => {
    if (!subscriptionDetails?.subscription) {
      return []
    }
    const startDate = new Date(
      subscriptionDetails.subscription.startDate || new Date()
    )
    const currentStart = new Date(
      subscriptionDetails.subscription.currentBillingPeriodStart || new Date()
    )
    const currentEnd = new Date(
      subscriptionDetails.subscription.currentBillingPeriodEnd || new Date()
    )
    const _endDate = subscriptionDetails.subscription.endDate
      ? new Date(subscriptionDetails.subscription.endDate)
      : null
    const today = new Date()
    const billingCycle = (
      subscriptionDetails.subscription.billingCycle || 'monthly'
    ).toLowerCase()

    // Use the stored billing day, fall back to start date's day-of-month
    const billingDay =
      (subscriptionDetails.subscription as any).billingDay ?? getDate(startDate)

    // Calculate days in the current period
    const daysInCurrentPeriod = differenceInDays(currentEnd, currentStart) + 1

    // Start with the current open cycle
    const cycles = [
      {
        id: 'current',
        label: `Current cycle: ${format(currentStart, 'MMM d')} – ${format(currentEnd, 'MMM d, yyyy')} (${differenceInDays(today, currentStart)}/${daysInCurrentPeriod} days elapsed)`,
        start: currentStart,
        end: currentEnd,
        isCurrent: true,
      },
    ]

    // Function to calculate period dates based on billing day
    const calculatePeriodDates = (
      referenceDate: Date,
      monthsToSubtract: number
    ) => {
      // Start with the reference date and subtract months
      const periodStart = subMonths(referenceDate, monthsToSubtract)

      // Set to the correct billing day
      let adjustedStart = new Date(periodStart)
      adjustedStart.setDate(billingDay)

      // If we went too far back, add a month
      if (adjustedStart > periodStart) {
        adjustedStart = subMonths(adjustedStart, 1)
      }

      // Calculate end date (one day before the next billing cycle starts)
      let periodEnd = new Date(adjustedStart)

      if (billingCycle === 'monthly') {
        periodEnd = addMonths(adjustedStart, 1)
      } else if (billingCycle === 'quarterly') {
        periodEnd = addMonths(adjustedStart, 3)
      } else if (billingCycle === 'annual' || billingCycle === 'yearly') {
        periodEnd = addMonths(adjustedStart, 12)
      } else {
        // Default to monthly
        periodEnd = addMonths(adjustedStart, 1)
      }

      // Subtract one day to get the end of the period
      periodEnd = subDays(periodEnd, 1)

      return { start: adjustedStart, end: periodEnd }
    }

    // Generate previous billing periods
    for (let i = 1; i <= 24; i++) {
      // Calculate period based on billing day
      const monthsToSubtract =
        billingCycle === 'monthly'
          ? i
          : billingCycle === 'quarterly'
            ? i * 3
            : billingCycle === 'annual' || billingCycle === 'yearly'
              ? i * 12
              : i

      const { start: periodStart, end: periodEnd } = calculatePeriodDates(
        currentStart,
        monthsToSubtract
      )

      // If this period ends before the subscription started, we're done
      if (isBefore(periodEnd, startDate)) break

      // If this period starts before the subscription started, adjust start date
      const adjustedStart = isBefore(periodStart, startDate)
        ? startDate
        : periodStart

      cycles.push({
        id: `period-${i}`,
        label: `${format(adjustedStart, 'MMM d')} – ${format(periodEnd, 'MMM d, yyyy')}`,
        start: adjustedStart,
        end: periodEnd,
        isCurrent: false,
      })

      // If we've reached or gone before the start date, stop generating more cycles
      if (!isAfter(periodStart, startDate)) break
    }

    return cycles
  }

  // Canonical metrics fetch tracks the billing-cycle picker so the tile
  // and the per-signal breakdown share a window. On initial mount the
  // cycle isn't known yet (billingCycles populates after the first
  // analytics call), so we fall back to the canonical default — the
  // tile will refresh once the cycle resolves.
  const activeCycle =
    billingCycles.find((c) =>
      billingPeriod === 'current' ? c.isCurrent : c.id === billingPeriod
    ) ||
    billingCycles[0] ||
    null
  const cycleStartIso = activeCycle?.start.toISOString() ?? null
  const cycleEndIso = activeCycle?.end.toISOString() ?? null

  useEffect(() => {
    if (!subscriptionId) return
    let cancelled = false
    const params =
      cycleStartIso && cycleEndIso
        ? { startDate: cycleStartIso, endDate: cycleEndIso }
        : undefined
    getCanonicalSubscriptionMetrics(subscriptionId, params).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setCanonicalMetrics(result.data)
      }
    })
    return () => {
      cancelled = true
    }
  }, [subscriptionId, cycleStartIso, cycleEndIso])

  // The credit pool, from the ONE shared balance canon that also
  // feeds the Money tab, the needs-attention page, and GET /v1/credit-balances.
  const loadCreditPool = useCallback(async () => {
    if (!subscriptionId) return
    const result = await getCreditBalancesAction({ subscriptionId })
    if (result.success) {
      setCreditPool(result.data.balances[0] ?? null)
      setCreditPoolPermission(result.data.permission)
    }
  }, [subscriptionId])

  useEffect(() => {
    if (!subscriptionId) return
    let cancelled = false
    getCreditBalancesAction({ subscriptionId }).then((result) => {
      if (cancelled) return
      if (result.success) {
        setCreditPool(result.data.balances[0] ?? null)
        setCreditPoolPermission(result.data.permission)
      }
    })
    return () => {
      cancelled = true
    }
  }, [subscriptionId])

  // Fetch subscription details
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)

        // First fetch subscription details without date filtering to get basic subscription info
        const result = await getSubscriptionAnalyticsAction(subscriptionId)
        if (!result.success || !result.data) {
          throw new Error(
            result.error || 'Failed to fetch subscription analytics'
          )
        }
        const data = result.data
        setSubscriptionDetails(data as any)

        // After we have the subscription details, generate billing cycles
        const cycles = getBillingCycles(data)
        setBillingCycles(cycles)

        // Always refetch with the selected cycle's window so the breakdown
        // matches the KPI tile (both canonical, same window); otherwise the
        // breakdown and the tile never reconcile.
        if (cycles.length > 0) {
          const selectedCycle =
            billingPeriod === 'current'
              ? cycles.find((c) => c.isCurrent) || cycles[0]
              : cycles.find((c) => c.id === billingPeriod) || cycles[0]
          fetchPeriodData(selectedCycle)
        }
      } catch (err) {
        console.error('Failed to fetch subscription details:', err)
        setError('Failed to load subscription details. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [subscriptionId])

  // Separate function to fetch period-specific data
  const fetchPeriodData = async (selectedCycle: {
    start: Date
    end: Date
    id: string
    label: string
    isCurrent: boolean
  }) => {
    try {
      setDataLoading(true)

      // Preserve the current subscription details
      const currentData = { ...subscriptionDetails }

      // Fetch data for the selected period
      const periodResult = await getSubscriptionAnalyticsAction(
        subscriptionId,
        {
          billingPeriodStart: selectedCycle.start.toISOString(),
          billingPeriodEnd: selectedCycle.end.toISOString(),
        }
      )
      if (!periodResult.success || !periodResult.data) {
        throw new Error(
          periodResult.error || 'Failed to fetch period analytics'
        )
      }
      const periodData = periodResult.data as any

      // Merge the data - keep the top subscription info from currentData
      // but update the analytics/financial data from periodData
      if (
        currentData &&
        currentData.subscription &&
        currentData.agent &&
        currentData.customer &&
        currentData.plan
      ) {
        setSubscriptionDetails({
          ...periodData,
          subscription: currentData.subscription,
          agent: currentData.agent,
          customer: currentData.customer,
          plan: currentData.plan,
        })
      } else {
        setSubscriptionDetails(periodData)
      }
    } catch (err) {
      console.error('Failed to fetch period data:', err)
      setError('Failed to load data for the selected period. Please try again.')
    } finally {
      setDataLoading(false)
    }
  }

  // Handle billing period change
  const handleBillingPeriodChange = (value: string) => {
    setBillingPeriod(value)

    // Find selected cycle
    const selectedCycle =
      billingCycles.find((cycle) => cycle.id === value) || billingCycles[0]

    // Fetch data for the selected period while preserving top subscription info
    fetchPeriodData(selectedCycle)
  }

  // Handle refresh button click
  const handleRefresh = () => {
    // Find selected cycle for the current period
    const selectedCycle =
      billingCycles.find((cycle) => cycle.id === billingPeriod) ||
      billingCycles[0]

    // Refresh data while preserving top subscription info
    fetchPeriodData(selectedCycle)
  }

  // Cancel is the SAFE stop (status:'canceled') — it never routes through
  // deleteSubscription's soft delete, so nothing on this subscription's
  // billing history disappears.
  const handleCancelSubscription = async (reason: string) => {
    setIsCanceling(true)
    setCancelError(null)
    try {
      const result = await cancelSubscription(subscriptionId, reason)
      if (!result.success) {
        setCancelError(result.error || 'Failed to cancel subscription')
        return
      }
      setSubscriptionDetails((prev) =>
        prev
          ? {
              ...prev,
              subscription: { ...prev.subscription, status: 'canceled' },
            }
          : prev
      )
      toast({
        title: 'Subscription canceled',
        description:
          'Billing has stopped. Past invoices and usage are unaffected.',
      })
      setShowCancelDialog(false)
    } catch (err) {
      console.error('Failed to cancel subscription:', err)
      setCancelError('Failed to cancel subscription. Please try again.')
    } finally {
      setIsCanceling(false)
    }
  }

  // Extract unique unit types from data
  const getUniqueUnitTypes = () => {
    if (!subscriptionDetails?.dailyBreakdown?.length) return ['all']

    const unitTypes = new Set<string>()
    unitTypes.add('all')

    subscriptionDetails.dailyBreakdown.forEach((day) => {
      if (day.costBreakdown?.byUnitType) {
        day.costBreakdown.byUnitType.forEach((ut) => {
          unitTypes.add(ut.unitType)
        })
      }
    })

    return Array.from(unitTypes)
  }

  // Process chart data from daily breakdown
  const prepareChartData = () => {
    if (!subscriptionDetails || !subscriptionDetails.dailyBreakdown) return []

    // Cost vs Revenue: cumulative cost and revenue per day, mirroring the
    // customer usage chart so the two area lines and their margin gap read the
    // same on both pages.
    if (displayType === 'costVsRevenue') {
      const byDate = subscriptionDetails.dailyBreakdown.reduce(
        (acc, item) => {
          const date = item.date.split('T')[0]
          if (!acc[date]) acc[date] = { date, dailyCost: 0, dailyRevenue: 0 }
          acc[date].dailyCost += item.cost || 0
          acc[date].dailyRevenue += item.revenue || 0
          return acc
        },
        {} as Record<string, any>
      )
      const sorted = Object.values(byDate).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      )
      let cumulativeCost = 0
      let cumulativeRevenue = 0
      return sorted.map((day: any) => {
        cumulativeCost += day.dailyCost
        cumulativeRevenue += day.dailyRevenue
        return {
          date: day.date,
          totalCost: cumulativeCost,
          totalRevenue: cumulativeRevenue,
        }
      })
    }

    // Group by date
    const groupedByDate = subscriptionDetails.dailyBreakdown.reduce(
      (acc, item) => {
        const date = item.date.split('T')[0]
        if (!acc[date]) {
          acc[date] = {}
        }

        // Use signal name as key
        const signalKey = item.signalName.replace(/\s+/g, '')

        // Set the appropriate value based on display type
        if (displayType === 'units') {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.quantity
        } else if (displayType === 'cost') {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.cost
        } else if (displayType === 'revenue') {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.revenue
        } else if (displayType === 'unitType') {
          // For unit type view
          if (item.costBreakdown?.byUnitType) {
            item.costBreakdown.byUnitType.forEach((unitType) => {
              if (
                selectedUnitType === 'all' ||
                selectedUnitType === unitType.unitType
              ) {
                const unitTypeKey = unitType.unitType
                acc[date][unitTypeKey] =
                  (acc[date][unitTypeKey] || 0) + unitType.units
              }
            })
          }
        }

        // Store additional metrics for tooltip
        if (!acc[date].tooltipData) {
          acc[date].tooltipData = {}
        }

        // Store details by signal
        if (!acc[date].tooltipData[signalKey]) {
          acc[date].tooltipData[signalKey] = {
            quantity: 0,
            cost: 0,
            revenue: 0,
            unitTypes: {},
          }
        }

        acc[date].tooltipData[signalKey].quantity += item.quantity
        acc[date].tooltipData[signalKey].cost += item.cost
        acc[date].tooltipData[signalKey].revenue += item.revenue

        // Store unit type details
        if (item.costBreakdown?.byUnitType) {
          item.costBreakdown.byUnitType.forEach((ut) => {
            if (!acc[date].tooltipData[signalKey].unitTypes[ut.unitType]) {
              acc[date].tooltipData[signalKey].unitTypes[ut.unitType] = {
                units: 0,
                cost: 0,
              }
            }
            acc[date].tooltipData[signalKey].unitTypes[ut.unitType].units +=
              ut.units
            acc[date].tooltipData[signalKey].unitTypes[ut.unitType].cost +=
              ut.cost
          })
        }

        // Keep track of the date for sorting
        acc[date].date = date

        return acc
      },
      {} as Record<string, any>
    )

    // Convert to array and sort by date
    const chartData = Object.values(groupedByDate).sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    // If cumulative view, calculate running totals
    if (chartView === 'cumulative') {
      let keys: string[] = []

      if (displayType === 'unitType') {
        // Get unit types as keys
        const unitTypes = getUniqueUnitTypes()
        keys = unitTypes.filter((ut) => ut !== 'all')
      } else {
        // Get signal names as keys
        keys = (subscriptionDetails.signalSummary || []).map((s) =>
          s.signalName.replace(/\s+/g, '')
        )
      }

      const runningTotals: Record<string, number> = {}

      return chartData.map((dayData: any) => {
        const cumulativeData = { ...dayData }

        keys.forEach((key) => {
          if (dayData[key]) {
            runningTotals[key] = (runningTotals[key] || 0) + dayData[key]
            cumulativeData[key] = runningTotals[key]
          }
        })

        return cumulativeData
      })
    }

    return chartData
  }

  const chartData = prepareChartData()

  // The ⓘ next to the toggles follows the active tab, so each view states its
  // own canon basis (units / cost / earned+fees revenue / margin).
  const activeTabTooltip =
    displayType === 'cost'
      ? tooltipDefinitions.totalCost
      : displayType === 'revenue'
        ? tooltipDefinitions.totalRevenue
        : displayType === 'costVsRevenue'
          ? tooltipDefinitions.costVsRevenueChart
          : tooltipDefinitions.units

  const getStatusBadgeColors = (status: string) => {
    switch (status.toLowerCase()) {
      case 'active':
        return 'bg-theme-accent-100 text-theme-accent-700 hover:bg-theme-accent-100'
      case 'canceled':
        return 'bg-destructive/10 text-destructive hover:bg-destructive/10'
      case 'expired':
        return 'bg-gray-100 text-gray-800 hover:bg-gray-100'
      case 'pending':
        return 'bg-amber-100 text-amber-800 hover:bg-amber-100'
      default:
        return 'bg-blue-100 text-blue-800 hover:bg-blue-100'
    }
  }

  // Format margin percentage
  const formatMarginPercent = (revenue: number, cost: number) =>
    formatPct(safeMarginPercent(revenue, revenue - cost))

  // Handle chart type change
  const handleChartTypeChange = (value: string) => {
    setChartType(value as 'area' | 'bar')
  }

  // Function to render content with data loading overlay if needed
  const renderWithDataLoadingState = (content: React.ReactNode) => {
    if (dataLoading) {
      return (
        <div className='relative'>
          <div className='absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]'>
            <Loader2 className='h-8 w-8 animate-spin text-primary' />
          </div>
          <div className='opacity-50'>{content}</div>
        </div>
      )
    }
    return content
  }

  // Modify the tooltip renderer to include additional unit type data
  const renderCustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null

    const dateData = chartData.find((d) => d.date === label)
    if (!dateData) return null

    return (
      <div className='rounded border bg-white p-4 text-sm shadow'>
        <p className='mb-2 font-semibold'>
          {formatDisplayDate(label, 'MMM d, yyyy')}
        </p>

        {payload.map((entry: any, index: number) => {
          const key = entry.dataKey
          const tooltipData = dateData.tooltipData?.[key]

          return (
            <div key={index} className='mb-2'>
              <div className='mb-1 flex items-center'>
                <span
                  className='mr-2 h-3 w-3 rounded-full'
                  style={{ backgroundColor: entry.color }}
                />
                <span className='font-medium'>{entry.name || key}:</span>
                <span className='ml-1 font-semibold'>
                  {displayType === 'units' || displayType === 'unitType'
                    ? entry.value.toLocaleString()
                    : formatCurrency(entry.value)}
                </span>
              </div>

              {tooltipData && displayType !== 'unitType' && (
                <div className='ml-5 text-xs text-gray-600'>
                  <div className='grid grid-cols-2 gap-x-4'>
                    <div>Units: {tooltipData.quantity.toLocaleString()}</div>
                    <div>Cost: {formatCurrency(tooltipData.cost)}</div>
                  </div>

                  {/* Unit type breakdown */}
                  {Object.entries(tooltipData.unitTypes || {}).map(
                    ([unitType, data]: [string, any]) => (
                      <div key={unitType} className='mt-1'>
                        <span className='font-medium'>{unitType}:</span>{' '}
                        {data.units.toLocaleString()} units
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  if (loading) {
    return (
      <Page
        title='Loading...'
        headerProps={{
          breadcrumb: [
            { name: 'Home', href: '/' },
            { name: 'Subscriptions', href: '/subscriptions' },
            { name: 'Loading...' },
          ],
        }}
      >
        <DetailPageSkeleton statCards={4} showChart />
      </Page>
    )
  }

  if (error) {
    return (
      <div className='container mx-auto p-4'>
        <div className='mb-4 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive'>
          {error}
        </div>
        <Button onClick={() => router.push('/subscriptions')} variant='outline'>
          Back to Subscriptions
        </Button>
      </div>
    )
  }

  if (!subscriptionDetails) {
    return (
      <div className='container mx-auto p-4'>
        <div className='mb-4 rounded border border-amber-400 bg-amber-100 px-4 py-3 text-amber-700'>
          Subscription not found.
        </div>
        <Button onClick={() => router.push('/subscriptions')} variant='outline'>
          Back to Subscriptions
        </Button>
      </div>
    )
  }

  // No pause/adjust-plan here: enum_subscriptions_status
  // has no 'paused' state, and plan swaps carry pricing implications this
  // page doesn't resolve. Cancel is the only safe stop wired in.
  const currentStatus = (
    subscriptionDetails.subscription?.status || ''
  ).toLowerCase()
  const canCancel = !['canceled', 'ended', 'expired'].includes(currentStatus)

  return (
    <Page
      title={subscriptionDetails.subscription?.name || 'Subscription'}
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          {
            name: subscriptionDetails.customer?.name || 'Customer',
            href: `/customers/${subscriptionDetails.customer?.id || ''}`,
          },
          { name: subscriptionDetails.subscription?.name || 'Subscription' },
        ],
        actionButtons: (
          <div className='flex items-center gap-2'>
            <Badge
              className={getStatusBadgeColors(
                subscriptionDetails.subscription?.status || 'active'
              )}
            >
              {subscriptionDetails.subscription?.status || 'Unknown'}
            </Badge>
            {canCancel && (
              <Button
                  variant='outline'
                  size='sm'
                  className='text-destructive hover:bg-destructive/10 hover:text-destructive'
                  onClick={() => {
                    setCancelError(null)
                    setShowCancelDialog(true)
                  }}
                >
                  <XCircle className='mr-2 h-4 w-4' />
                  Cancel Subscription
                </Button>
            )}
          </div>
        ),
      }}
    >
      <div className='space-y-6'>
        {/* Company Details Card */}
        <Card className='shadow-sm transition-all duration-200 hover:shadow-md'>
          <CardContent className='p-6'>
            <h3 className='mb-4 text-lg font-semibold'>Company Details</h3>
            {/* First row - 4 columns */}
            <div className='grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-4'>
              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Company
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.customer?.name || '–'}
                </div>
              </div>

              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Agent
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.agent?.name || '–'}
                </div>
              </div>

              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Plan
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.plan?.name || '–'}
                </div>
              </div>

              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Billing Cycle
                </div>
                <div className='text-sm capitalize text-muted-foreground'>
                  {subscriptionDetails.subscription?.billingCycle || '–'}
                </div>
              </div>
            </div>

            {/* Separator line */}
            <div className='my-5 border-t border-border/50' />

            {/* Second row - 3 columns for dates */}
            <div className='grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-3'>
              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Start Date
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.subscription?.startDate
                    ? formatDisplayDate(
                        subscriptionDetails.subscription.startDate,
                        'dd MMM yyyy'
                      )
                    : '–'}
                </div>
              </div>

              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  End Date
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.subscription?.endDate
                    ? formatDisplayDate(
                        subscriptionDetails.subscription.endDate,
                        'dd MMM yyyy'
                      )
                    : '–'}
                </div>
              </div>

              <div>
                <div className='mb-1 text-sm font-semibold text-foreground'>
                  Next Billing Date
                </div>
                <div className='text-sm text-muted-foreground'>
                  {subscriptionDetails.subscription?.currentBillingPeriodEnd
                    ? formatDisplayDate(
                        subscriptionDetails.subscription
                          .currentBillingPeriodEnd,
                        'dd MMM yyyy'
                      )
                    : '–'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Filter Bar */}
        <div className='mb-6 flex flex-wrap items-center gap-4 rounded-lg border bg-background p-3 shadow-sm'>
          <div className='flex items-center gap-2'>
            <span className='min-w-[100px] text-sm font-medium'>
              Billing period:
            </span>
            <Select
              value={billingPeriod}
              onValueChange={handleBillingPeriodChange}
              disabled={dataLoading}
            >
              <SelectTrigger className='min-w-[300px]'>
                <SelectValue placeholder='Select billing period' />
              </SelectTrigger>
              <SelectContent>
                {billingCycles.map((cycle) => (
                  <SelectItem key={cycle.id} value={cycle.id}>
                    {cycle.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            variant='ghost'
            size='sm'
            className='ml-auto'
            onClick={handleRefresh}
            disabled={dataLoading}
          >
            {dataLoading ? (
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            ) : (
              <RefreshCw className='mr-2 h-4 w-4' />
            )}
            Refresh
          </Button>
        </div>

        {/* KPI Summary Row. Numbers source from canonical 30-day metrics
            (getCanonicalSubscriptionMetrics). The billing period picker
            below only drives the chart + per-signal table (Revenue basis: earned + fees);
            these tiles stay on the canonical 30-day rolling window so they
            line up with home and customer detail for the same sub. */}
        {renderWithDataLoadingState(
          <div className='mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4'>
            <Card className='overflow-hidden shadow-sm transition-all duration-200 hover:shadow-md'>
              <CardContent className='p-0'>
                <div className='border-b bg-theme-accent-50/30 p-4'>
                  <div className='flex items-center gap-1.5 text-sm font-semibold text-muted-foreground'>
                    Total Revenue
                    <InfoTooltip {...tooltipDefinitions.totalRevenue} />
                  </div>
                </div>
                <div className='p-4'>
                  <div className='text-2xl font-bold'>
                    {/* Loading state shows a dash instead of a fake $0.00 so
                        the user never sees a misleading zero while the
                        canonical fetch is in flight. */}
                    {canonicalMetrics === null
                      ? '\u2014'
                      : formatCurrency(canonicalMetrics.revenue)}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className='overflow-hidden shadow-sm transition-all duration-200 hover:shadow-md'>
              <CardContent className='p-0'>
                <div className='border-b bg-red-50/30 p-4'>
                  <div className='text-sm font-semibold text-muted-foreground'>
                    Total Cost
                  </div>
                </div>
                <div className='p-4'>
                  <div className='text-2xl font-bold'>
                    {/* Same loading-vs-zero distinction as Total Revenue. */}
                    {canonicalMetrics === null
                      ? '\u2014'
                      : formatCurrency(canonicalMetrics.cost)}
                  </div>
                  {subscriptionDetails.costBreakdown?.avgCostPerEvent && (
                    <div className='text-sm text-muted-foreground'>
                      Avg cost per event:{' '}
                      {formatCurrency(
                        subscriptionDetails.costBreakdown.avgCostPerEvent,
                        'USD',
                        2
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className='overflow-hidden shadow-sm transition-all duration-200 hover:shadow-md'>
              <CardContent className='p-0'>
                <div className='border-b bg-blue-50/30 p-4'>
                  <div className='flex items-center gap-1.5 text-sm font-semibold text-muted-foreground'>
                    Total Margin
                    <InfoTooltip {...tooltipDefinitions.totalMargin} />
                  </div>
                </div>
                <div className='p-4'>
                  <div className='text-2xl font-bold'>
                    {/* Null canonicalMetrics is "still loading"; null
                        marginPercent is canon M1 (zero revenue → no
                        defined margin). Both render the same glyph
                        (U+2014), so a zero-revenue subscription reads the
                        same while loading and once loaded. */}
                    {formatPct(canonicalMetrics?.marginPercent ?? null)}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Current Bill & Usage Graph */}
        {renderWithDataLoadingState(
          <Card className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'>
            <CardHeader className='flex flex-row items-center justify-between border-b bg-gray-50/50 pb-2'>
              <CardTitle>Current Bill & Usage</CardTitle>
              <div className='flex flex-wrap items-center gap-4'>
                <div className='flex items-center gap-2'>
                  <Button
                    variant={displayType === 'units' ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setDisplayType('units')}
                    className='h-8 px-3'
                    disabled={dataLoading}
                  >
                    Metrics
                  </Button>
                  <Button
                    variant={displayType === 'cost' ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setDisplayType('cost')}
                    className='h-8 px-3'
                    disabled={dataLoading}
                  >
                    Cost
                  </Button>
                  <Button
                    variant={displayType === 'revenue' ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setDisplayType('revenue')}
                    className='h-8 px-3'
                    disabled={dataLoading}
                  >
                    Revenue
                  </Button>
                  <Button
                    variant={
                      displayType === 'costVsRevenue' ? 'default' : 'outline'
                    }
                    size='sm'
                    onClick={() => {
                      setDisplayType('costVsRevenue')
                      setChartView('cumulative')
                      setChartType('area')
                    }}
                    className='h-8 px-3'
                    disabled={dataLoading}
                  >
                    Cost vs Revenue
                  </Button>
                  {/* One ⓘ that describes whichever tab is active, so each view
                      states its own canon basis instead of one fixed label. */}
                  <InfoTooltip {...activeTabTooltip} iconSize='h-3 w-3' />
                </div>

                {displayType === 'unitType' && (
                  <div className='flex items-center gap-2 border-l pl-4'>
                    <Select
                      value={selectedUnitType}
                      onValueChange={setSelectedUnitType}
                      disabled={dataLoading}
                    >
                      <SelectTrigger className='h-8 w-36'>
                        <SelectValue placeholder='Unit Type' />
                      </SelectTrigger>
                      <SelectContent>
                        {getUniqueUnitTypes().map((type) => (
                          <SelectItem key={type} value={type}>
                            {type === 'all' ? 'All Types' : type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className='flex gap-2 border-l pl-4'>
                  <Select
                    value={chartView}
                    onValueChange={(value) =>
                      setChartView(value as 'periodic' | 'cumulative')
                    }
                    disabled={dataLoading}
                  >
                    <SelectTrigger className='h-8 w-36'>
                      <SelectValue placeholder='Display' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='periodic'>Periodic</SelectItem>
                      <SelectItem value='cumulative'>Cumulative</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={chartType}
                    onValueChange={handleChartTypeChange}
                    disabled={dataLoading}
                  >
                    <SelectTrigger className='h-8 w-28'>
                      <SelectValue placeholder='Chart Type' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='area'>Area</SelectItem>
                      <SelectItem value='bar'>Bar</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className='p-4'>
              <div className='h-[350px] w-full'>
                {/* ChartData is empty for a subscription with no usage in
                    the selected window (e.g. a brand-new subscription). An
                    empty ResponsiveContainer draws only axis lines on a
                    blank background, so show an explicit empty state. */}
                {chartData.length === 0 ? (
                  <div className='flex h-full items-center justify-center text-sm text-muted-foreground'>
                    No usage data for this period yet.
                  </div>
                ) : (
                  <ResponsiveContainer width='100%' height='100%'>
                    {chartType === 'area' ? (
                      displayType === 'costVsRevenue' ? (
                        <AreaChart
                          data={chartData}
                          margin={{ top: 20, right: 30, left: 0, bottom: 30 }}
                        >
                          <CartesianGrid strokeDasharray='3 3' />
                          <XAxis
                            dataKey='date'
                            angle={-45}
                            textAnchor='end'
                            height={60}
                            tick={{ fontSize: 12 }}
                          />
                          <YAxis
                            tickFormatter={(value) => formatCurrency(value)}
                          />
                          <Tooltip
                            content={({ active, payload, label }) => {
                              if (active && payload && payload.length) {
                                const costValue =
                                  (payload.find((p) => p.name === 'Cost')
                                    ?.value as number) || 0
                                const revenueValue =
                                  (payload.find((p) => p.name === 'Revenue')
                                    ?.value as number) || 0
                                const margin = safeMarginPercent(
                                  revenueValue,
                                  revenueValue - costValue
                                )
                                return (
                                  <div className='rounded-md border bg-white p-3 shadow-md'>
                                    <p className='mb-1 font-medium'>{label}</p>
                                    <div className='grid grid-cols-2 gap-x-3 gap-y-1 text-sm'>
                                      <span className='text-muted-foreground'>
                                        Cost:
                                      </span>
                                      <span className='font-medium'>
                                        {formatCurrency(costValue)}
                                      </span>
                                      <span className='text-muted-foreground'>
                                        Revenue:
                                      </span>
                                      <span className='font-medium'>
                                        {formatCurrency(revenueValue)}
                                      </span>
                                      <span className='text-muted-foreground'>
                                        Margin:
                                      </span>
                                      <span className='font-medium'>
                                        {formatCurrency(
                                          revenueValue - costValue
                                        )}{' '}
                                        ({formatPct(margin)})
                                      </span>
                                    </div>
                                  </div>
                                )
                              }
                              return null
                            }}
                          />
                          <Legend wrapperStyle={{ paddingTop: '10px' }} />
                          <Area
                            type='monotone'
                            dataKey='totalCost'
                            name='Cost'
                            fill={CHART_COLORS[4]}
                            stroke={CHART_COLORS[4]}
                            fillOpacity={0.4}
                            strokeWidth={2}
                          />
                          <Area
                            type='monotone'
                            dataKey='totalRevenue'
                            name='Revenue'
                            fill={CHART_COLORS[1]}
                            stroke={CHART_COLORS[1]}
                            fillOpacity={0.4}
                            strokeWidth={2}
                          />
                        </AreaChart>
                      ) : (
                        <AreaChart
                          data={chartData}
                          margin={{
                            top: 20,
                            right: 30,
                            left: 0,
                            bottom: 30,
                          }}
                        >
                          <CartesianGrid strokeDasharray='3 3' />
                          <XAxis
                            dataKey='date'
                            angle={-45}
                            textAnchor='end'
                            height={60}
                            tick={{ fontSize: 12 }}
                          />
                          <YAxis
                            tickFormatter={(value) =>
                              displayType === 'units'
                                ? value.toString()
                                : formatCurrency(value)
                            }
                          />
                          <Tooltip content={renderCustomTooltip} />
                          <Legend wrapperStyle={{ paddingTop: '10px' }} />
                          {displayType === 'unitType'
                            ? getUniqueUnitTypes()
                                .filter(
                                  (type) =>
                                    type !== 'all' &&
                                    (selectedUnitType === 'all' ||
                                      selectedUnitType === type)
                                )
                                .map((unitType, index) => (
                                  <Area
                                    key={unitType}
                                    type='monotone'
                                    dataKey={unitType}
                                    name={unitType}
                                    stackId={
                                      selectedUnitType === 'all'
                                        ? '1'
                                        : undefined
                                    }
                                    fill={
                                      CHART_COLORS[index % CHART_COLORS.length]
                                    }
                                    stroke={
                                      CHART_COLORS[index % CHART_COLORS.length]
                                    }
                                    fillOpacity={0.6}
                                  />
                                ))
                            : (subscriptionDetails.signalSummary || []).map(
                                (signal, index) => (
                                  <Area
                                    key={signal.signalId}
                                    type='monotone'
                                    dataKey={signal.signalName.replace(
                                      /\s+/g,
                                      ''
                                    )}
                                    name={signal.signalName}
                                    stackId='1'
                                    fill={
                                      CHART_COLORS[index % CHART_COLORS.length]
                                    }
                                    stroke={
                                      CHART_COLORS[index % CHART_COLORS.length]
                                    }
                                    fillOpacity={0.6}
                                  />
                                )
                              )}
                        </AreaChart>
                      )
                    ) : (
                      <BarChart
                        data={chartData}
                        margin={{
                          top: 20,
                          right: 30,
                          left: 0,
                          bottom: 30,
                        }}
                      >
                        <CartesianGrid strokeDasharray='3 3' />
                        <XAxis
                          dataKey='date'
                          angle={-45}
                          textAnchor='end'
                          height={60}
                          tick={{ fontSize: 12 }}
                        />
                        <YAxis
                          tickFormatter={(value) =>
                            displayType === 'units'
                              ? value.toString()
                              : formatCurrency(value)
                          }
                        />
                        <Tooltip content={renderCustomTooltip} />
                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                        {displayType === 'unitType'
                          ? getUniqueUnitTypes()
                              .filter(
                                (type) =>
                                  type !== 'all' &&
                                  (selectedUnitType === 'all' ||
                                    selectedUnitType === type)
                              )
                              .map((unitType, index) => (
                                <Bar
                                  key={unitType}
                                  dataKey={unitType}
                                  name={unitType}
                                  stackId={
                                    selectedUnitType === 'all' ? '1' : undefined
                                  }
                                  fill={
                                    CHART_COLORS[index % CHART_COLORS.length]
                                  }
                                  fillOpacity={0.8}
                                  radius={[4, 4, 0, 0]}
                                />
                              ))
                          : (subscriptionDetails.signalSummary || []).map(
                              (signal, index) => (
                                <Bar
                                  key={signal.signalId}
                                  dataKey={signal.signalName.replace(
                                    /\s+/g,
                                    ''
                                  )}
                                  name={signal.signalName}
                                  stackId='1'
                                  fill={
                                    CHART_COLORS[index % CHART_COLORS.length]
                                  }
                                  fillOpacity={0.8}
                                  radius={[4, 4, 0, 0]}
                                />
                              )
                            )}
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Credit pool. Rendered only when the plan sells one.
            Nothing here gates: when Left hits zero the calls keep working and
            the overage bills. */}
        {creditPool && (
          <Card className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'>
            <CardHeader className='flex flex-row items-center justify-between border-b bg-gray-50/50'>
              <CardTitle className='flex items-center gap-1.5'>
                Credit pool
                <InfoTooltip {...tooltipDefinitions.creditPools} />
              </CardTitle>
              <div className='flex items-center gap-2'>
                {creditPool.alertsPaused && (
                  <span className='inline-flex items-center gap-1'>
                    <Badge variant='outline'>Alerts paused</Badge>
                    <InfoTooltip
                      {...tooltipDefinitions.creditPoolAlertsPaused}
                      iconSize='h-3 w-3'
                    />
                  </span>
                )}
                <Button
                    variant='outline'
                    size='sm'
                    onClick={() => setCreditPoolDialogOpen(true)}
                  >
                    Top up or pause
                  </Button>
              </div>
            </CardHeader>
            <CardContent className='pt-4'>
              <div className='grid gap-4 sm:grid-cols-4'>
                <div>
                  <p className='text-sm text-muted-foreground'>Pool size</p>
                  <p className='text-xl font-semibold'>
                    {Math.round(creditPool.poolSizeUnits).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                    Used this period
                    <InfoTooltip
                      {...tooltipDefinitions.creditPoolUsed}
                      iconSize='h-3 w-3'
                    />
                  </p>
                  <p className='text-xl font-semibold'>
                    {creditPool.noActivePeriod
                      ? 'Not started'
                      : Math.round(creditPool.consumedUnits).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                    Units left
                    <InfoTooltip
                      {...tooltipDefinitions.creditPoolRemaining}
                      iconSize='h-3 w-3'
                    />
                  </p>
                  <p
                    className={`text-xl font-semibold ${
                      !creditPool.noActivePeriod &&
                      creditPool.remainingUnits <= 0
                        ? 'text-destructive'
                        : ''
                    }`}
                  >
                    {creditPool.noActivePeriod
                      ? 'Not started'
                      : Math.round(creditPool.remainingUnits).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className='flex items-center gap-1 text-sm text-muted-foreground'>
                    Billing as overage
                    <InfoTooltip
                      {...tooltipDefinitions.creditPoolOverage}
                      iconSize='h-3 w-3'
                    />
                  </p>
                  <p className='text-xl font-semibold'>
                    {!creditPool.noActivePeriod &&
                    creditPool.overageInProgressUnits > 0
                      ? Math.round(
                          creditPool.overageInProgressUnits
                        ).toLocaleString()
                      : '—'}
                  </p>
                </div>
              </div>
              <p className='mt-4 text-sm text-muted-foreground'>
                {creditPool.noActivePeriod
                  ? 'This subscription has no billing period yet, so the pool has not started counting down.'
                  : `Period ${formatDisplayDate(new Date(creditPool.periodStartMs))} to ${formatDisplayDate(new Date(creditPool.periodEndMs))}. Nothing stops when the pool empties: usage past the pool bills as overage${creditPool.overageRatePerUnit !== null ? ` at ${formatCurrency(creditPool.overageRatePerUnit)} a unit` : ''}.`}
              </p>
              <p className='mt-1 text-xs text-muted-foreground'>
                Read the same numbers from code with
                client.creditBalances.get(subscriptionId) or GET
                /v1/subscriptions/{'{id}'}/credit-balance.
                {CREDIT_BALANCES_DOCS
                  ? ` Reference: ${CREDIT_BALANCES_DOCS}`
                  : null}
              </p>
            </CardContent>
          </Card>
        )}

        {creditPoolDialogOpen && (
          <CreditPoolResolveDialog
            pool={creditPool}
            permission={creditPoolPermission}
            onOpenChange={(open) => {
              if (!open) setCreditPoolDialogOpen(false)
            }}
            onResolved={loadCreditPool}
          />
        )}

        {/* Metric-Level Breakdown */}
        {renderWithDataLoadingState(
          <Card className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'>
            <CardHeader className='border-b bg-gray-50/50'>
              <CardTitle>Metric-Level Breakdown</CardTitle>
            </CardHeader>
            <CardContent className='p-0'>
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader className='bg-muted/20'>
                    <TableRow>
                      <TableHead className='font-semibold'>Signal</TableHead>
                      <TableHead className='text-right font-semibold'>
                        Count
                      </TableHead>
                      <TableHead className='text-right font-semibold'>
                        <span className='inline-flex items-center justify-end gap-1'>
                          Earned
                          <InfoTooltip
                            {...tooltipDefinitions.metricBreakdownEarned}
                            iconSize='h-3 w-3'
                          />
                        </span>
                      </TableHead>
                      <TableHead className='text-right font-semibold'>
                        Cost
                      </TableHead>
                      <TableHead className='text-right font-semibold'>
                        <span className='inline-flex items-center justify-end gap-1'>
                          Earned Margin
                          <InfoTooltip
                            {...tooltipDefinitions.metricBreakdownEarnedMargin}
                            iconSize='h-3 w-3'
                          />
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(subscriptionDetails.signalSummary || []).map(
                      (signal, index) => (
                        <TableRow
                          key={signal.signalId}
                          className={
                            index % 2 === 0
                              ? 'bg-background transition-colors duration-200 hover:bg-muted/50'
                              : 'bg-muted/30 transition-colors duration-200 hover:bg-muted/50'
                          }
                        >
                          <TableCell className='border-b font-semibold'>
                            {signal.signalName}
                          </TableCell>
                          <TableCell className='border-b text-right'>
                            {signal.totalQuantity.toLocaleString()}
                          </TableCell>
                          <TableCell className='border-b text-right'>
                            {formatCurrency(signal.totalRevenue)}
                          </TableCell>
                          <TableCell className='border-b text-right'>
                            {formatCurrency(signal.totalCost)}
                          </TableCell>
                          <TableCell className='border-b text-right'>
                            <div className='flex flex-col'>
                              <span>
                                {formatCurrency(
                                  (signal.totalRevenue || 0) -
                                    (signal.totalCost || 0)
                                )}
                              </span>
                              <span
                                className={`text-xs ${(signal.totalRevenue || 0) - (signal.totalCost || 0) > 0 ? 'text-secondary-dark' : 'text-red-600'}`}
                              >
                                (
                                {formatMarginPercent(
                                  signal.totalRevenue,
                                  signal.totalCost
                                )}
                                )
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    )}

                    {/* Total row */}
                    <TableRow className='bg-muted/20'>
                      <TableCell className='font-semibold'>Total</TableCell>
                      <TableCell className='text-right'>
                        {(subscriptionDetails.signalSummary || [])
                          .reduce(
                            (sum, signal) => sum + signal.totalQuantity,
                            0
                          )
                          .toLocaleString()}
                      </TableCell>
                      <TableCell className='text-right'>
                        {formatCurrency(
                          subscriptionDetails.summary?.totalRevenue || 0
                        )}
                      </TableCell>
                      <TableCell className='text-right'>
                        {formatCurrency(
                          subscriptionDetails.summary?.totalCost || 0
                        )}
                      </TableCell>
                      <TableCell className='text-right'>
                        <div className='flex flex-col'>
                          <span>
                            {formatCurrency(
                              subscriptionDetails.summary?.totalMargin || 0
                            )}
                          </span>
                          <span
                            className={`text-xs ${(subscriptionDetails.summary?.totalMargin || 0) > 0 ? 'text-secondary-dark' : 'text-red-600'}`}
                          >
                            (
                            {formatMarginPercent(
                              subscriptionDetails.summary?.totalRevenue || 0,
                              subscriptionDetails.summary?.totalCost || 0
                            )}
                            )
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cost Breakdown */}
        {subscriptionDetails.costBreakdown &&
          renderWithDataLoadingState(
            <Card className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'>
              <CardHeader className='border-b bg-gray-50/50'>
                <CardTitle>Cost Breakdown</CardTitle>
              </CardHeader>
              <CardContent className='p-6'>
                {/* Cost Analytics Summary */}
                {subscriptionDetails.costBreakdown.avgCostPerEvent && (
                  <div className='mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                    <div className='rounded-md border bg-slate-50/50 p-4'>
                      <div className='text-sm font-semibold text-gray-500'>
                        Avg. Cost Per Event
                      </div>
                      <div className='mt-1 text-xl'>
                        {formatCurrency(
                          subscriptionDetails.costBreakdown.avgCostPerEvent,
                          'USD',
                          2
                        )}
                      </div>
                    </div>
                    <div className='rounded-md border bg-slate-50/50 p-4'>
                      <div className='text-sm font-semibold text-gray-500'>
                        Avg. Daily Cost
                      </div>
                      <div className='mt-1 text-xl'>
                        {formatCurrency(
                          subscriptionDetails.costBreakdown.avgDailyCost || 0,
                          'USD',
                          2
                        )}
                      </div>
                    </div>
                    <div className='rounded-md border bg-slate-50/50 p-4'>
                      <div className='text-sm font-semibold text-gray-500'>
                        Total Events
                      </div>
                      <div className='mt-1 text-xl'>
                        {(
                          subscriptionDetails.costBreakdown.totalEvents || 0
                        ).toLocaleString()}
                      </div>
                    </div>
                    <div className='rounded-md border bg-slate-50/50 p-4'>
                      <div className='text-sm font-semibold text-gray-500'>
                        Cost Trend
                      </div>
                      <div className='mt-1 flex items-center'>
                        {subscriptionDetails.costBreakdown.costTrend ===
                        'decreasing' ? (
                          <span className='flex items-center text-secondary-dark'>
                            <svg
                              className='mr-1 h-4 w-4'
                              fill='none'
                              stroke='currentColor'
                              viewBox='0 0 24 24'
                              xmlns='http://www.w3.org/2000/svg'
                            >
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth={2}
                                d='M13 17h8m0 0V9m0 8l-8-8-4 4-6-6'
                              />
                            </svg>
                            <span className='text-lg'>Decreasing</span>
                          </span>
                        ) : subscriptionDetails.costBreakdown.costTrend ===
                          'increasing' ? (
                          <span className='flex items-center text-red-600'>
                            <svg
                              className='mr-1 h-4 w-4'
                              fill='none'
                              stroke='currentColor'
                              viewBox='0 0 24 24'
                              xmlns='http://www.w3.org/2000/svg'
                            >
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth={2}
                                d='M13 7h8m0 0v8m0-8l-8 8-4-4-6 6'
                              />
                            </svg>
                            <span className='text-lg'>Increasing</span>
                          </span>
                        ) : (
                          <span className='flex items-center text-yellow-600'>
                            <svg
                              className='mr-1 h-4 w-4'
                              fill='none'
                              stroke='currentColor'
                              viewBox='0 0 24 24'
                              xmlns='http://www.w3.org/2000/svg'
                            >
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth={2}
                                d='M5 12h14'
                              />
                            </svg>
                            <span className='text-lg'>Stable</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Highest Cost Items */}
                {subscriptionDetails.costBreakdown.highestService && (
                  <div className='mb-6 rounded-md border p-4'>
                    <h3 className='mb-3 text-lg font-semibold'>
                      Cost Highlights
                    </h3>
                    <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
                      <div>
                        <h4 className='text-sm font-semibold text-gray-500'>
                          Highest Cost Service
                        </h4>
                        <div className='mt-1'>
                          {
                            subscriptionDetails.costBreakdown.highestService
                              .name
                          }
                        </div>
                        <div className='mt-0.5 text-sm text-gray-600'>
                          {formatCurrency(
                            subscriptionDetails.costBreakdown.highestService
                              .cost
                          )}
                          <span className='ml-1 text-xs'>
                            (
                            {subscriptionDetails.costBreakdown.highestService.units.toLocaleString()}{' '}
                            units)
                          </span>
                        </div>
                      </div>
                      <div>
                        <h4 className='text-sm font-semibold text-gray-500'>
                          Highest Cost Provider
                        </h4>
                        <div className='mt-1'>
                          {subscriptionDetails.costBreakdown.highestProvider
                            ?.name || 'N/A'}
                        </div>
                        <div className='mt-0.5 text-sm text-gray-600'>
                          {formatCurrency(
                            subscriptionDetails.costBreakdown.highestProvider
                              ?.cost || 0
                          )}
                          <span className='ml-1 text-xs'>
                            (
                            {subscriptionDetails.costBreakdown.highestProvider?.units.toLocaleString() ||
                              '0'}{' '}
                            units)
                          </span>
                        </div>
                      </div>
                      <div>
                        <h4 className='text-sm font-semibold text-gray-500'>
                          Highest Cost Per Unit
                        </h4>
                        <div className='mt-1'>
                          {subscriptionDetails.costBreakdown
                            .highestCostPerUnitService?.name || 'N/A'}
                        </div>
                        <div className='mt-0.5 text-sm text-gray-600'>
                          {formatCurrency(
                            subscriptionDetails.costBreakdown
                              .highestCostPerUnitService?.costPerUnit || 0,
                            'USD',
                            4
                          )}{' '}
                          per unit
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Service Average Costs */}
                {subscriptionDetails.costBreakdown.serviceAvgCosts &&
                  subscriptionDetails.costBreakdown.serviceAvgCosts.length >
                    0 && (
                    <div className='mb-6 rounded-md border p-4'>
                      <h3 className='mb-3 text-lg font-semibold'>
                        Service Cost Analysis
                      </h3>
                      <div className='overflow-x-auto'>
                        <table className='min-w-full divide-y divide-gray-200'>
                          <thead className='bg-gray-50'>
                            <tr>
                              <th
                                scope='col'
                                className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500'
                              >
                                Service
                              </th>
                              <th
                                scope='col'
                                className='px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500'
                              >
                                Event Count
                              </th>
                              <th
                                scope='col'
                                className='px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500'
                              >
                                Total Cost
                              </th>
                              <th
                                scope='col'
                                className='px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500'
                              >
                                Avg. Cost Per Event
                              </th>
                            </tr>
                          </thead>
                          <tbody className='divide-y divide-gray-200 bg-white'>
                            {subscriptionDetails.costBreakdown.serviceAvgCosts.map(
                              (service, index) => (
                                <tr
                                  key={index}
                                  className={
                                    index % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                                  }
                                >
                                  <td className='whitespace-nowrap px-6 py-4'>
                                    <div className='font-medium text-gray-900'>
                                      {service.serviceName}
                                    </div>
                                  </td>
                                  <td className='whitespace-nowrap px-6 py-4 text-right text-sm text-gray-500'>
                                    {service.eventCount.toLocaleString()}
                                  </td>
                                  <td className='whitespace-nowrap px-6 py-4 text-right text-sm text-gray-500'>
                                    {formatCurrency(service.totalCost)}
                                  </td>
                                  <td className='whitespace-nowrap px-6 py-4 text-right text-sm font-medium text-gray-900'>
                                    {formatCurrency(service.avgCost, 'USD', 2)}
                                  </td>
                                </tr>
                              )
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                <div className='grid grid-cols-1 gap-6'>
                  {/* By Service */}
                  <div>
                    <h3 className='mb-4 text-lg font-medium'>By Service</h3>
                    <div className='grid grid-cols-1 items-center gap-6 md:grid-cols-2'>
                      <div className='max-h-60 overflow-y-auto'>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Service</TableHead>
                              <TableHead className='text-right'>
                                Units
                              </TableHead>
                              <TableHead className='text-right'>Cost</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {subscriptionDetails.costBreakdown.byService.map(
                              (service, index) => (
                                <TableRow key={index}>
                                  <TableCell
                                    className='max-w-[180px] truncate font-medium'
                                    title={service.serviceName}
                                  >
                                    {service.serviceName}
                                  </TableCell>
                                  <TableCell className='text-right'>
                                    {service.units.toLocaleString()}
                                    <div className='text-xs text-muted-foreground'>
                                      @ {formatCurrency(service.costPerUnit)}{' '}
                                      each
                                    </div>
                                  </TableCell>
                                  <TableCell className='text-right font-semibold'>
                                    {formatCurrency(service.cost)}
                                  </TableCell>
                                </TableRow>
                              )
                            )}
                          </TableBody>
                        </Table>
                      </div>
                      <div className='flex h-52 items-center justify-center'>
                        <ResponsiveContainer width='100%' height='100%'>
                          <BarChart
                            data={subscriptionDetails.costBreakdown.byService}
                            layout='vertical'
                            margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                          >
                            <XAxis
                              type='number'
                              tickFormatter={(value) => formatCurrency(value)}
                            />
                            <YAxis
                              dataKey='serviceName'
                              type='category'
                              width={120}
                              tick={{ fontSize: 11 }}
                              tickFormatter={(value) =>
                                value.length > 18
                                  ? `${value.substring(0, 18)}...`
                                  : value
                              }
                            />
                            <Tooltip
                              formatter={(value) =>
                                formatCurrency(value as number)
                              }
                            />
                            <Bar
                              dataKey='cost'
                              fill={CHART_COLORS[0]}
                              radius={[0, 4, 4, 0]}
                            />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>

                  {/* By Provider & By Unit Type - Side by Side */}
                  <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
                    {/* By Provider */}
                    <div className='rounded-lg border p-4'>
                      <h3 className='mb-3 text-base font-medium'>
                        By Provider
                      </h3>
                      <div className='flex items-center gap-4'>
                        <div className='flex-1 overflow-x-auto'>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className='text-xs'>
                                  Provider
                                </TableHead>
                                <TableHead className='text-right text-xs'>
                                  Units
                                </TableHead>
                                <TableHead className='text-right text-xs'>
                                  Cost
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {subscriptionDetails.costBreakdown.byProvider.map(
                                (provider, index) => (
                                  <TableRow key={index}>
                                    <TableCell className='py-2 text-sm font-medium'>
                                      {provider.providerName}
                                    </TableCell>
                                    <TableCell className='py-2 text-right text-sm'>
                                      {provider.units.toLocaleString()}
                                    </TableCell>
                                    <TableCell className='py-2 text-right text-sm font-semibold'>
                                      {formatCurrency(provider.cost)}
                                    </TableCell>
                                  </TableRow>
                                )
                              )}
                            </TableBody>
                          </Table>
                        </div>
                        <div className='h-32 w-32 flex-shrink-0'>
                          <ResponsiveContainer width='100%' height='100%'>
                            <PieChart>
                              <Pie
                                data={
                                  subscriptionDetails.costBreakdown.byProvider
                                }
                                dataKey='cost'
                                nameKey='providerName'
                                cx='50%'
                                cy='50%'
                                outerRadius={50}
                                innerRadius={25}
                                fill={CHART_COLORS[0]}
                                paddingAngle={2}
                              >
                                {subscriptionDetails.costBreakdown.byProvider.map(
                                  (_entry, index) => (
                                    <Cell
                                      key={`cell-${index}`}
                                      fill={
                                        CHART_COLORS[
                                          index % CHART_COLORS.length
                                        ]
                                      }
                                    />
                                  )
                                )}
                              </Pie>
                              <Tooltip
                                formatter={(value) =>
                                  formatCurrency(value as number)
                                }
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>

                    {/* By Unit Type */}
                    <div className='rounded-lg border p-4'>
                      <h3 className='mb-3 text-base font-medium'>
                        By Unit Type
                      </h3>
                      <div className='flex items-center gap-4'>
                        <div className='flex-1 overflow-x-auto'>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className='text-xs'>
                                  Unit Type
                                </TableHead>
                                <TableHead className='text-right text-xs'>
                                  Units
                                </TableHead>
                                <TableHead className='text-right text-xs'>
                                  Cost
                                </TableHead>
                                <TableHead className='text-right text-xs'>
                                  Per Unit
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {subscriptionDetails.costBreakdown.byUnitType.map(
                                (unitType, index) => (
                                  <TableRow key={index}>
                                    <TableCell className='py-2 text-sm font-medium'>
                                      {unitType.unitType}
                                    </TableCell>
                                    <TableCell className='py-2 text-right text-sm'>
                                      {unitType.units.toLocaleString()}
                                    </TableCell>
                                    <TableCell className='py-2 text-right text-sm font-semibold'>
                                      {formatCurrency(unitType.cost)}
                                    </TableCell>
                                    <TableCell className='py-2 text-right text-sm'>
                                      {formatCurrency(
                                        unitType.cost / unitType.units,
                                        'USD',
                                        2
                                      )}
                                    </TableCell>
                                  </TableRow>
                                )
                              )}
                            </TableBody>
                          </Table>
                        </div>
                        <div className='h-32 w-32 flex-shrink-0'>
                          <ResponsiveContainer width='100%' height='100%'>
                            <PieChart>
                              <Pie
                                data={
                                  subscriptionDetails.costBreakdown.byUnitType
                                }
                                dataKey='cost'
                                nameKey='unitType'
                                cx='50%'
                                cy='50%'
                                outerRadius={50}
                                innerRadius={25}
                                fill={CHART_COLORS[0]}
                                paddingAngle={2}
                              >
                                {subscriptionDetails.costBreakdown.byUnitType.map(
                                  (_entry, index) => (
                                    <Cell
                                      key={`cell-${index}`}
                                      fill={
                                        CHART_COLORS[
                                          index % CHART_COLORS.length
                                        ]
                                      }
                                    />
                                  )
                                )}
                              </Pie>
                              <Tooltip
                                formatter={(value) =>
                                  formatCurrency(value as number)
                                }
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        {/* All invoices for this subscription — paginated, newest first */}
        {renderWithDataLoadingState(
          <InvoicesTable
            subscriptionId={subscriptionId}
            paginated
            pageSize={25}
            sortBy='invoiceDate'
            sortOrder='desc'
            includeDetails={true}
            title='All Invoices'
            className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'
          />
        )}

        {/* Change history — subscription_change_logs, read-only */}
        <SubscriptionHistorySection subscriptionId={subscriptionId} />
      </div>

      <CancelSubscriptionDialog
        open={showCancelDialog}
        subscriptionName={
          subscriptionDetails.subscription?.name || 'this subscription'
        }
        customerName={subscriptionDetails.customer?.name || 'This customer'}
        pending={isCanceling}
        error={cancelError}
        onCancel={() => setShowCancelDialog(false)}
        onConfirm={handleCancelSubscription}
      />
    </Page>
  )
}
