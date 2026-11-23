/**
 * How "What you finished" is wired onto the three surfaces.
 *
 * Source-asserted where the wiring is what matters (dashboard jest is
 * node-only, no React Testing Library) and builder-asserted where a number
 * is. Each assertion pins something a later refactor could break silently:
 * the block rendering between the agents table and the metrics, the one
 * subtraction that keeps the Usage events tile and the agents column from
 * disagreeing, and the print and JSON quoting the SAME block the screen does.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  FINISHED_WORK_COPY,
  REPORT_COPY,
  buildPrintReport,
  buildRoiReportJson,
  finishedWorkSourceWord,
  finishedWorkTotalsWord,
  reportMetricTile,
  sumFinishedThings,
  surfaceFinishedWork,
  type ReportSurfaceInput,
} from '../report-derivation'
import { CCC_COMMAND_INVOCATION } from '@/lib/meter-command'

const FEATURE_DIR = join(__dirname, '..')
const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')

const reportSrc = read(FEATURE_DIR, 'components', 'roi-report.tsx')
const blockSrc = read(FEATURE_DIR, 'components', 'finished-work.tsx')
const printSrc = read(FEATURE_DIR, 'components', 'board-ready-export.tsx')
const actionSrc = read(DASHBOARD_ROOT, 'app', 'actions', 'roi-report.ts')
const withoutAiSrc = read(FEATURE_DIR, 'components', 'without-ai.tsx')

const WINDOW = { startDate: '2026-09-01', endDate: '2026-09-30' }
const RESOLVED = {
  startDate: '2026-09-01T00:00:00.000Z',
  endDate: '2026-09-30T23:59:59.999Z',
}
const AGENT = 'agent-a'

const SURFACE: ReportSurfaceInput = {
  window: WINDOW,
  resolvedPeriod: RESOLVED,
  agents: {
    rows: [
      {
        agentId: AGENT,
        name: 'Claude Code',
        usageEvents: 37,
        cost: 12,
        earned: 0,
        revenue: 0,
        marginPercent: null,
      },
    ],
    totals: { usageEvents: 37, cost: 12, earned: 0, revenue: 0 },
  },
  metrics: [
    { metric: 'cost', value: 12, unavailable: null },
    { metric: 'eventCount', value: 37, unavailable: null },
    { metric: 'costPerTask', value: 12 / 37, unavailable: null },
  ],
  assumptions: {},
  inputs: {
    unitsCompleted: null,
    measuredCount: null,
    windowIsAnchored: true,
    selectedAgentKeys: null,
  },
  finishedWork: {
    things: [
      {
        name: 'Contract summarized',
        agentId: AGENT,
        customerExternalId: 'ada@co.test',
        label: 'PROJ-123',
        howMany: 4,
        eventCount: 2,
      },
    ],
    buckets: [
      {
        customerExternalId: 'ada@co.test',
        label: 'PROJ-123',
        agentId: AGENT,
        cost: 12,
        eventCount: 37,
        eventCountWithNullCost: 0,
      },
    ],
    namedUsage: [],
    excludedFromUsageEvents: 2,
    finishedThings: 4,
  },
}

/**
 * Two names inside ONE bucket, so each row's cost is a share of the bucket and
 * `split` is true, plus an integration row stamped measured. The shape that
 * would raise both marker legends, which is why the gate reads it.
 */
const BOTH_LEGENDS: ReportSurfaceInput = {
  ...SURFACE,
  finishedWork: {
    ...SURFACE.finishedWork!,
    things: [
      {
        name: 'Contract summarized',
        agentId: AGENT,
        customerExternalId: 'ada@co.test',
        label: 'PROJ-123',
        howMany: 4,
        eventCount: 2,
      },
      {
        name: 'Draft sent',
        agentId: AGENT,
        customerExternalId: 'ada@co.test',
        label: 'PROJ-123',
        howMany: 1,
        eventCount: 1,
      },
    ],
    namedUsage: [
      {
        name: 'Invoice parsed',
        agentId: AGENT,
        howMany: 10,
        cost: 6,
        eventCount: 10,
        eventCountWithNullCost: 0,
      },
    ],
  },
}

/** Two agents in the table, one of them checked: the shape where the tiles
 *  and the comparison answer with different money. */
const SCOPED: ReportSurfaceInput = {
  ...SURFACE,
  agents: {
    ...SURFACE.agents,
    rows: [
      ...SURFACE.agents.rows,
      {
        agentId: 'agent-b',
        name: 'Quote Writer',
        usageEvents: 9,
        cost: 3,
        earned: 0,
        revenue: 0,
        marginPercent: null,
      },
    ],
  },
  inputs: { ...SURFACE.inputs, selectedAgentKeys: [AGENT] },
}

describe('the screen', () => {
  // Finished work has a tab of its own. The page surfaces the block once
  // and hands it to both readers, so the table and the count the comparison
  // takes from it can never be two different surfacings of the same window.
  it('is the Finished work tab, surfaced once by the page', () => {
    const indexSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
    const finishedPanel = indexSrc.indexOf("<TabsContent value='finished'>")
    expect(finishedPanel).toBeGreaterThan(-1)
    expect(indexSrc.indexOf('<FinishedWork')).toBeGreaterThan(finishedPanel)
    expect(indexSrc.match(/surfaceFinishedWork\(/g)).toHaveLength(1)
    expect(reportSrc).not.toMatch(/surfaceFinishedWork\(/)
    expect(reportSrc).toMatch(/finishedWork: FinishedWorkBlock \| null/)
  })

  it('formats nothing itself: every cell comes from the builder', () => {
    expect(blockSrc).not.toMatch(/formatCost|toLocaleString|toFixed/)
  })

  // Unchecking every agent must not tell a customer with recorded things
  // that nothing was recorded and their meter needs connecting.
  it('takes the empty title from the builder and closes the wrong door', () => {
    expect(blockSrc).toMatch(/title=\{block\.title\}/)
    expect(blockSrc).not.toMatch(/FINISHED_WORK_COPY\.emptyTitle/)
    expect(blockSrc).toMatch(/block\.reason === 'no-agents'/)
    const action = blockSrc.slice(
      blockSrc.indexOf("block.reason === 'no-agents'"),
      blockSrc.indexOf(
        'variant=',
        blockSrc.indexOf("block.reason === 'no-agents'")
      )
    )
    expect(action).toMatch(/\?\s*undefined/)
    expect(action).toContain('GETTING_STARTED_HREF')
  })

  // Two numbers for the same word on one screen (the Cost tile and a
  // narrower comparison) need a visible line saying why they differ.
  it('reconciles the tiles with the comparison when the check marks narrow it', () => {
    expect(reportSrc).toMatch(/REPORT_COPY\.everyAgentTilesNote/)
    expect(reportSrc).toMatch(/tilesCountMoreAgents/)
    expect(REPORT_COPY.everyAgentTilesNote).toContain('count every agent')
    expect(REPORT_COPY.everyAgentTilesNote).toContain('Finished work tab')
    // Same contrast as the numbers it qualifies, not the dimmer note class.
    const line = reportSrc.slice(
      reportSrc.indexOf('tilesCountMoreAgents &&'),
      reportSrc.indexOf('everyAgentTilesNote}</p>')
    )
    expect(line).toContain('className={HONESTY}')
  })

  // The print leaves the building and gets quoted, so it must explain the
  // two Cost numbers the same way the screen does.
  it('reconciles the same two numbers on paper', () => {
    const print = buildPrintReport(SCOPED)
    expect(print.everyAgentTilesNote).toBe(REPORT_COPY.everyAgentTilesNote)
    expect(buildPrintReport(SURFACE).everyAgentTilesNote).toBeNull()
    const metrics = printSrc.indexOf('{report.metricsHeading}')
    const note = printSrc.indexOf('report.everyAgentTilesNote')
    expect(note).toBeGreaterThan(metrics)
  })

  it('says on the tiles themselves that the check marks never touch them', () => {
    for (const metric of ['cost', 'eventCount', 'costPerTask'] as const) {
      const tile = reportMetricTile({ metric, value: 1, unavailable: null })
      expect(tile.tooltip.details).toBe('Every agent, checked or not.')
    }
  })

  // The print and the JSON inherit the clause through the one builder, so a
  // board deck cannot quote a re-scoped table as the whole story.
  it('carries the scope clause onto paper and into the payload', () => {
    const scoped = {
      ...SURFACE,
      agents: {
        ...SURFACE.agents,
        rows: [
          ...SURFACE.agents.rows,
          {
            agentId: 'agent-b',
            name: 'Quote Writer',
            usageEvents: 9,
            cost: 3,
            earned: 0,
            revenue: 0,
            marginPercent: null,
          },
        ],
        agentCount: 2,
      },
      inputs: { ...SURFACE.inputs, selectedAgentKeys: [AGENT] },
    }
    const block = surfaceFinishedWork(scoped)
    if (block?.kind !== 'rows') throw new Error('rows')
    expect(block.lead).toContain('Counting 1 of 2 agents.')
    const print = buildPrintReport(scoped).finishedWork
    if (print?.kind !== 'rows') throw new Error('rows')
    expect(print.lead).toBe(block.lead)
  })

  it('shows no agents and still says the meter is fine, on screen and on paper', () => {
    const noAgents = {
      ...SURFACE,
      inputs: { ...SURFACE.inputs, selectedAgentKeys: [] },
    }
    const block = surfaceFinishedWork(noAgents)
    expect(block?.kind).toBe('empty')
    if (block?.kind !== 'empty') return
    expect(block.reason).toBe('no-agents')
    expect(block.body).toBe(FINISHED_WORK_COPY.emptyNoAgents)
    expect(buildPrintReport(noAgents).finishedWork).toEqual(block)
  })

  it('reads the Without AI count from the same block it renders', () => {
    expect(reportSrc).toMatch(/finishedWorkMeasuredCount\(finishedWork\)/)
  })

  it('tells the Usage events tile what it left out', () => {
    expect(reportSrc).toMatch(/finishedThings=\{/)
  })

  // A word per costed row instead of a * and a +, read off the row's own
  // stamp, and no marker legends.
  it('carries the word from the stamp, not a mark, and drops the legends', () => {
    expect(blockSrc).toMatch(/finishedWorkSourceWord\(row\)/)
    expect(blockSrc).toMatch(/FINISHED_WORK_COPY\.sourceWords\[word\]/)
    expect(blockSrc).not.toMatch(/integrationMarker|splitMarker/)
    expect(blockSrc).not.toMatch(/honesty\.integrationLegend/)
    expect(blockSrc).not.toMatch(/honesty\.splitLegend/)
  })

  // The standing paragraph is the only place that says the cost column
  // understates work that began before these dates, so it must reach the
  // screen as well as paper and the JSON.
  it('renders the standing paragraph, at the contrast of the numbers it describes', () => {
    expect(blockSrc).toMatch(/block\.honesty\.attribution/)
    expect(blockSrc).toMatch(/const HONESTY = 'text-\[11\.5px\] text-mf-tx2'/)
    expect(blockSrc).toMatch(
      /className=\{HONESTY\}>\{block\.honesty\.attribution\}/
    )
    // Above moreNames: it is a claim about the whole column, not a footnote.
    expect(blockSrc.indexOf('block.honesty.attribution')).toBeLessThan(
      blockSrc.indexOf('block.honesty.moreNames')
    )
    expect(FINISHED_WORK_COPY.attribution).toContain(
      'Cost is counted only inside these dates'
    )
  })

  it("the word on a row is the row's own stamp, for every shape of row", () => {
    const block = surfaceFinishedWork(SURFACE)
    if (block === null || block.kind !== 'rows') {
      throw new Error('expected rows')
    }
    for (const row of block.rows) {
      const word = finishedWorkSourceWord(row)
      if (row.numbers.aiCost === null) {
        expect(word).toBeNull()
        continue
      }
      if (row.numbers.aiCost.source === 'measured') {
        expect(word).toBe('measured')
      } else {
        expect(word).toBe(row.split ? 'attributedShared' : 'attributed')
      }
      expect(FINISHED_WORK_COPY.sourceWords[word!]).toBe(
        {
          measured: 'Measured',
          attributed: 'Attributed',
          attributedShared: 'Attributed, shared',
        }[word!]
      )
    }
  })

  it('a row with no cost keeps its dash and gets no word', () => {
    expect(
      finishedWorkSourceWord({
        split: false,
        numbers: {
          howMany: { value: 2, source: 'measured' },
          aiCost: null,
          costForOne: null,
        },
      })
    ).toBeNull()
  })

  it('says on screen how many names it did not list', () => {
    expect(blockSrc).toMatch(/honesty\.moreNames/)
  })
})

describe('the count field in the Without AI block', () => {
  // Pre-filled with the meter's number and editable, so a
  // customer who finished more than the meter saw can say so. Saving the
  // number already on screen must NOT restamp it as theirs, which is why the
  // link only takes a count that differs.
  it('pre-fills with the meter count and stays editable', () => {
    expect(withoutAiSrc).not.toMatch(/disabled=\{meterCounted\}/)
    expect(withoutAiSrc).toMatch(
      /inputs\.unitsCompleted \?\? inputs\.measuredCount \?\? ''/
    )
    expect(withoutAiSrc).toMatch(
      /windowFields\.values\.unitsCompleted === inputs\.measuredCount/
    )
  })

  it('names what the meter counted rather than only that it counted', () => {
    expect(withoutAiSrc).toMatch(
      /countMeasuredNote\(\s*nouns\.plural,\s*measuredThings/
    )
    expect(reportSrc).toMatch(/measuredThings=\{/)
  })

  it('reads the names off the same block the table renders', () => {
    expect(reportSrc).toMatch(/finishedWorkRecordedThings\(finishedWork\)/)
  })
})

describe('the Usage events tile', () => {
  it('says what it left out, in the tile itself', () => {
    const tile = reportMetricTile(
      { metric: 'eventCount', value: 37, unavailable: null },
      { finishedThings: 2 }
    )
    expect(tile.notes).toContain(FINISHED_WORK_COPY.usageEventsTileLine(2))
  })

  it('stays quiet when nothing was left out', () => {
    const tile = reportMetricTile(
      { metric: 'eventCount', value: 37, unavailable: null },
      { finishedThings: 0 }
    )
    expect(tile.notes).toHaveLength(0)
  })

  it('says it about Usage events and no other tile', () => {
    const tile = reportMetricTile(
      { metric: 'cost', value: 12, unavailable: null },
      { finishedThings: 2 }
    )
    expect(tile.notes).toHaveLength(0)
  })
})

describe('the one subtraction, in the action', () => {
  it('takes finished things out of the totals the tile and the divisor read', () => {
    expect(actionSrc).toContain(
      'costBreakdown.totals.eventCount - finishedWorkCount'
    )
  })

  it('takes them out of the per-agent column too, so the table total matches', () => {
    expect(actionSrc).toMatch(
      /eventCount: row\.eventCount - \(row\.eventCountFinishedWork \?\? 0\)/
    )
    expect(actionSrc).toMatch(
      /composeReportAgentRows\(\s*agents,\s*usageEventRows,/
    )
  })

  it('asks for the finished-work lists in the SAME read as the Cost tile', () => {
    const start = actionSrc.indexOf('getCostBreakdown(')
    const end = actionSrc.indexOf('getRevenueMetrics(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(actionSrc.slice(start, end)).toContain(
      'finishedWork: { agentIds: null }'
    )
  })

  it('never re-reads cost for this block', () => {
    const calls = actionSrc.match(/getCostBreakdown\(/g) ?? []
    expect(calls).toHaveLength(1)
  })
})

describe('the print', () => {
  it('carries the block after the agents table', () => {
    const block = printSrc.indexOf('report.finishedWork')
    const agentsTable = printSrc.indexOf('report.usageEventDefinition')
    const metrics = printSrc.indexOf('report.metricsHeading')
    expect(block).toBeGreaterThan(agentsTable)
    expect(block).toBeLessThan(metrics)
  })

  it('quotes the same rows and the same sentence the screen shows', () => {
    const print = buildPrintReport(SURFACE)
    expect(print.finishedWork?.kind).toBe('rows')
    if (print.finishedWork?.kind !== 'rows') return
    expect(print.finishedWork.rows[0].name).toBe('Contract summarized')
    expect(print.finishedWork.rows[0].howMany).toBe('4')
    expect(print.finishedWork.honesty.attribution).toBe(
      FINISHED_WORK_COPY.attribution
    )
  })

  it('carries the current proxy-gap honesty sentence', () => {
    const print = buildPrintReport(SURFACE)
    expect(print.proxyGap).toBe(REPORT_COPY.proxyGap)
    expect(print.proxyGap).toContain(`${CCC_COMMAND_INVOCATION} done`)
  })

  it('leaves the block out when the read did not ask for it', () => {
    const print = buildPrintReport({ ...SURFACE, finishedWork: null })
    expect(print.finishedWork).toBeNull()
  })

  // One vocabulary on screen and on paper. The print keeps the standing
  // paragraph, because nobody can hover a sheet of paper, and carries one
  // legend that explains the words it prints.
  it('prints the same words the screen shows, with a legend for them', () => {
    expect(printSrc).toMatch(/finishedWorkSourceWord\(row\)/)
    expect(printSrc).toMatch(/FINISHED_WORK_COPY\.sourceWords\[/)
    expect(printSrc).not.toMatch(/integrationMarker|splitMarker/)
    expect(printSrc).toMatch(/FINISHED_WORK_COPY\.sourceWordLegend/)
    expect(printSrc).not.toMatch(/honesty\.integrationLegend/)
    expect(printSrc).not.toMatch(/honesty\.splitLegend/)
    expect(printSrc).toMatch(/honesty\.moreNames/)
    for (const word of Object.values(FINISHED_WORK_COPY.sourceWords)) {
      expect(FINISHED_WORK_COPY.sourceWordLegend).toContain(word.split(',')[0])
    }
  })

  // The payload must not hand a customer a key to a star and a plus sign
  // that appear nowhere in it and on neither surface. BOTH_LEGENDS is the shape
  // that RAISED both, so a null here would have passed whatever the constants
  // said. The row's own `split` and `source` carry those two facts instead.
  it('publishes no legend for a mark that appears nowhere in the payload', () => {
    const json = buildRoiReportJson(BOTH_LEGENDS)
    const honesty = json.whatYouFinished!.honesty
    expect(Object.keys(honesty).sort()).toEqual([
      'attribution',
      'moreNames',
      'unattributed',
      'unpriced',
    ])
    expect(JSON.stringify(json)).not.toContain('A star means')
    expect(JSON.stringify(json)).not.toContain('A plus sign means')
    const rows = json.whatYouFinished!.rows
    expect(rows.some((row) => row.split)).toBe(true)
    expect(rows.some((row) => row.source === 'integration')).toBe(true)
  })
})

/** The Without AI count is pre-filled from this block, and a typed count wins. */
describe('what the pre-filled count is allowed to read', () => {
  const INTEGRATION_ONLY: ReportSurfaceInput = {
    ...SURFACE,
    assumptions: { method: 'perItem' as const, costPerItem: 40 },
    inputs: { ...SURFACE.inputs, unitsCompleted: 12 },
    finishedWork: {
      things: [],
      buckets: [],
      namedUsage: [
        {
          name: 'Invoice parsed',
          agentId: AGENT,
          howMany: 10_000,
          cost: 6,
          eventCount: 10_000,
          eventCountWithNullCost: 0,
        },
      ],
      excludedFromUsageEvents: 0,
      finishedThings: 0,
    },
  }

  it('shows the integration row but does not force-fill the count', () => {
    const json = buildRoiReportJson(INTEGRATION_ONLY)
    expect(json.whatYouFinished!.rows[0].source).toBe('integration')
    expect(json.withoutAi?.numbers.unitsCompleted).toEqual({
      value: 12,
      source: 'customer_entered',
    })
    // The word beside that row is still Measured: its cost IS the money.
    const block = surfaceFinishedWork(INTEGRATION_ONLY)
    if (block === null || block.kind !== 'rows') throw new Error('rows')
    expect(finishedWorkSourceWord(block.rows[0])).toBe('measured')
  })

  it('keeps the print and the screen on that same count', () => {
    const print = buildPrintReport(INTEGRATION_ONLY)
    const json = buildRoiReportJson(INTEGRATION_ONLY)
    expect(print.withoutAi?.paragraph).toBe(json.withoutAi?.paragraph)
  })
})

describe('the JSON', () => {
  const json = buildRoiReportJson(SURFACE)

  it('publishes the table under its own key, with a stamp on every number', () => {
    expect(json.whatYouFinished).not.toBeNull()
    const row = json.whatYouFinished!.rows[0]
    expect(row).toEqual({
      name: 'Contract summarized',
      source: 'recorded',
      howMany: { value: 4, source: 'measured' },
      aiCost: { value: 12, source: 'attributed' },
      costForOne: { value: 3, source: 'attributed' },
      split: false,
    })
  })

  it('publishes the records it subtracted AND the things they carried', () => {
    // One field for both would make the tile say 3 while the table under
    // it says 5. The tile subtracts RECORDS; the sentence counts THINGS.
    expect(json.whatYouUsedAiFor.totals.finishedRecordsExcluded).toEqual({
      value: 2,
      source: 'measured',
    })
    expect(json.whatYouUsedAiFor.totals.finishedThings).toEqual({
      value: 4,
      source: 'measured',
    })
    expect(json.whatYouFinished!.totals.howMany.value).toBe(
      json.whatYouUsedAiFor.totals.finishedThings.value
    )
  })

  it('carries the standing sentence so a quoted figure cannot lose it', () => {
    expect(json.whatYouFinished!.honesty.attribution).toBe(
      FINISHED_WORK_COPY.attribution
    )
  })

  it('publishes the proxy-gap honesty sentence', () => {
    expect(json.honesty.proxyGap).toBe(REPORT_COPY.proxyGap)
  })

  it('is null, not an empty table, when the read did not ask', () => {
    expect(
      buildRoiReportJson({ ...SURFACE, finishedWork: null }).whatYouFinished
    ).toBeNull()
  })

  it('lets a typed count beat the meter on every surface at once', () => {
    const typed = {
      ...SURFACE,
      assumptions: { method: 'perItem' as const, costPerItem: 100 },
      inputs: { ...SURFACE.inputs, unitsCompleted: 57 },
    }
    const withoutAi = buildRoiReportJson(typed).withoutAi
    expect(withoutAi?.numbers.unitsCompleted).toEqual({
      value: 57,
      source: 'customer_entered',
    })
    const print = buildPrintReport(typed)
    expect(print.withoutAi?.paragraph).toBe(withoutAi?.paragraph)
  })

  it("falls back to the meter's count, stamped measured, with nothing typed", () => {
    const untouched = {
      ...SURFACE,
      assumptions: { method: 'perItem' as const, costPerItem: 100 },
    }
    expect(
      buildRoiReportJson(untouched).withoutAi?.numbers.unitsCompleted
    ).toEqual({ value: 4, source: 'measured' })
  })
})

/** One quantity gets one number, the page names a command that exists, and
 *  the print keeps the line that makes its biggest number reproducible. */
describe('the tile sentence counts THINGS, while the tile subtracts RECORDS', () => {
  it('says 2 for one record of two, and the tile still drops by one', () => {
    // `done "contract summarized" 2` is ONE usage record carrying TWO finished
    // things. The tile's own number is right to drop by one; the sentence
    // beside it has to say two, or it disagrees with the table it points at.
    const oneRecordOfTwo: ReportSurfaceInput = {
      ...SURFACE,
      metrics: [{ metric: 'eventCount', value: 17, unavailable: null }],
      finishedWork: {
        things: [
          {
            name: 'Contract summarized',
            agentId: AGENT,
            customerExternalId: 'ada@co.test',
            label: 'PROJ-123',
            howMany: 2,
            eventCount: 1,
          },
        ],
        buckets: SURFACE.finishedWork!.buckets,
        namedUsage: [],
        excludedFromUsageEvents: 1,
        finishedThings: 2,
      },
    }
    const json = buildRoiReportJson(oneRecordOfTwo)
    expect(json.whatYouUsedAiFor.totals.finishedRecordsExcluded.value).toBe(1)
    expect(json.whatYouUsedAiFor.totals.finishedThings.value).toBe(2)
    expect(json.whatYouFinished!.totals.howMany.value).toBe(2)

    const tile = reportMetricTile(
      { metric: 'eventCount', value: 17, unavailable: null },
      { finishedThings: 2 }
    )
    expect(tile.notes).toContain(FINISHED_WORK_COPY.usageEventsTileLine(2))
    expect(tile.notes.join(' ')).not.toContain('1 finished thing')

    // The print quotes the same builder, so it cannot say a third thing.
    const print = buildPrintReport(oneRecordOfTwo)
    expect(
      print.metrics.find((entry) => entry.key === 'eventCount')?.notes
    ).toContain(FINISHED_WORK_COPY.usageEventsTileLine(2))
  })

  it('sums quantity in the action rather than counting rows', () => {
    expect(actionSrc).toMatch(/sumFinishedThings\(/)
    expect(sumFinishedThings([{ howMany: 2 }, { howMany: 3 }])).toBe(5)
  })
})

describe('the command the page tells a customer to type', () => {
  // The package's only bin is `code-cost-clarity`.
  const meterSrc = read(
    DASHBOARD_ROOT,
    '..',
    '..',
    'packages',
    'code-cost-clarity',
    'src',
    'connector.ts'
  )

  it('is the invocation the meter itself answers to', () => {
    const meterInvocation = /CCC_COMMAND_INVOCATION = "([^"]+)"/.exec(
      meterSrc
    )?.[1]
    expect(meterInvocation).toBe(CCC_COMMAND_INVOCATION)
  })

  it('is spelled the same way in all three places the page names it', () => {
    for (const line of [
      REPORT_COPY.proxyGap,
      FINISHED_WORK_COPY.empty,
      FINISHED_WORK_COPY.attribution,
    ]) {
      expect(line).toContain(CCC_COMMAND_INVOCATION)
    }
  })
})

/**
 * The Everything row is the number most likely to be lifted into a board deck,
 * and it is the least certain one in the table: it sums measured integration
 * money and attributed shares together. Every other costed number on this tab
 * says where it came from, so this one does too, on screen and on paper.
 */
describe('the totals row says where its money came from', () => {
  const wordFor = (input: ReportSurfaceInput) => {
    const block = surfaceFinishedWork(input)
    if (block === null || block.kind !== 'rows') throw new Error('rows')
    return finishedWorkTotalsWord(block.totals)
  }

  const INTEGRATION_ONLY_TOTALS: ReportSurfaceInput = {
    ...SURFACE,
    finishedWork: {
      ...SURFACE.finishedWork!,
      things: [],
      buckets: [],
      namedUsage: [
        {
          name: 'Invoice parsed',
          agentId: AGENT,
          howMany: 10,
          cost: 6,
          eventCount: 10,
          eventCountWithNullCost: 0,
        },
      ],
    },
  }

  const NOTHING_COSTED: ReportSurfaceInput = {
    ...SURFACE,
    finishedWork: { ...SURFACE.finishedWork!, buckets: [], namedUsage: [] },
  }

  it('reads measured when every costed row was priced from its own events', () => {
    expect(wordFor(INTEGRATION_ONLY_TOTALS)).toBe('measured')
  })

  it('reads attributed the moment a share is mixed in', () => {
    // BOTH_LEGENDS is integration money plus two attributed rows.
    expect(wordFor(BOTH_LEGENDS)).toBe('attributed')
    expect(wordFor(SURFACE)).toBe('attributed')
  })

  it('says nothing at all when there is no total to describe', () => {
    expect(wordFor(NOTHING_COSTED)).toBeNull()
  })

  it('reads the SAME stamp GET /api/roi/report publishes', () => {
    const json = buildRoiReportJson(BOTH_LEGENDS)
    expect(json.whatYouFinished!.totals.aiCost!.source).toBe('attributed')
    expect(FINISHED_WORK_COPY.sourceWords[wordFor(BOTH_LEGENDS)!]).toBe(
      'Attributed'
    )
  })

  it('renders beside the total on screen, not only beside the rows', () => {
    expect(blockSrc).toMatch(/<TotalsWord totals=\{block\.totals\}/)
    expect(blockSrc).toMatch(/finishedWorkTotalsWord\(totals\)/)
  })

  it('prints the word too, with the sentence that owns the blend', () => {
    expect(printSrc).toMatch(
      /finishedWorkTotalsWord\(\s*report\.finishedWork\.totals/
    )
    expect(printSrc).toMatch(/FINISHED_WORK_COPY\.totalsWordLegend/)
    expect(FINISHED_WORK_COPY.totalsWordLegend).toContain(
      FINISHED_WORK_COPY.totalsRowLabel
    )
  })
})

describe('the board-ready print', () => {
  it('is titled for what page one leads with', () => {
    expect(printSrc).toContain('>ROI report</h1>')
    expect(printSrc).not.toContain('>ROI goals</h1>')
  })

  it('carries every honesty note the screen carries under a tile', () => {
    // The print is the one document read with nobody present to explain it.
    expect(printSrc).toMatch(/tile\.notes\.map/)
  })

  it('renders the standing sentence only when the block still carries one', () => {
    expect(printSrc).toMatch(/report\.finishedWork\.honesty\.attribution && \(/)
  })
})
