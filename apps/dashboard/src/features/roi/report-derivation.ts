/**
 * The ROI report's pure derivation, the progress-derivation.ts
 * pattern. Framework-free and node-testable; NO fetching, NO money math beyond
 * the canon formatters.
 *
 * Every string the report renders lives here rather than inline in JSX because
 * three surfaces render them: the page, the board-ready print and the
 * JSON route. One copy or they drift, and a printed paragraph that
 * disagrees with the screen is the failure this avoids.
 * METRIC_DESCRIPTIONS lives here, not in the goal dialog, for that same reason.
 */

import { formatCost, formatPct, safeMarginPercent } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { CCC_COMMAND_INVOCATION } from '@/lib/meter-command'
import { WORK_ITEM_NOUN, WORK_ITEM_NOUN_PLURAL } from '@/lib/work-item-noun'
import {
  FEES_OUTSIDE_USAGE_REVENUE,
  roiMetricTileDetails,
  roiTooltipCopy,
} from '@/lib/tooltip-definitions'
import type {
  BreakdownRow,
  FinishedThingRow,
  FinishedWorkBucketRow,
  NamedUsageRow,
} from '@marginfront/db'
import {
  deriveAgentRows,
  type AgentInventoryRow,
} from '@/features/build/agents-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'
import {
  INITIATIVE_METRIC_META,
  formatMetricValue,
  type InitiativeHealth,
} from './progress-derivation'

/**
 * The six the report loads on first paint: answerable from two reads. The
 * other six each cost a read the first paint skips (the close journal, an
 * unbounded customer findMany, an MRR snapshot), so they wait for the
 * disclosure.
 */
export const HEADLINE_METRICS: readonly InitiativeMetric[] = [
  'cost',
  'revenue',
  'margin',
  'marginPercent',
  'eventCount',
  'costPerTask',
]

export const SECONDARY_METRICS: readonly InitiativeMetric[] = [
  'unmappedCount',
  'mrr',
  'arr',
  'newCustomers',
  'internalCost',
  'externalCost',
]

/** The four a reader opens this page for. The other two headline metrics are
 * diagnostics: they answer "why is that number what it is", which is a second
 * question, so they sit behind Show every metric with the secondary six. */
export const MONEY_TILE_METRICS: readonly InitiativeMetric[] = [
  'cost',
  'revenue',
  'margin',
  'marginPercent',
]

/**
 * One honest sentence per metric, naming the real data it comes from. TOTAL
 * over InitiativeMetric on purpose, same reason INITIATIVE_METRIC_META is
 * total: growing the union without adding a sentence here is a compile error.
 */
export const METRIC_DESCRIPTIONS: Record<InitiativeMetric, string> = {
  cost: 'Total cost of every usage event in this window, summed from real costs, never estimates.',
  revenue:
    'What your subscriptions earned in this window: recurring fees, seat fees, usage and one-time charges.',
  margin:
    'Revenue minus the cost of the usage events that were billed to a subscription, in dollars.',
  marginPercent: 'Margin as a percent of revenue for this window.',
  costPerTask:
    'Total cost divided by the number of usage events, for this window.',
  eventCount: 'Usage events recorded in this window.',
  unmappedCount:
    'Usage signals in this window that still need a GL code, the accounting category assigned during close.',
  mrr: 'Your active monthly recurring revenue from contracts, as of today (not limited to this window).',
  arr: 'Monthly recurring revenue times 12, as of today (not limited to this window).',
  newCustomers: 'Number of customers created during this window.',
  internalCost:
    'Cost in this window from users flagged internal (tracked for cost only, never invoiced).',
  externalCost: 'Cost in this window from every customer not flagged internal.',
}

/**
 * The half of revenueScopeNote that answers "why don't these three tiles add
 * up", split out so the tile hover can carry it alone. revenueScopeNote is
 * still assembled from it below, byte for byte, because the print and the
 * stored report render the whole note.
 */
const REVENUE_VS_COST_SCOPE =
  "Cost counts every usage event, subscription or not, so Revenue minus Cost won't always equal Margin."

export const REPORT_COPY = {
  dateHelper:
    'These dates cover the Summary and Finished work tabs. Each goal keeps the dates you set on it.',

  agentsHeading: 'What you used AI for',
  /** The PRINT's columns. Paper has no control to switch between Earned and
   *  Total revenue, so it carries both; the screen renders
   *  reportAgentsTableHeaders(basis), which is this list minus the column the
   *  reader did not pick. */
  agentsTableHeaders: [
    'Agent',
    'Usage events',
    'Cost',
    'Earned',
    'Total revenue',
    'Margin',
  ],
  totalsRowLabel: 'All agents',
  usageEventDefinition:
    'One usage event is one call your integration records. For the coding meter, one model response plus one per tool, per five-minute flush.',
  meterNamesHelper:
    'The name your meter or your integration sent. To rename one, open Build in the left menu, then the Agents tab, and this table follows.',
  earnedScopeHelper:
    "Usage fees only: what the per-unit prices on this agent's subscriptions " +
    'earned from the usage events in these dates. It leaves out the ' +
    `${FEES_OUTSIDE_USAGE_REVENUE} the Revenue metric counts.`,
  revenueColumnHelper:
    "Every fee on this agent's subscriptions in these dates: monthly and " +
    'seat fees pro-rated to the dates, per-unit usage fees and one-time ' +
    'charges. The Revenue tile uses this number.',
  /** The agent count is LIVE agents; the totals cover deleted ones too. Two
   * scopes in one sentence, so the sentence has to say so. */
  deletedAgentsClause:
    ' That total also covers agents you deleted, listed as one row.',

  metricsHeading: 'The metrics you care about',
  /** Only when the check marks have narrowed things. Two numbers for the same
   *  word on one screen, and nothing on it saying why they differ, is the one
   *  misread this page exists to prevent. */
  everyAgentTilesNote:
    'These tiles count every agent. The Without AI comparison and the ' +
    'Finished work tab count only the agents you checked.',
  showEveryMetric: 'Show every metric',
  agentCounted: 'Counted',
  agentLeftOut: 'Left out',
  printDatesLine: (startDate: string, endDate: string) =>
    `These numbers cover ${formatDisplayDate(startDate)} to ${formatDisplayDate(
      endDate
    )}.`,
  asOfTodayNote: 'As of today, not limited to these dates.',
  trackedByGoal: (goalName: string) => `Tracked by your goal: ${goalName}.`,
  unmappedOverWindowCap: (capDays: number) =>
    `Not available past ${capDays} days. This one reads your close journal, and we cap that read so a wide date range doesn't have to scan every entry you've ever closed.`,

  proxyGap:
    'We count a finished thing when your team records it: a coding assistant ' +
    `does that with ${CCC_COMMAND_INVOCATION} done in a terminal, and your own ` +
    'app does it through the API. Signals your integrations name count too. ' +
    'Everything else on this page is usage events.',
  noHours:
    "We don't show hours saved. We don't record how long anything took, so any hours number here would be a guess.",

  revenueScopeNote:
    'Revenue counts what your subscriptions earned in this window: recurring fees, seat fees, usage and one-time charges. Margin is that revenue minus the cost of the usage events billed to a subscription. ' +
    REVENUE_VS_COST_SCOPE,
  revenueVsCostScope: REVENUE_VS_COST_SCOPE,

  printReportLabel: 'Print report',
  printReportHover:
    "Opens your browser's print window with every tab as one document, " +
    'comparison first. Choose Save as PDF there if you want a file.',
  /** The comparison card carries a second copy of the same button. Two doors
   *  to one print is deliberate; leaving a reader to guess that the near one
   *  prints only the card is not. */
  printReportAgainHover:
    "The same print as the Print report button in this page's header: every " +
    'tab as one document, comparison first.',

  dataLinkHover:
    'Opens the numbers behind this page as plain data (JSON) in a new tab, ' +
    'with a word on each saying where it came from: measured, attributed, ' +
    'or your own estimate. For a spreadsheet or a slide tool, not for ' +
    'reading.',

  howThisPageWorksLabel: 'How this page works',
  howThisPageWorks: [
    'We measure what your AI cost and earned from real usage, inside the date range you picked for this page.',
    'You tell us what the same work cost without AI. That number stays labeled as your estimate wherever it shows.',
    'Hover or tap the small i on any number for what it means. Print report gives you every tab as one document.',
  ],

  /** The GettingStartedNudge's body on this page. Every tab is empty for the
   * same reason until the org's first usage event lands. */
  firstEventNudge:
    'Nothing has landed yet. To see what your AI cost, connect your meter or ' +
    'your app from Getting Started: open it in the left menu, under Learn. ' +
    'Once one usage event lands, this page fills in on its own.',

  goalsHeading: 'Your goals',
  goalsOwnWindowNote:
    'Each goal measures the dates shown on it, not the dates you picked for this report.',
  goalsUnread:
    "Your goals hadn't loaded when this report was printed, so they're not shown here.",

  reportRequestFailed:
    "Couldn't load this report. The request failed before it reached the server. Check your connection and refresh to try again.",
  secondaryMetricsFailed:
    "Couldn't load the rest of the metrics. Refresh to try again.",
} as const

/** Why one metric has no number, when the reason is worth saying out loud. */
export interface ReportMetricUnavailable {
  reason: 'window-too-wide'
  /** The real server cap, carried so the sentence can't drift from it. */
  capDays: number
}

export interface ReportMetricValue {
  metric: InitiativeMetric
  /** null renders the dash, never a 0. */
  value: number | null
  unavailable: ReportMetricUnavailable | null
}

/** Membership, not a slice: a seventh headline metric added tomorrow lands
 * behind the disclosure rather than silently becoming a fifth money tile. */
export function splitHeadlineMetrics<T extends { metric: InitiativeMetric }>(
  entries: readonly T[]
): { money: T[]; behindDisclosure: T[] } {
  const money: T[] = []
  const behindDisclosure: T[] = []
  for (const entry of entries) {
    if (MONEY_TILE_METRICS.includes(entry.metric)) money.push(entry)
    else behindDisclosure.push(entry)
  }
  return { money, behindDisclosure }
}

export interface ReportAgentRowValues {
  /** null ONLY for the deleted-agents catch-all row. */
  agentId: string | null
  name: string
  usageEvents: number
  cost: number
  /** Usage fees only. */
  earned: number
  /** Every fee on this agent's subscriptions, which is the basis
   *  the Revenue tile and the comparison use. */
  revenue: number
  /** On the Earned basis, which is what deriveAgentRows computes. The cells
   *  recompute it for whichever column the reader picked. */
  marginPercent: number | null
}

/** Which revenue the table shows for each agent. Product rule: keep
 * both and let the reader pick, rather than choosing for them. */
export type RevenueBasis = 'earned' | 'total'

/** Total revenue, so one screen holds ONE definition of revenue by default:
 * the tile, the table total and the comparison's Revenue row all agree until
 * the reader deliberately narrows the column to usage fees. */
export const DEFAULT_REVENUE_BASIS: RevenueBasis = 'total'

export const REVENUE_BASIS_OPTIONS: readonly {
  id: RevenueBasis
  label: string
}[] = [
  { id: 'earned', label: 'Earned' },
  { id: 'total', label: 'Total revenue' },
]

const REVENUE_BASIS_IDS: ReadonlySet<string> = new Set(
  REVENUE_BASIS_OPTIONS.map((option) => option.id)
)

/** Narrows an arbitrary `?revenue=` value, the resolveRoiTab rule: a stale
 * bookmark falls back to the default rather than rendering a bare column. */
export function resolveRevenueBasis(
  value: string | null | undefined
): RevenueBasis {
  return value !== null && value !== undefined && REVENUE_BASIS_IDS.has(value)
    ? (value as RevenueBasis)
    : DEFAULT_REVENUE_BASIS
}

/** The screen's columns: the print's list minus the revenue column the reader
 * did not pick. */
export type ReportAgentColumn = (typeof REPORT_COPY.agentsTableHeaders)[number]

/** Paper carries both revenue columns, one Margin, and no hover to say which
 *  of the two that percent is a share of, so the header says it. The screen
 *  keeps the bare word. */
export function marginHeaderForBasis(basis: RevenueBasis): string {
  const label = REVENUE_BASIS_OPTIONS.find(
    (option) => option.id === basis
  )?.label
  return `Margin (on ${label})`
}

export function reportAgentsTableHeaders(
  basis: RevenueBasis
): ReportAgentColumn[] {
  const dropped = basis === 'earned' ? 'Total revenue' : 'Earned'
  return REPORT_COPY.agentsTableHeaders.filter((header) => header !== dropped)
}

export interface ReportAgentRowCells {
  key: string
  name: string
  usageEvents: string
  cost: string
  earned: string
  revenue: string
  chosenRevenue: string
  margin: string
}

export interface ReportTotalsCells {
  label: string
  usageEvents: string
  cost: string
  earned: string
  revenue: string
}

/** The shape InfoTooltip and TileHeader take. Declared here rather than
 * imported so this module stays framework-free. */
export interface RoiTooltip {
  title: string
  description: string
  details?: string
}

export interface ReportMetricTile {
  key: InitiativeMetric
  label: string
  value: string
  definition: string
  /** The definition and the scope caveat, one hover away instead of two grey
   * lines under every tile. */
  tooltip: RoiTooltip
  /** Extra lines under the number: as-of-today, why it's a dash, which goal. */
  notes: string[]
  /** notes minus the ones the hover carries. The print renders `notes`,
   * because paper cannot ask a tooltip anything. */
  screenNotes: string[]
  /** Built from the SAME read the tile renders, so the tile and the goal
   * dialog can never show two numbers. */
  example: MetricExample
}

export interface ReportWindow {
  startDate: string
  endDate: string
}

/** Live agents that recorded at least one usage event. A row with none is in
 * the table for its subscription revenue, so counting it makes the lead
 * sentence claim recordings the rows under it disprove. */
export function countRecordingAgents(rows: ReportAgentRowValues[]): number {
  return rows.filter((row) => row.agentId !== null && row.usageEvents > 0)
    .length
}

export function reportLeadSentence(input: {
  startDate: string
  endDate: string
  agentsThatRecorded: number
  usageEvents: number
  cost: number
  /** True when the catch-all row is present, so the total outgrows the count. */
  includesDeletedAgents: boolean
}): string {
  const events = `${input.usageEvents.toLocaleString()} usage event${
    input.usageEvents === 1 ? '' : 's'
  }`
  const sentence =
    `Between ${formatDisplayDate(input.startDate)} and ${formatDisplayDate(
      input.endDate
    )}, ` +
    `${input.agentsThatRecorded.toLocaleString()} of your agents recorded ${events} and cost ${formatCost(
      input.cost
    )}.`
  return input.includesDeletedAgents
    ? `${sentence}${REPORT_COPY.deletedAgentsClause}`
    : sentence
}

export function reportEmptySentence(window: ReportWindow): string {
  return (
    `Nothing recorded between ${formatDisplayDate(
      window.startDate
    )} and ${formatDisplayDate(window.endDate)}. ` +
    'Widen the dates, or connect an agent and this table fills itself.'
  )
}

/**
 * ONE key per row, so the checkbox the customer ticks and the row the
 * comparison sums are the same thing by construction rather than by two
 * matching string literals.
 */
export function reportAgentRowKey(row: Pick<ReportAgentRowValues, 'agentId'>) {
  return row.agentId ?? 'deleted-agents'
}

export function reportAgentRowCells(
  row: ReportAgentRowValues,
  basis: RevenueBasis = DEFAULT_REVENUE_BASIS
): ReportAgentRowCells {
  const chosen = basis === 'earned' ? row.earned : row.revenue
  return {
    key: reportAgentRowKey(row),
    name: row.name,
    usageEvents: row.usageEvents.toLocaleString(),
    cost: formatCost(row.cost),
    earned: formatCost(row.earned),
    revenue: formatCost(row.revenue),
    chosenRevenue: formatCost(chosen),
    // Recomputed from the chosen column rather than read off the row: a
    // Margin percent of a revenue figure the reader is not looking at is a
    // number nothing on the screen explains.
    margin: formatPct(safeMarginPercent(chosen, chosen - row.cost)),
  }
}

/**
 * The totals row. Takes the canon totals and nothing else on purpose: with no
 * rows argument, re-summing them here is not expressible, so the table footer
 * and the Cost tile can never drift apart.
 */
export function reportTotalsCells(totals: {
  usageEvents: number
  cost: number
  earned: number
  revenue: number
}): ReportTotalsCells {
  return {
    label: REPORT_COPY.totalsRowLabel,
    usageEvents: totals.usageEvents.toLocaleString(),
    cost: formatCost(totals.cost),
    earned: formatCost(totals.earned),
    revenue: formatCost(totals.revenue),
  }
}

/**
 * The per-agent split of ONE getRevenueMetrics read.
 * getAgentEarned drops a subscription with no usage events, which is exactly
 * the monthly-fee-only row the Total revenue column has to show, so the action
 * reads canon once and splits it here instead.
 */
export interface AgentSubscriptionRevenue {
  agentId: string
  revenue: number
  usageRevenue: number
  eventCount: number
}

/** The Earned rule applied to the Revenue read: usage fees only, and only
 * for a subscription that carries usage. */
export function usageOnlyAgentRevenue(
  rows: readonly AgentSubscriptionRevenue[]
): Array<{ agentId: string; revenue: number }> {
  return rows
    .filter((row) => row.usageRevenue > 0 || row.eventCount > 0)
    .map((row) => ({ agentId: row.agentId, revenue: row.usageRevenue }))
}

/**
 * Total revenue per agent, keyed the way the table is: null is the
 * deleted-agents catch-all, the deriveAgentRows rule, so the rows still sum to
 * the canon total when a customer has deleted an agent that still has money
 * against it.
 */
export function totalRevenueByAgent(
  rows: readonly AgentSubscriptionRevenue[],
  liveAgentIds: ReadonlySet<string>
): Map<string | null, number> {
  const byAgent = new Map<string | null, number>()
  for (const row of rows) {
    const key = liveAgentIds.has(row.agentId) ? row.agentId : null
    byAgent.set(key, (byAgent.get(key) ?? 0) + row.revenue)
  }
  return byAgent
}

/** Composed once so the action and its test hold the SAME rows. A live agent
 *  with nothing against it drops out; a deleted agent still billing a monthly
 *  fee does not, or the column stops adding up to its own total. */
export function composeReportAgentRows(
  agents: AgentInventoryRow[],
  usageEventRows: Array<Pick<BreakdownRow, 'key' | 'cost' | 'eventCount'>>,
  bySubscription: readonly AgentSubscriptionRevenue[]
): ReportAgentRowValues[] {
  const liveAgentIds = new Set(agents.map((agent) => agent.id))
  const derived = deriveAgentRows(
    agents,
    usageEventRows,
    usageOnlyAgentRevenue(bySubscription),
    bySubscription.map((row) => row.agentId)
  )
  const revenueByAgent = totalRevenueByAgent(bySubscription, liveAgentIds)

  return derived.rows
    .map((row) => ({
      agentId: row.agentId,
      name: row.name,
      usageEvents: row.tasks,
      cost: row.cost,
      earned: row.earned,
      revenue: revenueByAgent.get(row.agentId) ?? 0,
      marginPercent: row.marginPercent,
    }))
    .filter(
      (row) =>
        row.usageEvents > 0 ||
        row.cost !== 0 ||
        row.earned !== 0 ||
        row.revenue !== 0
    )
}

/** These come from getRevenueMetrics, whose cost is subscription-filtered.
 * The Cost family comes from the breakdown, which filters on nothing. */
const SUBSCRIPTION_SCOPED_METRICS: ReadonlySet<InitiativeMetric> = new Set([
  'revenue',
  'margin',
  'marginPercent',
])

/** Tiles the check marks never touch. Each one says so, so a reader hovering
 * the count or the average knows why it disagrees with the comparison. */
const EVERY_AGENT_METRICS: ReadonlySet<InitiativeMetric> = new Set([
  'cost',
  'eventCount',
  'costPerTask',
])

export function reportMetricTile(
  entry: ReportMetricValue,
  opts: {
    trackedByGoal?: string | null
    window?: ReportWindow | null
    /** Finished things left OUT of this tile's number. The tile has to say
     *  so, or the count stops meaning what its definition says it means.
     *  THINGS, not records: the table this sentence points at sums quantity,
     *  and two numbers for one quantity cannot disagree on the same screen. */
    finishedThings?: number
  } = {}
): ReportMetricTile {
  const notes: string[] = []
  if (SUBSCRIPTION_SCOPED_METRICS.has(entry.metric)) {
    notes.push(REPORT_COPY.revenueScopeNote)
  }
  if (entry.metric === 'eventCount' && (opts.finishedThings ?? 0) > 0) {
    notes.push(FINISHED_WORK_COPY.usageEventsTileLine(opts.finishedThings!))
  }
  if (entry.metric === 'mrr' || entry.metric === 'arr') {
    notes.push(REPORT_COPY.asOfTodayNote)
  }
  if (entry.unavailable?.reason === 'window-too-wide') {
    notes.push(REPORT_COPY.unmappedOverWindowCap(entry.unavailable.capDays))
  }
  if (opts.trackedByGoal) {
    notes.push(REPORT_COPY.trackedByGoal(opts.trackedByGoal))
  }

  const label = INITIATIVE_METRIC_META[entry.metric].label
  return {
    key: entry.metric,
    label,
    value: formatMetricValue(entry.metric, entry.value),
    definition: METRIC_DESCRIPTIONS[entry.metric],
    tooltip: metricTileTooltip(entry.metric, label),
    notes,
    screenNotes: notes.filter((note) => note !== REPORT_COPY.revenueScopeNote),
    example: metricExample(entry, opts.window ?? null),
  }
}

/**
 * Title from the tile's own label, so the hover and the tile cannot name the
 * number two different things. Sentence from METRIC_DESCRIPTIONS, which the
 * print and GET /api/roi/report render too.
 */
function metricTileTooltip(
  metric: InitiativeMetric,
  label: string
): RoiTooltip {
  const details = EVERY_AGENT_METRICS.has(metric)
    ? roiMetricTileDetails.everyAgent
    : metric === 'marginPercent'
      ? roiMetricTileDetails.marginPercent
      : SUBSCRIPTION_SCOPED_METRICS.has(metric)
        ? REPORT_COPY.revenueVsCostScope
        : undefined
  return {
    title: label,
    // The count's own sentence says what a usage event IS, which is the
    // question a reader hovering this tile is actually asking.
    description:
      metric === 'eventCount'
        ? REPORT_COPY.usageEventDefinition
        : METRIC_DESCRIPTIONS[metric],
    ...(details === undefined ? {} : { details }),
  }
}

/* "See an example", for every metric in the dropdown. */

export const METRIC_EXAMPLE_COPY = {
  buttonLabel: 'See an example',
  hideLabel: 'Hide the example',
  illustrativePrefix: 'Example, not your data.',
  unavailable:
    "Couldn't measure that right now. This number comes from the same read your ROI page uses, so refreshing the page usually fixes it.",
} as const

/**
 * ONE illustrative organization, so three metrics in a row tell one coherent
 * story. Write every derived field as its arithmetic, never as a typed-in
 * result, or the consistency the test asserts stops holding.
 */
const ILLUSTRATIVE_COST = 5012.4
const ILLUSTRATIVE_REVENUE = 41800
const ILLUSTRATIVE_USAGE_EVENTS = 12225
const ILLUSTRATIVE_INTERNAL_COST = 1210.15
const ILLUSTRATIVE_MRR = 4200

export const ILLUSTRATIVE_METRICS: Record<InitiativeMetric, number> = {
  cost: ILLUSTRATIVE_COST,
  revenue: ILLUSTRATIVE_REVENUE,
  margin: ILLUSTRATIVE_REVENUE - ILLUSTRATIVE_COST,
  marginPercent:
    ((ILLUSTRATIVE_REVENUE - ILLUSTRATIVE_COST) / ILLUSTRATIVE_REVENUE) * 100,
  costPerTask: ILLUSTRATIVE_COST / ILLUSTRATIVE_USAGE_EVENTS,
  eventCount: ILLUSTRATIVE_USAGE_EVENTS,
  unmappedCount: 18,
  mrr: ILLUSTRATIVE_MRR,
  arr: ILLUSTRATIVE_MRR * 12,
  newCustomers: 7,
  internalCost: ILLUSTRATIVE_INTERNAL_COST,
  externalCost: ILLUSTRATIVE_COST - ILLUSTRATIVE_INTERNAL_COST,
}

/**
 * Used by BOTH the real and the illustrative line, so each is worded about the
 * metric rather than the reader: an illustrative line must never claim a
 * number is theirs. TOTAL over InitiativeMetric, like the registries above.
 */
export const METRIC_EXAMPLE_NOTES: Record<InitiativeMetric, string> = {
  cost: 'That number is every usage event in the window, summed from real costs.',
  revenue:
    'That number is the recurring fees, seat fees, usage and one-time charges your subscriptions earned in the window.',
  margin:
    'That number is revenue minus the cost of the usage events billed to a subscription.',
  marginPercent: 'That number is margin as a share of revenue.',
  costPerTask: 'That number is cost divided by usage events.',
  eventCount: 'That number counts the calls an integration records.',
  unmappedCount: 'That number counts usage signals still waiting on a GL code.',
  mrr: 'That number reads active contracts as of today, not the window.',
  arr: 'That number is monthly recurring revenue times 12, as of today.',
  newCustomers: 'That number counts the customers created in the window.',
  internalCost: 'That number is the cost from users flagged internal.',
  externalCost: 'That number is the cost from everyone not flagged internal.',
}

export type MetricExampleKind = 'real' | 'illustrative' | 'unavailable'

export interface MetricExample {
  kind: MetricExampleKind
  line: string
}

/**
 * There is no fourth case: a failed read shows words and no number at all,
 * because a plausible figure with nothing behind it is worse than no answer.
 */
export function metricExample(
  entry: ReportMetricValue | null,
  window: ReportWindow | null
): MetricExample {
  if (entry === null || window === null) {
    return { kind: 'unavailable', line: METRIC_EXAMPLE_COPY.unavailable }
  }
  if (entry.unavailable?.reason === 'window-too-wide') {
    return {
      kind: 'unavailable',
      line: REPORT_COPY.unmappedOverWindowCap(entry.unavailable.capDays),
    }
  }
  const note = METRIC_EXAMPLE_NOTES[entry.metric]
  if (entry.value === null) {
    return {
      kind: 'illustrative',
      line: `${METRIC_EXAMPLE_COPY.illustrativePrefix} ${formatMetricValue(
        entry.metric,
        ILLUSTRATIVE_METRICS[entry.metric]
      )}. ${note}`,
    }
  }
  return {
    kind: 'real',
    line: `Your numbers for ${formatDisplayDate(
      window.startDate
    )} to ${formatDisplayDate(window.endDate)}: ${formatMetricValue(
      entry.metric,
      entry.value
    )}. ${note}`,
  }
}

/* "Without AI": what your AI cost and earned in these dates,
 * next to what the same work would have cost and earned without it. The
 * without-AI side is always the customer's own estimate, by one of three
 * methods they pick. */

/**
 * Where one number came from: recorded data, something a person typed, or
 * arithmetic with at least one typed number in it. Stamped per number rather
 * than per section, so a figure quoted alone carries its own provenance.
 */
export type ReportProvenance =
  | 'measured'
  /** A split of money we DID measure, across things we DID count. Never a
   *  per-item price anyone recorded — see FINISHED_WORK_COPY.attribution. */
  | 'attributed'
  | 'customer_entered'
  | 'derived_from_customer_input'
  /** The customer told us nothing about their without-AI revenue, so we hold
   *  it equal to the with-AI side and SAY SO. Its own word rather than a null:
   *  a number quoted off a slide has to carry that it was our assumption. */
  | 'assumed_same_as_with_ai'

export interface StampedNumber {
  value: number
  source: ReportProvenance
}

/** Two of the three need no count of finished work, which is the point:
 *  nothing we record tells us how many finished things an org produced. */
export type WithoutAiMethod = 'perItem' | 'peopleTime' | 'periodTotal'

export const WITHOUT_AI_METHODS: readonly WithoutAiMethod[] = [
  'perItem',
  'peopleTime',
  'periodTotal',
]

/** The org-level fields, stored on organizations.roiAssumptions. */
export interface RoiAssumptions {
  method?: WithoutAiMethod
  unitSingular?: string
  unitPlural?: string
  costPerItem?: number
  hoursPerMonth?: number
  hourlyRate?: number
  costPerMonth?: number
  revenuePerMonth?: number
}

/**
 * True for ONE window only, so these ride beside the dates rather than being
 * stored: a count shown against a different date range is a wrong number, not
 * a stale one.
 */
export interface WithoutAiWindowInputs {
  /** What the customer typed. Read back only on an anchored window. */
  unitsCompleted: number | null
  /**
   * How many finished things the meter itself tagged in this
   * window. Null when nothing feeds it. When it is here it wins, and it is the
   * only count that is ever stamped 'measured'.
   */
  measuredCount: number | null
  /**
   * True when the page link names both dates. A typed count belongs to the
   * dates it was typed for, and a rolling window's dates move every day, so
   * the count is read back only when the link pins the window down.
   */
  windowIsAnchored: boolean
  /** null = every agent, which is the default and the URL param's absence. */
  selectedAgentKeys: string[] | null
}

export interface WithoutAiInput {
  window: ReportWindow
  /** The instants the reads ran on: what the day count pro-rates by. */
  resolvedPeriod: ReportWindow
  /** null = not read back yet, which is NOT the same as nothing stored. */
  assumptions: RoiAssumptions | null
  inputs: WithoutAiWindowInputs
  rows: ReportAgentRowValues[]
  /** The canon totals, echoed when the customer has everything checked. */
  totals: {
    usageEvents: number
    cost: number
    earned: number
    revenue: number
  }
  /** What the meter counted, per name. The opening sentence needs the MIX,
   *  not the sum: 4 contracts summarized and 1 slide deck is not 5 contracts. */
  measuredThings: readonly FinishedWorkRecordedThing[]
}

/** One line of the comparison, already rendered. No surface formats money. */
export interface WithoutAiRow {
  heading: string
  withAiLabel: string
  withoutAiLabel: string
  withAi: string
  withoutAi: string
  /** How the estimate was built, in the customer's own numbers. */
  note: string | null
  /** The verdict, same words and same size whichever way it goes. */
  sentence: string
}

export interface WithoutAiStampedRow {
  withAi: StampedNumber
  withoutAi: StampedNumber
  /** Always positive: the word in the sentence carries the direction. */
  difference: StampedNumber
  aiHigher: boolean
  /** Under a cent apart, where a formatted dollar figure stops meaning anything. */
  aboutTheSame: boolean
}

export interface WithoutAiNumbers {
  cost: WithoutAiStampedRow
  /** Never null: with nothing from the customer the without-AI side is held
   *  equal to the with-AI side and stamped 'assumed_same_as_with_ai'. */
  revenue: WithoutAiStampedRow
  /** Cost saved plus revenue gained. */
  net: StampedNumber
  /** Null on "about the same": a boolean would let a consumer claim a win
   *  the page never gave. */
  netFavorsAi: boolean | null
  windowDays: StampedNumber
  unitsCompleted: StampedNumber | null
  costPerItem: StampedNumber | null
  hoursPerMonth: StampedNumber | null
  hourlyRate: StampedNumber | null
  costPerMonth: StampedNumber | null
  revenuePerMonth: StampedNumber | null
}

export interface WithoutAiScope {
  agentKeys: string[]
  allSelected: boolean
  source: 'customer_entered'
}

export type WithoutAiBlock =
  /** Not read back yet. Distinct from 'empty' because "we have nothing from
   *  you" is a false claim about their data while the read is in flight. */
  | { kind: 'loading' }
  | { kind: 'empty'; body: string; buttonLabel: string }
  | {
      kind: 'comparison'
      method: WithoutAiMethod
      intro: string
      cost: WithoutAiRow
      revenue: WithoutAiRow
      /** Where a subscription is created, when nothing bills these agents. */
      revenueNote: string | null
      /** The block's headline: cost saved plus revenue gained, in one
       *  sentence. The cost and revenue verdicts stay on their own rows. */
      netLine: string
      estimateLabel: string
      /**
       * The whole comparison as ONE string, built from the same sentences the
       * rows carry. The print and the JSON render it, the screen renders the
       * rows, so a slide and the page it came from cannot disagree.
       */
      paragraph: string
      scope: WithoutAiScope
      numbers: WithoutAiNumbers
    }

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Gregorian mean month. A monthly figure divided by 30 or 31 would answer a
 * different question in February than in March. */
const DAYS_PER_AVERAGE_MONTH = 365.25 / 12

/** Below this the two sides are the same money, and a formatted difference
 * ("$0.0060 less") reads as precision we do not have. */
const ABOUT_THE_SAME_BELOW = 0.01

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`
}

function sentenceCase(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/** Ends every countMeasuredNote branch: the field is pre-filled and editable,
 * so the helper has to say when editing it is the right move. */
const WITHOUT_AI_COUNT_OVERRIDE_HINT =
  'Change it only if you finished more than the meter saw.'

export const WITHOUT_AI_COPY = {
  heading: 'Without AI',

  intro: (startDate: string, endDate: string) =>
    `We measured what your AI cost between ${formatDisplayDate(
      startDate
    )} and ${formatDisplayDate(
      endDate
    )} for the agents checked in the What you used AI for table, and what those agents brought in. Tell us what the same work cost without AI and we show the difference. Your estimates stay labeled as yours everywhere: on this page, in the print and in the data.`,

  costHeading: 'Cost',
  revenueHeading: 'Revenue',
  withAiLabel: 'With AI, measured',
  withoutAiLabel: 'Without AI, your estimate',
  differenceLabel: 'Difference',
  aboutTheSameCell: 'About the same',

  emptyNoInputs:
    "Tell us what the same work would have cost without AI and we'll show the difference here. We have no way to measure that number, so it has to come from you.",
  emptyButton: 'Estimate without AI',
  editButton: 'Change your numbers',
  emptyNoCount: (unitPlural: string, startDate: string, endDate: string) =>
    `You've told us what one used to cost. Tell us how many ${unitPlural} you finished between ${formatDisplayDate(
      startDate
    )} and ${formatDisplayDate(endDate)} and the comparison appears here.`,
  emptyCountNeedsDates: (unitPlural: string) =>
    `A count belongs to the dates you counted. Pick Month or Custom in this page's date picker, tell us how many ${unitPlural} you finished in those dates, and the comparison appears here.`,
  emptyNoActivity:
    "Nothing was recorded in these dates, so there's no AI cost to compare against. Widen the dates and the comparison appears here.",
  emptyNoAgents:
    "Every agent is unchecked, so there's no AI cost to compare. Check at least one in the What you used AI for table and the comparison comes back.",

  methodQuestion: 'How do you want to estimate what this work cost without AI?',
  methodChoice: {
    perItem: (unitSingular: string) => `Per ${unitSingular}`,
    peopleTime: 'People time',
    periodTotal: 'Period total',
  },

  costPerItemLabel: (unitSingular: string) =>
    `Before AI, one ${unitSingular} cost`,
  countLabel: (unitPlural: string, startDate: string, endDate: string) =>
    `How many ${unitPlural} did you finish between ${formatDisplayDate(
      startDate
    )} and ${formatDisplayDate(endDate)}?`,
  /** Up to three names, then a count of them: a list of eight stops being
   *  read. No names at all is kept for a caller with none. */
  countMeasuredNote: (
    unitPlural: string,
    things: readonly FinishedWorkRecordedThing[] = [],
    total = 0
  ): string => {
    const what =
      things.length === 0
        ? `Your meter tagged these ${unitPlural}, so you don't have to count them.`
        : things.length <= 3
          ? `Your meter counted ${plural(total, 'thing')}: ${renderThingMix(
              things
            )}.`
          : `Your meter counted ${total} finished things across ${things.length} names.`
    return `${what} ${WITHOUT_AI_COUNT_OVERRIDE_HINT}`
  },

  /** One name is the customer's own noun. More than one is a MIX, and the sum
   *  printed under one of those nouns is a number nobody counted: 4 contracts
   *  summarized and 1 slide deck is not 5 contracts summarized. */
  countPhrase: (
    count: number,
    unitPlural: string,
    things: readonly FinishedWorkRecordedThing[]
  ): string => {
    const total = count.toLocaleString()
    if (things.length <= 1) return `${total} ${unitPlural} with AI`
    if (things.length <= 3) {
      return `${total} things with AI: ${renderThingMix(things)}`
    }
    return `${total} things with AI across ${things.length} names`
  },
  countNeedsDatesHelper:
    "A count belongs to specific dates. Pick Month or Custom in this page's date picker and this field is read back.",
  unitSingularLabel: 'What do you call one?',
  unitSingularHelper: `Optional. For example, paper, order or ticket. We use ${WORK_ITEM_NOUN} until you tell us otherwise.`,
  unitPluralLabel: 'And more than one?',
  unitPluralHelper: `Optional. For example, papers, orders or tickets. We use ${WORK_ITEM_NOUN_PLURAL} until you tell us otherwise.`,
  hoursPerMonthLabel: 'About how many hours a month went into this work?',
  hourlyRateLabel: 'At what cost an hour?',
  hourlyRateHelper: '$65,000 a year is about $31 an hour.',
  costPerMonthLabel: 'Before AI, about what did this work cost a month?',
  revenuePerMonthLabel: 'Revenue without AI, about how much a month?',
  revenuePerMonthHelper:
    'Leave it blank and we assume the same revenue as with AI.',

  /** What the without-AI cell reads when the customer has told us nothing.
   *  The row renders either way: a comparison that shows what AI cost and
   *  never what it made is half an answer. */
  revenueAssumedCell: 'Same as with AI, until you tell us',
  revenueAssumedSentence:
    'We assume AI brought in the same until you tell us otherwise.',
  revenueNoSubscription:
    'No subscription bills these agents in these dates, so revenue reads ' +
    '$0.00. Link a plan, a customer and an agent through a subscription: ' +
    'open Unit Economics in the left menu, then the Subscriptions tab, and ' +
    'it shows here.',

  whatSaves:
    'Your method and your numbers are saved for next time. The count lives in this page link, because it only applies to these dates.',
  unitsInvalid:
    "That count has to be a whole number, like 40. It can't have a decimal point or a minus sign. Round it to the nearest one and save again.",

  methodFieldNames: {
    costPerItem: (unitSingular: string) =>
      `what one ${unitSingular} cost before AI`,
    hoursPerMonth: 'the hours a month this work took',
    hourlyRate: 'the cost an hour',
    costPerMonth: 'what this work cost a month before AI',
  },
  methodIncomplete: (missingFieldNames: string[]) =>
    `Nothing was saved. We still need ${joinNames(
      missingFieldNames
    )}, or there's nothing to compare your AI cost against. Fill that in and save again.`,

  saveLabel: 'Save your numbers',
  savedLabel: 'Saved',
  closeLabel: 'Close',
  saveFailed: "Couldn't save your numbers. Try again.",
  readFailed: "Couldn't load your numbers. Refresh to try again.",

  agentScopeColumnLabel: 'Count in the comparison',
  agentScopeRowLabel: (agentName: string) =>
    `Count ${agentName} in the comparison`,
  agentScopeHelper:
    'Uncheck an agent to leave its AI cost out of the comparison and the ' +
    'Finished work tab.',
} as const

/** Past this many, the sentence counts the checked agents instead of naming
 * them: a list of four names mid-paragraph stops being read. */
const MAX_NAMED_AGENTS = 2

/** "Unchecked all of them", which has to survive a reload distinct from
 * "never touched it". No real key (a uuid, or the catch-all) can collide. */
const NO_AGENTS_PARAM = 'none'

/**
 * Whether the page link pins the window down. A count typed against "the last
 * 30 days" would be restated as fact tomorrow, for a window it was never
 * counted for, so the count is read back only when both dates are in the link.
 */
export function windowIsAnchored(params: {
  startDate?: string | null
  endDate?: string | null
}): boolean {
  return Boolean(params.startDate?.trim() && params.endDate?.trim())
}

export function parseUnitsParam(
  raw: string | null | undefined,
  params: { startDate?: string | null; endDate?: string | null }
): number | null {
  if (!windowIsAnchored(params)) return null
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

export interface WindowInputDraft {
  unitsCompleted: string
}

export type WindowInputDraftResult =
  | { ok: true; values: { unitsCompleted: number | null } }
  | { ok: false; error: string }

/**
 * What the inputs panel may commit to the URL. It reads its own output back
 * with the reader above, so a value that reader would refuse is refused in
 * front of the customer rather than saved, echoed as "Saved", and then dropped.
 */
export function parseWindowInputDraft(
  draft: WindowInputDraft
): WindowInputDraftResult {
  const raw = draft.unitsCompleted.trim()
  if (raw === '') return { ok: true, values: { unitsCompleted: null } }
  const anchored = { startDate: 'pinned', endDate: 'pinned' }
  const value = parseUnitsParam(raw, anchored)
  if (value === null || parseUnitsParam(String(value), anchored) !== value) {
    return { ok: false, error: WITHOUT_AI_COPY.unitsInvalid }
  }
  return { ok: true, values: { unitsCompleted: value } }
}

export function parseAgentsParam(
  raw: string | null | undefined
): string[] | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed === NO_AGENTS_PARAM) return []
  return [
    ...new Set(
      trimmed
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
    ),
  ]
}

export function agentsParamValue(keys: string[] | null): string | null {
  if (keys === null) return null
  return keys.length === 0 ? NO_AGENTS_PARAM : keys.join(',')
}

/**
 * One checkbox click, as the URL should carry it: null means every agent.
 * Narrows the selection to the agents on screen BEFORE counting, because a
 * stale key (the roster changes with the dates) would otherwise stand in for
 * a live one and quietly widen the comparison to the org-wide total.
 */
export function toggleAgentSelection(
  agentKeys: string[],
  selectedAgentKeys: string[] | null,
  key: string
): string[] | null {
  const live = new Set(agentKeys)
  if (!live.has(key)) return selectedAgentKeys
  const current =
    selectedAgentKeys === null
      ? [...new Set(agentKeys)]
      : [
          ...new Set(
            selectedAgentKeys.filter((candidate) => live.has(candidate))
          ),
        ]
  const next = current.includes(key)
    ? current.filter((candidate) => candidate !== key)
    : [...current, key]
  return next.length === live.size ? null : next
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "contract summarized x4 and slide deck x1". Never pluralises a name the customer
 *  typed: "slide deck" has no plural we are entitled to invent. */
function renderThingMix(things: readonly FinishedWorkRecordedThing[]): string {
  return joinNames(
    things.map((thing) => `${thing.name} x${thing.howMany.toLocaleString()}`)
  )
}

function agentPhrase(
  selected: ReportAgentRowValues[],
  allSelected: boolean
): string {
  if (allSelected) return 'your AI'
  if (selected.length > MAX_NAMED_AGENTS) {
    return `your ${selected.length.toLocaleString()} selected agents`
  }
  const names = selected.map((row) => row.name)
  return selected.length === 1
    ? `your ${names[0]} agent`
    : `your ${joinNames(names)} agents`
}

export function resolveAgentScope(
  rows: ReportAgentRowValues[],
  selectedAgentKeys: string[] | null
): { rows: ReportAgentRowValues[]; scope: WithoutAiScope } {
  if (selectedAgentKeys === null) {
    return {
      rows,
      scope: {
        agentKeys: rows.map(reportAgentRowKey),
        allSelected: true,
        source: 'customer_entered',
      },
    }
  }
  const wanted = new Set(selectedAgentKeys)
  const picked = rows.filter((row) => wanted.has(reportAgentRowKey(row)))
  return {
    rows: picked,
    scope: {
      agentKeys: picked.map(reportAgentRowKey),
      allSelected: rows.length > 0 && picked.length === rows.length,
      source: 'customer_entered',
    },
  }
}

/** The noun for one finished thing: the customer's word when they gave us one,
 * the product's placeholder otherwise. Never invented from the other form. */
export function resolveUnitNouns(assumptions: RoiAssumptions): {
  singular: string
  plural: string
} {
  const singular = assumptions.unitSingular?.trim()
  const plural = assumptions.unitPlural?.trim()
  return {
    singular: singular || WORK_ITEM_NOUN,
    plural: plural || WORK_ITEM_NOUN_PLURAL,
  }
}

/**
 * The days this window actually covers, from the instants the reads ran on.
 * The display dates cannot answer it: "Aug 22 to Sep 21" is 30 days of a
 * rolling window and 31 days of a calendar month, and the difference is a
 * whole day of a monthly estimate.
 */
export function windowDayCount(resolvedPeriod: ReportWindow): number {
  const span =
    Date.parse(resolvedPeriod.endDate) - Date.parse(resolvedPeriod.startDate)
  if (!Number.isFinite(span)) return 1
  return Math.max(1, Math.round(span / MS_PER_DAY))
}

/** methodIsComplete reads this same list, so the panel and the page can never
 *  disagree about whether a method is ready to compare. */
export function missingMethodFields(
  method: WithoutAiMethod,
  assumptions: RoiAssumptions
): string[] {
  const names = WITHOUT_AI_COPY.methodFieldNames
  if (method === 'perItem') {
    return assumptions.costPerItem === undefined
      ? [names.costPerItem(resolveUnitNouns(assumptions).singular)]
      : []
  }
  if (method === 'peopleTime') {
    return [
      ...(assumptions.hoursPerMonth === undefined ? [names.hoursPerMonth] : []),
      ...(assumptions.hourlyRate === undefined ? [names.hourlyRate] : []),
    ]
  }
  return assumptions.costPerMonth === undefined ? [names.costPerMonth] : []
}

export function methodIsComplete(
  method: WithoutAiMethod,
  assumptions: RoiAssumptions
): boolean {
  return missingMethodFields(method, assumptions).length === 0
}

/**
 * The units precedence rule. The field is
 * pre-filled with the meter's count and editable, so a count in the page link
 * means the customer typed one over it and the number is theirs. With nothing
 * typed, the meter's count stands and is the only count ever stamped
 * 'measured'. The surface only writes the link when the typed number differs
 * from the meter's, so saving an unrelated field cannot restamp the count.
 */
function resolveFinishedCount(
  inputs: WithoutAiWindowInputs
): StampedNumber | null {
  if (inputs.unitsCompleted !== null) {
    return { value: inputs.unitsCompleted, source: 'customer_entered' }
  }
  if (inputs.measuredCount !== null) {
    return { value: inputs.measuredCount, source: 'measured' }
  }
  return null
}

function stampedRow(
  withAi: number,
  withoutAi: number,
  withoutAiSource: ReportProvenance = 'derived_from_customer_input'
): WithoutAiStampedRow {
  const difference = Math.abs(withAi - withoutAi)
  // A gap measured against a number WE assumed is ours, not the customer's:
  // stamping it otherwise lets a consumer present our figure as theirs.
  const differenceSource: ReportProvenance =
    withoutAiSource === 'assumed_same_as_with_ai'
      ? 'assumed_same_as_with_ai'
      : 'derived_from_customer_input'
  return {
    withAi: { value: withAi, source: 'measured' },
    withoutAi: { value: withoutAi, source: withoutAiSource },
    difference: { value: difference, source: differenceSource },
    aiHigher: withAi > withoutAi,
    aboutTheSame: difference < ABOUT_THE_SAME_BELOW,
  }
}

const stamped = (
  value: number | undefined,
  source: ReportProvenance
): StampedNumber | null => (value === undefined ? null : { value, source })

/** Pure, and the ONLY builder: the page, the print and the JSON route all
 *  call it, so none of them can disagree with the others. */
export function buildWithoutAi(input: WithoutAiInput): WithoutAiBlock {
  const {
    window,
    resolvedPeriod,
    assumptions,
    inputs,
    rows,
    totals,
    measuredThings,
  } = input
  if (assumptions === null) return { kind: 'loading' }

  const empty = (body: string): WithoutAiBlock => ({
    kind: 'empty',
    body,
    buttonLabel: WITHOUT_AI_COPY.emptyButton,
  })

  const method = assumptions.method
  if (method === undefined || !methodIsComplete(method, assumptions)) {
    return empty(WITHOUT_AI_COPY.emptyNoInputs)
  }

  const nouns = resolveUnitNouns(assumptions)
  const count = resolveFinishedCount(inputs)

  // Before the count question: an empty window has nothing to count against.
  if (rows.length === 0) return empty(WITHOUT_AI_COPY.emptyNoActivity)
  if (method === 'perItem' && count === null) {
    return empty(
      inputs.windowIsAnchored
        ? WITHOUT_AI_COPY.emptyNoCount(
            nouns.plural,
            window.startDate,
            window.endDate
          )
        : WITHOUT_AI_COPY.emptyCountNeedsDates(nouns.plural)
    )
  }

  const { rows: selectedRows, scope } = resolveAgentScope(
    rows,
    inputs.selectedAgentKeys
  )
  if (selectedRows.length === 0) return empty(WITHOUT_AI_COPY.emptyNoAgents)

  const days = windowDayCount(resolvedPeriod)
  const proRate = (monthly: number) => (monthly * days) / DAYS_PER_AVERAGE_MONTH
  const proRatedTo = `pro-rated to ${plural(days, 'day')}`

  // Everything checked ECHOES the canon totals rather than re-summing, the
  // same rule the totals row keeps. A partial selection is the one case where
  // a sum is the only way to answer, and it is the customer's own subset.
  const aiCost = scope.allSelected
    ? totals.cost
    : selectedRows.reduce((sum, row) => sum + row.cost, 0)

  let withoutAiCost: number
  let costNote: string
  if (method === 'perItem') {
    withoutAiCost = assumptions.costPerItem! * count!.value
    costNote = `per ${nouns.singular}: ${count!.value.toLocaleString()} ${
      nouns.plural
    } at ${formatCost(assumptions.costPerItem!)} each`
  } else if (method === 'peopleTime') {
    withoutAiCost = proRate(
      assumptions.hoursPerMonth! * assumptions.hourlyRate!
    )
    costNote = `people time: ${plural(
      assumptions.hoursPerMonth!,
      'hour'
    )} a month at ${formatCost(assumptions.hourlyRate!)} an hour, ${proRatedTo}`
  } else {
    withoutAiCost = proRate(assumptions.costPerMonth!)
    costNote = `period total: ${formatCost(
      assumptions.costPerMonth!
    )} a month, ${proRatedTo}`
  }

  const costNumbers = stampedRow(aiCost, withoutAiCost)
  const costSentence = costNumbers.aboutTheSame
    ? 'AI cost you about the same.'
    : `AI cost you ${formatCost(costNumbers.difference.value)} ${
        costNumbers.aiHigher ? 'more' : 'less'
      }.`

  const cost: WithoutAiRow = {
    heading: WITHOUT_AI_COPY.costHeading,
    withAiLabel: WITHOUT_AI_COPY.withAiLabel,
    withoutAiLabel: WITHOUT_AI_COPY.withoutAiLabel,
    withAi: formatCost(aiCost),
    withoutAi: formatCost(withoutAiCost),
    note: costNote,
    sentence: costSentence,
  }

  // The same rule the cost row keeps: echo the canon total when everything is
  // checked, sum the customer's own subset otherwise. Total revenue, not
  // usage-only, so this row and the Revenue tile are the same dollars.
  const aiRevenue = scope.allSelected
    ? totals.revenue
    : selectedRows.reduce((sum, row) => sum + row.revenue, 0)

  const monthlyRevenue = assumptions.revenuePerMonth
  const revenueAssumed = monthlyRevenue === undefined
  const revenueNumbers = revenueAssumed
    ? stampedRow(aiRevenue, aiRevenue, 'assumed_same_as_with_ai')
    : stampedRow(aiRevenue, proRate(monthlyRevenue!))

  const revenue: WithoutAiRow = {
    heading: WITHOUT_AI_COPY.revenueHeading,
    withAiLabel: WITHOUT_AI_COPY.withAiLabel,
    withoutAiLabel: WITHOUT_AI_COPY.withoutAiLabel,
    withAi: formatCost(revenueNumbers.withAi.value),
    withoutAi: revenueAssumed
      ? WITHOUT_AI_COPY.revenueAssumedCell
      : formatCost(revenueNumbers.withoutAi.value),
    note: revenueAssumed
      ? null
      : `${formatCost(monthlyRevenue!)} a month, ${proRatedTo}`,
    sentence: revenueAssumed
      ? WITHOUT_AI_COPY.revenueAssumedSentence
      : revenueNumbers.aboutTheSame
        ? 'AI brought in about the same.'
        : `AI brought in ${formatCost(revenueNumbers.difference.value)} ${
            revenueNumbers.aiHigher ? 'more' : 'less'
          }.`,
  }

  // A $0.00 row with no explanation reads as a broken product, and it is
  // almost always an org that never linked a subscription. It renders against
  // an estimate too: that is where the headline says AI left them worse off.
  const revenueNote =
    aiRevenue === 0 ? WITHOUT_AI_COPY.revenueNoSubscription : null

  const net =
    withoutAiCost -
    aiCost +
    (revenueNumbers.withAi.value - revenueNumbers.withoutAi.value)
  const netAboutTheSame = Math.abs(net) < ABOUT_THE_SAME_BELOW
  const netFavorsAi = netAboutTheSame ? null : net >= 0
  const netLine = netAboutTheSame
    ? 'About the same either way in these dates.'
    : `AI left you ${formatCost(Math.abs(net))} ${
        netFavorsAi ? 'better' : 'worse'
      } off in these dates.`

  const dateSpan = `${formatDisplayDate(
    window.startDate
  )} and ${formatDisplayDate(window.endDate)}`
  const phrase = agentPhrase(selectedRows, scope.allSelected)
  const opening =
    count === null
      ? `Between ${dateSpan}, ${phrase} cost ${cost.withAi}.`
      : `Between ${dateSpan} you finished ${WITHOUT_AI_COPY.countPhrase(
          count.value,
          nouns.plural,
          // A typed count has no names behind it, so it never states a mix.
          count.source === 'measured' ? measuredThings : []
        )}. ${sentenceCase(phrase)} cost ${cost.withAi}.`

  // countPhrase's rule, two sentences later: one recorded name is the
  // customer's own noun, a mix of names under that noun is a claim nobody
  // recorded. The opening refuses it, so the trailer cannot make it.
  const meterTagged =
    measuredThings.length <= 1
      ? `Your meter tagged the ${nouns.plural}.`
      : 'Your meter tagged them.'
  const trailer =
    count === null
      ? 'The without-AI figures are yours, not ours.'
      : count.source === 'measured'
        ? `${meterTagged} The without-AI figures are yours, not ours.`
        : 'The count and the without-AI figures are yours, not ours.'

  const paragraph = [
    opening,
    `Without AI, by your own estimate, the same work would have cost ${cost.withoutAi} (${costNote}).`,
    cost.sentence,
    revenueAssumed
      ? `Your AI brought in ${revenue.withAi}.`
      : `Your AI brought in ${revenue.withAi} and you estimate ${revenue.withoutAi} without AI.`,
    revenue.sentence,
    netLine,
    trailer,
  ].join(' ')

  return {
    kind: 'comparison',
    method,
    intro: WITHOUT_AI_COPY.intro(window.startDate, window.endDate),
    cost,
    revenue,
    revenueNote,
    netLine,
    estimateLabel: estimateLabelFor(method, nouns.singular, revenueAssumed),
    paragraph,
    scope,
    numbers: {
      cost: costNumbers,
      revenue: revenueNumbers,
      net: {
        value: net,
        source: revenueAssumed
          ? 'assumed_same_as_with_ai'
          : 'derived_from_customer_input',
      },
      netFavorsAi,
      windowDays: { value: days, source: 'measured' },
      unitsCompleted: count,
      costPerItem: stamped(assumptions.costPerItem, 'customer_entered'),
      hoursPerMonth: stamped(assumptions.hoursPerMonth, 'customer_entered'),
      hourlyRate: stamped(assumptions.hourlyRate, 'customer_entered'),
      costPerMonth: stamped(assumptions.costPerMonth, 'customer_entered'),
      revenuePerMonth: stamped(assumptions.revenuePerMonth, 'customer_entered'),
    },
  }
}

/**
 * The Difference cell of the on-screen comparison table: the same gap the
 * row's verdict sentence states, plus what share of the estimate it is.
 *
 * Deliberately not a field on WithoutAiRow. The print and the JSON render the
 * sentence, and a new field on the row would change GET /api/roi/report.
 */
export function comparisonDifferenceCell(row: WithoutAiStampedRow): string {
  if (row.aboutTheSame) return WITHOUT_AI_COPY.aboutTheSameCell
  const direction = row.aiHigher ? 'more' : 'less'
  const dollars = `${formatCost(row.difference.value)} ${direction}`
  const base = row.withoutAi.value
  if (base <= 0) return dollars
  // Floored, not rounded: 99.95% of an estimate is not all of it, and
  // "100.0% less" beside a measured cost of $2.46 says the work was free.
  const share = Math.floor((row.difference.value / base) * 1000) / 10
  return `${dollars} (${formatPct(share)})`
}

/** The stamp under the comparison, naming the method in the customer's words
 * rather than the union member's spelling. */
export function estimateLabelFor(
  method: WithoutAiMethod,
  unitSingular: string,
  revenueAssumed = false
): string {
  const how =
    method === 'perItem'
      ? `from what you told us one ${unitSingular} used to cost`
      : method === 'peopleTime'
        ? 'from the hours a month and the cost an hour you gave us'
        : 'from the monthly total you gave us'
  const label = `Estimate. We measured the with-AI side. The without-AI side is your estimate, ${how}.`
  return revenueAssumed
    ? `${label} We assume your revenue without AI matched what AI brought in.`
    : label
}

/* The printed page and the JSON read, composed HERE from
 * the builders the screen calls so neither can say something the page does
 * not. Pure, like everything above it: no fetching, no formatting. */

/** Exactly what the report already read, plus what the customer typed. The
 * screen, the print and the JSON are three renderings of this one input. */
export interface ReportSurfaceInput {
  window: ReportWindow
  resolvedPeriod: ReportWindow
  agents: {
    rows: ReportAgentRowValues[]
    totals: {
      usageEvents: number
      cost: number
      earned: number
      revenue: number
    }
  }
  metrics: ReportMetricValue[]
  assumptions: RoiAssumptions | null
  inputs: WithoutAiWindowInputs
  /** null when the read did not ask for finished work. */
  finishedWork: ReportFinishedWorkReads | null
  /** Which revenue column the reader is on. The print follows the screen, so
   *  the Margin column reads the same on both. */
  revenueBasis?: RevenueBasis
}

/** The three lists getCostBreakdown's finishedWork option returns, plus the
 *  count the Usage events tile subtracts. */
export interface ReportFinishedWorkReads {
  things: FinishedThingRow[]
  buckets: FinishedWorkBucketRow[]
  namedUsage: NamedUsageRow[]
  /** Usage RECORDS the Usage events tile subtracted. */
  excludedFromUsageEvents: number
  /** Finished THINGS those records carry, which is what the sentence beside
   *  the tile counts. One record can carry a count of three. */
  finishedThings: number
}

/**
 * Scoped by the same checkboxes the comparison uses. A partial selection can
 * only name live agents, so the deleted-agents catch-all contributes nothing
 * until every box is checked.
 */
export function surfaceFinishedWork(
  input: Pick<
    ReportSurfaceInput,
    'window' | 'agents' | 'inputs' | 'finishedWork'
  >
): FinishedWorkBlock | null {
  if (input.finishedWork === null) return null
  const { scope } = resolveAgentScope(
    input.agents.rows,
    input.inputs.selectedAgentKeys
  )
  return buildFinishedWork({
    window: input.window,
    things: input.finishedWork.things,
    buckets: input.finishedWork.buckets,
    namedUsage: input.finishedWork.namedUsage,
    agentScope: scope.allSelected
      ? null
      : {
          checkedAgentKeys: new Set(scope.agentKeys),
          agentsInTable: input.agents.rows.length,
        },
  })
}

export interface PrintAgentRow extends ReportAgentRowCells {
  /** The rendered word, not a boolean: the print holds no copy of its own. */
  counted: string
}

export interface PrintWithoutAi {
  heading: string
  cost: WithoutAiRow
  revenue: WithoutAiRow
  revenueNote: string | null
  netLine: string
  paragraph: string
  estimateLabel: string
}

export interface PrintReport {
  datesLine: string
  agentsHeading: string
  leadSentence: string
  tableHeaders: string[]
  rows: PrintAgentRow[]
  totals: ReportTotalsCells | null
  usageEventDefinition: string
  /** The same block the screen renders, after the agents table. */
  finishedWork: FinishedWorkBlock | null
  metricsHeading: string
  metrics: ReportMetricTile[]
  /** Non-null only when the check marks narrowed things, same rule the screen
   *  applies. Paper shows both Cost numbers, so paper has to say why. */
  everyAgentTilesNote: string | null
  withoutAi: PrintWithoutAi | null
  proxyGap: string
  hoursNote: string
}

function surfaceWithoutAi(input: ReportSurfaceInput): WithoutAiBlock {
  const finished = surfaceFinishedWork(input)
  return buildWithoutAi({
    window: input.window,
    resolvedPeriod: input.resolvedPeriod,
    assumptions: input.assumptions,
    // The meter's own count beats a typed one, and it is read from the SAME
    // block the table renders rather than summed a second time.
    inputs: {
      ...input.inputs,
      measuredCount:
        finished === null ? null : finishedWorkMeasuredCount(finished),
    },
    rows: input.agents.rows,
    totals: input.agents.totals,
    measuredThings:
      finished === null ? [] : finishedWorkRecordedThings(finished),
  })
}

export function buildPrintReport(
  input: ReportSurfaceInput & {
    trackedByGoal?: Partial<Record<InitiativeMetric, string>>
  }
): PrintReport {
  const { window, agents, metrics, inputs } = input
  const hasActivity = agents.rows.length > 0
  const { scope } = resolveAgentScope(agents.rows, inputs.selectedAgentKeys)
  const counted = new Set(scope.agentKeys)
  const block = surfaceWithoutAi(input)

  return {
    datesLine: REPORT_COPY.printDatesLine(window.startDate, window.endDate),
    agentsHeading: REPORT_COPY.agentsHeading,
    leadSentence: hasActivity
      ? reportLeadSentence({
          ...window,
          agentsThatRecorded: countRecordingAgents(agents.rows),
          usageEvents: agents.totals.usageEvents,
          cost: agents.totals.cost,
          includesDeletedAgents: agents.rows.some(
            (row) => row.agentId === null
          ),
        })
      : reportEmptySentence(window),
    tableHeaders: [
      ...REPORT_COPY.agentsTableHeaders.map((header) =>
        header === 'Margin'
          ? marginHeaderForBasis(input.revenueBasis ?? DEFAULT_REVENUE_BASIS)
          : header
      ),
      WITHOUT_AI_COPY.agentScopeColumnLabel,
    ],
    rows: agents.rows.map((row) => ({
      ...reportAgentRowCells(row, input.revenueBasis),
      counted: counted.has(reportAgentRowKey(row))
        ? REPORT_COPY.agentCounted
        : REPORT_COPY.agentLeftOut,
    })),
    totals: hasActivity ? reportTotalsCells(agents.totals) : null,
    usageEventDefinition: REPORT_COPY.usageEventDefinition,
    finishedWork: surfaceFinishedWork(input),
    metricsHeading: REPORT_COPY.metricsHeading,
    metrics: metrics.map((entry) =>
      reportMetricTile(entry, {
        trackedByGoal: input.trackedByGoal?.[entry.metric] ?? null,
        window,
        finishedThings: input.finishedWork?.finishedThings ?? 0,
      })
    ),
    everyAgentTilesNote:
      hasActivity && !scope.allSelected
        ? REPORT_COPY.everyAgentTilesNote
        : null,
    withoutAi:
      block.kind === 'comparison'
        ? {
            heading: WITHOUT_AI_COPY.heading,
            cost: block.cost,
            revenue: block.revenue,
            revenueNote: block.revenueNote,
            netLine: block.netLine,
            paragraph: block.paragraph,
            estimateLabel: block.estimateLabel,
          }
        : null,
    proxyGap: REPORT_COPY.proxyGap,
    hoursNote: REPORT_COPY.noHours,
  }
}

export interface RoiReportJsonAgent {
  key: string
  name: string
  usageEvents: StampedNumber
  cost: StampedNumber
  /** Usage fees only. */
  earned: StampedNumber
  /** Every fee on this agent's subscriptions. The document carries
   *  BOTH, so a consumer never has to know which column was on screen. */
  revenue: StampedNumber
  /** Named, because the document carries both revenue columns: one unlabeled
   *  percent is a number nothing in it explains. Each is the screen's cell. */
  marginPercentEarned: StampedNumber | null
  marginPercentTotal: StampedNumber | null
  countedInComparison: boolean
}

export interface RoiReportJsonMetric {
  key: InitiativeMetric
  label: string
  definition: string
  /** Dash included: a null value still renders the page's '—'. */
  formatted: string
  /** null when the window has no answer — never a zero standing in for one. */
  value: StampedNumber | null
}

export interface RoiReportJsonFinishedWorkRow {
  name: string
  /** 'recorded' = your team told us. 'integration' = an SDK or MCP client
   *  named the signal it sent and we counted what it sent. */
  source: 'recorded' | 'integration'
  howMany: StampedNumber
  /** null renders the page's dash: counted, but no spend we can tie to it. */
  aiCost: StampedNumber | null
  costForOne: StampedNumber | null
  /** The cost was shared with other things finished on the same work item. */
  split: boolean
}

export interface RoiReportJson {
  /**
   * start/end are the days the report names on screen. resolvedStart/
   * resolvedEnd are the instants the reads ran on, and re-sending THOSE as
   * ?start=&end= is what reproduces these numbers: a bare date re-parses to
   * the whole UTC day, a wider window and therefore different money.
   */
  window: {
    start: string
    end: string
    resolvedStart: string
    resolvedEnd: string
    source: 'measured'
  }
  scope: WithoutAiScope
  whatYouUsedAiFor: {
    agents: RoiReportJsonAgent[]
    totals: {
      usageEvents: StampedNumber
      /** Usage RECORDS left out of usageEvents, so the number above is
       *  reproducible from this document without the page. */
      finishedRecordsExcluded: StampedNumber
      /** The finished THINGS those records carry, which is what the sentence
       *  beside the tile counts and what What you finished sums. */
      finishedThings: StampedNumber
      cost: StampedNumber
      earned: StampedNumber
      revenue: StampedNumber
    }
  }
  whatYouFinished: {
    rows: RoiReportJsonFinishedWorkRow[]
    totals: { howMany: StampedNumber; aiCost: StampedNumber | null }
    honesty: FinishedWorkHonesty
  } | null
  metrics: RoiReportJsonMetric[]
  withoutAi: {
    method: WithoutAiMethod
    intro: string
    paragraph: string
    cost: WithoutAiRow
    revenue: WithoutAiRow
    revenueNote: string | null
    netLine: string
    estimateLabel: string
    numbers: WithoutAiNumbers
  } | null
  honesty: {
    proxyGap: string
    usageEventDefinition: string
    hoursNote: string
  }
}

const MEASURED = (value: number): StampedNumber => ({
  value,
  source: 'measured',
})

/** The same recomputation reportAgentRowCells does for the screen's cell, so
 *  the document and the page can't hold two different percents. */
const stampedMargin = (revenue: number, cost: number): StampedNumber | null => {
  const percent = safeMarginPercent(revenue, revenue - cost)
  return percent === null ? null : MEASURED(percent)
}

export function buildRoiReportJson(input: ReportSurfaceInput): RoiReportJson {
  const { window, resolvedPeriod, agents, metrics, inputs } = input
  const { scope } = resolveAgentScope(agents.rows, inputs.selectedAgentKeys)
  const counted = new Set(scope.agentKeys)
  const block = surfaceWithoutAi(input)
  const finished = surfaceFinishedWork(input)

  return {
    window: {
      start: window.startDate,
      end: window.endDate,
      resolvedStart: resolvedPeriod.startDate,
      resolvedEnd: resolvedPeriod.endDate,
      source: 'measured',
    },
    scope,
    whatYouUsedAiFor: {
      agents: agents.rows.map((row) => ({
        key: reportAgentRowKey(row),
        name: row.name,
        usageEvents: MEASURED(row.usageEvents),
        cost: MEASURED(row.cost),
        earned: MEASURED(row.earned),
        revenue: MEASURED(row.revenue),
        marginPercentEarned: stampedMargin(row.earned, row.cost),
        marginPercentTotal: stampedMargin(row.revenue, row.cost),
        countedInComparison: counted.has(reportAgentRowKey(row)),
      })),
      totals: {
        usageEvents: MEASURED(agents.totals.usageEvents),
        finishedRecordsExcluded: MEASURED(
          input.finishedWork?.excludedFromUsageEvents ?? 0
        ),
        finishedThings: MEASURED(input.finishedWork?.finishedThings ?? 0),
        cost: MEASURED(agents.totals.cost),
        earned: MEASURED(agents.totals.earned),
        revenue: MEASURED(agents.totals.revenue),
      },
    },
    whatYouFinished:
      finished !== null && finished.kind === 'rows'
        ? {
            rows: finished.rows.map((row) => ({
              name: row.name,
              source: row.source,
              howMany: row.numbers.howMany,
              aiCost: row.numbers.aiCost,
              costForOne: row.numbers.costForOne,
              split: row.split,
            })),
            totals: finished.totals.numbers,
            honesty: finished.honesty,
          }
        : null,
    metrics: metrics.map((entry) => ({
      key: entry.metric,
      label: INITIATIVE_METRIC_META[entry.metric].label,
      definition: METRIC_DESCRIPTIONS[entry.metric],
      formatted: formatMetricValue(entry.metric, entry.value),
      value: entry.value === null ? null : MEASURED(entry.value),
    })),
    withoutAi:
      block.kind === 'comparison'
        ? {
            method: block.method,
            intro: block.intro,
            paragraph: block.paragraph,
            cost: block.cost,
            revenue: block.revenue,
            revenueNote: block.revenueNote,
            netLine: block.netLine,
            estimateLabel: block.estimateLabel,
            numbers: block.numbers,
          }
        : null,
    honesty: {
      proxyGap: REPORT_COPY.proxyGap,
      usageEventDefinition: REPORT_COPY.usageEventDefinition,
      hoursNote: REPORT_COPY.noHours,
    },
  }
}

/* "What you finished": the one table on this page whose cost
 * column is not measured. Everything below exists to keep that honest. */

/** The read's three lists, already scoped to the window by the SQL. */
/** What the check marks left, and how many there were to begin with: the
 *  lead has to be able to say "5 of 7" without a second read. */
export interface FinishedWorkAgentScope {
  checkedAgentKeys: ReadonlySet<string>
  agentsInTable: number
}

export interface FinishedWorkInput {
  window: ReportWindow
  things: FinishedThingRow[]
  buckets: FinishedWorkBucketRow[]
  namedUsage: NamedUsageRow[]
  /** null = every agent. The check marks in the agents table scope this
   *  table too, and the lead says so when they have. */
  agentScope: FinishedWorkAgentScope | null
}

export interface AttributedThing extends FinishedThingRow {
  /** null = no spend we can tie to this. The cell renders a dash. */
  aiCost: number | null
  /** The bucket held more than this row, so this cost is a share of it. */
  split: boolean
  /** The bucket's events we could not price, so the share reads low. */
  unpricedEvents: number
}

export interface FinishedWorkRow {
  key: string
  name: string
  howMany: string
  aiCost: string
  costForOne: string
  split: boolean
  source: 'recorded' | 'integration'
  numbers: {
    howMany: StampedNumber
    aiCost: StampedNumber | null
    costForOne: StampedNumber | null
  }
}

export interface FinishedWorkTotals {
  label: string
  howMany: string
  aiCost: string
  numbers: { howMany: StampedNumber; aiCost: StampedNumber | null }
}

export interface FinishedWorkHonesty {
  /** null when no recorded row survived into the block: an integration-only
   *  table has no split to explain and no reason to run the work command. */
  attribution: string | null
  /** null when every row is attributed. */
  unattributed: string | null
  /** null when every event behind the split carries a price. */
  unpriced: string | null
  /** null when every name fit on the page. */
  moreNames: string | null
}

export interface FinishedWorkRecordedThing {
  name: string
  howMany: number
}

/** What your team RECORDED, before the page cap and without the integration
 *  rows. See finishedWorkMeasuredCount for why those two exclusions matter. */
export interface FinishedWorkRecorded {
  howMany: number
  /** Per name, because a count over more than one name is a MIX, and a
   *  sentence that prints the sum under one customer noun invents a number. */
  things: FinishedWorkRecordedThing[]
}

export type FinishedWorkBlock =
  | {
      kind: 'empty'
      heading: string
      /** 'no-agents' means the checkboxes emptied this table, not the window,
       *  so the surface must not send the reader off to connect a meter that
       *  is already working. */
      reason: 'no-activity' | 'no-agents'
      title: string
      body: string
    }
  | {
      kind: 'rows'
      heading: string
      lead: string
      /** The literal tuple, not readonly string[]: a surface that maps a
       *  hover onto each column has to be exhaustive over the real headers. */
      tableHeaders: typeof FINISHED_WORK_COPY.tableHeaders
      rows: FinishedWorkRow[]
      recorded: FinishedWorkRecorded
      totals: FinishedWorkTotals
      honesty: FinishedWorkHonesty
    }

/** Caps what RENDERS, never what is counted: totals and the recorded count are
 *  summed over every name first, and a line says how many are not listed. */
export const FINISHED_WORK_MAX_ROWS = 25

const FINISHED_WORK_TOTALS_ROW_LABEL = 'Everything'

export const FINISHED_WORK_COPY = {
  heading: 'What you finished',

  lead: (
    startDate: string,
    endDate: string,
    scope: FinishedWorkAgentScope | null = null
  ) =>
    `What your team finished between ${formatDisplayDate(
      startDate
    )} and ${formatDisplayDate(
      endDate
    )}, plus the named signals your integrations counted, with the AI cost ` +
    'beside each.' +
    (scope === null
      ? ''
      : ` Counting ${scope.checkedAgentKeys.size} of ${scope.agentsInTable} ` +
        'agents. Change that in the What you used AI for table on the ' +
        'Summary tab.'),

  tableHeaders: [
    'What you finished',
    'How many',
    'AI cost',
    'Cost for one',
  ] as const,

  totalsRowLabel: FINISHED_WORK_TOTALS_ROW_LABEL,

  emptyTitle: 'Nothing recorded in these dates',

  emptyNoAgentsTitle: 'Nothing from the agents you checked',

  /** The scope emptied the table, so the reader is pointed back at the
   *  checkboxes rather than at Getting Started. */
  emptyNoAgents:
    'The agents you checked recorded nothing in these dates. Check more of ' +
    'them in the What you used AI for table on the Summary tab and this ' +
    'table fills itself.',

  empty:
    'When your team records something they finished, it shows here with its ' +
    'AI cost beside it. There are two ways to record one: your coding ' +
    `assistant runs ${CCC_COMMAND_INVOCATION} done "<name>" in a terminal, ` +
    'or your own app sends it through the API. Signals your integrations ' +
    'already name show here on their own. Open Getting Started in the left ' +
    'menu, under Learn, for either one.',

  /** The destination's own name, no verb: the wayfinding gate refuses "Open"
   *  without a surface word, and a button that lands you there IS the
   *  surface. */
  emptyButton: 'Getting Started',

  /** The one sentence that says what the cost column is and is not. Scoped to
   *  the recorded rows: an integration row's cost IS measured. */
  attribution:
    'AI cost on the things your team recorded is attributed, not measured ' +
    'per item. We take everything ' +
    `the same developer's AI spent on the same ${WORK_ITEM_NOUN} in these ` +
    'dates and split it by count across the things they finished on it. ' +
    `Things recorded without a ${WORK_ITEM_NOUN} share everything that ` +
    "developer's AI spent outside one. To narrow the split to one piece of " +
    `work, the developer runs ${CCC_COMMAND_INVOCATION} work "<name>" in their ` +
    'terminal before they start it. Cost is counted only inside these dates, ' +
    'so work that began before them reads low.',

  unattributed: (count: number) =>
    `${count} of these had no AI spend we could attribute.`,

  unpriced: (count: number) =>
    `${plural(count, 'usage event')} behind these numbers ${
      count === 1 ? "isn't" : "aren't"
    } priced yet, so the attributed cost reads low.`,

  /** One word per costed row, with no symbol marks and no legend for them. */
  sourceWords: {
    measured: 'Measured',
    attributed: 'Attributed',
    attributedShared: 'Attributed, shared',
  },

  /** The print's legend for those words. The screen asks the AI cost column
   *  hover instead, which is why this is one string and not a paragraph. */
  sourceWordLegend:
    'Measured means we counted and priced that row from the events themselves. ' +
    'Attributed means a share of measured spend, split by count across what ' +
    `was finished, and "shared" adds that the same ${WORK_ITEM_NOUN} carried ` +
    'other finished things too.',

  /** The totals row's word needs its own sentence, and only on paper: the
   *  total is a SUM, so "attributed" there can be covering a blend of measured
   *  integration money and attributed shares. The screen asks the hover. */
  totalsWordLegend:
    `The ${FINISHED_WORK_TOTALS_ROW_LABEL} row carries the same word. It reads ` +
    'attributed whenever the total blends money we measured with shares we ' +
    'worked out, because the less certain half decides.',

  moreNames: (count: number) =>
    `${plural(count, 'more name')} ${
      count === 1 ? "isn't" : "aren't"
    } listed here. The ${FINISHED_WORK_TOTALS_ROW_LABEL} row still counts every one of them.`,

  /** A record whose signal row went missing still needs something to read. */
  unnamed: 'Unnamed',

  usageEventsTileLine: (count: number) =>
    count === 1
      ? "1 finished thing you recorded isn't counted here. It's on the " +
        'Finished work tab and costs nothing on its own.'
      : `${count} finished things you recorded aren't counted here. They're ` +
        'on the Finished work tab and cost nothing on their own.',
} as const

export type FinishedWorkSourceWordKey =
  keyof typeof FINISHED_WORK_COPY.sourceWords

/** The totals row cannot be 'attributedShared': a split is a fact about one
 *  row's cost, and the sum of every row is nobody's share. */
export type FinishedWorkTotalsWordKey = Exclude<
  FinishedWorkSourceWordKey,
  'attributedShared'
>

/**
 * The stamp-to-word map. Reads the row's OWN stamp rather than its `source`
 * field, so the word on screen and the provenance in GET /api/roi/report are
 * the same fact by construction. A row with no cost keeps its dash: there is
 * no number for a word to describe.
 */
export function finishedWorkSourceWord(
  row: Pick<FinishedWorkRow, 'numbers' | 'split'>
): FinishedWorkSourceWordKey | null {
  const stamp = row.numbers.aiCost
  if (stamp === null) return null
  if (stamp.source === 'measured') return 'measured'
  return row.split ? 'attributedShared' : 'attributed'
}

/** The word the totals row carries, read off the SAME stamp GET
 *  /api/roi/report publishes. A sum that mixes measured integration money with
 *  attributed shares is stamped 'attributed': the least certain input wins. */
export function finishedWorkTotalsWord(
  totals: Pick<FinishedWorkTotals, 'numbers'>
): FinishedWorkTotalsWordKey | null {
  const stamp = totals.numbers.aiCost
  if (stamp === null) return null
  return stamp.source === 'measured' ? 'measured' : 'attributed'
}

/** Case-folded and trimmed: "Contract summarized" and " contract SUMMARIZED " are one
 *  thing the customer finished, not two. */
function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

const displayName = (name: string): string =>
  name.trim() === '' ? FINISHED_WORK_COPY.unnamed : name

/**
 * (developer, work-item label), and nothing else. Not the agent:
 * one person works a ticket with both assistants, and an agent in the key
 * strands whichever one did not run `code-cost-clarity done`, printing a cost per finished
 * thing that reads low. The agent is a filter over the slices instead.
 *
 * Never (developer, session): no assistant hands a terminal command a session
 * id. Never by timestamp: ingest time lags a turn by minutes, so the tail of
 * every piece of work would land on the next one.
 */
function bucketKey(row: { customerExternalId: string; label: string }): string {
  return [row.customerExternalId, row.label].join('\u0000')
}

/** One bucket's money, after the checked agent slices are added together. */
interface BucketSpend {
  cost: number
  eventCount: number
  eventCountWithNullCost: number
}

function inScope(
  agentId: string | null,
  agentScope: ReadonlySet<string> | null
): boolean {
  if (agentScope === null) return true
  return agentId !== null && agentScope.has(agentId)
}

/**
 * The split. Pure arithmetic over canonical sums, so the agent checkboxes
 * re-scope this table without a second read.
 *
 * Three properties hold by construction and are pinned by tests: shares inside
 * a bucket sum to one (a bucket's dollars are spent once), the column can
 * never exceed the Cost tile (buckets are disjoint subsets of the window), and
 * a bucket with NO cost records attributes nothing at all.
 */
export function attributeFinishedWork(
  things: FinishedThingRow[],
  buckets: FinishedWorkBucketRow[],
  agentScope: ReadonlySet<string> | null
): AttributedThing[] {
  const scoped = things.filter((row) => inScope(row.agentId, agentScope))

  // Summing the checked slices is what makes the bucket (developer, work item)
  // rather than (developer, work item, agent), with no second round trip.
  const byKey = new Map<string, BucketSpend>()
  for (const row of buckets) {
    if (!inScope(row.agentId, agentScope)) continue
    const key = bucketKey(row)
    const spend = byKey.get(key) ?? {
      cost: 0,
      eventCount: 0,
      eventCountWithNullCost: 0,
    }
    spend.cost += row.cost
    spend.eventCount += row.eventCount
    spend.eventCountWithNullCost += row.eventCountWithNullCost
    byKey.set(key, spend)
  }

  const countByBucket = new Map<string, number>()
  for (const row of scoped) {
    const key = bucketKey(row)
    countByBucket.set(key, (countByBucket.get(key) ?? 0) + row.howMany)
  }

  return scoped.map((row) => {
    const bucket = byKey.get(bucketKey(row))
    const bucketThings = countByBucket.get(bucketKey(row)) ?? 0
    // eventCount 0 is the load-bearing case: things we counted, and no spend
    // we can tie to them. A $0 here would be a claim we never measured.
    const attributable =
      bucket !== undefined && bucket.eventCount > 0 && bucketThings > 0
    return {
      ...row,
      aiCost: attributable ? (bucket.cost * row.howMany) / bucketThings : null,
      split: attributable && bucketThings > row.howMany,
      unpricedEvents: attributable ? bucket.eventCountWithNullCost : 0,
    }
  })
}

interface RowAccumulator {
  name: string
  howMany: number
  cost: number
  /** False until something real feeds the cost, which is what a dash means. */
  attributed: boolean
  split: boolean
  source: 'recorded' | 'integration'
}

const stampedOrNull = (
  value: number | null,
  source: ReportProvenance
): StampedNumber | null => (value === null ? null : { value, source })

/** Canon M2's dash, the same glyph formatMetricValue and formatPct render. */
const money = (value: number | null): string =>
  value === null ? '\u2014' : formatCost(value)

/**
 * The ONE builder. The screen renders its rows, the print renders the same
 * rows, the JSON publishes its numbers, so none of the three can say something
 * the other two do not.
 */
export function buildFinishedWork(input: FinishedWorkInput): FinishedWorkBlock {
  const { window, things, buckets, namedUsage, agentScope } = input
  const checked = agentScope?.checkedAgentKeys ?? null
  const attributed = attributeFinishedWork(things, buckets, checked)
  const named = namedUsage.filter((row) => inScope(row.agentId, checked))

  const accumulators = new Map<string, RowAccumulator>()
  const accumulatorFor = (
    key: string,
    seed: () => RowAccumulator
  ): RowAccumulator => {
    const existing = accumulators.get(key)
    if (existing) return existing
    const created = seed()
    accumulators.set(key, created)
    return created
  }

  let unattributedThings = 0
  let unpricedEvents = 0
  const bucketsCounted = new Set<string>()

  for (const row of attributed) {
    const acc = accumulatorFor(`recorded\u0000${nameKey(row.name)}`, () => ({
      name: displayName(row.name),
      howMany: 0,
      cost: 0,
      attributed: false,
      split: false,
      source: 'recorded' as const,
    }))
    acc.howMany += row.howMany
    if (row.aiCost === null) {
      unattributedThings += row.howMany
    } else {
      acc.cost += row.aiCost
      acc.attributed = true
      acc.split = acc.split || row.split
    }
    // One bucket feeds many rows; its unpriced events are counted once.
    const key = bucketKey(row)
    if (!bucketsCounted.has(key)) {
      bucketsCounted.add(key)
      unpricedEvents += row.unpricedEvents
    }
  }

  for (const row of named) {
    const acc = accumulatorFor(`integration\u0000${nameKey(row.name)}`, () => ({
      name: displayName(row.name),
      howMany: 0,
      cost: 0,
      attributed: true,
      split: false,
      source: 'integration' as const,
    }))
    acc.howMany += row.howMany
    acc.cost += row.cost
  }

  if (accumulators.size === 0) {
    // A narrowed scope that came up empty is not an empty window, and only a
    // window that HAD something can have been emptied by a check mark. Under
    // a null scope every thing and every named row builds a row, so those
    // two lists are the whole answer to what the unscoped build would hold.
    const emptiedByScope =
      agentScope !== null && (things.length > 0 || namedUsage.length > 0)
    return {
      kind: 'empty',
      heading: FINISHED_WORK_COPY.heading,
      reason: emptiedByScope ? 'no-agents' : 'no-activity',
      title: emptiedByScope
        ? FINISHED_WORK_COPY.emptyNoAgentsTitle
        : FINISHED_WORK_COPY.emptyTitle,
      body: emptiedByScope
        ? FINISHED_WORK_COPY.emptyNoAgents
        : FINISHED_WORK_COPY.empty,
    }
  }

  const everyRow: FinishedWorkRow[] = [...accumulators.entries()]
    .sort(
      (a, b) =>
        b[1].howMany - a[1].howMany || a[1].name.localeCompare(b[1].name)
    )
    .map(([key, acc]) => {
      // A recorded row's cost is a split of measured money; an integration's
      // IS the money. Two different claims, so two different stamps.
      const source: ReportProvenance =
        acc.source === 'recorded' ? 'attributed' : 'measured'
      const cost = acc.attributed ? acc.cost : null
      const perOne =
        cost === null || acc.howMany === 0 ? null : cost / acc.howMany
      return {
        key,
        name: acc.name,
        howMany: acc.howMany.toLocaleString(),
        aiCost: money(cost),
        costForOne: money(perOne),
        split: acc.split,
        source: acc.source,
        numbers: {
          howMany: { value: acc.howMany, source: 'measured' as const },
          aiCost: stampedOrNull(cost, source),
          costForOne: stampedOrNull(perOne, source),
        },
      }
    })

  // Every number below is computed over EVERY name. The cap after it decides
  // what renders, never what is counted.
  const totalHowMany = everyRow.reduce(
    (sum, row) => sum + row.numbers.howMany.value,
    0
  )
  const attributedRows = everyRow.filter((row) => row.numbers.aiCost !== null)
  const totalCost = attributedRows.reduce(
    (sum, row) => sum + (row.numbers.aiCost?.value ?? 0),
    0
  )
  const hasCost = attributedRows.length > 0

  const recordedRows = everyRow.filter((row) => row.source === 'recorded')
  const recorded: FinishedWorkRecorded = {
    howMany: recordedRows.reduce(
      (sum, row) => sum + row.numbers.howMany.value,
      0
    ),
    things: recordedRows.map((row) => ({
      name: row.name,
      howMany: row.numbers.howMany.value,
    })),
  }

  const rows = everyRow.slice(0, FINISHED_WORK_MAX_ROWS)
  const notListed = everyRow.length - rows.length

  return {
    kind: 'rows',
    heading: FINISHED_WORK_COPY.heading,
    lead: FINISHED_WORK_COPY.lead(window.startDate, window.endDate, agentScope),
    tableHeaders: FINISHED_WORK_COPY.tableHeaders,
    rows,
    recorded,
    totals: {
      label: FINISHED_WORK_COPY.totalsRowLabel,
      howMany: totalHowMany.toLocaleString(),
      aiCost: money(hasCost ? totalCost : null),
      numbers: {
        howMany: { value: totalHowMany, source: 'measured' },
        // An integration row's cost IS the money, so a total built only from
        // those rows is measured. 'attributed' would call the number a board
        // quotes an estimate when nothing about it is one.
        aiCost: hasCost
          ? {
              value: totalCost,
              source: attributedRows.every(
                (row) => row.source === 'integration'
              )
                ? 'measured'
                : 'attributed',
            }
          : null,
      },
    },
    honesty: {
      attribution:
        recordedRows.length === 0 ? null : FINISHED_WORK_COPY.attribution,
      unattributed:
        unattributedThings > 0
          ? FINISHED_WORK_COPY.unattributed(unattributedThings)
          : null,
      unpriced:
        unpricedEvents > 0 ? FINISHED_WORK_COPY.unpriced(unpricedEvents) : null,
      moreNames: notListed > 0 ? FINISHED_WORK_COPY.moreNames(notListed) : null,
    },
  }
}

/**
 * The things your team RECORDED, and only those. This PRE-FILLS the count
 * field, so feeding an integration row in would offer ten thousand parsed
 * invoices as the default number of things a person finished. Null leaves the
 * field empty for the customer to fill.
 */
export function finishedWorkMeasuredCount(
  block: FinishedWorkBlock
): number | null {
  if (block.kind !== 'rows') return null
  return block.recorded.things.length === 0 ? null : block.recorded.howMany
}

/** THINGS, not records: one `done "contract summarized" 3` is one usage record
 *  carrying three finished things, so the number the tile subtracts and the
 *  number the sentence beside it says are two different numbers. */
export function sumFinishedThings(
  things: readonly Pick<FinishedThingRow, 'howMany'>[]
): number {
  return things.reduce((sum, thing) => sum + thing.howMany, 0)
}

export function finishedWorkRecordedThings(
  block: FinishedWorkBlock
): FinishedWorkRecordedThing[] {
  return block.kind === 'rows' ? block.recorded.things : []
}

export function finishedWorkNames(block: FinishedWorkBlock): string[] {
  return finishedWorkRecordedThings(block).map((thing) => thing.name)
}

/* The hover inventory, in one record so a number, a control or
 * a column with no entry is a compile error at its call site rather than a
 * silent gap a reader finds. Two halves: copy that exists only as a hover
 * comes from lib/tooltip-definitions.ts, and copy the print or the JSON also
 * renders is spread from the constant above that owns it. */
export const ROI_TOOLTIPS = {
  printReport: {
    title: REPORT_COPY.printReportLabel,
    description: REPORT_COPY.printReportHover,
  },
  getThisAsData: {
    title: 'Get this as data',
    description: REPORT_COPY.dataLinkHover,
  },
  printReportAgain: {
    title: REPORT_COPY.printReportLabel,
    description: REPORT_COPY.printReportAgainHover,
  },
  howThisPageWorks: roiTooltipCopy.howThisPageWorks,

  withoutAiHeading: roiTooltipCopy.withoutAiHeading,
  withAiMeasured: roiTooltipCopy.withAiMeasured,
  withoutAiEstimate: roiTooltipCopy.withoutAiEstimate,
  comparisonCostRow: roiTooltipCopy.comparisonCostRow,
  comparisonRevenueRow: roiTooltipCopy.comparisonRevenueRow,
  comparisonRevenueWithAi: roiTooltipCopy.comparisonRevenueWithAi,
  comparisonRevenueWithoutAi: roiTooltipCopy.comparisonRevenueWithoutAi,
  comparisonRevenueDifference: roiTooltipCopy.comparisonRevenueDifference,
  netLine: roiTooltipCopy.netLine,
  revenuePerMonthField: roiTooltipCopy.revenuePerMonthField,
  comparisonDifference: roiTooltipCopy.comparisonDifference,
  changeYourNumbers: roiTooltipCopy.changeYourNumbers,
  estimateWithoutAi: roiTooltipCopy.estimateWithoutAi,
  methodChoice: roiTooltipCopy.methodChoice,
  saveYourNumbers: {
    title: WITHOUT_AI_COPY.saveLabel,
    description: WITHOUT_AI_COPY.whatSaves,
  },
  closeFields: roiTooltipCopy.closeFields,

  agentsHeading: roiTooltipCopy.agentsHeading,
  countInComparison: roiTooltipCopy.countInComparison,
  agentName: {
    title: 'Agent',
    description: REPORT_COPY.meterNamesHelper,
  },
  agentUsageEvents: {
    title: 'Usage events',
    description: REPORT_COPY.usageEventDefinition,
  },
  agentCost: roiTooltipCopy.agentCost,
  agentEarned: {
    title: 'Earned',
    description: REPORT_COPY.earnedScopeHelper,
  },
  agentRevenue: {
    title: 'Total revenue',
    description: REPORT_COPY.revenueColumnHelper,
  },
  revenueBasis: roiTooltipCopy.revenueBasis,
  agentMargin: roiTooltipCopy.agentMargin,
  showEveryMetric: roiTooltipCopy.showEveryMetric,
  seeExample: roiTooltipCopy.seeExample,

  finishedHeading: roiTooltipCopy.finishedHeading,
  finishedName: roiTooltipCopy.finishedName,
  finishedHowMany: roiTooltipCopy.finishedHowMany,
  finishedAiCost: {
    title: 'AI cost',
    description:
      'For a row marked Attributed, a share of what the same developer’s ' +
      `AI spent on the same ${WORK_ITEM_NOUN} in these dates, split evenly ` +
      "across what they finished on it. For a row marked Measured, it's the " +
      'real cost of those events.',
  },
  finishedCostForOne: roiTooltipCopy.finishedCostForOne,
  sourceMeasured: roiTooltipCopy.sourceMeasured,
  sourceAttributed: roiTooltipCopy.sourceAttributed,
  sourceAttributedShared: roiTooltipCopy.sourceAttributedShared,

  goalsHeading: roiTooltipCopy.goalsHeading,
  goalProgress: roiTooltipCopy.goalProgress,
  newGoal: roiTooltipCopy.newGoal,
  showArchived: roiTooltipCopy.showArchived,
} as const satisfies Record<string, RoiTooltip>

export type RoiTooltipKey = keyof typeof ROI_TOOLTIPS

/** The Everything row's word, whose sentence has to own the blend a sum can
 *  hide. Not the row record above: those sentences describe one row. */
export const FINISHED_WORK_TOTALS_TOOLTIPS: Record<
  FinishedWorkTotalsWordKey,
  RoiTooltip
> = {
  measured: roiTooltipCopy.finishedTotalsMeasured,
  attributed: roiTooltipCopy.finishedTotalsAttributed,
}

/** The word a costed row carries, with the sentence that defines it. */
export const FINISHED_WORK_SOURCE_TOOLTIPS: Record<
  FinishedWorkSourceWordKey,
  RoiTooltip
> = {
  measured: ROI_TOOLTIPS.sourceMeasured,
  attributed: ROI_TOOLTIPS.sourceAttributed,
  attributedShared: ROI_TOOLTIPS.sourceAttributedShared,
}

/** TOTAL over InitiativeHealth, the HEALTH_PILLS rule: a new health state is a
 * compile error here rather than a pill nobody can explain. */
export const GOAL_HEALTH_TOOLTIPS: Record<InitiativeHealth, RoiTooltip> = {
  'on-track': roiTooltipCopy.goalHealthOnTrack,
  'at-risk': roiTooltipCopy.goalHealthAtRisk,
  achieved: roiTooltipCopy.goalHealthAchieved,
  'not-started': roiTooltipCopy.goalHealthNotStarted,
  'no-data': roiTooltipCopy.goalHealthNoData,
  archived: roiTooltipCopy.goalHealthArchived,
}
