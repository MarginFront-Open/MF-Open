/**
 * The Top KPI Summary Boxes (Total Revenue/Cost/Margin/Customer Share) must
 * render for a cancelled-only customer (every subscription status !== 'active').
 * Gating the strip on `(hasActiveSubscriptions || allSubscriptions.length === 0)`
 * would hide it. canonicalTotals/customerShare/
 * customerCostShare are fetched by customerId alone (getCanonicalCustomerMetrics
 * et al.), independent of subscription status, and canon keeps a canceled
 * subscription's history — so the strip must render for any customer with
 * data, not just ones with a currently-ACTIVE subscription.
 *
 * apps/dashboard's jest runs in a node env with no RTL (see jest.config.ts),
 * so this is a source-assert, same idiom used across this repo's page tests.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')

describe('Customer detail page — Top KPI Summary Boxes render for every customer', () => {
  it('the KPI strip is not gated on hasActiveSubscriptions', () => {
    // isolate the "Top KPI Summary Boxes" block from the (legitimately
    // active-subscription-gated) Subscription Analysis subtree further down
    const kpiBlockStart = pageSource.indexOf('Top KPI Summary Boxes')
    const kpiBlockEnd = pageSource.indexOf('Revenue Type Split')
    expect(kpiBlockStart).toBeGreaterThan(-1)
    expect(kpiBlockEnd).toBeGreaterThan(kpiBlockStart)
    const kpiBlock = pageSource.slice(kpiBlockStart, kpiBlockEnd)
    expect(kpiBlock).not.toMatch(/hasActiveSubscriptions/)
  })

  it('still reads Total Revenue/Cost/Margin/Customer Share from the subscription-status-independent canonical sources', () => {
    const kpiBlockStart = pageSource.indexOf('Top KPI Summary Boxes')
    const kpiBlockEnd = pageSource.indexOf('Revenue Type Split')
    const kpiBlock = pageSource.slice(kpiBlockStart, kpiBlockEnd)
    expect(kpiBlock).toMatch(/formatCurrency\(canonicalTotals\.revenue\)/)
    expect(kpiBlock).toMatch(/formatCurrency\(canonicalTotals\.cost\)/)
    expect(kpiBlock).toMatch(/formatPct\(canonicalTotals\.marginPercent\)/)
  })

  it('the Subscription Analysis subtree stays gated on a selected active sub', () => {
    expect(pageSource).toMatch(
      /\{hasActiveSubscriptions &&\s*\n\s*activeSubscription &&/
    )
  })
})
