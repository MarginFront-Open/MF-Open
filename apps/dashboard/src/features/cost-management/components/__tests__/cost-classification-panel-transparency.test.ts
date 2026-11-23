/**
 * WHAT THIS FILE DOES: Locks the transparency copy in the Cost
 *   Management classification panel:
 *     - the "Suggest classifications" toast says honestly where each bucket
 *       came from (a classification rule or the name guesser).
 *     - the Signals table explains that classifying is retroactive: past
 *       and future events re-bucket with no separate backfill.
 *     - revenue figures are labeled with a tooltip, never a bare
 *       "$X revenue". The canon-labeled revenue figure lives in the CFO Charts
 *       panel (../cfo-charts-panel.tsx), earned (usageRevenue) vs total
 *       (totalRevenueHero), and the classification panel renders no bare
 *       revenue figure.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST (not a render test): the dashboard jest
 *   suite runs in a NODE environment with NO jsdom and NO React Testing
 *   Library (jest.config.ts: testEnvironment 'node'), and jsdom/RTL are not
 *   installed. So we read the .tsx source as text and assert the required
 *   strings are present and the forbidden ones are absent, the
 *   same guardrail style as cost-classification-panel-margin-language.test.ts. The one
 *   real behavior check (bottom) runs against the pure classification utils,
 *   which need no DOM.
 *
 * CONNECTS TO: ../cost-classification-panel.tsx (the component these guard) and
 *   ../../classification-utils.ts (the rule/guesser functions whose null vs
 *   non-null return is exactly the provenance distinction the toast surfaces).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  evaluateRulesForSignal,
  suggestCostCategoryForSignalName,
} from '../../classification-utils'

const panelSource = readFileSync(
  join(__dirname, '../cost-classification-panel.tsx'),
  'utf8'
)
// The revenue label lives in the CFO Charts panel.
const cfoPanelSource = readFileSync(
  join(__dirname, '../cfo-charts-panel.tsx'),
  'utf8'
)

describe('Suggest toast tells the truth about provenance', () => {
  it('does not hardcode "from your classification rules" for every signal', () => {
    // This phrasing credits the org's rules for the whole batch, which is
    // false when some buckets came from the name guesser.
    expect(panelSource).not.toContain(
      'updated from your classification rules. Tweak any below.'
    )
  })

  it('counts rule matches vs name guesses separately', () => {
    // The panel branches on whether evaluateRulesForSignal returned a match.
    expect(panelSource).toContain('ruleMatched++')
    expect(panelSource).toContain('nameGuessed++')
  })

  it('names the name guesser when no rule matched', () => {
    expect(panelSource).toMatch(
      /guessed from the signal name \(no rule matched\)/
    )
  })

  it('reminds the user the change is reversible per-row', () => {
    expect(panelSource).toMatch(/Review or change any row below/)
  })
})

describe('retroactive backfill is explained', () => {
  it('states classifying applies to past and future events with no backfill', () => {
    expect(panelSource).toMatch(
      /past and\s*\n?\s*future\. No backfill needed\./
    )
  })
})

describe('revenue figures are labeled, not bare', () => {
  it('labels the revenue figure as "Total Revenue" (on the CFO Charts panel)', () => {
    expect(cfoPanelSource).toContain('Total Revenue')
  })

  it('keeps the classification panel free of any bare revenue label', () => {
    // The panel must not render a bare "{formatCurrency(data.revenue)} revenue"
    // figure at all.
    expect(panelSource).not.toMatch(/data\.revenue\)}\s*revenue/)
  })

  it('attaches the canon Total Revenue tooltip on the CFO Charts panel (consistent with the Money command center)', () => {
    expect(cfoPanelSource).toContain('tooltipDefinitions.totalRevenueHero')
  })
})

describe('provenance distinction is real (behavior anchor)', () => {
  // This is WHY the toast must distinguish: with no matching rule,
  // evaluateRulesForSignal returns null and the panel falls back to the name
  // guesser. Crediting "your rules" in that case is false.
  it('returns null when no rule matches → guesser must run', () => {
    const noRules = evaluateRulesForSignal('finops-test-manual', 'agent-1', [])
    expect(noRules).toBeNull()
    // The guesser still produces a category — that is the "name guess" path.
    expect(suggestCostCategoryForSignalName('finops-test-manual')).toBe(
      'DEVELOPMENT_RD'
    )
  })

  it('returns the rule category when a rule matches → "your rules" is true', () => {
    const matched = evaluateRulesForSignal('prod-inference', 'agent-1', [
      {
        id: 'r1',
        pattern: 'prod',
        category: 'PRODUCTION_COGS',
        agentId: null,
        priority: 100,
        isDefault: false,
      },
    ])
    expect(matched).toBe('PRODUCTION_COGS')
  })
})
