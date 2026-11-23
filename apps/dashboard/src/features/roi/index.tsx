'use client'

/**
 * ROI: a REPORT above the goals, split into three child tabs, one per
 * question a reader actually asks: did AI pay for itself (Summary), what did
 * we get for it (Finished work), are we on track (Goals).
 *
 * TWO data paths, two windows. The report reads the page-scoped range from the
 * URL (the Build page's pattern) through getRoiReport; each goal card still
 * measures its OWN stored window through getRoiOverview. The band
 * above the tabs says both out loud, which is the only thing that makes two
 * rules honest.
 *
 * The print is ONE document of every tab, so it renders outside the Tabs root:
 * Radix unmounts the panels a reader is not on, and a print from the Goals tab
 * would otherwise lose the comparison that is its page one. Same reason the
 * stored without-AI numbers are read here rather than inside the block that
 * renders them.
 *
 * The bespoke cards grid is org-content, not personal tiles: one card per
 * initiative, archived cards behind a toggle, and the add-card renders
 * ALWAYS (it IS the create affordance).
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import { PAGE_DATE_RANGE } from '@/features/dashboard-shell/default-layouts'
import {
  selectionFromParams,
  selectionToPeriod,
} from '@/features/dashboard-shell/date-range'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { storage } from '@/lib/storage'
import {
  getRoiOverview,
  type RoiInitiativeView,
  type RoiOverview,
} from '@/app/actions/roi-overview'
import { getRoiReport, type RoiReport } from '@/app/actions/roi-report'
import { getOrgRoiAssumptions } from '@/app/actions/org-roi-assumptions'
import type { InitiativeMetric } from '@/app/actions/initiatives'
import { GettingStartedNudge } from '@/features/build/components/getting-started-nudge'
import { getHasIngestedFirstEvent } from '@/app/actions/getting-started-status'
import { InfoTooltip, TooltipWrap } from '@/components/ui/info-tooltip'
import { InitiativeCard } from './components/initiative-card'
import { InitiativeDialog } from './components/initiative-dialog'
import { FinishedWork } from './components/finished-work'
import { RoiReport as RoiReportSection } from './components/roi-report'
import { ROI_TABS, resolveRoiTab } from './roi-tabs'
import {
  REPORT_COPY,
  ROI_TOOLTIPS,
  WITHOUT_AI_COPY,
  agentsParamValue,
  buildPrintReport,
  parseAgentsParam,
  parseUnitsParam,
  resolveRevenueBasis,
  surfaceFinishedWork,
  windowIsAnchored,
  type RevenueBasis,
  type RoiAssumptions,
  type WithoutAiWindowInputs,
} from './report-derivation'
import {
  BoardReadyExportButton,
  BoardReadyExportView,
} from './components/board-ready-export'
import { RoiTour } from './tour/roi-tour'
import { ShowMeAround } from './tour/show-me-around'
import { useRoiTour } from './tour/use-roi-tour'
import { resolveTourPlan } from './tour/tour-steps'

const PAGE = 'roi' as const

const OVERVIEW_ERROR =
  "Couldn't load your goals. The request failed before it reached the server. Check your connection and refresh to try again."

const CARD_CELL = 'col-span-12 sm:col-span-6 lg:col-span-4'

const HOW_THIS_PAGE_WORKS_KEY = 'roi-how-this-page-works'

function setParam(params: URLSearchParams, key: string, value: string | null) {
  if (value === null) params.delete(key)
  else params.set(key, value)
}

/**
 * GET /api/roi/report, pointed at the window on screen. Route param names,
 * not the page's: the URL says startDate/endDate and the route reads
 * start/end. It sits in the band beside Print report, because it answers for
 * every tab and not only for the comparison.
 */
function ReportJsonLink({
  startDate,
  endDate,
  inputs,
}: {
  startDate?: string
  endDate?: string
  inputs: WithoutAiWindowInputs
}) {
  const query = new URLSearchParams()
  const pairs: Array<[string, string | null | undefined]> = [
    ['start', startDate],
    ['end', endDate],
    ['units', inputs.unitsCompleted?.toString()],
    ['agents', agentsParamValue(inputs.selectedAgentKeys)],
  ]
  for (const [key, value] of pairs) {
    if (value) query.set(key, value)
  }
  const qs = query.toString()

  return (
    <TooltipWrap
      title={ROI_TOOLTIPS.getThisAsData.title}
      description={ROI_TOOLTIPS.getThisAsData.description}
    >
      <a
        href={qs ? `/api/roi/report?${qs}` : '/api/roi/report'}
        target='_blank'
        rel='noreferrer'
        data-tour='get-this-as-data'
        className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
      >
        {ROI_TOOLTIPS.getThisAsData.title}
      </a>
    </TooltipWrap>
  )
}

function RoiInner() {
  const [overview, setOverview] = useState<RoiOverview | null>(null)
  const [overviewState, setOverviewState] = useState<TileState>('loading')
  const [overviewError, setOverviewError] = useState<string | undefined>(
    undefined
  )
  // Bumped after any successful write so the cards re-fetch — the FinOps
  // refreshKey pattern. Never an optimistic update: a failed write leaves
  // the cards exactly as the server last reported them.
  const [refreshKey, setRefreshKey] = useState(0)
  const [, startOverviewFetch] = useTransition()

  const [report, setReport] = useState<RoiReport | null>(null)
  const [reportState, setReportState] = useState<TileState>('loading')
  const [reportError, setReportError] = useState<string | undefined>(undefined)
  const [, startReportFetch] = useTransition()

  // Read HERE, not inside the block that renders it: Radix unmounts the panel
  // a reader is not on, so a print from Goals would find no stored numbers and
  // lose page one of its own report.
  const [assumptions, setAssumptions] = useState<RoiAssumptions | null>(null)
  const [assumptionsError, setAssumptionsError] = useState<string | null>(null)

  // Read here rather than inside the nudge: the tour picks its plan from the
  // same fact, and two round trips can answer differently.
  const [hasEvents, setHasEvents] = useState<boolean | null>(null)
  const [hasEventsRead, setHasEventsRead] = useState(false)

  const howRef = useRef<HTMLDetailsElement>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<RoiInitiativeView | null>(null)

  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = resolveRoiTab(searchParams.get('tab'))
  // Beside `tab`, not beside the dates: which revenue a reader wants to read
  // is not a fact about one window, so a date change keeps it (the param is
  // deliberately absent from PAGE_DATE_RANGE.roi.windowScopedParams).
  const revenueBasis = resolveRevenueBasis(searchParams.get('revenue'))
  const dateRangeConfig = PAGE_DATE_RANGE[PAGE]
  const selection = selectionFromParams(
    {
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
      range: searchParams.get('range') ?? undefined,
    },
    dateRangeConfig
  ) ?? { mode: 'rolling' as const }
  const { startDate, endDate } = selectionToPeriod(selection)
  // Stable identity, so the report re-fetches on a date change and not on
  // every render.
  const period = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

  const unitsParam = searchParams.get('units')
  const agentsParam = searchParams.get('agents')
  // The RAW date params, not the resolved window: a rolling range resolves to
  // dates the link never named, and a count typed against dates that move is
  // restated as fact for a window it was never counted for.
  const urlDates = useMemo(
    () => ({
      startDate: searchParams.get('startDate'),
      endDate: searchParams.get('endDate'),
    }),
    [searchParams]
  )
  const reportInputs = useMemo<WithoutAiWindowInputs>(
    () => ({
      unitsCompleted: parseUnitsParam(unitsParam, urlDates),
      measuredCount: null,
      windowIsAnchored: windowIsAnchored(urlDates),
      selectedAgentKeys: parseAgentsParam(agentsParam),
    }),
    [unitsParam, agentsParam, urlDates]
  )

  // The whole param set, not a fresh one: a tab click must not drop the
  // dates, the count and the agent selection the reader already chose.
  const handleTabChange = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams)
      params.set('tab', tab)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [searchParams, router, pathname]
  )

  const handleRevenueBasisChange = useCallback(
    (next: RevenueBasis) => {
      const params = new URLSearchParams(searchParams)
      params.set('revenue', next)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [searchParams, router, pathname]
  )

  // ONE writer for these three params, so the inputs row and the agent
  // checkboxes cannot commit two different versions of the same URL.
  const handleReportInputsChange = useCallback(
    (next: Partial<WithoutAiWindowInputs>) => {
      const merged = { ...reportInputs, ...next }
      const params = new URLSearchParams(searchParams)
      setParam(
        params,
        'units',
        merged.unitsCompleted === null ? null : String(merged.unitsCompleted)
      )
      setParam(params, 'agents', agentsParamValue(merged.selectedAgentKeys))
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [reportInputs, searchParams, router, pathname]
  )

  const handleHowToggle = useCallback((open: boolean) => {
    storage.setItem(HOW_THIS_PAGE_WORKS_KEY, open ? 'open' : 'closed')
  }, [])

  // Open on the server and on the first client render alike, so React has
  // nothing to reconcile. Seeding state from storage instead (the
  // taxonomy-card.tsx shape) makes the two disagree for a reader who closed it,
  // and React 19 answers a mismatched attribute by discarding the server markup.
  useEffect(() => {
    const panel = howRef.current
    if (panel && storage.getItem(HOW_THIS_PAGE_WORKS_KEY) === 'closed') {
      panel.open = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    startOverviewFetch(async () => {
      setOverviewState('loading')
      try {
        const result = await getRoiOverview()
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
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    startReportFetch(async () => {
      setReportState('loading')
      try {
        const result = await getRoiReport(period)
        if (cancelled) return
        if (result.ok) {
          setReport(result.data)
          setReportState('ready')
          setReportError(undefined)
        } else {
          setReportState('error')
          setReportError(result.error)
        }
      } catch {
        if (cancelled) return
        setReportState('error')
        setReportError(REPORT_COPY.reportRequestFailed)
      }
    })
    return () => {
      cancelled = true
    }
  }, [period])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await getOrgRoiAssumptions()
        if (cancelled) return
        setAssumptionsError(result.success ? null : WITHOUT_AI_COPY.readFailed)
        // An empty object is "we asked, they have nothing stored" — a claim
        // the page may not make until the read lands, hence null before it.
        setAssumptions(result.success ? (result.data.assumptions ?? {}) : {})
      } catch {
        if (cancelled) return
        setAssumptionsError(WITHOUT_AI_COPY.readFailed)
        setAssumptions({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await getHasIngestedFirstEvent()
        if (cancelled) return
        // Fail-quiet: only an explicit false is a claim of zero.
        setHasEvents(result.success ? (result.hasEvents ?? null) : null)
      } catch {
        if (cancelled) return
        setHasEvents(null)
      } finally {
        // A read that failed is not a claim of zero, and unread is what keeps
        // the tour shut: both have to resolve to the core tour instead.
        if (!cancelled) setHasEventsRead(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleChanged = useCallback(() => {
    setRefreshKey((key) => key + 1)
  }, [])

  const openCreate = useCallback(() => {
    setEditTarget(null)
    setDialogOpen(true)
  }, [])

  const openEdit = useCallback((view: RoiInitiativeView) => {
    setEditTarget(view)
    setDialogOpen(true)
  }, [])

  const initiatives = overview?.initiatives ?? []
  const activeViews = initiatives.filter((view) => view.status === 'active')
  const archivedViews = initiatives.filter((view) => view.status === 'archived')

  // One flag behind both ways to the print. An empty `initiatives` before the
  // read lands is an unread list, not a count of zero.
  const goalsRead = overviewState === 'ready'

  // First active goal wins a metric: a tile names one goal, not a list.
  const trackedByGoal = useMemo(() => {
    const byMetric: Partial<Record<InitiativeMetric, string>> = {}
    for (const view of activeViews) {
      for (const target of view.targets) {
        if (!byMetric[target.metric]) byMetric[target.metric] = view.name
      }
    }
    return byMetric
  }, [activeViews])

  // Built here because two tabs read it: Finished work renders it, and the
  // comparison on Summary counts from it.
  const finishedWork = useMemo(
    () =>
      report
        ? surfaceFinishedWork({
            window: report.window,
            agents: report.agents,
            inputs: reportInputs,
            finishedWork: report.finishedWork,
          })
        : null,
    [report, reportInputs]
  )

  const printReport = useMemo(
    () =>
      report
        ? buildPrintReport({
            window: report.window,
            resolvedPeriod: report.resolvedPeriod,
            agents: report.agents,
            metrics: report.metrics,
            assumptions,
            inputs: reportInputs,
            finishedWork: report.finishedWork,
            revenueBasis,
            trackedByGoal,
          })
        : null,
    [report, assumptions, reportInputs, revenueBasis, trackedByGoal]
  )

  const tourPlan = useMemo(() => resolveTourPlan({ hasEvents }), [hasEvents])
  const tour = useRoiTour({
    activeTab,
    onTabChange: handleTabChange,
    // A step may not point at a control the page has not finished painting.
    ready: goalsRead && reportState !== 'loading' && hasEventsRead,
    suppressed: dialogOpen,
    autoPlan: tourPlan,
  })

  const subtitle = overview
    ? overview.activeCount === 1
      ? '1 goal tracked'
      : `${overview.activeCount} goals tracked`
    : undefined

  return (
    <>
      <PageShell
        page={PAGE}
        title='ROI'
        subtitle={subtitle}
        dateRange={PAGE_DATE_RANGE[PAGE]}
        editable={false}
        headerExtras={
          <>
            <ShowMeAround onStart={(planId) => tour.start(planId, 'button')} />
            <BoardReadyExportButton
              disabled={!goalsRead}
              dataTour='print-report'
            />
            <InfoTooltip
              title={ROI_TOOLTIPS.printReport.title}
              description={ROI_TOOLTIPS.printReport.description}
              iconSize='h-3 w-3'
            />
            <ReportJsonLink
              startDate={startDate}
              endDate={endDate}
              inputs={reportInputs}
            />
          </>
        }
      >
        {/* The print renders the same report as one document, outside the
            tabs, so exactly one of the two reaches paper. */}
        <div className='no-print'>
          {/* Renders only for an org whose first usage event has not landed;
              until then every tab on this page is empty for the same reason. */}
          <div className='mb-3'>
            <GettingStartedNudge
              description={REPORT_COPY.firstEventNudge}
              hasEvents={hasEvents}
            />
          </div>

          <p className='mb-2 text-[11.5px] text-mf-tx2'>
            {REPORT_COPY.dateHelper}
          </p>

          <details
            ref={howRef}
            open
            onToggle={(e) => handleHowToggle(e.currentTarget.open)}
            className='mb-4 flex flex-col gap-1'
          >
            <summary className='flex cursor-pointer items-center gap-1.5 text-[11.5px] font-medium text-mf-tx3 hover:text-mf-tx'>
              {REPORT_COPY.howThisPageWorksLabel}
              <InfoTooltip
                title={ROI_TOOLTIPS.howThisPageWorks.title}
                description={ROI_TOOLTIPS.howThisPageWorks.description}
                iconSize='h-3 w-3'
              />
            </summary>
            {REPORT_COPY.howThisPageWorks.map((line) => (
              <p key={line} className='text-[11.5px] text-mf-tx2'>
                {line}
              </p>
            ))}
          </details>

          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              {ROI_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value='summary'>
              <RoiReportSection
                report={report}
                state={reportState}
                errorMessage={reportError}
                trackedByGoal={trackedByGoal}
                reportInputs={reportInputs}
                onReportInputsChange={handleReportInputsChange}
                revenueBasis={revenueBasis}
                onRevenueBasisChange={handleRevenueBasisChange}
                assumptions={assumptions}
                assumptionsError={assumptionsError}
                onAssumptionsChange={setAssumptions}
                finishedWork={finishedWork}
                goalsRead={goalsRead}
              />
            </TabsContent>

            <TabsContent value='finished'>
              <FinishedWork
                block={finishedWork}
                state={reportState}
                errorMessage={reportError}
              />
            </TabsContent>

            <TabsContent value='goals' className='flex flex-col gap-3'>
              <div className='flex items-center gap-1.5'>
                <h2
                  data-tour='goals-heading'
                  className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'
                >
                  {REPORT_COPY.goalsHeading}
                </h2>
                <InfoTooltip
                  title={ROI_TOOLTIPS.goalsHeading.title}
                  description={ROI_TOOLTIPS.goalsHeading.description}
                  iconSize='h-3 w-3'
                />
              </div>

              {overviewState === 'error' ? (
                <TileFrame
                  state='error'
                  errorMessage={overviewError}
                  className='min-h-[120px] px-[17px] py-[14px]'
                >
                  <div />
                </TileFrame>
              ) : overviewState === 'loading' ? (
                <div className='grid grid-cols-12 gap-3'>
                  {[0, 1, 2].map((i) => (
                    <TileFrame
                      key={i}
                      state='loading'
                      loadingLines={4}
                      className={`${CARD_CELL} min-h-[140px] px-[17px] py-[14px]`}
                    >
                      <div />
                    </TileFrame>
                  ))}
                </div>
              ) : (
                <div className='flex flex-col gap-4'>
                  <div className='grid grid-cols-12 gap-3'>
                    {activeViews.map((view) => (
                      <div key={view.id} className={CARD_CELL}>
                        <InitiativeCard
                          view={view}
                          onEdit={openEdit}
                          onChanged={handleChanged}
                        />
                      </div>
                    ))}
                    {showArchived &&
                      archivedViews.map((view) => (
                        <div key={view.id} className={CARD_CELL}>
                          <InitiativeCard
                            view={view}
                            onEdit={openEdit}
                            onChanged={handleChanged}
                          />
                        </div>
                      ))}
                    <div
                      className={`${CARD_CELL} flex flex-col items-start justify-center gap-2 rounded-mf-card border border-dashed border-mf-bd bg-mf-card px-[17px] py-[14px]`}
                    >
                      {initiatives.length === 0 && (
                        <>
                          <p className='text-[12px] font-semibold text-mf-tx'>
                            Track your first goal
                          </p>
                          <p className='text-[11.5px] text-mf-tx3'>
                            Name a goal, pick a metric like cost or revenue, and
                            set a target. We measure where you started and track
                            progress against your real numbers, so there is no
                            spreadsheet to keep up to date.
                          </p>
                        </>
                      )}
                      <div className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          onClick={openCreate}
                          data-tour='new-goal'
                          className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
                        >
                          ＋ New goal
                        </button>
                        <InfoTooltip
                          title={ROI_TOOLTIPS.newGoal.title}
                          description={ROI_TOOLTIPS.newGoal.description}
                          iconSize='h-3 w-3'
                        />
                      </div>
                    </div>
                  </div>

                  {archivedViews.length > 0 && (
                    <div className='flex items-center gap-1.5'>
                      <button
                        type='button'
                        onClick={() => setShowArchived((value) => !value)}
                        className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-tx'
                      >
                        {showArchived
                          ? 'Hide archived'
                          : `Show archived (${archivedViews.length})`}
                      </button>
                      <InfoTooltip
                        title={ROI_TOOLTIPS.showArchived.title}
                        description={ROI_TOOLTIPS.showArchived.description}
                        iconSize='h-3 w-3'
                      />
                    </div>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <BoardReadyExportView
          initiatives={activeViews}
          goalsRead={goalsRead}
          report={printReport}
        />
      </PageShell>

      <RoiTour controller={tour} />

      <InitiativeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initiative={editTarget}
        onSaved={handleChanged}
      />
    </>
  )
}

export default function Roi() {
  // useSearchParams needs a Suspense boundary during prerender (DateRangeSelector
  // wraps its own internal call; this page reads the same params independently
  // to compute `period`, so it needs its own boundary too).
  return (
    <Suspense fallback={null}>
      <RoiInner />
    </Suspense>
  )
}
