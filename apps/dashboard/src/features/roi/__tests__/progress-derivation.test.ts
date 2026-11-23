/**
 * The pure ROI derivation: targetProgress
 * (the core math, exact values), deriveInitiativeHealth (the pace
 * rule), META totality, and the copy builders. Node-only, no DB, no
 * mocks — pure functions in, exact values out.
 */

import { formatCost, formatPct } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  ROI_PACE_GRACE_PTS,
  INITIATIVE_METRIC_META,
  targetProgress,
  deriveInitiativeHealth,
  formatMetricValue,
  goalSentence,
  goalProgressSentence,
  baselineLabel,
  formatGoalWindow,
} from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

/**
 * Every value here is a LEVEL metric: a number that exists whole at any
 * instant, whose progress is the distance travelled from where it started.
 * The cumulative metrics (revenue, spend, usage events) read against their
 * target instead and live in goal-pace.test.ts.
 */
describe('targetProgress — exact values', () => {
  it('cost-per-usage-event card: lte with baseline — $1.18 of $2.10 closed ⇒ 56.19…%', () => {
    // baseline B = 10.00, target B − 2.10, actual B − 1.18.
    const { progressPct, met } = targetProgress(
      { metric: 'costPerTask', direction: 'lte', targetValue: 7.9 },
      8.82,
      10
    )
    expect(met).toBe(false)
    expect(progressPct).toBeCloseTo((1.18 / 2.1) * 100, 6)
    expect(progressPct).toBeCloseTo(56.190476, 4)
  })

  it('margin card: gte 70, actual 65, no baseline ⇒ 92.857…%', () => {
    const { progressPct, met } = targetProgress(
      { metric: 'marginPercent', direction: 'gte', targetValue: 70 },
      65,
      null
    )
    expect(met).toBe(false)
    expect(progressPct).toBeCloseTo((65 / 70) * 100, 6)
    expect(progressPct).toBeCloseTo(92.857142, 4)
  })

  it('unmapped card: lte 0, actual 14, baseline 56 ⇒ exactly 75', () => {
    const { progressPct, met } = targetProgress(
      { metric: 'unmappedCount', direction: 'lte', targetValue: 0 },
      14,
      56
    )
    expect(met).toBe(false)
    expect(progressPct).toBe(75)
  })
})

describe('targetProgress — M2 null edges and clamps', () => {
  it('lte-to-zero WITHOUT a baseline ⇒ null, never an invented bar (the honesty pin)', () => {
    const { progressPct, met } = targetProgress(
      { metric: 'unmappedCount', direction: 'lte', targetValue: 0 },
      14,
      null
    )
    expect(progressPct).toBeNull()
    expect(met).toBe(false)
  })

  it('met forces 100 in both directions, including overshoot', () => {
    expect(
      targetProgress(
        { metric: 'marginPercent', direction: 'gte', targetValue: 70 },
        80,
        null
      )
    ).toEqual({ progressPct: 100, met: true })
    expect(
      targetProgress(
        { metric: 'unmappedCount', direction: 'lte', targetValue: 2100 },
        1000,
        null
      )
    ).toEqual({ progressPct: 100, met: true })
    expect(
      targetProgress(
        { metric: 'marginPercent', direction: 'gte', targetValue: 70 },
        70,
        null
      )
    ).toEqual({ progressPct: 100, met: true })
  })

  it('clamps at 0 when a metric regressed below its baseline (gte)', () => {
    const { progressPct, met } = targetProgress(
      { metric: 'marginPercent', direction: 'gte', targetValue: 100 },
      40,
      50
    )
    expect(progressPct).toBe(0)
    expect(met).toBe(false)
  })

  it('null actual ⇒ both null', () => {
    expect(
      targetProgress(
        { metric: 'costPerTask', direction: 'lte', targetValue: 100 },
        null,
        500
      )
    ).toEqual({ progressPct: null, met: null })
  })

  it('negative margin targets: met collapses to 100, unmet-without-baseline to null (sign guard)', () => {
    expect(
      targetProgress(
        { metric: 'marginPercent', direction: 'gte', targetValue: -10 },
        -5,
        null
      )
    ).toEqual({ progressPct: 100, met: true })
    const regressed = targetProgress(
      { metric: 'marginPercent', direction: 'gte', targetValue: -10 },
      -20,
      null
    )
    expect(regressed.progressPct).toBeNull()
    expect(regressed.met).toBe(false)
  })

  it('baseline === target ⇒ null progress (no division by zero)', () => {
    const { progressPct, met } = targetProgress(
      { metric: 'costPerTask', direction: 'lte', targetValue: 50 },
      60,
      50
    )
    expect(progressPct).toBeNull()
    expect(met).toBe(false)
  })

  it('no-baseline lte above a positive cap is a proximity gauge (target / actual)', () => {
    const { progressPct } = targetProgress(
      { metric: 'costPerTask', direction: 'lte', targetValue: 100 },
      200,
      null
    )
    expect(progressPct).toBe(50)
  })
})

describe('deriveInitiativeHealth — the pace rule', () => {
  const active = {
    status: 'active' as const,
    startDate: '2026-04-01T00:00:00.000Z',
    endDate: '2026-04-21T00:00:00.000Z',
  }
  // Halfway through the 20-day window ⇒ expectedPct = 50.
  const halfway = new Date('2026-04-11T00:00:00.000Z')
  // A level metric with a plain gte target, so the pace rule reads the
  // progress percentage straight. The cumulative-cap pace, which compares the
  // running total against a pro-rated target instead, lives in goal-pace.
  const target = (progressPct: number | null, met: boolean | null = false) => ({
    metric: 'marginPercent' as const,
    direction: 'gte' as const,
    targetValue: 70,
    actual: progressPct === null ? null : 65,
    // Below the target and below this start, so the pace rule reads the
    // percentage rather than the moved-the-wrong-way shortcut.
    baseline: 60,
    progressPct,
    met,
  })

  it('archived beats everything — even an all-met target set', () => {
    expect(
      deriveInitiativeHealth(
        { ...active, status: 'archived' },
        [target(100, true)],
        halfway
      )
    ).toBe('archived')
  })

  it('future start ⇒ not-started even with targets present', () => {
    expect(
      deriveInitiativeHealth(
        { ...active, startDate: '2026-05-01T00:00:00.000Z' },
        [target(40)],
        new Date('2026-04-11T00:00:00.000Z')
      )
    ).toBe('not-started')
  })

  it('empty targets ⇒ no-data', () => {
    expect(deriveInitiativeHealth(active, [], halfway)).toBe('no-data')
  })

  it('every target met ⇒ achieved', () => {
    expect(
      deriveInitiativeHealth(
        active,
        [target(100, true), target(100, true)],
        halfway
      )
    ).toBe('achieved')
  })

  it('all-null progress ⇒ no-data', () => {
    expect(deriveInitiativeHealth(active, [target(null, null)], halfway)).toBe(
      'no-data'
    )
  })

  it('pace boundary at 50% elapsed: 41 ⇒ on-track, 39 ⇒ at-risk (pins the 10-pt grace)', () => {
    expect(ROI_PACE_GRACE_PTS).toBe(10)
    expect(deriveInitiativeHealth(active, [target(41)], halfway)).toBe(
      'on-track'
    )
    expect(deriveInitiativeHealth(active, [target(39)], halfway)).toBe(
      'at-risk'
    )
    // Strict <: exactly expected − grace is still on-track.
    expect(deriveInitiativeHealth(active, [target(40)], halfway)).toBe(
      'on-track'
    )
  })

  it('the SLOWEST measurable target sets the pace (min, not mean)', () => {
    expect(
      deriveInitiativeHealth(active, [target(95), target(10)], halfway)
    ).toBe('at-risk')
  })

  it('no endDate ⇒ on-track with any non-null progress', () => {
    expect(
      deriveInitiativeHealth({ ...active, endDate: null }, [target(1)], halfway)
    ).toBe('on-track')
  })
})

describe('INITIATIVE_METRIC_META — totality + copy', () => {
  // The full InitiativeMetric union, hardcoded so an `as`-cast escape in the
  // map can't hide behind the compile-time Record check.
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

  it('has exactly one entry per union member, every label non-empty', () => {
    expect(Object.keys(INITIATIVE_METRIC_META).sort()).toEqual(
      [...ALL_METRICS].sort()
    )
    for (const metric of ALL_METRICS) {
      expect(INITIATIVE_METRIC_META[metric].label.length).toBeGreaterThan(0)
      expect(['cost', 'pct', 'count']).toContain(
        INITIATIVE_METRIC_META[metric].format
      )
    }
  })

  it('the extra metrics carry the right label + format + kind', () => {
    expect(INITIATIVE_METRIC_META.mrr).toEqual({
      label: 'MRR',
      format: 'cost',
      kind: 'level',
    })
    expect(INITIATIVE_METRIC_META.arr).toEqual({
      label: 'ARR',
      format: 'cost',
      kind: 'level',
    })
    expect(INITIATIVE_METRIC_META.newCustomers).toEqual({
      label: 'New customers',
      format: 'count',
      kind: 'cumulative',
    })
    expect(INITIATIVE_METRIC_META.internalCost).toEqual({
      label: 'Internal cost',
      format: 'cost',
      kind: 'cumulative',
    })
    expect(INITIATIVE_METRIC_META.externalCost).toEqual({
      label: 'External cost',
      format: 'cost',
      kind: 'cumulative',
    })
  })

  it('leaves "new seats" out — no seat-delta history to compute it honestly', () => {
    expect(INITIATIVE_METRIC_META).not.toHaveProperty('newSeats')
    expect(INITIATIVE_METRIC_META).not.toHaveProperty('seats')
  })

  it('money strings come from canon-format exactly — never a local toFixed', () => {
    expect(formatMetricValue('cost', 1234.5)).toBe(formatCost(1234.5))
    expect(formatMetricValue('marginPercent', 70)).toBe(formatPct(70))
    expect(formatMetricValue('eventCount', 12345)).toBe(
      (12345).toLocaleString()
    )
    expect(formatMetricValue('cost', null)).toBe('—')
  })

  it('goal sentences per direction', () => {
    expect(
      goalSentence({ metric: 'cost', direction: 'lte', targetValue: 2100 })
    ).toBe(`Keep Cost at or under ${formatCost(2100)}`)
    expect(
      goalSentence({
        metric: 'marginPercent',
        direction: 'gte',
        targetValue: 70,
      })
    ).toBe(`Reach Margin % of at least ${formatPct(70)}`)
    expect(
      goalSentence({
        metric: 'unmappedCount',
        direction: 'lte',
        targetValue: 0,
      })
    ).toBe('Keep Unmapped GL items at or under 0')
  })

  // The "actual" line is one sentence that says where a goal stands
  // AND which side of the clock it is on, rather than a raw number next to a
  // raw target that leaves the reader to judge both.
  it('the goal sentence: every branch', () => {
    // Margin card — a level metric that has climbed from its starting value.
    expect(
      goalProgressSentence(
        {
          metric: 'marginPercent',
          direction: 'gte',
          targetValue: 70,
          actual: 65,
          baseline: null,
          progressPct: 92.857142,
          met: false,
        },
        null
      )
    ).toBe(`${formatPct(65)} now, 93% of the way to ${formatPct(70)}.`)
    // A count burned down from its starting value.
    expect(
      goalProgressSentence(
        {
          metric: 'unmappedCount',
          direction: 'lte',
          targetValue: 0,
          actual: 14,
          baseline: 56,
          progressPct: 75,
          met: false,
        },
        null
      )
    ).toBe('14 now, down from 56 at the start, 75% of the way to 0.')
    // A running total, which reads against its target rather than its start.
    expect(
      goalProgressSentence(
        {
          metric: 'cost',
          direction: 'lte',
          targetValue: 4,
          actual: 3.75,
          baseline: null,
          progressPct: 93.75,
          met: false,
        },
        null
      )
    ).toBe(`${formatCost(3.75)} so far, 94% of the limit.`)
    // Null actual ⇒ the M2 path, in words rather than a bare dash.
    expect(
      goalProgressSentence(
        {
          metric: 'cost',
          direction: 'lte',
          targetValue: 2,
          actual: null,
          baseline: null,
          progressPct: null,
          met: null,
        },
        null
      )
    ).toBe('No number for this window.')
  })
})

/**
 * Two labels that made a claim the number does not support.
 *
 * "Net margin" reads as margin after everything. The number is
 * subscription-scoped revenue minus subscription-scoped cost, and it
 * deliberately excludes the usage cost with no subscription that the Cost
 * tile counts. "Net" is also the word most likely to end up on a slide.
 *
 * One stored field gets one name: the dialog, the detail page and the card
 * all call it "Starting value" (or "Last window" on a running total).
 */
describe('labels claim only what the number supports', () => {
  it('the margin percentage is a percentage, not a net-of-everything claim', () => {
    expect(INITIATIVE_METRIC_META.marginPercent.label).toBe('Margin %')
    expect(INITIATIVE_METRIC_META.marginPercent.label).not.toMatch(/\bnet\b/i)
  })

  it('the goal page names the stored field the same way the dialog does', () => {
    expect(baselineLabel('unmappedCount', '2026-11-30')).toBe('Starting value')
  })

  // On a running total that field holds the PREVIOUS window's number, and
  // "Starting value" invited the reading that this window begins there.
  it('and calls it what it is on a running total', () => {
    expect(baselineLabel('revenue', '2026-11-30')).toBe('Last window')
  })
})

/**
 * One goal-window formatter, shared. The print and the goal card
 * both show this line, and two copies
 * of it would be two dates lines that could disagree about the same goal.
 */
describe('formatGoalWindow — the dates a goal measures', () => {
  it('renders a closed window as start to end, through canon-date', () => {
    expect(formatGoalWindow('2026-08-19', '2026-09-18')).toBe(
      `${formatDisplayDate('2026-08-19')} to ${formatDisplayDate('2026-09-18')}`
    )
  })

  it('says a goal with no end date is still running, rather than inventing one', () => {
    expect(formatGoalWindow('2026-08-19', null)).toBe(
      `Started ${formatDisplayDate('2026-08-19')}, ongoing`
    )
  })

  // The card and the print render this line, in a codebase whose copy rule
  // bans dash punctuation everywhere else.
  it('punctuates the line in words, not in dashes and dots', () => {
    for (const line of [
      formatGoalWindow('2026-08-19', '2026-09-18'),
      formatGoalWindow('2026-08-19', null),
    ]) {
      expect(line).not.toMatch(/[—–·]/)
    }
  })
})
