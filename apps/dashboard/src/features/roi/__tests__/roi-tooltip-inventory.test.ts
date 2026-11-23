/**
 * WHAT THIS FILE DOES: gates every hover sentence on the ROI page.
 *
 * WHY IT EXISTS: the ROI page carries many sentences behind hovers. They
 * all live in
 * apps/dashboard/lib/tooltip-definitions.ts, which sits OUTSIDE
 * src/features/roi — so neither copy gate reads a word of it. Without
 * this file the next sentence someone adds there can say "matter", or point at
 * "the menu on the left", and every suite stays green.
 *
 * CONNECTS TO: ROI_TOOLTIPS, FINISHED_WORK_SOURCE_TOOLTIPS,
 * FINISHED_WORK_TOTALS_TOOLTIPS and GOAL_HEALTH_TOOLTIPS in
 * report-derivation.ts, every tooltip reportMetricTile builds, and the
 * regexes in ./support/copy-gates that tasks-copy-honesty.test.ts runs too.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  FEES_OUTSIDE_USAGE_REVENUE,
  tooltipDefinitions,
} from '@/lib/tooltip-definitions'
import {
  FINISHED_WORK_SOURCE_TOOLTIPS,
  FINISHED_WORK_TOTALS_TOOLTIPS,
  GOAL_HEALTH_TOOLTIPS,
  HEADLINE_METRICS,
  REPORT_COPY,
  ROI_TOOLTIPS,
  SECONDARY_METRICS,
  WITHOUT_AI_COPY,
  reportMetricTile,
  type RoiTooltip,
} from '../report-derivation'
import { ROI_PACE_GRACE_PTS } from '../progress-derivation'
import {
  VERTICAL_WORD,
  isWayfindingOffense,
  sentenceCount,
  uncontractedForms,
} from './support/copy-gates'

const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')

/** Every hover the ROI page can show, keyed by where a reader would meet it. */
const EVERY_HOVER: Array<[string, RoiTooltip]> = [
  ...Object.entries(ROI_TOOLTIPS),
  ...Object.entries(FINISHED_WORK_SOURCE_TOOLTIPS).map(
    ([key, tooltip]): [string, RoiTooltip] => [`finished word: ${key}`, tooltip]
  ),
  ...Object.entries(FINISHED_WORK_TOTALS_TOOLTIPS).map(
    ([key, tooltip]): [string, RoiTooltip] => [`totals word: ${key}`, tooltip]
  ),
  ...Object.entries(GOAL_HEALTH_TOOLTIPS).map(
    ([key, tooltip]): [string, RoiTooltip] => [`goal health: ${key}`, tooltip]
  ),
  ...[...HEADLINE_METRICS, ...SECONDARY_METRICS].map(
    (metric): [string, RoiTooltip] => [
      `metric tile: ${metric}`,
      reportMetricTile({ metric, value: 12.5, unavailable: null }).tooltip,
    ]
  ),
]

describe('every ROI hover', () => {
  it('covers all four records and all twelve tiles, so a thin run cannot pass', () => {
    expect(EVERY_HOVER.length).toBeGreaterThanOrEqual(51)
    const keys = EVERY_HOVER.map(([key]) => key)
    expect(keys).toEqual(expect.arrayContaining(['metric tile: cost']))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each(EVERY_HOVER)('%s says something', (_key, tooltip) => {
    expect(tooltip.title.trim()).not.toBe('')
    expect(tooltip.description.trim()).not.toBe('')
  })

  // The tooltip rule: one to two plain sentences. `details` is the
  // popover's second paragraph, set in dimmer type under the body, and it
  // qualifies the body rather than continuing it, so it carries exactly one.
  it.each(EVERY_HOVER)('%s is two sentences or fewer', (_key, tooltip) => {
    const body = sentenceCount(tooltip.description)
    expect(body).toBeGreaterThan(0)
    expect(body).toBeLessThanOrEqual(2)
    if (tooltip.details) expect(sentenceCount(tooltip.details)).toBe(1)
  })

  it.each(EVERY_HOVER)(
    '%s carries none of the vertical vocabulary',
    (_key, tooltip) => {
      for (const sentence of [
        tooltip.title,
        tooltip.description,
        tooltip.details ?? '',
      ]) {
        expect(VERTICAL_WORD.test(sentence)).toBe(false)
      }
    }
  )

  it.each(EVERY_HOVER)('%s points at a findable place', (_key, tooltip) => {
    for (const sentence of [tooltip.description, tooltip.details ?? '']) {
      expect(isWayfindingOffense(sentence)).toBe(false)
    }
  })

  // No em dashes, and no smart quotes pretending to be one.
  it.each(EVERY_HOVER)('%s carries no em dash', (_key, tooltip) => {
    const all = `${tooltip.title} ${tooltip.description} ${tooltip.details ?? ''}`
    expect(all).not.toMatch(/[—–]/)
  })

  // The page uses contractions, so every hover does too and a reader
  // crossing the page meets one voice.
  it.each(EVERY_HOVER)('%s writes the way the page writes', (_key, tooltip) => {
    const all = `${tooltip.description} ${tooltip.details ?? ''}`
    expect(uncontractedForms(all)).toEqual([])
  })

  // The trigger is a button labelled `What ${title} means`, so a plural title
  // is read aloud as "What these three methods means".
  it.each(EVERY_HOVER)(
    '%s has a title that fits its aria-label',
    (_key, tooltip) => {
      expect(`What ${tooltip.title} means`).not.toMatch(
        /\b(these|those|they|them)\b/i
      )
    }
  )

  // Two Print report buttons about 350px apart, both calling the same print.
  // A reader who cannot tell them apart assumes the near one prints the card.
  it('tells the two Print report buttons apart', () => {
    expect(ROI_TOOLTIPS.printReportAgain.title).toBe(
      ROI_TOOLTIPS.printReport.title
    )
    expect(ROI_TOOLTIPS.printReportAgain.description).not.toBe(
      ROI_TOOLTIPS.printReport.description
    )
    expect(ROI_TOOLTIPS.printReportAgain.description).toContain(
      'The same print'
    )
    expect(ROI_TOOLTIPS.printReportAgain.description).toContain(
      'every tab as one document'
    )
  })

  // The disclosure holds eight tiles: the six slow reads plus Usage events and
  // Avg cost / usage event, which are already loaded, so the hover names no
  // count.
  it('does not promise a count of what Show every metric opens', () => {
    expect(ROI_TOOLTIPS.showEveryMetric.description).toContain(
      'Opens the rest of the metrics.'
    )
    expect(ROI_TOOLTIPS.showEveryMetric.description).not.toContain(
      'Opens the six metrics'
    )
  })

  it('the gate catches what it exists to catch', () => {
    expect(VERTICAL_WORD.test('Cost per matter in these dates.')).toBe(true)
    expect(uncontractedForms('It is never an estimate.')).toEqual(['It is'])
    expect(uncontractedForms("It's never an estimate.")).toEqual([])
    expect(isWayfindingOffense('The dates at the top of this page.')).toBe(true)
    expect(isWayfindingOffense('Open Getting Started in the left menu.')).toBe(
      false
    )
    expect(sentenceCount('One. Two. Three.')).toBe(3)
  })
})

/**
 * The intro line promises a TAP shows a definition, and that is only true while
 * the component drives `open` from the tap's own click. Playwright proves the
 * behavior; this pins the sentence and the code together so neither can go
 * alone.
 */
describe('the promise the intro line makes about tapping', () => {
  const infoTooltipSrc = readFileSync(
    join(DASHBOARD_ROOT, 'src', 'components', 'ui', 'info-tooltip.tsx'),
    'utf8'
  )
  const intro = REPORT_COPY.howThisPageWorks.join(' ')

  it('is made', () => {
    expect(intro).toContain('Hover or tap the small i')
  })

  // The wayfinding rule bans layout-relative words in a direction.
  it('names the control rather than where it sits', () => {
    expect(intro).toContain('the small i on any number')
    expect(intro).not.toMatch(/\b(beside|above|below)\b/)
  })

  it('is kept by both hover components, not just the icon one', () => {
    expect(intro).toMatch(/\btap\b/)
    expect(infoTooltipSrc).toContain('function useHoverOrTap()')
    // Controlled open plus a click that toggles it: without both, a tap shows
    // nothing at all on a touch screen.
    expect(infoTooltipSrc).toMatch(
      /open=\{open\} onOpenChange=\{onOpenChange\}/
    )
    expect(
      infoTooltipSrc.match(/const \{ open, onOpenChange, triggerProps \} =/g)
    ).toHaveLength(2)
    expect(infoTooltipSrc.match(/triggerProps\}/g)).toHaveLength(2)
  })

  it('never cancels the wrapped element’s own click', () => {
    // TooltipWrap wraps the "Get this as data" link. Cancelling the trigger's
    // default would open the definition and swallow the navigation.
    expect(infoTooltipSrc).not.toMatch(/preventDefault\s*\(/)
  })
})

/**
 * The seven hovers the two revenue columns and the always-there
 * Revenue row owe a reader. Every number on this block has a definition a
 * tap away, including the one we assume on their behalf.
 */
describe('the revenue hovers', () => {
  it('defines both columns, and says which fees each one leaves out', () => {
    expect(ROI_TOOLTIPS.agentEarned.description).toContain('Usage fees only')
    expect(ROI_TOOLTIPS.agentEarned.description).toContain(
      FEES_OUTSIDE_USAGE_REVENUE
    )
    expect(ROI_TOOLTIPS.agentRevenue.title).toBe('Total revenue')
    expect(ROI_TOOLTIPS.agentRevenue.description).toContain('Every fee')
    expect(ROI_TOOLTIPS.agentRevenue.description).toContain('Revenue tile')
  })

  it('defines the control itself', () => {
    expect(ROI_TOOLTIPS.revenueBasis.description).toContain('Margin')
  })

  it('says which revenue the Margin column is a percent of', () => {
    expect(ROI_TOOLTIPS.agentMargin.description).toContain('as a percent of')
    expect(ROI_TOOLTIPS.agentMargin.description).toMatch(/picked|pick/)
  })

  it('covers all three cells of the Revenue row and the net line', () => {
    for (const key of [
      'comparisonRevenueWithAi',
      'comparisonRevenueWithoutAi',
      'comparisonRevenueDifference',
      'netLine',
      'revenuePerMonthField',
    ] as const) {
      expect(ROI_TOOLTIPS[key].description.trim().length).toBeGreaterThan(0)
    }
    expect(ROI_TOOLTIPS.comparisonRevenueWithoutAi.description).toContain(
      'blank'
    )
    expect(ROI_TOOLTIPS.netLine.description).toContain('cost')
  })

  it('the revenue-gap hover reads true when the without-AI number is ours, not theirs', () => {
    const copy = ROI_TOOLTIPS.comparisonRevenueDifference.description
    // On the assumed path there is no customer estimate to take a share of.
    expect(copy).not.toContain('your estimate')
    expect(copy).toContain(WITHOUT_AI_COPY.aboutTheSameCell)
  })
})

/**
 * The rule: reuse an existing tooltip key where the term matches. Earned
 * matched and is not forked; the three terms ROI does not reuse are pinned here
 * with their reasons, so the next reader sees a decision rather than an oversight.
 */
describe('the ROI hovers and the shared tooltip registry', () => {
  it('give Earned one fee list, on the ROI page and on Build', () => {
    expect(ROI_TOOLTIPS.agentEarned.description).toContain(
      FEES_OUTSIDE_USAGE_REVENUE
    )
    expect(tooltipDefinitions.agentEarned.details).toContain(
      FEES_OUTSIDE_USAGE_REVENUE
    )
    expect(tooltipDefinitions.usageRevenue.details).toContain(
      FEES_OUTSIDE_USAGE_REVENUE
    )
    for (const key of [
      'agentEarned',
      'usageRevenue',
      'earnedRevenueBreakdown',
    ] as const) {
      expect(tooltipDefinitions[key].details).not.toMatch(/setup fees/)
    }
  })

  it('count a USAGE event, which the shared events entry does not', () => {
    expect(ROI_TOOLTIPS.agentUsageEvents.description).toBe(
      REPORT_COPY.usageEventDefinition
    )
    expect(ROI_TOOLTIPS.agentUsageEvents.description).toContain(
      'five-minute flush'
    )
    expect(tooltipDefinitions.events.description).not.toContain(
      'five-minute flush'
    )
  })

  it('call Margin a percent, where the shared margin entry is dollars', () => {
    expect(ROI_TOOLTIPS.agentMargin.description).toContain('as a percent of')
    expect(tooltipDefinitions.margin.description).not.toContain('percent')
  })

  it('leave no em dash in the shared entries the ROI page sits beside', () => {
    for (const key of ['margin', 'agentEarned', 'usageRevenue'] as const) {
      const entry: { description: string; details?: string } =
        tooltipDefinitions[key]
      expect(`${entry.description} ${entry.details ?? ''}`).not.toMatch(/[—–]/)
    }
  })
})

/**
 * The health pill is the only word on a goal card that explains itself, so it
 * has to describe the rule deriveInitiativeHealth actually runs: a ten-point
 * grace band, and no pace expectation at all without an end date.
 */
describe('the goal health hovers describe the rule the code runs', () => {
  it('names the grace band rather than plain "behind"', () => {
    expect(ROI_PACE_GRACE_PTS).toBe(10)
    expect(GOAL_HEALTH_TOOLTIPS['on-track'].description).toContain(
      'more than ten points behind'
    )
    expect(GOAL_HEALTH_TOOLTIPS['at-risk'].description).toContain(
      'more than ten points behind'
    )
  })

  // The percent means two different things depending on what the metric is,
  // and a reader who assumes the wrong one misreads the card either way.
  it('the progress hover names both kinds of goal metric', () => {
    const description = ROI_TOOLTIPS.goalProgress.description
    expect(description).toMatch(/adds up/i)
    expect(description).toMatch(/running total divided by the target/i)
    expect(description).toMatch(/level you hold/i)
    expect(description).toMatch(/from where it started/i)
  })

  it('says a goal with no end date has no pace to keep', () => {
    expect(GOAL_HEALTH_TOOLTIPS['on-track'].description).toContain(
      'no end date'
    )
  })

  it('matches the other four states to what the code returns', () => {
    expect(GOAL_HEALTH_TOOLTIPS.achieved.description).toContain('Every target')
    expect(GOAL_HEALTH_TOOLTIPS['not-started'].description).toContain(
      'start date'
    )
    expect(GOAL_HEALTH_TOOLTIPS['no-data'].description).toContain(
      'no target we can measure'
    )
    expect(GOAL_HEALTH_TOOLTIPS.archived.description).toContain('archived')
  })

  // Two kinds of goal run two different rules, and "behind" is the wrong word
  // for a spending cap: over its pace means it spent AHEAD of its dates.
  it('the health hovers name the cap rule as well as the level one', () => {
    for (const state of ['on-track', 'at-risk'] as const) {
      const { description } = GOAL_HEALTH_TOOLTIPS[state]
      expect(description).toMatch(/spending cap/i)
      expect(description).toMatch(/through its dates/i)
      expect(description).toMatch(/ten points behind/i)
    }
  })

  it('spells the progress hover in US English', () => {
    expect(ROI_TOOLTIPS.goalProgress.description).toContain('traveled')
    expect(ROI_TOOLTIPS.goalProgress.description).not.toContain('travelled')
  })
})
