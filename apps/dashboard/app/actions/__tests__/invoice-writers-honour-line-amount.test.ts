/**
 * The dashboard's invoice writers must not reinvent a line's amount.
 *
 * `invoice_line_items` stores quantity, unitPrice and amount as three separate
 * numeric(12,2) columns, and only `amount` is the bill. A blended price cannot
 * be rebuilt from the other two: a $99 credit pool over 400 credits is $0.2475
 * each, stored as $0.25, and 400 x $0.25 is $100.00. A writer that
 * recomputes the product and derives the header total from it quietly
 * changes what the customer owes when an invoice is re-created through the
 * dashboard.
 *
 * createInvoice and updateInvoice both call the shared rule in
 * @marginfront/db. This file guards that on two
 * fronts: the rule itself still behaves (imported and run for real, no mock),
 * and the Server Action source contains no recomputation to fall back into.
 * The source check is the dashboard's established pattern for server-only code
 * that cannot be imported under jest (see
 * src/__tests__/no-client-value-imports-of-marginfront-db.test.ts).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import { invoiceLineAmount, invoiceSubtotal } from '@marginfront/db'

const ACTIONS = join(__dirname, '..', 'invoices.ts')

describe('the shared line-amount rule', () => {
  const pooledCredits = { quantity: 400, unitPrice: 0.25, amount: 99 }

  it('bills what the line says, not the product of the two display columns', () => {
    expect(invoiceLineAmount(pooledCredits)).toBe(99)
    // NEGATIVE CONTROL: what a recomputing writer would persist for the same row.
    expect(pooledCredits.quantity * pooledCredits.unitPrice).toBe(100)
  })

  it('derives the amount when a human states none', () => {
    expect(invoiceLineAmount({ quantity: 3, unitPrice: 150 })).toBe(450)
  })

  it('sums a mixed invoice off the amounts', () => {
    expect(
      invoiceSubtotal([
        pooledCredits,
        { quantity: 1, unitPrice: 50, amount: 50 },
      ])
    ).toBe(149)
  })
})

describe('apps/dashboard/app/actions/invoices.ts', () => {
  const source = readFileSync(ACTIONS, 'utf8')

  /**
   * Both writers — createInvoice and updateInvoice — persist a line amount,
   * and both must take it from the shared rule. If a third writer appears,
   * this count goes red and whoever added it has to decide deliberately.
   */
  it('writes every line amount through the shared rule', () => {
    expect(source.match(/invoiceLineAmount\(/g)).toHaveLength(2)
    expect(source.match(/invoiceSubtotal\(/g)).toHaveLength(2)
  })

  it('derives nothing from quantity x unitPrice', () => {
    expect(source).not.toMatch(/quantity\s*\*\s*\w+\.unitPrice/)
  })

  /**
   * Every read of invoice_line_items filters `deletedAt: null`, on the premise
   * that a retired line is soft-deleted. Hard-deleting the whole set and
   * recreating it would destroy the record of what a draft charged before
   * somebody edited it and contradict the premise those reads are built on.
   * Editing an invoice is not a reason to lose its history.
   */
  it('retires line items instead of destroying them', () => {
    expect(source).not.toMatch(/invoice_line_items\.deleteMany/)
    expect(source).not.toMatch(/invoice_line_items\.delete\(/)
    expect(source).toMatch(/invoice_line_items\.updateMany/)
  })
})
