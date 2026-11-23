/**
 * The two-band layout contract. KPI tiles always
 * render as the first band, every other component below; drag reorders WITHIN
 * a band only. Bands are DERIVED from component type (layout rows stored
 * unchanged, one flat array), so the whole contract lives in the pure
 * helpers + the reducer's move guard — these node tests are the behavioral
 * spec. The cross-band-identity cases fail on a reducer without the band
 * guard, which would splice a KPI past the alert tile.
 */

import {
  COMPONENT_CATALOG,
  type DashboardLayoutTile,
} from '@/lib/component-catalog'
import { bandIndices, layoutReducer, tileBand } from '../layout-state'

const kpi = (metric: 'cost' | 'revenue' | 'mrr'): DashboardLayoutTile => ({
  component: 'kpi-tile',
  metric,
  size: 'sm',
})

const CHECKLIST: DashboardLayoutTile = { component: 'checklist', size: 'md' }
const ALERTS: DashboardLayoutTile = { component: 'alert-list', size: 'md' }

describe('tileBand — kpi-tile vs everything else', () => {
  it('kpi-tile is the kpi band', () => {
    expect(tileBand({ component: 'kpi-tile' })).toBe('kpi')
  })

  it.each(COMPONENT_CATALOG.filter((c) => c !== 'kpi-tile'))(
    '%s is the content band',
    (component) => {
      expect(tileBand({ component })).toBe('content')
    }
  )
})

describe('bandIndices — flat-index split, stored order preserved', () => {
  it('splits an interleaved array into per-band index lists', () => {
    const tiles = [CHECKLIST, kpi('cost'), ALERTS, kpi('revenue')]
    expect(bandIndices(tiles)).toEqual({ kpi: [1, 3], content: [0, 2] })
  })

  it('covers every index exactly once', () => {
    const tiles = [kpi('cost'), CHECKLIST, kpi('revenue'), ALERTS, kpi('mrr')]
    const { kpi: kpiBand, content } = bandIndices(tiles)
    expect([...kpiBand, ...content].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ])
  })

  it('an empty layout yields two empty bands', () => {
    expect(bandIndices([])).toEqual({ kpi: [], content: [] })
  })
})

describe('layoutReducer move: band-constrained', () => {
  it('a KPI → content-slot move is identity', () => {
    const tiles = [kpi('cost'), kpi('revenue'), ALERTS]
    expect(layoutReducer(tiles, { type: 'move', from: 0, to: 2 })).toBe(tiles)
  })

  it('a content → KPI-slot move is identity too', () => {
    const tiles = [kpi('cost'), CHECKLIST, ALERTS]
    expect(layoutReducer(tiles, { type: 'move', from: 2, to: 0 })).toBe(tiles)
  })

  it('a within-band KPI move still reorders', () => {
    const tiles = [kpi('cost'), kpi('revenue'), kpi('mrr'), ALERTS]
    const next = layoutReducer(tiles, { type: 'move', from: 2, to: 0 })
    expect(next.map((t) => t.metric)).toEqual([
      'mrr',
      'cost',
      'revenue',
      undefined,
    ])
  })

  it('a within-band move across an interleaved array never disturbs the other band', () => {
    // Stored order interleaves the bands (a saved layout with no band grouping).
    const tiles = [kpi('cost'), CHECKLIST, kpi('revenue'), kpi('mrr')]
    const next = layoutReducer(tiles, { type: 'move', from: 3, to: 0 })
    const bands = bandIndices(next)
    expect(bands.kpi.map((i) => next[i].metric)).toEqual([
      'mrr',
      'cost',
      'revenue',
    ])
    expect(bands.content.map((i) => next[i].component)).toEqual(['checklist'])
  })

  it('a within-band content move keeps the KPI order intact', () => {
    const tiles = [CHECKLIST, kpi('cost'), ALERTS, kpi('revenue')]
    const next = layoutReducer(tiles, { type: 'move', from: 0, to: 2 })
    const bands = bandIndices(next)
    expect(bands.content.map((i) => next[i].component)).toEqual([
      'alert-list',
      'checklist',
    ])
    expect(bands.kpi.map((i) => next[i].metric)).toEqual(['cost', 'revenue'])
  })
})

describe('layoutReducer add/remove/reset — banding is render-derived, storage untouched', () => {
  it('an added KPI appends to the array but joins the kpi band, even after content tiles', () => {
    const next = layoutReducer([ALERTS], {
      type: 'add',
      component: 'kpi-tile',
      metric: 'cost',
    })
    expect(next).toHaveLength(2)
    expect(bandIndices(next)).toEqual({ kpi: [1], content: [0] })
  })

  it('an added content tile joins the content band', () => {
    const next = layoutReducer([kpi('cost')], {
      type: 'add',
      component: 'alert-list',
    })
    expect(bandIndices(next)).toEqual({ kpi: [0], content: [1] })
  })

  it('remove works by flat index regardless of band', () => {
    const tiles = [CHECKLIST, kpi('cost'), ALERTS]
    const next = layoutReducer(tiles, { type: 'remove', index: 2 })
    expect(next).toEqual([CHECKLIST, kpi('cost')])
  })

  it('reset replaces state with the defaults verbatim — band order is a render concern', () => {
    const defaults = [CHECKLIST, kpi('cost')]
    const next = layoutReducer([], { type: 'reset', defaults })
    expect(next).toEqual(defaults)
  })
})
