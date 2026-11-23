import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Money's tab bar (Breakdown / Users).
 * Source-assertion (dashboard jest is node-only, no RTL — same pattern as
 * chart-title-tooltip.test.ts / no-direct-resolver.test.ts in this dir).
 * Locks two things: the tab wiring exists, AND the Breakdown content
 * renders inside a TabsContent.
 */
describe('money/index.tsx — Breakdown/Users tab wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('imports the shared Tabs primitive, not a bespoke tab bar', () => {
    expect(src).toMatch(
      /import \{ Tabs, TabsContent, TabsList, TabsTrigger \} from '@\/components\/ui\/tabs'/
    )
  })

  it('drives the active tab from the MONEY_TABS registry (extensible, not a one-off)', () => {
    expect(src).toMatch(/from '\.\/money-tabs'/)
    expect(src).toMatch(/MONEY_TABS\.map/)
  })

  it('reads/writes the tab via the URL (?tab=), the same idiom DateRangeSelector uses', () => {
    expect(src).toMatch(/resolveMoneyTab\(searchParams\.get\('tab'\)\)/)
    expect(src).toMatch(/nextParams\.set\('tab', tab\)/)
  })

  it('renders a Breakdown TabsContent that still contains the existing TileGrid + DimensionedSection', () => {
    const breakdownIndex = src.indexOf("TabsContent value='breakdown'")
    expect(breakdownIndex).toBeGreaterThan(-1)
    const usersIndex = src.indexOf("TabsContent value='users'")
    expect(usersIndex).toBeGreaterThan(breakdownIndex)
    const breakdownSection = src.slice(breakdownIndex, usersIndex)
    expect(breakdownSection).toMatch(/<TileGrid/)
    expect(breakdownSection).toMatch(/<DimensionedSection/)
    expect(breakdownSection).toMatch(/<CsvExportDialog/)
  })

  it('renders the new Users tab via MoneyUsersTab, not inline markup', () => {
    const usersIndex = src.indexOf("TabsContent value='users'")
    const afterUsers = src.slice(usersIndex, usersIndex + 200)
    expect(afterUsers).toMatch(/<MoneyUsersTab \/>/)
  })

  it('hides the Export dropdown on non-Breakdown tabs (nothing to export on Users yet)', () => {
    expect(src).toMatch(
      /activeTab === 'breakdown'[\s\S]{0,40}\?[\s\S]*<DropdownMenu>/
    )
  })

  it('renders the Plans tab via MoneyPlansTab, after Users, not inline markup', () => {
    expect(src).toMatch(
      /import \{ MoneyPlansTab \} from '\.\/components\/money-plans-tab'/
    )
    const usersIndex = src.indexOf("TabsContent value='users'")
    const plansIndex = src.indexOf("TabsContent value='plans'")
    expect(plansIndex).toBeGreaterThan(usersIndex)
    const afterPlans = src.slice(plansIndex, plansIndex + 200)
    expect(afterPlans).toMatch(/<MoneyPlansTab \/>/)
  })

  it('renders the Invoices tab via MoneyInvoicesTab, after Plans, not inline markup', () => {
    expect(src).toMatch(
      /import \{ MoneyInvoicesTab \} from '\.\/components\/money-invoices-tab'/
    )
    const plansIndex = src.indexOf("TabsContent value='plans'")
    const invoicesIndex = src.indexOf("TabsContent value='invoices'")
    expect(invoicesIndex).toBeGreaterThan(plansIndex)
    const afterInvoices = src.slice(invoicesIndex, invoicesIndex + 200)
    expect(afterInvoices).toMatch(/<MoneyInvoicesTab \/>/)
  })
})
