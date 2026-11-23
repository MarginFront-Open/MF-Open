/**
 * Agents-table rendering rules. The
 * component renders the derived rows VERBATIM: every dollar through canon-format,
 * no re-sorting (the derivation already pinned catch-all-last in
 * agents-derivation.test.ts), no re-derived math. jest is node-only so the
 * money-path facts are source-asserted; the null-margin dash is proven for
 * real through the canon helper the source-assert ties the cell to.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { formatPct } from '@/lib/canon-format'

const tableSrc = readFileSync(
  join(__dirname, '..', 'components', 'agents-table.tsx'),
  'utf8'
)

describe('money columns render through canon-format only', () => {
  it('cost and earned through formatCost', () => {
    expect(tableSrc).toMatch(/formatCost\(row\.cost\)/)
    expect(tableSrc).toMatch(/formatCost\(row\.earned\)/)
  })

  it('margin through formatPct — and formatPct(null) really renders the dash', () => {
    expect(tableSrc).toMatch(/formatPct\(row\.marginPercent\)/)
    expect(formatPct(null)).toBe('—')
  })

  it('tasks through toLocaleString, never a money formatter', () => {
    expect(tableSrc).toMatch(/row\.tasks\.toLocaleString\(\)/)
  })

  it('re-derives nothing: no .toFixed, no .reduce, no .sort, no margin math', () => {
    expect(tableSrc).not.toMatch(/\.toFixed\(/)
    expect(tableSrc).not.toMatch(/\.reduce\(/)
    expect(tableSrc).not.toMatch(/\.sort\(/)
    expect(tableSrc).not.toMatch(/safeMarginPercent/)
  })
})

describe('the deleted-agents catch-all row', () => {
  it('is detected by agentId === null — the derivation contract', () => {
    expect(tableSrc).toMatch(/const catchAll = row\.agentId === null/)
  })

  it('gets no kebab (the actions cell is gated on !catchAll)', () => {
    expect(tableSrc).toMatch(/\{!catchAll && \(/)
  })

  it('gets no drill-in button (the name renders as a plain span)', () => {
    expect(tableSrc).toMatch(/catchAll \? \(\s*<span/)
  })
})

describe('status pill + margin tooltip come from the shared homes', () => {
  it('pill via agentStatusPill (status-maps.ts — the node-tested map)', () => {
    expect(tableSrc).toMatch(/agentStatusPill\(row\.isActive\)/)
  })

  it('margin header carries the EXISTING agentEarnedMargin tooltip — no new copy', () => {
    expect(tableSrc).toMatch(/tooltipDefinitions\.agentEarnedMargin/)
  })
})
