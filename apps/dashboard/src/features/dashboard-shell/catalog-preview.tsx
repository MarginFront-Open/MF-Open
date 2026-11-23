'use client'

import { useReducer, useState, type ReactNode } from 'react'
import {
  COMPONENT_CATALOG,
  type ComponentId,
  type Dimension,
} from '@/lib/component-catalog'
import { MF_THEME_DARK, MF_THEME_LIGHT } from './mf-tokens'
import { layoutReducer } from './layout-state'
import { DimensionedSection, type MetricsResolver } from './dimensioned-section'
import { TileGrid } from './tile-grid'
import { DEFAULT_LAYOUTS } from './default-layouts'
import type { DashboardLayoutTile } from './types'
import { KpiTile } from './tiles/kpi-tile'
import { TimeseriesChart } from './tiles/timeseries-chart'
import { CategoryDonut } from './tiles/category-donut'
import { BreakdownTable } from './tiles/breakdown-table'
import { Checklist } from './tiles/checklist'
import { AlertList } from './tiles/alert-list'
import { Gauge } from './tiles/gauge'
import type { TileState } from './tiles/tile-frame'
import {
  CATALOG_PREVIEW_FIXTURES,
  KPI_TILE_FIXTURES_BY_METRIC,
  KPI_TILE_NULL_HONESTY_FIXTURE,
} from './preview-fixtures'

// Every catalog component, both themes, all 4
// states, on static fixtures. No auth, no DB, no server-action call (the
// dimensioned-section demo injects a fixture resolver through its `resolve`
// seam): this page exists so a developer can check the catalog without the real
// pages. The route-level NODE_ENV guard lives in page.tsx.

// Verbatim from metrics-resolver.ts's own catch-all — proves the error
// branch renders the resolver's real copy, not a placeholder string.
const ERROR_MESSAGE_FIXTURE =
  "Couldn't load metrics for this page. The database query failed. Refresh to retry; if it keeps happening, the database may be unreachable."

const STATES: TileState[] = ['ready', 'loading', 'empty', 'error']

function stateProps(state: TileState) {
  return {
    state,
    errorMessage: state === 'error' ? ERROR_MESSAGE_FIXTURE : undefined,
  }
}

function renderCatalogComponent(id: ComponentId, state: TileState): ReactNode {
  switch (id) {
    case 'kpi-tile':
      return (
        <KpiTile
          {...CATALOG_PREVIEW_FIXTURES['kpi-tile']}
          {...stateProps(state)}
        />
      )
    case 'timeseries-chart':
      return (
        <TimeseriesChart
          {...CATALOG_PREVIEW_FIXTURES['timeseries-chart']}
          {...stateProps(state)}
        />
      )
    case 'category-donut':
      return (
        <CategoryDonut
          {...CATALOG_PREVIEW_FIXTURES['category-donut']}
          {...stateProps(state)}
        />
      )
    case 'breakdown-table':
      return (
        <BreakdownTable
          {...CATALOG_PREVIEW_FIXTURES['breakdown-table']}
          {...stateProps(state)}
          onPageChange={() => {}}
        />
      )
    case 'checklist':
      return (
        <Checklist
          {...CATALOG_PREVIEW_FIXTURES['checklist']}
          {...stateProps(state)}
        />
      )
    case 'alert-list':
      return (
        <AlertList
          {...CATALOG_PREVIEW_FIXTURES['alert-list']}
          {...stateProps(state)}
        />
      )
    case 'gauge':
      return (
        <Gauge {...CATALOG_PREVIEW_FIXTURES['gauge']} {...stateProps(state)} />
      )
  }
}

// Same 7 components, but driven by a real DashboardLayoutTile from the
// layout reducer rather than one canonical per-id fixture — the kpi-tile
// case picks the fixture matching the tile's OWN metric so a Money-page
// grid full of Cost/Revenue/Margin/Overdue tiles doesn't show four
// identical "Cost" cards. Dimensioned tiles (chart/donut/table) reuse the
// single gallery fixture regardless of `tile.dimension` — wiring a fixture
// per dimension is page work, not catalog-component work.
function renderGridTile(tile: DashboardLayoutTile): ReactNode {
  switch (tile.component) {
    case 'kpi-tile': {
      const fixture = tile.metric
        ? KPI_TILE_FIXTURES_BY_METRIC[tile.metric]
        : CATALOG_PREVIEW_FIXTURES['kpi-tile']
      return <KpiTile {...fixture} state='ready' />
    }
    case 'timeseries-chart':
      return (
        <TimeseriesChart
          {...CATALOG_PREVIEW_FIXTURES['timeseries-chart']}
          state='ready'
        />
      )
    case 'category-donut':
      return (
        <CategoryDonut
          {...CATALOG_PREVIEW_FIXTURES['category-donut']}
          state='ready'
        />
      )
    case 'breakdown-table':
      return (
        <BreakdownTable
          {...CATALOG_PREVIEW_FIXTURES['breakdown-table']}
          state='ready'
          onPageChange={() => {}}
        />
      )
    case 'checklist':
      return (
        <Checklist {...CATALOG_PREVIEW_FIXTURES['checklist']} state='ready' />
      )
    case 'alert-list':
      return (
        <AlertList {...CATALOG_PREVIEW_FIXTURES['alert-list']} state='ready' />
      )
    case 'gauge':
      return <Gauge {...CATALOG_PREVIEW_FIXTURES['gauge']} state='ready' />
  }
}

// The Money default plus a second KPI row (MRR / ARR / Earned / Cost-per-
// task) so every registry metric family is visible in the demo grid without
// opening the add panel. Preview
// seed only; DEFAULT_LAYOUTS.money is the real page default.
const DEMO_GRID_TILES = [
  ...DEFAULT_LAYOUTS.money.slice(0, 4),
  { component: 'kpi-tile', metric: 'mrr', size: 'sm' },
  { component: 'kpi-tile', metric: 'arr', size: 'sm' },
  { component: 'kpi-tile', metric: 'earned', size: 'sm' },
  { component: 'kpi-tile', metric: 'costPerTask', size: 'sm' },
  ...DEFAULT_LAYOUTS.money.slice(4),
] satisfies DashboardLayoutTile[]

function TileGridDemo() {
  const [tiles, dispatch] = useReducer(layoutReducer, DEMO_GRID_TILES)
  const [editing, setEditing] = useState(true)

  return (
    <section className='mb-10'>
      <h2 className='mb-3 text-[13px] font-semibold text-foreground'>
        Tile grid: live reducer + drag
      </h2>
      <p className='mb-3 max-w-2xl text-[12px] text-muted-foreground'>
        The REAL <code>layoutReducer</code> and <code>TileGrid</code>, seeded
        with the Money page&apos;s default layout plus a second KPI row (MRR /
        ARR / Earned / Cost per usage event), running on local state only.
        Nothing here calls <code>saveDashboardLayout</code> or persists
        anything. Drag a tile, remove one, or add one from the panel below.
        Exact duplicates grey out. Tile CONTENT is illustrative fixture data
        (per-metric KPI values are real mock numbers; chart/donut/table content
        doesn&apos;t vary by the tile&apos;s own dimension).
      </p>
      <div className='mf-shell dark rounded-mf-card bg-mf-bg p-5'>
        <div className='mb-3 flex items-center gap-3'>
          <span className='text-[11px] text-mf-tx3'>{tiles.length} tiles</span>
          <button
            type='button'
            onClick={() => setEditing((e) => !e)}
            className='rounded-mf-seg border border-mf-bd px-2.5 py-1 text-[11px] text-mf-tx2 hover:text-mf-tx'
          >
            {editing ? 'Stop editing' : 'Edit layout'}
          </button>
          <button
            type='button'
            onClick={() =>
              dispatch({ type: 'reset', defaults: DEMO_GRID_TILES })
            }
            className='rounded-mf-seg border border-mf-bd px-2.5 py-1 text-[11px] text-mf-tx2 hover:text-mf-tx'
          >
            Reset to default
          </button>
        </div>
        <TileGrid
          page='money'
          tiles={tiles}
          editing={editing}
          onMove={(from, to) => dispatch({ type: 'move', from, to })}
          onRemove={(index) => dispatch({ type: 'remove', index })}
          onAdd={(component, config) =>
            dispatch({ type: 'add', component, ...config })
          }
          renderTile={renderGridTile}
        />
      </div>
    </section>
  )
}

// One live dimensioned-section on fixtures, with a working picker. Same
// 4,539 / 240,313 window totals as the gallery fixtures; each
// dimension gets its own bucket labels so a picker change visibly swaps the
// donut + table. Customer reuses the paginated table fixture (2 pages).
const PREVIEW_SECTION_SERIES =
  CATALOG_PREVIEW_FIXTURES['timeseries-chart'].series.find(
    (s) => s.label === 'Cost'
  )?.points ?? []

const PREVIEW_SECTION_WINDOW = {
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-06-30T00:00:00.000Z'),
  label: 'Last 30 days',
}

const PREVIEW_SECTION_TILES = {
  cost: 4539,
  eventCount: 240313,
  eventCountWithNullCost: 15900,
  costPerTask: 0.019,
}

const PREVIEW_SECTION_BUCKETS: Record<
  Exclude<Dimension, 'customer'>,
  [string, string]
> = {
  agent: ['Research Agent', 'Support Agent'],
  signal: ['Summarize inbox', 'Draft replies'],
  day: ['2026-06-28', '2026-06-29'],
  plan: ['Scale', 'Starter'],
  model: ['claude-sonnet-4-5', 'gpt-4o'],
  costCategory: ['COGS', 'R&D'],
  environment: ['Production', 'Staging'],
}

const previewSectionResolver: MetricsResolver = async (input) => {
  const page = input.breakdown?.page ?? 1
  if (input.dimension === 'customer') {
    const base = CATALOG_PREVIEW_FIXTURES['breakdown-table'].breakdown
    const breakdown =
      page <= 1
        ? base
        : {
            ...base,
            page,
            rows: [{ key: 'Internal · Dev', cost: 1024, eventCount: 579 }],
            other: null,
          }
    return {
      success: true,
      data: {
        window: PREVIEW_SECTION_WINDOW,
        tiles: PREVIEW_SECTION_TILES,
        series: PREVIEW_SECTION_SERIES,
        breakdown,
      },
    }
  }
  const [first, second] = PREVIEW_SECTION_BUCKETS[input.dimension]
  const rows = [
    { key: first, cost: 2890, eventCount: 156000 },
    { key: second, cost: 1325, eventCount: 68400 },
    { key: null, cost: 324, eventCount: 15900 },
  ]
  return {
    success: true,
    data: {
      window: PREVIEW_SECTION_WINDOW,
      tiles: PREVIEW_SECTION_TILES,
      series: PREVIEW_SECTION_SERIES,
      breakdown: {
        rows,
        totalRowCount: rows.length,
        other: null,
        page: 1,
        pageSize: rows.length,
        revenueBasis: null,
      },
    },
  }
}

function DimensionedSectionDemo() {
  return (
    <section className='mb-10'>
      <h2 className='mb-3 text-[13px] font-semibold text-foreground'>
        Dimensioned section: one call, one truth
      </h2>
      <p className='mb-3 max-w-2xl text-[12px] text-muted-foreground'>
        The real <code>DimensionedSection</code>: each picker change makes ONE
        resolver call, and the chart, donut, and table all render slices of that
        single response. They cannot disagree. Here the injected resolver
        answers with fixtures (pick Customer for a paginated table); real pages
        omit the <code>resolve</code> prop and get the live server action.
      </p>
      <div className='mf-shell dark rounded-mf-card bg-mf-bg p-5'>
        <DimensionedSection
          scope='money'
          period={{}}
          initialDimension='costCategory'
          title='Breakdown'
          resolveLabel={
            CATALOG_PREVIEW_FIXTURES['breakdown-table'].resolveLabel
          }
          resolve={previewSectionResolver}
        />
      </div>
    </section>
  )
}

function ThemeColumn({
  theme,
  id,
}: {
  theme: 'light' | 'dark'
  id: ComponentId
}) {
  return (
    <div className={`${theme} mf-shell rounded-mf-card bg-mf-bg p-4`}>
      <p className='mb-3 text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
        {theme}
      </p>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        {STATES.map((state) => (
          <div key={state}>
            <p className='mb-1 text-[9.5px] uppercase tracking-[.04em] text-mf-tx3'>
              {state}
            </p>
            {renderCatalogComponent(id, state)}
          </div>
        ))}
      </div>
    </div>
  )
}

function ComponentGallerySection({ id }: { id: ComponentId }) {
  return (
    <section className='mb-10'>
      <h2 className='mb-3 font-mono text-[13px] font-semibold text-foreground'>
        {id}
      </h2>
      <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
        <ThemeColumn theme='dark' id={id} />
        <ThemeColumn theme='light' id={id} />
      </div>
    </section>
  )
}

function TokenSwatchSheet() {
  const names = Object.keys(MF_THEME_DARK) as Array<keyof typeof MF_THEME_DARK>
  return (
    <section className='mb-10'>
      <h2 className='mb-3 text-[13px] font-semibold text-foreground'>
        Token swatches
      </h2>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        {(['dark', 'light'] as const).map((theme) => {
          const table = theme === 'dark' ? MF_THEME_DARK : MF_THEME_LIGHT
          return (
            <div
              key={theme}
              className={`${theme} mf-shell rounded-mf-card bg-mf-bg p-4`}
            >
              <p className='mb-2 text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
                {theme}
              </p>
              <div className='flex flex-col gap-1.5'>
                {names.map((name) => (
                  <div key={name} className='flex items-center gap-2'>
                    <span
                      className='h-3.5 w-3.5 shrink-0 rounded-sm border border-mf-bd'
                      style={{ background: table[name] }}
                    />
                    <span className='font-mono text-[11px] text-mf-tx2'>
                      {name}
                    </span>
                    <span className='ml-auto font-mono text-[10.5px] text-mf-tx3'>
                      {table[name]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NullHonestySection() {
  return (
    <section className='mb-10'>
      <h2 className='mb-3 text-[13px] font-semibold text-foreground'>
        Null-honesty
      </h2>
      <p className='mb-3 max-w-xl text-[12px] text-muted-foreground'>
        A number the resolver genuinely doesn&apos;t have (no MRR relationship,
        no agent attribution) renders as an honest dash or an
        &quot;Unassigned&quot; bucket, never a misleading zero. The &quot;Cost
        by agent&quot; donut above already carries an <code>Unassigned</code>{' '}
        slice for events with no agent key; this KPI tile shows the same rule
        for a scalar value.
      </p>
      <div className='mf-shell dark w-[220px] rounded-mf-card bg-mf-bg p-4'>
        <KpiTile {...KPI_TILE_NULL_HONESTY_FIXTURE} state='ready' />
      </div>
    </section>
  )
}

export function CatalogPreview() {
  return (
    <div className='mx-auto max-w-[1400px] px-6 py-8'>
      <div className='mb-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-600 dark:text-amber-400'>
        Dev-only page. Not linked from any nav, 404s outside development, and
        every component below renders from static fixtures, no login, no
        database, no real org data.
      </div>

      <h1 className='mb-1 text-[18px] font-semibold text-foreground'>
        Dashboard shell: catalog preview
      </h1>
      <p className='mb-8 max-w-2xl text-[13px] text-muted-foreground'>
        Every catalog component, both themes, all four states (ready / loading /
        empty / error), the token swatch sheet, a live drag/add/remove tile
        grid, and the live dimensioned section, the dimension-picker pairing
        that feeds a chart, donut, and table from one shared resolver response.
      </p>

      <TokenSwatchSheet />
      <NullHonestySection />
      <TileGridDemo />
      <DimensionedSectionDemo />

      {COMPONENT_CATALOG.map((id) => (
        <ComponentGallerySection key={id} id={id} />
      ))}
    </div>
  )
}
