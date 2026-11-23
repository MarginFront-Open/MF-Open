/**
 * Initiative-dialog copy: the dialog explains why you're entering what
 * you're entering, and how progress gets tracked. Dashboard jest is
 * node-only, no RTL — source-assert, same idiom as the sibling
 * page-composition / initiative-dialog tests in this directory.
 *
 * handleSubmit is not byte-pinned, because it carries the auto-derived
 * starting-value logic. The structural pins at the bottom keep the parts that
 * must not drift (validation messages, both branches submitting the full
 * targetsPayload, failure branches refreshing the page); the baseline
 * submission rule itself is behavior-tested in baseline-derivation.test.ts
 * and wired in auto-baseline-source.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const componentSrc = readFileSync(
  join(__dirname, '..', 'components', 'initiative-dialog.tsx'),
  'utf8'
)
const derivationSrc = readFileSync(
  join(__dirname, '..', 'report-derivation.ts'),
  'utf8'
)

/**
 * JSX text children wrap at prettier's printWidth, so the exact newline
 * position inside a sentence is not stable across formatting passes. Collapse
 * all whitespace runs to a single space before matching prose so these
 * assertions pin the WORDS, not incidental line breaks.
 */
const flatSrc = componentSrc.replace(/\s+/g, ' ')

describe('initiative-dialog.tsx — intro line', () => {
  it("states the dialog's job in one DialogDescription sentence: pick a goal, set a target, progress tracks automatically, nothing manual", () => {
    expect(componentSrc).toMatch(/<DialogDescription\b[^>]*>/)
    expect(flatSrc).toContain(
      'Pick a goal and set a target, and progress is tracked automatically from your real usage, cost, and revenue data, so you never update it by hand.'
    )
  })
})

describe('initiative-dialog.tsx — per-field helper text', () => {
  it('Name: explains where it shows up (the card + the board export)', () => {
    expect(flatSrc).toContain(
      'Appears as the headline on this card and in the board-ready export.'
    )
  })

  it('dates: names the window and the open-end convention', () => {
    expect(flatSrc).toContain(
      'This is the window we measure. Leave the end date blank for an ongoing goal.'
    )
  })

  it('target value: states it is the goal, compared automatically', () => {
    expect(flatSrc).toContain(
      'The goal you are aiming for. Your card compares it to the real, current number automatically.'
    )
  })

  it('starting value (baseline): honestly says the app measured it, and when it could not', () => {
    expect(flatSrc).not.toContain(
      'You type this in yourself. It is not calculated automatically.'
    )
    expect(flatSrc).toContain(
      'Measured from your data over the matching period right before your start date. Override it only if you know better.'
    )
  })
})

describe('initiative-dialog.tsx — one honest sentence per metric option', () => {
  // The registry lives in report-derivation.ts so the dialog, the report
  // tiles and the print render ONE copy of each sentence.
  it('renders a TOTAL description map next to the select, covering every InitiativeMetric', () => {
    expect(derivationSrc).toMatch(
      /export const METRIC_DESCRIPTIONS: Record<InitiativeMetric, string> = \{/
    )
    expect(componentSrc).toMatch(
      /import \{[^}]*\bMETRIC_DESCRIPTIONS\b[^}]*\} from '\.\.\/report-derivation'/s
    )
    expect(componentSrc).toMatch(/\{METRIC_DESCRIPTIONS\[row\.metric\]\}/)
  })

  it('has exactly one entry per InitiativeMetric union member (mirrors the INITIATIVE_METRIC_META totality pattern)', () => {
    const ALL_METRICS = [
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
      expect(derivationSrc).toMatch(new RegExp(`\\b${metric}:`))
    }
  })

  it('offers no separate new-seats note — the per-metric description right under the select covers it', () => {
    expect(componentSrc).not.toMatch(/new seats/)
    expect(componentSrc).not.toMatch(/aren(?:'|&apos;)t trackable yet/)
    expect(componentSrc).not.toMatch(
      /no\s+history exists to compute them honestly/
    )
  })

  it('never claims a metric is auto-derived from history it does not have (no fake precision)', () => {
    expect(componentSrc).not.toMatch(
      /calculated for you|derived automatically from history/
    )
  })
})

describe('initiative-dialog.tsx — confirmation copy', () => {
  it('both toasts carry their titles and spell out what happens next', () => {
    expect(componentSrc).toMatch(/title: 'Goal saved'/)
    expect(componentSrc).toMatch(/title: 'Goal created'/)
    const whatHappensNext =
      'Progress updates as new events land. Check the card on this page, or export the board-ready view.'
    expect(
      flatSrc.split(whatHappensNext).length - 1 // occurrence count
    ).toBe(2)
  })

  it('the create toast opens with the "tracked against your real numbers" line', () => {
    expect(flatSrc).toContain('is now tracked against your real numbers.')
  })
})

describe('initiative-dialog.tsx — copy microstyle rules on the dialog strings', () => {
  const NEW_COPY_STRINGS = [
    'Pick a goal and set a target, and progress is tracked automatically from your real usage, cost, and revenue data, so you never update it by hand.',
    'Appears as the headline on this card and in the board-ready export.',
    'This is the window we measure. Leave the end date blank for an ongoing goal.',
    'The goal you are aiming for. Your card compares it to the real, current number automatically.',
    'Measured from your data over the matching period right before your start date. Override it only if you know better.',
    'Progress updates as new events land. Check the card on this page, or export the board-ready view.',
  ]

  it('every new copy string is present verbatim (whitespace-normalized)', () => {
    for (const s of NEW_COPY_STRINGS) {
      expect(flatSrc).toContain(s)
    }
  })

  it('none of the new copy strings use an em dash or an exclamation mark', () => {
    for (const s of NEW_COPY_STRINGS) {
      expect(s).not.toMatch(/—/)
      expect(s).not.toMatch(/!/)
    }
  })

  it('every METRIC_DESCRIPTIONS sentence avoids em dashes and exclamation marks too', () => {
    const mapStart = derivationSrc.indexOf(
      'export const METRIC_DESCRIPTIONS: Record<InitiativeMetric, string> = {'
    )
    const mapEnd = derivationSrc.indexOf('\n}', mapStart)
    const mapBody = derivationSrc.slice(mapStart, mapEnd)
    expect(mapBody).not.toMatch(/—/)
    expect(mapBody).not.toMatch(/!/)
  })
})

describe('initiative-dialog.tsx — handleSubmit structural pins (the parts that must not drift)', () => {
  const start = componentSrc.indexOf('const handleSubmit = async () => {')
  const end = componentSrc.indexOf('\n\n  return (', start)
  const handleSubmit = componentSrc.slice(start, end)

  it('anchors exist — component structure has not moved', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('keeps all four validation messages pinned', () => {
    expect(handleSubmit).toContain("setFormError('Name is required')")
    expect(handleSubmit).toContain("setFormError('Start date is required')")
    expect(handleSubmit).toContain(
      "setFormError('Each target needs a numeric target value')"
    )
    expect(handleSubmit).toContain(
      '`${baselineFieldLabel(row, endDate)} must be a number, or leave it blank`'
    )
  })

  it('the starting-value message names the field the customer is looking at, not a second hardcoded label', () => {
    expect(componentSrc).not.toContain('Starting value must be a number')
    expect(handleSubmit).toContain('baselineFieldLabel(')
  })

  it('BOTH branches submit the FULL targetsPayload and surface failures via fail()', () => {
    expect(handleSubmit).toMatch(
      /setInitiativeTargets\(\s*initiative\.id,\s*targetsPayload\s*\)/
    )
    expect(handleSubmit).toMatch(
      /setInitiativeTargets\(\s*created\.data\.id,\s*targetsPayload\s*\)/
    )
    expect(handleSubmit).toContain('fail("Couldn\'t save the goal"')
    expect(handleSubmit).toContain('fail("Couldn\'t create the goal"')
  })

  it('a failed target save still refreshes the page (onSaved) and keeps the dialog open', () => {
    const failureRefreshes = handleSubmit.match(
      /fail\([\s\S]{0,200}?\)\s*\n\s*onSaved\(\)\s*\n\s*return/g
    )
    expect(failureRefreshes).toHaveLength(2)
  })

  it('pending always resets — the try/finally survives', () => {
    expect(handleSubmit).toMatch(/finally \{\s*\n\s*setPending\(false\)/)
  })

  it('updateInitiative runs BEFORE setInitiativeTargets — targets measure against the stored dates', () => {
    const updateIdx = handleSubmit.indexOf('updateInitiative(')
    const targetsIdx = handleSubmit.indexOf('setInitiativeTargets(')
    expect(updateIdx).toBeGreaterThan(-1)
    expect(targetsIdx).toBeGreaterThan(updateIdx)
  })
})

/**
 * The starting-value helper speaks in one voice across every state of the
 * field: contracted throughout, and never the word "just", including the
 * string a customer sees when something has already gone wrong.
 */
describe('initiative-dialog.tsx — baselineHelperCopy speaks in one voice', () => {
  const start = componentSrc.indexOf('function baselineHelperCopy(')
  const helper = componentSrc.slice(start, componentSrc.indexOf('\n}', start))
  /** Only what the function RETURNS: source operators like !== are not copy. */
  const helperCopy = (
    helper.match(/return\s+(['"])(?:\\.|(?!\1).)*\1/g) ?? []
  ).map((line) => line.replace(/^return\s+/, '').slice(1, -1))

  it('the anchor exists — the helper has not moved or been renamed', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('never says "just"', () => {
    expect(helper).not.toMatch(/\bjust\b/i)
    expect(componentSrc).not.toContain('We could not measure this just now.')
  })

  it('the failed-measurement string tells the customer what to do next, contracted', () => {
    expect(helper).toContain(
      "We couldn't measure this right now. Leave it blank and we'll measure it when you save, or type your own."
    )
  })

  it('every "we will" is contracted, in every state of the field', () => {
    expect(helper).not.toMatch(/\bwe will\b/i)
    expect(helper).not.toMatch(/\bcould not\b/i)
    for (const line of [
      "Pick a start date first and we'll measure this from your data.",
      "Your override. We'll use this instead of the measured value.",
      "Cleared. We'll measure a fresh one from your data when you save.",
      "You set this by hand. Clear it and we'll measure one from your data when you save.",
    ]) {
      expect(helper).toContain(line)
    }
  })

  it('has strings to check, and none uses an em dash or an exclamation mark', () => {
    expect(helperCopy.length).toBeGreaterThan(5)
    for (const line of helperCopy) {
      expect(line).not.toMatch(/—/)
      expect(line).not.toMatch(/!/)
    }
  })
})
