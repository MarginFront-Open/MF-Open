'use client'

/**
 * Where the AI spend went: internal coding-agent spend for
 * the current period, grouped by git repo or branch, on the Internal AI Spend
 * page. Data comes from the getSpendBreakdown server action — never a
 * client-side aggregation. That action forwards to the API's
 * GET /control/spend/breakdown. Honesty rails match the rest of
 * the tab: null spend renders as words, the untagged bucket is a visible row,
 * coverage is stated, and every number carries a freshness label.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { captureException } from '@sentry/nextjs'
import { ChevronRight, Info } from 'lucide-react'
import {
  TileFrame,
  type TileState,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { TooltipWrap } from '@/components/ui/info-tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  getSpendBreakdown,
  getSpendBreakdownDrill,
} from '@/app/actions/spend-controls'
import { freshnessLabel } from '../spend-controls-utils'
import {
  REPO_HELP_AFTER,
  REPO_HELP_COPIED_LABEL,
  REPO_HELP_COPY_LABEL,
  REPO_HELP_INTRO,
  REPO_HELP_PROMPT,
  REPO_HELP_PROMPT_LABEL,
  REPO_HELP_TOGGLE,
} from '../repo-help'
import type { CapPeriod } from '@/features/money/spend-controls-types'
import {
  BREAKDOWN_COLUMN_HEADERS,
  DIMENSION_CHOICES,
  DRILL_CAVEAT_NOTE,
  DRILL_COLLAPSE_LABEL,
  DRILL_COLUMN_HEADERS,
  DRILL_EMPTY_LINE,
  DRILL_ERROR_LINE,
  DRILL_EXPAND_LABEL,
  EMPTY_NO_ACTIVITY,
  EXPORT_CSV_LABEL,
  NO_KEY_LABELS,
  NO_KEY_ROW_NOTES,
  PERIOD_CHOICES,
  REPO_SPEND_ERROR_LINE,
  REPO_SPEND_EXPLAINER_COVERAGE,
  REPO_SPEND_EXPLAINER_HOW,
  REPO_SPEND_EXPLAINER_PR,
  REPO_SPEND_EXPLAINER_TITLE,
  REPO_SPEND_INTRO,
  REPO_SPEND_TITLE,
  breakdownCsv,
  buildBreakdownRows,
  commitCellText,
  coverageLine,
  csvFileName,
  noTaggedLine,
  sortDisplayRows,
  spendCellText,
  totalsLine,
  type BreakdownSortDirection,
  type BreakdownSortKey,
  type DisplayRow,
  type SpendBreakdownData,
  type SpendBreakdownDimension,
  type SpendBreakdownDrillData,
  type SpendBreakdownDrillRow,
} from '@/features/money/repo-spend'

/** Per-branch drill fetch state, keyed by composite branch key in the section. */
type DrillState =
  | { state: 'loading'; data: null }
  | { state: 'error'; data: null }
  | { state: 'ready'; data: SpendBreakdownDrillData }

export function RepoSpendSection() {
  const [dimension, setDimension] = useState<SpendBreakdownDimension>('repo')
  const [period, setPeriod] = useState<CapPeriod>('month')
  const [data, setData] = useState<SpendBreakdownData | null>(null)
  const [loadedAtMs, setLoadedAtMs] = useState<number>(0)
  const [state, setState] = useState<TileState>('loading')
  const [sortKey, setSortKey] = useState<BreakdownSortKey>('spend')
  const [sortDirection, setSortDirection] =
    useState<BreakdownSortDirection>('desc')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [drillByKey, setDrillByKey] = useState<Record<string, DrillState>>({})
  const [helpOpen, setHelpOpen] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
      }
    },
    []
  )

  // A drill fetch is dispatched from an event handler, not an effect, so it
  // cannot lean on effect-cleanup to cancel a stale request. This ref always
  // holds the current window; the fetch stamps the window it was fired for and
  // drops its result if the window has since changed. Without it, a drill that
  // resolves after a period/dimension switch would repopulate drillByKey with
  // wrong-window rows that a later re-expand would reuse — the exact attribution
  // drift this section guards against.
  const drillWindowRef = useRef({ period, dimension })
  // Synced in an effect, not a render-body assignment (which trips
  // react-hooks' no-mutating-refs-during-render rule); this runs after every
  // commit, so the ref is current before any in-flight drill resolves.
  useEffect(() => {
    drillWindowRef.current = { period, dimension }
  })

  // Same fetch-effect shape as the parent tab, .catch included: setState only
  // inside the callbacks with a cancelled guard. A period/dimension switch keeps
  // the current table on screen while the new data loads (no skeleton flash).
  useEffect(() => {
    let cancelled = false
    getSpendBreakdown({ period, dimension })
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setData(res.data.breakdown)
          setLoadedAtMs(Date.now())
          setState('ready')
        } else {
          setState('error')
        }
      })
      // Without this a rejected action leaves the table on 'loading' forever:
      // the error copy never renders and the user gets a permanent skeleton.
      .catch((err) => {
        captureException(err)
        if (cancelled) return
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [period, dimension])

  // A period or dimension switch invalidates every open drill (different
  // window, or repo mode has no drill at all). Cleared in the change handlers
  // below, not an effect: react-compiler forbids synchronous setState in an
  // effect, and each fetch's window-guard still drops an in-flight drill that
  // resolves after a switch.
  const resetDrill = () => {
    setExpandedKeys(new Set())
    setDrillByKey({})
  }

  const handleToggleDrill = (branchKey: string) => {
    const isOpen = expandedKeys.has(branchKey)
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (isOpen) next.delete(branchKey)
      else next.add(branchKey)
      return next
    })
    // Collapsing needs no fetch. Re-expanding reuses a cached result, EXCEPT a
    // prior error: the error copy tells the user to expand again to retry, so a
    // cached error must refetch, not stick.
    if (isOpen) return
    const cached = drillByKey[branchKey]
    if (cached && cached.state !== 'error') return
    setDrillByKey((prev) => ({
      ...prev,
      [branchKey]: { state: 'loading', data: null },
    }))
    const firedFor = { period, dimension }
    const isStale = () => {
      const now = drillWindowRef.current
      return (
        now.period !== firedFor.period || now.dimension !== firedFor.dimension
      )
    }
    getSpendBreakdownDrill(branchKey, period)
      .then((res) => {
        if (isStale()) return
        setDrillByKey((prev) => ({
          ...prev,
          [branchKey]: res.success
            ? { state: 'ready', data: res.data.drill }
            : { state: 'error', data: null },
        }))
      })
      // A rejection would otherwise leave this row's drill on 'loading' with no
      // way back: the error state is what tells the user to expand again.
      .catch((err) => {
        captureException(err)
        if (isStale()) return
        setDrillByKey((prev) => ({
          ...prev,
          [branchKey]: { state: 'error', data: null },
        }))
      })
  }

  const handleSort = (key: BreakdownSortKey) => {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection(key === 'label' ? 'asc' : 'desc')
    }
  }

  const view = useMemo(() => {
    if (!data) return null
    const { rows, noKeyRow } = buildBreakdownRows(data)
    return { sorted: sortDisplayRows(rows, sortKey, sortDirection), noKeyRow }
  }, [data, sortKey, sortDirection])

  const handleCsvDownload = () => {
    if (!data) return
    const blob = new Blob([breakdownCsv(data)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName(data.dimension, data.period)
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleCopyPrompt = async () => {
    try {
      if (!navigator.clipboard?.writeText) return
      await navigator.clipboard.writeText(REPO_HELP_PROMPT)
      setPromptCopied(true)
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = setTimeout(() => setPromptCopied(false), 2000)
    } catch {
      setPromptCopied(false)
    }
  }

  const dimensionColumn =
    DIMENSION_CHOICES.find((c) => c.id === dimension)?.columnHeader ?? 'Repo'

  return (
    <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-4'>
      <div className='flex items-center gap-1.5'>
        <p className='text-[13px] font-semibold text-mf-tx'>
          {REPO_SPEND_TITLE}
        </p>
        <TooltipWrap
          title={REPO_SPEND_EXPLAINER_TITLE}
          description={REPO_SPEND_EXPLAINER_HOW}
          details={`${REPO_SPEND_EXPLAINER_PR} ${REPO_SPEND_EXPLAINER_COVERAGE}`}
        >
          {/* A native button, not the bare icon: SVGs never join the tab
              order, and Radix only opens a tooltip on hover or focus. */}
          <button
            type='button'
            aria-label={REPO_SPEND_EXPLAINER_TITLE}
            className='cursor-help rounded-full text-mf-tx3 hover:text-mf-tx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
          >
            <Info className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
        </TooltipWrap>
      </div>
      <p className='mt-1 text-[11.5px] text-mf-tx3'>{REPO_SPEND_INTRO}</p>

      <div className='mt-3 flex flex-wrap items-center gap-3'>
        <div className='inline-flex overflow-hidden rounded-mf-seg-item border border-mf-bd'>
          {DIMENSION_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type='button'
              onClick={() => {
                resetDrill()
                setDimension(choice.id)
              }}
              className={
                'px-3 py-1 text-[11.5px] font-medium ' +
                (dimension === choice.id
                  ? 'bg-mf-accent text-white'
                  : 'bg-mf-card2 text-mf-tx2 hover:text-mf-tx')
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
        <Select
          value={period}
          onValueChange={(v) => {
            resetDrill()
            setPeriod(v as CapPeriod)
          }}
        >
          <SelectTrigger className='w-32'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_CHOICES.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && view && data.totals.eventCount > 0 ? (
          <Button variant='outline' size='sm' onClick={handleCsvDownload}>
            {EXPORT_CSV_LABEL}
          </Button>
        ) : null}
      </div>

      {state !== 'ready' ? (
        <div className='mt-3'>
          <TileFrame
            state={state}
            errorMessage={REPO_SPEND_ERROR_LINE}
            className='px-[17px] py-[15px]'
          >
            <div />
          </TileFrame>
        </div>
      ) : data && view ? (
        data.totals.eventCount === 0 ? (
          <p className='mt-3 rounded-mf-card border border-dashed border-mf-bd px-[17px] py-4 text-[11.5px] text-mf-tx3'>
            {EMPTY_NO_ACTIVITY}
          </p>
        ) : (
          <div className='mt-3'>
            <p className='text-[12.5px] font-medium text-mf-tx'>
              {totalsLine(data.totals)}
            </p>
            <p className='mt-1 text-[11.5px] text-mf-tx3'>
              {coverageLine(data.coveragePercent, dimension)}
            </p>
            {view.sorted.length === 0 ? (
              <p className='mt-2 text-[11.5px] text-mf-tx3'>
                {noTaggedLine(dimension)}
              </p>
            ) : null}
            <div className='mt-2 overflow-x-auto'>
              <table className='w-full border-collapse'>
                <thead>
                  <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
                    <SortableHeader
                      label={dimensionColumn}
                      column='label'
                      align='left'
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label={BREAKDOWN_COLUMN_HEADERS.spend}
                      column='spend'
                      align='right'
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <th className='px-[10px] pb-2 text-right font-semibold'>
                      {BREAKDOWN_COLUMN_HEADERS.share}
                    </th>
                    <SortableHeader
                      label={BREAKDOWN_COLUMN_HEADERS.events}
                      column='events'
                      align='right'
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {view.sorted.map((row) => {
                    // Only real branch rows drill: the "No branch recorded"
                    // bucket has a null key and no branch to query.
                    const expandable =
                      dimension === 'branch' && row.key !== null
                    return (
                      <BreakdownRow
                        key={row.key ?? row.label}
                        row={row}
                        expandable={expandable}
                        expanded={row.key !== null && expandedKeys.has(row.key)}
                        onToggle={
                          row.key !== null
                            ? () => handleToggleDrill(row.key as string)
                            : undefined
                        }
                        drill={
                          row.key !== null ? drillByKey[row.key] : undefined
                        }
                      />
                    )
                  })}
                  {view.noKeyRow ? (
                    <BreakdownRow
                      row={view.noKeyRow}
                      muted
                      note={{
                        title: NO_KEY_LABELS[dimension],
                        description: NO_KEY_ROW_NOTES[dimension],
                      }}
                    />
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className='mt-3'>
              <button
                type='button'
                onClick={() => setHelpOpen((open) => !open)}
                aria-expanded={helpOpen}
                aria-controls='repo-help-panel'
                className='inline-flex items-center gap-1 text-[11.5px] text-mf-tx2 hover:text-mf-tx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform ${helpOpen ? 'rotate-90' : ''}`}
                  aria-hidden='true'
                />
                {REPO_HELP_TOGGLE}
              </button>
              {helpOpen ? (
                <div id='repo-help-panel' className='mt-2 space-y-2'>
                  <p className='text-[11.5px] text-mf-tx3'>{REPO_HELP_INTRO}</p>
                  <div className='rounded-mf-card border border-mf-bd'>
                    <div className='flex items-center justify-between gap-3 border-b border-mf-bd px-3 py-2'>
                      <span className='text-[11px] font-medium text-mf-tx2'>
                        {REPO_HELP_PROMPT_LABEL}
                      </span>
                      <button
                        type='button'
                        onClick={handleCopyPrompt}
                        className='rounded-mf-seg-item px-2 py-0.5 text-[11px] font-medium text-mf-tx2 hover:text-mf-tx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                      >
                        {promptCopied
                          ? REPO_HELP_COPIED_LABEL
                          : REPO_HELP_COPY_LABEL}
                      </button>
                    </div>
                    <pre className='max-h-72 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-mf-tx2'>
                      {REPO_HELP_PROMPT}
                    </pre>
                  </div>
                  <p className='text-[11.5px] text-mf-tx3'>{REPO_HELP_AFTER}</p>
                </div>
              ) : null}
            </div>
            <p className='mt-2 text-[11px] text-mf-tx3'>
              {freshnessLabel(Date.parse(data.asOf), loadedAtMs)}.
            </p>
          </div>
        )
      ) : null}
    </section>
  )
}

function SortableHeader({
  label,
  column,
  align,
  sortKey,
  sortDirection,
  onSort,
}: {
  label: string
  column: BreakdownSortKey
  align: 'left' | 'right'
  sortKey: BreakdownSortKey
  sortDirection: BreakdownSortDirection
  onSort: (key: BreakdownSortKey) => void
}) {
  const active = sortKey === column
  return (
    <th
      className={`px-[10px] pb-2 font-semibold ${align === 'left' ? 'text-left' : 'text-right'}`}
    >
      <button
        type='button'
        onClick={() => onSort(column)}
        className={
          'uppercase tracking-[.05em] hover:text-mf-tx ' +
          (active ? 'text-mf-tx' : 'text-mf-tx3')
        }
      >
        {label}
        {active ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )
}

function BreakdownRow({
  row,
  muted,
  note,
  expandable,
  expanded,
  onToggle,
  drill,
}: {
  row: DisplayRow
  muted?: boolean
  note?: { title: string; description: string }
  // Branch-mode only: repo rows and the no-key bucket never drill.
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  drill?: DrillState
}) {
  return (
    <>
      <tr className='border-t border-mf-bd2'>
        <td
          className={`px-[10px] py-[11px] text-[12.5px] font-medium ${muted ? 'text-mf-tx2' : 'text-mf-tx'}`}
        >
          {expandable && onToggle ? (
            <button
              type='button'
              onClick={onToggle}
              aria-expanded={!!expanded}
              aria-label={expanded ? DRILL_COLLAPSE_LABEL : DRILL_EXPAND_LABEL}
              className='mr-1.5 inline-flex align-middle text-mf-tx3 hover:text-mf-tx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
            >
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                aria-hidden='true'
              />
            </button>
          ) : null}
          {row.label}
          {note ? (
            <TooltipWrap title={note.title} description={note.description}>
              <button
                type='button'
                aria-label={note.title}
                className='ml-1.5 inline-flex cursor-help align-middle text-mf-tx3 hover:text-mf-tx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
              >
                <Info className='h-3 w-3' aria-hidden='true' />
              </button>
            </TooltipWrap>
          ) : null}
          {row.repoContext ? (
            <span className='ml-2 text-[11px] font-normal text-mf-tx3'>
              {row.repoContext}
            </span>
          ) : null}
        </td>
        <td className='px-[10px] py-[11px] text-right text-[12px] font-medium text-mf-tx'>
          {row.spentUsd === null ? (
            <span className='font-normal text-mf-tx3'>{row.spendText}</span>
          ) : (
            row.spendText
          )}
        </td>
        <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
          {row.shareText}
        </td>
        <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
          {row.events.toLocaleString()}
        </td>
      </tr>
      {expandable && expanded ? <DrillRows drill={drill} /> : null}
    </>
  )
}

function DrillRows({ drill }: { drill?: DrillState }) {
  const drillState = drill?.state ?? 'loading'
  return (
    <tr className='border-t border-mf-bd2 bg-mf-card2'>
      <td colSpan={4} className='px-[10px] py-2'>
        {drillState === 'loading' || drillState === 'error' ? (
          <TileFrame
            state={drillState}
            errorMessage={DRILL_ERROR_LINE}
            className='px-[14px] py-[12px]'
          >
            <div />
          </TileFrame>
        ) : !drill?.data || drill.data.rows.length === 0 ? (
          <p className='py-1 text-[11.5px] text-mf-tx3'>{DRILL_EMPTY_LINE}</p>
        ) : (
          <>
            <div className='overflow-x-auto'>
              <table className='w-full border-collapse'>
                <thead>
                  <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
                    <th className='px-[10px] pb-1.5 text-left font-semibold'>
                      {DRILL_COLUMN_HEADERS.commit}
                    </th>
                    <th className='px-[10px] pb-1.5 text-left font-semibold'>
                      {DRILL_COLUMN_HEADERS.member}
                    </th>
                    <th className='px-[10px] pb-1.5 text-right font-semibold'>
                      {DRILL_COLUMN_HEADERS.cost}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drill.data.rows.map((drillRow, index) => (
                    <DrillSubRow
                      key={`${drillRow.commitSha ?? 'no-commit'}:${drillRow.member}:${index}`}
                      row={drillRow}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className='mt-2 text-[11px] text-mf-tx3'>{DRILL_CAVEAT_NOTE}</p>
          </>
        )}
      </td>
    </tr>
  )
}

function DrillSubRow({ row }: { row: SpendBreakdownDrillRow }) {
  return (
    <tr className='border-t border-mf-bd2'>
      <td className='px-[10px] py-2 font-mono text-[12px] text-mf-tx2'>
        {commitCellText(row.commitSha)}
      </td>
      <td className='px-[10px] py-2 text-[12px] text-mf-tx2'>{row.member}</td>
      <td className='px-[10px] py-2 text-right text-[12px] font-medium text-mf-tx'>
        {row.spentUsd === null ? (
          <span className='font-normal text-mf-tx3'>
            {spendCellText(row.spentUsd)}
          </span>
        ) : (
          spendCellText(row.spentUsd)
        )}
      </td>
    </tr>
  )
}
