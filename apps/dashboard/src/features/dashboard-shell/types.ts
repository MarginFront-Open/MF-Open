/**
 * Shared type hub for the dashboard shell.
 *
 * Data-row shapes are re-exported from their canonical homes (@marginfront/db,
 * app/actions/metrics-resolver) so shell code imports ONE path and can never
 * fork a row shape. All imports from the 'use server' resolver are type-only
 * (erased at build — value imports there would be a build failure).
 */

import type { ReactNode } from 'react'
import type {
  ComponentId,
  DashboardLayoutTile,
  DashboardPageId,
  Dimension,
  TileMetric,
} from '@/lib/component-catalog'

export type {
  BreakdownRow,
  CostBreakdownOther,
  CostByDayRow,
} from '@marginfront/db'

export type {
  EarnedByDayRow,
  ResolvedBreakdown,
  ResolvedBreakdownOther,
  ResolvedBreakdownRow,
  ResolvedMetrics,
  ResolvedTiles,
} from '@/app/actions/metrics-resolver'

// Client-safe (pure module, no Prisma) — the revenue column label + gating.
export type { RevenueBasis } from '@/lib/revenue-basis'

export type {
  ComponentId,
  DashboardLayoutTile,
  DashboardPageId,
  Dimension,
  TileMetric,
  TileSize,
  TooltipKey,
} from '@/lib/component-catalog'

// ── Date range ─────────────────────────────────────────────────

export type DateRangeMode = 'month' | 'rolling' | 'custom'

/**
 * The page-scoped date-range state. date-range.ts#selectionToPeriod maps it
 * to resolveMetrics' period ({} = rolling, bare YYYY-MM-DD otherwise —
 * parseWindowFilter's UI shape); #selectionToUrlParams maps it to the actual
 * URL, adding an explicit ?range=rolling marker so Rolling survives the
 * round trip on pages whose default isn't rolling.
 */
export type DateRangeSelection =
  | { mode: 'month'; monthsAgo: number }
  | { mode: 'rolling' }
  | { mode: 'custom'; startDate: string; endDate: string }

export interface DateRangeConfig {
  /** Which modes this page allows. Empty = no selector (ROI/MF IQ: the page owns its window). */
  modes: readonly DateRangeMode[]
  /** Applied when the URL carries no window params. null only when modes is empty. */
  default: DateRangeSelection | null
  /**
   * Params true for ONE window only, dropped whenever the dates move: carried
   * forward they would restate a number about a period nobody measured it for
   */
  windowScopedParams?: readonly string[]
}

// ── Layout state ───────────────────────────────────────────────

export type LayoutAction =
  | {
      type: 'add'
      component: ComponentId
      dimension?: Dimension
      metric?: TileMetric
    }
  | { type: 'remove'; index: number }
  // Drag-reorder lands here — reorder ONLY, no resize action exists.
  | { type: 'move'; from: number; to: number }
  | { type: 'setDimension'; index: number; dimension: Dimension }
  | { type: 'reset'; defaults: DashboardLayoutTile[] }

// ── Page shell ─────────────────────────────────────────────────

export interface PageShellRenderContext {
  editing: boolean
}

export interface PageShellProps {
  // internal-ai-spend renders in the shell but has no per-user layout, date
  // range, or metrics scope, so it stays out of DASHBOARD_PAGE_IDS.
  page: DashboardPageId | 'internal-ai-spend'
  title: string
  /** COMPUTED by the page (live period/agent-count/rec-count), never hardcoded. */
  subtitle?: string
  dateRange: DateRangeConfig
  /** default true; false hides the edit toggle (ROI, MF IQ). */
  editable?: boolean
  /** Page-specific header buttons (e.g. FinOps "Auto-map"). */
  headerExtras?: ReactNode
  /**
   * "Done" in the edit banner. Failure keeps edit mode open and shows the
   * returned error string verbatim. Omitted = toggle-only shell.
   */
  onSaveLayout?: () => Promise<{ success: boolean; error?: string }>
  /** "Cancel" — the page discards its local layout state. */
  onCancelEdit?: () => void
  /** "Reset to default" — the page calls resetDashboardLayout + reloads defaults. */
  onResetLayout?: () => Promise<{ success: boolean; error?: string }>
  children: ReactNode | ((ctx: PageShellRenderContext) => ReactNode)
}

// ── Tile grid ──────────────────────────────────────────────────

export interface TileGridProps {
  page: DashboardPageId
  tiles: DashboardLayoutTile[]
  editing?: boolean
  /** Drag interactions emit ONLY (from, to) — the reducer stays the single mutation path. */
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  /**
   * Add-panel pick. The panel supplies the exact config it offered (per-
   * metric KPI options; a default dimension for chart/donut/table) so it can
   * grey out configs already on the grid; the page just dispatches 'add'.
   */
  onAdd?: (
    component: ComponentId,
    config: { metric?: TileMetric; dimension?: Dimension }
  ) => void
  /** The GRID owns order/spans/edit-chrome; the PAGE owns each tile's data. */
  renderTile: (tile: DashboardLayoutTile, index: number) => ReactNode
}
