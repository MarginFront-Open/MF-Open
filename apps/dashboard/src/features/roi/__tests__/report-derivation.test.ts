/**
 * The ROI report's pure derivation. Every string the report
 * puts on screen is built here, so this suite is the copy gate as well as the
 * math gate: the lead sentence and its grammar, the empty state, the rule that
 * totals are ECHOED and never re-summed from the rows, the twelve metric
 * definitions, and the two honesty sentences.
 *
 * Node-only, no DB, no mocks — pure functions in, exact strings out.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { formatCost, formatPct } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { WORK_ITEM_NOUN_PLURAL } from '@/lib/work-item-noun'
import {
  HEADLINE_METRICS,
  METRIC_DESCRIPTIONS,
  ROI_TOOLTIPS,
  METRIC_EXAMPLE_NOTES,
  REPORT_COPY,
  SECONDARY_METRICS,
  WITHOUT_AI_COPY,
  comparisonDifferenceCell,
  countRecordingAgents,
  reportAgentRowCells,
  reportEmptySentence,
  reportLeadSentence,
  reportMetricTile,
  reportTotalsCells,
  splitHeadlineMetrics,
  DEFAULT_REVENUE_BASIS,
  REVENUE_BASIS_OPTIONS,
  reportAgentsTableHeaders,
  resolveRevenueBasis,
  composeReportAgentRows,
  totalRevenueByAgent,
  usageOnlyAgentRevenue,
  type ReportAgentRowValues,
  type ReportProvenance,
  type WithoutAiStampedRow,
} from '../report-derivation'
import { INITIATIVE_METRIC_META } from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const WINDOW = { startDate: '2026-08-19', endDate: '2026-09-18' }

describe('reportLeadSentence — the one line above the agent table', () => {
  it('names the dates, the agent count, the usage events and the cost', () => {
    expect(
      reportLeadSentence({
        ...WINDOW,
        agentsThatRecorded: 4,
        usageEvents: 1204,
        cost: 5012.4,
        includesDeletedAgents: false,
      })
    ).toBe(
      `Between ${formatDisplayDate('2026-08-19')} and ${formatDisplayDate(
        '2026-09-18'
      )}, 4 of your agents recorded ${(1204).toLocaleString()} usage events and cost ${formatCost(
        5012.4
      )}.`
    )
  })

  it('a single usage event is not pluralised', () => {
    const sentence = reportLeadSentence({
      ...WINDOW,
      agentsThatRecorded: 1,
      usageEvents: 1,
      cost: 0.42,
      includesDeletedAgents: false,
    })
    expect(sentence).toContain('1 of your agents recorded 1 usage event and')
    expect(sentence).not.toContain('1 usage events')
  })

  it('formats money through canon-format, never a raw number', () => {
    const sentence = reportLeadSentence({
      ...WINDOW,
      agentsThatRecorded: 2,
      usageEvents: 9,
      cost: 0.006,
      includesDeletedAgents: false,
    })
    expect(sentence).toContain(formatCost(0.006))
    expect(sentence).not.toContain('0.006 ')
  })
})

describe('countRecordingAgents — who the lead sentence is allowed to count', () => {
  const row = (
    over: Partial<ReportAgentRowValues> = {}
  ): ReportAgentRowValues => ({
    agentId: 'a1',
    name: 'Quote Writer',
    usageEvents: 12,
    cost: 1,
    earned: 0,
    revenue: 0,
    marginPercent: null,
    ...over,
  })

  // A row can show 0 usage events and $0.00: it is in the
  // table for its subscription revenue. "10 of your agents recorded 247
  // usage events" is a claim such a row disproves on the same screen.
  it('leaves out a row that recorded nothing', () => {
    expect(
      countRecordingAgents([
        row(),
        row({ agentId: 'a2', usageEvents: 0 }),
        row({ agentId: 'a3', usageEvents: 0, earned: 198 }),
      ])
    ).toBe(1)
  })

  it('leaves out the deleted-agents catch-all, which is no agent', () => {
    expect(countRecordingAgents([row({ agentId: null, usageEvents: 4 })])).toBe(
      0
    )
  })
})

describe('reportLeadSentence — the deleted-agents scope qualifier', () => {
  it('says the total outgrows the agent count when a catch-all row is present', () => {
    // The agent COUNT is live agents; the cost and usage-event TOTALS cover
    // every event in the window, including events from agents the customer
    // deleted. Two scopes in one sentence is honest only if the sentence
    // says so, so the clause rides on the number it qualifies.
    const withDeleted = reportLeadSentence({
      ...WINDOW,
      agentsThatRecorded: 4,
      usageEvents: 1204,
      cost: 5012.4,
      includesDeletedAgents: true,
    })
    const without = reportLeadSentence({
      ...WINDOW,
      agentsThatRecorded: 4,
      usageEvents: 1204,
      cost: 5012.4,
      includesDeletedAgents: false,
    })
    expect(withDeleted).toBe(`${without}${REPORT_COPY.deletedAgentsClause}`)
    expect(withDeleted).toContain('agents you deleted')
    expect(without).not.toContain('deleted')
  })
})

describe('reportEmptySentence — a window with nothing in it', () => {
  it('names the dates and says what to do next, without inventing a zero', () => {
    expect(reportEmptySentence(WINDOW)).toBe(
      `Nothing recorded between ${formatDisplayDate(
        '2026-08-19'
      )} and ${formatDisplayDate(
        '2026-09-18'
      )}. Widen the dates, or connect an agent and this table fills itself.`
    )
    expect(reportEmptySentence(WINDOW)).not.toContain('$0')
  })
})

describe('reportAgentRowCells — one row, already formatted', () => {
  const ROW: ReportAgentRowValues = {
    agentId: 'agent-1',
    name: 'Contract summary',
    usageEvents: 1204,
    cost: 5012.4,
    earned: 9000,
    revenue: 9000,
    marginPercent: 44.3,
  }

  it('every cell is a string built through the canon formatters', () => {
    expect(reportAgentRowCells(ROW, 'earned')).toEqual({
      key: 'agent-1',
      name: 'Contract summary',
      usageEvents: (1204).toLocaleString(),
      cost: formatCost(5012.4),
      earned: formatCost(9000),
      revenue: formatCost(9000),
      chosenRevenue: formatCost(9000),
      margin: formatPct(44.3),
    })
  })

  it('a null margin renders the honest dash, never 0%', () => {
    expect(reportAgentRowCells({ ...ROW, earned: 0, revenue: 0 }).margin).toBe(
      '—'
    )
  })

  it('the deleted-agents catch-all row has a stable key even with a null id', () => {
    expect(
      reportAgentRowCells({
        ...ROW,
        agentId: null,
        name: 'Deleted agents',
      }).key
    ).toBe('deleted-agents')
  })
})

describe('reportTotalsCells — the totals are ECHOED, never re-summed', () => {
  it('renders the totals it was handed even when the rows would sum to something else', () => {
    // Deliberately inconsistent input: if this function ever re-summed the
    // rows, these expectations would be the row sum instead of the canon
    // totals, and the table would silently disagree with the tiles.
    const cells = reportTotalsCells({
      usageEvents: 1204,
      cost: 5012.4,
      earned: 9000,
      revenue: 11000,
    })
    expect(cells).toEqual({
      label: REPORT_COPY.totalsRowLabel,
      usageEvents: (1204).toLocaleString(),
      cost: formatCost(5012.4),
      earned: formatCost(9000),
      revenue: formatCost(11000),
    })
  })

  it('takes no rows argument at all, so re-summing is not expressible', () => {
    expect(reportTotalsCells.length).toBe(1)
  })
})

describe('the metric registry — twelve metrics, split six and six', () => {
  const ALL_METRICS = Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[]

  it('has a definition for every metric the goal dropdown offers', () => {
    expect(ALL_METRICS).toHaveLength(12)
    for (const metric of ALL_METRICS) {
      expect(METRIC_DESCRIPTIONS[metric].length).toBeGreaterThan(0)
    }
  })

  it('the headline six load first and the other six sit behind the disclosure', () => {
    expect(HEADLINE_METRICS).toEqual([
      'cost',
      'revenue',
      'margin',
      'marginPercent',
      'eventCount',
      'costPerTask',
    ])
    expect(SECONDARY_METRICS).toEqual([
      'unmappedCount',
      'mrr',
      'arr',
      'newCustomers',
      'internalCost',
      'externalCost',
    ])
  })

  it('the two lists partition the union — no metric is in both, none is missing', () => {
    const union = [...HEADLINE_METRICS, ...SECONDARY_METRICS]
    expect(new Set(union).size).toBe(union.length)
    expect([...union].sort()).toEqual([...ALL_METRICS].sort())
  })

  it('the headline six are the ones two cheap reads answer (no journal, no unbounded customer read)', () => {
    for (const metric of SECONDARY_METRICS) {
      expect(HEADLINE_METRICS).not.toContain(metric)
    }
  })
})

describe('reportMetricTile — a number with its definition under it', () => {
  it('carries the shipped label, the canon-formatted value and the definition', () => {
    const tile = reportMetricTile({
      metric: 'cost',
      value: 5012.4,
      unavailable: null,
    })
    expect(tile.key).toBe('cost')
    expect(tile.label).toBe(INITIATIVE_METRIC_META.cost.label)
    expect(tile.value).toBe(formatCost(5012.4))
    expect(tile.definition).toBe(METRIC_DESCRIPTIONS.cost)
    expect(tile.notes).toEqual([])
  })

  it('a null value renders the dash, never a zero', () => {
    expect(
      reportMetricTile({ metric: 'revenue', value: null, unavailable: null })
        .value
    ).toBe('—')
  })

  it('MRR and ARR say out loud that they are as-of-today, not window-scoped', () => {
    for (const metric of ['mrr', 'arr'] as const) {
      expect(
        reportMetricTile({ metric, value: 1000, unavailable: null }).notes
      ).toContain(REPORT_COPY.asOfTodayNote)
    }
  })

  it('an unmapped count refused by the window cap says why, with the real cap', () => {
    const tile = reportMetricTile({
      metric: 'unmappedCount',
      value: null,
      unavailable: { reason: 'window-too-wide', capDays: 92 },
    })
    expect(tile.value).toBe('—')
    expect(tile.notes).toContain(REPORT_COPY.unmappedOverWindowCap(92))
    expect(REPORT_COPY.unmappedOverWindowCap(92)).toContain('92 days')
  })

  it('a metric a live goal tracks says which goal', () => {
    const tile = reportMetricTile(
      { metric: 'cost', value: 10, unavailable: null },
      { trackedByGoal: 'Cut agent spend' }
    )
    expect(tile.notes).toContain(REPORT_COPY.trackedByGoal('Cut agent spend'))
    expect(REPORT_COPY.trackedByGoal('Cut agent spend')).toBe(
      'Tracked by your goal: Cut agent spend.'
    )
  })
})

describe('the honesty sentences — what a usage event is not, and why no hours', () => {
  it('says what one usage event is, in both sources, without the task word', () => {
    expect(REPORT_COPY.usageEventDefinition).toContain(
      'one call your integration records'
    )
    expect(REPORT_COPY.usageEventDefinition).toContain('five-minute flush')
    expect(REPORT_COPY.usageEventDefinition).not.toMatch(/\btasks?\b/i)
  })

  it('names the only two ways a finished thing gets counted', () => {
    // The customer has real doors to the count, so the sentence names them
    // and says what every other number on the page still is. One door the
    // table already shows is a named integration signal, which nobody on the
    // team recorded, so "only when your team records them" would contradict
    // a row just below it.
    expect(REPORT_COPY.proxyGap).toContain('when your team records it')
    expect(REPORT_COPY.proxyGap).toContain(
      'node ~/.marginfront-ccc/cli.js done'
    )
    expect(REPORT_COPY.proxyGap).toContain('through the API')
    expect(REPORT_COPY.proxyGap).toContain(
      'Signals your integrations name count too'
    )
    expect(REPORT_COPY.proxyGap).toContain(
      'Everything else on this page is usage events'
    )
  })

  it('refuses an hours number and says why, because no duration is recorded anywhere', () => {
    expect(REPORT_COPY.noHours).toContain("We don't show hours saved")
    expect(REPORT_COPY.noHours).toContain('would be a guess')
  })

  it('the work-item noun is ONE constant for the whole dashboard, so a rename later is one line', () => {
    // The report must not carry a second copy of this noun beside the one the
    // goal cards read; two copies would drift apart.
    expect(WORK_ITEM_NOUN_PLURAL).toBe('work items')
    expect(
      readFileSync(join(__dirname, '..', 'report-derivation.ts'), 'utf8')
    ).not.toMatch(/const WORK_ITEM_NOUN\b/)
  })
})

describe('copy microstyle — every string the report renders', () => {
  const EVERY_STRING: string[] = [
    ...Object.values(REPORT_COPY).flatMap((value) =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value
          : typeof value === 'function'
            ? [value(WINDOW.startDate as never, WINDOW.endDate as never)]
            : []
    ),
    ...Object.values(METRIC_DESCRIPTIONS),
    reportLeadSentence({
      ...WINDOW,
      agentsThatRecorded: 2,
      usageEvents: 5,
      cost: 1,
      includesDeletedAgents: true,
    }),
    reportEmptySentence(WINDOW),
  ]

  it('has strings to check (guards against a silently-empty suite)', () => {
    expect(EVERY_STRING.length).toBeGreaterThan(15)
  })

  it('uses no em dash and no exclamation mark', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(/—/)
      expect(value).not.toMatch(/!/)
    }
  })

  it('never says "just"', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(/\bjust\b/i)
    }
  })

  it('carries none of the banned vertical vocabulary', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(
        /\b(matter|matters|legal|law|firm|case|cases)\b/i
      )
    }
  })
})

describe('the Revenue and Margin tiles name their basis, because Cost does not share it', () => {
  // Cost is every usage event in the window. Revenue and margin count only
  // usage billed to a subscription, so on an org with no subscriptions the
  // page renders Cost $5,012.40 next to Margin $0.00 under the words
  // "Revenue minus cost for this window". The math is canon; the note must
  // explain why Margin can read $0.00 next to a cost.
  it.each(['revenue', 'margin', 'marginPercent'] as const)(
    '%s carries the basis note',
    (metric) => {
      expect(
        reportMetricTile({ metric, value: 1, unavailable: null }).notes
      ).toContain(REPORT_COPY.revenueScopeNote)
    }
  )

  it.each(['cost', 'eventCount', 'costPerTask'] as const)(
    '%s carries no basis note — it IS the total, not the scoped half',
    (metric) => {
      expect(
        reportMetricTile({ metric, value: 1, unavailable: null }).notes
      ).not.toContain(REPORT_COPY.revenueScopeNote)
    }
  )

  it('names both bases and says out loud that the subtraction will not close', () => {
    expect(REPORT_COPY.revenueScopeNote).toContain('billed to a subscription')
    expect(REPORT_COPY.revenueScopeNote).toContain('every usage event')
    expect(REPORT_COPY.revenueScopeNote).toContain("won't always equal")
  })

  // revenue-metrics.ts sums recurring + seat + usage + one-time, so the
  // sentence names all four. Saying only "usage billed to a subscription"
  // would contradict a flat-fee customer's number.
  it('names what Revenue actually counts, all four kinds', () => {
    expect(REPORT_COPY.revenueScopeNote).toContain(
      'recurring fees, seat fees, usage and one-time charges'
    )
    expect(REPORT_COPY.revenueScopeNote).not.toContain(
      'Revenue and margin cover usage billed to a subscription'
    )
  })

  it('rides alongside the other notes rather than replacing them', () => {
    const tile = reportMetricTile(
      { metric: 'margin', value: 1, unavailable: null },
      { trackedByGoal: 'Cut agent spend' }
    )
    expect(tile.notes).toContain(REPORT_COPY.revenueScopeNote)
    expect(tile.notes).toContain(REPORT_COPY.trackedByGoal('Cut agent spend'))
  })
})

describe('the Earned column names its own scope, under a fuller Revenue tile', () => {
  it('says Earned is usage revenue only, and names what the Revenue tile adds', () => {
    expect(REPORT_COPY.earnedScopeHelper).toContain('Usage fees only')
    expect(REPORT_COPY.earnedScopeHelper).toContain(
      'recurring, seat and one-time fees'
    )
  })
})

/**
 * The tile definitions have to match the code that computes
 * them (packages/db/src/lib/revenue-metrics.ts: revenue sums recurring + seat
 * + usage + one-time; margin subtracts only subscription-attached cost), and
 * they have to agree with the note rendered directly beneath them.
 */
describe('Revenue and Margin say what the canon code actually computes', () => {
  it('Revenue names all four revenue kinds, not "usage and subscription activity"', () => {
    expect(METRIC_DESCRIPTIONS.revenue).toBe(
      'What your subscriptions earned in this window: recurring fees, seat fees, usage and one-time charges.'
    )
  })

  it('Margin subtracts the SUBSCRIPTION-scoped cost, not the Cost tile', () => {
    expect(METRIC_DESCRIPTIONS.margin).toBe(
      'Revenue minus the cost of the usage events that were billed to a subscription, in dollars.'
    )
  })

  it('the Margin definition agrees with the note printed under it', () => {
    const tile = reportMetricTile({
      metric: 'margin',
      value: 1,
      unavailable: null,
    })
    // "Revenue minus cost for this window" would contradict the note below,
    // which says Revenue minus Cost won't always equal Margin.
    expect(tile.definition).not.toBe(
      'Revenue minus cost for this window, in dollars.'
    )
    expect(tile.notes).toContain(REPORT_COPY.revenueScopeNote)
    expect(tile.definition).toContain('billed to a subscription')
  })

  it('the example notes match the definitions', () => {
    expect(METRIC_EXAMPLE_NOTES.revenue).toBe(
      'That number is the recurring fees, seat fees, usage and one-time charges your subscriptions earned in the window.'
    )
    expect(METRIC_EXAMPLE_NOTES.margin).toBe(
      'That number is revenue minus the cost of the usage events billed to a subscription.'
    )
  })
})

/**
 * The usage-event definition appears once on a screen: as the
 * agents-section note, not again inside the Usage events tile.
 */
describe('the usage-event definition lives in exactly one string', () => {
  it('the tile definition states the number, and leaves the definition to the page note', () => {
    expect(METRIC_DESCRIPTIONS.eventCount).toBe(
      'Usage events recorded in this window.'
    )
  })

  it('the page note carries the full definition, on all three surfaces', () => {
    expect(REPORT_COPY.usageEventDefinition).toContain(
      'One usage event is one call your integration records'
    )
    expect(REPORT_COPY.usageEventDefinition).toContain('coding meter')
  })

  it('the tile does not restate the coding-meter clause', () => {
    expect(METRIC_DESCRIPTIONS.eventCount).not.toContain('coding meter')
    expect(METRIC_DESCRIPTIONS.eventCount).not.toContain(
      'one call your integration records'
    )
  })
})

/** A title attribute reaches a mouse user only, so the sentence is a real
 *  tooltip and a keyboard reader gets it too. Pinned here so it cannot
 *  drift. */
describe('the data link says what it opens and who it is for', () => {
  it('names the format, the new tab, the per-number stamp and the audience', () => {
    expect(REPORT_COPY.dataLinkHover).toBe(
      'Opens the numbers behind this page as plain data (JSON) in a new tab, ' +
        'with a word on each saying where it came from: measured, attributed, ' +
        'or your own estimate. For a spreadsheet or a slide tool, not for ' +
        'reading.'
    )
  })

  // The payload ships four stamps, and the hover must name every one,
  // "attributed" included, since that is the measured-versus-attributed
  // line. Read off the
  // union rather than a list, so a new stamp cannot ship unexplained.
  it('names every stamp the payload can carry, attributed included', () => {
    const EVERY_STAMP: Record<ReportProvenance, string> = {
      measured: 'measured',
      attributed: 'attributed',
      customer_entered: 'your own estimate',
      derived_from_customer_input: 'your own estimate',
      assumed_same_as_with_ai: 'your own estimate',
    }
    for (const word of Object.values(EVERY_STAMP)) {
      expect(REPORT_COPY.dataLinkHover).toContain(word)
    }
    expect(REPORT_COPY.dataLinkHover).not.toContain(
      'whether we measured it or you estimated it'
    )
  })

  it('is the string the link actually hands the reader, through the record', () => {
    const index = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
    expect(index).not.toContain('title={REPORT_COPY.dataLinkHover}')
    expect(index).toContain('ROI_TOOLTIPS.getThisAsData.description')
    expect(ROI_TOOLTIPS.getThisAsData.description).toBe(
      REPORT_COPY.dataLinkHover
    )
  })
})

/**
 * The comparison is a three-column table on screen, so the
 * reader sees With AI, their own estimate and the gap between them side by
 * side instead of reading a paragraph for it.
 *
 * The Difference cell is built HERE, from the numbers the rows already carry,
 * and it is deliberately NOT a field on WithoutAiRow: the print and the JSON
 * render the row's own verdict sentence, and a field on the row would change
 * GET /api/roi/report, which must stay byte-identical.
 */
describe('comparisonDifferenceCell — the gap, in dollars and percent', () => {
  const row = (withAi: number, withoutAi: number): WithoutAiStampedRow => ({
    withAi: { value: withAi, source: 'measured' },
    withoutAi: { value: withoutAi, source: 'customer_entered' },
    difference: {
      value: Math.abs(withoutAi - withAi),
      source: 'derived_from_customer_input',
    },
    aiHigher: withAi > withoutAi,
    aboutTheSame: Math.abs(withoutAi - withAi) < 0.01,
  })

  it('says how much less, and what share of the estimate that is', () => {
    expect(comparisonDifferenceCell(row(1208, 6300))).toBe(
      `${formatCost(5092)} less (${formatPct((5092 / 6300) * 100)})`
    )
  })

  it('says how much more when AI cost more, with the same shape', () => {
    expect(comparisonDifferenceCell(row(6300, 1208))).toBe(
      `${formatCost(5092)} more (${formatPct((5092 / 1208) * 100)})`
    )
  })

  it('refuses to state a share of nothing — a zero estimate gets dollars only', () => {
    expect(comparisonDifferenceCell(row(1208, 0))).toBe(
      `${formatCost(1208)} more`
    )
  })

  it('says "About the same" under a cent, where a formatted gap means nothing', () => {
    expect(comparisonDifferenceCell(row(1208, 1208.004))).toBe(
      WITHOUT_AI_COPY.aboutTheSameCell
    )
  })

  // 99.95% of an estimate is not all of it. Rounding half-up would print
  // "100.0% less" beside a nonzero With AI column, which says the work was
  // free. The share is floored, so the page never rounds a saving up.
  it('never rounds a saving up to all of it', () => {
    expect(comparisonDifferenceCell(row(2.46, 5133.14))).toBe(
      `${formatCost(5130.68)} less (99.9%)`
    )
  })

  it('floors the share rather than rounding it', () => {
    // 4,799 of 6,000 is 79.98%: shown as 79.9%, never 80.0%.
    expect(comparisonDifferenceCell(row(1201, 6000))).toContain('(79.9%)')
  })

  it('the column header is a plain word, not a formula', () => {
    expect(WITHOUT_AI_COPY.differenceLabel).toBe('Difference')
    expect(WITHOUT_AI_COPY.aboutTheSameCell).toBe('About the same')
  })
})

/**
 * Four money tiles up front, the diagnostics behind
 * "Show every metric". The split is a list, not a slice of an array, so a
 * seventh headline metric cannot silently land in the wrong group.
 */
describe('splitHeadlineMetrics — the four the reader came for, then the rest', () => {
  const entries = HEADLINE_METRICS.map((metric) => ({ metric, value: 1 }))

  it('puts Cost, Revenue, Margin and Margin % in the money group, in that order', () => {
    expect(splitHeadlineMetrics(entries).money.map((e) => e.metric)).toEqual([
      'cost',
      'revenue',
      'margin',
      'marginPercent',
    ])
  })

  it('sends Usage events and Avg cost per usage event behind the disclosure', () => {
    expect(
      splitHeadlineMetrics(entries).behindDisclosure.map((e) => e.metric)
    ).toEqual(['eventCount', 'costPerTask'])
  })

  it('loses nothing — every headline metric lands in exactly one group', () => {
    const { money, behindDisclosure } = splitHeadlineMetrics(entries)
    expect([...money, ...behindDisclosure].map((e) => e.metric).sort()).toEqual(
      [...HEADLINE_METRICS].sort()
    )
  })

  it('keeps the order it was handed within each group', () => {
    const reversed = [...entries].reverse()
    expect(splitHeadlineMetrics(reversed).money.map((e) => e.metric)).toEqual([
      'marginPercent',
      'margin',
      'revenue',
      'cost',
    ])
  })
})

/**
 * The product rule: the table carries BOTH revenue
 * columns, Earned and Total revenue, and the reader picks which one is on
 * screen. These are the pure pieces that make the two columns come from ONE
 * revenue read: the per-agent bucketing, the cells, and the URL param.
 */
describe('the two revenue columns come from one read', () => {
  const SUBSCRIPTION_ROWS = [
    // Usage and fees, on a live agent.
    {
      agentId: 'a1',
      revenue: 900,
      usageRevenue: 400,
      eventCount: 120,
    },
    // A second subscription on the SAME agent, monthly fee only: no usage, no
    // events, real money. This is the row getAgentEarned drops.
    {
      agentId: 'a1',
      revenue: 250,
      usageRevenue: 0,
      eventCount: 0,
    },
    // An agent the customer deleted: its money belongs to the catch-all row.
    {
      agentId: 'gone',
      revenue: 60,
      usageRevenue: 10,
      eventCount: 4,
    },
  ]

  it('sums TOTAL revenue per agent, including a subscription with no events', () => {
    const byAgent = totalRevenueByAgent(SUBSCRIPTION_ROWS, new Set(['a1']))
    expect(byAgent.get('a1')).toBe(1150)
  })

  it('routes an agent with no live row into the deleted-agents catch-all', () => {
    const byAgent = totalRevenueByAgent(SUBSCRIPTION_ROWS, new Set(['a1']))
    expect(byAgent.get(null)).toBe(60)
    expect(byAgent.get('gone')).toBeUndefined()
  })

  it('keeps Earned to the usage-only rows, the way canon defines it', () => {
    expect(usageOnlyAgentRevenue(SUBSCRIPTION_ROWS)).toEqual([
      { agentId: 'a1', revenue: 400 },
      { agentId: 'gone', revenue: 10 },
    ])
  })

  it('the bucketed total equals the canon total, so the table matches the tile', () => {
    const byAgent = totalRevenueByAgent(SUBSCRIPTION_ROWS, new Set(['a1']))
    const bucketed = [...byAgent.values()].reduce(
      (sum, value) => sum + value,
      0
    )
    const canon = SUBSCRIPTION_ROWS.reduce((sum, row) => sum + row.revenue, 0)
    expect(bucketed).toBe(canon)
  })
})

/**
 * The rows the ACTION renders, not the bucketing
 * helper on its own. deleteAgent stamps the agent and leaves the subscription
 * billing, so a monthly fee can outlive the agent it bills for.
 */
describe('the rows the table renders add up to their own total', () => {
  it('keeps a deleted agent’s fee-only revenue in the table, not only in the total', () => {
    const rows = composeReportAgentRows(
      [],
      [],
      [{ agentId: 'gone', revenue: 1200, usageRevenue: 0, eventCount: 0 }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].agentId).toBeNull()
    expect(rows[0].name).toBe('Deleted agents')
    expect(rows[0].revenue).toBe(1200)
    expect(rows.reduce((sum, row) => sum + row.revenue, 0)).toBe(1200)
  })

  it('a live agent billed a monthly fee with no usage still gets a row', () => {
    const rows = composeReportAgentRows(
      [
        {
          id: 'a1',
          name: 'Contract summary',
          agentCode: 'contract',
          isActive: true,
        },
      ],
      [],
      [{ agentId: 'a1', revenue: 480, usageRevenue: 0, eventCount: 0 }]
    )
    expect(rows.map((row) => [row.agentId, row.revenue, row.earned])).toEqual([
      ['a1', 480, 0],
    ])
  })

  it('every dollar of the canon total lands on a row, live agent or not', () => {
    const bySubscription = [
      { agentId: 'a1', revenue: 900, usageRevenue: 400, eventCount: 120 },
      { agentId: 'a1', revenue: 250, usageRevenue: 0, eventCount: 0 },
      { agentId: 'gone', revenue: 1200, usageRevenue: 0, eventCount: 0 },
    ]
    const rows = composeReportAgentRows(
      [
        {
          id: 'a1',
          name: 'Contract summary',
          agentCode: 'contract',
          isActive: true,
        },
      ],
      [{ key: 'a1', cost: 300, eventCount: 120 }],
      bySubscription
    )
    const canon = bySubscription.reduce((sum, row) => sum + row.revenue, 0)
    expect(rows.reduce((sum, row) => sum + row.revenue, 0)).toBe(canon)
    expect(rows.reduce((sum, row) => sum + row.earned, 0)).toBe(400)
  })

  it('a live agent with nothing against it is still left out of the answer', () => {
    const rows = composeReportAgentRows(
      [{ id: 'quiet', name: 'Quiet', agentCode: 'quiet', isActive: true }],
      [],
      []
    )
    expect(rows).toEqual([])
  })
})

describe('the revenue the table shows is the reader’s pick', () => {
  const ROW: ReportAgentRowValues = {
    agentId: 'agent-1',
    name: 'Contract summary',
    usageEvents: 1204,
    cost: 5012.4,
    earned: 9000,
    revenue: 12000,
    marginPercent: 44.3,
  }

  it('carries both columns on every row', () => {
    const cells = reportAgentRowCells(ROW)
    expect(cells.earned).toBe(formatCost(9000))
    expect(cells.revenue).toBe(formatCost(12000))
  })

  it('defaults to Total revenue, so one screen holds one definition of revenue', () => {
    expect(DEFAULT_REVENUE_BASIS).toBe('total')
    expect(reportAgentRowCells(ROW).chosenRevenue).toBe(formatCost(12000))
    expect(reportAgentRowCells(ROW, 'earned').chosenRevenue).toBe(
      formatCost(9000)
    )
  })

  it('the Margin column follows the pick, on the same basis', () => {
    expect(reportAgentRowCells(ROW, 'total').margin).toBe(
      formatPct(((12000 - 5012.4) / 12000) * 100)
    )
    expect(reportAgentRowCells(ROW, 'earned').margin).toBe(
      formatPct(((9000 - 5012.4) / 9000) * 100)
    )
  })

  it('a basis with nothing in it renders the honest dash, never 0%', () => {
    expect(reportAgentRowCells({ ...ROW, revenue: 0 }, 'total').margin).toBe(
      '—'
    )
  })

  it('the totals row echoes both, still with no rows argument to re-sum', () => {
    expect(
      reportTotalsCells({
        usageEvents: 1204,
        cost: 5012.4,
        earned: 9000,
        revenue: 12000,
      })
    ).toEqual({
      label: REPORT_COPY.totalsRowLabel,
      usageEvents: (1204).toLocaleString(),
      cost: formatCost(5012.4),
      earned: formatCost(9000),
      revenue: formatCost(12000),
    })
    expect(reportTotalsCells.length).toBe(1)
  })

  it('the screen shows one revenue column, the print shows both', () => {
    expect(reportAgentsTableHeaders('earned')).toEqual([
      'Agent',
      'Usage events',
      'Cost',
      'Earned',
      'Margin',
    ])
    expect(reportAgentsTableHeaders('total')).toEqual([
      'Agent',
      'Usage events',
      'Cost',
      'Total revenue',
      'Margin',
    ])
    expect(REPORT_COPY.agentsTableHeaders).toEqual([
      'Agent',
      'Usage events',
      'Cost',
      'Earned',
      'Total revenue',
      'Margin',
    ])
  })

  it('reads the pick off the page link and refuses anything else', () => {
    expect(resolveRevenueBasis('earned')).toBe('earned')
    expect(resolveRevenueBasis('total')).toBe('total')
    for (const junk of [null, undefined, '', 'Earned', 'usage', 'revenue']) {
      expect(resolveRevenueBasis(junk)).toBe(DEFAULT_REVENUE_BASIS)
    }
  })

  it('the control names both choices from the one copy source', () => {
    expect(REVENUE_BASIS_OPTIONS.map((option) => option.label)).toEqual([
      'Earned',
      'Total revenue',
    ])
    expect(REVENUE_BASIS_OPTIONS.map((option) => option.id)).toEqual([
      'earned',
      'total',
    ])
  })
})
