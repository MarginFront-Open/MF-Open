import {
  buildInvoicesTabRows,
  invoiceStatusChip,
  type InvoiceListItem,
} from '../invoices-derivation'

/**
 * Pure derivation behind
 * the Money → Invoices tab. Real assertions (not source-scanning), same
 * idiom as plans-derivation.test.ts / users-derivation.test.ts, since this
 * module has no JSX.
 */

function invoice(overrides: Partial<InvoiceListItem> = {}): InvoiceListItem {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-202607-00001',
    status: 'paid',
    totalAmount: 100,
    refundedAmount: 0,
    invoiceDate: '2026-07-01T00:00:00.000Z',
    dueDate: '2026-07-15T00:00:00.000Z',
    customer: { name: 'Acme Corp' },
    subscription: { name: 'Pro Plan Sub' },
    ...overrides,
  }
}

describe('buildInvoicesTabRows', () => {
  it('every input invoice lands in exactly one output row, in order', () => {
    const rows = buildInvoicesTabRows([
      invoice({ id: 'a' }),
      invoice({ id: 'b' }),
      invoice({ id: 'c' }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('carries amount, dates, and status through verbatim — no hand-rolled math', () => {
    const rows = buildInvoicesTabRows([
      invoice({
        totalAmount: 249.5,
        refundedAmount: 0,
        invoiceDate: '2026-06-01T00:00:00.000Z',
        dueDate: '2026-06-15T00:00:00.000Z',
        status: 'issued',
      }),
    ])
    expect(rows[0]).toMatchObject({
      amount: 249.5,
      refundedAmount: 0,
      invoiceDate: '2026-06-01T00:00:00.000Z',
      dueDate: '2026-06-15T00:00:00.000Z',
      status: 'issued',
    })
  })

  it('maps customer.name and subscription.name to the row fields', () => {
    const rows = buildInvoicesTabRows([
      invoice({
        customer: { name: 'Beta LLC' },
        subscription: { name: 'Usage Plan' },
      }),
    ])
    expect(rows[0].customerName).toBe('Beta LLC')
    expect(rows[0].subscriptionName).toBe('Usage Plan')
  })

  it('an invoice with no subscription gets an honest null, never a fabricated label', () => {
    const rows = buildInvoicesTabRows([invoice({ subscription: null })])
    expect(rows[0].subscriptionName).toBeNull()
  })

  it('an invoice with no customer relation loaded gets an honest null', () => {
    const rows = buildInvoicesTabRows([invoice({ customer: null })])
    expect(rows[0].customerName).toBeNull()
  })

  it('carries a nonzero refundedAmount through untouched (no derived partial/full math here)', () => {
    const rows = buildInvoicesTabRows([
      invoice({ totalAmount: 100, refundedAmount: 40 }),
    ])
    expect(rows[0].refundedAmount).toBe(40)
    expect(rows[0].amount).toBe(100)
  })
})

describe('invoiceStatusChip', () => {
  it('labels every canon enum_invoices_status value honestly, refunded included', () => {
    expect(invoiceStatusChip('draft')).toEqual({
      label: 'Draft',
      variant: 'outline',
    })
    expect(invoiceStatusChip('pending')).toEqual({
      label: 'Pending',
      variant: 'warning',
    })
    expect(invoiceStatusChip('issued')).toEqual({
      label: 'Issued',
      variant: 'secondary',
    })
    expect(invoiceStatusChip('paid')).toEqual({
      label: 'Paid',
      variant: 'success',
    })
    expect(invoiceStatusChip('overdue')).toEqual({
      label: 'Overdue',
      variant: 'destructive',
    })
    expect(invoiceStatusChip('void')).toEqual({
      label: 'Void',
      variant: 'outline',
    })
    expect(invoiceStatusChip('refunded')).toEqual({
      label: 'Refunded',
      variant: 'destructive',
    })
  })

  it('gives refunded its own distinct chip, never falling back to Draft', () => {
    const refunded = invoiceStatusChip('refunded')
    const draft = invoiceStatusChip('draft')
    expect(refunded.label).not.toBe(draft.label)
  })

  it('never fabricates a label for an unrecognized status — capitalizes the raw value instead', () => {
    expect(invoiceStatusChip('weird_future_status')).toEqual({
      label: 'Weird_future_status',
      variant: 'outline',
    })
  })

  it('handles an empty status string without throwing', () => {
    expect(invoiceStatusChip('')).toEqual({
      label: 'Unknown',
      variant: 'outline',
    })
  })
})
