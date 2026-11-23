import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The Users tab list. Source-assertion
 * (node-only jest, no RTL). Locks: reuse over re-querying, the customer
 * link-out to the detail page, the internal cost-only routing, and the
 * status write path.
 */
describe('money-users-tab.tsx — reuse + wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'money-users-tab.tsx'), 'utf8')

  it('reuses getFilters() — no second/direct customer query', () => {
    expect(src).toMatch(
      /import \{ getFilters, type CustomerBasic \} from '@\/app\/actions\/get-filters'/
    )
    expect(src).not.toMatch(/PrismaClient/)
    expect(src).not.toMatch(/from '@\/app\/lib\/db'/)
  })

  it('reuses the shared partition/filter derivation, not ad-hoc filtering', () => {
    expect(src).toMatch(/from '\.\.\/users-derivation'/)
    expect(src).toMatch(/filterUsersTabCustomers/)
    expect(src).toMatch(/countUsersTabCustomers/)
  })

  it('links a real-customer row straight to the existing rich detail page', () => {
    expect(src).toMatch(/href=\{`\/customers\/\$\{row\.id\}`\}/)
  })

  it('routes an internal-user row to InternalUserDetailDialog, never the customer link', () => {
    expect(src).toMatch(/from '\.\/internal-user-detail-dialog'/)
    expect(src).toMatch(/<InternalUserDetailDialog/)
  })

  it('wires the status control to the existing updateCustomer action (no new server code)', () => {
    expect(src).toMatch(
      /import \{ updateCustomer \} from '@\/app\/actions\/customers'/
    )
    expect(src).toMatch(/updateCustomer\(customerId, \{ status \}\)/)
  })

  it('wires the type flip to the existing updateCustomer action (no new server code)', () => {
    expect(src).toMatch(/updateCustomer\(customerId, \{ isInternal \}\)/)
  })

  it('type select reads its value from the row flag and labels itself per row', () => {
    expect(src).toMatch(/row\.isInternal \? 'internal' : 'customer'/)
    expect(src).toMatch(/aria-label=\{`Type for \$\{row\.name\}`\}/)
  })

  it('resolves GL account names via getChartOfAccounts', () => {
    expect(src).toMatch(
      /import \{ getChartOfAccounts \} from '@\/app\/actions\/chart-of-accounts'/
    )
  })
})
