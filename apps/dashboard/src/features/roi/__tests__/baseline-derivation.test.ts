/**
 * The pure auto-baseline rules: the mirrored pre-start window, the
 * supported-metric map, the per-metric value mapping with its honest-null
 * edges, and the dialog's submission rule. Node-only, no DB, no mocks: pure
 * functions in, exact values out (the progress-derivation.test.ts idiom).
 */

import {
  AUTO_BASELINE_SUPPORTED,
  BASELINE_FALLBACK_LOOKBACK_DAYS,
  baselineWindowFor,
  resolveBaselineSubmission,
} from '../baseline-derivation'
import {
  actualForMetric,
  autoBaselineFromReads,
  NO_READS,
  type WindowReads,
} from '../../../../app/actions/_shared/initiative-metric-values'
import { targetProgress } from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const READS_WITH_DATA: WindowReads = {
  breakdownTotals: { cost: 500, eventCount: 200 },
  revenue: { revenue: 900, margin: 400, marginPercent: 44.4 },
  unmappedSignalCount: 7,
  mrr: { mrr: 1200, arr: 14400 },
  newCustomers: 3,
  partitionedCost: { internal: 120, external: 380, eventCount: 200 },
}

describe('baselineWindowFor — the mirrored pre-start window', () => {
  it('a bounded initiative mirrors its own length, ending the day before the start', () => {
    // A 31-day window (Jan 1 – Jan 31) mirrors to Dec 1 – Dec 31.
    expect(baselineWindowFor('2026-01-01', '2026-01-31')).toEqual({
      startDate: '2025-12-01',
      endDate: '2025-12-31',
    })
  })

  it('an open-ended initiative falls back to the 30-day default lookback', () => {
    expect(BASELINE_FALLBACK_LOOKBACK_DAYS).toBe(30)
    expect(baselineWindowFor('2026-07-01', null)).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })
  })

  it('a same-day window (endDate === startDate is legal) mirrors a single day', () => {
    expect(baselineWindowFor('2026-03-10', '2026-03-10')).toEqual({
      startDate: '2026-03-09',
      endDate: '2026-03-09',
    })
  })

  it('accepts full-ISO stored timestamps and still emits bare dates (a stored midnight timestamp)', () => {
    expect(
      baselineWindowFor('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z')
    ).toEqual({ startDate: '2025-12-01', endDate: '2025-12-31' })
  })
})

describe('AUTO_BASELINE_SUPPORTED — total, and honest about mrr/arr', () => {
  it('covers every InitiativeMetric', () => {
    const ALL_METRICS: InitiativeMetric[] = [
      'cost',
      'revenue',
      'margin',
      'marginPercent',
      'costPerTask',
      'eventCount',
      'unmappedCount',
      'mrr',
      'arr',
      'newCustomers',
      'internalCost',
      'externalCost',
    ]
    for (const metric of ALL_METRICS) {
      expect(typeof AUTO_BASELINE_SUPPORTED[metric]).toBe('boolean')
    }
  })

  it('mrr/arr are the ONLY unsupported metrics (getMrr has no historical mode, canon MRR1)', () => {
    const unsupported = Object.entries(AUTO_BASELINE_SUPPORTED)
      .filter(([, supported]) => !supported)
      .map(([metric]) => metric)
      .sort()
    expect(unsupported).toEqual(['arr', 'mrr'])
  })
})

describe('autoBaselineFromReads — the same mapping the actuals use', () => {
  it('a window with activity measures cost/revenue/count exactly as actualForMetric does', () => {
    for (const metric of [
      'cost',
      'revenue',
      'margin',
      'marginPercent',
      'costPerTask',
      'eventCount',
      'newCustomers',
      'unmappedCount',
      'internalCost',
      'externalCost',
    ] as InitiativeMetric[]) {
      expect(autoBaselineFromReads(metric, READS_WITH_DATA)).toBe(
        actualForMetric(metric, READS_WITH_DATA)
      )
    }
  })

  it('mrr/arr never auto-derive, even when a snapshot is present in the reads', () => {
    expect(autoBaselineFromReads('mrr', READS_WITH_DATA)).toBeNull()
    expect(autoBaselineFromReads('arr', READS_WITH_DATA)).toBeNull()
  })

  it('a zero-activity window yields null for usage metrics, never a fabricated $0 starting point', () => {
    const emptyWindow: WindowReads = {
      ...NO_READS,
      breakdownTotals: { cost: 0, eventCount: 0 },
      revenue: { revenue: 0, margin: 0, marginPercent: null },
      partitionedCost: { internal: 0, external: 0, eventCount: 0 },
    }
    for (const metric of [
      'cost',
      'eventCount',
      'costPerTask',
      'revenue',
      'margin',
      'marginPercent',
      'internalCost',
      'externalCost',
    ] as InitiativeMetric[]) {
      expect(autoBaselineFromReads(metric, emptyWindow)).toBeNull()
    }
  })

  it('entity counts keep a real zero — 0 unmapped items and 0 new customers are measurements, not gaps', () => {
    const reads: WindowReads = {
      ...NO_READS,
      unmappedSignalCount: 0,
      newCustomers: 0,
    }
    expect(autoBaselineFromReads('unmappedCount', reads)).toBe(0)
    expect(autoBaselineFromReads('newCustomers', reads)).toBe(0)
  })

  it('a window with revenue but negative margin still measures (loss-leader phases are real)', () => {
    const reads: WindowReads = {
      ...NO_READS,
      revenue: { revenue: 100, margin: -50, marginPercent: -50 },
    }
    expect(autoBaselineFromReads('margin', reads)).toBe(-50)
  })
})

describe('auto-derived baselines feed the SAME progress math as manual ones', () => {
  // A level metric: the measured starting value IS the zero point of the
  // progress bar. On a cumulative metric it is last window's total and the
  // bar reads against the target instead, which goal-pace.test.ts covers.
  it('lte cost-per-usage-event goal: measured baseline 10, target 7.90, actual 8.82 ⇒ 56.19…%', () => {
    const measured = autoBaselineFromReads('costPerTask', {
      ...NO_READS,
      breakdownTotals: { cost: 10000, eventCount: 1000 },
    })
    expect(measured).toBe(10)
    const { progressPct } = targetProgress(
      { metric: 'costPerTask', direction: 'lte', targetValue: 7.9 },
      8.82,
      measured
    )
    expect(progressPct).toBeCloseTo(56.190476, 4)
  })

  it('lte-to-zero becomes measurable once a baseline is auto-derived', () => {
    const withoutBaseline = targetProgress(
      { metric: 'unmappedCount', direction: 'lte', targetValue: 0 },
      14,
      null
    )
    expect(withoutBaseline.progressPct).toBeNull()

    const measured = autoBaselineFromReads('unmappedCount', {
      ...NO_READS,
      unmappedSignalCount: 56,
    })
    const withBaseline = targetProgress(
      { metric: 'unmappedCount', direction: 'lte', targetValue: 0 },
      14,
      measured
    )
    expect(withBaseline.progressPct).toBe(75)
  })

  it('a genuinely-no-data window keeps the null fallback end to end', () => {
    const measured = autoBaselineFromReads('costPerTask', {
      ...NO_READS,
      breakdownTotals: { cost: 0, eventCount: 0 },
    })
    expect(measured).toBeNull()
    const { progressPct } = targetProgress(
      { metric: 'costPerTask', direction: 'lte', targetValue: 0 },
      14,
      measured
    )
    expect(progressPct).toBeNull()
  })
})

describe('resolveBaselineSubmission — what the dialog sends per row', () => {
  const base = {
    fieldValue: '',
    touched: false,
    storedValue: null,
    storedSource: null,
    startDateChanged: false,
    scopeChanged: false,
    isEdit: false,
  }

  it('create mode, untouched ⇒ measure on save (null + auto)', () => {
    expect(resolveBaselineSubmission({ ...base })).toEqual({
      baselineValue: null,
      baselineSource: 'auto',
    })
  })

  it('a typed value is a manual override', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        fieldValue: '123.45',
        touched: true,
      })
    ).toEqual({ baselineValue: 123.45, baselineSource: 'manual' })
  })

  it('clearing the field asks for a fresh measurement', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        touched: true,
        fieldValue: '',
        storedValue: 500,
        storedSource: 'manual',
      })
    ).toEqual({ baselineValue: null, baselineSource: 'auto' })
  })

  it('an untouched manual baseline is carried forward verbatim — never silently replaced', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '500',
        storedValue: 500,
        storedSource: 'manual',
        startDateChanged: true,
      })
    ).toEqual({ baselineValue: 500, baselineSource: 'manual' })
  })

  it('a baseline with source null is treated as manual', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '75',
        storedValue: 75,
        storedSource: null,
        startDateChanged: true,
      })
    ).toEqual({ baselineValue: 75, baselineSource: 'manual' })
  })

  it('an untouched auto baseline carries forward while the start date holds', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '812.5',
        storedValue: 812.5,
        storedSource: 'auto',
      })
    ).toEqual({ baselineValue: 812.5, baselineSource: 'auto' })
  })

  it('a moved start date re-measures an untouched auto baseline (null + auto)', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '812.5',
        storedValue: 812.5,
        storedSource: 'auto',
        startDateChanged: true,
      })
    ).toEqual({ baselineValue: null, baselineSource: 'auto' })
  })

  it('a changed matter scope re-measures an untouched auto baseline (null + auto)', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '812.5',
        storedValue: 812.5,
        storedSource: 'auto',
        scopeChanged: true,
      })
    ).toEqual({ baselineValue: null, baselineSource: 'auto' })
  })

  it('a changed matter scope never overwrites an untouched MANUAL baseline', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        fieldValue: '500',
        storedValue: 500,
        storedSource: 'manual',
        scopeChanged: true,
      })
    ).toEqual({ baselineValue: 500, baselineSource: 'manual' })
  })

  it('a row with no baseline and no source upgrades to auto measurement on the next save', () => {
    expect(
      resolveBaselineSubmission({
        ...base,
        isEdit: true,
        storedValue: null,
        storedSource: null,
      })
    ).toEqual({ baselineValue: null, baselineSource: 'auto' })
  })
})
