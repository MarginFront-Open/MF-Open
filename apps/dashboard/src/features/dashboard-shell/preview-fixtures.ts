import type { ComponentId, TileMetric } from '@/lib/component-catalog'
import type {
  BreakdownRow,
  CostByDayRow,
  CostBreakdownOther,
  ResolvedBreakdown,
} from './types'
import type { KpiTileProps } from './tiles/kpi-tile'
import type { TimeseriesChartProps } from './tiles/timeseries-chart'
import type { CategoryDonutProps } from './tiles/category-donut'
import type { BreakdownTableProps } from './tiles/breakdown-table'
import type { ChecklistProps } from './tiles/checklist'
import type { AlertListProps } from './tiles/alert-list'
import type { GaugeProps } from './tiles/gauge'

// Fixture data for the dev-only catalog
// preview. Plausible example values (Cost $4,539, Revenue $13,090, Net
// margin 65%, Overdue $1,120; a 3-slice category split; a 6-row account
// table) rather than lorem ipsum.

type Base<T> = Omit<T, 'state' | 'errorMessage'>

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

// ─────────────────────────────────────────────
// kpi-tile
// ─────────────────────────────────────────────

const COST_SPARK: CostByDayRow[] = [
  { date: day('2026-06-23'), cost: 612, eventCount: 31200 },
  { date: day('2026-06-24'), cost: 590, eventCount: 30100 },
  { date: day('2026-06-25'), cost: 655, eventCount: 33500 },
  { date: day('2026-06-26'), cost: 540, eventCount: 27800 },
  { date: day('2026-06-27'), cost: 601, eventCount: 30700 },
  { date: day('2026-06-28'), cost: 498, eventCount: 25400 },
  { date: day('2026-06-29'), cost: 520, eventCount: 26600 },
]

export const KPI_TILE_FIXTURE: Base<KpiTileProps> = {
  metric: 'cost',
  value: 4539,
  delta: {
    value: 4.2,
    direction: 'down-good',
    comparisonLabel: 'vs prev 30 days',
  },
  spark: COST_SPARK,
}

// A genuinely undefined value — this org has no subscriptions, so MRR
// is not "$0," it is not-applicable-yet. Rendered separately from the main
// gallery grid, since it demonstrates a data condition, not a UI state.
export const KPI_TILE_NULL_HONESTY_FIXTURE: Base<KpiTileProps> = {
  metric: 'mrr',
  value: null,
  subtext: 'No active subscriptions this period',
}

// One entry per TILE_METRIC_REGISTRY key, for the tile-grid demo below —
// every default layout (Money, Build, Overview) mixes kpi-tiles by metric,
// and each one needs to show ITS OWN number, not the single Cost fixture
// repeated under the wrong label. Cost/Revenue/Net margin/Overdue are the
// same example values as KPI_TILE_FIXTURE; costPerTask/eventCount are
// $0.019 and 240,313 tasks; mrr/arr/earned are plausible placeholders
// (arr = mrr × 12). The deliberate null-MRR fixture
// above stays its own demo (NullHonestySection) — here mrr shows a real
// dollar figure so the metric reads as a live option, not a permanent dash.
export const KPI_TILE_FIXTURES_BY_METRIC: Record<
  TileMetric,
  Base<KpiTileProps>
> = {
  cost: KPI_TILE_FIXTURE,
  revenue: {
    metric: 'revenue',
    value: 13090,
    delta: {
      value: 18,
      direction: 'up-good',
      comparisonLabel: 'vs prev 30 days',
    },
  },
  marginPercent: {
    metric: 'marginPercent',
    value: 65,
    delta: {
      value: 3,
      direction: 'up-good',
      comparisonLabel: 'vs prev 30 days',
    },
  },
  overdueAmount: {
    metric: 'overdueAmount',
    value: 1120,
    subtext: '2 invoices',
  },
  mrr: {
    metric: 'mrr',
    value: 9840,
    delta: {
      value: 2.5,
      direction: 'up-good',
      comparisonLabel: 'vs prev month',
    },
  },
  arr: {
    metric: 'arr',
    value: 118080,
    subtext: 'MRR × 12',
  },
  earned: {
    metric: 'earned',
    value: 8210,
    delta: {
      value: 6.1,
      direction: 'up-good',
      comparisonLabel: 'vs prev 30 days',
    },
  },
  costPerTask: {
    metric: 'costPerTask',
    value: 0.019,
    subtext: 'across all agents',
  },
  eventCount: {
    metric: 'eventCount',
    value: 240313,
    delta: {
      value: 9.4,
      direction: 'up-good',
      comparisonLabel: 'vs prev 30 days',
    },
  },
  // Close metrics (close-engine-backed, not resolver-backed) — an example
  // mid-close state: 1 of 5 steps done, 14 unmapped signals,
  // mid-close-window.
  closeProgress: {
    metric: 'closeProgress',
    value: 20,
    subtext: '1 of 5 steps done',
  },
  unmappedCount: {
    metric: 'unmappedCount',
    value: 14,
    subtext: 'signals need a GL code',
  },
  categorizedPct: {
    metric: 'categorizedPct',
    value: 88,
    subtext: 'of June 2026 AI cost',
  },
  daysToClose: {
    metric: 'daysToClose',
    value: 2,
    subtext: 'until the close deadline',
  },
}

// ─────────────────────────────────────────────
// timeseries-chart
// ─────────────────────────────────────────────

const REVENUE_SERIES: CostByDayRow[] = [
  { date: day('2026-06-01'), cost: 2650, eventCount: 18000 },
  { date: day('2026-06-04'), cost: 2820, eventCount: 19100 },
  { date: day('2026-06-08'), cost: 2760, eventCount: 18700 },
  { date: day('2026-06-11'), cost: 3140, eventCount: 21200 },
  { date: day('2026-06-15'), cost: 3020, eventCount: 20600 },
  { date: day('2026-06-18'), cost: 3480, eventCount: 23400 },
  { date: day('2026-06-21'), cost: 3350, eventCount: 22700 },
  { date: day('2026-06-25'), cost: 3820, eventCount: 25800 },
  { date: day('2026-06-29'), cost: 4310, eventCount: 28900 },
]

const COST_SERIES: CostByDayRow[] = [
  { date: day('2026-06-01'), cost: 990, eventCount: 18000 },
  { date: day('2026-06-04'), cost: 1020, eventCount: 19100 },
  { date: day('2026-06-08'), cost: 960, eventCount: 18700 },
  { date: day('2026-06-11'), cost: 1080, eventCount: 21200 },
  { date: day('2026-06-15'), cost: 1010, eventCount: 20600 },
  { date: day('2026-06-18'), cost: 1140, eventCount: 23400 },
  { date: day('2026-06-21'), cost: 1070, eventCount: 22700 },
  { date: day('2026-06-25'), cost: 1160, eventCount: 25800 },
  { date: day('2026-06-29'), cost: 1230, eventCount: 28900 },
]

export const TIMESERIES_CHART_FIXTURE: Base<TimeseriesChartProps> = {
  title: 'Spend vs revenue',
  series: [
    { label: 'Revenue', points: REVENUE_SERIES },
    { label: 'Cost', points: COST_SERIES },
  ],
  valueFormat: 'cost',
  now: day('2026-06-29'),
}

// ─────────────────────────────────────────────
// category-donut
// ─────────────────────────────────────────────

const AGENT_NAMES: Record<string, string> = {
  'fixture-agent-research': 'Research Agent',
  'fixture-agent-support': 'Support Agent',
}

const CATEGORY_DONUT_ROWS: BreakdownRow[] = [
  { key: 'fixture-agent-research', cost: 2890, eventCount: 156000 },
  { key: 'fixture-agent-support', cost: 1325, eventCount: 68400 },
  // Events with no agent attribution — a real bucket, never dropped.
  { key: null, cost: 324, eventCount: 15900 },
]

export const CATEGORY_DONUT_FIXTURE: Base<CategoryDonutProps> = {
  title: 'Cost by agent',
  rows: CATEGORY_DONUT_ROWS,
  other: null,
  resolveLabel: (key) => (key ? (AGENT_NAMES[key] ?? key) : 'Unassigned'),
}

// ─────────────────────────────────────────────
// breakdown-table
// ─────────────────────────────────────────────

const CUSTOMER_NAMES: Record<string, string> = {
  'a1b2c3d4-0001-4e5f-8a9b-000000000001': 'Northwind AI',
  'a1b2c3d4-0002-4e5f-8a9b-000000000002': 'Acme Robotics',
  'a1b2c3d4-0003-4e5f-8a9b-000000000003': 'Foglamp Media',
  'a1b2c3d4-0004-4e5f-8a9b-000000000004': 'Tamarack Commerce',
  'a1b2c3d4-0005-4e5f-8a9b-000000000005': 'BrightSignal Labs',
}

const BREAKDOWN_TABLE_ROWS: BreakdownRow[] = [
  {
    key: 'a1b2c3d4-0001-4e5f-8a9b-000000000001',
    cost: 1830,
    eventCount: 48204,
  },
  {
    key: 'a1b2c3d4-0002-4e5f-8a9b-000000000002',
    cost: 1000,
    eventCount: 33067,
  },
  {
    key: 'a1b2c3d4-0003-4e5f-8a9b-000000000003',
    cost: 260,
    eventCount: 135461,
  },
  { key: 'a1b2c3d4-0004-4e5f-8a9b-000000000004', cost: 210, eventCount: 4102 },
  { key: 'a1b2c3d4-0005-4e5f-8a9b-000000000005', cost: 215, eventCount: 18900 },
]

// Everything past this page, folded into Other.
const BREAKDOWN_TABLE_OTHER: CostBreakdownOther = {
  cost: 1024,
  eventCount: 579,
}

const BREAKDOWN_TABLE_BREAKDOWN: ResolvedBreakdown = {
  rows: BREAKDOWN_TABLE_ROWS,
  other: BREAKDOWN_TABLE_OTHER,
  totalRowCount: 6,
  page: 1,
  pageSize: 5,
  // Cost-only showcase fixture — the revenue column is exercised on the real
  // Money page + the resolver/aggregation tests, not this design catalog.
  revenueBasis: null,
}

export const BREAKDOWN_TABLE_FIXTURE: Omit<
  Base<BreakdownTableProps>,
  'onPageChange'
> = {
  title: 'Cost by customer',
  breakdown: BREAKDOWN_TABLE_BREAKDOWN,
  // Totals rendered verbatim — equals rows + other by the resolver's own
  // construction (cost: 1830+1000+260+210+215+1024=4539; events likewise).
  totals: { cost: 4539, eventCount: 240313 },
  resolveLabel: (key) => (key ? (CUSTOMER_NAMES[key] ?? key) : 'Unassigned'),
}

// ─────────────────────────────────────────────
// checklist
// ─────────────────────────────────────────────

export const CHECKLIST_FIXTURE: Base<ChecklistProps> = {
  title: 'Month-end close',
  items: [
    { label: 'Import transactions', status: 'done' },
    { label: 'Map to GL codes', status: 'active', detail: '3 left' },
    { label: 'Categorize COGS / R&D', status: 'todo' },
    { label: 'Review with finance', status: 'todo' },
    { label: 'Sign off month', status: 'todo' },
  ],
}

// ─────────────────────────────────────────────
// alert-list
// ─────────────────────────────────────────────

export const ALERT_LIST_FIXTURE: Base<AlertListProps> = {
  title: 'Needs attention',
  items: [
    {
      severity: 'amber',
      text: '3 signals booked to the wrong account type',
      href: '/finops?tab=settings',
    },
    {
      severity: 'red',
      text: 'Acme Robotics margin 56% below floor',
      href: '/customers',
      timestamp: '2h',
    },
    {
      severity: 'red',
      text: 'Deal Ops cost spike ▲ 11.6%',
      href: '/build',
      timestamp: '2h',
    },
    {
      severity: 'green',
      text: '$1,825 / mo savings found',
      href: '/build',
      timestamp: '1d',
    },
  ],
}

// ─────────────────────────────────────────────
// gauge
// ─────────────────────────────────────────────

export const GAUGE_FIXTURE: Base<GaugeProps> = {
  title: 'MFiQ',
  value: 6,
  max: 10,
  label: 'Financial hygiene',
  fixes: [
    { label: 'Connect a revenue source', points: 2 },
    { label: 'Map 3 unmapped items', points: 1 },
    { label: 'Set a June close date', points: 1 },
  ],
}

// ─────────────────────────────────────────────
// Completeness — one entry per COMPONENT_CATALOG id. The
// `satisfies` check means a future 8th catalog component fails this file's
// typecheck until a fixture is added, the same completeness guarantee the
// catalog itself uses for TILE_METRIC_REGISTRY.
// ─────────────────────────────────────────────

export const CATALOG_PREVIEW_FIXTURES = {
  'kpi-tile': KPI_TILE_FIXTURE,
  'timeseries-chart': TIMESERIES_CHART_FIXTURE,
  'category-donut': CATEGORY_DONUT_FIXTURE,
  'breakdown-table': BREAKDOWN_TABLE_FIXTURE,
  checklist: CHECKLIST_FIXTURE,
  'alert-list': ALERT_LIST_FIXTURE,
  gauge: GAUGE_FIXTURE,
} satisfies Record<ComponentId, object>
