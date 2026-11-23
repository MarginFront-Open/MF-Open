/**
 * WHAT THIS FILE DOES: reads the FinOps Settings feature's SOURCE CODE as
 *   plain text and asserts the editors are wired correctly: the page stacks
 *   both editors, each editor self-fetches its own data, and each carries the
 *   add/delete/restore handlers. It does NOT render anything.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST (and not a normal render test):
 *   The dashboard's jest suite runs in a NODE environment with NO jsdom and NO
 *   React Testing Library (see jest.config.ts: testEnvironment 'node'). So we
 *   read the .tsx files as strings and assert on their contents, the same
 *   pattern the other cost-management source tests use.
 *
 * CONNECTS TO: the files it guards —
 *   - ../index.tsx (the page that stacks the two editors)
 *   - ../components/classification-rules-editor.tsx
 *   - ../components/chart-of-accounts-editor.tsx
 *   - ../../../../app/(dashboard)/finops-settings/page.tsx (the route)
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
// Strip block + JSX comments and full-line `//` comments so "absence"
// assertions test the CODE, not the explanatory comments.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const indexSrc = read('../index.tsx')
const rulesSrc = read('../components/classification-rules-editor.tsx')
const glSrc = read('../components/chart-of-accounts-editor.tsx')
const routeSrc = read('../../../../app/(dashboard)/finops-settings/page.tsx')

describe('FinOps Settings page stacks both editors', () => {
  it('imports both editors', () => {
    expect(indexSrc).toContain(
      "import ClassificationRulesEditor from './components/classification-rules-editor'"
    )
    expect(indexSrc).toContain(
      "import ChartOfAccountsEditor from './components/chart-of-accounts-editor'"
    )
  })

  it('renders both editors', () => {
    expect(indexSrc).toContain('<ClassificationRulesEditor />')
    expect(indexSrc).toContain('<ChartOfAccountsEditor />')
  })

  it('carries no standalone page chrome', () => {
    // Comment-stripped: the file header may name the page chrome.
    const code = stripComments(indexSrc)
    expect(code).not.toContain("title='FinOps Settings'")
    expect(code).not.toContain('breadcrumb')
  })

  it('/finops-settings redirects to the Settings tab instead of rendering the feature', () => {
    expect(routeSrc).toContain("redirect('/finops?tab=settings')")
    expect(routeSrc).not.toContain('<FinopsSettings />')
  })
})

describe('Classification rules editor self-fetches and owns its mutations', () => {
  it('is a client component', () => {
    expect(rulesSrc.startsWith("'use client'")).toBe(true)
  })

  it('self-fetches its rules (and signals for the agent scope list)', () => {
    expect(rulesSrc).toContain('getClassificationRules')
    // The Scope dropdown + rule-list agent column need the org's agent list,
    // derived from the loaded signals.
    expect(rulesSrc).toContain('getSignalsForClassification')
  })

  it('carries all three rule mutation actions', () => {
    expect(rulesSrc).toContain('upsertClassificationRule')
    expect(rulesSrc).toContain('deleteClassificationRule')
    expect(rulesSrc).toContain('restoreDefaultClassificationRules')
  })

  it('carries the three rule handlers', () => {
    const code = stripComments(rulesSrc)
    expect(code).toContain('const handleAddRule')
    expect(code).toContain('const handleDeleteRule')
    expect(code).toContain('const handleRestoreDefaults')
  })
})

describe('Chart of accounts editor self-fetches and owns its mutations', () => {
  it('is a client component', () => {
    expect(glSrc.startsWith("'use client'")).toBe(true)
  })

  it('self-fetches its GL codes', () => {
    expect(glSrc).toContain('getChartOfAccounts')
  })

  it('carries all three GL mutation actions', () => {
    expect(glSrc).toContain('upsertGlCode')
    expect(glSrc).toContain('deleteGlCode')
    expect(glSrc).toContain('restoreDefaultGlCodes')
  })

  it('carries the three GL handlers', () => {
    const code = stripComments(glSrc)
    expect(code).toContain('const handleAddGlCode')
    expect(code).toContain('const handleDeleteGlCode')
    expect(code).toContain('const handleRestoreGlDefaults')
  })

  it('does NOT re-fetch signals on delete (no signals table on this page)', () => {
    // The Settings page has no signals table, so delete must not refetch
    // signals (server-side revalidatePath re-syncs Cost Management).
    // Comment-stripped so an explanatory note doesn't trip it.
    const code = stripComments(glSrc)
    expect(code).not.toContain('getSignalsForClassification')
  })
})

describe('GL editor: type derivation, delete safety, mismatch banner', () => {
  // jsdom + RTL are not installed (see header), so we guard the
  // UI WIRING with source assertions, the same way the cases
  // above do. The behavioral guarantees live in the action-layer test
  // (app/actions/__tests__/chart-of-accounts-validation.test.ts).
  const glCode = stripComments(glSrc)

  it('derives the accounting type one-way from the category', () => {
    // The map is imported and the type is computed from the category; there is
    // no independent Type <Select> setter.
    expect(glSrc).toContain('CATEGORY_TO_ACCOUNTING_TYPE')
    expect(glCode).toContain('CATEGORY_TO_ACCOUNTING_TYPE[newGlCategory]')
    expect(glCode).not.toContain('setNewGlAccountingType')
  })

  it('gates GL-code delete behind an AlertDialog that fetches the impact count', () => {
    expect(glSrc).toContain("from '@/components/ui/alert-dialog'")
    expect(glCode).toContain('AlertDialog')
    expect(glCode).toContain('getGlCodeSignalCount')
  })

  it('reports the orphaned-signal count after a delete', () => {
    expect(glCode).toContain('orphanedSignalCount')
  })

  it('renders the mismatch reconciliation banner from a count', () => {
    expect(glCode).toContain('getMismatchedSignalCount')
    expect(glCode).toContain('mismatchCount')
  })
})

describe('Rules editor: delete success toast (no dialog)', () => {
  it('shows a success toast on rule delete', () => {
    const code = stripComments(rulesSrc)
    expect(code).toContain("title: 'Rule deleted'")
  })

  it('does NOT add a confirmation dialog for rule delete (rules are advisory)', () => {
    // Deleting a rule un-maps nothing, so it stays a single-click + toast.
    expect(rulesSrc).not.toContain('alert-dialog')
  })
})
