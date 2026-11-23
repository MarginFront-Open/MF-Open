/**
 * Every per-page default validates against
 * the REAL shared catalog schema (no test-local copy), every page id is
 * covered by all three config maps, and FinOps stays month-locked.
 */

import {
  CLOSE_TILE_METRICS,
  COMPONENT_CATALOG,
  DASHBOARD_PAGE_IDS,
  MAX_TILES_PER_LAYOUT,
  TILE_METRIC_REGISTRY,
  TileInputSchema,
  TilesInputSchema,
} from '@/lib/component-catalog'
import { monthPeriod } from '@/features/_shared/billing-period'
import {
  ADDABLE_COMPONENTS,
  DEFAULT_LAYOUTS,
  PAGE_DATE_RANGE,
} from '../default-layouts'

const pageIds = [...DASHBOARD_PAGE_IDS].sort()

describe('coverage — every dashboard page has defaults, a date-range config, and an addable list', () => {
  it.each([
    ['DEFAULT_LAYOUTS', DEFAULT_LAYOUTS],
    ['PAGE_DATE_RANGE', PAGE_DATE_RANGE],
    ['ADDABLE_COMPONENTS', ADDABLE_COMPONENTS],
  ] as const)('%s covers exactly the DASHBOARD_PAGE_IDS', (_name, record) => {
    expect(Object.keys(record).sort()).toEqual(pageIds)
  })
})

describe('DEFAULT_LAYOUTS — valid against the lifted TileInputSchema', () => {
  it('every default tile parses (the exact schema saveDashboardLayout enforces)', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      for (const tile of DEFAULT_LAYOUTS[page]) {
        const result = TileInputSchema.safeParse(tile)
        expect(
          result.success
            ? null
            : `${page}: ${JSON.stringify(tile)} → ${result.error.issues[0].message}`
        ).toBeNull()
      }
    }
  })

  it('every kpi metric is a TILE_METRIC_REGISTRY key', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      for (const tile of DEFAULT_LAYOUTS[page]) {
        if (tile.component === 'kpi-tile') {
          expect(Object.keys(TILE_METRIC_REGISTRY)).toContain(tile.metric)
        }
      }
    }
  })

  it('every layout fits under the tile cap', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      expect(DEFAULT_LAYOUTS[page].length).toBeLessThanOrEqual(
        MAX_TILES_PER_LAYOUT
      )
    }
  })
})

// ── KPIs first on EVERY page ────────────

describe('DEFAULT_LAYOUTS — KPI tiles always lead', () => {
  it.each([...DASHBOARD_PAGE_IDS])(
    '%s: no kpi-tile appears after a non-KPI tile',
    (page) => {
      const components = DEFAULT_LAYOUTS[page].map((tile) => tile.component)
      const firstContentIndex = components.findIndex(
        (component) => component !== 'kpi-tile'
      )
      if (firstContentIndex !== -1) {
        expect(components.slice(firstContentIndex)).not.toContain('kpi-tile')
      }
    }
  )
})

describe('PAGE_DATE_RANGE — per-page window rules', () => {
  // Only a month that has ENDED is closeable, so the FinOps default points
  // at the last complete month, not the in-progress one.
  it('FinOps defaults to the last COMPLETE month, not the in-progress one', () => {
    expect(PAGE_DATE_RANGE.finops.modes).toEqual(['month'])
    expect(PAGE_DATE_RANGE.finops.default).toEqual({
      mode: 'month',
      monthsAgo: 1,
    })
  })

  it('the default month is strictly before the current month, not equal to it', () => {
    const defaultMonthsAgo = (
      PAGE_DATE_RANGE.finops.default as { monthsAgo: number }
    ).monthsAgo
    const defaulted = monthPeriod(defaultMonthsAgo)
    const current = monthPeriod(0)
    expect(defaulted.monthLabel).not.toBe(current.monthLabel)
    expect(defaulted.endDate < current.startDate).toBe(true)
  })

  it('every config default is either null (empty modes) or an allowed mode', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      const config = PAGE_DATE_RANGE[page]
      if (config.modes.length === 0) {
        expect(config.default).toBeNull()
      } else {
        expect(config.default).not.toBeNull()
        expect(config.modes).toContain(config.default!.mode)
      }
    }
  })
})

describe('ADDABLE_COMPONENTS — UI whitelist stays inside the catalog', () => {
  it('every addable component is a real catalog entry', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      for (const component of ADDABLE_COMPONENTS[page]) {
        expect(COMPONENT_CATALOG).toContain(component)
      }
    }
  })

  it('non-editable pages (roi, mfiq) offer nothing to add', () => {
    expect(ADDABLE_COMPONENTS.roi).toEqual([])
    expect(ADDABLE_COMPONENTS.mfiq).toEqual([])
  })
})

// ── Money's chart+donut+table is ONE fixed DimensionedSection outside the
// customizable grid ──────────────

describe('DEFAULT_LAYOUTS.money: KPI tiles only', () => {
  it('is exactly the 4 KPI tiles — no dimensioned() entries left', () => {
    expect(DEFAULT_LAYOUTS.money).toHaveLength(4)
    for (const tile of DEFAULT_LAYOUTS.money) {
      expect(tile.component).toBe('kpi-tile')
    }
  })

  it('the 4 KPIs are exactly cost, revenue, marginPercent, overdueAmount', () => {
    const metrics = DEFAULT_LAYOUTS.money.map((tile) => tile.metric)
    expect(metrics).toEqual([
      'cost',
      'revenue',
      'marginPercent',
      'overdueAmount',
    ])
  })
})

describe('ADDABLE_COMPONENTS.money: chart/donut/table are not individually addable', () => {
  it('drops timeseries-chart, category-donut, and breakdown-table', () => {
    for (const component of [
      'timeseries-chart',
      'category-donut',
      'breakdown-table',
    ]) {
      expect(ADDABLE_COMPONENTS.money).not.toContain(component)
    }
  })

  it('still offers kpi-tile and alert-list', () => {
    expect([...ADDABLE_COMPONENTS.money].sort()).toEqual(
      ['kpi-tile', 'alert-list'].sort()
    )
  })
})

// ── FinOps default layout + gating ────

describe('DEFAULT_LAYOUTS.finops — the inventory, order pinned', () => {
  it('parses as a whole under the REAL TilesInputSchema (the exact array schema saveDashboardLayout enforces)', () => {
    const result = TilesInputSchema.safeParse(DEFAULT_LAYOUTS.finops)
    expect(result.success ? null : result.error.issues[0].message).toBeNull()
  })

  // KPIs lead, so the FinOps landing can't
  // open on checklist + alerts with the close KPIs below the fold.
  it('is exactly the 4 close KPIs, then checklist, then alert-list — in that order', () => {
    expect(
      DEFAULT_LAYOUTS.finops.map((tile) => [tile.component, tile.metric])
    ).toEqual([
      ['kpi-tile', 'closeProgress'],
      ['kpi-tile', 'unmappedCount'],
      ['kpi-tile', 'categorizedPct'],
      ['kpi-tile', 'daysToClose'],
      ['checklist', undefined],
      ['alert-list', undefined],
    ])
  })

  it('contains NO timeseries-chart', () => {
    expect(
      DEFAULT_LAYOUTS.finops.some(
        (tile) => tile.component === 'timeseries-chart'
      )
    ).toBe(false)
  })

  it('contains NO donut/table rows', () => {
    for (const component of ['category-donut', 'breakdown-table']) {
      expect(
        DEFAULT_LAYOUTS.finops.some((tile) => tile.component === component)
      ).toBe(false)
    }
  })

  it('every default finops kpi metric is a CLOSE_TILE_METRICS key', () => {
    for (const tile of DEFAULT_LAYOUTS.finops) {
      if (tile.component === 'kpi-tile') {
        expect(Object.keys(CLOSE_TILE_METRICS)).toContain(tile.metric)
      }
    }
  })
})

describe('ADDABLE_COMPONENTS.finops — chart addable-only, alert tile recoverable', () => {
  // Two independent assertions on purpose: "no chart by default" and
  // "chart addable" are separate contracts that must fail separately.
  it('CONTAINS timeseries-chart (the chart is one add-panel click away)', () => {
    expect(ADDABLE_COMPONENTS.finops).toContain('timeseries-chart')
  })

  it('CONTAINS alert-list (a removed alert tile must be recoverable)', () => {
    expect(ADDABLE_COMPONENTS.finops).toContain('alert-list')
  })

  it('drops category-donut and breakdown-table', () => {
    for (const component of ['category-donut', 'breakdown-table']) {
      expect(ADDABLE_COMPONENTS.finops).not.toContain(component)
    }
  })
})

// ── Build default layout + gating ────

describe('DEFAULT_LAYOUTS.build — the inventory, order pinned', () => {
  it('parses as a whole under the REAL TilesInputSchema (the exact array schema saveDashboardLayout enforces)', () => {
    const result = TilesInputSchema.safeParse(DEFAULT_LAYOUTS.build)
    expect(result.success ? null : result.error.issues[0].message).toBeNull()
  })

  it('is exactly costPerTask, eventCount, earned KPIs, then alert-list — in that order', () => {
    expect(
      DEFAULT_LAYOUTS.build.map((tile) => [tile.component, tile.metric])
    ).toEqual([
      ['kpi-tile', 'costPerTask'],
      ['kpi-tile', 'eventCount'],
      ['kpi-tile', 'earned'],
      ['alert-list', undefined],
    ])
  })

  it('contains NO dimensioned component', () => {
    for (const component of [
      'timeseries-chart',
      'category-donut',
      'breakdown-table',
    ]) {
      expect(
        DEFAULT_LAYOUTS.build.some((tile) => tile.component === component)
      ).toBe(false)
    }
  })
})

describe('ADDABLE_COMPONENTS.build — donut/table become fixed section chrome', () => {
  // Independent assertions on purpose: "chart addable" and
  // "donut/table dropped" are separate contracts that must fail separately.
  it('CONTAINS timeseries-chart (renders from the bridged series, FinOps pattern)', () => {
    expect(ADDABLE_COMPONENTS.build).toContain('timeseries-chart')
  })

  it('drops category-donut and breakdown-table (no data path as grid tiles)', () => {
    for (const component of ['category-donut', 'breakdown-table']) {
      expect(ADDABLE_COMPONENTS.build).not.toContain(component)
    }
  })

  it('offers exactly kpi-tile, timeseries-chart, alert-list', () => {
    expect([...ADDABLE_COMPONENTS.build].sort()).toEqual(
      ['kpi-tile', 'timeseries-chart', 'alert-list'].sort()
    )
  })
})

describe('PAGE_DATE_RANGE.build', () => {
  it('offers month/rolling/custom with a rolling default', () => {
    expect(PAGE_DATE_RANGE.build.modes).toEqual(['month', 'rolling', 'custom'])
    expect(PAGE_DATE_RANGE.build.default).toEqual({ mode: 'rolling' })
  })
})

// ── MF IQ is a bespoke page, no TileGrid ─

describe('DEFAULT_LAYOUTS.mfiq: empty (bespoke page)', () => {
  it('is exactly [] — the roi posture; a tile row would imply a TileGrid this page rejects', () => {
    expect(DEFAULT_LAYOUTS.mfiq).toEqual([])
  })
})

describe('PAGE_DATE_RANGE.mfiq', () => {
  it('offers no modes with a null default (the page has no date selector)', () => {
    expect(PAGE_DATE_RANGE.mfiq).toEqual({ modes: [], default: null })
  })
})

/**
 * Which params are true for one window only. ROI carries the
 * customer's own count of finished work beside the dates; every other page
 * carries nothing that a date change would falsify.
 */
describe('PAGE_DATE_RANGE — window-scoped params', () => {
  it('ROI declares the one param the customer typed for these dates', () => {
    expect(PAGE_DATE_RANGE.roi.windowScopedParams).toEqual(['units'])
  })

  // The period total is not on the link: the monthly figure behind it is
  // saved on the org, so nothing window-scoped is left but the count of
  // finished work.
  it('the link carries no period total', () => {
    expect(PAGE_DATE_RANGE.roi.windowScopedParams).not.toContain('beforeTotal')
  })

  it('no other page declares any, so the selector still copies their URLs whole', () => {
    for (const page of DASHBOARD_PAGE_IDS) {
      if (page === 'roi') continue
      expect(PAGE_DATE_RANGE[page].windowScopedParams).toBeUndefined()
    }
  })

  // The Earned / Total revenue pick is a reading preference, not
  // a fact about one window, so it survives a date change the way `tab` does.
  it('the revenue column pick is deliberately NOT window-scoped', () => {
    expect(PAGE_DATE_RANGE.roi.windowScopedParams).not.toContain('revenue')
  })

  it('the agent selection is deliberately NOT window-scoped (the checkboxes show it, and toggling self-heals a stale key)', () => {
    expect(PAGE_DATE_RANGE.roi.windowScopedParams).not.toContain('agents')
  })
})
