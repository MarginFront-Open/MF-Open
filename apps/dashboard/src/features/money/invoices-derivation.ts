/**
 * Pure derivation behind
 * the Money → Invoices tab. A structural input type rather than importing
 * `Invoice` from `@/app/actions/invoices` — same "framework-free and
 * node-testable" convention users-derivation.ts established — so this file
 * has no dependency on the 'use server' action module.
 *
 * Status labeling deliberately does NOT reuse InvoiceStatusBadge /
 * invoiceStateMachine.ts: that shared mapper has no case for the DB's real
 * `refunded` status (enum_invoices_status includes it —
 * packages/db/prisma/schema.prisma) and silently falls through to
 * "Draft" for it (mapLegacyStatus's `default` branch). Reusing it here would
 * misrepresent a refunded invoice as a draft. This module's mapping instead
 * lists all 7 canon statuses explicitly, `refunded` included.
 */

export type InvoiceStatusChipVariant =
  | 'success'
  | 'warning'
  | 'destructive'
  | 'outline'
  | 'secondary'

export interface InvoiceListItem {
  id: string
  invoiceNumber: string
  status: string
  totalAmount: number
  refundedAmount: number
  invoiceDate: string
  dueDate: string
  customer?: { name: string } | null
  subscription?: { name: string } | null
}

export interface InvoicesTabRow {
  id: string
  invoiceNumber: string
  customerName: string | null
  subscriptionName: string | null
  amount: number
  refundedAmount: number
  invoiceDate: string
  dueDate: string
  status: string
}

/** The Invoices tab table's rows — every invoice the list read returned,
 * mapped to only the fields this tab shows. Null customer/subscription
 * (should never happen for customer, but subscription is nullable by
 * schema) render as an honest `null` here — the component renders '—',
 * never a fabricated "N/A" label. */
export function buildInvoicesTabRows(
  invoices: ReadonlyArray<InvoiceListItem>
): InvoicesTabRow[] {
  return invoices.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerName: invoice.customer?.name ?? null,
    subscriptionName: invoice.subscription?.name ?? null,
    amount: invoice.totalAmount,
    refundedAmount: invoice.refundedAmount,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
  }))
}

const STATUS_CHIPS: Record<
  string,
  { label: string; variant: InvoiceStatusChipVariant }
> = {
  draft: { label: 'Draft', variant: 'outline' },
  pending: { label: 'Pending', variant: 'warning' },
  issued: { label: 'Issued', variant: 'secondary' },
  paid: { label: 'Paid', variant: 'success' },
  overdue: { label: 'Overdue', variant: 'destructive' },
  void: { label: 'Void', variant: 'outline' },
  // DB-official terminal state (enum_invoices_status) — a fully-refunded
  // invoice, distinct from a `paid` invoice that carries a nonzero
  // refundedAmount but hasn't (yet) transitioned to this status.
  refunded: { label: 'Refunded', variant: 'destructive' },
}

/** Maps a raw invoice status string to an honest chip label + Badge variant.
 * Covers all 7 `enum_invoices_status` values explicitly (refunded included,
 * per the module doc above). An unrecognized value (a status this chip
 * doesn't know, or bad data) renders its own capitalized text rather than
 * silently mislabeling it: never fabricate a status the data doesn't say. */
export function invoiceStatusChip(status: string): {
  label: string
  variant: InvoiceStatusChipVariant
} {
  const known = STATUS_CHIPS[status]
  if (known) return known
  return {
    label:
      status.length > 0
        ? status.charAt(0).toUpperCase() + status.slice(1)
        : 'Unknown',
    variant: 'outline',
  }
}
