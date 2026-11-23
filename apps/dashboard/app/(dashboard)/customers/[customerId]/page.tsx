// @ts-nocheck
'use client'

import { useState, useEffect } from 'react'
import { formatDisplayDate } from '@/lib/canon-date'
import { useParams, useRouter } from 'next/navigation'
import { useCustomer } from '@/services/customers-service'
import {
  Loader2,
  ChevronLeft,
  ExternalLink,
  Plus,
  TrendingUp,
  Eye,
} from 'lucide-react'
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
} from 'recharts'
import { getSubscriptions as getSubscriptionsAction } from '@/app/actions/subscriptions'
import { getCreditBalancesAction } from '@/app/actions/credit-pools'
import type { CreditPoolBalanceView } from '@/features/money/credit-pool-types'
import {
  getSubscriptionAnalytics as getSubscriptionAnalyticsAction,
  type SubscriptionAnalyticsResponse,
  getCanonicalCustomerMetrics,
  getCustomerShareOfRevenue,
  getCustomerShareOfCost,
  type CanonicalCustomerMetricsResponse,
  type CustomerShareOfRevenueResponse,
  type CustomerShareOfCostResponse,
} from '@/app/actions/analytics'
import {
  getCustomerMrrArr,
  type CustomerMrrArrResponse,
} from '@/app/actions/customer-mrr'
import {
  formatCurrency,
  formatPct,
  safeMarginPercent,
} from '@/lib/canon-format'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { InvoicesTable } from '@/features/invoices/InvoicesTable'
import { impersonateCustomer } from '@/app/actions/impersonate-customer'
import { SendPortalLinkDialog } from '@/features/customer-portal/SendPortalLinkDialog'
import { CustomerWatchSection } from '@/features/customers/components/customer-watch-section'
import { Send } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { canManageMoney } from '@/lib/permissions'

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

export default function CustomerDetailComponent() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const customerId = params.customerId as string
  // Cosmetic hide only: the portal actions gate on assertPortalManager
  // (owner/admin/finance), which this mirrors.
  const { organization } = useCurrentOrganization()
  const canManagePortal = canManageMoney(organization?.role)

  // Use the useCustomer hook to fetch customer details
  const {
    data: customerData,
    isLoading: isCustomerLoading,
    error: customerError,
  } = useCustomer(customerId)

  const [subscriptionAnalytics, setSubscriptionAnalytics] = useState<
    SubscriptionAnalyticsResponse[]
  >([])
  const [allSubscriptions, setAllSubscriptions] = useState<any[]>([])
  // Credit-pool balances for this customer, keyed by subscription.
  // Absent for a subscription whose plan sells no pool — that row shows a dash,
  // never a zero, because a plan without a pool has no pool number.
  const [creditPools, setCreditPools] = useState<
    Map<string, CreditPoolBalanceView>
  >(new Map())
  const [activeSubscriptionId, setActiveSubscriptionId] = useState<
    string | null
  >(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [displayType, setDisplayType] = useState<
    'metrics' | 'cost' | 'revenue' | 'costVsRevenue'
  >('metrics')
  const [chartView, setChartView] = useState<'periodic' | 'cumulative'>(
    'periodic'
  )
  const [chartType, setChartType] = useState<'bar' | 'area'>('bar')

  // MRR/ARR state. Loading is derived from `mrrArrData === null`: the tiles
  // are deterministic, so null can only mean "still loading".
  const [mrrArrData, setMrrArrData] = useState<CustomerMrrArrResponse | null>(
    null
  )
  const [showMrrBreakdown, setShowMrrBreakdown] = useState(false)

  // Canonical metrics state (revenue/cost/margin per canon R1+R2+C1).
  // Drives the KPI tiles, the Selected-Sub KPIs, and the all-subs table.
  // SubscriptionAnalytics supplies dailyBreakdown + signalSummary, which
  // have no canonical equivalent.
  const [canonicalMetrics, setCanonicalMetrics] =
    useState<CanonicalCustomerMetricsResponse | null>(null)
  const [customerShare, setCustomerShare] =
    useState<CustomerShareOfRevenueResponse | null>(null)
  const [customerCostShare, setCustomerCostShare] =
    useState<CustomerShareOfCostResponse | null>(null)
  const [shareMode, setShareMode] = useState<'revenue' | 'cost'>('revenue')
  // Window scope for the KPI tiles. "last30" matches canon and /home;
  // "allTime" answers the "how big is this customer overall" question
  // that detail pages are built for. Customer Share of Revenue is
  // intentionally unaffected — it's all-time by design.
  const [kpiWindow, setKpiWindow] = useState<'last30' | 'allTime'>('last30')

  // Impersonation state
  const [isImpersonating, setIsImpersonating] = useState(false)
  // Portal link modal state
  const [portalLinkDialogOpen, setPortalLinkDialogOpen] = useState(false)

  // Fetch MRR/ARR data
  useEffect(() => {
    if (!customerId) return
    const fetchMrrArr = async () => {
      try {
        const result = await getCustomerMrrArr(customerId)
        if (result.success && result.data) {
          setMrrArrData(result.data)
        }
      } catch (err) {
        console.error('Failed to fetch MRR/ARR:', err)
      }
    }

    fetchMrrArr()
  }, [customerId])

  // Fetch canonical metrics + customer share of revenue in parallel.
  // Canonical metrics re-fetch on kpiWindow change so toggling between
  // last-30 and all-time re-runs the action with the right window.
  // Customer share stays all-time by design and re-fetches only on
  // customerId change.
  useEffect(() => {
    if (!customerId) return
    let cancelled = false
    const metricsParams =
      kpiWindow === 'allTime'
        ? {
            startDate: new Date(Date.UTC(2020, 0, 1)).toISOString(),
            endDate: new Date().toISOString(),
          }
        : undefined
    Promise.all([
      getCanonicalCustomerMetrics(customerId, metricsParams),
      getCustomerShareOfRevenue(customerId),
      getCustomerShareOfCost(customerId),
    ]).then(([metricsResult, shareResult, costShareResult]) => {
      if (cancelled) return
      if (metricsResult.success && metricsResult.data) {
        setCanonicalMetrics(metricsResult.data)
      }
      if (shareResult.success && shareResult.data) {
        setCustomerShare(shareResult.data)
      }
      if (costShareResult.success && costShareResult.data) {
        setCustomerCostShare(costShareResult.data)
      }
    })
    return () => {
      cancelled = true
    }
  }, [customerId, kpiWindow])

  // Fetch subscriptions and their analytics, gated on the customer fetch
  // resolving successfully first, so a malformed or nonexistent customerId
  // doesn't log a second, redundant "Failed to fetch subscription details"
  // error. On a customer-fetch error this effect still flips `loading` false
  // (nothing else will) so the page can leave the loading skeleton and reach
  // the customerError empty state.
  useEffect(() => {
    if (!customerId || isCustomerLoading) return

    if (customerError) {
      setLoading(false)
      return
    }

    const fetchSubscriptionData = async () => {
      try {
        setLoading(true)
        setError(null)

        // Fetch customer's subscriptions using Server Action
        const subscriptionsResult = await getSubscriptionsAction({
          includeDetails: true,
          customerId: customerId,
        })

        if (!subscriptionsResult.success || !subscriptionsResult.data) {
          throw new Error(
            subscriptionsResult.error || 'Failed to fetch subscriptions'
          )
        }

        const subscriptions = subscriptionsResult.data.results

        // Pool balances ride the same shared canon the Money tab and the API
        // read, so this column and GET /v1/credit-balances can't disagree.
        const poolResult = await getCreditBalancesAction({ customerId })
        if (poolResult.success) {
          setCreditPools(
            new Map(poolResult.data.balances.map((b) => [b.subscriptionId, b]))
          )
        }

        if (subscriptions.length === 0) {
          setLoading(false)
          return
        }

        // Store all subscriptions (cast to expected type)
        setAllSubscriptions(subscriptions as any[])

        // Filter for only active subscriptions for analytics
        const activeSubscriptions = subscriptions.filter(
          (sub) => sub.status.toLowerCase() === 'active'
        )

        // Fetch analytics for active subscriptions only using Server Action
        const analyticsPromises = activeSubscriptions.map(async (sub) => {
          const result = await getSubscriptionAnalyticsAction(sub.id)
          if (result.success && result.data) {
            return result.data
          }
          return null
        })

        const analyticsResults = await Promise.all(analyticsPromises)
        setSubscriptionAnalytics(analyticsResults.filter(Boolean) as any[])

        // Set the first active subscription as default, or first subscription if none are active
        setActiveSubscriptionId(
          activeSubscriptions.length > 0
            ? activeSubscriptions[0].id
            : subscriptions[0].id
        )
      } catch (err) {
        console.error('Failed to fetch subscription details:', err)
        setError('Failed to load subscription details. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchSubscriptionData()
  }, [customerId, isCustomerLoading, customerError])

  // Get currently selected subscription analytics
  const getActiveSubscriptionAnalytics = () => {
    if (!activeSubscriptionId || subscriptionAnalytics.length === 0) return null
    return (
      subscriptionAnalytics.find(
        (analytics) => analytics.subscription.id === activeSubscriptionId
      ) || null
    )
  }

  const activeSubscription = getActiveSubscriptionAnalytics()
  const _hasSingleSubscription = allSubscriptions.length === 1
  const hasActiveSubscriptions =
    allSubscriptions.filter((sub) => sub.status.toLowerCase() === 'active')
      .length > 0

  // Check if there's only one active/pending subscription or only one subscription total
  const hasMultipleActiveSubscriptions =
    allSubscriptions.filter((sub) =>
      ['active', 'pending'].includes(sub.status.toLowerCase())
    ).length > 1

  // Process chart data from daily breakdown
  const prepareChartData = () => {
    if (!activeSubscription || !activeSubscription.dailyBreakdown) return []

    // Special handling for costVsRevenue display type
    if (displayType === 'costVsRevenue') {
      // Group by date and calculate cost/revenue
      const costRevenueByDate = activeSubscription.dailyBreakdown.reduce(
        (acc, item) => {
          const date = item.date.split('T')[0]
          if (!acc[date]) {
            acc[date] = {
              date,
              dailyCost: 0,
              dailyRevenue: 0,
            }
          }

          // Include all revenue sources, not just signal-specific
          acc[date].dailyCost += item.cost || 0
          acc[date].dailyRevenue += item.revenue || 0

          return acc
        },
        {} as Record<string, any>
      )

      // Convert to array and sort by date
      const sortedData = Object.values(costRevenueByDate).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      )

      // Calculate cumulative totals
      let cumulativeCost = 0
      let cumulativeRevenue = 0

      return sortedData.map((day: any) => {
        cumulativeCost += day.dailyCost
        cumulativeRevenue += day.dailyRevenue

        return {
          date: day.date,
          totalCost: cumulativeCost,
          totalRevenue: cumulativeRevenue,
        }
      })
    }

    // Group by date for other display types
    const groupedByDate = activeSubscription.dailyBreakdown.reduce(
      (acc, item) => {
        const date = item.date.split('T')[0]
        if (!acc[date]) {
          acc[date] = {}
        }

        // Use signal name as key
        const signalKey = item.signalName.replace(/\s+/g, '')

        // Set the appropriate value based on display type
        if (displayType === 'metrics') {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.quantity
        } else if (displayType === 'cost') {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.cost
        } else {
          acc[date][signalKey] = (acc[date][signalKey] || 0) + item.revenue
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
      const signals = (activeSubscription.signalSummary || []).map((s) =>
        s.signalName.replace(/\s+/g, '')
      )

      const runningTotals: Record<string, number> = {}
      let cumulativeCost = 0
      let cumulativeRevenue = 0

      return chartData.map((dayData: any) => {
        const cumulativeData = { ...dayData }

        // Calculate signal-specific running totals
        signals.forEach((signal) => {
          if (dayData[signal]) {
            runningTotals[signal] =
              (runningTotals[signal] || 0) + dayData[signal]
            cumulativeData[signal] = runningTotals[signal]
          }
        })

        // Add cost vs revenue running totals for the cost/revenue view
        if (displayType === 'cost') {
          let dailyCost = 0
          let dailyRevenue = 0

          // Calculate daily cost and revenue from signal data, including all revenue sources
          activeSubscription.dailyBreakdown
            .filter((item) => item.date.split('T')[0] === dayData.date)
            .forEach((item) => {
              dailyCost += item.cost || 0
              dailyRevenue += item.revenue || 0
            })

          cumulativeCost += dailyCost
          cumulativeRevenue += dailyRevenue

          cumulativeData.totalCost = cumulativeCost
          cumulativeData.totalRevenue = cumulativeRevenue
        }

        return cumulativeData
      })
    }

    return chartData
  }

  const chartData = prepareChartData()

  // The ⓘ next to the usage toggles follows the active tab, so each view states
  // its own canon basis (units / cost / earned+fees revenue / margin).
  const activeTabTooltip =
    displayType === 'cost'
      ? tooltipDefinitions.totalCost
      : displayType === 'revenue'
        ? tooltipDefinitions.totalRevenue
        : displayType === 'costVsRevenue'
          ? tooltipDefinitions.costVsRevenueChart
          : tooltipDefinitions.units

  // Canonical totals drive the KPI tiles.
  // Null-safe: tiles render "—" for marginPercent while canon data loads,
  // and formatCurrency($0) reads naturally during the brief fetch window.
  const canonicalTotals = canonicalMetrics?.totals ?? {
    revenue: 0,
    cost: 0,
    margin: 0,
    marginPercent: null,
  }

  // Lookup table: subscriptionId to canonical per-sub numbers.
  // Selected-Sub KPIs and the all-subs table both read through this map.
  const canonicalBySubId = new Map(
    (canonicalMetrics?.bySubscription ?? []).map((s) => [s.subscriptionId, s])
  )

  const getStatusBadgeColors = (status: string) => {
    switch (status?.toLowerCase() || '') {
      case 'active':
        return 'bg-secondary/10 text-secondary-dark border-secondary/20 hover:bg-secondary/15'
      case 'canceled':
        return 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15'
      case 'expired':
        return 'bg-muted text-muted-foreground border-border hover:bg-muted'
      case 'pending':
        return 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
      default:
        return 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/15'
    }
  }

  // Handle chart type change
  const handleChartTypeChange = (value: string) => {
    setChartType(value as 'area' | 'bar')
  }

  // Handle subscription change
  const _handleSubscriptionChange = (subscriptionId: string) => {
    setActiveSubscriptionId(subscriptionId)
  }

  // Handle edit customer
  const _handleEditCustomer = () => {
    router.push(`/customers/edit/${customerId}`)
  }

  // Handle view as customer (impersonation)
  const handleViewAsCustomer = async () => {
    if (!customerData) return

    setIsImpersonating(true)
    try {
      const result = await impersonateCustomer(customerId)

      if (result.success && result.data) {
        // /r/<prtl_> redeemer handles cookie + redirect; URL already complete from Server Action.
        window.open(result.data.portalUrl, '_blank')
        toast({
          variant: 'success',
          title: 'Portal opened',
          description: `Viewing portal as ${result.data.customerName}`,
        })
      } else {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: result.error || 'Failed to impersonate customer',
        })
      }
    } catch (error) {
      console.error('Impersonation error:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'An error occurred while setting up impersonation',
      })
    } finally {
      setIsImpersonating(false)
    }
  }

  if (isCustomerLoading || loading) {
    return (
      <Page
        title='Loading...'
        headerProps={{
          breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Customer' }],
        }}
      >
        <DetailPageSkeleton statCards={4} showChart />
      </Page>
    )
  }

  if (customerError || error) {
    return (
      <div className='container mx-auto p-4'>
        <div className='mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive'>
          <p className='text-sm font-medium'>
            {customerError instanceof Error
              ? customerError.message
              : error || 'An error occurred'}
          </p>
        </div>
        <Button onClick={() => router.push('/customers')} variant='outline'>
          Back to Customers
        </Button>
      </div>
    )
  }

  if (!customerData) {
    return (
      <div className='container mx-auto p-4'>
        <div className='mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400'>
          <p className='text-sm font-medium'>Customer not found.</p>
        </div>
        <Button onClick={() => router.push('/customers')} variant='outline'>
          Back to Customers
        </Button>
      </div>
    )
  }

  return (
    <Page
      title={customerData.name}
      headerProps={{
        breadcrumb: [{ name: 'Home', href: '/' }, { name: customerData.name }],
        actionButtons: canManagePortal ? (
          <div className='ml-auto flex items-center gap-2'>
            <Button
              variant='default'
              size='sm'
              onClick={() => setPortalLinkDialogOpen(true)}
            >
              <Send className='mr-2 h-4 w-4' />
              Send Portal Link
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={handleViewAsCustomer}
              disabled={isImpersonating}
            >
              {isImpersonating ? (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : (
                <Eye className='mr-2 h-4 w-4' />
              )}
              View as Customer
            </Button>
          </div>
        ) : undefined,
      }}
    >
      {/* The cost / canonical KPI data, Recent Invoices, and Customer
          Details render regardless of subscriptions, so a cost-only customer
          (one that incurs cost but has no subscription) still sees their
          cost-tracking data. Only the subscription-specific subtree
          (Subscription Analysis + All Subscriptions table) is gated on
          having subscriptions below. */}
      <>
        {/* Top KPI Summary Boxes. Numbers come from canonical revenue +
              cost (getCanonicalCustomerMetrics) — fetched by customerId
              alone, independent of any subscription's status, so this
              renders for every customer, including cost-only customers with
              zero subscriptions and cancelled-only customers (canon keeps a canceled
              subscription's history). The fourth tile is Customer Share of Revenue.
              The window toggle above the grid
              drives Revenue / Cost / Margin between last-30 and all-time;
              Customer Share stays all-time by design. */}
        <div className='mb-3 flex items-center gap-2'>
          <span className='text-xs font-medium text-muted-foreground'>
            Window:
          </span>
          <Button
            variant={kpiWindow === 'last30' ? 'default' : 'outline'}
            size='sm'
            className='h-7 rounded-md px-3 text-xs'
            onClick={() => setKpiWindow('last30')}
          >
            Last 30 days
          </Button>
          <Button
            variant={kpiWindow === 'allTime' ? 'default' : 'outline'}
            size='sm'
            className='h-7 rounded-md px-3 text-xs'
            onClick={() => setKpiWindow('allTime')}
          >
            All-time
          </Button>
        </div>
        <div className='mb-6 grid grid-cols-2 gap-4 md:grid-cols-4'>
          <Card className='overflow-hidden'>
            <CardHeader className='bg-muted/30 pb-2 pt-3'>
              <p className='flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Total Revenue
                <InfoTooltip {...tooltipDefinitions.totalRevenue} />
              </p>
            </CardHeader>
            <CardContent className='pt-3'>
              <p className='font-tabular text-2xl font-bold text-foreground'>
                {formatCurrency(canonicalTotals.revenue)}
              </p>
            </CardContent>
          </Card>

          <Card className='overflow-hidden'>
            <CardHeader className='bg-muted/30 pb-2 pt-3'>
              <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Total Cost
              </p>
            </CardHeader>
            <CardContent className='pt-3'>
              <p className='font-tabular text-2xl font-bold text-foreground'>
                {formatCurrency(canonicalTotals.cost)}
              </p>
            </CardContent>
          </Card>

          <Card className='overflow-hidden'>
            <CardHeader className='bg-muted/30 pb-2 pt-3'>
              <p className='flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Total Margin
                <InfoTooltip {...tooltipDefinitions.totalMargin} />
              </p>
            </CardHeader>
            <CardContent className='pt-3'>
              <p className='font-tabular text-2xl font-bold text-foreground'>
                {formatPct(canonicalTotals.marginPercent)}
              </p>
            </CardContent>
          </Card>

          <Card className='overflow-hidden'>
            <CardHeader className='bg-muted/30 pb-2 pt-3'>
              <div className='flex items-center justify-between gap-2'>
                <p className='flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                  Customer Share
                  <InfoTooltip
                    {...(shareMode === 'revenue'
                      ? tooltipDefinitions.customerShareOfRevenue
                      : tooltipDefinitions.customerShareOfCost)}
                  />
                </p>
                <div
                  className='flex rounded-md border border-border bg-background p-0.5 text-[10px]'
                  role='tablist'
                  aria-label='Customer share mode'
                >
                  <button
                    type='button'
                    role='tab'
                    aria-selected={shareMode === 'revenue'}
                    onClick={() => setShareMode('revenue')}
                    className={`rounded-sm px-2 py-0.5 font-semibold uppercase tracking-wide transition-colors ${
                      shareMode === 'revenue'
                        ? 'bg-muted text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Revenue
                  </button>
                  <button
                    type='button'
                    role='tab'
                    aria-selected={shareMode === 'cost'}
                    onClick={() => setShareMode('cost')}
                    className={`rounded-sm px-2 py-0.5 font-semibold uppercase tracking-wide transition-colors ${
                      shareMode === 'cost'
                        ? 'bg-muted text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Cost
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent className='pt-3'>
              <p className='font-tabular text-2xl font-bold text-foreground'>
                {shareMode === 'revenue'
                  ? customerShare === null ||
                    customerShare.sharePercent === null
                    ? '—'
                    : `${customerShare.sharePercent.toFixed(1)}%`
                  : customerCostShare === null ||
                      customerCostShare.sharePercent === null
                    ? '—'
                    : `${customerCostShare.sharePercent.toFixed(1)}%`}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* MRR tiles (canon MRR1 + MRR2) + Revenue Type Split.
              MRR1 = contracted monthly recurring revenue today.
              MRR2 = 30-day run-rate (contract commitments + actual usage).
              Both are deterministic. */}
        <div className='mb-6 grid grid-cols-1 gap-4 md:grid-cols-3'>
          {/* MRR Card (canon MRR1) */}
          <Card className='overflow-hidden border-l-4 border-l-primary'>
            <CardHeader className='bg-primary/5 pb-2 pt-3'>
              <div className='flex items-center gap-1.5'>
                <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                  Monthly Recurring Revenue
                </p>
                <InfoTooltip {...tooltipDefinitions.mrrCanonical} />
              </div>
            </CardHeader>
            <CardContent className='pt-3'>
              {!mrrArrData ? (
                <div className='flex items-center gap-2'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                  <span className='text-sm text-muted-foreground'>
                    Calculating...
                  </span>
                </div>
              ) : (
                <div className='space-y-1'>
                  <div className='flex items-baseline gap-2'>
                    <p className='font-tabular text-2xl font-bold text-foreground'>
                      {formatCurrency(mrrArrData.mrr)}
                    </p>
                    <span className='text-sm text-muted-foreground'>/mo</span>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    ARR: {formatCurrency(mrrArrData.arr)}/yr
                  </p>
                  {mrrArrData.activeSubscriptionCount > 0 && (
                    <p className='text-xs text-muted-foreground'>
                      from {mrrArrData.activeSubscriptionCount} active
                      subscription
                      {mrrArrData.activeSubscriptionCount > 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Run-Rate MRR Card (canon MRR2) */}
          <Card className='overflow-hidden border-l-4 border-l-secondary'>
            <CardHeader className='bg-secondary/5 pb-2 pt-3'>
              <div className='flex items-center gap-1.5'>
                <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                  Run-Rate MRR
                </p>
                <InfoTooltip {...tooltipDefinitions.runRateMrr} />
              </div>
            </CardHeader>
            <CardContent className='pt-3'>
              {!mrrArrData ? (
                <div className='flex items-center gap-2'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                  <span className='text-sm text-muted-foreground'>
                    Calculating...
                  </span>
                </div>
              ) : (
                <div className='space-y-1'>
                  <div className='flex items-baseline gap-2'>
                    <p className='font-tabular text-2xl font-bold text-foreground'>
                      {formatCurrency(mrrArrData.runRateMrr)}
                    </p>
                    <span className='text-sm text-muted-foreground'>/mo</span>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    Run-Rate ARR: {formatCurrency(mrrArrData.runRateArr)}/yr
                  </p>
                  <p className='flex items-center gap-1 text-xs text-muted-foreground'>
                    <TrendingUp className='h-3 w-3' />
                    Based on last 30 days
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Revenue Type Split (Run-Rate MRR basis) */}
          <Card className='overflow-hidden'>
            <CardHeader className='bg-muted/30 pb-2 pt-3'>
              <div className='flex items-center gap-1.5'>
                <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                  Revenue Breakdown
                </p>
                <InfoTooltip
                  title='Revenue Breakdown'
                  description='How your Run-Rate MRR splits across recurring fees, seat-based pricing, and usage-based charges.'
                />
              </div>
            </CardHeader>
            <CardContent className='pt-3'>
              {!mrrArrData ? (
                <div className='flex items-center gap-2'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                  <span className='text-sm text-muted-foreground'>
                    Calculating...
                  </span>
                </div>
              ) : mrrArrData.runRateMrr > 0 ? (
                <div className='space-y-2'>
                  {mrrArrData.revenueTypeSplit.recurring > 0 && (
                    <div className='flex items-center justify-between text-sm'>
                      <span className='text-muted-foreground'>Recurring</span>
                      <div className='flex items-center gap-2'>
                        <span className='font-medium'>
                          {formatCurrency(
                            mrrArrData.revenueTypeSplit.recurring
                          )}
                        </span>
                        <span className='text-xs text-muted-foreground'>
                          (
                          {Math.round(
                            (mrrArrData.revenueTypeSplit.recurring /
                              mrrArrData.runRateMrr) *
                              100
                          )}
                          %)
                        </span>
                      </div>
                    </div>
                  )}
                  {mrrArrData.revenueTypeSplit.seatBased > 0 && (
                    <div className='flex items-center justify-between text-sm'>
                      <span className='text-muted-foreground'>Seat-based</span>
                      <div className='flex items-center gap-2'>
                        <span className='font-medium'>
                          {formatCurrency(
                            mrrArrData.revenueTypeSplit.seatBased
                          )}
                        </span>
                        <span className='text-xs text-muted-foreground'>
                          (
                          {Math.round(
                            (mrrArrData.revenueTypeSplit.seatBased /
                              mrrArrData.runRateMrr) *
                              100
                          )}
                          %)
                        </span>
                      </div>
                    </div>
                  )}
                  {mrrArrData.revenueTypeSplit.usage > 0 && (
                    <div className='flex items-center justify-between text-sm'>
                      <span className='text-muted-foreground'>Usage-based</span>
                      <div className='flex items-center gap-2'>
                        <span className='font-medium'>
                          {formatCurrency(mrrArrData.revenueTypeSplit.usage)}
                        </span>
                        <span className='text-xs text-muted-foreground'>
                          (
                          {Math.round(
                            (mrrArrData.revenueTypeSplit.usage /
                              mrrArrData.runRateMrr) *
                              100
                          )}
                          %)
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className='text-sm text-muted-foreground'>
                  No recurring revenue
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Run-Rate MRR breakdown by subscription. Per-sub contribution
              with aggregated recurring / seat-based / usage chips. */}
        {mrrArrData && mrrArrData.breakdown.length > 0 && (
          <Collapsible
            open={showMrrBreakdown}
            onOpenChange={setShowMrrBreakdown}
            className='mb-6'
          >
            <CollapsibleTrigger asChild>
              <Button
                variant='ghost'
                className='h-auto w-full justify-between px-3 py-2'
              >
                <span className='text-sm font-medium text-muted-foreground'>
                  View Run-Rate MRR breakdown by subscription
                </span>
                <ChevronLeft
                  className={`h-4 w-4 text-muted-foreground transition-transform ${
                    showMrrBreakdown ? '-rotate-90' : 'rotate-180'
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className='mt-2'>
              <Card>
                <CardContent className='p-4'>
                  <div className='space-y-4'>
                    {mrrArrData.breakdown.map((sub) => (
                      <div
                        key={sub.subscriptionId}
                        className='rounded-lg border p-3'
                      >
                        <div className='mb-2 flex items-center justify-between'>
                          <div>
                            <div className='flex items-center gap-2'>
                              <span className='font-medium'>
                                {sub.subscriptionName}
                              </span>
                              <Badge
                                variant='outline'
                                className={
                                  sub.status === 'active'
                                    ? 'border-secondary/20 bg-secondary/10 text-secondary-dark'
                                    : 'border-amber-200 bg-amber-50 text-amber-700'
                                }
                              >
                                {sub.status}
                              </Badge>
                            </div>
                            <p className='text-xs text-muted-foreground'>
                              Plan: {sub.planName} • {sub.billingCycle} billing
                            </p>
                          </div>
                          <div className='text-right'>
                            <p className='font-tabular font-bold'>
                              {formatCurrency(sub.total)}
                            </p>
                            <p className='text-xs text-muted-foreground'>
                              /month
                            </p>
                          </div>
                        </div>

                        {(sub.recurring > 0 ||
                          sub.seatBased > 0 ||
                          sub.usage > 0) && (
                          <div className='mt-2 flex flex-wrap gap-2 border-t pt-2 text-xs'>
                            {sub.recurring > 0 && (
                              <div className='rounded bg-muted px-2 py-1'>
                                Recurring: {formatCurrency(sub.recurring)}/mo
                              </div>
                            )}
                            {sub.seatBased > 0 && (
                              <div className='rounded bg-muted px-2 py-1'>
                                Seat-based: {formatCurrency(sub.seatBased)}/mo
                              </div>
                            )}
                            {sub.usage > 0 && (
                              <div className='rounded bg-muted px-2 py-1'>
                                Usage: {formatCurrency(sub.usage)}/mo
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Subscription-specific subtree (Subscription
              Analysis card + pills + All Subscriptions table) only renders
              when the customer actually has subscriptions. A cost-only
              customer sees a plain "No active subscriptions" empty state
              here instead — one section of the page, not the whole page. */}
        {allSubscriptions.length > 0 ? (
          <>
            {/* Main Subscription Analysis Card */}
            <Card className='mb-6 overflow-hidden'>
              <CardHeader className='border-b bg-muted/20 pb-4 pt-4'>
                <div className='flex items-center justify-between'>
                  <CardTitle>
                    {activeSubscription
                      ? `Subscription - ${activeSubscription.subscription.name}`
                      : 'Subscription Analysis'}
                  </CardTitle>
                </div>
              </CardHeader>

              <CardContent className='p-5'>
                {/* Subscription Pills - Only show if there are multiple active/pending subscriptions */}
                {hasMultipleActiveSubscriptions && (
                  <div className='mb-6 flex flex-wrap gap-2'>
                    {allSubscriptions
                      .filter((sub) =>
                        ['active', 'pending'].includes(sub.status.toLowerCase())
                      )
                      .slice(0, 5)
                      .map((sub) => (
                        <Button
                          key={sub.id}
                          variant={
                            activeSubscriptionId === sub.id
                              ? 'default'
                              : 'outline'
                          }
                          size='sm'
                          className={`h-8 rounded-full px-4 text-sm ${activeSubscriptionId === sub.id ? 'shadow-sm' : ''}`}
                          onClick={() => setActiveSubscriptionId(sub.id)}
                        >
                          {sub.name}
                        </Button>
                      ))}
                    {allSubscriptions.filter((sub) =>
                      ['active', 'pending'].includes(sub.status.toLowerCase())
                    ).length > 5 && (
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 rounded-full px-3 text-sm'
                      >
                        <Plus className='mr-1.5 h-3.5 w-3.5' />
                        {allSubscriptions.filter((sub) =>
                          ['active', 'pending'].includes(
                            sub.status.toLowerCase()
                          )
                        ).length - 5}{' '}
                        more
                      </Button>
                    )}
                  </div>
                )}

                {/* Current Subscription Details */}
                {activeSubscription && (
                  <div className='mb-6 rounded-lg bg-muted/20 p-4'>
                    <div className='grid grid-cols-1 gap-4 text-sm md:grid-cols-4'>
                      <div>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Plan
                        </div>
                        <div className='font-medium'>
                          {activeSubscription.plan?.name || 'No plan'}
                        </div>
                      </div>
                      <div>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Agent
                        </div>
                        <div className='font-medium'>
                          {activeSubscription.agent.name}
                        </div>
                      </div>
                      <div>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Billing Cycle
                        </div>
                        <div className='font-medium capitalize'>
                          {activeSubscription.subscription.billingCycle ||
                            'Monthly'}
                        </div>
                      </div>
                      <div>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Subscription Duration
                        </div>
                        <div className='font-medium'>
                          {activeSubscription.subscription.startDate
                            ? formatDisplayDate(
                                activeSubscription.subscription.startDate,
                                'dd MMM yyyy'
                              )
                            : 'N/A'}
                          {' → '}
                          {activeSubscription.subscription.endDate
                            ? formatDisplayDate(
                                activeSubscription.subscription.endDate,
                                'dd MMM yyyy'
                              )
                            : '∞'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Selected Subscription KPIs. Numbers source from canonical
                  per-sub metrics via canonicalBySubId. The two margin tiles
                  are labeled "Total Margin" (%) and "Margin $" so they can't
                  be confused. */}
                {activeSubscription && hasMultipleActiveSubscriptions && (
                  <div className='mb-6 grid grid-cols-2 gap-4 md:grid-cols-4'>
                    <Card className='overflow-hidden border border-muted'>
                      <CardContent className='p-3'>
                        <div className='mb-1 flex items-center gap-1 text-xs text-muted-foreground'>
                          Revenue
                          <InfoTooltip
                            {...tooltipDefinitions.totalRevenue}
                            iconSize='h-3 w-3'
                          />
                        </div>
                        <div className='text-xl font-bold'>
                          {formatCurrency(
                            canonicalBySubId.get(activeSubscriptionId ?? '')
                              ?.revenue ?? 0
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card className='overflow-hidden border border-muted'>
                      <CardContent className='p-3'>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Cost
                        </div>
                        <div className='text-xl font-bold'>
                          {formatCurrency(
                            canonicalBySubId.get(activeSubscriptionId ?? '')
                              ?.cost ?? 0
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card className='overflow-hidden border border-muted'>
                      <CardContent className='p-3'>
                        <div className='mb-1 flex items-center gap-1 text-xs text-muted-foreground'>
                          Total Margin
                          <InfoTooltip
                            {...tooltipDefinitions.totalMargin}
                            iconSize='h-3 w-3'
                          />
                        </div>
                        <div className='text-xl font-bold'>
                          {(() => {
                            const pct = canonicalBySubId.get(
                              activeSubscriptionId ?? ''
                            )?.marginPercent
                            return pct === null || pct === undefined
                              ? '—'
                              : `${pct.toFixed(0)}%`
                          })()}
                        </div>
                      </CardContent>
                    </Card>

                    <Card className='overflow-hidden border border-muted'>
                      <CardContent className='p-3'>
                        <div className='mb-1 text-xs text-muted-foreground'>
                          Margin $
                        </div>
                        <div className='text-xl font-bold'>
                          {formatCurrency(
                            canonicalBySubId.get(activeSubscriptionId ?? '')
                              ?.margin ?? 0
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {hasActiveSubscriptions &&
                  activeSubscription &&
                  activeSubscription.dailyBreakdown &&
                  activeSubscription.signalSummary &&
                  activeSubscription.signalSummary.length > 0 && (
                    <>
                      {/* Chart Controls */}
                      <div className='mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/10 p-3'>
                        <div className='flex items-center gap-1 text-sm font-medium'>
                          Usage Data
                          <InfoTooltip
                            {...activeTabTooltip}
                            iconSize='h-3 w-3'
                          />
                        </div>
                        <div className='flex flex-wrap items-center gap-2'>
                          <div className='flex items-center gap-1 rounded-md bg-background p-1'>
                            <Button
                              variant={
                                displayType === 'metrics' ? 'default' : 'ghost'
                              }
                              size='sm'
                              className='h-8 rounded-md px-3 text-xs'
                              onClick={() => setDisplayType('metrics')}
                            >
                              Metrics
                            </Button>
                            <Button
                              variant={
                                displayType === 'cost' ? 'default' : 'ghost'
                              }
                              size='sm'
                              className='h-8 rounded-md px-3 text-xs'
                              onClick={() => setDisplayType('cost')}
                            >
                              Cost
                            </Button>
                            <Button
                              variant={
                                displayType === 'revenue' ? 'default' : 'ghost'
                              }
                              size='sm'
                              className='h-8 rounded-md px-3 text-xs'
                              onClick={() => setDisplayType('revenue')}
                            >
                              Revenue
                            </Button>
                            <Button
                              variant={
                                displayType === 'costVsRevenue'
                                  ? 'default'
                                  : 'ghost'
                              }
                              size='sm'
                              className='h-8 rounded-md px-3 text-xs'
                              onClick={() => {
                                setDisplayType('costVsRevenue')
                                setChartView('cumulative')
                                setChartType('area')
                              }}
                            >
                              Cost vs Revenue
                            </Button>
                          </div>

                          <div className='flex items-center gap-2 border-l pl-4'>
                            <Select
                              value={chartView}
                              onValueChange={(value) =>
                                setChartView(value as 'periodic' | 'cumulative')
                              }
                            >
                              <SelectTrigger className='h-8 w-32 text-xs'>
                                <SelectValue placeholder='Display' />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value='periodic'>
                                  Periodic
                                </SelectItem>
                                <SelectItem value='cumulative'>
                                  Cumulative
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <Select
                              value={chartType}
                              onValueChange={handleChartTypeChange}
                            >
                              <SelectTrigger className='h-8 w-28 text-xs'>
                                <SelectValue placeholder='Chart Type' />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value='bar'>Bar Chart</SelectItem>
                                <SelectItem value='area'>Area Chart</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>

                      {/* Usage Chart */}
                      <div className='h-[400px] w-full rounded-lg border border-muted bg-card p-2'>
                        <ResponsiveContainer width='100%' height='100%'>
                          {chartType === 'area' ? (
                            displayType === 'costVsRevenue' ||
                            (displayType === 'cost' &&
                              chartView === 'cumulative') ? (
                              // Cost vs Revenue Area Chart
                              <AreaChart
                                data={chartData}
                                margin={{
                                  top: 15,
                                  right: 20,
                                  left: 5,
                                  bottom: 35,
                                }}
                              >
                                <CartesianGrid
                                  strokeDasharray='3 3'
                                  stroke='#f0f0f0'
                                />
                                <XAxis
                                  dataKey='date'
                                  angle={-45}
                                  textAnchor='end'
                                  height={60}
                                  tick={{ fontSize: 11 }}
                                />
                                <YAxis
                                  tickFormatter={(value) =>
                                    formatCurrency(value)
                                  }
                                />
                                <Tooltip
                                  formatter={(value, name) => [
                                    formatCurrency(value as number),
                                    name,
                                  ]}
                                  contentStyle={{
                                    borderRadius: '6px',
                                    border: '1px solid #f0f0f0',
                                  }}
                                  content={({ active, payload, label }) => {
                                    if (active && payload && payload.length) {
                                      const costValue =
                                        (payload.find((p) => p.name === 'Cost')
                                          ?.value as number) || 0
                                      const revenueValue =
                                        (payload.find(
                                          (p) => p.name === 'Revenue'
                                        )?.value as number) || 0
                                      const margin = safeMarginPercent(
                                        revenueValue,
                                        revenueValue - costValue
                                      )

                                      return (
                                        <div className='rounded-md border bg-white p-3 shadow-md'>
                                          <p className='mb-1 font-medium'>
                                            {label}
                                          </p>
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
                                  top: 15,
                                  right: 20,
                                  left: 5,
                                  bottom: 35,
                                }}
                              >
                                <CartesianGrid
                                  strokeDasharray='3 3'
                                  stroke='#f0f0f0'
                                />
                                <XAxis
                                  dataKey='date'
                                  angle={-45}
                                  textAnchor='end'
                                  height={60}
                                  tick={{ fontSize: 11 }}
                                />
                                <YAxis
                                  tickFormatter={(value) =>
                                    displayType === 'metrics'
                                      ? value.toString()
                                      : formatCurrency(value)
                                  }
                                />
                                <Tooltip
                                  formatter={(value, name) => [
                                    displayType === 'metrics'
                                      ? value
                                      : formatCurrency(value as number),
                                    name,
                                  ]}
                                  contentStyle={{
                                    borderRadius: '6px',
                                    border: '1px solid #f0f0f0',
                                  }}
                                />
                                <Legend wrapperStyle={{ paddingTop: '10px' }} />
                                {activeSubscription.signalSummary.map(
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
                                        CHART_COLORS[
                                          index % CHART_COLORS.length
                                        ]
                                      }
                                      stroke={
                                        CHART_COLORS[
                                          index % CHART_COLORS.length
                                        ]
                                      }
                                      fillOpacity={0.6}
                                      strokeWidth={2}
                                    />
                                  )
                                )}
                              </AreaChart>
                            )
                          ) : (
                            <BarChart
                              data={chartData}
                              margin={{
                                top: 15,
                                right: 20,
                                left: 5,
                                bottom: 35,
                              }}
                            >
                              <CartesianGrid
                                strokeDasharray='3 3'
                                stroke='#f0f0f0'
                              />
                              <XAxis
                                dataKey='date'
                                angle={-45}
                                textAnchor='end'
                                height={60}
                                tick={{ fontSize: 11 }}
                              />
                              <YAxis
                                tickFormatter={(value) =>
                                  displayType === 'metrics'
                                    ? value.toString()
                                    : formatCurrency(value)
                                }
                              />
                              <Tooltip
                                formatter={(value, name) => [
                                  displayType === 'metrics'
                                    ? value
                                    : formatCurrency(value as number),
                                  name,
                                ]}
                                contentStyle={{
                                  borderRadius: '6px',
                                  border: '1px solid #f0f0f0',
                                }}
                              />
                              <Legend wrapperStyle={{ paddingTop: '10px' }} />
                              {activeSubscription.signalSummary.map(
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
                                    radius={[4, 4, 0, 0]}
                                  />
                                )
                              )}
                            </BarChart>
                          )}
                        </ResponsiveContainer>
                      </div>
                    </>
                  )}

                {hasActiveSubscriptions &&
                  activeSubscription &&
                  (!activeSubscription.dailyBreakdown ||
                    !activeSubscription.signalSummary ||
                    activeSubscription.signalSummary.length === 0) && (
                    <div className='flex h-32 items-center justify-center rounded-lg border bg-muted/10'>
                      <p className='text-center text-muted-foreground'>
                        No usage data available for this billing period.
                      </p>
                    </div>
                  )}

                {!hasActiveSubscriptions && activeSubscription && (
                  <div className='flex h-32 items-center justify-center rounded-lg border bg-muted/10'>
                    <p className='text-center text-muted-foreground'>
                      This subscription is not active. Usage data is only
                      available for active subscriptions.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* All Subscriptions Table */}
            <Card className='mb-6 overflow-hidden'>
              <CardHeader className='border-b bg-muted/20 pb-4 pt-4'>
                <CardTitle>All Subscriptions</CardTitle>
              </CardHeader>
              <CardContent className='p-0'>
                <div className='overflow-x-auto'>
                  <Table>
                    <TableHeader>
                      <TableRow className='bg-muted/10 transition-colors duration-200 hover:bg-muted/50'>
                        <TableHead>Name</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead className='text-right'>
                          <span className='inline-flex items-center gap-1'>
                            Credits left
                            <InfoTooltip
                              {...tooltipDefinitions.creditPoolRemaining}
                              iconSize='h-3 w-3'
                            />
                          </span>
                        </TableHead>
                        <TableHead>
                          <span className='inline-flex items-center gap-1'>
                            Revenue
                            <InfoTooltip
                              {...tooltipDefinitions.totalRevenue}
                              iconSize='h-3 w-3'
                            />
                          </span>
                        </TableHead>
                        <TableHead>Cost</TableHead>
                        <TableHead>
                          <span className='inline-flex items-center gap-1'>
                            Total Margin
                            <InfoTooltip
                              {...tooltipDefinitions.totalMargin}
                              iconSize='h-3 w-3'
                            />
                          </span>
                        </TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className='text-right'>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allSubscriptions.map((subscription, _index) => {
                        // Canonical per-sub metrics. Subs outside the 30-day
                        // canonical window (e.g., long-canceled ones) render
                        // em-dash for revenue/cost/margin rather than zero.
                        const canonical = canonicalBySubId.get(subscription.id)
                        return (
                          <TableRow
                            key={subscription.id}
                            className={
                              activeSubscriptionId === subscription.id
                                ? 'bg-muted/30'
                                : ''
                            }
                          >
                            <TableCell className='font-medium'>
                              {subscription.name}
                            </TableCell>
                            <TableCell>
                              {subscription.pricingPlan?.name || 'No plan'}
                            </TableCell>
                            <TableCell className='text-right'>
                              {(() => {
                                const pool = creditPools.get(subscription.id)
                                if (!pool) return '—'
                                // No billing period means the countdown has
                                // not started; a number here would read as a
                                // drained pool.
                                if (pool.noActivePeriod) {
                                  return (
                                    <span className='text-muted-foreground'>
                                      Not started
                                    </span>
                                  )
                                }
                                return (
                                  <span
                                    className={
                                      pool.remainingUnits <= 0
                                        ? 'font-medium text-destructive'
                                        : 'font-medium'
                                    }
                                  >
                                    {Math.round(
                                      pool.remainingUnits
                                    ).toLocaleString()}
                                  </span>
                                )
                              })()}
                            </TableCell>
                            <TableCell>
                              {canonical
                                ? formatCurrency(canonical.revenue)
                                : '—'}
                            </TableCell>
                            <TableCell>
                              {canonical ? formatCurrency(canonical.cost) : '—'}
                            </TableCell>
                            <TableCell>
                              {canonical
                                ? formatPct(canonical.marginPercent)
                                : '—'}
                            </TableCell>
                            <TableCell>
                              <Badge
                                className={getStatusBadgeColors(
                                  subscription.status
                                )}
                              >
                                {subscription.status}
                              </Badge>
                            </TableCell>
                            <TableCell className='text-right'>
                              <div className='flex justify-end space-x-2'>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={() =>
                                    router.push(
                                      `/subscriptions/${subscription.id}`
                                    )
                                  }
                                  title='View Subscription'
                                  className='h-8 w-8 p-0'
                                >
                                  <ExternalLink className='h-4 w-4' />
                                  <span className='sr-only'>View</span>
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          // Plain empty state for cost-only customers — no CTA,
          // no "coming soon". The rest of the page (cost KPIs, invoices,
          // details) still renders above and below this section.
          <div className='mb-6 rounded-lg border p-8 text-center'>
            <h4 className='mb-2'>No active subscriptions</h4>
          </div>
        )}

        {/* Recent Invoices */}
        <InvoicesTable
          customerId={customerId}
          limit={3}
          sortBy='invoiceDate'
          sortOrder='desc'
          includeDetails={true}
          title='Recent Invoices'
          className='mb-6'
        />

        {/* Customer Details Card */}
        <Card className='mb-6 overflow-hidden'>
          <CardHeader className='border-b bg-muted/20 pb-4 pt-4'>
            <CardTitle>Customer Details</CardTitle>
          </CardHeader>
          <CardContent className='p-5'>
            <div className='grid grid-cols-1 gap-5 md:grid-cols-2'>
              <div>
                <div className='mb-1 text-xs text-muted-foreground'>
                  Contact Information
                </div>
                <div className='space-y-2'>
                  <div className='font-medium'>{customerData.email}</div>
                  {customerData.phone && (
                    <div className='text-sm'>{customerData.phone}</div>
                  )}
                </div>
              </div>

              <div className='text-right'>
                <div className='mb-1 text-xs text-muted-foreground'>Status</div>
                <div>
                  <Badge
                    className={getStatusBadgeColors(customerData.status || '')}
                  >
                    {customerData.status || 'Unknown'}
                  </Badge>
                </div>
              </div>

              <div>
                <div className='mb-1 text-xs text-muted-foreground'>
                  Billing Address
                </div>
                <div className='space-y-1 text-sm'>
                  {customerData.addressLine1 ||
                  customerData.city ||
                  customerData.state ? (
                    <>
                      {customerData.addressLine1 && (
                        <div>{customerData.addressLine1}</div>
                      )}
                      {customerData.addressLine2 && (
                        <div>{customerData.addressLine2}</div>
                      )}
                      <div>
                        {customerData.city}
                        {customerData.state && `, ${customerData.state}`}
                        {customerData.zipCode && ` ${customerData.zipCode}`}
                      </div>
                      {customerData.country && (
                        <div>{customerData.country}</div>
                      )}
                    </>
                  ) : (
                    <div className='text-muted-foreground'>
                      No address provided
                    </div>
                  )}
                </div>
              </div>

              <div className='text-right'>
                <div className='mb-1 text-xs text-muted-foreground'>
                  Customer Information
                </div>
                <div className='space-y-1 text-sm'>
                  <div>
                    <span className='text-muted-foreground'>External ID: </span>
                    <span className='font-medium'>
                      {customerData.externalId || 'N/A'}
                    </span>
                  </div>
                  <div>
                    <span className='text-muted-foreground'>
                      Active Subscriptions:{' '}
                    </span>
                    <span className='font-medium'>
                      {
                        allSubscriptions.filter(
                          (sub) => sub.status.toLowerCase() === 'active'
                        ).length
                      }
                    </span>
                  </div>
                  {customerData.billingContactName && (
                    <div>
                      <span className='text-muted-foreground'>
                        Billing Contact:{' '}
                      </span>
                      <span className='font-medium'>
                        {customerData.billingContactName}
                      </span>
                      {customerData.billingContactEmail &&
                        ` (${customerData.billingContactEmail})`}
                    </div>
                  )}
                </div>
              </div>

              {customerData.metadata &&
                Object.keys(customerData.metadata).length > 0 && (
                  <div className='col-span-2'>
                    <div className='mb-1 text-xs text-muted-foreground'>
                      Additional Information
                    </div>
                    <div className='grid grid-cols-2 gap-2 rounded-md bg-muted/10 p-3 text-sm'>
                      {Object.entries(customerData.metadata).map(
                        ([key, value]) => (
                          <div key={key}>
                            <span className='text-muted-foreground'>
                              {key}:{' '}
                            </span>
                            <span>{value?.toString() || ''}</span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}
            </div>
          </CardContent>
        </Card>

        {/* Per-customer watch management. Fully typed component —
            only this mount lives on the @ts-nocheck page. Money-gated inside
            (renders nothing for non-money roles; the page stays open). */}
        <CustomerWatchSection customerId={customerId} />
      </>

      {customerData && canManagePortal && (
        <SendPortalLinkDialog
          customer={{
            id: customerData.id,
            name: customerData.name,
            email: customerData.email ?? null,
          }}
          open={portalLinkDialogOpen}
          onOpenChange={setPortalLinkDialogOpen}
        />
      )}
    </Page>
  )
}
