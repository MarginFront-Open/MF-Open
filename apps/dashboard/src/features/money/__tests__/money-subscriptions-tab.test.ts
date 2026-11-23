import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Money → Subscriptions tab. Source-assertion,
 * not a render test: Money/MoneySubscriptionsTab lean on client-only hooks
 * (react-query, useSearchParams) this repo's Node-only jest can't render
 * (same reasoning as the sibling money-*-tab tests). What this locks down:
 * the tab reuses the SAME table component the standalone `/subscriptions`
 * route renders — no forked, second implementation.
 */
describe("MoneySubscriptionsTab reuses the standalone route's table", () => {
  const tabSrc = readFileSync(
    join(__dirname, '..', 'components', 'money-subscriptions-tab.tsx'),
    'utf8'
  )
  const routeSrc = readFileSync(
    join(__dirname, '..', '..', 'subscriptions', 'index.tsx'),
    'utf8'
  )

  it('imports SubscriptionsListTable from the subscriptions feature', () => {
    expect(tabSrc).toMatch(
      /import\s*\{\s*SubscriptionsListTable\s*\}\s*from\s*['"]@\/features\/subscriptions\/components\/subscriptions-list-table['"]/
    )
  })

  it('renders SubscriptionsListTable, not a second hand-rolled table', () => {
    expect(tabSrc).toMatch(/<SubscriptionsListTable\s*\/>/)
  })

  it('the standalone /subscriptions route renders the SAME component (not a Page-wrapped copy embedded elsewhere)', () => {
    expect(routeSrc).toMatch(
      /import\s*\{\s*SubscriptionsListTable\s*\}\s*from\s*['"]\.\/components\/subscriptions-list-table['"]/
    )
    expect(routeSrc).toMatch(/<SubscriptionsListTable\s*\/>/)
    // The route wraps it in Page; the Money tab does not.
    expect(routeSrc).toMatch(/<Page/)
  })

  it('the Money tab does NOT wrap SubscriptionsListTable in Page chrome', () => {
    expect(tabSrc).not.toMatch(/<Page/)
  })
})

describe('Money index wires up the Subscriptions tab', () => {
  const moneyIndexSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('imports and renders MoneySubscriptionsTab', () => {
    expect(moneyIndexSrc).toMatch(/import \{ MoneySubscriptionsTab \}/)
    expect(moneyIndexSrc).toMatch(
      /<TabsContent value='subscriptions'>\s*<MoneySubscriptionsTab \/>/
    )
  })

  it('keeps Export scoped to Breakdown only (Subscriptions gets no export button)', () => {
    // The headerExtras Export dropdown is gated on activeTab === 'breakdown'
    // — Subscriptions must not be added to that condition.
    const exportGateIndex = moneyIndexSrc.indexOf("activeTab === 'breakdown'")
    expect(exportGateIndex).toBeGreaterThan(-1)
  })
})
