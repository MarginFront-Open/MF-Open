/**
 * The revenue-basis chip beside the
 * breakdown "Group by" control. Dashboard jest is node-only (no RTL), so the
 * wiring is source-asserted (same shape as breakdown-revenue-column-source
 * .test.ts) and the copy is asserted through the real tooltip-definitions
 * import. Load-bearing contracts:
 *   - the chip reads the SAME breakdown.revenueBasis the table gates its
 *     column on, so chip and column cannot disagree
 *   - the scope gate mirrors the resolver's sources.revenue flag, so a scope
 *     that never computes revenue shows no chip at all
 *   - Earned/Billed spelling stays single-sourced via revenueColumnLabel
 *   - each chip state explains itself from the shared tooltip registry, and
 *     the Earned copy is where a user learns table Earned is not chart Revenue
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

const SECTION_SRC = readFileSync(
  join(__dirname, '..', 'dimensioned-section.tsx'),
  'utf8'
)

describe('dimensioned-section.tsx — basis chip wiring', () => {
  it('reads the SAME breakdown.revenueBasis the table gates its column on', () => {
    expect(SECTION_SRC).toMatch(/tableBasis\s*=\s*breakdown\.revenueBasis/)
  })

  it('renders only with the table it describes, and only on a revenue-computing scope (resolver parity)', () => {
    expect(SECTION_SRC).toMatch(
      /showTable\s*&&\s*data\s*!==\s*null\s*&&\s*SCOPE_TILE_SOURCES\[scope\]\.revenue/
    )
  })

  it('labels the basis via revenueColumnLabel so Earned/Billed spelling stays single-sourced with the column header', () => {
    expect(SECTION_SRC).toMatch(
      /Revenue column: \$\{revenueColumnLabel\(tableBasis\)\}/
    )
  })

  it('names the hidden case out loud instead of silently dropping the column', () => {
    expect(SECTION_SRC).toMatch(/'No revenue column'/)
  })

  it('every chip state explains itself from the shared tooltip registry via TooltipWrap, no inline copy', () => {
    expect(SECTION_SRC).toMatch(/tooltipDefinitions\.breakdownBasisEarned/)
    expect(SECTION_SRC).toMatch(/tooltipDefinitions\.breakdownBasisBilled/)
    expect(SECTION_SRC).toMatch(/tooltipDefinitions\.breakdownBasisNone/)
    expect(SECTION_SRC).toMatch(/<TooltipWrap/)
  })
})

describe('tooltip-definitions — the three basis-chip entries', () => {
  const entries = [
    tooltipDefinitions.breakdownBasisEarned,
    tooltipDefinitions.breakdownBasisBilled,
    tooltipDefinitions.breakdownBasisNone,
  ]

  it('Earned entry states the R1 formula and that Revenue surfaces read higher by design (table Earned is not chart Revenue)', () => {
    const entry = tooltipDefinitions.breakdownBasisEarned
    expect(entry.description).toMatch(/events times your pricing rate/i)
    expect(entry.description).toMatch(
      /no subscription, seat, or one-time fees/i
    )
    expect(entry.details).toMatch(/labeled Revenue/)
    expect(entry.details).toMatch(/expected, not a bug/i)
  })

  it('Billed entry names invoice totals and the before-any-invoice contrast with Revenue', () => {
    const entry = tooltipDefinitions.breakdownBasisBilled
    expect(entry.description).toMatch(/invoice totals/i)
    expect(entry.details).toMatch(/before any invoice/i)
  })

  it('None entry says why the column is hidden and which groupings bring it back', () => {
    const entry = tooltipDefinitions.breakdownBasisNone
    expect(entry.description).toMatch(/cost only/i)
    expect(entry.details).toMatch(/agent or task/i)
    expect(entry.details).toMatch(/customer or plan/i)
  })

  it('no em dash in any rendered basis copy', () => {
    for (const entry of entries) {
      expect(
        `${entry.title} ${entry.description} ${entry.details}`
      ).not.toMatch(/—/)
    }
  })
})
