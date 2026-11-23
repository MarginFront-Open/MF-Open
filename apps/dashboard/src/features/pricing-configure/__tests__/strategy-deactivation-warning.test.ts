/**
 * WHAT THIS FILE GUARDS: revenue metrics
 * filter pricing strategies on { active: true, deletedAt: null }
 * (packages/db/src/lib/revenue-metrics.ts), so flipping a strategy to
 * active:false retroactively zeroes the revenue it already earned. The
 * Configure Pricing screen is the ONE surface that does that flip (toggle
 * a pricing option off + Save), so it confirms first and names the
 * retroactive impact. This locks that confirmation.
 *
 * Node-only jest, so these are source assertions — same idiom as
 * cancel-subscription-wiring.test.ts.
 */

import { readFileSync } from 'fs'
import path from 'path'

const indexSource = readFileSync(path.join(__dirname, '../index.tsx'), 'utf-8')
const operationsSource = readFileSync(
  path.join(__dirname, '../hooks/usePricingOperations.ts'),
  'utf-8'
)

describe('usePricingOperations — exposes the pending deactivations', () => {
  it('derives them from the same formatForApi payload the save uses', () => {
    expect(operationsSource).toMatch(/getPendingStrategyDeactivations/)
    const fnIndex = operationsSource.indexOf(
      'const getPendingStrategyDeactivations'
    )
    expect(fnIndex).toBeGreaterThan(-1)
    const fnBody = operationsSource.slice(fnIndex, fnIndex + 900)
    expect(fnBody).toMatch(/formatForApi/)
    expect(fnBody).toMatch(/active === false/)
  })
})

describe('Configure Pricing — save warns before deactivating a strategy', () => {
  it('checks for pending deactivations before saving', () => {
    const handleSaveIndex = indexSource.indexOf('const handleSave')
    expect(handleSaveIndex).toBeGreaterThan(-1)
    const handleSaveBody = indexSource.slice(
      handleSaveIndex,
      handleSaveIndex + 700
    )
    expect(handleSaveBody).toMatch(/getPendingStrategyDeactivations/)
    expect(handleSaveBody).toMatch(/savePricingPlan/)
  })

  it('names the retroactive revenue impact in the warning copy', () => {
    expect(indexSource).toMatch(/already earned/)
    expect(indexSource).toMatch(/every revenue report/)
    expect(indexSource).toMatch(/past periods included/)
  })

  it('confirming the warning is what saves; dismissing keeps the strategy on', () => {
    expect(indexSource).toMatch(/Deactivate and save/)
    expect(indexSource).toMatch(/Keep it on/)
    const confirmIndex = indexSource.indexOf('Deactivate and save')
    const confirmTag = indexSource.slice(confirmIndex - 500, confirmIndex)
    expect(confirmTag).toMatch(/savePricingPlan/)
  })
})
