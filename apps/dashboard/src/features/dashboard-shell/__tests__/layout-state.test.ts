/**
 * The pure layout reducer. Every mutation
 * path (drag, remove, add, picker) funnels through layoutReducer, so these
 * node tests are the whole behavioral contract: happy paths, catalog
 * whitelist rejections, the tile cap, and identity on every invalid action
 * (never throw mid-drag).
 */

import {
  CANONICAL_SIZE_BY_COMPONENT,
  DIMENSION_REGISTRY,
  MAX_TILES_PER_LAYOUT,
  TILE_METRIC_IDS,
  type DashboardLayoutTile,
} from '@/lib/component-catalog'
import { layoutReducer } from '../layout-state'
import type { LayoutAction } from '../types'

const baseTiles = (): DashboardLayoutTile[] => [
  { component: 'kpi-tile', metric: 'cost', size: 'sm' },
  { component: 'timeseries-chart', dimension: 'day', size: 'lg' },
  { component: 'breakdown-table', dimension: 'customer', size: 'lg' },
]

// CAP distinct configs (exact duplicates are blocked, so a full layout must
// be built from unique (component, metric, dimension) triples).
const uniqueFullLayout = (): DashboardLayoutTile[] => {
  const tiles: DashboardLayoutTile[] = [
    ...TILE_METRIC_IDS.map(
      (metric): DashboardLayoutTile => ({
        component: 'kpi-tile',
        metric,
        size: 'sm',
      })
    ),
    ...DIMENSION_REGISTRY.map(
      (dimension): DashboardLayoutTile => ({
        component: 'timeseries-chart',
        dimension,
        size: 'lg',
      })
    ),
    ...DIMENSION_REGISTRY.map(
      (dimension): DashboardLayoutTile => ({
        component: 'category-donut',
        dimension,
        size: 'md',
      })
    ),
  ]
  expect(tiles.length).toBeGreaterThanOrEqual(MAX_TILES_PER_LAYOUT)
  return tiles.slice(0, MAX_TILES_PER_LAYOUT)
}

const multiset = (tiles: DashboardLayoutTile[]) =>
  tiles.map((t) => JSON.stringify(t)).sort()

describe('layoutReducer — add', () => {
  it('appends and stamps the canonical size for the component type', () => {
    const next = layoutReducer(baseTiles(), {
      type: 'add',
      component: 'category-donut',
      dimension: 'costCategory',
    })
    expect(next).toHaveLength(4)
    expect(next[3]).toEqual({
      component: 'category-donut',
      dimension: 'costCategory',
      size: CANONICAL_SIZE_BY_COMPONENT['category-donut'],
    })
  })

  it('adds a kpi-tile with its metric', () => {
    const next = layoutReducer([], {
      type: 'add',
      component: 'kpi-tile',
      metric: 'revenue',
    })
    expect(next).toEqual([
      { component: 'kpi-tile', metric: 'revenue', size: 'sm' },
    ])
  })

  it('rejects an unknown component (identity)', () => {
    const tiles = baseTiles()
    const next = layoutReducer(tiles, {
      type: 'add',
      component: 'not-a-component',
    } as unknown as LayoutAction)
    expect(next).toBe(tiles)
  })

  it('rejects a dimensioned component without a dimension (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, { type: 'add', component: 'timeseries-chart' })
    ).toBe(tiles)
  })

  it('rejects a kpi-tile without a metric (identity)', () => {
    const tiles = baseTiles()
    expect(layoutReducer(tiles, { type: 'add', component: 'kpi-tile' })).toBe(
      tiles
    )
  })

  it('rejects a metric on a component that does not take one (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'add',
        component: 'checklist',
        metric: 'cost',
      })
    ).toBe(tiles)
  })

  it('rejects an unknown metric (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'add',
        component: 'kpi-tile',
        metric: 'not-a-metric',
      } as unknown as LayoutAction)
    ).toBe(tiles)
  })

  it(`caps the layout at MAX_TILES_PER_LAYOUT (${MAX_TILES_PER_LAYOUT})`, () => {
    // Unique configs throughout, so the CAP is what rejects this add — not
    // the duplicate rule (an all-identical layout would trip that first).
    const full = uniqueFullLayout()
    expect(
      layoutReducer(full, {
        type: 'add',
        component: 'breakdown-table',
        dimension: 'agent',
      })
    ).toBe(full)
  })
})

describe('layoutReducer — exact-duplicate rule', () => {
  it('adding an exact (component, metric) duplicate is identity', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'add',
        component: 'kpi-tile',
        metric: 'cost',
      })
    ).toBe(tiles)
  })

  it('adding an exact (component, dimension) duplicate is identity', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'add',
        component: 'timeseries-chart',
        dimension: 'day',
      })
    ).toBe(tiles)
  })

  it('a second kpi-tile with a DIFFERENT metric stays legal', () => {
    const next = layoutReducer(baseTiles(), {
      type: 'add',
      component: 'kpi-tile',
      metric: 'mrr',
    })
    expect(next).toHaveLength(4)
    expect(next[3]).toEqual({
      component: 'kpi-tile',
      metric: 'mrr',
      size: 'sm',
    })
  })

  it('a second chart with a DIFFERENT dimension stays legal', () => {
    const next = layoutReducer(baseTiles(), {
      type: 'add',
      component: 'timeseries-chart',
      dimension: 'agent',
    })
    expect(next).toHaveLength(4)
  })

  it('setDimension cannot re-point a tile onto another tile’s exact config', () => {
    const tiles: DashboardLayoutTile[] = [
      { component: 'timeseries-chart', dimension: 'day', size: 'lg' },
      { component: 'timeseries-chart', dimension: 'agent', size: 'lg' },
    ]
    expect(
      layoutReducer(tiles, { type: 'setDimension', index: 1, dimension: 'day' })
    ).toBe(tiles)
  })

  it('reset with duplicated defaults is identity (TilesInputSchema enforces the same rule)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'reset',
        defaults: [
          { component: 'kpi-tile', metric: 'cost', size: 'sm' },
          { component: 'kpi-tile', metric: 'cost', size: 'sm' },
        ],
      })
    ).toBe(tiles)
  })
})

describe('layoutReducer — remove', () => {
  it('removes exactly the indexed tile', () => {
    const next = layoutReducer(baseTiles(), { type: 'remove', index: 1 })
    expect(next).toHaveLength(2)
    expect(next.map((t) => t.component)).toEqual([
      'kpi-tile',
      'breakdown-table',
    ])
  })

  it.each([-1, 3, 0.5, NaN])('out-of-range index %p ⇒ identity', (index) => {
    const tiles = baseTiles()
    expect(layoutReducer(tiles, { type: 'remove', index })).toBe(tiles)
  })
})

describe('layoutReducer — move (the only drag mutation)', () => {
  // Moves here stay WITHIN a band (chart↔table↔donut are all content tiles);
  // the cross-band identity contract lives in layout-bands.test.ts.
  const contentTiles = (): DashboardLayoutTile[] => [
    { component: 'timeseries-chart', dimension: 'day', size: 'lg' },
    { component: 'breakdown-table', dimension: 'customer', size: 'lg' },
    { component: 'category-donut', dimension: 'costCategory', size: 'md' },
  ]

  it('reorders and is a permutation (same multiset before/after)', () => {
    const tiles = contentTiles()
    const next = layoutReducer(tiles, { type: 'move', from: 0, to: 2 })
    expect(next.map((t) => t.component)).toEqual([
      'breakdown-table',
      'category-donut',
      'timeseries-chart',
    ])
    expect(multiset(next)).toEqual(multiset(tiles))
  })

  it('moves backwards too', () => {
    const next = layoutReducer(contentTiles(), { type: 'move', from: 2, to: 0 })
    expect(next.map((t) => t.component)).toEqual([
      'category-donut',
      'timeseries-chart',
      'breakdown-table',
    ])
  })

  it.each([
    { from: -1, to: 1 },
    { from: 0, to: 3 },
    { from: 1.5, to: 0 },
  ])('out-of-range move %p ⇒ identity', ({ from, to }) => {
    const tiles = baseTiles()
    expect(layoutReducer(tiles, { type: 'move', from, to })).toBe(tiles)
  })

  it('from === to ⇒ identity', () => {
    const tiles = baseTiles()
    expect(layoutReducer(tiles, { type: 'move', from: 1, to: 1 })).toBe(tiles)
  })
})

describe('layoutReducer — setDimension', () => {
  it('re-points a dimensioned tile', () => {
    const next = layoutReducer(baseTiles(), {
      type: 'setDimension',
      index: 1,
      dimension: 'agent',
    })
    expect(next[1]).toEqual({
      component: 'timeseries-chart',
      dimension: 'agent',
      size: 'lg',
    })
  })

  it('rejects a dimension on a fixed component (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'setDimension',
        index: 0,
        dimension: 'agent',
      })
    ).toBe(tiles)
  })

  it('rejects an unknown dimension (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'setDimension',
        index: 1,
        dimension: 'not-a-dimension',
      } as unknown as LayoutAction)
    ).toBe(tiles)
  })

  it('out-of-range index ⇒ identity', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'setDimension',
        index: 9,
        dimension: 'agent',
      })
    ).toBe(tiles)
  })
})

describe('layoutReducer — reset', () => {
  it('replaces state with a copy of the defaults', () => {
    const defaults = baseTiles()
    const next = layoutReducer([], { type: 'reset', defaults })
    expect(next).toEqual(defaults)
    expect(next).not.toBe(defaults)
    expect(next[0]).not.toBe(defaults[0])
  })

  it('rejects invalid defaults (identity)', () => {
    const tiles = baseTiles()
    expect(
      layoutReducer(tiles, {
        type: 'reset',
        defaults: [
          { component: 'bogus', size: 'sm' },
        ] as unknown as DashboardLayoutTile[],
      })
    ).toBe(tiles)
  })
})

describe('layoutReducer — purity', () => {
  it('never mutates the input array', () => {
    const tiles = baseTiles()
    const snapshot = JSON.parse(JSON.stringify(tiles))
    layoutReducer(tiles, { type: 'add', component: 'kpi-tile', metric: 'mrr' })
    layoutReducer(tiles, { type: 'remove', index: 0 })
    layoutReducer(tiles, { type: 'move', from: 0, to: 2 })
    layoutReducer(tiles, { type: 'setDimension', index: 1, dimension: 'plan' })
    layoutReducer(tiles, { type: 'reset', defaults: [] })
    expect(tiles).toEqual(snapshot)
  })
})
