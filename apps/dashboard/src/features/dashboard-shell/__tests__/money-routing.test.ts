/**
 * Every money-rendering surface in
 * tiles/*.tsx routes through canon-format, never a re-derived .toFixed/
 * .toLocaleString on a money value. Mirrors the canon display guard in
 * eslint.config.mjs: that rule only fires on .toFixed calls whose
 * object/property name looks money-shaped (cost|revenue|margin|amount|
 * price|earned|billed|collected|mrr|arr) — kpi-tile's sparkline geometry
 * legitimately keeps its own bare `x.toFixed(1)`/`y.toFixed(1)` pixel-coord
 * rounding, so this test checks for MONEY-named .toFixed/.toLocaleString,
 * not a blanket ban (a blanket ban would be a false positive here).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { formatCost, formatPct } from '@/lib/canon-format'
import { TILE_METRIC_REGISTRY, type TileMetric } from '@/lib/component-catalog'
import { formatMetric } from '../tiles/format-metric'

const TILES_DIR = join(__dirname, '..', 'tiles')

// The four components that render a canon $-surface (exact
// list). checklist/alert-list/gauge never format money themselves — see
// their source: checklist/alert-list take pre-composed strings, gauge
// renders a score, not a dollar figure.
const MONEY_TILE_FILES = [
  'kpi-tile.tsx',
  'timeseries-chart.tsx',
  'category-donut.tsx',
  'breakdown-table.tsx',
]

const MONEY_NAME =
  '(?:cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)'
const MONEY_TOFIXED = new RegExp(
  `\\w*${MONEY_NAME}\\w*\\s*\\.\\s*toFixed\\(`,
  'i'
)
const MONEY_TOLOCALE = new RegExp(
  `\\w*${MONEY_NAME}\\w*\\s*\\.\\s*toLocaleString\\(`,
  'i'
)

describe.each(MONEY_TILE_FILES)(
  '%s — money routing (source-assert)',
  (file) => {
    const src = readFileSync(join(TILES_DIR, file), 'utf8')

    it('imports from @/lib/canon-format', () => {
      expect(src).toMatch(/from ['"]@\/lib\/canon-format['"]/)
    })

    it('has no .toFixed( on a money-named value', () => {
      expect(src).not.toMatch(MONEY_TOFIXED)
    })

    it('has no .toLocaleString( on a money-named value (counts only)', () => {
      expect(src).not.toMatch(MONEY_TOLOCALE)
    })
  }
)

describe('TILE_METRIC_REGISTRY — every TileMetric maps to a format canon-format can render', () => {
  const ALL_METRICS = Object.keys(TILE_METRIC_REGISTRY) as TileMetric[]
  const KNOWN_FORMATS = new Set(['cost', 'currency', 'pct', 'count'])

  it.each(ALL_METRICS)('%s declares a known format', (metric) => {
    expect(KNOWN_FORMATS.has(TILE_METRIC_REGISTRY[metric].format)).toBe(true)
  })

  it('cost-format metrics render through formatCost (matches formatMetric output)', () => {
    const costMetrics = ALL_METRICS.filter(
      (m) => TILE_METRIC_REGISTRY[m].format === 'cost'
    )
    expect(costMetrics.length).toBeGreaterThan(0)
    for (const metric of costMetrics) {
      expect(formatMetric(metric, 4539)).toBe(formatCost(4539))
    }
  })

  it('pct-format metrics render through formatPct (matches formatMetric output)', () => {
    const pctMetrics = ALL_METRICS.filter(
      (m) => TILE_METRIC_REGISTRY[m].format === 'pct'
    )
    expect(pctMetrics.length).toBeGreaterThan(0)
    for (const metric of pctMetrics) {
      expect(formatMetric(metric, 65)).toBe(formatPct(65))
    }
  })

  it('count-format metrics render through toLocaleString, not formatCost/formatPct', () => {
    const countMetrics = ALL_METRICS.filter(
      (m) => TILE_METRIC_REGISTRY[m].format === 'count'
    )
    expect(countMetrics.length).toBeGreaterThan(0)
    for (const metric of countMetrics) {
      expect(formatMetric(metric, 240313)).toBe((240313).toLocaleString())
    }
  })
})

describe('formatMetric — null path renders "—" for every TileMetric (canon M1, never ?? 0)', () => {
  it.each(Object.keys(TILE_METRIC_REGISTRY) as TileMetric[])('%s', (metric) => {
    expect(formatMetric(metric, null)).toBe('—')
  })
})
