/**
 * A tile's header (title + optional info icon) must survive ALL FOUR
 * TileFrame states. FinOps's "Needs attention" tile can go state='empty',
 * and swapping the children (header included) away would leave an unlabeled
 * card. These are REAL renders via react-dom/server (no DOM needed, so
 * node-env jest can run them): mutate the state prop, assert the header
 * substring survives. createElement, not JSX — testMatch only picks up .ts.
 */
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TileFrame, type TileState } from '../tiles/tile-frame'
import { AlertList } from '../tiles/alert-list'
import { Checklist } from '../tiles/checklist'
import { Gauge } from '../tiles/gauge'
import { CategoryDonut } from '../tiles/category-donut'
import { BreakdownTable } from '../tiles/breakdown-table'
import { KpiTile } from '../tiles/kpi-tile'
import { TimeseriesChart } from '../tiles/timeseries-chart'
import type { ResolvedBreakdown } from '../types'

const STATES: TileState[] = ['loading', 'empty', 'error', 'ready']

const EMPTY_BREAKDOWN: ResolvedBreakdown = {
  rows: [],
  totalRowCount: 0,
  other: null,
  page: 1,
  pageSize: 25,
  revenueBasis: null,
}

// [tile name, element factory, header substring the markup must contain]
const TILE_CASES: Array<[string, (state: TileState) => ReactElement, string]> =
  [
    [
      'AlertList',
      (state) =>
        createElement(AlertList, {
          title: 'Needs attention',
          tooltipKey: 'needsAttention',
          items: [],
          state,
        }),
      'Needs attention',
    ],
    [
      'Checklist',
      (state) =>
        createElement(Checklist, {
          title: 'Month-end close',
          tooltipKey: 'monthEndClose',
          items: [],
          state,
        }),
      'Month-end close',
    ],
    [
      'Gauge',
      (state) =>
        createElement(Gauge, {
          title: 'Defensibility',
          value: null,
          max: 100,
          label: 'score',
          state,
        }),
      'Defensibility',
    ],
    [
      'CategoryDonut',
      (state) =>
        createElement(CategoryDonut, {
          title: 'Cost by category',
          rows: [],
          other: null,
          state,
        }),
      'Cost by category',
    ],
    [
      'BreakdownTable',
      (state) =>
        createElement(BreakdownTable, {
          title: 'Breakdown',
          breakdown: EMPTY_BREAKDOWN,
          totals: { cost: 0, eventCount: 0 },
          onPageChange: () => undefined,
          state,
        }),
      'Breakdown',
    ],
    [
      'KpiTile',
      (state) => createElement(KpiTile, { metric: 'cost', value: null, state }),
      'Cost',
    ],
    [
      'TimeseriesChart',
      (state) =>
        createElement(TimeseriesChart, {
          title: 'Cost vs revenue',
          series: [],
          valueFormat: 'cost',
          state,
        }),
      'Cost vs revenue',
    ],
  ]

describe('tile headers render in all four states', () => {
  describe.each(TILE_CASES)('%s', (_name, factory, headerText) => {
    it.each(STATES)('keeps its title in state=%s', (state) => {
      expect(renderToStaticMarkup(factory(state))).toContain(headerText)
    })
  })

  it.each(STATES)(
    'AlertList keeps its info-tooltip icon in state=%s',
    (state) => {
      const markup = renderToStaticMarkup(TILE_CASES[0][1](state))
      expect(markup).toContain('What Needs attention means')
    }
  )

  it.each(STATES)(
    "Checklist keeps the 'Month-end close' info-tooltip icon in state=%s",
    (state) => {
      const markup = renderToStaticMarkup(TILE_CASES[1][1](state))
      expect(markup).toContain('What Month-end close means')
    }
  )

  it('TileFrame renders the header prop itself in every state, alongside the state body', () => {
    for (const state of STATES) {
      const markup = renderToStaticMarkup(
        // Children as a prop, not a third argument: TileFrameProps marks
        // children required, and createElement's overloads don't count the
        // rest-argument form toward that.
        // eslint-disable-next-line react/no-children-prop -- createElement takes children as a prop here
        createElement(TileFrame, {
          state,
          header: createElement('span', null, 'HEADER-SENTINEL'),
          emptyMessage: 'nothing here',
          errorMessage: 'it broke',
          children: createElement('span', null, 'READY-BODY'),
        })
      )
      expect(markup).toContain('HEADER-SENTINEL')
      if (state === 'ready') expect(markup).toContain('READY-BODY')
      if (state === 'empty') expect(markup).toContain('nothing here')
      if (state === 'error') expect(markup).toContain('it broke')
    }
  })
})
