'use server'

/**
 * ROI report — the ONE read action behind the report above the
 * goal cards. Canon getters only, no new SQL.
 *
 * ONE REVENUE READ, ON PURPOSE. The Revenue tile, the table's two revenue
 * columns and the comparison's Revenue row are the same dollars on one screen,
 * so ONE getRevenueMetrics call answers all of them and the per-agent split is
 * derived from that same object. getAgentEarned is that call with the usage
 * rows kept and the rest dropped, so asking for it too would be a second
 * transaction for numbers we already hold.
 *
 * ONE COST READ, ON PURPOSE. The agent table and the Cost tile are the same
 * dollars inches apart, so they come from one snapshot: getCostBreakdown's
 * totals query has no dimension in it and runs in the same REPEATABLE READ
 * transaction as its rows, so the cost family is mapped from THAT read and
 * readMetricsWindow is asked only for revenue. Asking it for cost too opens a
 * second transaction, and on an org ingesting live the two could disagree.
 *
 * TWO CALLS, NOT ONE. The other six metrics each cost a read this page does
 * not pay for (the close journal's unbounded findMany, a customers
 * findMany with no take, an MRR snapshot), so they wait for the disclosure.
 *
 * The row join and every rendered string are pure and live in
 * features/build/agents-derivation.ts and features/roi/report-derivation.ts —
 * a 'use server' file may only export async functions.
 */

import { db as prisma } from '@/app/lib/db'
import {
  getCostBreakdown,
  getRevenueMetrics,
  ANALYTICS_MAX_ROWS,
} from '@marginfront/db'
import { assertMoneyManager } from './_shared/assert-money-manager'
import { parseWindowFilter } from './_shared/parse-window-filter'
import {
  readMetricsWindow,
  ROI_UNMAPPED_WINDOW_MAX_DAYS,
} from './_shared/initiative-actuals'
import {
  NO_READS,
  actualForMetric,
} from './_shared/initiative-metric-values'
import type { WindowReads } from './_shared/initiative-metric-values'
import { agentIdsWithActivity } from '@/features/build/agents-derivation'
import {
  HEADLINE_METRICS,
  SECONDARY_METRICS,
  buildRoiReportJson,
  composeReportAgentRows,
  parseAgentsParam,
  parseUnitsParam,
  sumFinishedThings,
  windowIsAnchored,
} from '@/features/roi/report-derivation'
import type {
  ReportAgentRowValues,
  ReportFinishedWorkReads,
  ReportMetricValue,
  RoiReportJson,
} from '@/features/roi/report-derivation'
import { getOrgRoiAssumptions } from './org-roi-assumptions'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Direct type DECLARATIONS in a 'use server' file are safe (they erase at
// build); only type RE-exports crash the action bundle at runtime.
export interface RoiReport {
  window: { startDate: string; endDate: string }
  /**
   * The instants these reads actually used. The disclosure's second call must
   * take THESE: a rolling period carries no dates, so resolving it again
   * minutes later answers for a window shifted off the one already on screen.
   */
  resolvedPeriod: { startDate: string; endDate: string }
  agents: {
    rows: ReportAgentRowValues[]
    /** ECHOED canon totals, never re-summed from the rows. */
    totals: {
      usageEvents: number
      cost: number
      earned: number
      revenue: number
    }
  }
  metrics: ReportMetricValue[]
  /** The finished-work lists, from the SAME snapshot. */
  finishedWork: ReportFinishedWorkReads
}

export interface RoiReportSecondaryMetrics {
  metrics: ReportMetricValue[]
}

/** All twelve for one window: what the goal dialog's examples read. */
export interface RoiMetricExamples {
  window: { startDate: string; endDate: string }
  metrics: ReportMetricValue[]
}

/**
 * { ok, status } rather than the page's { success, error }: this same action
 * feeds the JSON route, which has to answer 401 versus 403, and one
 * action with two result conventions is how the two surfaces drift apart.
 */
export type RoiReportResult<T> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: 400 | 401 | 403 | 500; error: string }

const READ_FAILED =
  "Couldn't load the report. Reading your usage data failed. Refresh to try again; if it keeps happening, it's a problem with this install, not anything you did."

/** Both of the gate's refusals describe a WRITE, the wrong accusation for a
 *  read, and the no-session one is the bare string 'Not authenticated'. */
const NOT_SIGNED_IN = "You're signed out. Sign in again to read this report."

const NOT_ALLOWED =
  "You don't have access to this report. Reading it takes the finance, admin, or owner role. Ask an owner on your team to change yours."

function gateFailure(gate: { error: string }): {
  ok: false
  status: 401 | 403
  error: string
} {
  // The gate reports "Not authenticated" only for the no-session case;
  // everything else is a real member with the wrong role.
  return gate.error === 'Not authenticated'
    ? { ok: false, status: 401, error: NOT_SIGNED_IN }
    : { ok: false, status: 403, error: NOT_ALLOWED }
}

/**
 * The window every read in one call must share, as FULL ISO instants.
 * parseWindowFilter uses an ISO string verbatim and only expands a bare date,
 * so handing the resolved instants down keeps each read on identical bounds.
 * Bare dates would not: the default "last 30 days" resolves to now-minus-30-at
 * -this-hour, and re-parsing its date part would silently widen the second
 * read to the start of that day. Revenue over 30.6 days against cost over 30
 * is a Margin tile that does not equal Revenue minus Cost on the same screen.
 */
function resolveWindow(period: { startDate?: string; endDate?: string }) {
  const { windowStart, windowEnd } = parseWindowFilter(period)
  return {
    windowStart,
    windowEnd,
    /** What every downstream read is given. */
    resolvedPeriod: {
      startDate: windowStart.toISOString(),
      endDate: windowEnd.toISOString(),
    },
    /** What the copy builders render. */
    displayWindow: {
      startDate: windowStart.toISOString().slice(0, 10),
      endDate: windowEnd.toISOString().slice(0, 10),
    },
  }
}

/** Inclusive UTC day count, the readMetricsWindow shape. */
function windowDays(windowStart: Date, windowEnd: Date): number {
  return (
    Math.floor(windowEnd.getTime() / MS_PER_DAY) -
    Math.floor(windowStart.getTime() / MS_PER_DAY) +
    1
  )
}

type ResolvedWindow = ReturnType<typeof resolveWindow>

type HeadlineRead =
  | {
      ok: true
      agents: RoiReport['agents']
      metrics: ReportMetricValue[]
      finishedWork: ReportFinishedWorkReads
    }
  | { ok: false; status: 400; error: string }

/**
 * The report's default load, as ONE function. Every surface that wants these
 * numbers calls it rather than composing its own, which is what makes the
 * goal dialog's example and the report's tile the same number.
 */
async function readHeadlineReport(
  orgId: string,
  resolved: ResolvedWindow
): Promise<HeadlineRead> {
  const { windowStart, windowEnd } = resolved
  const window = { start: windowStart, end: windowEnd }

  const [costBreakdown, revenueMetrics] = await Promise.all([
    getCostBreakdown(
      prisma,
      orgId,
      window,
      'agent',
      {},
      {
        page: 1,
        pageSize: ANALYTICS_MAX_ROWS,
        includeOtherRollup: false,
        // Every agent: the checkboxes re-scope the rendered table in memory,
        // so unchecking one must not cost a round trip.
        finishedWork: { agentIds: null },
      }
    ),
    getRevenueMetrics(prisma, orgId, window, {}),
  ])

  if (costBreakdown.totalRowCount > ANALYTICS_MAX_ROWS) {
    return {
      ok: false,
      status: 400,
      error: `This window has ${costBreakdown.totalRowCount} agents with activity, more than the ${ANALYTICS_MAX_ROWS} this report can load at once. The cap keeps one page from reading your whole usage history. Narrow the date range.`,
    }
  }

  // A finished thing is not a usage event. The tile, the divisor under Cost
  // per usage event and the per-agent column all take it out HERE, so the
  // table's total can never stop matching the tile.
  const finishedWorkCount = costBreakdown.totals.eventCountFinishedWork ?? 0
  // RECORDS came out of the tile; THINGS is what the sentence beside it says.
  const finishedThings = sumFinishedThings(
    costBreakdown.finishedWork?.things ?? []
  )
  const usageEventRows = costBreakdown.rows.map((row) => ({
    ...row,
    eventCount: row.eventCount - (row.eventCountFinishedWork ?? 0),
  }))

  // Scoped to the ids the refusal above has already bounded. A capped roster
  // read instead puts a big org's LIVE agents in the deleted-agents row.
  // bySubscription, not the usage-only slice: a subscription that billed a
  // monthly fee and recorded no events is revenue this table has to show.
  const activeAgentIds = agentIdsWithActivity(
    costBreakdown.rows,
    revenueMetrics.bySubscription
  )
  const agents =
    activeAgentIds.length === 0
      ? []
      : await prisma.agents.findMany({
          where: { orgId, deletedAt: null, id: { in: activeAgentIds } },
          select: { id: true, name: true, agentCode: true, isActive: true },
        })

  const rows: ReportAgentRowValues[] = composeReportAgentRows(
    agents,
    usageEventRows,
    revenueMetrics.bySubscription
  )

  // One snapshot for both cost reads: the breakdown's canon totals ARE the
  // cost family, so the tiles and the table cannot disagree.
  const headlineReads: WindowReads = {
    ...NO_READS,
    revenue: {
      revenue: revenueMetrics.revenue,
      margin: revenueMetrics.margin,
      marginPercent: revenueMetrics.marginPercent,
    },
    breakdownTotals: {
      cost: costBreakdown.totals.cost,
      eventCount: costBreakdown.totals.eventCount - finishedWorkCount,
    },
  }

  return {
    ok: true,
    agents: {
      rows,
      totals: {
        usageEvents: costBreakdown.totals.eventCount - finishedWorkCount,
        cost: costBreakdown.totals.cost,
        earned: revenueMetrics.usageRevenue,
        revenue: revenueMetrics.revenue,
      },
    },
    metrics: HEADLINE_METRICS.map((metric) => ({
      metric,
      value: actualForMetric(metric, headlineReads),
      unavailable: null,
    })),
    finishedWork: {
      things: costBreakdown.finishedWork?.things ?? [],
      buckets: costBreakdown.finishedWork?.buckets ?? [],
      namedUsage: costBreakdown.finishedWork?.namedUsage ?? [],
      excludedFromUsageEvents: finishedWorkCount,
      finishedThings,
    },
  }
}

/** The six behind the disclosure, each of which costs a read the default
 * load does not pay for. */
async function readSecondaryMetrics(
  orgId: string,
  resolved: ResolvedWindow
): Promise<ReportMetricValue[]> {
  const { windowStart, windowEnd, resolvedPeriod } = resolved

  const reads = await readMetricsWindow(
    orgId,
    new Set(SECONDARY_METRICS),
    resolvedPeriod,
    { includeMrrSnapshot: true, matterId: null }
  )

  // readMetricsWindow returns null for the unmapped count both when the
  // journal is empty and when the window is too wide to read it. Only the
  // second has a reason worth printing, and the cap it names is the real
  // server constant rather than a number typed into a sentence.
  const overCap =
    windowDays(windowStart, windowEnd) > ROI_UNMAPPED_WINDOW_MAX_DAYS

  return SECONDARY_METRICS.map((metric) => ({
    metric,
    value: actualForMetric(metric, reads),
    unavailable:
      metric === 'unmappedCount' && overCap
        ? {
            reason: 'window-too-wide' as const,
            capDays: ROI_UNMAPPED_WINDOW_MAX_DAYS,
          }
        : null,
  }))
}

export async function getRoiReport(period: {
  startDate?: string
  endDate?: string
}): Promise<RoiReportResult<RoiReport>> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return gateFailure(gate)

  try {
    const orgId = gate.orgId
    const resolved = resolveWindow(period)
    const { resolvedPeriod, displayWindow } = resolved

    const headline = await readHeadlineReport(orgId, resolved)
    if (!headline.ok) return headline

    return {
      ok: true,
      status: 200,
      data: {
        window: displayWindow,
        resolvedPeriod,
        agents: headline.agents,
        metrics: headline.metrics,
        finishedWork: headline.finishedWork,
      },
    }
  } catch {
    return { ok: false, status: 500, error: READ_FAILED }
  }
}

export async function getRoiReportSecondaryMetrics(period: {
  startDate?: string
  endDate?: string
}): Promise<RoiReportResult<RoiReportSecondaryMetrics>> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return gateFailure(gate)

  try {
    const orgId = gate.orgId
    const metrics = await readSecondaryMetrics(orgId, resolveWindow(period))
    return { ok: true, status: 200, data: { metrics } }
  } catch {
    return { ok: false, status: 500, error: READ_FAILED }
  }
}

/**
 * All twelve metrics for one window in ONE call, so the goal
 * dialog fetches once when it opens. Composes the same two reads above.
 */
export async function getRoiMetricExamples(period: {
  startDate?: string
  endDate?: string
}): Promise<RoiReportResult<RoiMetricExamples>> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return gateFailure(gate)

  try {
    const orgId = gate.orgId
    const resolved = resolveWindow(period)

    const [headline, secondary] = await Promise.all([
      readHeadlineReport(orgId, resolved),
      readSecondaryMetrics(orgId, resolved),
    ])
    if (!headline.ok) return headline

    return {
      ok: true,
      status: 200,
      data: {
        window: resolved.displayWindow,
        metrics: [...headline.metrics, ...secondary],
      },
    }
  } catch {
    return { ok: false, status: 500, error: READ_FAILED }
  }
}

/**
 * The whole report as JSON, a provenance stamp on every number.
 * The gate lives here, not in the route, so the page and the route can never
 * answer differently about who may read this.
 */
export async function getRoiReportJson(params: {
  startDate?: string
  endDate?: string
  units?: string | null
  agents?: string | null
}): Promise<RoiReportResult<RoiReportJson>> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return gateFailure(gate)

  try {
    const orgId = gate.orgId
    const resolved = resolveWindow({
      startDate: params.startDate,
      endDate: params.endDate,
    })

    const [headline, secondary, stored] = await Promise.all([
      readHeadlineReport(orgId, resolved),
      readSecondaryMetrics(orgId, resolved),
      getOrgRoiAssumptions(),
    ])
    if (!headline.ok) return headline
    if (!stored.success) {
      return { ok: false, status: 500, error: READ_FAILED }
    }

    return {
      ok: true,
      status: 200,
      data: buildRoiReportJson({
        window: resolved.displayWindow,
        resolvedPeriod: resolved.resolvedPeriod,
        agents: headline.agents,
        metrics: [...headline.metrics, ...secondary],
        assumptions: stored.data.assumptions ?? {},
        finishedWork: headline.finishedWork,
        inputs: {
          unitsCompleted: parseUnitsParam(params.units, params),
          // surfaceWithoutAi fills this from the finished-work block above, so
          // the JSON and the screen cannot read back two different counts.
          measuredCount: null,
          windowIsAnchored: windowIsAnchored(params),
          selectedAgentKeys: parseAgentsParam(params.agents),
        },
      }),
    }
  } catch {
    return { ok: false, status: 500, error: READ_FAILED }
  }
}
