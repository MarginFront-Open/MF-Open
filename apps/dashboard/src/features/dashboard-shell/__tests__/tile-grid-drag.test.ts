/**
 * The two-band drag contract for tile-grid.tsx (source-assert: dashboard jest
 * is node-only, no RTL).
 *
 * A single-grid rectSortingStrategy scales mixed-span tiles into each other's
 * slots, and a whole-grid closestCenter lets a KPI drop resolve to a
 * different tile than the one under the pointer. The band model avoids both:
 * each band is its own DndContext
 * (a drag can only target its own band), the uniform-span KPI band gets
 * true live reflow via rectSortingStrategy with hand-built translate-only
 * transforms, and the mixed-span content band keeps the null strategy +
 * DragOverlay ghost + drop-target ring.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'tile-grid.tsx'), 'utf8')

describe('tile-grid.tsx — two-band structure', () => {
  it('derives bands from layout-state.ts#bandIndices (single source with the reducer guard)', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bbandIndices\b[^}]*\}\s*from\s*['"]\.\/layout-state['"]/
    )
    expect(src).toMatch(/bandIndices\(tiles\)/)
  })

  it('renders the kpi band before the content band', () => {
    expect(src).toMatch(/\(\['kpi', 'content'\] as const\)\.map/)
  })

  it('each band mounts its own DndContext, so a drag can never target the other band', () => {
    const bandGridStart = src.indexOf('function BandGrid')
    expect(bandGridStart).toBeGreaterThan(-1)
    expect(src.slice(bandGridStart)).toMatch(/<DndContext/)
    // TileGrid itself holds no DndContext — only BandGrid does.
    expect(src.slice(0, bandGridStart)).not.toMatch(/<DndContext/)
  })

  it('sorts each band over its own flat indices', () => {
    expect(src).toMatch(/items=\{indices\.map\(String\)\}/)
  })
})

describe('tile-grid.tsx — per-band strategies', () => {
  it('KPI band live-reflows with rectSortingStrategy; content band keeps the null strategy', () => {
    expect(src).toMatch(
      /strategy=\{band === 'kpi' \? rectSortingStrategy : noLivePreview\}/
    )
    expect(src).toMatch(/SortingStrategy = \(\) => null/)
  })

  it('transforms are hand-built translate3d (CSS.Transform is banned because it applies scale)', () => {
    expect(src).toMatch(
      /translate3d\(\$\{transform\.x\}px, \$\{transform\.y\}px, 0\)/
    )
    expect(src).not.toMatch(/CSS\.Transform/)
    expect(src).not.toMatch(/@dnd-kit\/utilities/)
    expect(src).not.toMatch(/scaleX/)
  })

  it('only the live-reflow band applies the strategy transform, never the dragged source', () => {
    expect(src).toMatch(/liveReflow && !isDragging && transform/)
  })

  it('renders the dragged tile in a DragOverlay ghost', () => {
    expect(src).toMatch(/DragOverlay/)
  })

  it('content band keeps the drop-target ring; the reflow band relies on the parted gap', () => {
    expect(src).toMatch(/!liveReflow &&\s*\n?\s*!isDragging &&\s*\n?\s*isOver/)
  })

  it('uses closestCenter collision detection (scoped per band)', () => {
    expect(src).toMatch(/collisionDetection=\{closestCenter\}/)
    expect(src).not.toMatch(/collisionDetection=\{rectIntersection\}/)
  })

  it('guards the grid container against horizontal overflow', () => {
    expect(src).toMatch(/grid grid-cols-12 gap-3 overflow-x-clip/)
  })
})

describe('tile-grid.tsx — add panel', () => {
  it('greys out exact-duplicate configs via tileConfigKey', () => {
    expect(src).toMatch(/tileConfigKey/)
    expect(src).toMatch(/alreadyAdded/)
  })

  it('groups the options by destination band', () => {
    expect(src).toMatch(/BAND_LABELS\.kpi/)
    expect(src).toMatch(/BAND_LABELS\.content/)
    expect(src).toMatch(/option\.component === 'kpi-tile'/)
  })
})
