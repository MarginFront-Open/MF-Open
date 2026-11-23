/**
 * The dashboard-layout catalog
 * (src/lib/component-catalog.ts). This module is the single source of
 * truth every layout row is validated against (dashboard-layouts.ts,
 * saved-views.ts) and the seam the catalog imports for the taxonomy picker —
 * see the module header's "do not fork it."
 *
 * The one cross-package contract worth locking down here: DIMENSION_REGISTRY
 * must stay byte-identical to @marginfront/db's DimensionSchema (the SQL
 * dimension-registry keys in packages/db/src/lib/cost-grouping.ts). A layout
 * tile that validates against one but not the other would let a user save a
 * dimension the metrics resolver can't actually group by.
 */

import { DimensionSchema } from '@marginfront/db'
import {
  ADDABLE_METRICS,
  CLOSE_TILE_METRICS,
  COMPONENT_CATALOG,
  DIMENSIONED_COMPONENTS,
  DIMENSION_REGISTRY,
  GROUP_BY_DIMENSIONS,
  RESOLVER_TILE_METRICS,
  SCOPE_TILE_SOURCES,
  TILE_METRIC_REGISTRY,
  TILE_SIZES,
  TilesInputSchema,
  DASHBOARD_PAGE_IDS,
  MAX_TILES_PER_LAYOUT,
  isCloseTileMetric,
  resolverTileValue,
  type CloseTileMetric,
  type TileMetric,
} from '../component-catalog'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import type { ResolvedTiles } from '@/app/actions/metrics-resolver'

describe('DIMENSION_REGISTRY parity with @marginfront/db DimensionSchema', () => {
  it('is exactly the 8 dimensions getCostBreakdown supports, same set', () => {
    expect([...DIMENSION_REGISTRY].sort()).toEqual(
      [...DimensionSchema.options].sort()
    )
  })

  it('has no duplicate entries', () => {
    expect(new Set(DIMENSION_REGISTRY).size).toBe(DIMENSION_REGISTRY.length)
  })

  it('DimensionSchema rejects a value not in the catalog (unknown-dimension guard)', () => {
    const result = DimensionSchema.safeParse('not-a-real-dimension')
    expect(result.success).toBe(false)
  })

  it('DimensionSchema accepts every catalog entry', () => {
    for (const dim of DIMENSION_REGISTRY) {
      expect(DimensionSchema.safeParse(dim).success).toBe(true)
    }
  })
})

// ── per-page "Group by" allow-list ─────────

describe('GROUP_BY_DIMENSIONS — Money omits Day + Category, FinOps omits Day', () => {
  it('covers exactly the six DASHBOARD_PAGE_IDS', () => {
    expect(Object.keys(GROUP_BY_DIMENSIONS).sort()).toEqual(
      [...DASHBOARD_PAGE_IDS].sort()
    )
  })

  it('the shared DIMENSION_REGISTRY has all 8, including day + costCategory (FinOps needs Category)', () => {
    expect([...DIMENSION_REGISTRY].sort()).toEqual(
      [
        'agent',
        'customer',
        'signal',
        'day',
        'plan',
        'model',
        'costCategory',
        'environment',
      ].sort()
    )
    expect(DIMENSION_REGISTRY).toContain('day')
    expect(DIMENSION_REGISTRY).toContain('costCategory')
  })

  it('money excludes day and costCategory', () => {
    expect(GROUP_BY_DIMENSIONS.money).not.toContain('day')
    expect(GROUP_BY_DIMENSIONS.money).not.toContain('costCategory')
  })

  it('money offers the other 6 dimensions', () => {
    expect([...GROUP_BY_DIMENSIONS.money].sort()).toEqual(
      ['agent', 'customer', 'signal', 'plan', 'model', 'environment'].sort()
    )
  })

  it('finops excludes day', () => {
    expect(GROUP_BY_DIMENSIONS.finops).not.toContain('day')
  })

  it('finops keeps costCategory (its initialDimension) plus the other 6', () => {
    expect([...GROUP_BY_DIMENSIONS.finops].sort()).toEqual(
      [
        'agent',
        'customer',
        'signal',
        'plan',
        'model',
        'costCategory',
        'environment',
      ].sort()
    )
  })

  it('every non-money, non-finops scope offers the full DIMENSION_REGISTRY (Build/ROI/MFiQ)', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      if (page === 'money' || page === 'finops') continue
      expect([...GROUP_BY_DIMENSIONS[page]].sort()).toEqual(
        [...DIMENSION_REGISTRY].sort()
      )
    }
  })

  it('every entry is a subset of the real DIMENSION_REGISTRY (no invented dimension)', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      for (const dimension of GROUP_BY_DIMENSIONS[page]) {
        expect(DIMENSION_REGISTRY).toContain(dimension)
      }
    }
  })
})

describe('COMPONENT_CATALOG — the seven component types', () => {
  it('has exactly the seven component types', () => {
    expect([...COMPONENT_CATALOG].sort()).toEqual(
      [
        'kpi-tile',
        'timeseries-chart',
        'category-donut',
        'breakdown-table',
        'checklist',
        'alert-list',
        'gauge',
      ].sort()
    )
  })

  it('has no duplicates', () => {
    expect(new Set(COMPONENT_CATALOG).size).toBe(COMPONENT_CATALOG.length)
  })
})

describe('DIMENSIONED_COMPONENTS — only chart/table types take a dimension', () => {
  it('contains exactly timeseries-chart, category-donut, breakdown-table', () => {
    expect([...DIMENSIONED_COMPONENTS].sort()).toEqual(
      ['timeseries-chart', 'category-donut', 'breakdown-table'].sort()
    )
  })

  it('every dimensioned component is a real catalog entry', () => {
    for (const c of DIMENSIONED_COMPONENTS) {
      expect(COMPONENT_CATALOG).toContain(c)
    }
  })

  it('the four fixed-content components do not take a dimension', () => {
    const fixed = COMPONENT_CATALOG.filter(
      (c) => !DIMENSIONED_COMPONENTS.has(c)
    )
    expect(fixed.sort()).toEqual(
      ['kpi-tile', 'checklist', 'alert-list', 'gauge'].sort()
    )
  })
})

describe('DASHBOARD_PAGE_IDS — the five pages with a per-user layout', () => {
  it('has exactly the five page ids, including mfiq spelled with no separator', () => {
    expect([...DASHBOARD_PAGE_IDS].sort()).toEqual(
      ['money', 'finops', 'build', 'roi', 'mfiq'].sort()
    )
  })

  it('includes mfiq', () => {
    expect(DASHBOARD_PAGE_IDS).toContain('mfiq')
  })
})

describe('TILE_SIZES + MAX_TILES_PER_LAYOUT', () => {
  it('has exactly sm/md/lg', () => {
    expect([...TILE_SIZES].sort()).toEqual(['sm', 'md', 'lg'].sort())
  })

  it('caps layouts at 24 tiles', () => {
    expect(MAX_TILES_PER_LAYOUT).toBe(24)
  })
})

// ── the scope map + the derived per-page add-panel gating ─────────────────

describe('SCOPE_TILE_SOURCES — per-scope tile map', () => {
  it('covers exactly the six DASHBOARD_PAGE_IDS', () => {
    expect(Object.keys(SCOPE_TILE_SOURCES).sort()).toEqual(
      [...DASHBOARD_PAGE_IDS].sort()
    )
  })

  it('every entry declares all four source flags', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      const entry = SCOPE_TILE_SOURCES[page]
      expect(typeof entry.revenue).toBe('boolean')
      expect(typeof entry.invoices).toBe('boolean')
      expect(typeof entry.mrr).toBe('boolean')
      expect(typeof entry.earned).toBe('boolean')
    }
  })
})

describe('ADDABLE_METRICS — per-page add-panel gating agrees with SCOPE_TILE_SOURCES', () => {
  // Always available regardless of scope — every page's resolver runs
  // getCostBreakdown, which feeds these three tiles unconditionally.
  const ALWAYS_ON: TileMetric[] = ['cost', 'eventCount', 'costPerTask']

  it('covers exactly the six DASHBOARD_PAGE_IDS', () => {
    expect(Object.keys(ADDABLE_METRICS).sort()).toEqual(
      [...DASHBOARD_PAGE_IDS].sort()
    )
  })

  it('every listed metric is a real TILE_METRIC_REGISTRY key', () => {
    const registryKeys = Object.keys(TILE_METRIC_REGISTRY)
    for (const page of DASHBOARD_PAGE_IDS) {
      for (const metric of ADDABLE_METRICS[page]) {
        expect(registryKeys).toContain(metric)
      }
    }
  })

  it('offers overdueAmount ONLY on money, the one page with sources.invoices true (removable there, so it must be re-addable there)', () => {
    expect(ADDABLE_METRICS.money).toContain('overdueAmount')
    for (const page of DASHBOARD_PAGE_IDS) {
      if (page === 'money') continue
      expect(ADDABLE_METRICS[page]).not.toContain('overdueAmount')
    }
  })

  it.each(DASHBOARD_PAGE_IDS)(
    'every metric offered for "%s" is either always-on or backed by a true SCOPE_TILE_SOURCES flag (or the close engine, finops only)',
    (page) => {
      const sources = SCOPE_TILE_SOURCES[page]
      for (const metric of ADDABLE_METRICS[page]) {
        if (ALWAYS_ON.includes(metric)) continue
        const backedByRevenue =
          (metric === 'revenue' || metric === 'marginPercent') &&
          sources.revenue
        const backedByMrr =
          (metric === 'mrr' || metric === 'arr') && sources.mrr
        const backedByEarned = metric === 'earned' && sources.earned
        const backedByInvoices = metric === 'overdueAmount' && sources.invoices
        // Close metrics gate on the close-status action (getFinopsCloseStatus),
        // not a SCOPE_TILE_SOURCES flag — only finops has that engine.
        const backedByCloseEngine =
          isCloseTileMetric(metric) && page === 'finops'
        expect(
          backedByRevenue ||
            backedByMrr ||
            backedByEarned ||
            backedByInvoices ||
            backedByCloseEngine
        ).toBe(true)
      }
    }
  )

  it('close metrics appear in ADDABLE_METRICS.finops and NOWHERE else', () => {
    const closeMetrics = Object.keys(CLOSE_TILE_METRICS) as CloseTileMetric[]
    for (const metric of closeMetrics) {
      expect(ADDABLE_METRICS.finops).toContain(metric)
    }
    for (const page of DASHBOARD_PAGE_IDS) {
      if (page === 'finops') continue
      for (const metric of closeMetrics) {
        expect(ADDABLE_METRICS[page]).not.toContain(metric)
      }
    }
  })

  it('build never offers revenue/marginPercent/mrr/arr/overdueAmount', () => {
    for (const metric of [
      'revenue',
      'marginPercent',
      'mrr',
      'arr',
      'overdueAmount',
    ]) {
      expect(ADDABLE_METRICS.build).not.toContain(metric)
    }
  })

  it('money offers the full revenue set (revenue, marginPercent, mrr, arr, overdueAmount)', () => {
    for (const metric of [
      'revenue',
      'marginPercent',
      'mrr',
      'arr',
      'overdueAmount',
    ]) {
      expect(ADDABLE_METRICS.money).toContain(metric)
    }
  })

  it('roi and mfiq (no per-user layout) offer nothing to add', () => {
    expect(ADDABLE_METRICS.roi).toEqual([])
    expect(ADDABLE_METRICS.mfiq).toEqual([])
  })
})

// ── the source-typed registry split, close-metric tooltips, schema pickup,
// and the typed accessor ──────

describe('TILE_METRIC_REGISTRY split — RESOLVER ∪ CLOSE, disjoint', () => {
  it('the merged registry key set is exactly the union of the two sub-maps', () => {
    const merged = Object.keys(TILE_METRIC_REGISTRY).sort()
    const union = [
      ...Object.keys(RESOLVER_TILE_METRICS),
      ...Object.keys(CLOSE_TILE_METRICS),
    ].sort()
    expect(merged).toEqual(union)
  })

  it('the two sub-maps are disjoint — a metric has exactly one source', () => {
    const resolverKeys = new Set(Object.keys(RESOLVER_TILE_METRICS))
    for (const key of Object.keys(CLOSE_TILE_METRICS)) {
      expect(resolverKeys.has(key)).toBe(false)
    }
  })

  it('the close sub-map holds exactly the 4 close metrics', () => {
    expect(Object.keys(CLOSE_TILE_METRICS).sort()).toEqual(
      ['categorizedPct', 'closeProgress', 'daysToClose', 'unmappedCount'].sort()
    )
  })

  it('the 9 resolver-backed keys keep their public shape', () => {
    expect(Object.keys(RESOLVER_TILE_METRICS).sort()).toEqual(
      [
        'cost',
        'revenue',
        'marginPercent',
        'overdueAmount',
        'mrr',
        'arr',
        'earned',
        'costPerTask',
        'eventCount',
      ].sort()
    )
  })

  it('isCloseTileMetric answers true for close keys, false for resolver keys', () => {
    for (const metric of Object.keys(CLOSE_TILE_METRICS) as TileMetric[]) {
      expect(isCloseTileMetric(metric)).toBe(true)
    }
    for (const metric of Object.keys(RESOLVER_TILE_METRICS) as TileMetric[]) {
      expect(isCloseTileMetric(metric)).toBe(false)
    }
  })

  it("every close metric's tooltipKey resolves in tooltipDefinitions (real import)", () => {
    for (const spec of Object.values(CLOSE_TILE_METRICS)) {
      expect(tooltipDefinitions[spec.tooltipKey]).toBeDefined()
      expect(
        tooltipDefinitions[spec.tooltipKey].description.length
      ).toBeGreaterThan(0)
    }
  })
})

describe('TilesInputSchema picks the close keys up automatically', () => {
  const kpi = (metric: TileMetric) => ({
    component: 'kpi-tile',
    metric,
    size: 'sm',
  })

  it('accepts [kpi(closeProgress)]', () => {
    expect(TilesInputSchema.safeParse([kpi('closeProgress')]).success).toBe(
      true
    )
  })

  it('still rejects a metric on a checklist tile', () => {
    const result = TilesInputSchema.safeParse([
      { component: 'checklist', metric: 'closeProgress', size: 'md' },
    ])
    expect(result.success).toBe(false)
  })

  it('still rejects a duplicate kpi(closeProgress) pair', () => {
    const result = TilesInputSchema.safeParse([
      kpi('closeProgress'),
      kpi('closeProgress'),
    ])
    expect(result.success).toBe(false)
  })
})

describe('resolverTileValue — the typed accessor', () => {
  const tiles: ResolvedTiles = {
    cost: 4539,
    eventCount: 240313,
    eventCountWithNullCost: 12,
    costPerTask: 0.019,
    revenue: 13090,
    marginPercent: 65,
    overdueAmount: 1120,
    mrr: 9840,
    arr: 118080,
    earned: 8210,
  }

  it.each(Object.keys(CLOSE_TILE_METRICS) as TileMetric[])(
    'returns null for close metric "%s" — close values never come from the resolver',
    (metric) => {
      expect(resolverTileValue(tiles, metric)).toBeNull()
    }
  )

  it.each(Object.keys(RESOLVER_TILE_METRICS) as TileMetric[])(
    'passes through the resolver value for "%s"',
    (metric) => {
      expect(resolverTileValue(tiles, metric)).toBe(
        tiles[metric as keyof ResolvedTiles] ?? null
      )
    }
  )

  it('null-coalesces a scope-absent optional field (build scope has no revenue)', () => {
    const costOnly: ResolvedTiles = {
      cost: 100,
      eventCount: 5,
      eventCountWithNullCost: 0,
      costPerTask: 20,
    }
    expect(resolverTileValue(costOnly, 'revenue')).toBeNull()
    expect(resolverTileValue(costOnly, 'mrr')).toBeNull()
    expect(resolverTileValue(costOnly, 'cost')).toBe(100)
  })

  it('null costPerTask stays null, never 0 (canon M2)', () => {
    const zeroEvents: ResolvedTiles = {
      cost: 0,
      eventCount: 0,
      eventCountWithNullCost: 0,
      costPerTask: null,
    }
    expect(resolverTileValue(zeroEvents, 'costPerTask')).toBeNull()
  })
})
