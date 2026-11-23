/**
 * Pure date-range mapping. Pins the three
 * mode contracts (month = monthPeriod bounds as-is, rolling = {} =
 * parseWindowFilter's 30d default, custom = bare dates) and the URL-param
 * round-trip identity that makes views shareable.
 *
 * selectionToUrlParams coverage: rolling's period is
 * {}, but the URL round trip needs its
 * own explicit ?range=rolling marker or it collides with any page whose
 * default isn't rolling (Money's is month) — see date-range.ts's header.
 */

import { monthPeriod } from '@/features/_shared/billing-period'
import { formatWindowLabel } from '@/app/actions/_shared/parse-window-filter'
import {
  nextUrlParams,
  selectionFromParams,
  selectionLabel,
  selectionToPeriod,
  selectionToUrlParams,
} from '../date-range'
import { PAGE_DATE_RANGE } from '../default-layouts'
import type { DateRangeConfig, DateRangeSelection } from '../types'

const ALL_MODES: DateRangeConfig = {
  modes: ['month', 'rolling', 'custom'],
  default: { mode: 'rolling' },
}

describe('selectionToPeriod — the three mode contracts', () => {
  it('month passes monthPeriod(n) bounds through UNCHANGED (no re-derivation)', () => {
    for (const monthsAgo of [0, 1, 5, 11]) {
      const { startDate, endDate } = monthPeriod(monthsAgo)
      expect(selectionToPeriod({ mode: 'month', monthsAgo })).toEqual({
        startDate,
        endDate,
      })
    }
  })

  it('rolling emits {} — parseWindowFilter supplies the 30-days-back default', () => {
    expect(selectionToPeriod({ mode: 'rolling' })).toEqual({})
  })

  it('custom passes bare YYYY-MM-DD dates through verbatim', () => {
    expect(
      selectionToPeriod({
        mode: 'custom',
        startDate: '2026-06-03',
        endDate: '2026-06-17',
      })
    ).toEqual({ startDate: '2026-06-03', endDate: '2026-06-17' })
  })
})

describe('URL-param round-trip (params → selection → params) is identity', () => {
  const cases: DateRangeSelection[] = [
    { mode: 'month', monthsAgo: 0 },
    { mode: 'month', monthsAgo: 3 },
    { mode: 'rolling' },
    { mode: 'custom', startDate: '2026-06-03', endDate: '2026-06-17' },
  ]

  it.each(cases)('%o survives the round trip', (selection) => {
    const params = selectionToPeriod(selection)
    const parsed = selectionFromParams(params, ALL_MODES)
    expect(parsed).toEqual(selection)
    expect(selectionToPeriod(parsed!)).toEqual(params)
  })

  it('a clean calendar month reads back as month mode, not custom', () => {
    const { startDate, endDate } = monthPeriod(2)
    expect(selectionFromParams({ startDate, endDate }, ALL_MODES)).toEqual({
      mode: 'month',
      monthsAgo: 2,
    })
  })
})

describe('selectionToUrlParams — the URL round-trip shape (adds the rolling marker)', () => {
  it('rolling gets an explicit range=rolling marker', () => {
    expect(selectionToUrlParams({ mode: 'rolling' })).toEqual({
      range: 'rolling',
    })
  })

  it('month and custom carry no marker — identical to selectionToPeriod', () => {
    expect(selectionToUrlParams({ mode: 'month', monthsAgo: 2 })).toEqual(
      selectionToPeriod({ mode: 'month', monthsAgo: 2 })
    )
    const custom = {
      mode: 'custom' as const,
      startDate: '2026-06-03',
      endDate: '2026-06-17',
    }
    expect(selectionToUrlParams(custom)).toEqual(selectionToPeriod(custom))
  })
})

describe('"Last 30 days" round-trips on a page whose default is NOT rolling', () => {
  it('rolling survives selectionToUrlParams -> selectionFromParams on Money (default: month)', () => {
    const urlParams = selectionToUrlParams({ mode: 'rolling' })
    expect(selectionFromParams(urlParams, PAGE_DATE_RANGE.money)).toEqual({
      mode: 'rolling',
    })
  })

  it('a stray range=rolling on a page that forbids rolling (FinOps) falls back to the default, not smuggled in', () => {
    expect(
      selectionFromParams({ range: 'rolling' }, PAGE_DATE_RANGE.finops)
    ).toEqual(PAGE_DATE_RANGE.finops.default)
  })
})

describe('config gating — forbidden modes fall back to the page default', () => {
  it('FinOps is month-locked: custom params fall back to the month default', () => {
    const finops = PAGE_DATE_RANGE.finops
    expect(finops.modes).toEqual(['month'])
    expect(
      selectionFromParams(
        { startDate: '2026-06-03', endDate: '2026-06-17' },
        finops
      )
    ).toEqual(finops.default)
  })

  it('no params ⇒ the page default', () => {
    expect(selectionFromParams({}, PAGE_DATE_RANGE.money)).toEqual(
      PAGE_DATE_RANGE.money.default
    )
    expect(selectionFromParams({}, PAGE_DATE_RANGE.build)).toEqual({
      mode: 'rolling',
    })
  })

  // This is the exact call finops/index.tsx
  // makes with no ?startDate/?endDate in the URL — pin it to the last
  // COMPLETE month, not the in-progress one.
  it('FinOps with no params resolves to last month, not the current one', () => {
    expect(selectionFromParams({}, PAGE_DATE_RANGE.finops)).toEqual({
      mode: 'month',
      monthsAgo: 1,
    })
  })

  it('empty modes (MF IQ) ⇒ null — the page owns its window', () => {
    expect(selectionFromParams({}, PAGE_DATE_RANGE.mfiq)).toBeNull()
    expect(
      selectionFromParams(
        { startDate: '2026-06-01', endDate: '2026-06-30' },
        PAGE_DATE_RANGE.mfiq
      )
    ).toBeNull()
  })

  it('ROI reads a real window for the report above the goals', () => {
    expect(selectionFromParams({}, PAGE_DATE_RANGE.roi)).toEqual({
      mode: 'rolling',
    })
    // A range that is not a whole calendar month reads back as custom, which
    // month-locked pages refuse. Time-stable on purpose: no "months ago" math.
    expect(
      selectionFromParams(
        { startDate: '2026-06-03', endDate: '2026-06-17' },
        PAGE_DATE_RANGE.roi
      )
    ).toEqual({
      mode: 'custom',
      startDate: '2026-06-03',
      endDate: '2026-06-17',
    })
  })

  it('half a custom range (one date) is not a selectable window ⇒ default', () => {
    expect(selectionFromParams({ startDate: '2026-06-03' }, ALL_MODES)).toEqual(
      ALL_MODES.default
    )
  })
})

describe('labels', () => {
  it("rolling label matches formatWindowLabel's no-dates default exactly", () => {
    expect(selectionLabel({ mode: 'rolling' })).toBe(
      formatWindowLabel({}, new Date(), new Date())
    )
  })

  it('month label is the monthPeriod label', () => {
    expect(selectionLabel({ mode: 'month', monthsAgo: 1 })).toBe(
      monthPeriod(1).monthLabel
    )
  })

  it('custom label shows the explicit range', () => {
    expect(
      selectionLabel({
        mode: 'custom',
        startDate: '2026-06-03',
        endDate: '2026-06-17',
      })
    ).toBe('2026-06-03 → 2026-06-17')
  })
})

/**
 * A param that is true for ONE window only must not ride
 * along when the window changes. The ROI page carries the customer's own
 * count of finished work in the URL (units). If the selector copied the
 * whole query string on commit, a count typed for Aug 19 - Sep 18 would be
 * restated as fact for August. Config-driven, not ROI-aware: the shell
 * knows nothing about ROI.
 */
describe('nextUrlParams — window-scoped params never survive a date change', () => {
  const carrying = () =>
    new URLSearchParams(
      'startDate=2026-08-19&endDate=2026-09-18&units=57&agents=a1'
    )

  it('a month commit on ROI drops the count and keeps agents', () => {
    const next = nextUrlParams(
      carrying(),
      { mode: 'month', monthsAgo: 1 },
      PAGE_DATE_RANGE.roi
    )
    expect(next.get('units')).toBeNull()
    expect(next.get('agents')).toBe('a1')
  })

  it('still writes exactly the dates selectionToUrlParams would', () => {
    const selection: DateRangeSelection = { mode: 'month', monthsAgo: 1 }
    const next = nextUrlParams(carrying(), selection, PAGE_DATE_RANGE.roi)
    const { startDate, endDate } = selectionToUrlParams(selection)
    expect(next.get('startDate')).toBe(startDate)
    expect(next.get('endDate')).toBe(endDate)
    expect(next.get('range')).toBeNull()
  })

  it('drops them on rolling and custom too, not only month', () => {
    const rolling = nextUrlParams(
      carrying(),
      { mode: 'rolling' },
      PAGE_DATE_RANGE.roi
    )
    expect(rolling.get('units')).toBeNull()
    expect(rolling.get('range')).toBe('rolling')
    expect(rolling.get('startDate')).toBeNull()

    const custom = nextUrlParams(
      carrying(),
      { mode: 'custom', startDate: '2026-07-01', endDate: '2026-07-31' },
      PAGE_DATE_RANGE.roi
    )
    expect(custom.get('units')).toBeNull()
    expect(custom.get('startDate')).toBe('2026-07-01')
  })

  it('a page that declares none keeps every param it was carrying', () => {
    const next = nextUrlParams(
      carrying(),
      { mode: 'month', monthsAgo: 1 },
      PAGE_DATE_RANGE.build
    )
    expect(next.get('units')).toBe('57')
    expect(next.get('agents')).toBe('a1')
  })

  it('leaves the URLSearchParams it was handed untouched (pure)', () => {
    const current = carrying()
    nextUrlParams(current, { mode: 'rolling' }, PAGE_DATE_RANGE.roi)
    expect(current.get('units')).toBe('57')
    expect(current.get('startDate')).toBe('2026-08-19')
  })
})
