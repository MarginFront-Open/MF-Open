import { TILE_METRIC_REGISTRY, type TileMetric } from '@/lib/component-catalog'
import { formatCost, formatPct } from '@/lib/canon-format'

// The ONE place a kpi-tile
// value becomes a string. Routes on TILE_METRIC_REGISTRY's `format` field so
// every TileMetric renders through canon-format — never a re-derived
// .toFixed. Null means "undefined for this window," not a zero: always '—',
// regardless of format.
export function formatMetric(metric: TileMetric, value: number | null): string {
  if (value === null) return '—'

  // Widen explicitly: TILE_METRIC_REGISTRY is `as const satisfies ...`, so
  // indexing it infers each entry's *actual* literal format ('cost' | 'pct' |
  // 'count' today) rather than the declared TileMetricSpec union — and a
  // plain type ANNOTATION here doesn't widen it back for switch narrowing
  // (TS keeps tracking the initializer's narrower type). An `as` assertion
  // does, keeping 'currency' a live, type-checked branch for when a future
  // registry entry uses it, instead of TS flagging it as unreachable.
  const format = TILE_METRIC_REGISTRY[metric].format as
    | 'cost'
    | 'currency'
    | 'pct'
    | 'count'
  switch (format) {
    case 'pct':
      return formatPct(value)
    case 'count':
      return value.toLocaleString()
    case 'cost':
    case 'currency':
      return formatCost(value)
  }
}
