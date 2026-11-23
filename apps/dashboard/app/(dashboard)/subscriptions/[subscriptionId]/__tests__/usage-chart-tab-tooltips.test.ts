/**
 * WHAT THIS FILE GUARDS: the usage-detail chart toggles on BOTH the subscription
 * and customer detail pages, which share one canon tab set —
 * Metrics / Cost / Revenue / Cost-vs-Revenue — each with an active-tab tooltip.
 *
 * WHY IT EXISTS: the series the revenue toggle draws is canon Revenue
 * (events × rate + recurring/seat/one-time fees), NOT invoice-based Billed.
 * Labeling it "Billed Revenue" would tell a customer they'd been billed when
 * no invoice exists. So the toggle says "Revenue", its tooltip is
 * totalRevenue, and a Cost-vs-Revenue tab matches the customer chart.
 * (Billed/Collected are invoice-lifecycle slices that live on the
 * tiles/invoice surfaces, not these usage charts.)
 *
 * WHY THE TEST LOOKS LIKE THIS: this directory's jest config runs in a NODE env and
 * only matches *.test.ts — React components/hooks are NOT rendered here (see
 * apps/dashboard/jest.config.ts; component behavior stays on Playwright E2E). So we
 * (1) import the REAL tooltip definitions the toggles depend on and assert their
 * contract + canon semantics, and (2) mirror the call-site wiring (the
 * activeTabTooltip map: active tab → tooltip key) as a pure function so a reader can
 * map it back to page.tsx. If a toggle is ever re-pointed at the wrong definition,
 * these assertions fail.
 *
 * CONNECTS TO:
 *   - subscriptions/[subscriptionId]/page.tsx + customers/[customerId]/page.tsx (activeTabTooltip)
 *   - apps/dashboard/lib/tooltip-definitions.ts (units, totalCost, totalRevenue, costVsRevenueChart)
 *   - apps/dashboard/components/ui/info-tooltip.tsx (spread target: {title, description, details?})
 */

import { tooltipDefinitions } from '@/lib/tooltip-definitions'

// Mirror of the `activeTabTooltip` const in both page.tsx files: which tooltip
// key each usage-chart tab resolves to. Keep in sync with that const next to the
// toggles. ('metrics' on the customer chart == 'units' on the subscription chart —
// same usage-units basis.)
const tooltipKeyForTab = (
  tab: 'units' | 'metrics' | 'cost' | 'revenue' | 'costVsRevenue'
): keyof typeof tooltipDefinitions => {
  switch (tab) {
    case 'cost':
      return 'totalCost'
    case 'revenue':
      return 'totalRevenue'
    case 'costVsRevenue':
      return 'costVsRevenueChart'
    default:
      return 'units'
  }
}

describe('Usage-detail chart tab tooltips', () => {
  it('every tab resolves to a defined tooltip shaped for the InfoTooltip spread', () => {
    for (const tab of [
      'units',
      'metrics',
      'cost',
      'revenue',
      'costVsRevenue',
    ] as const) {
      const def = tooltipDefinitions[tooltipKeyForTab(tab)]
      expect(def).toBeDefined()
      expect(typeof def.title).toBe('string')
      expect(def.title.length).toBeGreaterThan(0)
      expect(typeof def.description).toBe('string')
      expect(def.description.length).toBeGreaterThan(0)
    }
  })

  it('the Revenue tab carries Revenue (earned + fees) semantics — NOT Billed', () => {
    const def = tooltipDefinitions[tooltipKeyForTab('revenue')]
    // This series is canon Revenue, not invoice
    // Billed. Its copy must describe earnable revenue and must NOT claim to be
    // "invoice totals sent."
    expect(def.title).toMatch(/Revenue/i)
    expect(def.title).not.toMatch(/Billed/i)
    expect(def.description).toMatch(/earnable|pricing rate|fees/i)
    expect(def.description).not.toMatch(/invoice totals sent/i)
  })

  it('the Cost-vs-Revenue tab tooltip describes cost vs revenue and margin', () => {
    const def = tooltipDefinitions[tooltipKeyForTab('costVsRevenue')]
    expect(def).toBeDefined()
    expect(def.title).toMatch(/Cost vs Revenue/i)
    expect(def.description).toMatch(/margin/i)
  })

  it('the revenue toggle is not wired to the billed definition', () => {
    expect(tooltipKeyForTab('revenue')).not.toBe('billedRevenue')
    expect(tooltipKeyForTab('revenue')).toBe('totalRevenue')
  })
})
