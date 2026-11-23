/**
 * WHAT THIS FILE DOES: Locks the Cost Management panel's margin language by
 *   reading the panel's SOURCE CODE as plain text. It does not render anything.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST (and not a normal render test):
 *   The dashboard's jest suite runs in a NODE environment with NO jsdom and NO
 *   React Testing Library (see jest.config.ts: testEnvironment 'node'). So we
 *   cannot mount <CostClassificationPanel /> and read the DOM. Instead we read
 *   the .tsx file as a string and assert on its contents. This is a guardrail,
 *   not a behavior test.
 *
 * WHY IT EXISTS: AI gross margin is computed on CLASSIFIED COGS only;
 *   uncategorized cost is its own bucket, never folded into COGS. Month-end
 *   close applies that rule, and this panel must not contradict it with
 *   "counted as COGS" or "(conservative)" language. The margin math itself is
 *   exercised at the action level in
 *   app/actions/__tests__/cost-classification-margin.test.ts.
 *
 * CONNECTS TO: ../cost-classification-panel.tsx (the component this guards) and
 *   the getCostClassificationBreakdown action in cost-command-center.ts (the
 *   source of cogsCost / unclassifiedCost the action computes).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('CostClassificationPanel margin-language source-level guard', () => {
  // Read the panel source. This test file lives in
  // src/features/cost-management/components/__tests__/, so the panel is one
  // directory up.
  const panelSource = readFileSync(
    join(__dirname, '../cost-classification-panel.tsx'),
    'utf8'
  )

  it('does NOT fold unclassified cost into the COGS dollar line', () => {
    // Classified + unclassified must never be summed into one figure in the
    // panel.
    expect(panelSource).not.toContain('data.cogsCost + data.unclassifiedCost')
  })

  it('never claims uncategorized cost is counted as COGS', () => {
    // Copy saying unclassified cost is "counted as COGS in the headline
    // below" would contradict the margin math.
    expect(panelSource).not.toMatch(/counted as COGS/i)
  })

  it('shows no "(conservative)" margin badge', () => {
    // The margin is classified-only regardless of unclassified cost, so a
    // "(conservative)" qualifier on the headline numbers mislabels them.
    expect(panelSource).not.toContain('(conservative)')
  })
})
