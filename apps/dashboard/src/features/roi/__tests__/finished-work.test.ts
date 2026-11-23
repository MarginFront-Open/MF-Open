/**
 * "What you finished": the attribution math and the words.
 *
 * The page makes ONE claim that is not measured, and this file is where that
 * claim is kept honest. A cost cell here is a split of money we did measure,
 * never a per-item price we recorded, so every arithmetic property that makes
 * the split defensible is pinned: shares inside a bucket sum to one, the sum
 * of the column never exceeds the Cost tile above it, and a bucket we cannot
 * tie to any spend renders a dash rather than a $0 or a slice of the org.
 */

import {
  FINISHED_WORK_COPY,
  REPORT_COPY,
  WITHOUT_AI_COPY,
  FINISHED_WORK_MAX_ROWS,
  attributeFinishedWork,
  buildFinishedWork,
  finishedWorkMeasuredCount,
  finishedWorkNames,
  finishedWorkRecordedThings,
  finishedWorkSourceWord,
  type FinishedWorkInput,
} from '../report-derivation'
import { CCC_COMMAND_INVOCATION } from '@/lib/meter-command'
import { WORK_ITEM_NOUN, WORK_ITEM_NOUN_PLURAL } from '@/lib/work-item-noun'
import { formatCost } from '@/lib/canon-format'

const WINDOW = { startDate: '2026-09-01', endDate: '2026-09-30' }
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

const thing = (over: Partial<FinishedWorkInput['things'][number]> = {}) => ({
  name: 'Contract summarized',
  agentId: AGENT_A,
  customerExternalId: 'ada@co.test',
  label: 'PROJ-123',
  howMany: 1,
  eventCount: 1,
  ...over,
})

const bucket = (over: Partial<FinishedWorkInput['buckets'][number]> = {}) => ({
  customerExternalId: 'ada@co.test',
  label: 'PROJ-123',
  agentId: AGENT_A,
  cost: 12,
  eventCount: 4,
  eventCountWithNullCost: 0,
  ...over,
})

const input = (over: Partial<FinishedWorkInput> = {}): FinishedWorkInput => ({
  window: WINDOW,
  things: [thing()],
  buckets: [bucket()],
  namedUsage: [],
  agentScope: null,
  ...over,
})

const rowsOf = (block: ReturnType<typeof buildFinishedWork>) => {
  if (block.kind !== 'rows') throw new Error(`expected rows, got ${block.kind}`)
  return block
}

describe('attributeFinishedWork — the split', () => {
  it('gives one thing in a bucket the whole bucket', () => {
    const [row] = attributeFinishedWork([thing()], [bucket()], null)
    expect(row.aiCost).toBe(12)
    expect(row.split).toBe(false)
  })

  it('splits by count, and the shares inside a bucket sum to one', () => {
    const things = [
      thing({ name: 'Contract summarized', howMany: 3 }),
      thing({ name: 'Contract drafted', howMany: 1 }),
    ]
    const attributed = attributeFinishedWork(
      things,
      [bucket({ cost: 12 })],
      null
    )
    expect(attributed.map((row) => row.aiCost)).toEqual([9, 3])
    expect(attributed.reduce((sum, row) => sum + (row.aiCost ?? 0), 0)).toBe(12)
  })

  it('flags a row whose bucket held more than that row, so the cell can say so', () => {
    const things = [
      thing({ name: 'Contract summarized', howMany: 3 }),
      thing({ name: 'Contract drafted', howMany: 1 }),
    ]
    const attributed = attributeFinishedWork(things, [bucket()], null)
    expect(attributed.every((row) => row.split)).toBe(true)
  })

  it('divides money that does not divide evenly without losing a cent', () => {
    const things = [
      thing({ name: 'a', howMany: 1 }),
      thing({ name: 'b', howMany: 1 }),
      thing({ name: 'c', howMany: 1 }),
    ]
    const attributed = attributeFinishedWork(
      things,
      [bucket({ cost: 10 })],
      null
    )
    const total = attributed.reduce((sum, row) => sum + (row.aiCost ?? 0), 0)
    expect(total).toBeCloseTo(10, 10)
  })

  it('renders a dash, never a $0, when the bucket has no cost records', () => {
    const [row] = attributeFinishedWork(
      [thing({ label: 'PROJ-202' })],
      [bucket({ label: 'PROJ-202', cost: 0, eventCount: 0 })],
      null
    )
    expect(row.aiCost).toBeNull()
  })

  it('renders a dash when no bucket answers for the thing at all', () => {
    const [row] = attributeFinishedWork([thing()], [], null)
    expect(row.aiCost).toBeNull()
  })

  it('keeps a real $0 bucket as $0: measured zero is not missing', () => {
    const [row] = attributeFinishedWork(
      [thing()],
      [bucket({ cost: 0, eventCount: 3 })],
      null
    )
    expect(row.aiCost).toBe(0)
  })

  it('never lets the column exceed the money it was split from', () => {
    const things = [
      thing({ howMany: 2 }),
      thing({ name: 'Other', howMany: 5 }),
      thing({ name: 'Third', label: '', howMany: 1 }),
    ]
    const buckets = [
      bucket({ cost: 12 }),
      bucket({ label: '', cost: 5, eventCount: 2 }),
    ]
    const attributed = attributeFinishedWork(things, buckets, null)
    const total = attributed.reduce((sum, row) => sum + (row.aiCost ?? 0), 0)
    expect(total).toBeLessThanOrEqual(17)
  })

  it('scopes to the checked agents, things and buckets together', () => {
    const things = [
      thing(),
      thing({ name: 'Elsewhere', agentId: AGENT_B, label: 'PROJ-999' }),
    ]
    const buckets = [
      bucket(),
      bucket({ agentId: AGENT_B, label: 'PROJ-999', cost: 99 }),
    ]
    const attributed = attributeFinishedWork(
      things,
      buckets,
      new Set([AGENT_A])
    )
    expect(attributed).toHaveLength(1)
    expect(attributed[0].aiCost).toBe(12)
  })

  // Keying the bucket by agent too strands the spend of whichever
  // assistant did not run `code-cost-clarity done`, printing a cost per thing
  // that reads low.
  it('covers both assistants a person used on one work item, not only the one that recorded it', () => {
    // Ada works one item with Claude Code ($10) and Codex ($6), then records
    // two finished contracts from Claude Code only.
    const things = [thing({ howMany: 2, agentId: AGENT_A })]
    const buckets = [
      bucket({ agentId: AGENT_A, cost: 10, eventCount: 20 }),
      bucket({ agentId: AGENT_B, cost: 6, eventCount: 12 }),
    ]
    const [row] = attributeFinishedWork(things, buckets, null)
    expect(row.aiCost).toBe(16)
  })

  it('still drops an unchecked assistant from the split, because the agent is a filter', () => {
    const things = [thing({ howMany: 2, agentId: AGENT_A })]
    const buckets = [
      bucket({ agentId: AGENT_A, cost: 10, eventCount: 20 }),
      bucket({ agentId: AGENT_B, cost: 6, eventCount: 12 }),
    ]
    const [row] = attributeFinishedWork(things, buckets, new Set([AGENT_A]))
    expect(row.aiCost).toBe(10)
  })

  it('adds up the unpriced events behind every slice of one bucket', () => {
    const things = [thing({ howMany: 1 })]
    const buckets = [
      bucket({ agentId: AGENT_A, eventCountWithNullCost: 2 }),
      bucket({
        agentId: AGENT_B,
        cost: 5,
        eventCount: 3,
        eventCountWithNullCost: 1,
      }),
    ]
    const [row] = attributeFinishedWork(things, buckets, null)
    expect(row.unpricedEvents).toBe(3)
  })
})

describe('buildFinishedWork — the block', () => {
  it('says nothing has been recorded rather than showing an empty table', () => {
    const block = buildFinishedWork(input({ things: [], buckets: [] }))
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.reason).toBe('no-activity')
    expect(block.title).toBe(FINISHED_WORK_COPY.emptyTitle)
    expect(block.body).toBe(FINISHED_WORK_COPY.empty)
    expect(block.body).toContain(`${CCC_COMMAND_INVOCATION} done`)
    expect(block.body).not.toContain('ccc done')
  })

  // An org with recorded things and a working meter must not be told
  // otherwise because every box is unchecked.
  it('blames the check marks, not the meter, when the scope emptied the table', () => {
    const block = buildFinishedWork(
      input({ agentScope: { checkedAgentKeys: new Set(), agentsInTable: 2 } })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.reason).toBe('no-agents')
    expect(block.title).toBe(FINISHED_WORK_COPY.emptyNoAgentsTitle)
    expect(block.body).toBe(FINISHED_WORK_COPY.emptyNoAgents)
    expect(block.body).toContain(
      'What you used AI for table on the Summary tab'
    )
    expect(block.body).not.toContain(CCC_COMMAND_INVOCATION)
    expect(block.body).not.toContain(FINISHED_WORK_COPY.emptyButton)
  })

  // When the window itself is empty, checking more agents would not fill the
  // table, so the block keeps pointing at Getting Started.
  it('keeps the Getting Started door when the window itself is empty', () => {
    const block = buildFinishedWork(
      input({
        things: [],
        buckets: [],
        namedUsage: [],
        agentScope: { checkedAgentKeys: new Set([AGENT_A]), agentsInTable: 2 },
      })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.reason).toBe('no-activity')
    expect(block.title).toBe(FINISHED_WORK_COPY.emptyTitle)
    expect(block.body).toBe(FINISHED_WORK_COPY.empty)
  })

  it('keeps blaming the check marks when a partial scope came up empty', () => {
    const block = buildFinishedWork(
      input({
        things: [thing({ agentId: AGENT_B })],
        agentScope: { checkedAgentKeys: new Set([AGENT_A]), agentsInTable: 2 },
      })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.reason).toBe('no-agents')
  })

  it('folds a case twin into one row and keeps the casing that came first', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [
            thing({ name: 'Contract summarized', howMany: 1 }),
            thing({ name: '  contract SUMMARIZED ', howMany: 3 }),
          ],
        })
      )
    )
    expect(block.rows).toHaveLength(1)
    expect(block.rows[0].name).toBe('Contract summarized')
    expect(block.rows[0].numbers.howMany.value).toBe(4)
  })

  it('stamps the count measured and the cost attributed', () => {
    const block = rowsOf(buildFinishedWork(input()))
    expect(block.rows[0].numbers.howMany.source).toBe('measured')
    expect(block.rows[0].numbers.aiCost?.source).toBe('attributed')
    expect(block.rows[0].numbers.costForOne?.source).toBe('attributed')
  })

  it('computes cost for one from the attributed cost and the count', () => {
    const block = rowsOf(
      buildFinishedWork(input({ things: [thing({ howMany: 4 })] }))
    )
    expect(block.rows[0].numbers.costForOne?.value).toBe(3)
    expect(block.rows[0].costForOne).toBe(formatCost(3))
  })

  it('shows a dash in both money cells when nothing can be attributed', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [thing({ label: 'PROJ-202' })],
          buckets: [bucket({ label: 'PROJ-202', cost: 0, eventCount: 0 })],
        })
      )
    )
    expect(block.rows[0].aiCost).toBe('—')
    expect(block.rows[0].costForOne).toBe('—')
    expect(block.rows[0].numbers.aiCost).toBeNull()
  })

  it('counts the things it could not attribute, out loud', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [thing(), thing({ name: 'Release cut', label: 'PROJ-202' })],
          buckets: [
            bucket(),
            bucket({ label: 'PROJ-202', cost: 0, eventCount: 0 }),
          ],
        })
      )
    )
    expect(block.honesty.unattributed).toBe(FINISHED_WORK_COPY.unattributed(1))
  })

  it('says nothing about unattributed things when every one is attributed', () => {
    const block = rowsOf(buildFinishedWork(input()))
    expect(block.honesty.unattributed).toBeNull()
  })

  it('warns when the spend behind the split is not fully priced', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({ buckets: [bucket({ eventCountWithNullCost: 2 })] })
      )
    )
    expect(block.honesty.unpriced).toBe(FINISHED_WORK_COPY.unpriced(2))
  })

  it('carries the standing sentence on every rendered block', () => {
    const block = rowsOf(buildFinishedWork(input()))
    expect(block.honesty.attribution).toBe(FINISHED_WORK_COPY.attribution)
    expect(FINISHED_WORK_COPY.attribution).toContain(WORK_ITEM_NOUN)
    expect(FINISHED_WORK_COPY.attribution).toContain(
      `${CCC_COMMAND_INVOCATION} work`
    )
    expect(FINISHED_WORK_COPY.attribution).not.toContain('ccc work')
  })

  it('lists a named integration signal beside the recorded things', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          namedUsage: [
            {
              name: 'Invoice parsed',
              agentId: AGENT_B,
              howMany: 10,
              cost: 6,
              eventCount: 2,
              eventCountWithNullCost: 0,
            },
          ],
        })
      )
    )
    const named = block.rows.find((row) => row.source === 'integration')
    expect(named).toBeDefined()
    expect(named!.numbers.howMany).toEqual({ value: 10, source: 'measured' })
    expect(named!.numbers.aiCost).toEqual({ value: 6, source: 'measured' })
    expect(named!.numbers.costForOne).toEqual({
      value: 0.6,
      source: 'measured',
    })
    expect(named!.split).toBe(false)
  })

  it('folds case twins in the named rows too, and sums them', () => {
    const named = (name: string, howMany: number, cost: number) => ({
      name,
      agentId: AGENT_B,
      howMany,
      cost,
      eventCount: 1,
      eventCountWithNullCost: 0,
    })
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [],
          buckets: [],
          namedUsage: [
            named('Invoice parsed', 4, 2.5),
            named('invoice parsed', 6, 3.5),
          ],
        })
      )
    )
    expect(block.rows).toHaveLength(1)
    expect(block.rows[0].name).toBe('Invoice parsed')
    expect(block.rows[0].numbers.howMany.value).toBe(10)
    expect(block.rows[0].numbers.aiCost?.value).toBe(6)
  })

  it('scopes the named rows by the same checkboxes', () => {
    const block = buildFinishedWork(
      input({
        things: [],
        buckets: [],
        agentScope: { checkedAgentKeys: new Set([AGENT_A]), agentsInTable: 2 },
        namedUsage: [
          {
            name: 'Invoice parsed',
            agentId: AGENT_B,
            howMany: 10,
            cost: 6,
            eventCount: 2,
            eventCountWithNullCost: 0,
          },
        ],
      })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.reason).toBe('no-agents')
  })

  it('totals what the rows say, so the footer cannot disagree with them', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [thing({ howMany: 2 }), thing({ name: 'Other', howMany: 1 })],
        })
      )
    )
    expect(block.totals.numbers.howMany.value).toBe(3)
    expect(block.totals.numbers.aiCost?.value).toBeCloseTo(12, 10)
  })

  // An integration row's cost IS the money, and the row says so in its own
  // word. There are no star or plus-sign legends, so nothing hands a reader a
  // key to symbols no surface prints.
  it('marks an integration row Measured on the row itself', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          namedUsage: [
            {
              name: 'Invoice parsed',
              agentId: AGENT_B,
              howMany: 10,
              cost: 6,
              eventCount: 2,
              eventCountWithNullCost: 0,
            },
          ],
        })
      )
    )
    const integrationRow = block.rows.find(
      (row) => row.name === 'Invoice parsed'
    )!
    expect(finishedWorkSourceWord(integrationRow)).toBe('measured')
    expect(FINISHED_WORK_COPY.sourceWordLegend).toContain('Measured')
  })

  it('publishes no legend for a mark no surface prints', () => {
    const block = rowsOf(buildFinishedWork(input()))
    expect(Object.keys(block.honesty).sort()).toEqual([
      'attribution',
      'moreNames',
      'unattributed',
      'unpriced',
    ])
    expect(FINISHED_WORK_COPY).not.toHaveProperty('splitMarker')
    expect(FINISHED_WORK_COPY).not.toHaveProperty('integrationMarker')
    expect(FINISHED_WORK_COPY).not.toHaveProperty('splitLegend')
    expect(FINISHED_WORK_COPY).not.toHaveProperty('integrationLegend')
  })

  it('scopes the standing sentence to the things the team recorded', () => {
    expect(
      FINISHED_WORK_COPY.attribution.startsWith('AI cost on the things')
    ).toBe(true)
  })

  // Two hundred named signals would otherwise be two hundred rows in the print
  // a board reads. The cap changes what renders, never what is counted.
  it('caps what it renders and says how many names it left out', () => {
    const many = Array.from({ length: FINISHED_WORK_MAX_ROWS + 5 }, (_, i) =>
      thing({ name: `Thing ${i}`, howMany: 1 })
    )
    const block = rowsOf(buildFinishedWork(input({ things: many })))
    expect(block.rows).toHaveLength(FINISHED_WORK_MAX_ROWS)
    expect(block.honesty.moreNames).toBe(FINISHED_WORK_COPY.moreNames(5))
  })

  it('counts every name in the totals even when it lists only some', () => {
    const many = Array.from({ length: FINISHED_WORK_MAX_ROWS + 5 }, (_, i) =>
      thing({ name: `Thing ${i}`, howMany: 2 })
    )
    const block = rowsOf(buildFinishedWork(input({ things: many })))
    expect(block.totals.numbers.howMany.value).toBe(
      (FINISHED_WORK_MAX_ROWS + 5) * 2
    )
    expect(block.recorded.howMany).toBe((FINISHED_WORK_MAX_ROWS + 5) * 2)
    expect(block.recorded.things).toHaveLength(FINISHED_WORK_MAX_ROWS + 5)
  })

  it('stays quiet about leftovers when every name fits', () => {
    expect(rowsOf(buildFinishedWork(input())).honesty.moreNames).toBeNull()
  })

  // signalId is nullable, so the read COALESCEs a missing name to ''.
  it('labels a record whose name went missing rather than showing a blank cell', () => {
    const block = rowsOf(
      buildFinishedWork(input({ things: [thing({ name: '' })] }))
    )
    expect(block.rows[0].name).toBe(FINISHED_WORK_COPY.unnamed)
  })
})

/** The field is pre-filled and editable, so every branch of the note
 *  has to end by saying when changing it is the right move. */
const OVERRIDE_HINT = 'Change it only if you finished more than the meter saw.'

describe('the count the Without AI block reads back', () => {
  it('every branch of the note ends with the override hint', () => {
    for (const things of [
      [],
      [{ name: 'contracts summarized', howMany: 9 }],
      [
        { name: 'contracts summarized', howMany: 7 },
        { name: 'contracts drafted', howMany: 2 },
      ],
      ['a', 'b', 'c', 'd'].map((name) => ({ name, howMany: 3 })),
    ]) {
      expect(
        WITHOUT_AI_COPY.countMeasuredNote('contracts', things, 9).endsWith(
          OVERRIDE_HINT
        )
      ).toBe(true)
    }
  })

  it('is the sum of How many across the block, stamped measured', () => {
    const block = buildFinishedWork(
      input({
        things: [thing({ howMany: 2 }), thing({ name: 'Other', howMany: 5 })],
      })
    )
    expect(finishedWorkMeasuredCount(block)).toBe(7)
  })

  it('is null when nothing was recorded, so a typed count still works', () => {
    expect(
      finishedWorkMeasuredCount(
        buildFinishedWork(input({ things: [], buckets: [] }))
      )
    ).toBeNull()
  })

  // The count this feeds is filled from measured data. Adding integration
  // rows to it would multiply 10,005 by the typed $40 and print that as a
  // board-ready ROI figure.
  const invoiceParsed = {
    name: 'Invoice parsed',
    agentId: AGENT_B,
    howMany: 10_000,
    cost: 6,
    eventCount: 2,
    eventCountWithNullCost: 0,
  }

  it('leaves the count typed and editable when only integrations fed the table', () => {
    const block = buildFinishedWork(
      input({ things: [], buckets: [], namedUsage: [invoiceParsed] })
    )
    expect(rowsOf(block).rows).toHaveLength(1)
    expect(finishedWorkMeasuredCount(block)).toBeNull()
  })

  it('counts only what the team recorded when the table holds both', () => {
    const block = buildFinishedWork(
      input({ things: [thing({ howMany: 5 })], namedUsage: [invoiceParsed] })
    )
    expect(rowsOf(block).totals.numbers.howMany.value).toBe(10_005)
    expect(finishedWorkMeasuredCount(block)).toBe(5)
    expect(finishedWorkNames(block)).toEqual(['Contract summarized'])
  })

  it('reads past the page cap, so a long table cannot shrink the count', () => {
    const many = Array.from({ length: FINISHED_WORK_MAX_ROWS + 5 }, (_, i) =>
      thing({ name: `Thing ${i}`, howMany: 1 })
    )
    expect(
      finishedWorkMeasuredCount(buildFinishedWork(input({ things: many })))
    ).toBe(FINISHED_WORK_MAX_ROWS + 5)
  })

  it('names up to three of them in the field note, with the count of each', () => {
    // A bare list of names under a locked total says 9 of WHICH. The mix is
    // the only honest answer when more than one name is in it.
    const note = WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      [
        { name: 'contracts summarized', howMany: 7 },
        { name: 'contracts drafted', howMany: 2 },
      ],
      9
    )
    expect(note).toBe(
      'Your meter counted 9 things: contracts summarized x7 and contracts drafted x2.' +
        ' ' +
        OVERRIDE_HINT
    )
  })

  // The one-name branch must not read "Your meter counted these: contracts
  // summarized." - a plural pronoun for one name - and must say what number is
  // sitting in the pre-filled field.
  it('names the number on a single name too, because the field is pre-filled', () => {
    const note = WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      [{ name: 'contracts summarized', howMany: 9 }],
      9
    )
    expect(note).toBe(
      `Your meter counted 9 things: contracts summarized x9. ${OVERRIDE_HINT}`
    )
    expect(note).not.toContain('counted these')
  })

  it('says one thing, not one things, when the meter counted a single one', () => {
    expect(
      WITHOUT_AI_COPY.countMeasuredNote(
        WORK_ITEM_NOUN_PLURAL,
        [{ name: 'contracts summarized', howMany: 1 }],
        1
      )
    ).toBe(
      `Your meter counted 1 thing: contracts summarized x1. ${OVERRIDE_HINT}`
    )
  })

  it('counts them instead of listing them past three', () => {
    const note = WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      ['a', 'b', 'c', 'd'].map((name) => ({ name, howMany: 3 })),
      12
    )
    expect(note).toBe(
      `Your meter counted 12 finished things across 4 names. ${OVERRIDE_HINT}`
    )
  })
})

describe('the words this block puts on screen', () => {
  const EVERY_STRING = [
    ...Object.values(FINISHED_WORK_COPY).flatMap((value) =>
      typeof value === 'string' ? [value] : []
    ),
    ...FINISHED_WORK_COPY.tableHeaders,
    FINISHED_WORK_COPY.lead(WINDOW.startDate, WINDOW.endDate),
    FINISHED_WORK_COPY.unattributed(3),
    FINISHED_WORK_COPY.unattributed(1),
    FINISHED_WORK_COPY.unpriced(4),
    FINISHED_WORK_COPY.unpriced(1),
    FINISHED_WORK_COPY.usageEventsTileLine(3),
    FINISHED_WORK_COPY.usageEventsTileLine(1),
    FINISHED_WORK_COPY.moreNames(4),
    FINISHED_WORK_COPY.moreNames(1),
    REPORT_COPY.proxyGap,
    WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      [{ name: 'contracts', howMany: 3 }],
      3
    ),
    WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      [
        { name: 'contracts', howMany: 2 },
        { name: 'slide deck', howMany: 1 },
      ],
      3
    ),
    WITHOUT_AI_COPY.countMeasuredNote(
      WORK_ITEM_NOUN_PLURAL,
      ['a', 'b', 'c', 'd'].map((name) => ({ name, howMany: 2 })),
      9
    ),
    WITHOUT_AI_COPY.agentScopeHelper,
  ]

  it('never reaches for a word that only fits one industry', () => {
    for (const line of EVERY_STRING) {
      expect(line.toLowerCase()).not.toMatch(/\bmatters?\b/)
      expect(line.toLowerCase()).not.toMatch(/\blegal\b/)
      expect(line.toLowerCase()).not.toMatch(/\blaw firms?\b/)
      expect(line.toLowerCase()).not.toMatch(/\bcases?\b/)
    }
  })

  it('uses the one noun this product settled on', () => {
    expect(FINISHED_WORK_COPY.attribution).toContain(WORK_ITEM_NOUN)
  })

  it('writes the way a person writes', () => {
    for (const line of EVERY_STRING) {
      expect(line).not.toContain('—')
      expect(line.toLowerCase()).not.toMatch(/\bjust\b/)
      expect(line.toLowerCase()).not.toMatch(
        /\b(leverage|utilize|seamless|robust|delve|unlock|empower)\b/
      )
    }
  })

  it('carries one proxy-gap sentence', () => {
    // Each recorder names the surface it works on, so a reader who
    // wants to start recording knows where to go.
    expect(REPORT_COPY.proxyGap).toBe(
      'We count a finished thing when your team records it: a coding assistant ' +
        'does that with node ~/.marginfront-ccc/cli.js done in a terminal, ' +
        'and your own app does it through the API. Signals your integrations ' +
        'name count too. Everything else on this page is usage events.'
    )
  })

  // Every sentence in this block uses contractions, including the one that
  // sits under every rendered table. The banned-word gate above does not
  // check for contractions, so this test does.
  it('writes the contraction a person would write, and names the terminal', () => {
    expect(FINISHED_WORK_COPY.attribution).not.toContain('what you are working')
    expect(FINISHED_WORK_COPY.attribution).toContain("developer's")
    // The narrowing sentence is a direction, so it carries the
    // surface and the exact command, not "the meter's work command".
    expect(FINISHED_WORK_COPY.attribution).toContain(
      'To narrow the split to one piece of work, the developer runs ' +
        'node ~/.marginfront-ccc/cli.js work "<name>" in their terminal ' +
        'before they start it.'
    )
  })

  // Plural() renders the number itself, so a template that also
  // prefixed ${count} would print it twice: "4 4 usage events". These pins
  // compare against literal strings, not the builder's own output.
  it('prints the number once in the unpriced note, at every count', () => {
    expect(FINISHED_WORK_COPY.unpriced(4)).toBe(
      "4 usage events behind these numbers aren't priced yet, so the " +
        'attributed cost reads low.'
    )
    expect(FINISHED_WORK_COPY.unpriced(1)).toBe(
      "1 usage event behind these numbers isn't priced yet, so the " +
        'attributed cost reads low.'
    )
  })

  it('prints the number once in the more-names note, at every count', () => {
    expect(FINISHED_WORK_COPY.moreNames(5)).toBe(
      "5 more names aren't listed here. The Everything row still counts " +
        'every one of them.'
    )
    expect(FINISHED_WORK_COPY.moreNames(1)).toBe(
      "1 more name isn't listed here. The Everything row still counts every " +
        'one of them.'
    )
  })

  // The gate, not the two strings: any counted line in this block that repeats
  // its own number is the same bug wearing a different template.
  it('never prints the same number twice in one sentence', () => {
    const counted = [
      FINISHED_WORK_COPY.unpriced,
      FINISHED_WORK_COPY.moreNames,
      FINISHED_WORK_COPY.unattributed,
      FINISHED_WORK_COPY.usageEventsTileLine,
    ]
    for (const line of counted) {
      for (const count of [1, 4, 25]) {
        const text = line(count)
        const digits = text.match(new RegExp(`\\b${count}\\b`, 'g')) ?? []
        expect([text, digits.length]).toEqual([text, 1])
      }
    }
  })

  it('spells a command a customer can actually run', () => {
    // The package's only bin is code-cost-clarity. `ccc` is not a command,
    // so typing it gives "command not found".
    for (const line of EVERY_STRING) {
      expect(line).not.toMatch(/\bccc (done|work)\b/)
    }
  })

  it('tells the reader which tab the finished things are on', () => {
    // "above" is true on one screen only; the tab word is true
    // in the print and to a screen reader too.
    for (const count of [1, 3]) {
      const line = FINISHED_WORK_COPY.usageEventsTileLine(count)
      expect(line).toContain('on the Finished work tab')
      expect(line).not.toMatch(/\b(above|below)\b/)
    }
  })

  // The Everything row drops when one agent is unchecked, so the lead must
  // say the count is narrowed.
  it('says how many agents it is counting once the check marks narrowed it', () => {
    const scoped = FINISHED_WORK_COPY.lead(WINDOW.startDate, WINDOW.endDate, {
      checkedAgentKeys: new Set([AGENT_A, AGENT_B]),
      agentsInTable: 7,
    })
    expect(scoped).toContain(
      'Counting 2 of 7 agents. Change that in the What you used AI for table on the Summary tab.'
    )
    expect(
      FINISHED_WORK_COPY.lead(WINDOW.startDate, WINDOW.endDate)
    ).not.toContain('Counting')
  })

  it('carries that clause into the block the three surfaces render', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({
          agentScope: {
            checkedAgentKeys: new Set([AGENT_A]),
            agentsInTable: 3,
          },
        })
      )
    )
    expect(block.lead).toContain('Counting 1 of 3 agents.')
  })

  it('says the checkboxes re-scope What you finished, not only the comparison', () => {
    // surfaceFinishedWork passes the same scope, so unchecking an agent drops
    // counts out of that table too, and the sentence must say so.
    expect(WITHOUT_AI_COPY.agentScopeHelper).toBe(
      'Uncheck an agent to leave its AI cost out of the comparison and the ' +
        'Finished work tab.'
    )
  })

  // It renders beside sibling helpers that all end in one. Without it the
  // sentence reads as copy that got cut off mid-thought.
  it('ends every helper sentence the way its siblings end', () => {
    const unfinished = Object.entries(WITHOUT_AI_COPY)
      .filter(
        ([key, value]) => key.endsWith('Helper') && typeof value === 'string'
      )
      .filter(([, value]) => !(value as string).trim().endsWith('.'))
      .map(([key, value]) => `${key}: ${value as string}`)
    expect(unfinished).toEqual([])
  })
})

/** The table's own sentences must agree with the table. Each test
 *  pins one of them against the shape of block it describes. */
describe('the block does not claim more than its rows support', () => {
  const namedRow = (over: Record<string, unknown> = {}) => ({
    name: 'RFP analysis',
    agentId: AGENT_B,
    howMany: 1,
    cost: 0.0105,
    eventCount: 1,
    eventCountWithNullCost: 0,
    ...over,
  })

  it('introduces both kinds of row, because the table holds both', () => {
    // The table holds team-recorded rows and integration rows, so the lead
    // names both and agrees with the legend below it.
    const lead = FINISHED_WORK_COPY.lead(WINDOW.startDate, WINDOW.endDate)
    expect(lead).toContain('What your team finished')
    expect(lead).toContain('plus the named signals your integrations counted')
    expect(lead).toContain('with the AI cost beside each')
    expect(lead).not.toContain('we attributed to each')
  })

  it('stamps an all-integration total measured, because every row in it is', () => {
    const block = rowsOf(
      buildFinishedWork(
        input({ things: [], buckets: [], namedUsage: [namedRow()] })
      )
    )
    expect(block.totals.numbers.aiCost).toEqual({
      value: 0.0105,
      source: 'measured',
    })
  })

  it('stamps the total attributed as soon as one recorded row feeds it', () => {
    const block = rowsOf(buildFinishedWork(input({ namedUsage: [namedRow()] })))
    expect(block.totals.numbers.aiCost?.source).toBe('attributed')
  })

  it('drops the standing sentence when no recorded row survived', () => {
    // With no recorded rows, a sentence about splitting recorded cost across
    // work items, and the command that does it, describes nothing on screen.
    const block = rowsOf(
      buildFinishedWork(
        input({ things: [], buckets: [], namedUsage: [namedRow()] })
      )
    )
    expect(block.honesty.attribution).toBeNull()
  })

  it('keeps the standing sentence when even one recorded row survived', () => {
    const block = rowsOf(buildFinishedWork(input({ namedUsage: [namedRow()] })))
    expect(block.honesty.attribution).toBe(FINISHED_WORK_COPY.attribution)
  })

  it('reports what the team recorded per name, not only the sum', () => {
    // 4 contracts and 1 slide deck is not 5 contracts, so a sum printed under one
    // noun is a wrong number.
    const block = rowsOf(
      buildFinishedWork(
        input({
          things: [
            thing({ name: 'Contract summarized', howMany: 4 }),
            thing({ name: 'Slide deck', howMany: 1 }),
          ],
        })
      )
    )
    expect(block.recorded.things).toEqual([
      { name: 'Contract summarized', howMany: 4 },
      { name: 'Slide deck', howMany: 1 },
    ])
    expect(finishedWorkRecordedThings(block)).toEqual(block.recorded.things)
    expect(finishedWorkNames(block)).toEqual([
      'Contract summarized',
      'Slide deck',
    ])
  })
})
