/**
 * The pure layout reducer. Framework-free and
 * node-testable; drag, remove, add, and the taxonomy picker ALL mutate
 * layout state through here, nowhere else.
 *
 * Every transition validates against the shared catalog schema; any invalid
 * action (unknown component, dimension/metric-rule violation, over-cap,
 * out-of-range index) returns the input state unchanged — never throws
 * mid-drag.
 */

import {
  CANONICAL_SIZE_BY_COMPONENT,
  MAX_TILES_PER_LAYOUT,
  TileInputSchema,
  TilesInputSchema,
  tileConfigKey,
  type DashboardLayoutTile,
} from '@/lib/component-catalog'
import type { LayoutAction } from './types'

/**
 * Bands are DERIVED from component type, never stored: a saved layout is
 * one flat array with no band field.
 */
export type TileBand = 'kpi' | 'content'

export function tileBand(
  tile: Pick<DashboardLayoutTile, 'component'>
): TileBand {
  return tile.component === 'kpi-tile' ? 'kpi' : 'content'
}

/**
 * Flat-array indices per band, in stored order. Render order is the kpi
 * list then the content list; a single-element move never disturbs the
 * other band's relative order, so an interleaved stored array displays
 * exactly as its per-band sequences.
 */
export function bandIndices(
  tiles: DashboardLayoutTile[]
): Record<TileBand, number[]> {
  const kpi: number[] = []
  const content: number[] = []
  tiles.forEach((tile, index) => {
    ;(tileBand(tile) === 'kpi' ? kpi : content).push(index)
  })
  return { kpi, content }
}

function isValidIndex(tiles: DashboardLayoutTile[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < tiles.length
}

function duplicatesExisting(
  tiles: DashboardLayoutTile[],
  candidate: DashboardLayoutTile,
  ignoreIndex?: number
): boolean {
  const key = tileConfigKey(candidate)
  return tiles.some(
    (tile, i) => i !== ignoreIndex && tileConfigKey(tile) === key
  )
}

export function layoutReducer(
  tiles: DashboardLayoutTile[],
  action: LayoutAction
): DashboardLayoutTile[] {
  switch (action.type) {
    case 'add': {
      if (tiles.length >= MAX_TILES_PER_LAYOUT) return tiles
      // Unknown component ⇒ no canonical size ⇒ schema parse below fails too,
      // but bail early so we never build a half-formed tile.
      const size = CANONICAL_SIZE_BY_COMPONENT[action.component]
      if (size === undefined) return tiles
      const candidate: DashboardLayoutTile = {
        component: action.component,
        size,
      }
      if (action.dimension !== undefined) candidate.dimension = action.dimension
      if (action.metric !== undefined) candidate.metric = action.metric
      if (!TileInputSchema.safeParse(candidate).success) return tiles
      // Adding an exact (component, metric, dimension) duplicate is
      // identity — same rule TilesInputSchema enforces server-side.
      if (duplicatesExisting(tiles, candidate)) return tiles
      return [...tiles, candidate]
    }

    case 'remove': {
      if (!isValidIndex(tiles, action.index)) return tiles
      return tiles.filter((_, i) => i !== action.index)
    }

    case 'move': {
      if (!isValidIndex(tiles, action.from) || !isValidIndex(tiles, action.to))
        return tiles
      if (action.from === action.to) return tiles
      // Bands are display-fixed (KPIs always first), so a cross-band move
      // could never land where it visually dropped — reject it outright
      // rather than commit a reorder the grid won't show.
      if (tileBand(tiles[action.from]) !== tileBand(tiles[action.to]))
        return tiles
      const next = [...tiles]
      const [moved] = next.splice(action.from, 1)
      next.splice(action.to, 0, moved)
      return next
    }

    case 'setDimension': {
      if (!isValidIndex(tiles, action.index)) return tiles
      const candidate: DashboardLayoutTile = {
        ...tiles[action.index],
        dimension: action.dimension,
      }
      if (!TileInputSchema.safeParse(candidate).success) return tiles
      // Re-pointing a tile onto another tile's exact config is identity too,
      // or the picker could manufacture the duplicate 'add' blocks.
      if (duplicatesExisting(tiles, candidate, action.index)) return tiles
      return tiles.map((tile, i) => (i === action.index ? candidate : tile))
    }

    case 'reset': {
      if (!TilesInputSchema.safeParse(action.defaults).success) return tiles
      return action.defaults.map((tile) => ({ ...tile }))
    }
  }
}
