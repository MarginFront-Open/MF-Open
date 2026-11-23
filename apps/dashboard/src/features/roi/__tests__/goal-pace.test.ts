/**
 * WHAT THIS FILE DOES: pins the two kinds of goal metric and the one sentence
 * every goal surface reads from.
 *
 * WHY IT EXISTS: measuring progress as distance travelled from a STARTING
 * value is right for a number that exists at any instant (margin percent,
 * average cost) and wrong for a number that adds up across the window
 * (revenue, spend, usage events). A running total cannot pass a whole
 * previous window's total until the window is nearly over, so a card measured
 * that way reads 0% and at risk for most of the window while the
 * organization is comfortably ahead.
 *
 * CONNECTS TO: progress-derivation.ts (the registry, the progress math, the
 * pace rule and the sentence), the goal card, the goal detail page and the
 * board-ready print, which all render the same sentence.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { formatCost, formatPct } from '@/lib/canon-format'
import {
  INITIATIVE_METRIC_META,
  ROI_PACE_GRACE_PTS,
  baselineLabel,
  deriveInitiativeHealth,
  displayProgressPct,
  goalProgressSentence,
  targetPace,
  targetProgress,
  windowElapsedPct,
} from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const FEATURE_DIR = join(__dirname, '..')

/** A fall window: Sep 1 to Nov 30, read on Sep 24 midday. */
const FALL = { startDate: '2026-09-01', endDate: '2026-11-30' }
const DAY_24 = new Date('2026-09-24T12:00:00.000Z')
/** 23.5 of 90 midnight-to-midnight days. */
const FALL_ELAPSED = windowElapsedPct(FALL.startDate, FALL.endDate, DAY_24)

describe('every goal metric is classified once, in the registry the page already has', () => {
  const CUMULATIVE: InitiativeMetric[] = [
    'cost',
    'revenue',
    'margin',
    'eventCount',
    'newCustomers',
    'internalCost',
    'externalCost',
  ]
  const LEVEL: InitiativeMetric[] = [
    'marginPercent',
    'costPerTask',
    'unmappedCount',
    'mrr',
    'arr',
  ]

  it('sorts the twelve metrics into the two kinds with nothing left over', () => {
    const byKind = (kind: 'cumulative' | 'level') =>
      (Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[])
        .filter((metric) => INITIATIVE_METRIC_META[metric].kind === kind)
        .sort()
    expect(byKind('cumulative')).toEqual([...CUMULATIVE].sort())
    expect(byKind('level')).toEqual([...LEVEL].sort())
  })

  it('names the starting value for what it is on each kind', () => {
    expect(baselineLabel('revenue', FALL.endDate)).toBe('Last window')
    expect(baselineLabel('marginPercent', FALL.endDate)).toBe('Starting value')
  })

  // A goal with no end date mirrors no window: its auto starting value is a
  // flat 30-day lookback, so "Last window" would name dates nobody measured.
  it('calls it a starting value where there is no window to mirror', () => {
    expect(baselineLabel('revenue', null)).toBe('Starting value')
  })
})

describe('windowElapsedPct — the share of a goal a clock has already spent', () => {
  it('measures a running window against its own length', () => {
    expect(FALL_ELAPSED).toBeCloseTo((23.5 / 90) * 100, 6)
  })

  it('has no answer for a goal with no end date', () => {
    expect(windowElapsedPct('2026-09-01', null, DAY_24)).toBeNull()
  })

  it('reads a started same-day window as fully spent', () => {
    expect(windowElapsedPct('2026-09-01', '2026-09-01', DAY_24)).toBe(100)
  })

  it('clamps to the window at both ends', () => {
    expect(
      windowElapsedPct('2026-09-01', '2026-11-30', new Date('2027-01-01'))
    ).toBe(100)
    expect(
      windowElapsedPct('2026-09-01', '2026-11-30', new Date('2026-08-01'))
    ).toBe(0)
  })
})

describe('a cumulative goal is measured against its target, not against last window', () => {
  const revenue = {
    metric: 'revenue' as const,
    direction: 'gte' as const,
    targetValue: 41500,
    baseline: 41048,
  }

  it('a revenue goal card: $17,137.63 of $41,500 reads 41%, not 0%', () => {
    const { progressPct, met } = targetProgress(
      revenue,
      17137.63,
      revenue.baseline,
      FALL_ELAPSED
    )
    expect(met).toBe(false)
    expect(progressPct).toBeCloseTo((17137.63 / 41500) * 100, 6)
    expect(
      displayProgressPct({ ...revenue, actual: 17137.63, progressPct })
    ).toBe(progressPct)
  })

  it('and the card says so in one sentence', () => {
    const { progressPct, met } = targetProgress(
      revenue,
      17137.63,
      revenue.baseline,
      FALL_ELAPSED
    )
    expect(
      goalProgressSentence(
        { ...revenue, actual: 17137.63, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(17137.63)} so far, 41% of target with 26% of the window elapsed. Ahead of pace.`
    )
  })

  it('calls a running total behind when it trails the clock by more than the grace', () => {
    const behind = targetProgress(revenue, 4000, revenue.baseline, FALL_ELAPSED)
    expect(
      targetPace(
        { ...revenue, actual: 4000, progressPct: behind.progressPct },
        FALL_ELAPSED
      )
    ).toBe('behind')
    expect(
      goalProgressSentence(
        {
          ...revenue,
          actual: 4000,
          progressPct: behind.progressPct,
          met: false,
        },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(4000)} so far, 10% of target with 26% of the window elapsed. Behind pace.`
    )
  })

  it('drops the pace clause entirely when a goal has no end date', () => {
    const { progressPct, met } = targetProgress(
      revenue,
      17137.63,
      revenue.baseline,
      null
    )
    expect(
      goalProgressSentence(
        { ...revenue, actual: 17137.63, progressPct, met },
        null
      )
    ).toBe(`${formatCost(17137.63)} so far, 41% of target.`)
  })

  it('a met target reads past the target, with no pace left to keep', () => {
    const { progressPct, met } = targetProgress(
      revenue,
      42000,
      revenue.baseline,
      FALL_ELAPSED
    )
    expect(met).toBe(true)
    expect(progressPct).toBe(100)
    expect(
      goalProgressSentence(
        { ...revenue, actual: 42000, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(`${formatCost(42000)} so far, past the ${formatCost(41500)} target.`)
  })

  it('says nothing was measured rather than inventing a zero', () => {
    const { progressPct, met } = targetProgress(
      revenue,
      null,
      revenue.baseline,
      FALL_ELAPSED
    )
    expect(progressPct).toBeNull()
    expect(met).toBeNull()
    expect(
      goalProgressSentence(
        { ...revenue, actual: null, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe('No number for this window.')
  })
})

describe('a cumulative cap is paced against the target pro-rated to the days gone by', () => {
  const cap = {
    metric: 'cost' as const,
    direction: 'lte' as const,
    targetValue: 13000,
    baseline: 10000,
  }

  it('under the pro-rated allowance reads on pace to stay under', () => {
    const { progressPct, met } = targetProgress(
      cap,
      4000,
      cap.baseline,
      FALL_ELAPSED
    )
    expect(met).toBe(false)
    expect(progressPct).toBeCloseTo((4000 / 13000) * 100, 6)
    expect(
      targetPace({ ...cap, actual: 4000, progressPct }, FALL_ELAPSED)
    ).toBe('ahead')
    expect(
      goalProgressSentence(
        { ...cap, actual: 4000, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(4000)} so far against last window's ${formatCost(10000)}, 31% of the limit with 26% of the window elapsed. On pace to stay under.`
    )
  })

  it('past the pro-rated allowance reads over pace, long before the cap itself', () => {
    const { progressPct, met } = targetProgress(
      cap,
      9000,
      cap.baseline,
      FALL_ELAPSED
    )
    expect(met).toBe(false)
    expect(
      targetPace({ ...cap, actual: 9000, progressPct }, FALL_ELAPSED)
    ).toBe('behind')
    expect(
      goalProgressSentence(
        { ...cap, actual: 9000, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(9000)} so far against last window's ${formatCost(10000)}, 69% of the limit with 26% of the window elapsed. Over pace.`
    )
  })

  it('past the cap itself names the cap rather than a percent over 100', () => {
    const { progressPct, met } = targetProgress(
      cap,
      14000,
      cap.baseline,
      FALL_ELAPSED
    )
    expect(met).toBe(false)
    expect(
      goalProgressSentence(
        { ...cap, actual: 14000, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(14000)} so far against last window's ${formatCost(10000)}, over the ${formatCost(13000)} limit with 26% of the window elapsed. Over pace.`
    )
  })

  it('is not achieved on day one just because the running total starts small', () => {
    const { met } = targetProgress(cap, 120, cap.baseline, 1)
    expect(met).toBe(false)
  })

  it('is achieved once the window closes under the cap', () => {
    const { progressPct, met } = targetProgress(cap, 12000, cap.baseline, 100)
    expect(met).toBe(true)
    expect(progressPct).toBe(100)
    expect(
      goalProgressSentence({ ...cap, actual: 12000, progressPct, met }, 100)
    ).toBe(
      `${formatCost(12000)} so far against last window's ${formatCost(10000)}, under the ${formatCost(13000)} limit.`
    )
  })
})

describe('a level goal below its starting value says which way it moved', () => {
  const margin = {
    metric: 'marginPercent' as const,
    direction: 'gte' as const,
    targetValue: 70,
    baseline: 67,
  }

  it('shows no percent at all rather than a floored 0%', () => {
    const { progressPct } = targetProgress(
      margin,
      65.8,
      margin.baseline,
      FALL_ELAPSED
    )
    expect(progressPct).toBe(0)
    expect(
      displayProgressPct({ ...margin, actual: 65.8, progressPct })
    ).toBeNull()
  })

  it('a margin goal card: 65.8% against a 67% start', () => {
    const { progressPct, met } = targetProgress(
      margin,
      65.8,
      margin.baseline,
      FALL_ELAPSED
    )
    expect(
      goalProgressSentence(
        { ...margin, actual: 65.8, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatPct(65.8)} now, down from ${formatPct(67)} at the start. Behind pace.`
    )
  })

  it('stays at risk, because a goal moving the wrong way is the thing to flag', () => {
    const { progressPct, met } = targetProgress(
      margin,
      65.8,
      margin.baseline,
      FALL_ELAPSED
    )
    expect(
      deriveInitiativeHealth(
        { status: 'active', startDate: FALL.startDate, endDate: FALL.endDate },
        [{ ...margin, actual: 65.8, progressPct, met }],
        DAY_24
      )
    ).toBe('at-risk')
  })

  it('above the start but short of the target keeps the percentage it always had', () => {
    const { progressPct, met } = targetProgress(
      {
        metric: margin.metric,
        direction: margin.direction,
        targetValue: margin.targetValue,
      },
      65,
      60,
      FALL_ELAPSED
    )
    expect(progressPct).toBeCloseTo(50, 6)
    expect(
      goalProgressSentence(
        { ...margin, baseline: 60, actual: 65, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatPct(65)} now, up from ${formatPct(60)} at the start, 50% of the way to ${formatPct(70)}. Ahead of pace.`
    )
  })

  it('a falling cost per usage event moves the right way by going down', () => {
    const cpt = {
      metric: 'costPerTask' as const,
      direction: 'lte' as const,
      targetValue: 2.35,
      baseline: 2.95,
    }
    const { progressPct, met } = targetProgress(
      cpt,
      2.6,
      cpt.baseline,
      FALL_ELAPSED
    )
    expect(progressPct).toBeCloseTo((0.35 / 0.6) * 100, 6)
    expect(
      goalProgressSentence(
        { ...cpt, actual: 2.6, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatCost(2.6)} now, down from ${formatCost(2.95)} at the start, 58% of the way to ${formatCost(2.35)}. Ahead of pace.`
    )
  })

  it('with no starting value it is still the gauge it always was', () => {
    const { progressPct, met } = targetProgress(margin, 65, null, FALL_ELAPSED)
    expect(progressPct).toBeCloseTo((65 / 70) * 100, 6)
    expect(
      goalProgressSentence(
        { ...margin, baseline: null, actual: 65, progressPct, met },
        FALL_ELAPSED
      )
    ).toBe(
      `${formatPct(65)} now, 93% of the way to ${formatPct(70)}. Ahead of pace.`
    )
  })
})

describe('the same-day window edge', () => {
  it('a one-day goal is fully elapsed, so anything short of target is behind', () => {
    const revenue = {
      metric: 'revenue' as const,
      direction: 'gte' as const,
      targetValue: 41500,
      baseline: 41048,
    }
    const elapsed = windowElapsedPct('2026-09-01', '2026-09-01', DAY_24)
    const { progressPct, met } = targetProgress(
      revenue,
      17137.63,
      41048,
      elapsed
    )
    expect(
      goalProgressSentence(
        { ...revenue, actual: 17137.63, progressPct, met },
        elapsed
      )
    ).toBe(
      `${formatCost(17137.63)} so far, 41% of target with 100% of the window elapsed. Behind pace.`
    )
  })
})

describe('health reads the pace of each kind on its own terms', () => {
  const window = {
    status: 'active' as const,
    startDate: FALL.startDate,
    endDate: FALL.endDate,
  }
  const cap = {
    metric: 'cost' as const,
    direction: 'lte' as const,
    targetValue: 13000,
    baseline: 10000,
  }

  it('the grace band is still ten points', () => {
    expect(ROI_PACE_GRACE_PTS).toBe(10)
  })

  it('a cap inside its pro-rated allowance is on track even at 31% of the cap', () => {
    const { progressPct, met } = targetProgress(
      cap,
      4000,
      cap.baseline,
      FALL_ELAPSED
    )
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...cap, actual: 4000, progressPct, met }],
        DAY_24
      )
    ).toBe('on-track')
  })

  it('a cap past its pro-rated allowance is at risk, though the cap itself is intact', () => {
    const { progressPct, met } = targetProgress(
      cap,
      9000,
      cap.baseline,
      FALL_ELAPSED
    )
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...cap, actual: 9000, progressPct, met }],
        DAY_24
      )
    ).toBe('at-risk')
  })

  it('a running total ahead of the clock is on track', () => {
    const revenue = {
      metric: 'revenue' as const,
      direction: 'gte' as const,
      targetValue: 41500,
      baseline: 41048,
    }
    const { progressPct, met } = targetProgress(
      revenue,
      17137.63,
      41048,
      FALL_ELAPSED
    )
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...revenue, actual: 17137.63, progressPct, met }],
        DAY_24
      )
    ).toBe('on-track')
  })
})

/**
 * The card is the surface a customer reads first. Three surfaces rebuilding this sentence from the
 * same fields would drift a word apart, and the print is the copy that goes
 * in front of a board.
 */
describe('the card, the goal page and the print carry one sentence', () => {
  const sources: Array<[string, string]> = [
    [
      'components/initiative-card.tsx',
      readFileSync(
        join(FEATURE_DIR, 'components', 'initiative-card.tsx'),
        'utf8'
      ),
    ],
    ['detail.tsx', readFileSync(join(FEATURE_DIR, 'detail.tsx'), 'utf8')],
    [
      'components/board-ready-export.tsx',
      readFileSync(
        join(FEATURE_DIR, 'components', 'board-ready-export.tsx'),
        'utf8'
      ),
    ],
  ]

  it.each(sources)('%s renders the shared sentence', (_name, src) => {
    expect(src).toMatch(/goalProgressSentence\(target, view\.elapsedPct\)/)
  })

  it.each(sources)('%s shows only an honest percent', (_name, src) => {
    expect(src).toMatch(/displayProgressPct\(target\)/)
    expect(src).not.toMatch(/progressLabel\(target\.progressPct\)/)
    // The bar and the number beside it read the same field, or a goal that
    // moved backwards shows a dash over a filled track.
    expect(src).not.toMatch(/target\.progressPct \?\? 0/)
  })
})

/**
 * Every rule below fails in the FLATTERING direction when it breaks, which is
 * worse than reading too low: a customer goes looking for
 * a card that reads badly and never goes looking for one that reads well.
 */
describe('a goal already lost never reads on pace', () => {
  const window = {
    status: 'active' as const,
    startDate: FALL.startDate,
    endDate: FALL.endDate,
  }
  /** 85.5 of the fall window's 90 days, then a day past the end. */
  const LATE = new Date('2026-11-25T12:00:00.000Z')
  const AFTER = new Date('2026-12-01T00:00:00.000Z')
  const LATE_ELAPSED = windowElapsedPct(FALL.startDate, FALL.endDate, LATE)
  const AFTER_ELAPSED = windowElapsedPct(FALL.startDate, FALL.endDate, AFTER)

  const cap = {
    metric: 'cost' as const,
    direction: 'lte' as const,
    targetValue: 13000,
    baseline: 10000,
  }

  it('reads these two clocks as the last tenth of the window', () => {
    expect(LATE_ELAPSED).toBe(100 - ROI_PACE_GRACE_PTS / 2)
    expect(AFTER_ELAPSED).toBe(100)
  })

  it('a blown cap is over pace at 95% elapsed, not on track', () => {
    const { progressPct, met } = targetProgress(
      cap,
      13400,
      cap.baseline,
      LATE_ELAPSED
    )
    expect(met).toBe(false)
    expect(
      targetPace({ ...cap, actual: 13400, progressPct }, LATE_ELAPSED)
    ).toBe('behind')
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...cap, actual: 13400, progressPct, met }],
        LATE
      )
    ).toBe('at-risk')
    expect(
      goalProgressSentence(
        { ...cap, actual: 13400, progressPct, met },
        LATE_ELAPSED
      )
    ).toBe(
      `${formatCost(13400)} so far against last window's ${formatCost(10000)}, over the ${formatCost(13000)} limit with 95% of the window elapsed. Over pace.`
    )
  })

  it('and is still over pace with the window fully spent', () => {
    const { progressPct, met } = targetProgress(
      cap,
      13400,
      cap.baseline,
      AFTER_ELAPSED
    )
    expect(met).toBe(false)
    expect(
      targetPace({ ...cap, actual: 13400, progressPct }, AFTER_ELAPSED)
    ).toBe('behind')
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...cap, actual: 13400, progressPct, met }],
        AFTER
      )
    ).toBe('at-risk')
    expect(
      goalProgressSentence(
        { ...cap, actual: 13400, progressPct, met },
        AFTER_ELAPSED
      )
    ).toBe(
      `${formatCost(13400)} so far against last window's ${formatCost(10000)}, over the ${formatCost(13000)} limit with 100% of the window elapsed. Over pace.`
    )
  })

  // A spent window has no time left for the grace to buy, so 94% of target on
  // the last day is a miss, not a lead.
  it('a revenue goal 6% short on the last day is behind pace', () => {
    const revenue = {
      metric: 'revenue' as const,
      direction: 'gte' as const,
      targetValue: 41500,
      baseline: 41048,
    }
    const { progressPct, met } = targetProgress(
      revenue,
      39000,
      revenue.baseline,
      AFTER_ELAPSED
    )
    expect(
      targetPace({ ...revenue, actual: 39000, progressPct }, AFTER_ELAPSED)
    ).toBe('behind')
    expect(
      deriveInitiativeHealth(
        window,
        [{ ...revenue, actual: 39000, progressPct, met }],
        AFTER
      )
    ).toBe('at-risk')
    expect(
      goalProgressSentence(
        { ...revenue, actual: 39000, progressPct, met },
        AFTER_ELAPSED
      )
    ).toBe(
      `${formatCost(39000)} so far, 94% of target with 100% of the window elapsed. Behind pace.`
    )
  })
})

describe('a level goal below its starting value is behind from the first week', () => {
  const window = {
    status: 'active' as const,
    startDate: FALL.startDate,
    endDate: FALL.endDate,
  }
  const margin = {
    metric: 'marginPercent' as const,
    direction: 'gte' as const,
    targetValue: 70,
    baseline: 67,
  }

  // Days 1, 4 and 8 of 90: the whole stretch where the elapsed share is still
  // inside the grace band, where a floored 0% must not read as a lead.
  it.each(['2026-09-02', '2026-09-05', '2026-09-09'])(
    'on %s it says behind pace and at risk, never ahead',
    (day) => {
      const now = new Date(`${day}T00:00:00.000Z`)
      const elapsed = windowElapsedPct(FALL.startDate, FALL.endDate, now)
      expect(elapsed).not.toBeNull()
      expect(elapsed as number).toBeLessThan(ROI_PACE_GRACE_PTS)

      const { progressPct, met } = targetProgress(
        margin,
        65.8,
        margin.baseline,
        elapsed
      )
      expect(progressPct).toBe(0)
      expect(
        targetPace({ ...margin, actual: 65.8, progressPct }, elapsed)
      ).toBe('behind')
      expect(
        deriveInitiativeHealth(
          window,
          [{ ...margin, actual: 65.8, progressPct, met }],
          now
        )
      ).toBe('at-risk')

      const sentence = goalProgressSentence(
        { ...margin, actual: 65.8, progressPct, met },
        elapsed
      )
      expect(sentence).toBe(
        `${formatPct(65.8)} now, down from ${formatPct(67)} at the start. Behind pace.`
      )
      expect(sentence).not.toContain('Ahead of pace')
    }
  )
})

/**
 * The one recipe for "show me what the AI saved" is internalCost or
 * externalCost + a starting value + Keep under (INITIATIVE_METRIC_META). The
 * card has to keep naming that starting figure, or the goal a customer set up
 * to watch spend come down stops showing what it came down from.
 */
describe('a spend cap with a starting value names last window on the card', () => {
  const cap = {
    metric: 'internalCost' as const,
    direction: 'lte' as const,
    targetValue: 7900,
    baseline: 10000,
  }

  it('names it over the cap, halfway through the window', () => {
    const { progressPct, met } = targetProgress(cap, 8820, cap.baseline, 49)
    expect(
      goalProgressSentence({ ...cap, actual: 8820, progressPct, met }, 49)
    ).toBe(
      `${formatCost(8820)} so far against last window's ${formatCost(10000)}, over the ${formatCost(7900)} limit with 49% of the window elapsed. Over pace.`
    )
  })

  it('names it under the cap, with the window closed', () => {
    const { progressPct, met } = targetProgress(cap, 7100, cap.baseline, 100)
    expect(met).toBe(true)
    expect(
      goalProgressSentence({ ...cap, actual: 7100, progressPct, met }, 100)
    ).toBe(
      `${formatCost(7100)} so far against last window's ${formatCost(10000)}, under the ${formatCost(7900)} limit.`
    )
  })

  it('names nothing where the goal has no starting value', () => {
    const { progressPct, met } = targetProgress(cap, 4000, null, 49)
    expect(
      goalProgressSentence(
        { ...cap, baseline: null, actual: 4000, progressPct, met },
        49
      )
    ).toBe(
      `${formatCost(4000)} so far, 51% of the limit with 49% of the window elapsed. On pace to stay under.`
    )
  })

  // Half a window in, a running total has not banked a saving against a whole
  // previous window's total, so the card names the figure and never the gap.
  it('claims no saving while the window is still running', () => {
    const { progressPct, met } = targetProgress(cap, 4000, cap.baseline, 49)
    const sentence = goalProgressSentence(
      { ...cap, actual: 4000, progressPct, met },
      49
    )
    expect(sentence).toContain(`against last window's ${formatCost(10000)}`)
    expect(sentence).not.toMatch(/saved|less than|under last window/)
  })
})

/**
 * A goal with no end date has no clock, but the pace rule still applies.
 * A running total is the one kind that can be lost before any date arrives:
 * once it is past its cap it can never come back under it, so reading it as
 * on track is the flattering failure the block above exists to kill.
 */
describe('an open-ended goal still reads a cap it has already blown', () => {
  const open = {
    status: 'active' as const,
    startDate: FALL.startDate,
    endDate: null,
  }
  const OPEN_ELAPSED = windowElapsedPct(FALL.startDate, null, DAY_24)
  const cap = {
    metric: 'internalCost' as const,
    direction: 'lte' as const,
    targetValue: 7900,
    baseline: 10000,
  }

  it('has no clock to read', () => {
    expect(OPEN_ELAPSED).toBeNull()
  })

  it('over the limit reads over the limit and at risk', () => {
    const { progressPct, met } = targetProgress(
      cap,
      8820,
      cap.baseline,
      OPEN_ELAPSED
    )
    expect(met).toBe(false)
    expect(
      targetPace({ ...cap, actual: 8820, progressPct }, OPEN_ELAPSED)
    ).toBe('behind')
    expect(
      deriveInitiativeHealth(
        open,
        [{ ...cap, actual: 8820, progressPct, met }],
        DAY_24
      )
    ).toBe('at-risk')
    const sentence = goalProgressSentence(
      { ...cap, actual: 8820, progressPct, met },
      OPEN_ELAPSED
    )
    expect(sentence).toBe(
      `${formatCost(8820)} so far against a starting value of ${formatCost(10000)}, over the ${formatCost(7900)} limit.`
    )
    expect(sentence).not.toContain('pace')
    expect(sentence).not.toContain('elapsed')
  })

  it('under the limit keeps its silence and its on-track reading', () => {
    const { progressPct, met } = targetProgress(
      cap,
      4000,
      cap.baseline,
      OPEN_ELAPSED
    )
    expect(
      targetPace({ ...cap, actual: 4000, progressPct }, OPEN_ELAPSED)
    ).toBeNull()
    expect(
      deriveInitiativeHealth(
        open,
        [{ ...cap, actual: 4000, progressPct, met }],
        DAY_24
      )
    ).toBe('on-track')
    expect(
      goalProgressSentence(
        { ...cap, actual: 4000, progressPct, met },
        OPEN_ELAPSED
      )
    ).toBe(
      `${formatCost(4000)} so far against a starting value of ${formatCost(10000)}, 51% of the limit.`
    )
  })

  it('a reach-at-least goal is untouched: no pace, still on track', () => {
    const revenue = {
      metric: 'revenue' as const,
      direction: 'gte' as const,
      targetValue: 41500,
      baseline: 41048,
    }
    const { progressPct, met } = targetProgress(
      revenue,
      4000,
      revenue.baseline,
      OPEN_ELAPSED
    )
    expect(
      targetPace({ ...revenue, actual: 4000, progressPct }, OPEN_ELAPSED)
    ).toBeNull()
    expect(
      deriveInitiativeHealth(
        open,
        [{ ...revenue, actual: 4000, progressPct, met }],
        DAY_24
      )
    ).toBe('on-track')
  })

  // A level number that slipped can climb back with no date pressing on it,
  // so the moved-the-wrong-way shortcut still needs a clock behind it.
  it('a level goal below its start is untouched too', () => {
    const margin = {
      metric: 'marginPercent' as const,
      direction: 'gte' as const,
      targetValue: 70,
      baseline: 67,
    }
    const { progressPct, met } = targetProgress(
      margin,
      65.8,
      margin.baseline,
      OPEN_ELAPSED
    )
    expect(
      targetPace({ ...margin, actual: 65.8, progressPct }, OPEN_ELAPSED)
    ).toBeNull()
    expect(
      deriveInitiativeHealth(
        open,
        [{ ...margin, actual: 65.8, progressPct, met }],
        DAY_24
      )
    ).toBe('on-track')
  })

  // The sentence and the Stat label above it read one rule, or the page says
  // "Starting value" over a line that names a window nobody measured.
  it('names the stored figure the way the page labels it, either way', () => {
    const openRead = targetProgress(cap, 4000, cap.baseline, OPEN_ELAPSED)
    expect(
      goalProgressSentence({ ...cap, actual: 4000, ...openRead }, OPEN_ELAPSED)
    ).toContain(baselineLabel(cap.metric, null).toLowerCase())

    const windowedRead = targetProgress(cap, 4000, cap.baseline, 49)
    expect(
      goalProgressSentence({ ...cap, actual: 4000, ...windowedRead }, 49)
    ).toContain(baselineLabel(cap.metric, FALL.endDate).toLowerCase())
  })
})
