/**
 * The auto-baseline WIRING, source-asserted (node-only jest; the DB half
 * needs a live org). The pure derivation itself is behavior-tested in
 * baseline-derivation.test.ts; these pins prove the server actions actually
 * CALL it, and that the dialog doesn't pretend the value is manual-only.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const actionsSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'actions', 'initiatives.ts'),
  'utf8'
)
const dialogSrc = readFileSync(
  join(__dirname, '..', 'components', 'initiative-dialog.tsx'),
  'utf8'
)
const flatDialog = dialogSrc.replace(/\s+/g, ' ')

describe('initiatives.ts — setInitiativeTargets measures baselines server-side on save', () => {
  it('imports computeAutoBaselines from the shared composition', () => {
    expect(actionsSrc).toMatch(
      /import\s*\{\s*computeAutoBaselines\s*\}\s*from\s*'\.\/_shared\/initiative-actuals'/
    )
  })

  it('an auto row without a value is measured; every other row is stored as sent', () => {
    const fnStart = actionsSrc.indexOf(
      'export async function setInitiativeTargets'
    )
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = actionsSrc.slice(fnStart)
    expect(fnBody).toMatch(
      /baselineSource === 'auto' && t\.baselineValue === null/
    )
    expect(fnBody).toMatch(/await computeAutoBaselines\(/)
    expect(fnBody).toMatch(/measured\.get\(t\.metric\)/)
  })

  it('a caller with a value and no source stays manual; no value and no source measures', () => {
    expect(actionsSrc).toMatch(
      /t\.baselineSource \?\? \(t\.baselineValue != null \? 'manual' : 'auto'\)/
    )
  })

  it('measures against the INITIATIVE window — the stored start/end dates, sliced to bare dates', () => {
    const fnStart = actionsSrc.indexOf(
      'export async function setInitiativeTargets'
    )
    const fnBody = actionsSrc.slice(fnStart)
    expect(fnBody).toMatch(
      /startDate: existing\.startDate\.toISOString\(\)\.slice\(0, 10\)/
    )
  })

  it('the input schema accepts baselineSource as exactly auto|manual', () => {
    expect(actionsSrc).toMatch(/BASELINE_SOURCES = \['auto', 'manual'\]/)
    expect(actionsSrc).toMatch(
      /baselineSource: z\.enum\(BASELINE_SOURCES\)\.optional\(\)/
    )
  })

  it('serializes baselineSource on every read so the dialog can tell measured from typed', () => {
    expect(actionsSrc).toMatch(/baselineSource: \(t\.baselineSource \?\?/)
  })
})

describe('initiatives.ts — updateInitiative re-measures ONLY auto baselines, ONLY when the start date or the matter scope moves', () => {
  it('compares bare dates to detect a moved start', () => {
    expect(actionsSrc).toMatch(
      /nextStartDate\.toISOString\(\)\.slice\(0, 10\) !==\s*\n\s*existing\.startDate\.toISOString\(\)\.slice\(0, 10\)/
    )
  })

  it("filters to baselineSource === 'auto': manual rows and rows with no source are never touched", () => {
    const fnStart = actionsSrc.indexOf('export async function updateInitiative')
    const fnEnd = actionsSrc.indexOf('export async function deleteInitiative')
    const fnBody = actionsSrc.slice(fnStart, fnEnd)
    expect(fnBody).toMatch(/\(t\) => t\.baselineSource === 'auto'/)
    expect(fnBody).toMatch(/if \(startDateChanged \|\| scopeChanged\) \{/)
    expect(fnBody).toMatch(/await computeAutoBaselines\(/)
  })
})

describe('initiatives.ts — previewAutoBaselines (the dialog disclosure read)', () => {
  it('exists, is gated by the same money-manager check as the writes it feeds, and scopes by the gated org', () => {
    const fnStart = actionsSrc.indexOf(
      'export async function previewAutoBaselines'
    )
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = actionsSrc.slice(fnStart)
    expect(fnBody).toMatch(/await assertMoneyManager\(\)/)
    expect(fnBody).toMatch(/const orgId = gate\.orgId/)
    expect(fnBody).toMatch(/computeAutoBaselines\(/)
  })
})

describe('initiative-dialog.tsx — the field is a quiet override, honestly labeled', () => {
  it('does not claim the baseline is manual-only', () => {
    expect(flatDialog).not.toContain(
      'You type this in yourself. It is not calculated automatically.'
    )
    expect(dialogSrc).not.toMatch(
      /Starting value \(optional, used to show % progress\)/
    )
  })

  it('carries the measured-from-your-data copy', () => {
    expect(flatDialog).toContain(
      'Measured from your data over the matching period right before your start date. Override it only if you know better.'
    )
  })

  it('the field hides behind a disclosure that reuses the page label', () => {
    expect(dialogSrc).toMatch(
      /\$\{row\.baselineOpen \? 'Hide' : 'Adjust'\} \$\{baselineFieldLabel\(/
    )
    expect(dialogSrc).toMatch(/row\.baselineOpen && \(/)
  })

  it('submits through resolveBaselineSubmission — the pure, node-tested rule', () => {
    expect(dialogSrc).toMatch(
      /import\s*\{[^}]*\bresolveBaselineSubmission\b[^}]*\}\s*from\s*'\.\.\/baseline-derivation'/s
    )
    expect(dialogSrc).toMatch(/resolveBaselineSubmission\(\{/)
    expect(dialogSrc).toMatch(/startDateChanged,/)
    expect(dialogSrc).toMatch(/scopeChanged,/)
  })

  it('pre-fills the disclosure via previewAutoBaselines and never applies a stale result over typing', () => {
    expect(dialogSrc).toMatch(/previewAutoBaselines\(\{/)
    expect(dialogSrc).toMatch(
      /row\.metric !== metric \|\| row\.baselineTouched/
    )
  })

  it('mrr/arr stay honest — the unavailable state names the no-history fact', () => {
    expect(dialogSrc).toMatch(/AUTO_BASELINE_SUPPORTED/)
    expect(flatDialog).toContain(
      "We can't measure this metric as of a past date yet. Type this number in if you know it."
    )
  })

  it('none of the new baseline copy uses an em dash or an exclamation mark', () => {
    const helperStart = dialogSrc.indexOf('function baselineHelperCopy')
    const helperEnd = dialogSrc.indexOf('\n}', helperStart)
    const helperBody = dialogSrc.slice(helperStart, helperEnd)
    expect(helperBody).not.toMatch(/—/)
    expect(helperBody).not.toMatch(/!(?!==?)/)
  })
})
