/**
 * UI wiring for the breakdown revenue column + donut
 * toggle. Dashboard jest is NODE-ONLY (no RTL), so the rendered table can't be
 * asserted directly — these source-assertions lock the load-bearing wiring:
 * basis-labeled header (BASIS), honest-null column gating (HONEST-NULL), canon
 * formatters, and the info tooltip.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const TABLE_SRC = readFileSync(
  join(__dirname, '..', 'tiles', 'breakdown-table.tsx'),
  'utf8'
)
const SECTION_SRC = readFileSync(
  join(__dirname, '..', 'dimensioned-section.tsx'),
  'utf8'
)
const DONUT_SRC = readFileSync(
  join(__dirname, '..', 'tiles', 'category-donut.tsx'),
  'utf8'
)

describe('breakdown-table.tsx — revenue column (BASIS + HONEST-NULL)', () => {
  it('gates the revenue column on revenueBasis !== null (cost-only when not definable)', () => {
    expect(TABLE_SRC).toMatch(/revenueBasis\s*!==\s*null/)
    expect(TABLE_SRC).toMatch(/showRevenue\s*&&/)
  })

  it('labels the header by basis via revenueColumnLabel (Earned vs Billed)', () => {
    expect(TABLE_SRC).toMatch(/revenueColumnLabel\(revenueBasis\)/)
  })

  it('renders "—" for an undefined per-row revenue (canon M2), formats real numbers via formatCost', () => {
    expect(TABLE_SRC).toMatch(/row\.revenue === undefined\s*\?\s*'—'/)
    expect(TABLE_SRC).toMatch(/formatCost\(row\.revenue\)/)
  })

  it('uses formatPct for margin so null margin renders "—" (canon M1) — never an inline (a-b)/a', () => {
    expect(TABLE_SRC).toMatch(/formatPct\(row\.marginPercent/)
    expect(TABLE_SRC).not.toMatch(/marginPercent[^)]*\/[^)]*revenue/)
  })

  it('shows the basis-explaining InfoTooltip on the revenue header', () => {
    expect(TABLE_SRC).toMatch(/InfoTooltip/)
    expect(TABLE_SRC).toMatch(/tooltipDefinitions\.breakdownRevenueColumn/)
  })
})

describe('dimensioned-section.tsx — donut cost/revenue toggle', () => {
  it('offers the toggle only when the response carries a revenue basis (donutBasis from breakdown.revenueBasis, same source as the table)', () => {
    expect(SECTION_SRC).toMatch(/donutBasis\s*=\s*breakdown\.revenueBasis/)
    expect(SECTION_SRC).toMatch(/donutBasis\s*!==\s*null/)
  })

  it('passes the selected metric to the donut as valueMode', () => {
    expect(SECTION_SRC).toMatch(/valueMode=\{effectiveDonutMetric\}/)
  })
})

describe('category-donut.tsx — revenue variant', () => {
  it('reads per-bucket revenue when valueMode is revenue, cost otherwise', () => {
    expect(DONUT_SRC).toMatch(/valueMode === 'revenue'/)
    expect(DONUT_SRC).toMatch(/bucket\.revenue/)
  })
})
