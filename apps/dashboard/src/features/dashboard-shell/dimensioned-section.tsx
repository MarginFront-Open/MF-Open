'use client'

/**
 * One dimension, one resolveMetrics call, one
 * truth. This is the ONLY shell code that calls the resolver; the chart,
 * donut, and table below all render slices of the same response, so they
 * cannot disagree — there is no second query for them to disagree across.
 */

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import {
  DIMENSION_LABELS,
  GROUP_BY_DIMENSIONS,
  SCOPE_TILE_SOURCES,
  type Dimension,
} from '@/lib/component-catalog'
import { revenueColumnLabel } from '@/lib/revenue-basis'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { TooltipWrap } from '@/components/ui/info-tooltip'
import {
  chartMetricLabel,
  chartMetricOptions,
  chartTitleFor,
  effectiveChartMetric as toEffectiveChartMetric,
  selectChartSeries,
  type ChartMetric,
} from './chart-metric'
import { cn } from '@/lib/utils'
import { resolveMetrics as serverResolveMetrics } from '@/app/actions/metrics-resolver'
import type {
  MetricsScope,
  ResolveMetricsInput,
  ResolvedMetrics,
  ResolvedTiles,
} from '@/app/actions/metrics-resolver'
import { TimeseriesChart } from './tiles/timeseries-chart'
import { CategoryDonut } from './tiles/category-donut'
import { BreakdownTable } from './tiles/breakdown-table'
import type { TileState } from './tiles/tile-frame'

/**
 * The injection seam (and what makes the single-call invariant unit-testable):
 * the preview and tests pass a fixture function of this exact shape; real
 * pages omit the prop and get the live server action.
 */
export type MetricsResolver = typeof serverResolveMetrics

// Mirrors COST_BREAKDOWN_DEFAULT_PAGE_SIZE (packages/db cost-grouping.ts).
// Not imported: a value import of @marginfront/db would pull Prisma into the
// client bundle — only type imports are safe here.
const BREAKDOWN_PAGE_SIZE = 25

const TRANSPORT_ERROR_MESSAGE =
  "Couldn't reach the server to load this section. The request failed before it got to the database. Check your connection and refresh to retry."

const EMPTY_BREAKDOWN: ResolvedMetrics['breakdown'] = {
  rows: [],
  totalRowCount: 0,
  other: null,
  revenueBasis: null,
  page: 1,
  pageSize: BREAKDOWN_PAGE_SIZE,
}

export interface DimensionedSectionProps {
  scope: MetricsScope
  /** parseWindowFilter's UI shape — {} = rolling 30 days. */
  period: ResolveMetricsInput['period']
  /** The tile's stored dimension — the picker's starting value. */
  initialDimension: Dimension
  filters?: ResolveMetricsInput['filters']
  title?: string
  chartTitle?: string
  /** Optional info-icon tooltip shown next to chartTitle, same shape as an
   * InfoTooltip/tooltipDefinitions entry. Absent = no icon. */
  chartTitleTooltip?: { title: string; description: string; details?: string }
  resolveLabel?: (key: string | null) => string
  /** default true for both — Money shows donut + table, Build table only. */
  showDonut?: boolean
  showTable?: boolean
  /** default true. false drops the time-series chart block entirely (FinOps
   * ships donut + table with NO default chart; a chart is add-panel-only
   * there, fed from this same response via renderKpiRow). */
  showChart?: boolean
  /** default false. When true AND showChart, the
   * chart gains a metric picker (Cost / Revenue / Cost + Revenue / Tasks), each
   * view sliced from the SAME response — no second query, so chart and table
   * can't disagree. Off = the plain Cost+Revenue chart. */
  showChartMetricPicker?: boolean
  /** default true. false hides the "Group by" picker for tiles whose data
   * is always day-grain regardless of dimension — otherwise a
   * user can pick a dimension and watch the chart silently not change. */
  showDimensionPicker?: boolean
  /** The page's KPI row, fed from the SAME response (data.tiles).
   * `series` carries the same response's day-grain rows so a page can render
   * its own chart tile without a second resolver call. */
  renderKpiRow?: (
    tiles: ResolvedTiles | null,
    state: TileState,
    series?: ResolvedMetrics['series'] | null
  ) => ReactNode
  resolve?: MetricsResolver
}

export function DimensionedSection({
  scope,
  period,
  initialDimension,
  filters,
  title,
  chartTitle,
  chartTitleTooltip,
  resolveLabel,
  showDonut = true,
  showTable = true,
  showChart = true,
  showChartMetricPicker = false,
  showDimensionPicker = true,
  renderKpiRow,
  // The local name is load-bearing: the single-call source-assert counts call
  // sites spelled with this exact name, injected-or-default alike.
  resolve: resolveMetrics = serverResolveMetrics,
}: DimensionedSectionProps) {
  // Dimension + breakdown page change together (picker resets to page 1) so
  // one state transition means one effect run means ONE resolver call.
  const [query, setQuery] = useState({ dimension: initialDimension, page: 1 })
  // Donut can show cost or per-bucket revenue for revenue-definable dimensions;
  // the preference persists across dimension switches and is force-ignored
  // (cost-only) when the current dimension has no revenue basis.
  const [donutMetric, setDonutMetric] = useState<'cost' | 'revenue'>('cost')
  // Chart view picker. Persists across dimension/window switches;
  // corrected to a still-available view when the revenue series is gone (same
  // idea as effectiveDonutMetric). Only surfaced when showChartMetricPicker.
  const [chartMetric, setChartMetric] = useState<ChartMetric>('cost+revenue')
  const [response, setResponse] = useState<ResolvedMetrics | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const requestSeq = useRef(0)

  const { dimension, page } = query
  const { startDate, endDate } = period
  const { customerId, agentId, signalId, subscriptionId } = filters ?? {}

  useEffect(() => {
    const seq = ++requestSeq.current
    startTransition(async () => {
      let result: Awaited<ReturnType<MetricsResolver>>
      try {
        result = await resolveMetrics({
          scope,
          period: { startDate, endDate },
          dimension,
          filters: { customerId, agentId, signalId, subscriptionId },
          breakdown: { page, pageSize: BREAKDOWN_PAGE_SIZE },
        })
      } catch {
        result = { success: false, error: TRANSPORT_ERROR_MESSAGE }
      }
      // A newer request superseded this one — drop it, never merge (
      // one new call replaces the previous response atomically).
      if (seq !== requestSeq.current) return
      if (result.success && result.data) {
        setResponse(result.data)
        setErrorMessage(null)
      } else {
        setErrorMessage(result.error ?? TRANSPORT_ERROR_MESSAGE)
      }
    })
  }, [
    scope,
    startDate,
    endDate,
    dimension,
    page,
    customerId,
    agentId,
    signalId,
    subscriptionId,
    resolveMetrics,
    startTransition,
  ])

  const data = response
  const stateFor = (hasData: boolean): TileState => {
    if (errorMessage) return 'error'
    if (!data) return 'loading'
    return hasData ? 'ready' : 'empty'
  }

  const chartState = stateFor(data !== null && data.series.length > 0)
  const donutState = stateFor(
    data !== null &&
      (data.breakdown.rows.length > 0 || data.breakdown.other !== null)
  )
  const tableState = stateFor(data !== null && data.breakdown.totalRowCount > 0)

  const breakdown = data?.breakdown ?? EMPTY_BREAKDOWN
  const totals = data
    ? { cost: data.tiles.cost, eventCount: data.tiles.eventCount }
    : { cost: 0, eventCount: 0 }
  const foldedRowCount = breakdown.totalRowCount - breakdown.rows.length
  const breakdownTitle = `Cost by ${DIMENSION_LABELS[dimension]}`

  // Donut metric toggle: offered only when the resolver actually returned a
  // revenue basis for this response (definable dimension AND a revenue-computing
  // scope). Keys off the SAME breakdown.revenueBasis the table reads, so donut
  // and table never disagree about whether revenue exists. Null until data
  // loads (EMPTY_BREAKDOWN.revenueBasis) → cost-only, no flash of a dead toggle.
  const donutBasis = breakdown.revenueBasis
  const effectiveDonutMetric = donutBasis === null ? 'cost' : donutMetric
  const donutTitle =
    effectiveDonutMetric === 'revenue' && donutBasis !== null
      ? `${revenueColumnLabel(donutBasis)} by ${DIMENSION_LABELS[dimension]}`
      : breakdownTitle

  // Basis chip. Reads the SAME breakdown.revenueBasis
  // the table gates its column on, so chip and column cannot disagree; the
  // scope gate mirrors the resolver's sources.revenue flag, so a scope that
  // never computes revenue (build) shows no chip instead of a false
  // "no revenue for this grouping".
  const tableBasis = breakdown.revenueBasis
  const basisChip =
    showTable && data !== null && SCOPE_TILE_SOURCES[scope].revenue
      ? tableBasis === null
        ? {
            label: 'No revenue column',
            tooltip: tooltipDefinitions.breakdownBasisNone,
          }
        : {
            label: `Revenue column: ${revenueColumnLabel(tableBasis)}`,
            tooltip:
              tableBasis === 'earned'
                ? tooltipDefinitions.breakdownBasisEarned
                : tooltipDefinitions.breakdownBasisBilled,
          }
      : null

  // Chart metric picker. Every plotted series is sliced
  // from THIS response (data.series / data.earnedSeries) — the picker is a pure
  // view toggle, never a second resolver call, so chart and table read the same
  // window/dimension by construction. Off (showChartMetricPicker false) forces
  // 'cost+revenue'.
  const hasRevenueSeries = (data?.earnedSeries?.length ?? 0) > 0
  const activeChartMetric: ChartMetric = showChartMetricPicker
    ? chartMetric
    : 'cost+revenue'
  const chartMetricInUse = toEffectiveChartMetric(
    activeChartMetric,
    hasRevenueSeries
  )
  const chart = selectChartSeries(
    chartMetricInUse,
    data?.series ?? [],
    data?.earnedSeries,
    hasRevenueSeries
  )
  const displayChartTitle = showChartMetricPicker
    ? chartTitleFor(chartMetricInUse, chartTitle ?? 'Cost over time')
    : (chartTitle ?? 'Cost over time')

  return (
    <section aria-busy={isPending}>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        {title && (
          <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
            {title}
          </h2>
        )}
        {showDimensionPicker && (
          <div className='ml-auto flex items-center gap-2'>
            <span className='text-[11px] text-mf-tx3'>Group by</span>
            <div
              role='group'
              aria-label='Group by'
              className='flex flex-wrap items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
            >
              {GROUP_BY_DIMENSIONS[scope].map((option) => (
                <button
                  key={option}
                  type='button'
                  aria-pressed={option === dimension}
                  onClick={() => setQuery({ dimension: option, page: 1 })}
                  className={cn(
                    'h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium',
                    option === dimension
                      ? 'bg-mf-accent2 text-mf-accent'
                      : 'text-mf-tx2 hover:text-mf-tx'
                  )}
                >
                  {DIMENSION_LABELS[option]}
                </button>
              ))}
            </div>
            {basisChip && (
              <TooltipWrap
                title={basisChip.tooltip.title}
                description={basisChip.tooltip.description}
                details={basisChip.tooltip.details}
              >
                <span className='cursor-help rounded-full border border-mf-bd bg-mf-card2 px-2 py-0.5 text-[10.5px] font-medium text-mf-tx2'>
                  {basisChip.label}
                </span>
              </TooltipWrap>
            )}
          </div>
        )}
      </div>

      <div className={cn('grid grid-cols-12 gap-3', isPending && 'opacity-60')}>
        {renderKpiRow && (
          <div className='col-span-12'>
            {renderKpiRow(
              data?.tiles ?? null,
              stateFor(data !== null),
              data?.series ?? null
            )}
          </div>
        )}
        {showChart && (
          <div className={cn('col-span-12', showDonut && 'lg:col-span-8')}>
            {showChartMetricPicker && (
              <div className='mb-2 flex items-center justify-end gap-2'>
                <span className='text-[11px] text-mf-tx3'>Show</span>
                <div
                  role='group'
                  aria-label='Chart metric'
                  className='flex flex-wrap items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
                >
                  {chartMetricOptions(hasRevenueSeries).map((option) => (
                    <button
                      key={option}
                      type='button'
                      aria-pressed={option === chartMetricInUse}
                      onClick={() => setChartMetric(option)}
                      className={cn(
                        'h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium',
                        option === chartMetricInUse
                          ? 'bg-mf-accent2 text-mf-accent'
                          : 'text-mf-tx2 hover:text-mf-tx'
                      )}
                    >
                      {chartMetricLabel(option)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <TimeseriesChart
              title={displayChartTitle}
              titleTooltip={chartTitleTooltip}
              series={chart.series}
              valueFormat={chart.valueFormat}
              state={chartState}
              errorMessage={errorMessage ?? undefined}
            />
          </div>
        )}
        {showDonut && (
          <div className='col-span-12 sm:col-span-6 lg:col-span-4'>
            {donutBasis !== null && (
              <div className='mb-2 flex items-center justify-end gap-2'>
                <span className='text-[11px] text-mf-tx3'>Show</span>
                <div
                  role='group'
                  aria-label='Donut metric'
                  className='flex items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
                >
                  {(['cost', 'revenue'] as const).map((metric) => (
                    <button
                      key={metric}
                      type='button'
                      aria-pressed={metric === effectiveDonutMetric}
                      onClick={() => setDonutMetric(metric)}
                      className={cn(
                        'h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium',
                        metric === effectiveDonutMetric
                          ? 'bg-mf-accent2 text-mf-accent'
                          : 'text-mf-tx2 hover:text-mf-tx'
                      )}
                    >
                      {metric === 'revenue'
                        ? revenueColumnLabel(donutBasis)
                        : 'Cost'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <CategoryDonut
              title={donutTitle}
              rows={breakdown.rows}
              other={breakdown.other}
              otherCount={foldedRowCount > 0 ? foldedRowCount : undefined}
              resolveLabel={resolveLabel}
              valueMode={effectiveDonutMetric}
              state={donutState}
              errorMessage={errorMessage ?? undefined}
            />
          </div>
        )}
        {showTable && (
          <div className='col-span-12'>
            <BreakdownTable
              title={breakdownTitle}
              breakdown={breakdown}
              totals={totals}
              resolveLabel={resolveLabel}
              onPageChange={(nextPage) =>
                setQuery((current) => ({ ...current, page: nextPage }))
              }
              state={tableState}
              errorMessage={errorMessage ?? undefined}
            />
          </div>
        )}
      </div>
    </section>
  )
}
