/**
 * WHAT THIS FILE DOES: Checks how the work is split between Cost Management
 *   and FinOps Settings, from the Cost Management side. It reads the panel +
 *   sidebar SOURCE as plain text and asserts:
 *     - the panel has no rules or GL EDITORS (those live on FinOps Settings),
 *     - the panel has no journal-by-GL TABLE (it lives only on Month-End
 *       Close),
 *     - BUT the panel LOADS rules + GL read-only and keeps the signals
 *       table, the Suggest button, and the journal CSV export,
 *     - and the sidebar has no "FinOps Settings" entry; the
 *       /finops-settings route stays reachable, but not from the nav.
 *   It does NOT render anything.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST (not a render test): the dashboard jest
 *   suite runs in a NODE environment with NO jsdom and NO React Testing Library
 *   (jest.config.ts: testEnvironment 'node'), and jsdom/RTL are not installed.
 *   So we read the .tsx/.ts source as text, the same guardrail style as
 *   cost-management-panels.test.ts.
 *
 * CONNECTS TO: ../components/cost-classification-panel.tsx (the panel) and
 *   ../../../components/layout/data/sidebar-data.ts (the nav).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const panelSrc = readFileSync(
  join(__dirname, '../components/cost-classification-panel.tsx'),
  'utf8'
)
const sidebarSrc = readFileSync(
  join(__dirname, '../../../components/layout/data/sidebar-data.ts'),
  'utf8'
)

// Strip block + JSX comments and full-line `//` comments so "absence"
// assertions test the CODE, not the panel's own explanatory comments.
const panelCode = panelSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('the Cost Management panel holds no rule or GL editors', () => {
  it('imports no rule mutation actions (read-only)', () => {
    expect(panelCode).not.toContain('upsertClassificationRule')
    expect(panelCode).not.toContain('deleteClassificationRule')
    expect(panelCode).not.toContain('restoreDefaultClassificationRules')
  })

  it('imports no GL mutation actions (read-only)', () => {
    expect(panelCode).not.toContain('upsertGlCode')
    expect(panelCode).not.toContain('deleteGlCode')
    expect(panelCode).not.toContain('restoreDefaultGlCodes')
  })

  it('defines no editor handlers', () => {
    expect(panelCode).not.toContain('const handleAddRule')
    expect(panelCode).not.toContain('const handleAddGlCode')
    expect(panelCode).not.toContain('const handleRestoreGlDefaults')
  })
})

describe('the Cost Management panel has no journal-by-GL table', () => {
  it('renders no journal table (no per-GL rows)', () => {
    // "All AI cost for period" is the journal table's TOTAL row label.
    expect(panelCode).not.toContain('All AI cost for period')
    expect(panelCode).not.toContain('journal.rows')
  })
})

describe('Cost Management keeps its live working surface', () => {
  it('still LOADS rules + GL read-only (Suggest + GL-assign need the data)', () => {
    expect(panelSrc).toContain('getClassificationRules')
    expect(panelSrc).toContain('getChartOfAccounts')
  })

  it('still evaluates rules for the Suggest button', () => {
    expect(panelSrc).toContain('evaluateRulesForSignal')
  })

  it('still has the signals-table GL-assign dropdown', () => {
    expect(panelSrc).toContain('handleAssignGlCode')
    expect(panelSrc).toContain('assignSignalToGlCode')
  })

  it('still homes the journal CSV export button', () => {
    expect(panelSrc).toContain('/api/export/journal')
  })

  it('still warns when costs are unmapped (export context)', () => {
    expect(panelSrc).toContain('is unmapped')
  })
})

describe('FinOps Settings is off-nav', () => {
  // /finops-settings stays a reachable route, but the sidebar
  // carries no entry for it (title, url, GearSix icon, role gate).
  it('has no "FinOps Settings" sidebar entry', () => {
    expect(sidebarSrc).not.toContain("title: 'FinOps Settings'")
    expect(sidebarSrc).not.toContain("url: '/finops-settings'")
  })
})
