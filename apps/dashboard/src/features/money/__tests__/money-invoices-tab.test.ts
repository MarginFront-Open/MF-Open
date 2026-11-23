import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Money → Invoices tab
 * component. Source-assertion (dashboard jest is node-only, no RTL — same
 * pattern as users-tab-wiring.test.ts / chart-title-tooltip.test.ts in this
 * dir) since there's no renderer available to mount the component and
 * click through it.
 */
describe('money-invoices-tab.tsx — list wiring, links, and honest status', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'money-invoices-tab.tsx'),
    'utf8'
  )

  it('fetches through the getInvoices() action, no second invoice-listing code path', () => {
    expect(src).toMatch(
      /import \{ getInvoices \} from '@\/app\/actions\/invoices'/
    )
    expect(src).toMatch(/getInvoices\(\{/)
  })

  it('builds rows through the pure derivation module, not inline mapping', () => {
    expect(src).toMatch(
      /import \{ buildInvoicesTabRows, invoiceStatusChip \} from '\.\.\/invoices-derivation'/
    )
    expect(src).toMatch(/buildInvoicesTabRows\(result\.data\.results\)/)
  })

  it('each row links to the /invoices/[invoiceId] detail page', () => {
    expect(src).toMatch(/href={`\/invoices\/\$\{row\.id\}`}/)
  })

  it('links out to the full /invoices page rather than rebuilding create/search/pagination', () => {
    expect(src).toMatch(/href='\/invoices'/)
  })

  it('renders status through invoiceStatusChip + the shared Badge, not a hand-rolled label', () => {
    expect(src).toMatch(/invoiceStatusChip\(row\.status\)/)
    expect(src).toMatch(/<Badge variant={chip\.variant}>{chip\.label}<\/Badge>/)
  })

  it('formats every money value via canon-format — never a raw .toFixed on an amount', () => {
    expect(src).toMatch(
      /import \{ formatCurrency \} from '@\/lib\/canon-format'/
    )
    expect(src).not.toMatch(/\.toFixed\(/)
  })

  it('does not add a refund button — refunds stay webhook-driven display only', () => {
    // Strip comments first — the file's own doc comment says "no refund
    // button" in prose, which would otherwise false-positive this check.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(codeOnly).not.toMatch(/<[Bb]utton[^>]*>[^<]*refund/i)
    expect(codeOnly).not.toMatch(/onClick={.*[Rr]efund/)
  })

  it('does not fake a PDF download — no download/PDF affordance was added', () => {
    expect(src).not.toMatch(/pdf/i)
  })
})
