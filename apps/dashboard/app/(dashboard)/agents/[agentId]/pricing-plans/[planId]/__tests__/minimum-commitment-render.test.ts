/**
 * minimumCommitment is a UNIT floor (Int), not a dollar amount, so it must
 * not render through formatCurrency ("$1,000.00" reads as a price).
 * apps/dashboard's jest runs in a node env with no RTL
 * (see jest.config.ts), so this reads the real source and asserts on it,
 * the same idiom as the subscriptions detail page tests in this repo.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')

describe('Pricing plan detail page — Minimum Commitment renders as units, not currency', () => {
  it('never formats minimumCommitment through formatCurrency', () => {
    expect(pageSource).not.toMatch(
      /formatCurrency\(strategy\.minimumCommitment\)/
    )
  })

  it('renders minimumCommitment as a plain, localized unit count', () => {
    expect(pageSource).toMatch(
      /strategy\.minimumCommitment\.toLocaleString\(\)/
    )
  })

  it('labels the unit using the same signal shortName/name idiom the per-unit rate uses', () => {
    const minCommitBlockIndex = pageSource.indexOf('Minimum Commitment:')
    expect(minCommitBlockIndex).toBeGreaterThan(-1)
    const nearby = pageSource.slice(
      minCommitBlockIndex,
      minCommitBlockIndex + 500
    )
    expect(nearby).toMatch(
      /strategy\.signal\?\.shortName[\s\S]*?strategy\.signal\?\.name[\s\S]*?'units'/
    )
  })

  it('still formats the tier rate and strategy rate through formatCurrency (money stays money)', () => {
    expect(pageSource).toMatch(/formatCurrency\(tier\.rate\)/)
    expect(pageSource).toMatch(/formatCurrency\(getStrategyRate\(strategy\)\)/)
  })
})
