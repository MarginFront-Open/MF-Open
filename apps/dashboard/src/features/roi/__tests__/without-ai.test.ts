/**
 * The "Without AI" block: what AI cost and earned in these
 * dates, next to the customer's own estimate of the same work without it.
 *
 * This suite is the honesty gate. The comparison is what a presenter reads out loud
 * and what a customer pastes into a board slide, so every rule that keeps it
 * from flattering the product is pinned here: nothing renders until the customer picks
 * a method and fills it in, a result that goes the wrong way renders in the
 * same words and the same place, a difference too small to mean anything says
 * so instead of printing a number, the with-AI side sums only the agents the
 * customer checked, and every number carries where it came from.
 *
 * Node-only, no DB, no mocks — pure functions in, exact strings out.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { selectionToUrlParams } from '@/features/dashboard-shell/date-range'
import type { DateRangeSelection } from '@/features/dashboard-shell/types'
import { formatCost } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { WORK_ITEM_NOUN, WORK_ITEM_NOUN_PLURAL } from '@/lib/work-item-noun'
import {
  WITHOUT_AI_COPY,
  WITHOUT_AI_METHODS,
  agentsParamValue,
  buildWithoutAi,
  comparisonDifferenceCell,
  estimateLabelFor,
  methodIsComplete,
  missingMethodFields,
  parseAgentsParam,
  parseUnitsParam,
  parseWindowInputDraft,
  reportAgentRowKey,
  resolveUnitNouns,
  toggleAgentSelection,
  windowDayCount,
  windowIsAnchored,
  type ReportAgentRowValues,
  type RoiAssumptions,
  type WithoutAiInput,
} from '../report-derivation'

const WINDOW = { startDate: '2026-08-19', endDate: '2026-09-18' }
const START = formatDisplayDate(WINDOW.startDate)
const END = formatDisplayDate(WINDOW.endDate)

/** Exactly 30 days apart, the rolling default the page lands on. */
const RESOLVED = {
  startDate: '2026-08-19T14:22:10.114Z',
  endDate: '2026-09-18T14:22:10.114Z',
}

const ROWS: ReportAgentRowValues[] = [
  {
    agentId: 'a1',
    name: 'Contract Summary',
    usageEvents: 900,
    cost: 3000,
    earned: 4000,
    revenue: 5200,
    marginPercent: 25,
  },
  {
    agentId: 'a2',
    name: 'Drafting',
    usageEvents: 300,
    cost: 1200,
    earned: 1500,
    revenue: 1800,
    marginPercent: 20,
  },
  {
    agentId: null,
    name: 'Deleted agents',
    usageEvents: 4,
    cost: 12,
    earned: 0,
    revenue: 0,
    marginPercent: null,
  },
]

const TOTALS = { usageEvents: 1204, cost: 4212, earned: 5500, revenue: 7000 }

/** 100 hours a month at $50, pro-rated across 30 of the 30.4375 days in an
 * average month. Written out so the expected strings below are checkable by
 * hand rather than by re-running the code under test. */
const PEOPLE_TIME_TOTAL = (100 * 50 * 30) / (365.25 / 12)
const PEOPLE_TIME_SAVED = PEOPLE_TIME_TOTAL - TOTALS.cost

const PEOPLE_TIME: RoiAssumptions = {
  method: 'peopleTime',
  hoursPerMonth: 100,
  hourlyRate: 50,
}

function input(overrides: Partial<WithoutAiInput> = {}): WithoutAiInput {
  return {
    window: WINDOW,
    resolvedPeriod: RESOLVED,
    assumptions: PEOPLE_TIME,
    inputs: {
      unitsCompleted: null,
      measuredCount: null,
      windowIsAnchored: true,
      selectedAgentKeys: null,
    },
    rows: ROWS,
    totals: TOTALS,
    measuredThings: [],
    ...overrides,
  }
}

/** Narrows to the rendering case, so a test that meant to compare cannot
 * silently assert against an empty state instead. */
function comparison(value: ReturnType<typeof buildWithoutAi>) {
  if (value.kind !== 'comparison') {
    throw new Error(`expected a comparison, got the ${value.kind} state`)
  }
  return value
}

const perItem = (
  costPerItem: number,
  count: number,
  extra: Partial<RoiAssumptions> = {}
) =>
  input({
    assumptions: { method: 'perItem', costPerItem, ...extra },
    inputs: {
      unitsCompleted: count,
      measuredCount: null,
      windowIsAnchored: true,
      selectedAgentKeys: null,
    },
  })

describe('nothing renders until the customer picks a method and fills it in', () => {
  it('says nothing about the customer until their saved numbers are read', () => {
    expect(buildWithoutAi(input({ assumptions: null })).kind).toBe('loading')
  })

  it('once they are read and nothing is stored, it asks for them', () => {
    const block = buildWithoutAi(input({ assumptions: {} }))
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(WITHOUT_AI_COPY.emptyNoInputs)
    expect(block.buttonLabel).toBe(WITHOUT_AI_COPY.emptyButton)
  })

  it.each([
    ['perItem', { method: 'perItem' as const }],
    ['peopleTime', { method: 'peopleTime' as const, hoursPerMonth: 100 }],
    ['peopleTime', { method: 'peopleTime' as const, hourlyRate: 50 }],
    ['periodTotal', { method: 'periodTotal' as const }],
  ])('a half-filled %s method renders nothing', (_name, assumptions) => {
    const block = buildWithoutAi(input({ assumptions }))
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(WITHOUT_AI_COPY.emptyNoInputs)
  })

  it('methodIsComplete is the one rule behind that, for all three', () => {
    expect(methodIsComplete('perItem', { costPerItem: 100 })).toBe(true)
    expect(methodIsComplete('perItem', {})).toBe(false)
    expect(
      methodIsComplete('peopleTime', { hoursPerMonth: 100, hourlyRate: 50 })
    ).toBe(true)
    expect(methodIsComplete('peopleTime', { hoursPerMonth: 100 })).toBe(false)
    expect(methodIsComplete('periodTotal', { costPerMonth: 9000 })).toBe(true)
    expect(methodIsComplete('periodTotal', {})).toBe(false)
  })

  it('a window with nothing recorded has no AI side to compare against', () => {
    const block = buildWithoutAi(input({ rows: [] }))
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(WITHOUT_AI_COPY.emptyNoActivity)
  })

  it('with every agent unchecked, refuses rather than comparing against $0 of AI', () => {
    const block = buildWithoutAi(
      input({ inputs: { ...input().inputs, selectedAgentKeys: [] } })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(WITHOUT_AI_COPY.emptyNoAgents)
  })
})

describe('the two methods that need no count of finished work', () => {
  it('people time pro-rates the monthly figure by the days the window covers', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.method).toBe('peopleTime')
    expect(block.cost.withAi).toBe(formatCost(TOTALS.cost))
    expect(block.cost.withoutAi).toBe(formatCost(PEOPLE_TIME_TOTAL))
    expect(block.cost.withoutAi).toBe('$4,928.13')
    expect(block.cost.note).toBe(
      `people time: 100 hours a month at ${formatCost(
        50
      )} an hour, pro-rated to 30 days`
    )
    expect(block.cost.sentence).toBe(
      `AI cost you ${formatCost(PEOPLE_TIME_SAVED)} less.`
    )
  })

  it('period total pro-rates the same way and names itself', () => {
    const block = comparison(
      buildWithoutAi(
        input({ assumptions: { method: 'periodTotal', costPerMonth: 9000 } })
      )
    )
    const expected = (9000 * 30) / (365.25 / 12)
    expect(block.cost.withoutAi).toBe(formatCost(expected))
    expect(block.cost.note).toBe(
      `period total: ${formatCost(9000)} a month, pro-rated to 30 days`
    )
    expect(block.cost.sentence).toBe(
      `AI cost you ${formatCost(expected - TOTALS.cost)} less.`
    )
  })

  it('neither one asks for a count, which is the whole point of having them', () => {
    for (const assumptions of [
      PEOPLE_TIME,
      { method: 'periodTotal' as const, costPerMonth: 9000 },
    ]) {
      const block = buildWithoutAi(input({ assumptions }))
      expect(block.kind).toBe('comparison')
      if (block.kind !== 'comparison') return
      expect(block.numbers.unitsCompleted).toBeNull()
    }
  })

  it('the day count comes from the instants, so a calendar month reads 31 and a rolling window 30', () => {
    expect(windowDayCount(RESOLVED)).toBe(30)
    expect(
      windowDayCount({
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-31T23:59:59.999Z',
      })
    ).toBe(31)
  })

  it('a one-day window is one day, never zero — a zero would erase the estimate', () => {
    expect(
      windowDayCount({
        startDate: '2026-08-19T00:00:00.000Z',
        endDate: '2026-08-19T00:00:00.000Z',
      })
    ).toBe(1)
  })

  it('a longer window scales the estimate up, and the label says by how much', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          resolvedPeriod: {
            startDate: '2026-07-20T14:22:10.114Z',
            endDate: '2026-09-18T14:22:10.114Z',
          },
        })
      )
    )
    expect(block.numbers.windowDays.value).toBe(60)
    expect(block.cost.note).toContain('pro-rated to 60 days')
    expect(block.numbers.cost.withoutAi.value).toBeCloseTo(
      (100 * 50 * 60) / (365.25 / 12),
      6
    )
  })
})

describe('the per-item method, and the count it needs', () => {
  it('multiplies the rate by the count and shows its work', () => {
    const block = comparison(buildWithoutAi(perItem(100, 57)))
    expect(block.method).toBe('perItem')
    expect(block.cost.withoutAi).toBe(formatCost(5700))
    expect(block.cost.note).toBe(
      `per ${WORK_ITEM_NOUN}: 57 ${WORK_ITEM_NOUN_PLURAL} at ${formatCost(
        100
      )} each`
    )
    expect(block.cost.sentence).toBe(`AI cost you ${formatCost(1488)} less.`)
  })

  it('a per-item method with no count at all asks for one by name', () => {
    const block = buildWithoutAi(
      input({ assumptions: { method: 'perItem', costPerItem: 100 } })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(
      WITHOUT_AI_COPY.emptyNoCount(
        WORK_ITEM_NOUN_PLURAL,
        WINDOW.startDate,
        WINDOW.endDate
      )
    )
  })

  it('on a window with no dates in the link, it says to pin the dates instead of asking for a number it would drop', () => {
    const block = buildWithoutAi(
      input({
        assumptions: { method: 'perItem', costPerItem: 100 },
        inputs: { ...input().inputs, windowIsAnchored: false },
      })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(
      WITHOUT_AI_COPY.emptyCountNeedsDates(WORK_ITEM_NOUN_PLURAL)
    )
    expect(block.body).toContain("in this page's date picker")
  })

  it('an empty window says nothing was recorded rather than asking for a count that has nothing to compare against', () => {
    const block = buildWithoutAi(
      input({
        assumptions: { method: 'perItem', costPerItem: 100 },
        rows: [],
        totals: { usageEvents: 0, cost: 0, earned: 0, revenue: 0 },
      })
    )
    expect(block.kind).toBe('empty')
    if (block.kind !== 'empty') return
    expect(block.body).toBe(WITHOUT_AI_COPY.emptyNoActivity)
  })

  it('never invents a zero: a count of zero is a real answer, not a missing one', () => {
    const block = comparison(buildWithoutAi(perItem(100, 0)))
    expect(block.numbers.unitsCompleted?.value).toBe(0)
    expect(block.numbers.cost.withoutAi.value).toBe(0)
  })

  it('the customer word for one finished thing replaces the placeholder everywhere', () => {
    const block = comparison(
      buildWithoutAi(
        perItem(100, 57, {
          unitSingular: 'contract summarized',
          unitPlural: 'contracts summarized',
        })
      )
    )
    expect(block.cost.note).toBe(
      `per contract summarized: 57 contracts summarized at ${formatCost(100)} each`
    )
    expect(block.paragraph).toContain(
      'you finished 57 contracts summarized with AI'
    )
    expect(block.paragraph).not.toContain(WORK_ITEM_NOUN_PLURAL)
  })

  it('never invents one form of the noun from the other', () => {
    expect(resolveUnitNouns({ unitPlural: 'papers' })).toEqual({
      singular: WORK_ITEM_NOUN,
      plural: 'papers',
    })
    expect(resolveUnitNouns({ unitSingular: 'paper' })).toEqual({
      singular: 'paper',
      plural: WORK_ITEM_NOUN_PLURAL,
    })
    expect(resolveUnitNouns({ unitPlural: '   ' }).plural).toBe(
      WORK_ITEM_NOUN_PLURAL
    )
  })
})

/**
 * The count field is pre-filled with the meter's
 * number and editable. Untouched, the meter's count stands and is stamped
 * measured. A count in the page link means the customer typed one over it, so
 * it wins and is stamped as theirs. The surface only writes the link when the
 * typed number differs, which is what keeps "untouched" meaning untouched.
 */
describe('the units precedence rule', () => {
  it("a typed count beats the meter's and is stamped as the customer", () => {
    const block = comparison(
      buildWithoutAi(
        input({
          assumptions: { method: 'perItem', costPerItem: 100 },
          inputs: {
            unitsCompleted: 57,
            measuredCount: 40,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
        })
      )
    )
    expect(block.numbers.unitsCompleted).toEqual({
      value: 57,
      source: 'customer_entered',
    })
    expect(block.cost.withoutAi).toBe(formatCost(5700))
    expect(block.paragraph).toContain(
      'The count and the without-AI figures are yours, not ours.'
    )
  })

  it("the meter's count stands, and is stamped measured, when nothing was typed", () => {
    const block = comparison(
      buildWithoutAi(
        input({
          assumptions: { method: 'perItem', costPerItem: 100 },
          inputs: {
            unitsCompleted: null,
            measuredCount: 40,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
        })
      )
    )
    expect(block.numbers.unitsCompleted).toEqual({
      value: 40,
      source: 'measured',
    })
    expect(block.cost.withoutAi).toBe(formatCost(4000))
    expect(block.paragraph).toContain(
      `Your meter tagged the ${WORK_ITEM_NOUN_PLURAL}.`
    )
  })

  it('states the MIX when the meter counted more than one name', () => {
    // 4 contracts summarized and 1 slide deck is not "5 contracts summarized". The count
    // the meter reported is a sum over names, so the sentence names them
    // rather than printing the sum under the customer's own noun.
    const block = comparison(
      buildWithoutAi(
        input({
          inputs: {
            unitsCompleted: null,
            measuredCount: 5,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
          measuredThings: [
            { name: 'contract summarized', howMany: 4 },
            { name: 'slide deck', howMany: 1 },
          ],
        })
      )
    )
    expect(block.paragraph).toContain(
      'you finished 5 things with AI: contract summarized x4 and slide deck x1.'
    )
    // The qualifier belongs ahead of the list: after it, "with AI" reads as
    // though the slide deck was the one thing done with AI.
    expect(block.paragraph).not.toContain('x1 with AI')
    expect(block.paragraph).not.toContain(`5 ${WORK_ITEM_NOUN_PLURAL} with AI`)
    // Same rule, two sentences later. The trailer must not print the whole mix
    // back under the customer's own noun, which is the claim the opening
    // exists to refuse.
    expect(block.paragraph).toContain('Your meter tagged them.')
    expect(block.paragraph).not.toContain(
      `Your meter tagged the ${WORK_ITEM_NOUN_PLURAL}.`
    )
  })

  it('leaves the sentence alone when the meter counted one name', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          inputs: {
            unitsCompleted: null,
            measuredCount: 5,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
          measuredThings: [{ name: 'contract summarized', howMany: 5 }],
        })
      )
    )
    expect(block.paragraph).toContain(`5 ${WORK_ITEM_NOUN_PLURAL} with AI`)
    expect(block.paragraph).toContain(
      `Your meter tagged the ${WORK_ITEM_NOUN_PLURAL}.`
    )
  })

  it('counts the names instead of listing them past three', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          inputs: {
            unitsCompleted: null,
            measuredCount: 8,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
          measuredThings: ['a', 'b', 'c', 'd'].map((name) => ({
            name,
            howMany: 2,
          })),
        })
      )
    )
    expect(block.paragraph).toContain(
      'you finished 8 things with AI across 4 names.'
    )
    expect(block.paragraph).not.toContain('names with AI')
  })

  it('never states a mix for a count the customer typed themselves', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          inputs: {
            unitsCompleted: 5,
            measuredCount: null,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
          measuredThings: [
            { name: 'contract summarized', howMany: 4 },
            { name: 'slide deck', howMany: 1 },
          ],
        })
      )
    )
    expect(block.paragraph).toContain(`5 ${WORK_ITEM_NOUN_PLURAL} with AI`)
  })

  it('a measured count needs no dates in the link, because nobody typed it', () => {
    const block = buildWithoutAi(
      input({
        assumptions: { method: 'perItem', costPerItem: 100 },
        inputs: {
          unitsCompleted: null,
          measuredCount: 40,
          windowIsAnchored: false,
          selectedAgentKeys: null,
        },
      })
    )
    expect(block.kind).toBe('comparison')
  })

  it('a typed count is stamped as the customer, and the paragraph says so', () => {
    const block = comparison(buildWithoutAi(perItem(100, 57)))
    expect(block.numbers.unitsCompleted).toEqual({
      value: 57,
      source: 'customer_entered',
    })
    expect(block.paragraph).toContain(
      'The count and the without-AI figures are yours, not ours.'
    )
  })
})

describe('a bad result reads in the same words, in the same place', () => {
  it('flips to "more" when AI cost more', () => {
    const block = comparison(buildWithoutAi(perItem(10, 57)))
    expect(block.cost.sentence).toBe(`AI cost you ${formatCost(3642)} more.`)
    expect(block.numbers.cost.aiHigher).toBe(true)
  })

  it('the difference is never signed in the copy — the word carries the direction', () => {
    const block = comparison(buildWithoutAi(perItem(10, 57)))
    expect(block.cost.sentence).not.toContain('-$')
    expect(block.numbers.cost.difference.value).toBe(3642)
  })

  it('the winning and losing sentences are the same shape', () => {
    const better = comparison(buildWithoutAi(perItem(100, 57))).cost.sentence
    const worse = comparison(buildWithoutAi(perItem(10, 57))).cost.sentence
    expect(better.replace(/\$[\d,.]+/, '$X')).toBe('AI cost you $X less.')
    expect(worse.replace(/\$[\d,.]+/, '$X')).toBe('AI cost you $X more.')
  })
})

describe('a difference too small to mean anything says so instead of printing it', () => {
  it('an exact tie reads "about the same"', () => {
    const block = comparison(buildWithoutAi(perItem(TOTALS.cost, 1)))
    expect(block.cost.sentence).toBe('AI cost you about the same.')
    expect(block.numbers.cost.aboutTheSame).toBe(true)
  })

  it('six tenths of a cent reads "about the same" rather than "$0.0060 less"', () => {
    const block = comparison(buildWithoutAi(perItem(TOTALS.cost + 0.006, 1)))
    expect(block.cost.sentence).toBe('AI cost you about the same.')
    expect(block.cost.sentence).not.toContain('0.0060')
  })

  it('a full cent apart is a real number again', () => {
    const block = comparison(buildWithoutAi(perItem(TOTALS.cost + 0.01, 1)))
    expect(block.numbers.cost.aboutTheSame).toBe(false)
    expect(block.cost.sentence).toContain('less')
  })
})

describe('a half-filled method is refused in front of the customer', () => {
  it("names the blank field, in the customer's own noun where there is one", () => {
    expect(missingMethodFields('perItem', { method: 'perItem' })).toEqual([
      `what one ${WORK_ITEM_NOUN} cost before AI`,
    ])
    expect(
      missingMethodFields('perItem', {
        method: 'perItem',
        unitSingular: 'paper',
      })
    ).toEqual(['what one paper cost before AI'])
    expect(missingMethodFields('peopleTime', { hourlyRate: 50 })).toEqual([
      'the hours a month this work took',
    ])
    expect(missingMethodFields('peopleTime', { hoursPerMonth: 100 })).toEqual([
      'the cost an hour',
    ])
    expect(missingMethodFields('peopleTime', {})).toHaveLength(2)
    expect(missingMethodFields('periodTotal', {})).toEqual([
      'what this work cost a month before AI',
    ])
  })

  it('is the one rule the builder already used, so the panel cannot disagree with the page', () => {
    const shapes: RoiAssumptions[] = [
      {},
      { costPerItem: 400 },
      { hoursPerMonth: 100 },
      { hourlyRate: 50 },
      { hoursPerMonth: 100, hourlyRate: 50 },
      { costPerMonth: 9000 },
    ]
    for (const method of WITHOUT_AI_METHODS) {
      for (const shape of shapes) {
        expect(methodIsComplete(method, shape)).toBe(
          missingMethodFields(method, shape).length === 0
        )
      }
    }
  })

  it('the refusal says what happened, what is missing and what to do', () => {
    const line = WITHOUT_AI_COPY.methodIncomplete(
      missingMethodFields('peopleTime', {})
    )
    expect(line).toContain('Nothing was saved')
    expect(line).toContain(
      'the hours a month this work took and the cost an hour'
    )
    expect(line).toContain('save again')
  })
})

/**
 * Every comparison shows cost and revenue, not cost alone. The Revenue row is
 * always present and never org-wide: it sums the checked agents' total
 * revenue, and when the customer has told us nothing about their without-AI
 * revenue we say we are assuming it rather than hiding the row.
 */
describe('the Revenue row, which is on every comparison', () => {
  const withRevenue = (extra: Partial<RoiAssumptions> = {}) =>
    input({
      assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000, ...extra },
    })

  it('measures the with-AI side from the checked agents and pro-rates the estimate', () => {
    const block = comparison(buildWithoutAi(withRevenue()))
    expect(block.revenue).not.toBeNull()
    expect(block.revenue?.withAi).toBe(formatCost(TOTALS.revenue))
    expect(block.revenue?.withoutAi).toBe(formatCost(PEOPLE_TIME_TOTAL))
    expect(block.revenue?.sentence).toBe(
      `AI brought in ${formatCost(TOTALS.revenue - PEOPLE_TIME_TOTAL)} more.`
    )
    expect(block.revenue?.note).toBe(
      `${formatCost(5000)} a month, pro-rated to 30 days`
    )
  })

  it('says "less" when the estimate beats what AI actually brought in', () => {
    const block = comparison(
      buildWithoutAi(withRevenue({ revenuePerMonth: 9000 }))
    )
    expect(block.revenue?.sentence).toContain('less')
    expect(block.numbers.revenue.aiHigher).toBe(false)
  })

  it('echoes the canon total when every agent is checked, so the row equals the tile', () => {
    const block = comparison(buildWithoutAi(withRevenue()))
    expect(block.numbers.revenue.withAi.value).toBe(TOTALS.revenue)
  })

  it('moves with the check marks, because it is summed from the rows', () => {
    const block = comparison(
      buildWithoutAi({
        ...withRevenue(),
        inputs: { ...input().inputs, selectedAgentKeys: ['a1'] },
      })
    )
    expect(block.numbers.revenue.withAi.value).toBe(ROWS[0].revenue)
    expect(block.revenue?.withAi).toBe(formatCost(ROWS[0].revenue))
    expect(block.revenueNote).toBeNull()
  })

  it('renders with no estimate at all, stamped as an assumption rather than hidden', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.revenue).not.toBeNull()
    expect(block.revenue?.withAi).toBe(formatCost(TOTALS.revenue))
    expect(block.revenue?.withoutAi).toBe(WITHOUT_AI_COPY.revenueAssumedCell)
    expect(block.revenue?.withoutAi).toBe('Same as with AI, until you tell us')
    expect(block.revenue?.sentence).toBe(WITHOUT_AI_COPY.revenueAssumedSentence)
    expect(block.numbers.revenue.withoutAi.source).toBe(
      'assumed_same_as_with_ai'
    )
    expect(block.numbers.revenue.withoutAi.value).toBe(TOTALS.revenue)
    expect(comparisonDifferenceCell(block.numbers.revenue)).toBe(
      WITHOUT_AI_COPY.aboutTheSameCell
    )
  })

  it('the assumption is written into the sentence, where nobody can miss it', () => {
    expect(WITHOUT_AI_COPY.revenueAssumedSentence).toContain('We assume')
    expect(WITHOUT_AI_COPY.revenueAssumedSentence).toContain(
      'until you tell us otherwise'
    )
  })

  it('the estimate stamp says the without-AI revenue is an assumption when it is', () => {
    const assumed = comparison(buildWithoutAi(input()))
    const told = comparison(buildWithoutAi(withRevenue()))
    expect(assumed.estimateLabel).toContain('assume')
    expect(told.estimateLabel).not.toContain('assume')
    expect(told.estimateLabel).toBe(
      estimateLabelFor('peopleTime', WORK_ITEM_NOUN)
    )
  })

  it('the intro promises what those agents brought in, not the whole organization', () => {
    const intro = WITHOUT_AI_COPY.intro(WINDOW.startDate, WINDOW.endDate)
    expect(intro).toContain('and what those agents brought in')
    expect(intro).not.toContain('across your whole organization')
  })

  it('the row that reads $0.00 says where a subscription is created', () => {
    const noRevenue = ROWS.map((row) => ({ ...row, revenue: 0 }))
    const block = comparison(
      buildWithoutAi(
        input({ rows: noRevenue, totals: { ...TOTALS, revenue: 0 } })
      )
    )
    expect(block.revenue?.withAi).toBe(formatCost(0))
    expect(block.revenue?.withoutAi).toBe(WITHOUT_AI_COPY.revenueAssumedCell)
    expect(block.revenueNote).toBe(WITHOUT_AI_COPY.revenueNoSubscription)
    expect(block.revenueNote).toContain('Unit Economics')
    expect(block.revenueNote).toContain('Subscriptions')
  })

  it('points at the setup gap even when the customer gave us a figure', () => {
    const noRevenue = ROWS.map((row) => ({ ...row, revenue: 0 }))
    const block = comparison(
      buildWithoutAi({
        ...withRevenue(),
        rows: noRevenue,
        totals: { ...TOTALS, revenue: 0 },
      })
    )
    // The verdict says AI made them worse off on revenue nobody wired up.
    expect(block.revenue?.sentence).toContain('less')
    expect(block.netLine).toContain('worse off')
    expect(block.revenueNote).toBe(WITHOUT_AI_COPY.revenueNoSubscription)
  })

  it('keeps the pointer off a row that actually earned something', () => {
    expect(comparison(buildWithoutAi(withRevenue())).revenueNote).toBeNull()
    expect(comparison(buildWithoutAi(input())).revenueNote).toBeNull()
  })

  it('the copy has no keys for hiding the Revenue row', () => {
    expect(WITHOUT_AI_COPY).not.toHaveProperty('revenueNeedsEveryAgent')
    expect(WITHOUT_AI_COPY).not.toHaveProperty('revenueNoNumber')
  })
})

describe('the net line, which is the headline', () => {
  it('stamps the net as ours when half of it is our assumption', () => {
    const assumed = comparison(buildWithoutAi(input()))
    expect(assumed.numbers.revenue.withoutAi.source).toBe(
      'assumed_same_as_with_ai'
    )
    expect(assumed.numbers.revenue.difference.source).toBe(
      'assumed_same_as_with_ai'
    )
    expect(assumed.numbers.net.source).toBe('assumed_same_as_with_ai')
  })

  it('hands the net back to the customer once they tell us a figure', () => {
    const told = comparison(
      buildWithoutAi(
        input({ assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000 } })
      )
    )
    expect(told.numbers.revenue.difference.source).toBe(
      'derived_from_customer_input'
    )
    expect(told.numbers.net.source).toBe('derived_from_customer_input')
  })

  it('never stamps the cost row with the revenue row’s assumption', () => {
    const assumed = comparison(buildWithoutAi(input()))
    expect(assumed.numbers.cost.withoutAi.source).toBe(
      'derived_from_customer_input'
    )
    expect(assumed.numbers.cost.difference.source).toBe(
      'derived_from_customer_input'
    )
  })

  it('adds the cost saved to the revenue gained', () => {
    const block = comparison(
      buildWithoutAi(
        input({ assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000 } })
      )
    )
    expect(block.numbers.net.value).toBeCloseTo(
      PEOPLE_TIME_SAVED + (TOTALS.revenue - PEOPLE_TIME_TOTAL),
      6
    )
    expect(block.netLine).toBe(
      'AI left you $2,788.00 better off in these dates.'
    )
  })

  it('says "worse off" without softening it', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          assumptions: {
            method: 'perItem',
            costPerItem: 10,
            revenuePerMonth: 50000,
          },
          inputs: {
            unitsCompleted: 57,
            measuredCount: null,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
        })
      )
    )
    expect(block.netLine).toContain('worse off in these dates.')
    expect(block.numbers.netFavorsAi).toBe(false)
  })

  it('renders with no revenue estimate too, where it equals the cost saved', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.netLine).toBe(
      `AI left you ${formatCost(PEOPLE_TIME_SAVED)} better off in these dates.`
    )
    expect(block.numbers.net.value).toBeCloseTo(PEOPLE_TIME_SAVED, 6)
  })

  it('never carries the word Net in front of the sentence a reader reads first', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.netLine.startsWith('Net:')).toBe(false)
  })
})

describe('the data never claims a verdict the page did not give', () => {
  it('a cost row that reads "about the same" carries no winner', () => {
    const tie = comparison(buildWithoutAi(perItem(TOTALS.cost, 1)))
    expect(tie.cost.sentence).toBe('AI cost you about the same.')
    expect(tie.numbers.netFavorsAi).toBeNull()
    expect(tie.netLine).toBe('About the same either way in these dates.')
  })

  it('a net inside a cent carries no winner either', () => {
    // 4212 against 4212 on cost, and the without-AI revenue assumed equal to
    // the $7,000 the checked agents brought in, so both sides land on zero.
    const tie = comparison(buildWithoutAi(perItem(TOTALS.cost, 1)))
    expect(tie.netLine).toBe('About the same either way in these dates.')
    expect(tie.numbers.netFavorsAi).toBeNull()
  })

  it('a real result still reads true or false', () => {
    expect(comparison(buildWithoutAi(input())).numbers.netFavorsAi).toBe(true)
    expect(
      comparison(buildWithoutAi(perItem(10, 57))).numbers.netFavorsAi
    ).toBe(false)
  })
})

describe('the one paragraph every surface renders', () => {
  it('reads end to end for the method with no count', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.paragraph).toBe(
      `Between ${START} and ${END}, your AI cost ${formatCost(
        TOTALS.cost
      )}. Without AI, by your own estimate, the same work would have cost ${formatCost(
        PEOPLE_TIME_TOTAL
      )} (people time: 100 hours a month at ${formatCost(
        50
      )} an hour, pro-rated to 30 days). AI cost you ${formatCost(
        PEOPLE_TIME_SAVED
      )} less. Your AI brought in ${formatCost(TOTALS.revenue)}. ${
        WITHOUT_AI_COPY.revenueAssumedSentence
      } AI left you ${formatCost(
        PEOPLE_TIME_SAVED
      )} better off in these dates. The without-AI figures are yours, not ours.`
    )
  })

  it('reads end to end for the per-item method, with the count in front', () => {
    const block = comparison(buildWithoutAi(perItem(100, 57)))
    expect(block.paragraph).toBe(
      `Between ${START} and ${END} you finished 57 ${WORK_ITEM_NOUN_PLURAL} with AI. Your AI cost ${formatCost(
        TOTALS.cost
      )}. Without AI, by your own estimate, the same work would have cost ${formatCost(
        5700
      )} (per ${WORK_ITEM_NOUN}: 57 ${WORK_ITEM_NOUN_PLURAL} at ${formatCost(
        100
      )} each). AI cost you ${formatCost(
        1488
      )} less. Your AI brought in ${formatCost(TOTALS.revenue)}. ${
        WITHOUT_AI_COPY.revenueAssumedSentence
      } AI left you ${formatCost(
        1488
      )} better off in these dates. The count and the without-AI figures are yours, not ours.`
    )
  })

  // Phrasing: the customer finished the work. The AI is a tool
  // they used, and a product that says otherwise is selling, not reporting.
  it('credits the customer with the work, never the AI', () => {
    const block = comparison(buildWithoutAi(perItem(100, 57)))
    expect(block.paragraph).toContain(
      `you finished 57 ${WORK_ITEM_NOUN_PLURAL} with AI`
    )
    expect(block.paragraph).not.toContain('your AI finished')
  })

  it('carries the revenue pair and the net line when there is one', () => {
    const block = comparison(
      buildWithoutAi(
        input({ assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000 } })
      )
    )
    expect(block.paragraph).toContain(
      `Your AI brought in ${formatCost(
        TOTALS.revenue
      )} and you estimate ${formatCost(PEOPLE_TIME_TOTAL)} without AI.`
    )
    expect(block.paragraph).toContain(block.revenue!.sentence)
    expect(block.paragraph).toContain(block.netLine)
  })

  it('names the agents when the scope is narrowed, instead of saying "your AI"', () => {
    const block = comparison(
      buildWithoutAi(
        input({ inputs: { ...input().inputs, selectedAgentKeys: ['a1'] } })
      )
    )
    expect(block.paragraph).toContain('your Contract Summary agent cost')
    expect(block.paragraph).not.toContain('your AI cost')
  })

  it('every sentence the block renders is inside the paragraph, so the two cannot drift', () => {
    const block = comparison(
      buildWithoutAi(
        input({ assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000 } })
      )
    )
    for (const piece of [
      block.cost.sentence,
      block.cost.withAi,
      block.cost.withoutAi,
      block.cost.note!,
      block.revenue!.sentence,
      block.netLine,
    ]) {
      expect(block.paragraph).toContain(piece)
    }
  })
})

describe('the estimate stamp names the method in plain words', () => {
  it.each([
    ['perItem', `from what you told us one ${WORK_ITEM_NOUN} used to cost`],
    ['peopleTime', 'from the hours a month and the cost an hour you gave us'],
    ['periodTotal', 'from the monthly total you gave us'],
  ] as const)('%s', (method, how) => {
    expect(estimateLabelFor(method, WORK_ITEM_NOUN)).toBe(
      `Estimate. We measured the with-AI side. The without-AI side is your estimate, ${how}.`
    )
  })

  it('the block renders the stamp for the method it actually used', () => {
    expect(comparison(buildWithoutAi(input())).estimateLabel).toBe(
      estimateLabelFor('peopleTime', WORK_ITEM_NOUN, true)
    )
    expect(
      comparison(
        buildWithoutAi(
          perItem(100, 57, { unitSingular: 'contract summarized' })
        )
      ).estimateLabel
    ).toBe(estimateLabelFor('perItem', 'contract summarized', true))
  })

  it('never claims we measured anything the customer typed', () => {
    for (const method of WITHOUT_AI_METHODS) {
      const label = estimateLabelFor(method, WORK_ITEM_NOUN)
      expect(label).toContain('We measured the with-AI side')
      expect(label).toContain('is your estimate')
    }
  })
})

describe('the with-AI side is the agents the customer checked', () => {
  it('everything checked echoes the canon totals and never re-sums the rows', () => {
    const block = comparison(buildWithoutAi(input()))
    expect(block.numbers.cost.withAi.value).toBe(TOTALS.cost)
    expect(block.scope.allSelected).toBe(true)
  })

  it('a partial selection sums exactly the checked rows', () => {
    const block = comparison(
      buildWithoutAi(
        input({
          inputs: { ...input().inputs, selectedAgentKeys: ['a1', 'a2'] },
        })
      )
    )
    expect(block.numbers.cost.withAi.value).toBe(3000 + 1200)
    expect(block.scope.allSelected).toBe(false)
    expect(block.scope.agentKeys).toEqual(['a1', 'a2'])
  })

  it('two named agents read as a list, and more than two read as a count', () => {
    const two = comparison(
      buildWithoutAi(
        input({
          inputs: { ...input().inputs, selectedAgentKeys: ['a1', 'a2'] },
        })
      )
    )
    expect(two.paragraph).toContain(
      'your Contract Summary and Drafting agents cost'
    )

    const many: ReportAgentRowValues[] = ['a1', 'a2', 'a3', 'a4'].map(
      (id, index) => ({
        agentId: id,
        name: `Agent ${index}`,
        usageEvents: 1,
        cost: 10,
        earned: 0,
        revenue: 0,
        marginPercent: null,
      })
    )
    const three = comparison(
      buildWithoutAi(
        input({
          rows: many,
          inputs: { ...input().inputs, selectedAgentKeys: ['a1', 'a2', 'a3'] },
        })
      )
    )
    expect(three.paragraph).toContain('your 3 selected agents cost')
  })

  it('selecting every row is the same as selecting nothing at all', () => {
    const explicit = comparison(
      buildWithoutAi(
        input({
          inputs: {
            ...input().inputs,
            selectedAgentKeys: ['a1', 'a2', 'deleted-agents'],
          },
        })
      )
    )
    expect(explicit.scope.allSelected).toBe(true)
    expect(explicit.numbers.cost.withAi.value).toBe(TOTALS.cost)
    expect(explicit.paragraph).toBe(
      comparison(buildWithoutAi(input())).paragraph
    )
  })

  it('the row key is one function, so the checkbox and the sum agree by construction', () => {
    expect(reportAgentRowKey(ROWS[0])).toBe('a1')
    expect(reportAgentRowKey(ROWS[2])).toBe('deleted-agents')
  })
})

describe('every number carries where it came from', () => {
  const full = () =>
    comparison(
      buildWithoutAi(
        input({
          assumptions: {
            method: 'perItem',
            costPerItem: 100,
            revenuePerMonth: 5000,
          },
          inputs: {
            unitsCompleted: 57,
            measuredCount: null,
            windowIsAnchored: true,
            selectedAgentKeys: null,
          },
        })
      )
    )

  it('the AI side is measured, the typed side is the customer, the math is derived', () => {
    const { numbers, scope } = full()
    expect(numbers.cost.withAi.source).toBe('measured')
    expect(numbers.cost.withoutAi.source).toBe('derived_from_customer_input')
    expect(numbers.cost.difference.source).toBe('derived_from_customer_input')
    expect(numbers.revenue.withAi.source).toBe('measured')
    expect(numbers.revenue.withoutAi.source).toBe('derived_from_customer_input')
    expect(numbers.net.source).toBe('derived_from_customer_input')
    expect(numbers.unitsCompleted?.source).toBe('customer_entered')
    expect(numbers.costPerItem?.source).toBe('customer_entered')
    expect(numbers.revenuePerMonth?.source).toBe('customer_entered')
    expect(numbers.windowDays.source).toBe('measured')
    expect(scope.source).toBe('customer_entered')
  })

  it('a figure the customer never gave us is null, never a zero standing in for one', () => {
    const { numbers } = full()
    expect(numbers.hoursPerMonth).toBeNull()
    expect(numbers.hourlyRate).toBeNull()
    expect(numbers.costPerMonth).toBeNull()
  })

  it('no number in the block is left without a stamp', () => {
    const stamps = [
      'measured',
      'customer_entered',
      'derived_from_customer_input',
    ]
    const walk = (node: unknown, path: string): string[] => {
      if (typeof node === 'number') return [path]
      if (node === null || typeof node !== 'object') return []
      const record = node as Record<string, unknown>
      if (typeof record.source === 'string' && 'value' in record) {
        expect(stamps).toContain(record.source)
        return typeof record.value === 'number' ? [] : [`${path}.value`]
      }
      return Object.entries(record).flatMap(([key, item]) =>
        walk(item, path === '' ? key : `${path}.${key}`)
      )
    }
    expect(walk(full().numbers, '')).toEqual([])
  })
})

describe('the count rides in the page link, and only on a window the link pins down', () => {
  const pinned = { startDate: '2026-08-19', endDate: '2026-09-18' }

  it('a count reads back as a whole number when both dates are in the link', () => {
    expect(parseUnitsParam('57', pinned)).toBe(57)
    expect(parseUnitsParam('0', pinned)).toBe(0)
  })

  // Bookmark drift: "last 30 days" is a different window
  // tomorrow, so a count bookmarked against it is restated as fact for dates
  // it was never counted for.
  it('a count with no dates beside it is dropped, not carried onto a moving window', () => {
    expect(parseUnitsParam('57', {})).toBeNull()
    expect(parseUnitsParam('57', { startDate: '2026-08-19' })).toBeNull()
    expect(parseUnitsParam('57', { endDate: '2026-09-18' })).toBeNull()
    expect(
      parseUnitsParam('57', { startDate: '  ', endDate: '2026-09-18' })
    ).toBeNull()
  })

  it('windowIsAnchored is the one rule behind that', () => {
    expect(windowIsAnchored(pinned)).toBe(true)
    expect(windowIsAnchored({})).toBe(false)
    expect(windowIsAnchored({ startDate: null, endDate: null })).toBe(false)
    expect(windowIsAnchored({ startDate: '2026-08-19', endDate: '' })).toBe(
      false
    )
  })

  it('a count that is not a whole non-negative number reads as nothing entered', () => {
    for (const raw of [
      '',
      ' ',
      '-3',
      '1.5',
      'abc',
      'Infinity',
      null,
      undefined,
    ]) {
      expect(parseUnitsParam(raw, pinned)).toBeNull()
    }
  })

  it('an absent agent list means every agent, which is the default', () => {
    expect(parseAgentsParam(null)).toBeNull()
    expect(parseAgentsParam(undefined)).toBeNull()
    expect(parseAgentsParam('')).toBeNull()
  })

  it('an agent list reads back deduped, in order, with blanks dropped', () => {
    expect(parseAgentsParam('a1,,a2,a1')).toEqual(['a1', 'a2'])
    expect(parseAgentsParam('deleted-agents')).toEqual(['deleted-agents'])
  })

  it('an explicitly empty selection round-trips as itself, not as everything', () => {
    expect(agentsParamValue([])).toBe('none')
    expect(parseAgentsParam(agentsParamValue([])!)).toEqual([])
  })

  it('everything selected drops the param rather than writing a long list', () => {
    expect(agentsParamValue(null)).toBeNull()
    expect(agentsParamValue(['a1', 'a2'])).toBe('a1,a2')
  })
})

describe('what the customer types is what the page link can read back', () => {
  it('a whole count comes back as a number', () => {
    const parsed = parseWindowInputDraft({ unitsCompleted: '57' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.values.unitsCompleted).toBe(57)
  })

  it('a blank field is a real answer: nothing entered, no complaint', () => {
    const parsed = parseWindowInputDraft({ unitsCompleted: '  ' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.values.unitsCompleted).toBeNull()
  })

  it('refuses a count the link would drop, and says so in words', () => {
    for (const raw of ['57.5', '-3', 'abc', '1e3']) {
      const parsed = parseWindowInputDraft({ unitsCompleted: raw })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.error).toBe(WITHOUT_AI_COPY.unitsInvalid)
    }
  })

  it('refuses a number too big to survive the trip, not only a badly shaped one', () => {
    const huge = '1' + '0'.repeat(21)
    expect(parseWindowInputDraft({ unitsCompleted: huge }).ok).toBe(false)
  })
})

describe('one checkbox click never quietly re-checks an agent', () => {
  it('unchecking one of three writes the other two', () => {
    expect(toggleAgentSelection(['a1', 'a2', 'a3'], null, 'a2')).toEqual([
      'a1',
      'a3',
    ])
  })

  it('checking the last missing one drops the param rather than listing everything', () => {
    expect(toggleAgentSelection(['a1', 'a2'], ['a1'], 'a2')).toBeNull()
  })

  it('unchecking the last one left is an explicit empty selection, not the default', () => {
    expect(toggleAgentSelection(['a1', 'a2'], ['a1'], 'a1')).toEqual([])
  })

  it('a key this window no longer has cannot buy back the everything default', () => {
    expect(
      toggleAgentSelection(['a1', 'a2', 'b7'], ['a1', 'a3'], 'a2')
    ).toEqual(['a1', 'a2'])
  })

  it('drops the stale key as it writes, so the link stops carrying what is gone', () => {
    expect(
      toggleAgentSelection(['a1', 'a2', 'b7'], ['a1', 'a3'], 'b7')
    ).toEqual(['a1', 'b7'])
  })
})

/**
 * The copy must not tell a customer to pick "Last 30 days" and then type a
 * count. Rolling writes no startDate and no endDate (date-range.ts
 * returns {} and adds range=rolling), so windowIsAnchored stays false, the
 * count is never read back, and the same empty panel reappears with nothing to
 * explain it. The gate reads the picker's own mapping rather than a list, so a
 * mode that stops anchoring can never be left in the copy.
 */
describe('the dates copy names only the modes that anchor a window', () => {
  const MODE_LABELS: Record<DateRangeSelection['mode'], string> = {
    month: 'Month',
    rolling: 'Last 30 days',
    custom: 'Custom',
  }

  const EVERY_MODE: DateRangeSelection[] = [
    { mode: 'month', monthsAgo: 0 },
    { mode: 'rolling' },
    { mode: 'custom', startDate: WINDOW.startDate, endDate: WINDOW.endDate },
  ]

  const anchors = (selection: DateRangeSelection): boolean =>
    windowIsAnchored(selectionToUrlParams(selection))

  const SENTENCES = [
    WITHOUT_AI_COPY.emptyCountNeedsDates(WORK_ITEM_NOUN_PLURAL),
    WITHOUT_AI_COPY.countNeedsDatesHelper,
  ]

  it('the picker has exactly one mode that writes no dates', () => {
    expect(EVERY_MODE.filter((mode) => !anchors(mode))).toEqual([
      { mode: 'rolling' },
    ])
  })

  it.each(SENTENCES)('%s names every anchoring mode', (sentence) => {
    for (const selection of EVERY_MODE.filter(anchors)) {
      expect(sentence).toContain(MODE_LABELS[selection.mode])
    }
  })

  it.each(SENTENCES)('%s names no mode that cannot work', (sentence) => {
    for (const selection of EVERY_MODE.filter((mode) => !anchors(mode))) {
      expect(sentence).not.toContain(MODE_LABELS[selection.mode])
    }
  })
})

describe('the copy this block puts on screen', () => {
  const EVERY_STRING: string[] = [
    ...Object.values(WITHOUT_AI_COPY).flatMap((value) =>
      typeof value === 'string' ? [value] : []
    ),
    WITHOUT_AI_COPY.intro(WINDOW.startDate, WINDOW.endDate),
    WITHOUT_AI_COPY.emptyNoCount(
      WORK_ITEM_NOUN_PLURAL,
      WINDOW.startDate,
      WINDOW.endDate
    ),
    WITHOUT_AI_COPY.emptyCountNeedsDates(WORK_ITEM_NOUN_PLURAL),
    WITHOUT_AI_COPY.countLabel(
      WORK_ITEM_NOUN_PLURAL,
      WINDOW.startDate,
      WINDOW.endDate
    ),
    WITHOUT_AI_COPY.countMeasuredNote(WORK_ITEM_NOUN_PLURAL),
    WITHOUT_AI_COPY.costPerItemLabel(WORK_ITEM_NOUN),
    WITHOUT_AI_COPY.methodChoice.perItem(WORK_ITEM_NOUN),
    WITHOUT_AI_COPY.methodChoice.peopleTime,
    WITHOUT_AI_COPY.methodChoice.periodTotal,
    WITHOUT_AI_COPY.methodFieldNames.costPerItem(WORK_ITEM_NOUN),
    WITHOUT_AI_COPY.methodFieldNames.hoursPerMonth,
    WITHOUT_AI_COPY.methodFieldNames.hourlyRate,
    WITHOUT_AI_COPY.methodFieldNames.costPerMonth,
    WITHOUT_AI_COPY.methodIncomplete(missingMethodFields('peopleTime', {})),
    WITHOUT_AI_COPY.agentScopeRowLabel('Contract Summary'),
    ...WITHOUT_AI_METHODS.map((method) =>
      estimateLabelFor(method, WORK_ITEM_NOUN)
    ),
    comparison(buildWithoutAi(perItem(100, 57))).paragraph,
    comparison(
      buildWithoutAi(
        input({ assumptions: { ...PEOPLE_TIME, revenuePerMonth: 5000 } })
      )
    ).paragraph,
  ]

  it('has strings to check (guards against a silently-empty suite)', () => {
    expect(EVERY_STRING.length).toBeGreaterThan(25)
  })

  it('uses no em dash and no exclamation mark, and never says "just"', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(/—/)
      expect(value).not.toMatch(/!/)
      expect(value).not.toMatch(/\bjust\b/i)
    }
  })

  it('never says "starting" or "baseline", which both mean something else here', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(/\bstarting\b/i)
      expect(value).not.toMatch(/\bbaselines?\b/i)
    }
  })

  it('carries none of the banned vertical vocabulary', () => {
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(
        /\b(matter|matters|legal|law|firm|firms|case|cases)\b/i
      )
    }
  })

  it('says "Without AI", never "Without us"', () => {
    expect(WITHOUT_AI_COPY.heading).toBe('Without AI')
    for (const value of EVERY_STRING) {
      expect(value).not.toMatch(/without us/i)
    }
  })

  it('the intro is the designed sentence, word for word', () => {
    expect(WITHOUT_AI_COPY.intro(WINDOW.startDate, WINDOW.endDate)).toBe(
      `We measured what your AI cost between ${START} and ${END} for the agents checked in the What you used AI for table, and what those agents brought in. Tell us what the same work cost without AI and we show the difference. Your estimates stay labeled as yours everywhere: on this page, in the print and in the data.`
    )
  })

  it('the salary helper sits on the hourly rate, where somebody has to convert a wage', () => {
    expect(WITHOUT_AI_COPY.hourlyRateHelper).toBe(
      '$65,000 a year is about $31 an hour.'
    )
  })

  it('asks for both forms of the noun, because it will not invent one from the other', () => {
    expect(WITHOUT_AI_COPY.unitSingularLabel).toBe('What do you call one?')
    expect(WITHOUT_AI_COPY.unitPluralLabel).toBe('And more than one?')
    expect(resolveUnitNouns({ unitSingular: 'paper' }).plural).toBe(
      WORK_ITEM_NOUN_PLURAL
    )
  })

  it('the noun helpers name the placeholder the block actually falls back to', () => {
    expect(WITHOUT_AI_COPY.unitSingularHelper).toContain(
      `We use ${WORK_ITEM_NOUN} until`
    )
    expect(WITHOUT_AI_COPY.unitPluralHelper).toContain(
      `We use ${WORK_ITEM_NOUN_PLURAL} until`
    )
    // A noun typed out here would not follow a rename. work-item-noun.ts holds
    // the name, so a rename is one edit.
    const source = readFileSync(
      join(__dirname, '..', 'report-derivation.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/We use work items? until/)
  })

  it('the copy carries no unit-name gate, scope apology or period-total override', () => {
    const source = readFileSync(
      join(__dirname, '..', 'report-derivation.ts'),
      'utf8'
    )
    // No gate that blocks a customer who has not named a unit.
    expect(source).not.toMatch(/what do you call one finished piece of work/i)
    // No line apologising that the count and the cost cover two scopes.
    expect(source).not.toMatch(/including any AI work that wasn/i)
    // No period-total override.
    expect(source).not.toMatch(/periodTotalWinsNote/)
    expect(source).not.toMatch(/beforeAiPeriodTotal/)
  })
})

describe('source pins — the block renders through the builder and formats nothing', () => {
  const FEATURE_DIR = join(__dirname, '..')
  const withoutAiSrc = readFileSync(
    join(FEATURE_DIR, 'components', 'without-ai.tsx'),
    'utf8'
  )
  const derivationSrc = readFileSync(
    join(FEATURE_DIR, 'report-derivation.ts'),
    'utf8'
  )
  const actionSrc = readFileSync(
    join(
      FEATURE_DIR,
      '..',
      '..',
      '..',
      'app',
      'actions',
      'org-roi-assumptions.ts'
    ),
    'utf8'
  )

  it('the component never formats money or dates itself', () => {
    expect(withoutAiSrc).not.toMatch(/@\/lib\/canon-format/)
    expect(withoutAiSrc).not.toMatch(/@\/lib\/canon-date/)
    expect(withoutAiSrc).not.toMatch(/\.toFixed\(/)
    expect(withoutAiSrc).not.toMatch(/\bformatCost\s*\(/)
    expect(withoutAiSrc).not.toMatch(/\bformatPct\s*\(/)
    expect(withoutAiSrc).not.toMatch(/\.toLocaleString\(/)
  })

  it('the component renders what the builder returned, never a paragraph of its own', () => {
    expect(withoutAiSrc).toMatch(/from '\.\.\/report-derivation'/)
    expect(withoutAiSrc).toMatch(/\bWITHOUT_AI_COPY\b/)
    expect(withoutAiSrc).not.toMatch(/buildWithoutAi\(/)
  })

  it('the component holds no inline prose', () => {
    const withoutComments = withoutAiSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    const proseNodes = (withoutComments.match(/>[^<>{}]+</g) ?? [])
      .map((fragment) => fragment.slice(1, -1).trim())
      .filter((fragment) => /^[A-Za-z][A-Za-z ,.'-]{3,}$/.test(fragment))
    expect(proseNodes).toEqual([])
  })

  it('every field the panel commits has an input the customer can type into', () => {
    // The plural drives the count question and the board paragraph, the
    // singular the rate label. Collect one and the paragraph contradicts itself.
    const at = withoutAiSrc.indexOf('interface DraftFields {')
    const shape = withoutAiSrc.slice(at, withoutAiSrc.indexOf('\n}', at))
    const fields = [...shape.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
    expect(fields).toContain('unitSingular')
    expect(fields).toContain('unitPlural')
    for (const field of fields) {
      expect(withoutAiSrc).toContain(`setField('${field}')`)
    }
  })

  it('the panel refuses a half-filled method before it writes and says "Saved"', () => {
    const guard = withoutAiSrc.indexOf('missingMethodFields(')
    const write = withoutAiSrc.indexOf('saveOrgRoiAssumptions(')
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(write)
  })

  it('the org fields and the window field are stored in two different places', () => {
    // A count stored on the org would be a wrong number against any other date
    // range, not a stale one. The split is the whole storage decision.
    for (const persisted of [
      'method',
      'unitSingular',
      'unitPlural',
      'costPerItem',
      'hoursPerMonth',
      'hourlyRate',
      'costPerMonth',
      'revenuePerMonth',
    ]) {
      expect(actionSrc).toContain(persisted)
    }
    expect(actionSrc).not.toContain('unitsCompleted')
    expect(actionSrc).not.toContain('measuredCount')
  })

  it('the action stores exactly the fields the builder reads, and no others', () => {
    const at = derivationSrc.indexOf('export interface RoiAssumptions {')
    const shape = derivationSrc.slice(at, derivationSrc.indexOf('\n}', at))
    const fields = [...shape.matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1])
    expect(fields).toEqual([
      'method',
      'unitSingular',
      'unitPlural',
      'costPerItem',
      'hoursPerMonth',
      'hourlyRate',
      'costPerMonth',
      'revenuePerMonth',
    ])
    const storedAt = actionSrc.indexOf('export interface OrgRoiAssumptions {')
    const stored = actionSrc.slice(storedAt, actionSrc.indexOf('\n}', storedAt))
    for (const field of fields) {
      expect(stored).toContain(`${field}?:`)
    }
  })

  it('the builder owns the comparison — the derivation is where the math lives', () => {
    expect(derivationSrc).toMatch(/export function buildWithoutAi\(/)
  })
})
