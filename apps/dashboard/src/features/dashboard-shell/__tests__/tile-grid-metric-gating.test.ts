/**
 * Tile-grid.tsx's addOptionsFor() must
 * offer a page only the metrics component-catalog.ts's ADDABLE_METRICS
 * allows for that page, not every TILE_METRIC_REGISTRY key regardless of
 * scope (a Build "Revenue" tile on a scope with no revenue). tile-grid.tsx
 * imports @dnd-kit/core, so — like tile-grid-drag.test.ts — this is a
 * source-assert, not a real import (dashboard jest is node-only, no RTL).
 * The actual per-page metric sets are proven directly against
 * SCOPE_TILE_SOURCES in component-catalog.test.ts; this file only proves
 * addOptionsFor reads from ADDABLE_METRICS instead of the full registry.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'tile-grid.tsx'), 'utf8')

describe('tile-grid.tsx — addOptionsFor per-page metric gating', () => {
  it('imports ADDABLE_METRICS from @/lib/component-catalog', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bADDABLE_METRICS\b[^}]*\}\s*from\s*['"]@\/lib\/component-catalog['"]/
    )
  })

  it('the kpi-tile branch maps over ADDABLE_METRICS[page], not every registry key', () => {
    expect(src).toMatch(/ADDABLE_METRICS\[page\]\.map/)
    expect(src).not.toMatch(/Object\.keys\(TILE_METRIC_REGISTRY\)/)
  })

  it('still looks up the option label from TILE_METRIC_REGISTRY (labels stay centralized)', () => {
    expect(src).toMatch(/TILE_METRIC_REGISTRY\[metric\]\.label/)
  })
})
