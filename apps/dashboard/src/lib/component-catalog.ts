// The catalog for per-user dashboard layouts and the
// taxonomy picker. Every layout surface imports this; do
// not fork it. Keeping the component list, dimension registry, page ids, and
// size set in ONE module is what stops a layout row from ever referencing a
// component/dimension/page the resolver or UI doesn't know about — see the
// Zod validation in app/actions/dashboard-layouts.ts and saved-views.ts.
//
// Also holds the tile schema (a 'use server' file such as dashboard-layouts.ts
// may only export async functions, so the schema can't live there), plus the
// metric registry, fixed spans, and display-label maps.

import { z } from 'zod'
import type { tooltipDefinitions } from '@/lib/tooltip-definitions'
import type { ResolvedTiles } from '@/app/actions/metrics-resolver'
import type { CloseTileValues } from '@/features/finops/close-derivation'

/** The seven tile types. A new type is a code change
 * here, in the renderer, and — if it takes a dimension — in the
 * `DIMENSIONED_COMPONENTS` set below. */
export const COMPONENT_CATALOG = [
  'kpi-tile',
  'timeseries-chart',
  'category-donut',
  'breakdown-table',
  'checklist',
  'alert-list',
  'gauge',
] as const

export type ComponentId = (typeof COMPONENT_CATALOG)[number]

/** Chart/table components take exactly one dimension; the other
 * four render fixed content and never take one. */
export const DIMENSIONED_COMPONENTS: ReadonlySet<ComponentId> = new Set([
  'timeseries-chart',
  'category-donut',
  'breakdown-table',
])

/** The 8 grouping dimensions `getCostBreakdown` supports. The set is closed. */
export const DIMENSION_REGISTRY = [
  'agent',
  'customer',
  'signal',
  'day',
  'plan',
  'model',
  'costCategory',
  'environment',
] as const

export type Dimension = (typeof DIMENSION_REGISTRY)[number]

/** The renderer draws every component at a fixed size per type (no freeform
 * resize, by design), but layouts store a size anyway so size variants need
 * no migration. */
export const TILE_SIZES = ['sm', 'md', 'lg'] as const

export type TileSize = (typeof TILE_SIZES)[number]

/** The 5 pages that get a per-user layout (`mfiq` is spelled with no
 * separator). */
export const DASHBOARD_PAGE_IDS = [
  'money',
  'finops',
  'build',
  'roi',
  'mfiq',
] as const

export type DashboardPageId = (typeof DASHBOARD_PAGE_IDS)[number]

/** Hard cap on tiles per layout row. Generous for the fixed-size grid, and
 * cheap to raise since it's an app-code check, not a column constraint. */
export const MAX_TILES_PER_LAYOUT = 24

// ──which metric a kpi-tile shows ─────────────────────

export type TooltipKey = keyof typeof tooltipDefinitions

interface TileMetricSpec {
  label: string
  format: 'cost' | 'currency' | 'pct' | 'count'
  tooltipKey: TooltipKey
}

/**
 * The metrics whose values come from resolveMetrics. Keys are a SUBSET of
 * `ResolvedTiles` fields (the `satisfies` below enforces it at the type
 * level) so this map can never name a metric the resolver doesn't return.
 * Every entry carries its canon-L1 tooltipKey — kpi tiles get the right
 * rule-citing tooltip for free.
 */
export const RESOLVER_TILE_METRICS = {
  cost: { label: 'Cost', format: 'cost', tooltipKey: 'totalCost' },
  revenue: { label: 'Revenue', format: 'cost', tooltipKey: 'totalRevenue' },
  marginPercent: {
    label: 'Net margin',
    format: 'pct',
    tooltipKey: 'totalMargin',
  },
  overdueAmount: {
    label: 'Overdue',
    format: 'cost',
    tooltipKey: 'overdueAmount',
  },
  mrr: { label: 'MRR', format: 'cost', tooltipKey: 'mrrDefinition' },
  arr: { label: 'ARR', format: 'cost', tooltipKey: 'arrDefinition' },
  earned: { label: 'Earned', format: 'cost', tooltipKey: 'agentEarned' },
  costPerTask: {
    label: 'Avg cost / usage event',
    format: 'cost',
    tooltipKey: 'avgCostPerEvent',
  },
  eventCount: { label: 'Usage events', format: 'count', tooltipKey: 'events' },
} as const satisfies Partial<Record<keyof ResolvedTiles, TileMetricSpec>>

/**
 * The metrics whose values come from the
 * close-status derivation (getFinopsCloseStatus → deriveCloseStatus), NEVER
 * from resolveMetrics — they aren't ResolvedTiles fields and must not become
 * ones. Keys check against the derivation module's tile-value shape (a
 * type-only import from a PLAIN module — close-derivation.ts, not the 'use
 * server' action file, so there's no server-action coupling here at all).
 */
export const CLOSE_TILE_METRICS = {
  closeProgress: {
    label: 'Close progress',
    format: 'pct',
    tooltipKey: 'closeProgress',
  },
  unmappedCount: {
    label: 'Unmapped items',
    format: 'count',
    tooltipKey: 'unmappedGlSignals',
  },
  categorizedPct: {
    label: 'Categorized',
    format: 'pct',
    tooltipKey: 'categorizedShare',
  },
  daysToClose: {
    label: 'Days to close',
    format: 'count',
    tooltipKey: 'daysToClose',
  },
} as const satisfies Partial<Record<keyof CloseTileValues, TileMetricSpec>>

/** The closed set of metrics a kpi-tile may display — the two source-typed
 * maps above merged under one public name. TILE_METRIC_IDS / TileInputSchema / tileConfigKey pick
 * the close keys up automatically. */
export const TILE_METRIC_REGISTRY = {
  ...RESOLVER_TILE_METRICS,
  ...CLOSE_TILE_METRICS,
} as const

export type TileMetric = keyof typeof TILE_METRIC_REGISTRY
export type ResolverTileMetric = keyof typeof RESOLVER_TILE_METRICS
export type CloseTileMetric = keyof typeof CLOSE_TILE_METRICS

export function isCloseTileMetric(
  metric: TileMetric
): metric is CloseTileMetric {
  return metric in CLOSE_TILE_METRICS
}

/**
 * The ONE way to read a kpi-tile value out of a ResolvedTiles response.
 * Close metrics never come from the resolver, so they read null here (their
 * values arrive via deriveCloseStatus on the FinOps page). Without this,
 * indexing ResolvedTiles by the widened TileMetric union is a compile error
 * in every page's renderTile.
 */
export function resolverTileValue(
  tiles: ResolvedTiles,
  metric: TileMetric
): number | null {
  if (isCloseTileMetric(metric)) return null
  return tiles[metric] ?? null
}

export const TILE_METRIC_IDS = Object.keys(TILE_METRIC_REGISTRY) as [
  TileMetric,
  ...TileMetric[],
]

/** Only kpi-tile shows a single registry metric; mirrors DIMENSIONED_COMPONENTS. */
export const METRIC_COMPONENTS: ReadonlySet<ComponentId> = new Set(['kpi-tile'])

// ──the tile shape + schema ──────────────────────────────────────────────────

export interface DashboardLayoutTile {
  component: ComponentId
  dimension?: Dimension
  metric?: TileMetric
  size: TileSize
}

// Zod-strict: unknown keys on a tile are rejected outright, and a
// superRefine ties `dimension`/`metric` presence to whether the component
// actually takes one — a chart/table tile with no dimension, a kpi-tile with
// no metric, or a fixed tile WITH either is just as invalid as an unknown
// component id.
export const TileInputSchema = z
  .object({
    component: z.enum(COMPONENT_CATALOG),
    dimension: z.enum(DIMENSION_REGISTRY).optional(),
    metric: z.enum(TILE_METRIC_IDS).optional(),
    size: z.enum(TILE_SIZES),
  })
  .strict()
  .superRefine((tile, ctx) => {
    const takesDimension = DIMENSIONED_COMPONENTS.has(tile.component)
    if (takesDimension && tile.dimension === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${tile.component}" requires a dimension`,
        path: ['dimension'],
      })
    }
    if (!takesDimension && tile.dimension !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${tile.component}" does not take a dimension`,
        path: ['dimension'],
      })
    }
    const takesMetric = METRIC_COMPONENTS.has(tile.component)
    if (takesMetric && tile.metric === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${tile.component}" requires a metric`,
        path: ['metric'],
      })
    }
    if (!takesMetric && tile.metric !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${tile.component}" does not take a metric`,
        path: ['metric'],
      })
    }
  })

/**
 * The identity of a tile CONFIG (not its position): two tiles are exact
 * duplicates when component, metric, and dimension all match. Shared by the
 * schema below, the layout reducer, and the add panel's grey-out so all
 * three enforce the same rule: exact duplicates are blocked; distinct
 * metrics/dimensions of the same component stay legal.
 */
export function tileConfigKey(
  tile: Pick<DashboardLayoutTile, 'component' | 'metric' | 'dimension'>
): string {
  return `${tile.component}|${tile.metric ?? ''}|${tile.dimension ?? ''}`
}

export const TilesInputSchema = z
  .array(TileInputSchema)
  .max(MAX_TILES_PER_LAYOUT)
  .superRefine((tiles, ctx) => {
    const seen = new Map<string, number>()
    tiles.forEach((tile, index) => {
      const key = tileConfigKey(tile)
      const firstIndex = seen.get(key)
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tile ${index} duplicates tile ${firstIndex} ("${tile.component}"): a layout can't hold two tiles with the same component, metric, and dimension`,
          path: [index],
        })
      } else {
        seen.set(key, index)
      }
    })
  })

// ──fixed size per type ────────────────────────────────

/** 12-col grid spans the renderer reads (KPI=¼, donut/gauge/
 * checklist/alerts=⅓, chart=⅔, table=full). */
export const SPAN_BY_COMPONENT: Record<ComponentId, 3 | 4 | 8 | 12> = {
  'kpi-tile': 3,
  gauge: 4,
  'category-donut': 4,
  checklist: 4,
  'alert-list': 4,
  'timeseries-chart': 8,
  'breakdown-table': 12,
}

/** What `add` stamps into the stored `size` field. NEVER read by the
 * renderer (it keys off SPAN_BY_COMPONENT); stored so size variants need no
 * migration. */
export const CANONICAL_SIZE_BY_COMPONENT: Record<ComponentId, TileSize> = {
  'kpi-tile': 'sm',
  gauge: 'md',
  'category-donut': 'md',
  checklist: 'md',
  'alert-list': 'md',
  'timeseries-chart': 'lg',
  'breakdown-table': 'lg',
}

// ──display labels ───────────────────────────────

export const DIMENSION_LABELS: Record<Dimension, string> = {
  agent: 'Agent',
  customer: 'Customer',
  signal: 'Task',
  day: 'Day',
  plan: 'Plan',
  model: 'Model',
  costCategory: 'Category',
  environment: 'Environment',
}

export const COMPONENT_LABELS: Record<ComponentId, string> = {
  'kpi-tile': 'KPI tile',
  'timeseries-chart': 'Trend chart',
  'category-donut': 'Donut breakdown',
  'breakdown-table': 'Breakdown table',
  checklist: 'Checklist',
  'alert-list': 'Alerts',
  gauge: 'Score gauge',
}

// ──per-scope tile sources ──────────────────────────────
//
// A 'use server' file such as metrics-resolver.ts may only export async
// functions, so the per-scope tile map lives here where it can be imported
// and asserted directly.

/** Which canon calls each page scope pays for — getCostBreakdown always
 * runs (feeds cost/eventCount/costPerTask + the chart series for every
 * scope); revenue/invoices/mrr/earned are each an extra query gated per
 * scope. build gets earned (Agent-Earned is its money surface) and skips
 * invoice totals; mfiq never calls the resolver at all (its page reads
 * getMfiqStatus only — its all-false row is vacuously satisfied). */
export interface ScopeTileSources {
  revenue: boolean
  invoices: boolean
  mrr: boolean
  earned: boolean
}

export const SCOPE_TILE_SOURCES: Record<DashboardPageId, ScopeTileSources> = {
  money: { revenue: true, invoices: true, mrr: true, earned: false },
  finops: { revenue: true, invoices: false, mrr: false, earned: false },
  build: { revenue: false, invoices: false, mrr: false, earned: true },
  roi: { revenue: true, invoices: false, mrr: false, earned: false },
  mfiq: { revenue: false, invoices: false, mrr: false, earned: false },
}

// ──which TileMetric keys each page may ADD ────────────
//
// Derived from SCOPE_TILE_SOURCES: cost/eventCount/costPerTask are always
// available; revenue/marginPercent gate on sources.revenue; mrr/arr on
// sources.mrr; earned on sources.earned; overdueAmount on sources.invoices
// (money only) so a user who removes it from their layout can re-add it —
// TilesInputSchema still blocks an actual duplicate tile server-side.
// A literal table (not a runtime transform) so it's eyeballable against
// SCOPE_TILE_SOURCES above; a test enforces the two agree.
/**
 * UI-only allow-list: which DIMENSION_REGISTRY values each page's "Group by"
 * control OFFERS. DIMENSION_REGISTRY stays the resolver's full vocabulary —
 * getCostBreakdown can still group by any dimension for any scope. Money drops
 * 'day' (its chart is already a daily timeseries) and 'costCategory' (category
 * lives on FinOps).
 */
export const GROUP_BY_DIMENSIONS: Record<
  DashboardPageId,
  readonly Dimension[]
> = {
  money: DIMENSION_REGISTRY.filter(
    (dimension) => dimension !== 'day' && dimension !== 'costCategory'
  ),
  // FinOps drops 'day' only (a "Day" option reads
  // as navigation, and day-grain belongs to charts); costCategory stays,
  // it is the page's home dimension.
  finops: DIMENSION_REGISTRY.filter((dimension) => dimension !== 'day'),
  build: DIMENSION_REGISTRY,
  roi: DIMENSION_REGISTRY,
  mfiq: DIMENSION_REGISTRY,
}

export const ADDABLE_METRICS: Record<DashboardPageId, TileMetric[]> = {
  money: [
    'cost',
    'eventCount',
    'costPerTask',
    'revenue',
    'marginPercent',
    'mrr',
    'arr',
    // Money's default layout ships this as a normal (removable) kpi-tile,
    // not `fixed()` chrome, so it must be listed here for a removed tile to
    // be re-addable. TilesInputSchema still blocks an actual duplicate tile
    // server-side.
    'overdueAmount',
  ],
  // The 4 close metrics are backed by getFinopsCloseStatus — they
  // exist ONLY here; no other page has a close engine to feed them.
  finops: [
    'cost',
    'eventCount',
    'costPerTask',
    'revenue',
    'marginPercent',
    'closeProgress',
    'unmappedCount',
    'categorizedPct',
    'daysToClose',
  ],
  build: ['cost', 'eventCount', 'costPerTask', 'earned'],
  roi: [],
  mfiq: [],
}
