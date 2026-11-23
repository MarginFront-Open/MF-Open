/**
 * WHAT THIS FILE DOES: Reads the Cost Management page's SOURCE CODE as plain
 *   text and asserts the page renders its FinOps panels, with no
 *   cost-dashboard widgets or their data plumbing. It does NOT render
 *   anything.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST (and not a normal render test):
 *   The dashboard's jest suite runs in a NODE environment with NO jsdom and NO
 *   React Testing Library (see jest.config.ts: testEnvironment 'node', scoped
 *   to the server side of the app), and jsdom/RTL are not installed. So we
 *   read index.tsx as a string and assert on its contents, the same pattern
 *   the sibling cost-classification-panel-margin-language test uses.
 *
 * WHY IT EXISTS: the panels must render unconditionally. If they sat behind
 *   a `{!loading && !error && costData && …}` guard with nothing setting
 *   costData, they would silently render blank. The "renders the FinOps
 *   panels outside any costData guard" test below checks exactly that.
 *
 * CONNECTS TO: ../index.tsx (the page this guards). The panels are
 *   ../components/cost-classification-panel.tsx and
 *   ../components/product-line-margin-panel.tsx.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('FinOps Cost Management panels (source guard)', () => {
  // This test lives in src/features/cost-management/__tests__/, so the page is
  // one directory up.
  const source = readFileSync(join(__dirname, '../index.tsx'), 'utf8')

  // Strip block comments (/** */ and JSX {/* */}) so the "absence" assertions
  // test the CODE, not the header comment in index.tsx.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')

  it('keeps both FinOps panels imported', () => {
    expect(code).toContain(
      "import CostClassificationPanel from './components/cost-classification-panel'"
    )
    expect(code).toContain(
      "import ProductLineMarginPanel from './components/product-line-margin-panel'"
    )
  })

  it('renders both FinOps panels', () => {
    // The page has a billing-period selector, so both panels render WITH a
    // `filter` prop (the selected calendar-month window).
    expect(code).toContain('<CostClassificationPanel filter={filter}')
    expect(code).toContain('<ProductLineMarginPanel filter={filter}')
  })

  it('does not import a ./api fetch module', () => {
    expect(code).not.toContain("from './api'")
  })

  it('renders no cost-dashboard widgets', () => {
    expect(code).not.toContain('<CostSummary')
    expect(code).not.toContain('<TimeSeriesChart')
    expect(code).not.toContain('<ServiceBreakdown')
    expect(code).not.toContain('<DimensionBreakdown')
  })

  it('renders the FinOps panels outside any costData guard', () => {
    // Nothing on this page sets costData, so a
    // `{!loading && !error && costData && …}` guard would blank the panels on
    // every load. Neither the guard nor costData may appear in the code.
    expect(code).not.toContain('!loading && !error && costData')
    expect(code).not.toContain('costData')
  })

  it('carries no standalone page chrome', () => {
    // This page renders inside the FinOps page, whose tab bar is the title.
    expect(code).not.toContain("title='FinOps Cost Management'")
    expect(code).not.toContain('breadcrumb')
  })
})
