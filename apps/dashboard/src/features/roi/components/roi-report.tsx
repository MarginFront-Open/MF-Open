'use client'

/**
 * The report above the goal cards: what the customer used AI
 * for, and the metrics they care about, for the page's date range.
 *
 * This file renders and nothing else. Every string and every dollar arrives
 * already built from report-derivation.ts, which the print and the JSON
 * route also call, so a number here can never read differently there.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { TileHeader } from '@/features/dashboard-shell/tiles/tile-header'
import { SegmentedControl } from '@/features/dashboard-shell/segmented-control'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  getRoiReportSecondaryMetrics,
  type RoiReport,
} from '@/app/actions/roi-report'
import {
  METRIC_EXAMPLE_COPY,
  REPORT_COPY,
  REVENUE_BASIS_OPTIONS,
  ROI_TOOLTIPS,
  WITHOUT_AI_COPY,
  buildWithoutAi,
  countRecordingAgents,
  finishedWorkMeasuredCount,
  finishedWorkRecordedThings,
  reportAgentRowCells,
  reportAgentRowKey,
  reportEmptySentence,
  reportLeadSentence,
  reportAgentsTableHeaders,
  reportMetricTile,
  reportTotalsCells,
  resolveAgentScope,
  splitHeadlineMetrics,
  toggleAgentSelection,
  type FinishedWorkBlock,
  type ReportMetricTile,
  type ReportMetricValue,
  type ReportAgentColumn,
  type ReportWindow,
  type RevenueBasis,
  type RoiTooltip,
  type RoiAssumptions,
  type WithoutAiWindowInputs,
} from '../report-derivation'
import { WithoutAi } from './without-ai'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const HEADER_CELL =
  'px-[10px] pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'
const BODY_CELL = 'px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'
const SECTION_HEADING = 'text-[13px] font-semibold tracking-[-.01em] text-mf-tx'
const NOTE = 'text-[11.5px] text-mf-tx3'
/** Not NOTE: what this page does not measure reads at the same contrast as
 * what it does. */
const HONESTY = 'text-[11.5px] text-mf-tx2'

/** One disclosure read, stamped with the window it answered for. */
interface SecondaryFetch {
  windowKey: string
  metrics: ReportMetricValue[] | null
  error: string | null
}

export interface RoiReportProps {
  report: RoiReport | null
  state: TileState
  errorMessage?: string
  /** metric -> the name of a live goal tracking it. */
  trackedByGoal: Partial<Record<InitiativeMetric, string>>
  /** The window-scoped inputs, read from the URL beside the dates. */
  reportInputs: WithoutAiWindowInputs
  onReportInputsChange: (next: Partial<WithoutAiWindowInputs>) => void
  /** Which revenue the table shows, from the page link. */
  revenueBasis: RevenueBasis
  onRevenueBasisChange: (next: RevenueBasis) => void
  /** Owned by the page so the print renders the SAME stored numbers this
   * section does. null means the read has not landed yet. */
  assumptions: RoiAssumptions | null
  assumptionsError: string | null
  onAssumptionsChange: (next: RoiAssumptions) => void
  /** Surfaced by the page, because the Finished work tab renders it too and
   * the comparison here counts from it. */
  finishedWork: FinishedWorkBlock | null
  /** Gates the comparison's Print report on what gates the header's, so two
   * doors to one print cannot disagree. */
  goalsRead: boolean
}

export function RoiReport({
  report,
  state,
  errorMessage,
  trackedByGoal,
  reportInputs,
  onReportInputsChange,
  revenueBasis,
  onRevenueBasisChange,
  assumptions,
  assumptionsError,
  onAssumptionsChange,
  finishedWork,
  goalsRead,
}: RoiReportProps) {
  // Stamped with the window it was read for rather than cleared by an effect:
  // a metric read for August can never paint under a September heading.
  const [secondary, setSecondary] = useState<SecondaryFetch | null>(null)
  const [showEvery, setShowEvery] = useState(false)
  const [, startSecondaryFetch] = useTransition()

  // A rolling range carries no dates, so resolving it again on click answers
  // for a window shifted off the tiles above. Reuse what the report resolved.
  const resolvedStart = report?.resolvedPeriod.startDate ?? null
  const resolvedEnd = report?.resolvedPeriod.endDate ?? null
  const windowKey =
    resolvedStart !== null && resolvedEnd !== null
      ? `${resolvedStart}|${resolvedEnd}`
      : null
  const fresh =
    windowKey !== null && secondary?.windowKey === windowKey ? secondary : null

  const loadSecondary = useCallback(() => {
    if (resolvedStart === null || resolvedEnd === null) return
    const key = `${resolvedStart}|${resolvedEnd}`
    startSecondaryFetch(async () => {
      try {
        const result = await getRoiReportSecondaryMetrics({
          startDate: resolvedStart,
          endDate: resolvedEnd,
        })
        setSecondary(
          result.ok
            ? { windowKey: key, metrics: result.data.metrics, error: null }
            : { windowKey: key, metrics: null, error: result.error }
        )
      } catch {
        setSecondary({
          windowKey: key,
          metrics: null,
          error: REPORT_COPY.secondaryMetricsFailed,
        })
      }
    })
  }, [resolvedStart, resolvedEnd])

  // Covers both openings: the reader opening the disclosure, and the dates
  // changing while it is already open.
  useEffect(() => {
    if (showEvery && fresh === null && windowKey !== null) loadSecondary()
  }, [showEvery, fresh, windowKey, loadSecondary])

  const rows = report
    ? report.agents.rows.map((row) => reportAgentRowCells(row, revenueBasis))
    : []
  const totals = report ? reportTotalsCells(report.agents.totals) : null
  const tableHeaders = reportAgentsTableHeaders(revenueBasis)
  const hasActivity = rows.length > 0

  const agentKeys = report ? report.agents.rows.map(reportAgentRowKey) : []
  const selectedKeys = reportInputs.selectedAgentKeys
  const isCountedIn = (key: string) =>
    selectedKeys === null || selectedKeys.includes(key)

  // The resolver the comparison and Finished work run, so the line appears
  // exactly when those two count fewer agents than the tiles do.
  const tilesCountMoreAgents =
    report !== null &&
    hasActivity &&
    !resolveAgentScope(report.agents.rows, selectedKeys).scope.allSelected

  const toggleAgent = (key: string) => {
    onReportInputsChange({
      selectedAgentKeys: toggleAgentSelection(agentKeys, selectedKeys, key),
    })
  }

  // Same rule surfaceWithoutAi applies for the print and the JSON.
  const withoutAiInputs: WithoutAiWindowInputs = {
    ...reportInputs,
    measuredCount:
      finishedWork === null ? null : finishedWorkMeasuredCount(finishedWork),
  }

  const withoutAi = report
    ? buildWithoutAi({
        window: report.window,
        resolvedPeriod: report.resolvedPeriod,
        assumptions,
        inputs: withoutAiInputs,
        rows: report.agents.rows,
        totals: report.agents.totals,
        measuredThings:
          finishedWork === null ? [] : finishedWorkRecordedThings(finishedWork),
      })
    : null

  const metricGroups = report
    ? splitHeadlineMetrics(report.metrics)
    : { money: [], behindDisclosure: [] }

  return (
    <div className='flex flex-col gap-5'>
      {report && withoutAi && (
        <WithoutAi
          block={withoutAi}
          window={report.window}
          inputs={withoutAiInputs}
          onInputsChange={onReportInputsChange}
          measuredThings={
            finishedWork === null
              ? []
              : finishedWorkRecordedThings(finishedWork)
          }
          assumptions={assumptions}
          readError={assumptionsError}
          onAssumptionsChange={onAssumptionsChange}
          goalsRead={goalsRead}
        />
      )}

      <section className='flex flex-col gap-2'>
        <SectionHeading
          text={REPORT_COPY.agentsHeading}
          tooltip={ROI_TOOLTIPS.agentsHeading}
        />

        <TileFrame
          state={state}
          errorMessage={errorMessage}
          className='min-h-[120px] overflow-hidden'
          loadingLines={4}
        >
          {report && (
            <div className='flex flex-col gap-2 px-[17px] py-[14px]'>
              <p className='text-[12px] text-mf-tx2'>
                {hasActivity
                  ? reportLeadSentence({
                      ...report.window,
                      agentsThatRecorded: countRecordingAgents(
                        report.agents.rows
                      ),
                      usageEvents: report.agents.totals.usageEvents,
                      cost: report.agents.totals.cost,
                      includesDeletedAgents: report.agents.rows.some(
                        (row) => row.agentId === null
                      ),
                    })
                  : reportEmptySentence(report.window)}
              </p>

              {hasActivity && (
                <p className={NOTE}>{WITHOUT_AI_COPY.agentScopeHelper}</p>
              )}

              {hasActivity && (
                <div className='flex items-center gap-1.5'>
                  <SegmentedControl
                    ariaLabel={ROI_TOOLTIPS.revenueBasis.title}
                    dataTour='revenue-basis'
                    options={REVENUE_BASIS_OPTIONS}
                    value={revenueBasis}
                    onChange={onRevenueBasisChange}
                  />
                  <InfoTooltip
                    title={ROI_TOOLTIPS.revenueBasis.title}
                    description={ROI_TOOLTIPS.revenueBasis.description}
                    iconSize='h-3 w-3'
                  />
                </div>
              )}

              {hasActivity && (
                <table
                  data-tour='agent-table'
                  className='w-full border-collapse'
                >
                  <thead>
                    <tr>
                      <ColumnHeader
                        label={WITHOUT_AI_COPY.agentScopeColumnLabel}
                        tooltip={ROI_TOOLTIPS.countInComparison}
                      />
                      {tableHeaders.map((header) => (
                        <ColumnHeader
                          key={header}
                          label={header}
                          tooltip={AGENT_COLUMN_TOOLTIPS[header]}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className='border-t border-mf-bd2'>
                        <td className='px-[10px] py-[7px]'>
                          <input
                            type='checkbox'
                            checked={isCountedIn(row.key)}
                            onChange={() => toggleAgent(row.key)}
                            aria-label={WITHOUT_AI_COPY.agentScopeRowLabel(
                              row.name
                            )}
                          />
                        </td>
                        <td className='px-[10px] py-[7px] text-[12px] text-mf-tx'>
                          {row.name}
                        </td>
                        <td className={BODY_CELL}>{row.usageEvents}</td>
                        <td className={BODY_CELL}>{row.cost}</td>
                        <td className={BODY_CELL}>{row.chosenRevenue}</td>
                        <td className={BODY_CELL}>{row.margin}</td>
                      </tr>
                    ))}
                    {totals && (
                      <tr className='border-t border-mf-bd'>
                        <td />
                        <td className='px-[10px] py-[7px] text-[12px] font-semibold text-mf-tx'>
                          {totals.label}
                        </td>
                        <td className={`${BODY_CELL} font-semibold`}>
                          {totals.usageEvents}
                        </td>
                        <td className={`${BODY_CELL} font-semibold`}>
                          {totals.cost}
                        </td>
                        <td className={`${BODY_CELL} font-semibold`}>
                          {revenueBasis === 'earned'
                            ? totals.earned
                            : totals.revenue}
                        </td>
                        <td className={BODY_CELL} />
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </TileFrame>
      </section>

      <section className='flex flex-col gap-2'>
        <h2 className={SECTION_HEADING}>{REPORT_COPY.metricsHeading}</h2>

        <TileFrame
          state={state}
          errorMessage={errorMessage}
          className='min-h-[120px]'
          loadingLines={4}
        >
          {report && (
            <div className='flex flex-col gap-3 px-[17px] py-[14px]'>
              <MetricGrid
                dataTour='metric-tiles'
                entries={metricGroups.money}
                trackedByGoal={trackedByGoal}
                window={report.window}
                finishedThings={report.finishedWork.finishedThings}
              />

              <details
                open={showEvery}
                onToggle={(e) => setShowEvery(e.currentTarget.open)}
                className='flex flex-col gap-2'
              >
                <summary
                  data-tour='show-every-metric'
                  className='flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-mf-tx3 hover:text-mf-tx'
                >
                  {REPORT_COPY.showEveryMetric}
                  <InfoTooltip
                    title={ROI_TOOLTIPS.showEveryMetric.title}
                    description={ROI_TOOLTIPS.showEveryMetric.description}
                    iconSize='h-3 w-3'
                  />
                </summary>
                <MetricGrid
                  entries={metricGroups.behindDisclosure}
                  trackedByGoal={trackedByGoal}
                  window={report.window}
                  finishedThings={report.finishedWork.finishedThings}
                />
                {fresh?.error ? (
                  <p className={NOTE}>{fresh.error}</p>
                ) : fresh?.metrics ? (
                  <MetricGrid
                    entries={fresh.metrics}
                    trackedByGoal={trackedByGoal}
                    window={report.window}
                    finishedThings={report.finishedWork.finishedThings}
                  />
                ) : (
                  // Nothing here reads as "no data" while six slow reads land.
                  <TileFrame state='loading' loadingLines={4}>
                    <div />
                  </TileFrame>
                )}
              </details>

              {tilesCountMoreAgents && (
                <p className={HONESTY}>{REPORT_COPY.everyAgentTilesNote}</p>
              )}
            </div>
          )}
        </TileFrame>
      </section>

      <div className='flex flex-col gap-1'>
        <p className={HONESTY}>{REPORT_COPY.proxyGap}</p>
        <p className={HONESTY}>{REPORT_COPY.noHours}</p>
      </div>
    </div>
  )
}

function MetricGrid({
  entries,
  trackedByGoal,
  window: reportWindow,
  finishedThings,
  dataTour,
}: {
  entries: ReportMetricValue[]
  trackedByGoal: Partial<Record<InitiativeMetric, string>>
  window: ReportWindow
  finishedThings: number
  dataTour?: string
}) {
  return (
    <div data-tour={dataTour} className='grid grid-cols-12 gap-3'>
      {entries
        .map((entry) =>
          reportMetricTile(entry, {
            trackedByGoal: trackedByGoal[entry.metric] ?? null,
            window: reportWindow,
            finishedThings,
          })
        )
        .map((tile) => (
          <MetricTile key={tile.key} tile={tile} />
        ))}
    </div>
  )
}

function MetricTile({ tile }: { tile: ReportMetricTile }) {
  const [showExample, setShowExample] = useState(false)

  return (
    <div className='col-span-12 flex flex-col gap-1 rounded-mf-card border border-mf-bd bg-mf-card2 px-[13px] py-[10px] sm:col-span-6 lg:col-span-4'>
      <TileHeader label={tile.label} tooltip={tile.tooltip} />
      <span className='text-[18px] font-semibold tabular-nums text-mf-tx'>
        {tile.value}
      </span>
      {tile.screenNotes.map((note) => (
        <span key={note} className='text-[11px] text-mf-tx2'>
          {note}
        </span>
      ))}
      <div className='flex items-center gap-1.5 self-start'>
        <button
          type='button'
          onClick={() => setShowExample((open) => !open)}
          className='text-[11px] font-medium text-mf-tx3 hover:text-mf-tx'
        >
          {showExample
            ? METRIC_EXAMPLE_COPY.hideLabel
            : METRIC_EXAMPLE_COPY.buttonLabel}
        </button>
        <InfoTooltip
          title={ROI_TOOLTIPS.seeExample.title}
          description={ROI_TOOLTIPS.seeExample.description}
          iconSize='h-3 w-3'
        />
      </div>
      {showExample && (
        <span className='text-[11px] text-mf-tx2'>{tile.example.line}</span>
      )}
    </div>
  )
}

/** A heading with its definition one hover away. */
function SectionHeading({
  text,
  tooltip,
}: {
  text: string
  tooltip: RoiTooltip
}) {
  return (
    <div className='flex items-center gap-1.5'>
      <h2 className={SECTION_HEADING}>{text}</h2>
      <InfoTooltip
        title={tooltip.title}
        description={tooltip.description}
        details={tooltip.details}
        iconSize='h-3 w-3'
      />
    </div>
  )
}

/** A table column heading with its definition one hover away. */
function ColumnHeader({
  label,
  tooltip,
}: {
  label: string
  tooltip: RoiTooltip
}) {
  return (
    <th className={HEADER_CELL}>
      <span className='inline-flex items-center gap-1'>
        {label}
        <InfoTooltip
          title={tooltip.title}
          description={tooltip.description}
          details={tooltip.details}
          iconSize='h-3 w-3'
        />
      </span>
    </th>
  )
}

/** Keyed by the header string the builder emits, so a renamed column with no
 * hover is a build error rather than a silent gap. */
const AGENT_COLUMN_TOOLTIPS: Record<ReportAgentColumn, RoiTooltip> = {
  Agent: ROI_TOOLTIPS.agentName,
  'Usage events': ROI_TOOLTIPS.agentUsageEvents,
  Cost: ROI_TOOLTIPS.agentCost,
  Earned: ROI_TOOLTIPS.agentEarned,
  'Total revenue': ROI_TOOLTIPS.agentRevenue,
  Margin: ROI_TOOLTIPS.agentMargin,
}
