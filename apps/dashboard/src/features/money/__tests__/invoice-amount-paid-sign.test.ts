import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The invoice-detail summary renders "Amount Paid" without a leading "-".
 * invoice.amountPaid is ALREADY the canonical net amount (the api-nest
 * refund finalizer, invoice-refund-finalizer.service.ts, decrements it on a
 * refund), so a hardcoded minus would print the partial-refund fixture
 * (payment $200, refund $40) as "-$160.00". The frontend does no money math
 * here: this asserts the display.
 * jest is node-only (no RTL), so this is a source-assertion.
 */
const src = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    '(dashboard)',
    'invoices',
    '[invoiceId]',
    'page.tsx'
  ),
  'utf8'
)

describe('invoice detail — Amount Paid renders positive (net-of-refund), not negated', () => {
  it('never prepends a minus sign to the paid amount', () => {
    expect(src).not.toMatch(/-\{formatCurrency\(invoice\.amountPaid\)\}/)
  })

  it('renders the canonical net amountPaid as a positive figure', () => {
    expect(src).toMatch(/\{formatCurrency\(invoice\.amountPaid\)\}/)
  })
})
