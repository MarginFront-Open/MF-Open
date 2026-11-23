/**
 * Per-page code defaults. A user with no
 * user_dashboard_layouts row renders these; "reset" deletes the row so the
 * default is never persisted (dashboard-layouts.ts contract).
 *
 * Layouts use catalog-expressible tiles only — bespoke sections (FinOps reconciliation ledger, Build agents
 * editor, ROI initiative card, MF IQ ask bar) are page work OUTSIDE
 * the tile grid.
 */

import {
  CANONICAL_SIZE_BY_COMPONENT,
  type ComponentId,
  type DashboardLayoutTile,
  type DashboardPageId,
  type TileMetric,
} from '@/lib/component-catalog'
import type { DateRangeConfig } from './types'

const kpi = (metric: TileMetric): DashboardLayoutTile => ({
  component: 'kpi-tile',
  metric,
  size: CANONICAL_SIZE_BY_COMPONENT['kpi-tile'],
})

const fixed = (
  component: 'checklist' | 'alert-list' | 'gauge'
): DashboardLayoutTile => ({
  component,
  size: CANONICAL_SIZE_BY_COMPONENT[component],
})

export const DEFAULT_LAYOUTS: Record<DashboardPageId, DashboardLayoutTile[]> = {
  // Chart+donut+table collapse into ONE fixed DimensionedSection outside
  // the customizable grid, so this array holds only the 4 KPIs.
  money: [
    kpi('cost'),
    kpi('revenue'),
    kpi('marginPercent'),
    kpi('overdueAmount'),
  ],
  // The 4 close-engine KPIs lead (KPIs render as
  // the first band on every page), then checklist + the alert list (the
  // wrong-account-type item). Donut + table are fixed chrome in
  // the page's ONE DimensionedSection (same as Money), not layout rows.
  // `kpi('cost')` is not in the default; it is one add-panel click away.
  finops: [
    kpi('closeProgress'),
    kpi('unmappedCount'),
    kpi('categorizedPct'),
    kpi('daysToClose'),
    fixed('checklist'),
    fixed('alert-list'),
  ],
  // No breakdown-table row: the agents table is bespoke chrome above
  // the grid, and donut + table are fixed chrome in the page's ONE
  // DimensionedSection (same as Money/FinOps).
  build: [
    kpi('costPerTask'),
    kpi('eventCount'),
    kpi('earned'),
    fixed('alert-list'),
  ],
  // Initiative surfaces are schema-driven, not catalog tiles.
  roi: [],
  // Bespoke page — /mfiq renders its four cards outside the
  // tile grid; no per-user layout.
  mfiq: [],
}

export const PAGE_DATE_RANGE: Record<DashboardPageId, DateRangeConfig> = {
  money: {
    modes: ['month', 'rolling', 'custom'],
    default: { mode: 'month', monthsAgo: 0 },
  },
  // Month-locked: FinOps closes calendar months — the selector
  // renders as the month dropdown only. Defaults to LAST month (monthsAgo: 1),
  // not the in-progress current one: the
  // current month can't be closed yet, so landing there just shows a
  // disabled "Close the books" button with no explanation.
  finops: { modes: ['month'], default: { mode: 'month', monthsAgo: 1 } },
  build: {
    modes: ['month', 'rolling', 'custom'],
    default: { mode: 'rolling' },
  },
  // The report above the goals reads this range. The goal cards
  // below still each measure their OWN stored window.
  roi: {
    modes: ['month', 'rolling', 'custom'],
    default: { mode: 'rolling' },
    // `agents` stays: a stale selection is visible in the checkboxes, and
    // toggling one rewrites the param against the rows actually present.
    windowScopedParams: ['units'],
  },
  mfiq: { modes: [], default: null },
}

/**
 * /roi/[initiativeId] reads ONE initiative's own window and ignores URL dates,
 * so sharing PAGE_DATE_RANGE.roi would put a control there that changes
 * nothing. The list page uses a real range; this page has none.
 */
export const ROI_DETAIL_DATE_RANGE: DateRangeConfig = {
  modes: [],
  default: null,
}

/**
 * UI-level constraint on the add panel — server validation stays
 * catalog-wide; the UI just doesn't offer a close
 * checklist on Money or a gauge outside MF IQ.
 */
export const ADDABLE_COMPONENTS: Record<DashboardPageId, ComponentId[]> = {
  // The combined chart+donut+table section is fixed chrome, not
  // an individually addable/removable layout row.
  money: ['kpi-tile', 'alert-list'],
  // Donut/table are the page's fixed DimensionedSection, as on Money.
  // FinOps has NO default chart, but timeseries-chart is addable (it renders
  // from the section's already-fetched series). alert-list is addable so a
  // removed alert tile can be restored from the panel.
  finops: ['kpi-tile', 'timeseries-chart', 'checklist', 'alert-list'],
  // Donut/table are the page's fixed DimensionedSection;
  // added grid tiles would have no data path on Build.
  // timeseries-chart is addable: it renders from the section's bridged
  // series, the FinOps pattern.
  build: ['kpi-tile', 'timeseries-chart', 'alert-list'],
  roi: [],
  mfiq: [],
}
