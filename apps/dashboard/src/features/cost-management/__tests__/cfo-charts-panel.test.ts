/**
 * Source-assertion guard for the CFO Charts panel.
 *
 * The dashboard jest suite is node-env with no jsdom/RTL (see jest.config.ts),
 * so — exactly like the sibling cost-management-panels test — we read the component source
 * as text and assert its structure instead of mounting it. Block comments are
 * stripped first so the "absence" checks test CODE, not the header comment.
 *
 * What it locks:
 *   - the panel reads the three canonical actions (revenue, cost, journal);
 *   - the earned series uses the `usageRevenue` tooltip and the total
 *     series uses `totalRevenueHero` — and it NEVER uses the `earnedRevenue`
 *     tooltip, whose copy folds in fees and would mislabel "Agent-Earned".
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('CFO Charts panel (source guard)', () => {
  const source = readFileSync(
    join(__dirname, '../components/cfo-charts-panel.tsx'),
    'utf8'
  )
  // Strip /* */ and {/* */} comment blocks so assertions test the code only.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')

  it('reads the three canonical server actions', () => {
    expect(code).toContain('getProductLineMargins')
    expect(code).toContain('getCostClassificationBreakdown')
    expect(code).toContain('getJournalExport')
  })

  it('shapes data through the pure helpers (not inline math)', () => {
    expect(code).toContain('buildRevenueComparison')
    expect(code).toContain('buildCategorySlices')
    expect(code).toContain('buildGlCostBars')
  })

  it('labels the earned series canonically (usageRevenue), the total series with totalRevenueHero', () => {
    expect(code).toContain('tooltipDefinitions.usageRevenue')
    expect(code).toContain('tooltipDefinitions.totalRevenueHero')
  })

  it('NEVER uses the mislabeled earnedRevenue tooltip for the earned series', () => {
    expect(code).not.toContain('tooltipDefinitions.earnedRevenue')
  })

  it('renders bar + donut chart types (chart fit to data)', () => {
    expect(code).toContain('BarChart')
    expect(code).toContain('PieChart')
  })

  it('"Code Cost Clarity" is not a chart title (it names the CCC product, not these charts)', () => {
    expect(code).not.toContain('Code Cost Clarity')
  })

  it('the revenue card wears a revenue name, the cost card a cost name, each with a title tooltip', () => {
    expect(code).toContain('Earned vs total revenue by product line')
    expect(code).toContain('tooltipDefinitions.earnedVsTotalRevenueChart')
    expect(code).toContain('Cost by category and GL account')
    expect(code).toContain('tooltipDefinitions.costByCategoryAndGl')
  })
})
