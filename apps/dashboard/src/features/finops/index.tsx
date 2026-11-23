'use client'

/**
 * FinOps: the month-end close surface.
 *
 * Two independent data paths, two failure domains:
 *   1. getFinopsCloseStatus (ONE composed close-engine read) feeds the
 *      checklist, alert list, the 4 close KPI tiles, the locked banner, the
 *      close controls, and the journal preview — via the pure
 *      deriveCloseStatus.
 *   2. The metrics resolver runs ONCE, inside the fixed DimensionedSection
 *      (donut + breakdown table on Category, NO default chart — showChart
 *      false). Its response is lifted into page state through KpiRowBridge,
 *      feeding any resolver-backed KPI tiles and the add-panel-only trend
 *      chart from the SAME response — never a second call.
 *
 * The GL-mapping table and journal preview are bespoke sections below the
 * customizable grid, like Money's combined section (fixed chrome, not
 * layout rows).
 *
 * All of the above lives inside a "Close" tab alongside "Cost management"
 * and "Settings" (registry: finops-tabs.ts), mirroring Money's and Build's
 * tab bars. Tab choice lives in `?tab=` (absent = Close). The other two tabs
 * embed the cost-management and finops-settings features. The page's
 * month-locked header selector is the ONE window for all three tabs; the
 * KPI band + grid stay on the Close tab only.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  useTransition,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { format } from 'date-fns'
import { Lock, Settings2 } from 'lucide-react'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import { TileGrid } from '@/features/dashboard-shell/tile-grid'
import { DimensionedSection } from '@/features/dashboard-shell/dimensioned-section'
import { layoutReducer } from '@/features/dashboard-shell/layout-state'
import {
  DEFAULT_LAYOUTS,
  PAGE_DATE_RANGE,
} from '@/features/dashboard-shell/default-layouts'
import { selectionFromParams } from '@/features/dashboard-shell/date-range'
// Month bounds + label come from the ONE shared helper, exactly
// like month-end-close — the two pages can never drift to different windows.
import { monthPeriod } from '@/features/_shared/billing-period'
import {
  getDashboardLayout,
  saveDashboardLayout,
  resetDashboardLayout,
} from '@/app/actions/dashboard-layouts'
import { getFilters } from '@/app/actions/get-filters'
import {
  getFinopsCloseStatus,
  type CloseStatusFacts,
} from '@/app/actions/finops-close-status'
import {
  getSignalsForClassification,
  type SignalClassificationRow,
} from '@/app/actions/signal-classification'
import { deriveCloseStatus } from './close-derivation'
import { isCloseTileMetric, resolverTileValue } from '@/lib/component-catalog'
import {
  COST_CATEGORY_LABELS,
  type CostCategoryKey,
} from '@/features/cost-management/classification-utils'
import { KpiTile } from '@/features/dashboard-shell/tiles/kpi-tile'
import { Checklist } from '@/features/dashboard-shell/tiles/checklist'
import { AlertList } from '@/features/dashboard-shell/tiles/alert-list'
import { TimeseriesChart } from '@/features/dashboard-shell/tiles/timeseries-chart'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import type {
  CostByDayRow,
  DashboardLayoutTile,
  ResolvedTiles,
} from '@/features/dashboard-shell/types'
import CostManagement from '@/features/cost-management'
import FinopsSettings from '@/features/finops-settings'
import { CloseControls } from './components/close-controls'
import { GlMappingTable } from './components/gl-mapping-table'
import { JournalPreview } from './components/journal-preview'
import { FINOPS_TABS, resolveFinopsTab } from './finops-tabs'

const PAGE = 'finops' as const

const CLOSE_STATUS_ERROR =
  "Couldn't load the close status for this month. The request failed before it reached the server. Check your connection and refresh to try again."

const GL_TABLE_ERROR =
  "Couldn't load the signal list for the GL-mapping table. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

// Pure navigation to the finops-settings rule/GL-code
// editors — no new mutation logic here. Same button chrome as CloseControls'
// BUTTON_CLASS so the header reads as one row of "act on this page" buttons.
const HEADER_LINK_CLASS =
  'flex h-7 items-center gap-1.5 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'

// Lifts the combined section's fetched response into the page's own state
// via an effect (runs after commit), never during the section's own render.
// `series` rides along so the add-panel trend chart renders
// from the same response.
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

function FinopsInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = resolveFinopsTab(searchParams.get('tab'))
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
  // FinOps is month-locked (default-layouts.ts): selectionFromParams refuses
  // rolling/custom windows, so the selection is always month mode here.
  const selection = selectionFromParams(
    {
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
    },
    dateRangeConfig
  ) ?? { mode: 'month' as const, monthsAgo: 1 }
  const monthsAgo = selection.mode === 'month' ? selection.monthsAgo : 0
  const { startDate, endDate, monthLabel } = useMemo(
    () => monthPeriod(monthsAgo),
    [monthsAgo]
  )
  const period = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

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

  // ── Failure domain 1: the composed close-engine read ────────────────────
  const [facts, setFacts] = useState<CloseStatusFacts | null>(null)
  const [closeState, setCloseState] = useState<TileState>('loading')
  const [closeError, setCloseError] = useState<string | undefined>(undefined)
  // Bumped after a close/reopen so the facts (and frozen-vs-live journal)
  // re-fetch — the month-end-close refreshKey pattern.
  const [refreshKey, setRefreshKey] = useState(0)
  const [, startCloseFetch] = useTransition()

  useEffect(() => {
    let cancelled = false
    startCloseFetch(async () => {
      setCloseState('loading')
      try {
        const result = await getFinopsCloseStatus({ startDate, endDate })
        if (cancelled) return
        if (result.success && result.data) {
          setFacts(result.data)
          setCloseState('ready')
          setCloseError(undefined)
        } else {
          setCloseState('error')
          setCloseError(result.error ?? CLOSE_STATUS_ERROR)
        }
      } catch {
        if (cancelled) return
        setCloseState('error')
        setCloseError(CLOSE_STATUS_ERROR)
      }
    })
    return () => {
      cancelled = true
    }
  }, [startDate, endDate, refreshKey])

  const derived = useMemo(
    () => (facts ? deriveCloseStatus(facts, new Date()) : null),
    [facts]
  )

  const handleLockChanged = useCallback(() => {
    setRefreshKey((key) => key + 1)
  }, [])

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

  // Customer/agent/plan/signal names for the non-Category dimensions the
  // picker can reach (BreakdownRow.key is a UUID for those).
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
    (key: string | null) => {
      if (key === null) return 'Unassigned'
      if (key in COST_CATEGORY_LABELS) {
        return COST_CATEGORY_LABELS[key as CostCategoryKey]
      }
      return labelMap.get(key) ?? key
    },
    [labelMap]
  )

  // ── GL-mapping rows (read-only; edits stay on /finops-settings) ─────
  const [signalRows, setSignalRows] = useState<
    SignalClassificationRow[] | null
  >(null)
  const [signalState, setSignalState] = useState<TileState>('loading')
  useEffect(() => {
    let cancelled = false
    getSignalsForClassification()
      .then((rows) => {
        if (cancelled) return
        setSignalRows(rows)
        setSignalState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setSignalState('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

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
          if (isCloseTileMetric(tile.metric)) {
            return (
              <KpiTile
                metric={tile.metric}
                value={derived ? derived.tiles[tile.metric] : null}
                subtext={derived?.subtexts[tile.metric]}
                state={closeState}
                errorMessage={closeError}
              />
            )
          }
          return (
            <KpiTile
              metric={tile.metric}
              value={kpiTiles ? resolverTileValue(kpiTiles, tile.metric) : null}
              state={kpiState}
            />
          )
        }
        case 'checklist':
          return (
            <Checklist
              title='Month-end close'
              tooltipKey='monthEndClose'
              items={derived?.steps ?? []}
              state={closeState}
              errorMessage={closeError}
            />
          )
        case 'alert-list':
          return (
            <AlertList
              title='Needs attention'
              tooltipKey='needsAttention'
              items={derived?.alerts ?? []}
              state={
                closeState === 'ready' && (derived?.alerts.length ?? 0) === 0
                  ? 'empty'
                  : closeState
              }
              errorMessage={closeError}
              emptyMessage='All signals are booked to the right account type. Nothing to fix before you close.'
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
    [derived, closeState, closeError, kpiTiles, kpiState, kpiSeries]
  )

  return (
    <PageShell
      page={PAGE}
      title='AI Accounting'
      subtitle={derived?.subtitle}
      dateRange={dateRangeConfig}
      headerExtras={
        <>
          <Link href='/finops?tab=settings' className={HEADER_LINK_CLASS}>
            <Settings2 className='h-3.5 w-3.5' />
            GL rules & codes
          </Link>
          {facts ? (
            <CloseControls
              lock={facts.lock}
              startDate={startDate}
              endDate={endDate}
              monthLabel={monthLabel}
              onChanged={handleLockChanged}
            />
          ) : null}
        </>
      }
      onSaveLayout={handleSaveLayout}
      onCancelEdit={handleCancelEdit}
      onResetLayout={handleResetLayout}
    >
      {({ editing }) => (
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            {FINOPS_TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value='close' className='flex flex-col gap-4'>
            {/* Locked-month banner (same copy as month-end-close):
              frozen numbers are never shown unlabeled. */}
            {facts?.lock.locked && (
              <div className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
                <p className='flex items-center gap-2 text-[12.5px] font-semibold text-mf-amber'>
                  <Lock className='h-3.5 w-3.5' />
                  {facts.lock.periodLabel ?? monthLabel} is closed
                </p>
                <p className='mt-1 text-[11.5px] text-mf-tx2'>
                  Closed
                  {facts.lock.lockedAt
                    ? ` ${format(new Date(facts.lock.lockedAt), 'MMM d, yyyy')}`
                    : ''}
                  {facts.lock.lockedByName
                    ? ` by ${facts.lock.lockedByName}`
                    : ''}
                  . The numbers below are the posted snapshot. Reclassifying
                  signals or remapping GL codes won’t change them. Reopen the
                  period to recompute from current data.
                </p>
              </div>
            )}
            {/* Open-month explainer: what closing does, on the page itself and
            not only inside the confirm dialog. */}
            {facts && !facts.lock.locked && (
              <div className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
                <p className='text-[12.5px] font-semibold text-mf-tx'>
                  What closing does
                </p>
                <p className='mt-1 text-[11.5px] text-mf-tx2'>
                  Closing a month freezes its numbers so your reports stop
                  moving. After you close a month, reclassifying a signal or
                  remapping a GL code won’t change that month’s journal, CSVs,
                  or margin. You can reopen a closed month later, and every
                  reopen is recorded. A month can be closed only after it ends.
                </p>
              </div>
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
            <DimensionedSection
              scope={PAGE}
              period={period}
              initialDimension='costCategory'
              showChart={false}
              showDonut={false}
              resolveLabel={resolveLabel}
              renderKpiRow={(data, state, series) => (
                <KpiRowBridge
                  tiles={data}
                  series={series ?? null}
                  state={state}
                  onData={handleKpiData}
                />
              )}
            />
            <GlMappingTable
              rows={signalRows}
              unmappedCount={derived?.tiles.unmappedCount ?? null}
              unmappedAmount={facts?.unmappedAmount ?? null}
              startDate={startDate}
              endDate={endDate}
              state={signalState}
              errorMessage={GL_TABLE_ERROR}
            />
            <JournalPreview
              journal={facts?.journal ?? null}
              lock={facts?.lock ?? null}
              startDate={startDate}
              endDate={endDate}
              state={closeState}
              errorMessage={closeError}
            />
          </TabsContent>

          {/* The cost-management and finops-settings features, embedded
              whole without their own page chrome. They read the SAME month
              window the Close tab uses (one page, one window). */}
          <TabsContent value='cost-management'>
            <CostManagement
              startDate={startDate}
              endDate={endDate}
              monthLabel={monthLabel}
            />
          </TabsContent>

          <TabsContent value='settings'>
            <FinopsSettings />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  )
}

export default function Finops() {
  // useSearchParams needs a Suspense boundary during prerender (DateRangeSelector
  // wraps its own internal call; this page reads the same params independently
  // to compute `period`, so it needs its own boundary too).
  return (
    <Suspense fallback={null}>
      <FinopsInner />
    </Suspense>
  )
}
