'use client'

/**
 * Build: the agents surface. Two independent data paths, two failure
 * domains (same split as the FinOps page):
 *
 *   1. getBuildAgentsOverview (ONE composed canon read) feeds the
 *      agents area — table, drill-in detail, and the header subtitle. Its
 *      totals are echoed canon values, so Σ table rows ≡ the resolver's
 *      scope-build tiles by construction.
 *   2. The metrics resolver runs ONCE, inside a HEADLESS DimensionedSection
 *      (every chrome flag off: no donut and no
 *      breakdown table on Build, and two invariant
 *      tests pin resolveMetrics behind this one seam, so the mount stays as
 *      a pure data source). Its response is lifted into page state through
 *      KpiRowBridge, feeding the grid's KPI tiles and the add-panel-only
 *      trend chart from the SAME response — never a second call.
 *
 * The agents area is bespoke chrome ABOVE the customizable grid, so Build leads
 * with the agents table; it is the table + the event
 * stream, and drill-in replaces ONLY that area. Drill-in state lives in
 * `?agent=` so a detail view survives refresh and can be
 * deep-linked, same idiom as `?tab=`.
 *
 * All of the above lives inside an
 * "Agents" tab alongside "API keys" and "Simulator" (registry:
 * build-tabs.ts), mirroring the Money page's tab bar. Tab choice lives in
 * `?tab=` (absent = Agents), same idiom as Money and as this page's own
 * `?startDate&endDate`. API keys are org-level, so they get their own tab
 * with full CRUD in place (ApiKeysTab). Simulator
 * embeds the SDK Simulator feature (SdkSimulatorEmbedded)
 * as-is, with no second copy of its form or its real-event `recordSdkUsage`
 * wiring.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useReducer,
  useState,
  useTransition,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageShell } from '@/features/dashboard-shell/page-shell'
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
import {
  getDashboardLayout,
  saveDashboardLayout,
  resetDashboardLayout,
} from '@/app/actions/dashboard-layouts'
import {
  getBuildAgentsOverview,
  type BuildAgentsOverview,
} from '@/app/actions/build-agents-overview'
import { getNeedsCostBackfillGroups } from '@/app/actions/signal-events'
import { resolverTileValue } from '@/lib/component-catalog'
import { KpiTile } from '@/features/dashboard-shell/tiles/kpi-tile'
import {
  AlertList,
  type AlertListItem,
} from '@/features/dashboard-shell/tiles/alert-list'
import { TimeseriesChart } from '@/features/dashboard-shell/tiles/timeseries-chart'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import type {
  CostByDayRow,
  DashboardLayoutTile,
  ResolvedTiles,
} from '@/features/dashboard-shell/types'
// Build's alert tile renders the backfill item ALONE (the
// wrong-account-type item belongs to FinOps) — never composeNeedsAttention.
import { costBackfillItem } from '@/features/dashboard-shell/needs-attention'
import { SdkSimulatorEmbedded } from '@/features/developer-zone/sdk-simulator'
import { AgentsTable } from './components/agents-table'
import { AgentDetail } from './components/agent-detail'
import { EventStream } from './components/event-stream'
import { ApiKeysTab } from './components/api-keys-tab'
import { GettingStartedNudge } from './components/getting-started-nudge'
import { BUILD_TABS, resolveBuildTab } from './build-tabs'

const PAGE = 'build' as const

const OVERVIEW_ERROR =
  "Couldn't load the agents overview. The request failed before it reached the server. Check your connection and refresh to try again."

const NEEDS_ATTENTION_ERROR =
  "Couldn't load the needs-attention list. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

// Lifts the combined section's fetched response into the page's own state
// via an effect (runs after commit), never during the section's own render.
// `series` rides along so the add-panel trend chart renders from the same
// response.
function KpiRowBridge({
  tiles,
  series,
  state,
  onData,
}: {
  tiles: ResolvedTiles | null
  series: CostByDayRow[] | null
  state: TileState
  onData: (
    tiles: ResolvedTiles | null,
    series: CostByDayRow[] | null,
    state: TileState
  ) => void
}) {
  useEffect(() => {
    onData(tiles, series, state)
  }, [tiles, series, state, onData])
  return null
}

function BuildInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = resolveBuildTab(searchParams.get('tab'))
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
  ) ?? { mode: 'rolling' as const }
  const period = selectionToPeriod(selection)
  const { startDate, endDate } = period

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

  // ── Failure domain 1: the composed agents-overview read ─────────────────
  const [overview, setOverview] = useState<BuildAgentsOverview | null>(null)
  const [overviewState, setOverviewState] = useState<TileState>('loading')
  const [overviewError, setOverviewError] = useState<string | undefined>(
    undefined
  )
  // Bumped after any pause/resume/delete success so the table re-fetches —
  // the FinOps lock/unlock refresh pattern.
  const [refreshKey, setRefreshKey] = useState(0)
  const [, startOverviewFetch] = useTransition()

  useEffect(() => {
    let cancelled = false
    startOverviewFetch(async () => {
      setOverviewState('loading')
      try {
        const result = await getBuildAgentsOverview({ startDate, endDate })
        if (cancelled) return
        if (result.success && result.data) {
          setOverview(result.data)
          setOverviewState('ready')
          setOverviewError(undefined)
        } else {
          setOverviewState('error')
          setOverviewError(result.error ?? OVERVIEW_ERROR)
        }
      } catch {
        if (cancelled) return
        setOverviewState('error')
        setOverviewError(OVERVIEW_ERROR)
      }
    })
    return () => {
      cancelled = true
    }
  }, [startDate, endDate, refreshKey])

  const handleAgentsChanged = useCallback(() => {
    setRefreshKey((key) => key + 1)
  }, [])

  // Drill-in replaces ONLY the agents area and lives in `?agent=`
  // — push, not replace, so the browser's Back returns to the
  // table. A refresh that removes the drilled agent (e.g. its deletion)
  // falls back to the table.
  const drilledAgentId = searchParams.get('agent')
  const drilledRow = drilledAgentId
    ? overview?.rows.find((row) => row.agentId === drilledAgentId)
    : undefined
  const handleDrillIn = useCallback(
    (agentId: string) => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('agent', agentId)
      router.push(`${pathname}?${nextParams.toString()}`, { scroll: false })
    },
    [searchParams, pathname, router]
  )
  const handleDrillOut = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('agent')
    router.push(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // ── Failure domain 2: the resolver response, bridged from the section ───
  const [kpiTiles, setKpiTiles] = useState<ResolvedTiles | null>(null)
  const [kpiSeries, setKpiSeries] = useState<CostByDayRow[] | null>(null)
  const [kpiState, setKpiState] = useState<TileState>('loading')
  const handleKpiData = useCallback(
    (
      nextTiles: ResolvedTiles | null,
      nextSeries: CostByDayRow[] | null,
      nextState: TileState
    ) => {
      setKpiTiles(nextTiles)
      setKpiSeries(nextSeries)
      setKpiState(nextState)
    },
    []
  )

  // Only fetched if the layout actually shows an alert tile (Money's lazy
  // pattern) — and Build fetches ONLY the backfill count.
  const hasAlertListTile = tiles.some((tile) => tile.component === 'alert-list')
  const [alertItems, setAlertItems] = useState<AlertListItem[]>([])
  const [alertState, setAlertState] = useState<TileState>('loading')
  const [alertError, setAlertError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!hasAlertListTile) return
    let cancelled = false
    getNeedsCostBackfillGroups().then((backfill) => {
      if (cancelled) return
      if (backfill.success && backfill.data) {
        setAlertItems(
          backfill.data.groups.length > 0
            ? [
                costBackfillItem(
                  backfill.data.groups.length,
                  backfill.data.totalEvents
                ),
              ]
            : []
        )
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
        // Add-panel only — NEVER in the default layout. Renders from the
        // bridged response's day-grain series: no second data path.
        case 'timeseries-chart': {
          const points = kpiSeries ?? []
          return (
            <TimeseriesChart
              title='Cost over time'
              series={[{ label: 'Cost', points }]}
              valueFormat='cost'
              state={
                kpiState === 'ready' && points.length === 0 ? 'empty' : kpiState
              }
            />
          )
        }
        default:
          return null
      }
    },
    [kpiTiles, kpiState, alertItems, alertState, alertError, kpiSeries]
  )

  const subtitle = overview
    ? `${overview.agentCount} agents · ${overview.pausedCount} paused`
    : undefined

  return (
    <PageShell
      page={PAGE}
      title='Build'
      subtitle={subtitle}
      dateRange={dateRangeConfig}
      onSaveLayout={handleSaveLayout}
      onCancelEdit={handleCancelEdit}
      onResetLayout={handleResetLayout}
    >
      {({ editing }) => (
        <>
          <GettingStartedNudge />
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              {BUILD_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value='agents' className='flex flex-col gap-4'>
              {drilledRow && drilledAgentId ? (
                <AgentDetail
                  agentId={drilledAgentId}
                  row={drilledRow}
                  period={period}
                  onBack={handleDrillOut}
                  onChanged={handleAgentsChanged}
                />
              ) : (
                <>
                  <AgentsTable
                    rows={overview?.rows ?? null}
                    agentCount={overview?.agentCount ?? null}
                    pausedCount={overview?.pausedCount ?? null}
                    state={overviewState}
                    errorMessage={overviewError}
                    onDrillIn={handleDrillIn}
                    onChanged={handleAgentsChanged}
                  />
                  <EventStream period={period} />
                </>
              )}
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
              {/* HEADLESS resolver mount: the donut +
                  breakdown table are off on Build, but the KPI tiles
                  and add-panel chart still ride this section's ONE
                  resolveMetrics call via the bridge — shell-safety.test.ts
                  and this page's single-data-path test both pin the resolver
                  behind this seam. With every chrome flag off it renders
                  nothing visible. */}
              <DimensionedSection
                scope={PAGE}
                period={period}
                initialDimension='model'
                showChart={false}
                showDonut={false}
                showTable={false}
                showDimensionPicker={false}
                renderKpiRow={(data, state, series) => (
                  <KpiRowBridge
                    tiles={data}
                    series={series ?? null}
                    state={state}
                    onData={handleKpiData}
                  />
                )}
              />
            </TabsContent>

            <TabsContent value='keys'>
              <ApiKeysTab />
            </TabsContent>

            <TabsContent value='simulator'>
              <SdkSimulatorEmbedded />
            </TabsContent>
          </Tabs>
        </>
      )}
    </PageShell>
  )
}

export default function Build() {
  // useSearchParams needs a Suspense boundary during prerender (DateRangeSelector
  // wraps its own internal call; this page reads the same params independently
  // to compute `period`, so it needs its own boundary too).
  return (
    <Suspense fallback={null}>
      <BuildInner />
    </Suspense>
  )
}
