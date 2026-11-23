/**
 * What one invoice line charges — the ONE rule, shared by every writer.
 *
 * `invoice_line_items` stores quantity, unitPrice and amount as three
 * independent numeric(12,2) columns, and only one of them is the truth.
 * `amount` is what the customer is billed. quantity and unitPrice describe it
 * for a human, and for a blended price they CANNOT reproduce it: a credit
 * pool's real per-unit price on 400 credits is $0.2475, which the column
 * rounds to $0.25, and 400 × $0.25 is a dollar more than the $99.00 the
 * customer actually owes.
 *
 * So a writer that recomputes `amount = quantity × unitPrice` silently changes
 * the bill. Every writer routes through here:
 *
 *   - a caller who KNOWS the amount (re-issuing, duplicating, importing, or
 *     anything fed by the invoice calculator) passes it, and it is honoured;
 *   - a human typing "3 hours at $150" passes no amount, and the product is
 *     derived for them.
 *
 * The derived branch deliberately does not round: numeric(12,2) rounds on
 * write, and rounding twice is its own drift.
 */

export interface InvoiceLineAmountInput {
  quantity: number;
  unitPrice: number;
  /** The authoritative charge, when the caller has one. */
  amount?: number | null;
}

/** What this line bills. */
export function invoiceLineAmount(item: InvoiceLineAmountInput): number {
  const stated = Number(item.amount);
  if (
    item.amount !== null &&
    item.amount !== undefined &&
    Number.isFinite(stated)
  ) {
    return stated;
  }
  return Number(item.quantity) * Number(item.unitPrice);
}

/** What the invoice bills before tax and discount. */
export function invoiceSubtotal(
  items: readonly InvoiceLineAmountInput[],
): number {
  return items.reduce((sum, item) => sum + invoiceLineAmount(item), 0);
}
