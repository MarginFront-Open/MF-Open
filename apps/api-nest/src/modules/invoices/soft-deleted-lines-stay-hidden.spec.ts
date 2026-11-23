/**
 * A deleted line is deleted everywhere, or it is a phantom charge.
 *
 * Checkout filters soft-deleted line items, so a merchant who removes a
 * mistaken $500 row gets the right total and the customer gets the right
 * charge. Every other read of the same rows must filter too, or the customer
 * still SEES the $500 row on the portal, in the SDK, in the invoice email. A
 * $500 gap between what you read and what you were charged reads as an
 * overcharge that never happened.
 *
 * The writer must filter as well: matching existing rows without the filter
 * would update a soft-deleted row in place instead of creating a live row,
 * and the charge would vanish from the invoice while the header total still
 * counted it.
 *
 * These are query shapes, so this asserts the queries. Every file below reads
 * invoice_line_items on a path a customer or an API consumer can see.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
const DASHBOARD = join(SRC, '..', 'dashboard');

const LINE_ITEM_WRITER = join(SRC, 'src', 'common', 'utils', 'invoice', 'invoice.utils.ts');

const CUSTOMER_VISIBLE_READS = [
  join(SRC, 'src', 'modules', 'invoices', 'invoices.service.ts'),
  join(SRC, 'src', 'modules', 'sdk', 'sdk.service.ts'),
  join(SRC, 'src', 'modules', 'portal-api', 'portal-api.service.ts'),
  join(SRC, 'src', 'modules', 'subscription', 'subscription-billing.service.ts'),
  join(DASHBOARD, 'app', 'actions', 'invoices.ts'),
  join(
    DASHBOARD,
    'app',
    '(customer-portal)',
    'portal',
    '[slug]',
    '(main)',
    'invoices',
    '[invoiceId]',
    'page.tsx',
  ),
];

describe('reads of invoice_line_items a customer can see', () => {
  it.each(CUSTOMER_VISIBLE_READS)('%s filters soft-deleted rows', (file) => {
    const source = readFileSync(file, 'utf8');

    // `invoice_line_items: true` pulls every row including the deleted ones.
    expect(source).not.toMatch(/invoice_line_items:\s*true/);

    // And every read of them names the filter. A nested `{ create: ... }` is
    // a write, not a read, so it is skipped.
    const reads = [...source.matchAll(/invoice_line_items:\s*\{(?!\s*create)([\s\S]{0,60})/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const [, body] of reads) {
      expect(body).toContain('deletedAt: null');
    }
  });

  it('the line-item writer matches live rows only', () => {
    const source = readFileSync(LINE_ITEM_WRITER, 'utf8');
    // Updating a soft-deleted row instead of creating a live one loses the
    // charge from the invoice while the header total still counts it.
    expect(source).toMatch(/where:\s*\{\s*invoiceId: invoice\.id,\s*deletedAt: null\s*\}/);
  });
});
