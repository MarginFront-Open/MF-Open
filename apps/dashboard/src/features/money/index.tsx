'use client'

/**
 * Money. The KPI
 * row (customizable via TileGrid) and the combined chart+donut+table section
 * (fixed chrome, outside the tile grid) share ONE resolveMetrics
 * call — the combined section's own DimensionedSection instance lifts its
 * response into this page's state via KpiRowBridge's effect, the same
 * pattern Overview uses for its chart+KPI row.
 *
 * Chart is cost-vs-revenue via a per-day `earned`/revenue field: that
 * plumbing lives entirely inside TimeseriesChart (multi-series) and
 * DimensionedSection/metrics-resolver.ts, none of which this page touches
 * directly. This file only sets chartTitle/chartTitleTooltip and opts the
 * chart into its metric picker (Cost / Revenue / Cost + Revenue / Tasks)
 * via showChartMetricPicker. The picker toggles which of THIS response's
 * already-fetched series render — never a second query.
 *
 * This landing view is the "Breakdown" tab, one of the tabs registered in
 * money-tabs.ts. Tab choice lives in
 * `?tab=` (absent = Breakdown) — same URL-state idiom DateRangeSelector uses
 * for `?startDate&endDate`, so switching tabs never disturbs the date range.
 */

import { Suspense, useCallback, useEffect, useReducer, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import { GettingStartedNudge } from '@/features/build/components/getting-started-nudge'
import { TileGrid } from '@/features/dashboard-shell/tile-grid'
import { DimensionedSection } from '@/features/dashboard-shell/dimensioned-section'
import { layoutReducer } from '@/features/dashboard-shell/layout-state'
import {
  DEFAULT_LAYOUTS,
  PAGE_DATE_RANGE,
} from '@/features/dashboard-shell/default-layouts'
import {
  selectionFromParams,
  selectionToPeriod,
} from '@/features/dashboard-shell/date-range'
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import {
  getDashboardLayout,
  saveDashboardLayout,
  resetDashboardLayout,
} from '@/app/actions/dashboard-layouts'
import { getFilters } from '@/app/actions/get-filters'
import { resolverTileValue } from '@/lib/component-catalog'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { getMismatchedSignalCount } from '@/app/actions/chart-of-accounts'
import { getNeedsCostBackfillGroups } from '@/app/actions/signal-events'
import { getExhaustedCreditPools } from '@/app/actions/credit-pools'
import { downloadBreakdownExport } from '@/features/dashboard-shell/command-center-shared'
import { CsvExportDialog } from './components/csv-export-dialog'
import { MoneyUsersTab } from './components/money-users-tab'
import { MoneyPlansTab } from './components/money-plans-tab'
import { MoneySubscriptionsTab } from './components/money-subscriptions-tab'
import { MoneyInvoicesTab } from './components/money-invoices-tab'
import { MoneySimulatorTab } from './components/money-simulator-tab'
import { MONEY_TABS, resolveMoneyTab } from './money-tabs'
import { KpiTile } from '@/features/dashboard-shell/tiles/kpi-tile'
import {
  AlertList,
  type AlertListItem,
} from '@/features/dashboard-shell/tiles/alert-list'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import type {
  DashboardLayoutTile,
  ResolvedTiles,
} from '@/features/dashboard-shell/types'
import { buildCostManagementHref } from './view-all-link'
// Reused, not duplicated: ADDABLE_COMPONENTS.money permits an alert-list
// tile too (a user can add one via the add panel), and the same two real
// counts Overview surfaces are equally relevant on the money page.
import {
  composeNeedsAttention,
  creditPoolItem,
} from '@/features/dashboard-shell/needs-attention'

const NEEDS_ATTENTION_ERROR =
  "Couldn't load the needs-attention list. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const PAGE = 'money' as const

// Lifts the combined section's fetched response into the page's own state
// via an effect (runs after commit), never during the section's own render.
function KpiRowBridge({
  tiles,
  state,
  onData,
}: {
  tiles: ResolvedTiles | null
  state: TileState
  onData: (tiles: ResolvedTiles | null, state: TileState) => void
}) {
  useEffect(() => {
    onData(tiles, state)
  }, [tiles, state, onData])
  return null
}

function MoneyInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = resolveMoneyTab(searchParams.get('tab'))
  const handleTabChange = useCallback(
    (tab: string) => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('tab', tab)
      router.replace(`${pathname}?${nextParams.toString()}`, {
        scroll: false,
      })
    },
    [searchParams, pathname, router]
  )
  const dateRangeConfig = PAGE_DATE_RANGE[PAGE]
  const selection = selectionFromParams(
    {
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
      range: searchParams.get('range') ?? undefined,
    },
    dateRangeConfig
  ) ?? { mode: 'month' as const, monthsAgo: 0 }
  const period = selectionToPeriod(selection)

  const [tiles, dispatch] = useReducer(layoutReducer, DEFAULT_LAYOUTS[PAGE])
  const [savedTiles, setSavedTiles] = useState<DashboardLayoutTile[]>(
    DEFAULT_LAYOUTS[PAGE]
  )

  useEffect(() => {
    let cancelled = false
    getDashboardLayout(PAGE).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        dispatch({ type: 'reset', defaults: result.data })
        setSavedTiles(result.data)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [kpiTiles, setKpiTiles] = useState<ResolvedTiles | null>(null)
  const [kpiState, setKpiState] = useState<TileState>('loading')
  const handleKpiData = useCallback(
    (next: ResolvedTiles | null, nextState: TileState) => {
      setKpiTiles(next)
      setKpiState(nextState)
    },
    []
  )

  // Customer/agent/plan/signal names for the combined section's breakdown
  // rows — BreakdownRow.key is a UUID for those four dimensions.
  const [labelMap, setLabelMap] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    getFilters().then((result) => {
      if (cancelled || !result.success || !result.data) return
      const map = new Map<string, string>()
      for (const c of result.data.customers) map.set(c.id, c.name)
      for (const a of result.data.agents) map.set(a.id, a.name)
      for (const p of result.data.pricingPlans) map.set(p.id, p.name)
      for (const s of result.data.signals) map.set(s.id, s.name)
      setLabelMap(map)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const resolveLabel = useCallback(
    (key: string | null) =>
      key === null ? 'Unassigned' : (labelMap.get(key) ?? key),
    [labelMap]
  )

  // ADDABLE_COMPONENTS.money permits an alert-list tile; only fetched
  // if the user actually adds one to their layout.
  const hasAlertListTile = tiles.some((tile) => tile.component === 'alert-list')
  const [alertItems, setAlertItems] = useState<AlertListItem[]>([])
  const [alertState, setAlertState] = useState<TileState>('loading')
  const [alertError, setAlertError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!hasAlertListTile) return
    let cancelled = false
    Promise.all([
      getMismatchedSignalCount(),
      getNeedsCostBackfillGroups(),
      getExhaustedCreditPools(),
    ]).then(([mismatched, backfill, creditPools]) => {
      if (cancelled) return
      if (mismatched.success && backfill.success && backfill.data) {
        // The credit-pool row is APPENDED, never folded into
        // composeNeedsAttention — that composer's output is byte-pinned by
        // its own test and shared with Overview.
        const items = composeNeedsAttention({
          mismatchedCount: mismatched.count,
          backfillModelCount: backfill.data.groups.length,
          backfillTotalEvents: backfill.data.totalEvents,
        })
        if (creditPools.success && creditPools.data.pools.length > 0) {
          items.push(creditPoolItem(creditPools.data.pools.length))
        }
        setAlertItems(items)
        setAlertState('ready')
      } else {
        setAlertError(NEEDS_ATTENTION_ERROR)
        setAlertState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [hasAlertListTile])

  const handleSaveLayout = useCallback(async () => {
    const result = await saveDashboardLayout(PAGE, tiles)
    if (result.success) setSavedTiles(tiles)
    return result
  }, [tiles])

  const handleCancelEdit = useCallback(() => {
    dispatch({ type: 'reset', defaults: savedTiles })
  }, [savedTiles])

  const handleResetLayout = useCallback(async () => {
    const result = await resetDashboardLayout(PAGE)
    if (result.success) {
      dispatch({ type: 'reset', defaults: DEFAULT_LAYOUTS[PAGE] })
      setSavedTiles(DEFAULT_LAYOUTS[PAGE])
    }
    return result
  }, [])

  // downloadBreakdownExport (command-center-shared.tsx) already translates
  // {startDate, endDate} Dates into the export route's real param names
  // (start/end — NOT startDate/endDate). parseWindowFilter
  // is the same pure helper resolveMetrics uses internally, so this window
  // matches the combined section's own window exactly without a second
  // resolveMetrics call.
  const handleExport = useCallback(() => {
    const { windowStart, windowEnd } = parseWindowFilter(period)
    void downloadBreakdownExport({ startDate: windowStart, endDate: windowEnd })
  }, [period])

  // "Custom CSV export…" — a second option
  // alongside the one-click XLSX above, never replacing it. The dialog stays
  // mounted at all times (only its `open` prop toggles) so a user's group-by/
  // timeframe/column picks survive closing and reopening it.
  const [csvDialogOpen, setCsvDialogOpen] = useState(false)

  const renderTile = useCallback(
    (tile: DashboardLayoutTile) => {
      switch (tile.component) {
        case 'kpi-tile': {
          if (!tile.metric) return null
          return (
            <KpiTile
              metric={tile.metric}
              value={kpiTiles ? resolverTileValue(kpiTiles, tile.metric) : null}
              state={kpiState}
            />
          )
        }
        case 'alert-list':
          return (
            <AlertList
              title='Needs attention'
              tooltipKey='needsAttention'
              items={alertItems}
              state={
                alertState === 'ready' && alertItems.length === 0
                  ? 'empty'
                  : alertState
              }
              errorMessage={alertError}
              emptyMessage='Nothing needs attention'
            />
          )
        default:
          return null
      }
    },
    [kpiTiles, kpiState, alertItems, alertState, alertError]
  )

  const viewAllHref = buildCostManagementHref(period)

  return (
    <PageShell
      page={PAGE}
      title='Unit Economics'
      dateRange={dateRangeConfig}
      headerExtras={
        // Export only applies to Breakdown; the other tabs have no export.
        activeTab === 'breakdown' ? (
          <DropdownMenu>
            <DropdownMenuTrigger className='flex h-7 items-center gap-1 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'>
              Export
              <ChevronDown className='h-3 w-3' />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuItem onSelect={handleExport}>
                Download spreadsheet (XLSX)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCsvDialogOpen(true)}>
                Custom CSV export…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
      onSaveLayout={handleSaveLayout}
      onCancelEdit={handleCancelEdit}
      onResetLayout={handleResetLayout}
    >
      {({ editing }) => (
        <>
          {/* Unit Economics (/money) is the default landing for finance/admin/
              owner roles, so a zero-event org needs the path to
              instrumentation here, not only on Build. Rendered bare (no
              wrapper) so a hidden nudge leaves no flex item behind —
              PageShell's gap-4 supplies the spacing. */}
          <GettingStartedNudge description='Nothing has landed yet. To see your AI spend here, connect from Getting Started: the SDK or REST API for product usage, or the coding-agent connector for Claude Code and Codex spend.' />
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              {MONEY_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value='breakdown' className='flex flex-col gap-4'>
              <TileGrid
                page={PAGE}
                tiles={tiles}
                editing={editing}
                onMove={(from, to) => dispatch({ type: 'move', from, to })}
                onRemove={(index) => dispatch({ type: 'remove', index })}
                onAdd={(component, config) =>
                  dispatch({ type: 'add', component, ...config })
                }
                renderTile={renderTile}
              />
              <div className='flex items-center justify-end'>
                <Link
                  href={viewAllHref}
                  className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'
                >
                  View all →
                </Link>
              </div>
              <DimensionedSection
                scope={PAGE}
                period={period}
                initialDimension='customer'
                title='Breakdown'
                chartTitle='Cost vs revenue'
                chartTitleTooltip={tooltipDefinitions.moneyCostVsRevenue}
                showChartMetricPicker
                resolveLabel={resolveLabel}
                renderKpiRow={(data, state) => (
                  <KpiRowBridge
                    tiles={data}
                    state={state}
                    onData={handleKpiData}
                  />
                )}
              />
              <CsvExportDialog
                open={csvDialogOpen}
                onOpenChange={setCsvDialogOpen}
                defaultPeriod={period}
              />
            </TabsContent>

            <TabsContent value='users'>
              <MoneyUsersTab />
            </TabsContent>

            <TabsContent value='plans'>
              <MoneyPlansTab />
            </TabsContent>

            <TabsContent value='subscriptions'>
              <MoneySubscriptionsTab />
            </TabsContent>

            <TabsContent value='invoices'>
              <MoneyInvoicesTab />
            </TabsContent>

            <TabsContent value='simulator'>
              <MoneySimulatorTab period={period} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </PageShell>
  )
}

export default function Money() {
  // useSearchParams needs a Suspense boundary during prerender (DateRangeSelector
  // wraps its own internal call; this page reads the same params independently
  // to compute `period`, so it needs its own boundary too).
  return (
    <Suspense fallback={null}>
      <MoneyInner />
    </Suspense>
  )
}
