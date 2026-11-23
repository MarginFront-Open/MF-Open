/**
 * WHAT THIS FILE DOES: unit tests for two invoice.utils.ts helpers:
 *   - generateIssuedUsageInvoiceNumber — mints a real customer-facing invoice
 *     number (INV-YYYYMM-NNNNN) the moment the dispatch cron issues a usage
 *     invoice.
 *   - findOverdueInvoices — the query the daily mark-overdue cron runs to find
 *     issued, past-due invoices to flip to 'overdue'.
 * WHY IT EXISTS: an issued bill must never carry the throwaway "DRAFT-…"
 *   placeholder. This helper replaces that placeholder; these tests lock down
 *   the three things that have to be right — the format, the org-scoped
 *   sequencing, and the collision "walk-forward" (the real risk: never hand
 *   back a number that's already taken, and never loop forever trying).
 * CONNECTS TO: invoice.utils.ts (the helpers under test) and
 *   subscription-billing.service.ts (dispatchUsageInvoices and
 *   markOverdueInvoices, which call these).
 */
import { generateIssuedUsageInvoiceNumber, findOverdueInvoices } from './invoice.utils';

// Minimal Prisma-shaped stub. The helper only ever touches invoices.count and
// invoices.findFirst, so we stub just those two. `takenNumbers` lets a test say
// "pretend these invoice numbers already exist for this org."
const makeClient = (count: number, takenNumbers: string[] = []) => {
  const taken = new Set(takenNumbers);
  return {
    invoices: {
      count: jest.fn().mockResolvedValue(count),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(taken.has(where.invoiceNumber) ? { id: 'existing' } : null),
      ),
    },
  } as any;
};

const ORG = 'org_123';

// The helper stamps the current year + month. Build the same prefix here so the
// sequence assertions don't depend on which month the test happens to run in.
const expectedPrefix = (): string => {
  const now = new Date();
  return `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`;
};

describe('generateIssuedUsageInvoiceNumber', () => {
  it('returns a number in the customer-facing INV-YYYYMM-NNNNN format', async () => {
    const result = await generateIssuedUsageInvoiceNumber(ORG, makeClient(6));
    expect(result).toMatch(/^INV-\d{6}-\d{5}$/);
  });

  it('sequences from the org invoice count + 1, zero-padded to 5 digits', async () => {
    const result = await generateIssuedUsageInvoiceNumber(ORG, makeClient(6));
    expect(result).toBe(`${expectedPrefix()}00007`);
  });

  it('scopes the invoice count to the organization', async () => {
    const client = makeClient(0);
    await generateIssuedUsageInvoiceNumber(ORG, client);
    expect(client.invoices.count).toHaveBeenCalledWith({ where: { organizationId: ORG } });
  });

  it('walks forward when the first candidate number is already taken', async () => {
    // count=6 → first candidate is 00007; mark it taken so it must bump to 00008.
    const client = makeClient(6, [`${expectedPrefix()}00007`]);
    const result = await generateIssuedUsageInvoiceNumber(ORG, client);
    expect(result).toBe(`${expectedPrefix()}00008`);
  });

  it('increments past multiple taken numbers (proves it is not a no-op recount)', async () => {
    // A plain "recount" would hand back the same taken number forever. We must
    // actually step past each collision.
    const client = makeClient(6, [
      `${expectedPrefix()}00007`,
      `${expectedPrefix()}00008`,
      `${expectedPrefix()}00009`,
    ]);
    const result = await generateIssuedUsageInvoiceNumber(ORG, client);
    expect(result).toBe(`${expectedPrefix()}00010`);
  });

  it('throws (rather than looping forever) if no free number can be found', async () => {
    // findFirst always reports the candidate as taken → the bounded loop gives up
    // with a clear error instead of spinning.
    const client = {
      invoices: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ id: 'always-taken' }),
      },
    } as any;
    await expect(generateIssuedUsageInvoiceNumber(ORG, client)).rejects.toThrow(
      /Could not generate a unique invoice number/,
    );
  });
});

// The soft-delete filter lives entirely in the Prisma `where` clause
// (Postgres does the filtering, not this function), so the only way to prove it's
// applied is to pin the exact where shape passed to findMany — same approach as the
// `client.invoices.count` assertions above.
describe('findOverdueInvoices', () => {
  const makeInvoicesClient = (rows: any[] = []) =>
    ({
      invoices: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    }) as any;

  it('queries issued, past-due invoices, excluding soft-deleted invoices', async () => {
    const client = makeInvoicesClient();
    const referenceDate = new Date('2026-08-05T05:00:00.000Z');

    await findOverdueInvoices({ referenceDate }, client);

    expect(client.invoices.findMany).toHaveBeenCalledWith({
      where: {
        status: 'issued',
        dueDate: { lt: referenceDate },
        deletedAt: null,
      },
      include: {
        customers: true,
        subscriptions: true,
      },
    });
  });

  it('defaults referenceDate to now when the caller omits it', async () => {
    const client = makeInvoicesClient();
    const before = new Date();

    await findOverdueInvoices({}, client);

    const after = new Date();
    const calledDueDate = client.invoices.findMany.mock.calls[0][0].where.dueDate.lt;
    expect(calledDueDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(calledDueDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('returns whatever Prisma resolves', async () => {
    const realInvoice = { id: 'inv-1', status: 'issued' };
    const client = makeInvoicesClient([realInvoice]);

    const result = await findOverdueInvoices({ referenceDate: new Date() }, client);

    expect(result).toEqual([realInvoice]);
  });
});
