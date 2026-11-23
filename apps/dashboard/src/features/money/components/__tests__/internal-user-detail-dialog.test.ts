import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Internal users are cost-only:
 * no invoices, no revenue, ever. Source-assertion (node-only jest, no RTL).
 * Guards on actual data access (`.totals.revenue`/`.margin`/`.marginPercent`
 * never read, no invoice import) rather than banning the word "revenue"
 * outright — the honest disclaimer text legitimately uses it.
 */
describe('internal-user-detail-dialog.tsx — cost + GL only, never revenue/invoices', () => {
  const src = readFileSync(
    join(__dirname, '..', 'internal-user-detail-dialog.tsx'),
    'utf8'
  )

  it('reads canon cost via getCanonicalCustomerMetrics, filtered to this one customer', () => {
    expect(src).toMatch(/getCanonicalCustomerMetrics\(customer\.id\)/)
    expect(src).toMatch(/result\.data\.totals\.cost/)
  })

  it('never reads revenue, margin, or marginPercent off the canonical response', () => {
    expect(src).not.toMatch(/totals\.revenue/)
    expect(src).not.toMatch(/totals\.margin/)
    expect(src).not.toMatch(/totals\.marginPercent/)
  })

  it('never imports an invoices table or component', () => {
    expect(src).not.toMatch(/InvoicesTable/)
    expect(src.toLowerCase()).not.toMatch(/invoice-/)
  })

  it('renders the assigned GL account', () => {
    expect(src).toMatch(/Assigned GL account/)
    expect(src).toMatch(/glAccount\.glCode/)
    expect(src).toMatch(/glAccount\.glName/)
  })

  it('formats cost via canon-format, never a hand-rolled toFixed on money', () => {
    expect(src).toMatch(/import \{ formatCost \} from '@\/lib\/canon-format'/)
    expect(src).not.toMatch(/\.toFixed\(/)
  })
})
