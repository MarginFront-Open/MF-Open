/**
 * Tests for InvoicesService.
 *
 * Two behaviors locked down here:
 *
 *   1. createInvoice honors `dto.lineItems`, writes invoice_line_items rows and
 *      computes non-zero totals, rather than creating a $0 shell with no line items.
 *
 *   2. generateInvoice composes SubscriptionBillingService.createUsageDraftInvoice +
 *      updateUsageDraftInvoice to produce a real draft with line items derived from the
 *      subscription's actual usage events, never a $0 shell.
 *
 * The codebase convention (see invoice-payment-reconciler.service.spec.ts) is in-memory
 * mock Prisma + NestJS Testing module — fast, no DB dependency.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { EmailService } from '../email/email.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { SubscriptionBillingService } from '../subscription/subscription-billing.service';
import { InvoicePaymentReconciler } from './invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from './invoice-refund-finalizer.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222';
const WRONG_CUSTOMER_ID = '99999999-9999-9999-9999-999999999999';
const SUBSCRIPTION_ID = '33333333-3333-3333-3333-333333333333';
const DRAFT_INVOICE_ID = '44444444-4444-4444-4444-444444444444';

function buildMockPrisma() {
  const lastInvoiceCreate: { data: any } = { data: null };
  const seededSubscriptions = new Map<string, any>();
  const seededInvoices = new Map<string, any>();

  const prisma = {
    invoices: {
      create: jest.fn(async ({ data, include: _include }: any) => {
        lastInvoiceCreate.data = data;
        const fakeRow = {
          ...data,
          invoice_line_items: data.invoice_line_items?.create ?? [],
        };
        seededInvoices.set(data.id, fakeRow);
        return fakeRow;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return seededInvoices.get(where.id) ?? null;
      }),
    },
    subscriptions: {
      findUnique: jest.fn(async ({ where }: any) => {
        return seededSubscriptions.get(where.id) ?? null;
      }),
    },
  };

  return { prisma, lastInvoiceCreate, seededSubscriptions, seededInvoices };
}

function buildModule(prisma: any, subscriptionBilling: any): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: PrismaService, useValue: prisma },
      { provide: PdfService, useValue: {} },
      { provide: EmailService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: PaymentProcessingService, useValue: {} },
      { provide: InvoicePaymentReconciler, useValue: {} },
      { provide: InvoiceRefundFinalizer, useValue: {} },
      { provide: SubscriptionBillingService, useValue: subscriptionBilling },
    ],
  }).compile();
}

// ─── createInvoice: honor lineItems ────────────────────────────────────────────────

describe('InvoicesService.createInvoice — honors lineItems', () => {
  let service: InvoicesService;
  let prisma: any;
  let lastInvoiceCreate: { data: any };

  beforeEach(async () => {
    const mocks = buildMockPrisma();
    prisma = mocks.prisma;
    lastInvoiceCreate = mocks.lastInvoiceCreate;
    const module = await buildModule(prisma, {});
    service = module.get(InvoicesService);
  });

  it('writes line items + correct subtotal when lineItems is provided', async () => {
    const result = await service.createInvoice(ORG_ID, {
      customerId: CUSTOMER_ID,
      dueDate: new Date('2026-06-01'),
      lineItems: [
        { description: 'API calls', quantity: 498, unitPrice: 0.5 },
        { description: 'Bandwidth GB', quantity: 10, unitPrice: 0.1 },
      ],
    } as any);

    expect(prisma.invoices.create).toHaveBeenCalledTimes(1);
    expect(lastInvoiceCreate.data.subtotal).toBe('250');
    expect(lastInvoiceCreate.data.totalAmount).toBe('250');
    expect(lastInvoiceCreate.data.amountDue).toBe('250');
    expect(lastInvoiceCreate.data.invoice_line_items.create).toHaveLength(2);
    expect(lastInvoiceCreate.data.invoice_line_items.create[0]).toMatchObject({
      description: 'API calls',
      quantity: 498,
      unitPrice: 0.5,
      amount: 249,
    });
    expect(result).toBeDefined();
  });

  /**
   * A blended price cannot be rebuilt from what the row stores: a
   * $99 credit pool over 400 credits is $0.2475 each, which numeric(12,2)
   * keeps as $0.25. Recomputing `amount = quantity x unitPrice` and deriving
   * the header from it would turn $99.00 into $100.00 when that invoice is
   * re-issued through the API.
   */
  it('honours a stated line amount over quantity x unitPrice', async () => {
    await service.createInvoice(ORG_ID, {
      customerId: CUSTOMER_ID,
      dueDate: new Date('2026-06-01'),
      lineItems: [
        { description: 'report: 400 credits', quantity: 400, unitPrice: 0.25, amount: 99 },
      ],
    } as any);

    expect(lastInvoiceCreate.data.invoice_line_items.create[0].amount).toBe(99);
    expect(lastInvoiceCreate.data.subtotal).toBe('99');
    expect(lastInvoiceCreate.data.totalAmount).toBe('99');
    expect(lastInvoiceCreate.data.amountDue).toBe('99');
    // NEGATIVE CONTROL: the number a recompute would produce.
    expect(400 * 0.25).toBe(100);
  });

  it('still derives the amount for a line that states none', async () => {
    await service.createInvoice(ORG_ID, {
      customerId: CUSTOMER_ID,
      dueDate: new Date('2026-06-01'),
      lineItems: [{ description: 'Consulting hours', quantity: 3, unitPrice: 150 }],
    } as any);

    expect(lastInvoiceCreate.data.invoice_line_items.create[0].amount).toBe(450);
    expect(lastInvoiceCreate.data.subtotal).toBe('450');
  });

  it('produces a $0 invoice with empty line items when lineItems is missing (no regression)', async () => {
    await service.createInvoice(ORG_ID, {
      customerId: CUSTOMER_ID,
      dueDate: new Date('2026-06-01'),
    } as any);

    expect(lastInvoiceCreate.data.subtotal).toBe('0');
    expect(lastInvoiceCreate.data.totalAmount).toBe('0');
    expect(lastInvoiceCreate.data.invoice_line_items.create).toEqual([]);
  });

  it('applies taxAmount and discountAmount to totalAmount', async () => {
    await service.createInvoice(ORG_ID, {
      customerId: CUSTOMER_ID,
      dueDate: new Date('2026-06-01'),
      lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
      taxAmount: 7,
      discountAmount: 10,
    } as any);

    expect(lastInvoiceCreate.data.subtotal).toBe('100');
    expect(lastInvoiceCreate.data.taxAmount).toBe('7');
    expect(lastInvoiceCreate.data.discountAmount).toBe('10');
    expect(lastInvoiceCreate.data.totalAmount).toBe('97');
    expect(lastInvoiceCreate.data.amountDue).toBe('97');
  });
});

// ─── generateInvoice: composition over subscription-billing ────────────────────────

describe('InvoicesService.generateInvoice — composes subscription-billing', () => {
  let service: InvoicesService;
  let prisma: any;
  let seededSubscriptions: Map<string, any>;
  let seededInvoices: Map<string, any>;
  let subscriptionBilling: {
    createUsageDraftInvoice: jest.Mock;
    updateUsageDraftInvoice: jest.Mock;
  };

  beforeEach(async () => {
    const mocks = buildMockPrisma();
    prisma = mocks.prisma;
    seededSubscriptions = mocks.seededSubscriptions;
    seededInvoices = mocks.seededInvoices;

    subscriptionBilling = {
      createUsageDraftInvoice: jest.fn(async (sub: any) => {
        const draft = {
          id: DRAFT_INVOICE_ID,
          organizationId: sub.organizationId,
          customerId: sub.customerId,
          subscriptionId: sub.id,
          status: 'draft',
          subtotal: '0',
          totalAmount: '0',
          amountDue: '0',
          invoiceNumber: 'INV-DRAFT',
          billingPeriodStart: sub.currentBillingPeriodStart,
          billingPeriodEnd: sub.currentBillingPeriodEnd,
        };
        seededInvoices.set(draft.id, { ...draft, invoice_line_items: [] });
        return draft;
      }),
      updateUsageDraftInvoice: jest.fn(async (invoice: any, _sub: any) => {
        const populated = {
          ...invoice,
          subtotal: '249',
          totalAmount: '249',
          amountDue: '249',
        };
        seededInvoices.set(invoice.id, {
          ...populated,
          invoice_line_items: [
            { id: 'li-1', description: 'API calls', quantity: 498, unitPrice: 0.5, amount: 249 },
          ],
          customers: { id: CUSTOMER_ID, name: 'Test Customer', email: 'test@example.com' },
          invoice_payments: [],
        });
        return populated;
      }),
    };

    const module = await buildModule(prisma, subscriptionBilling);
    service = module.get(InvoicesService);
  });

  it('composes createUsageDraftInvoice + updateUsageDraftInvoice for the happy path', async () => {
    seededSubscriptions.set(SUBSCRIPTION_ID, {
      id: SUBSCRIPTION_ID,
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      currentBillingPeriodStart: new Date('2026-04-01'),
      currentBillingPeriodEnd: new Date('2026-04-30'),
    });

    const result = await service.generateInvoice(CUSTOMER_ID, SUBSCRIPTION_ID);

    expect(subscriptionBilling.createUsageDraftInvoice).toHaveBeenCalledTimes(1);
    expect(subscriptionBilling.updateUsageDraftInvoice).toHaveBeenCalledTimes(1);
    expect((result as any).id).toBe(DRAFT_INVOICE_ID);
    expect((result as any).subtotal).toBe('249');
    expect((result as any).totalAmount).toBe('249');
    expect((result as any).invoice_line_items).toHaveLength(1);
    expect((result as any).invoice_line_items[0].amount).toBe(249);
  });

  it('passes billing period overrides through to subscription-billing', async () => {
    seededSubscriptions.set(SUBSCRIPTION_ID, {
      id: SUBSCRIPTION_ID,
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      currentBillingPeriodStart: new Date('2026-05-01'),
      currentBillingPeriodEnd: new Date('2026-05-31'),
    });

    const overrideStart = new Date('2026-03-01');
    const overrideEnd = new Date('2026-03-31');

    await service.generateInvoice(CUSTOMER_ID, SUBSCRIPTION_ID, overrideStart, overrideEnd);

    const createCallArg = subscriptionBilling.createUsageDraftInvoice.mock.calls[0][0];
    expect(createCallArg.currentBillingPeriodStart).toEqual(overrideStart);
    expect(createCallArg.currentBillingPeriodEnd).toEqual(overrideEnd);
  });

  it('throws NotFoundException when the subscription does not exist', async () => {
    await expect(service.generateInvoice(CUSTOMER_ID, SUBSCRIPTION_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(subscriptionBilling.createUsageDraftInvoice).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the subscription has no organizationId', async () => {
    seededSubscriptions.set(SUBSCRIPTION_ID, {
      id: SUBSCRIPTION_ID,
      organizationId: null,
      customerId: CUSTOMER_ID,
      currentBillingPeriodStart: new Date('2026-04-01'),
      currentBillingPeriodEnd: new Date('2026-04-30'),
    });

    await expect(service.generateInvoice(CUSTOMER_ID, SUBSCRIPTION_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(subscriptionBilling.createUsageDraftInvoice).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when the customer does not own the subscription', async () => {
    seededSubscriptions.set(SUBSCRIPTION_ID, {
      id: SUBSCRIPTION_ID,
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      currentBillingPeriodStart: new Date('2026-04-01'),
      currentBillingPeriodEnd: new Date('2026-04-30'),
    });

    await expect(service.generateInvoice(WRONG_CUSTOMER_ID, SUBSCRIPTION_ID)).rejects.toThrow(
      BadRequestException,
    );
    expect(subscriptionBilling.createUsageDraftInvoice).not.toHaveBeenCalled();
  });
});

// ─── cross-tenant READ isolation ─────────────────────────────────────────────────
//
// Looking an invoice/payment up by id ALONE would let any authenticated key (even a
// publishable one) read another org's invoice by guessing the id. Every TENANT read is
// scoped to the CALLER's organizationId
// (which comes from the authenticated principal, never the URL/body). These tests prove:
//
//   1. org A is DENIED (NotFoundException, no data) reading org B's invoice/payment by id
//   2. the same principal IS allowed its own org's record
//   3. the INTERNAL callers (PDF/cron path via getInvoiceByIdInternal) still resolve an
//      invoice by id alone
//
// The mock Prisma below models the two query shapes precisely:
//   - findFirst({ where: { id, organizationId } })  -> org-scoped tenant read (must filter)
//   - findUnique({ where: { id } })                 -> unscoped internal read (id only)
// so a test only passes if the SERVICE actually passes organizationId into the query.
describe('InvoicesService — cross-tenant read isolation', () => {
  const ORG_A = ORG_ID; // the caller's own org
  const ORG_B = '88888888-8888-8888-8888-888888888888'; // the victim org
  const INVOICE_A = '55555555-5555-5555-5555-555555555555'; // belongs to ORG_A
  const INVOICE_B = '66666666-6666-6666-6666-666666666666'; // belongs to ORG_B
  const PAYMENT_B = '77777777-7777-7777-7777-777777777777'; // payment ON invoice B (org B)

  let service: InvoicesService;
  let prisma: any;

  beforeEach(async () => {
    const invoiceRows = [
      { id: INVOICE_A, organizationId: ORG_A, invoiceNumber: 'INV-A' },
      { id: INVOICE_B, organizationId: ORG_B, invoiceNumber: 'INV-B' },
    ];
    const paymentRows = [{ id: PAYMENT_B, invoiceId: INVOICE_B, amount: '10' }];

    prisma = {
      invoices: {
        // org-scoped tenant read: only matches when BOTH id AND organizationId agree
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            invoiceRows.find(
              (i) => i.id === where.id && i.organizationId === where.organizationId,
            ) ?? null
          );
        }),
        // unscoped internal read: id only, no org filter
        findUnique: jest.fn(async ({ where }: any) => {
          return invoiceRows.find((i) => i.id === where.id) ?? null;
        }),
      },
      invoice_payments: {
        // tenant payment read scopes through the parent invoice's org:
        // where = { id, invoices: { organizationId } }
        findFirst: jest.fn(async ({ where }: any) => {
          const payment = paymentRows.find((p) => p.id === where.id);
          if (!payment) return null;
          const requiredOrg = where.invoices?.organizationId;
          if (requiredOrg) {
            const parent = invoiceRows.find((i) => i.id === payment.invoiceId);
            if (!parent || parent.organizationId !== requiredOrg) return null;
          }
          return payment;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          return paymentRows.filter((p) => p.invoiceId === where.invoiceId);
        }),
      },
    };

    const module = await buildModule(prisma, {});
    service = module.get(InvoicesService);
  });

  it('DENIES org A reading org B invoice by id (404, no data leaked)', async () => {
    await expect(service.getInvoiceById(INVOICE_B, ORG_A)).rejects.toThrow(NotFoundException);
    // proves the org filter is actually applied — not just that the row is missing
    expect(prisma.invoices.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: INVOICE_B, organizationId: ORG_A }),
      }),
    );
  });

  it('ALLOWS org A reading its OWN invoice', async () => {
    const inv = await service.getInvoiceById(INVOICE_A, ORG_A);
    expect(inv.id).toBe(INVOICE_A);
    expect((inv as any).organizationId).toBe(ORG_A);
  });

  it('DENIES org A reading a payment whose parent invoice belongs to org B', async () => {
    await expect(service.getPayment(PAYMENT_B, ORG_A)).rejects.toThrow(NotFoundException);
    expect(prisma.invoice_payments.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PAYMENT_B,
          invoices: { organizationId: ORG_A },
        }),
      }),
    );
  });

  it('ALLOWS org B reading its OWN payment', async () => {
    const pay = await service.getPayment(PAYMENT_B, ORG_B);
    expect((pay as any).id).toBe(PAYMENT_B);
  });

  it('getInvoicePayments DENIES cross-tenant before touching the payments table', async () => {
    // the parent-invoice org check must throw before findMany is ever reached
    await expect(service.getInvoicePayments(INVOICE_B, ORG_A)).rejects.toThrow(NotFoundException);
    expect(prisma.invoice_payments.findMany).not.toHaveBeenCalled();
  });

  it('INTERNAL getInvoiceByIdInternal still resolves an invoice by id alone (PDF/cron path unbroken)', async () => {
    // The internal (non-tenant) read must NOT org-filter, or the
    // billing cron + PDF generation would 404 on invoices they legitimately own.
    const inv = await service.getInvoiceByIdInternal(INVOICE_B);
    expect(inv.id).toBe(INVOICE_B);
    // internal path uses findUnique (id only) and NEVER the org-scoped findFirst
    expect(prisma.invoices.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: INVOICE_B } }),
    );
    expect(prisma.invoices.findFirst).not.toHaveBeenCalled();
  });

  // ── fail-closed on a MISSING org ───────────────────────────────
  // The org value comes from the authenticated principal, but one auth path — a Better
  // Auth JWT (or an org-less session) — can arrive with organizationId undefined. Prisma
  // silently drops an undefined `where` key, so without an explicit guard the filter
  // `{ id, organizationId: undefined }` would collapse to `{ id }`: a cross-tenant read.
  // These tests prove the service throws BEFORE the query is ever built, so an undefined
  // org can never disable the where-clause filter.

  it('FAILS CLOSED: getInvoiceById with an undefined org throws and never queries', async () => {
    await expect(service.getInvoiceById(INVOICE_B, undefined as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.invoices.findFirst).not.toHaveBeenCalled();
    expect(prisma.invoices.findUnique).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: getPayment with an undefined org throws and never queries', async () => {
    await expect(service.getPayment(PAYMENT_B, undefined as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.invoice_payments.findFirst).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: getInvoicePayments with an undefined org throws and never queries', async () => {
    await expect(service.getInvoicePayments(INVOICE_B, undefined as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.invoices.findFirst).not.toHaveBeenCalled();
    expect(prisma.invoice_payments.findMany).not.toHaveBeenCalled();
  });
});

// ─── cross-tenant WRITE isolation on generateInvoice ────────────────
//
// generateInvoice PERSISTS a draft invoice inside subscription.organizationId, so the
// subscription lookup is the tenant boundary for this write. If the public
// (POST /v1/invoices/generate) and SDK handlers resolved the subscription by id ALONE, a
// money-role user in org A could pass org B's customerId/subscriptionId and CREATE (and read
// back) a draft invoice inside org B's books. The customerId === subscription.customerId
// check is intra-record only and is no tenant boundary. The handlers thread the caller's org
// (from the authenticated principal) and resolve the subscription org-scoped. These tests
// prove:
//
//   1. a TENANT caller (org A) is DENIED billing org B's subscription (404, NOTHING written)
//   2. the same caller CAN bill its OWN org's subscription
//   3. the INTERNAL/cron path (no caller org -> generateInvoiceInternal handler) keeps the
//      unscoped by-id lookup so system billing keeps working
//   4. fail-closed: a blank caller org throws BEFORE any query or write (Prisma-drops-
//      undefined can never silently widen the subscription filter)
//
// Same two-query-shape mock as the read block above, so a test only passes if the SERVICE
// actually passes organizationId into the subscription lookup:
//   - findFirst({ where: { id, organizationId } })  -> org-scoped tenant write gate
//   - findUnique({ where: { id } })                 -> unscoped internal/system path
describe('InvoicesService.generateInvoice — cross-tenant write isolation', () => {
  const ORG_A = ORG_ID; // the caller's own org
  const ORG_B = '88888888-8888-8888-8888-888888888888'; // the victim org
  const SUB_A = SUBSCRIPTION_ID; // belongs to ORG_A, owned by CUSTOMER_ID
  const SUB_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // belongs to ORG_B
  const CUSTOMER_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // org B's customer

  let service: InvoicesService;
  let prisma: any;
  let subscriptionBilling: {
    createUsageDraftInvoice: jest.Mock;
    updateUsageDraftInvoice: jest.Mock;
  };

  beforeEach(async () => {
    const subscriptionRows = [
      {
        id: SUB_A,
        organizationId: ORG_A,
        customerId: CUSTOMER_ID,
        currentBillingPeriodStart: new Date('2026-04-01'),
        currentBillingPeriodEnd: new Date('2026-04-30'),
      },
      {
        id: SUB_B,
        organizationId: ORG_B,
        customerId: CUSTOMER_B,
        currentBillingPeriodStart: new Date('2026-04-01'),
        currentBillingPeriodEnd: new Date('2026-04-30'),
      },
    ];
    const invoiceStore = new Map<string, any>();

    prisma = {
      subscriptions: {
        // org-scoped tenant gate: matches only when BOTH id AND organizationId agree
        findFirst: jest.fn(
          async ({ where }: any) =>
            subscriptionRows.find(
              (s) => s.id === where.id && s.organizationId === where.organizationId,
            ) ?? null,
        ),
        // unscoped internal lookup: id only (cron/system path)
        findUnique: jest.fn(
          async ({ where }: any) => subscriptionRows.find((s) => s.id === where.id) ?? null,
        ),
      },
      invoices: {
        // getInvoiceByIdInternal round-trip read after the draft is persisted
        findUnique: jest.fn(async ({ where }: any) => invoiceStore.get(where.id) ?? null),
      },
    };

    subscriptionBilling = {
      createUsageDraftInvoice: jest.fn(async (sub: any) => {
        const draft = {
          id: DRAFT_INVOICE_ID,
          organizationId: sub.organizationId,
          customerId: sub.customerId,
          subscriptionId: sub.id,
          status: 'draft',
        };
        invoiceStore.set(draft.id, {
          ...draft,
          invoice_line_items: [],
          invoice_payments: [],
          customers: null,
        });
        return draft;
      }),
      updateUsageDraftInvoice: jest.fn(async (invoice: any) => invoice),
    };

    const module = await buildModule(prisma, subscriptionBilling);
    service = module.get(InvoicesService);
  });

  it('DENIES org A generating an invoice against org B subscription (404, nothing written)', async () => {
    await expect(
      service.generateInvoice(CUSTOMER_B, SUB_B, undefined, undefined, ORG_A),
    ).rejects.toThrow(NotFoundException);
    // proves the org filter is actually applied to the gate query, not just a missing row
    expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SUB_B, organizationId: ORG_A }),
      }),
    );
    // and NOTHING was written into org B's books
    expect(subscriptionBilling.createUsageDraftInvoice).not.toHaveBeenCalled();
    expect(subscriptionBilling.updateUsageDraftInvoice).not.toHaveBeenCalled();
    // the unscoped lookup must NOT be used on the tenant path
    expect(prisma.subscriptions.findUnique).not.toHaveBeenCalled();
  });

  it('ALLOWS org A generating an invoice against its OWN subscription', async () => {
    const result = await service.generateInvoice(CUSTOMER_ID, SUB_A, undefined, undefined, ORG_A);
    expect((result as any).id).toBe(DRAFT_INVOICE_ID);
    expect(subscriptionBilling.createUsageDraftInvoice).toHaveBeenCalledTimes(1);
    expect(subscriptionBilling.updateUsageDraftInvoice).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SUB_A, organizationId: ORG_A }),
      }),
    );
  });

  it('INTERNAL/cron path (no caller org) still resolves the subscription by id alone', async () => {
    // The CRON_SECRET system path carries no tenant org and must NOT
    // org-filter, or the billing cron would 404 on subscriptions it legitimately bills.
    const result = await service.generateInvoice(CUSTOMER_B, SUB_B);
    expect((result as any).id).toBe(DRAFT_INVOICE_ID);
    expect(prisma.subscriptions.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SUB_B }, include: { pricing_plans: true } }),
    );
    expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: a blank caller org throws BEFORE any query or write', async () => {
    await expect(
      service.generateInvoice(CUSTOMER_B, SUB_B, undefined, undefined, ''),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptions.findUnique).not.toHaveBeenCalled();
    expect(subscriptionBilling.createUsageDraftInvoice).not.toHaveBeenCalled();
  });
});

// ─── sendInvoiceEmail: customer-facing footer contact line ────────────────────────────

const SEND_CONFIG = {
  get: jest.fn((key: string) =>
    key === 'FRONTEND_URL' ? 'https://billing.example.com' : undefined,
  ),
};

describe('InvoicesService.sendInvoiceEmail — footer contact line', () => {
  const INVOICE_ID = '55555555-5555-5555-5555-555555555555';

  function buildSendHarness(organizationOverrides: any) {
    const prisma = {
      invoices: {
        findFirst: jest.fn(async () => ({
          id: INVOICE_ID,
          organizationId: ORG_ID,
          invoiceNumber: 'INV-777',
          status: 'open',
          totalAmount: '100.00',
          amountDue: '100.00',
          currency: 'USD',
          invoiceDate: new Date('2026-07-01'),
          dueDate: new Date('2026-07-15'),
          customers: { id: CUSTOMER_ID, name: 'Joan Customer', email: 'joan@example.com' },
          organizations: {
            id: ORG_ID,
            name: 'Acme Co',
            billing_email: null,
            billingIdentity: null,
            ...organizationOverrides,
          },
          invoice_line_items: [],
        })),
      },
    };
    const emailService = {
      isEnabled: true,
      sendEmail: jest.fn(async (_payload: { html: string }) => ({ id: 'email-1' })),
      invoiceFromEmail: 'Example Invoices <noreply@billing.example.com>',
    };
    return { prisma, emailService };
  }

  async function sendAndGetHtml(organizationOverrides: any): Promise<string> {
    const { prisma, emailService } = buildSendHarness(organizationOverrides);
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: {} },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: SEND_CONFIG },
        { provide: PaymentProcessingService, useValue: {} },
        { provide: InvoicePaymentReconciler, useValue: {} },
        { provide: InvoiceRefundFinalizer, useValue: {} },
        { provide: SubscriptionBillingService, useValue: {} },
      ],
    }).compile();
    const service = module.get(InvoicesService);
    await service.sendInvoiceEmail(INVOICE_ID, ORG_ID, {} as any);
    return emailService.sendEmail.mock.calls[0][0].html;
  }

  it('billing_email wins over billingIdentity.email', async () => {
    const html = await sendAndGetHtml({
      billing_email: 'bill@acme.test',
      billingIdentity: { email: 'identity@acme.test' },
    });
    expect(html).toContain('mailto:bill@acme.test');
    expect(html).not.toContain('identity@acme.test');
  });

  it('billing_email null → contact line renders billingIdentity.email', async () => {
    const html = await sendAndGetHtml({
      billingIdentity: { email: 'identity@acme.test' },
    });
    expect(html).toContain('mailto:identity@acme.test');
  });

  it('neither set → no mailto at all, falls back to the bare org name', async () => {
    const html = await sendAndGetHtml({});
    expect(html).not.toContain('mailto:');
    expect(html).toContain('Contact Acme Co');
  });

  it('malformed billingIdentity (string) never throws and never prints', async () => {
    const html = await sendAndGetHtml({ billingIdentity: 'not-an-object' });
    expect(html).not.toContain('mailto:');
    expect(html).toContain('Contact Acme Co');
  });
});

describe('InvoicesService — sends tell the truth about email', () => {
  const INVOICE_ID = '66666666-6666-6666-6666-666666666666';

  function invoiceRow(status: string) {
    return {
      id: INVOICE_ID,
      organizationId: ORG_ID,
      invoiceNumber: 'INV-900',
      status,
      totalAmount: '50.00',
      amountDue: '50.00',
      currency: 'USD',
      invoiceDate: new Date('2026-07-01'),
      dueDate: new Date('2026-07-15'),
      customers: { id: CUSTOMER_ID, name: 'Joan Customer', email: 'joan@example.com' },
      organizations: { id: ORG_ID, name: 'Acme Co', billing_email: null, billingIdentity: null },
      invoice_line_items: [],
    };
  }

  async function build(status: string, emailEnabled: boolean) {
    const prisma = {
      invoices: {
        findFirst: jest.fn(async () => invoiceRow(status)),
        update: jest.fn(async () => ({})),
      },
    };
    const emailService = {
      isEnabled: emailEnabled,
      sendEmail: jest.fn(async () => ({ id: 'email-42' })),
      invoiceFromEmail: 'Example Invoices <noreply@billing.example.com>',
    };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: {} },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: SEND_CONFIG },
        { provide: PaymentProcessingService, useValue: {} },
        { provide: InvoicePaymentReconciler, useValue: {} },
        { provide: InvoiceRefundFinalizer, useValue: {} },
        { provide: SubscriptionBillingService, useValue: {} },
      ],
    }).compile();
    return { service: module.get(InvoicesService), prisma, emailService };
  }

  it('manual send answers 503 and changes nothing when email is turned off', async () => {
    const { service, prisma, emailService } = await build('draft', false);

    const rejection = service.sendInvoiceEmail(INVOICE_ID, ORG_ID, {} as any);

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(rejection).rejects.toThrow(/Email is turned off.*not emailed/s);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(prisma.invoices.update).not.toHaveBeenCalled();
  });

  it('reminder emails the customer with a Reminder subject, then records it', async () => {
    const { service, prisma, emailService } = await build('overdue', true);

    const result = await service.sendManualReminder(INVOICE_ID, ORG_ID);

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const sent = (emailService.sendEmail.mock.calls[0] as any[])[0];
    expect(sent.to).toBe('joan@example.com');
    expect(sent.subject).toBe('Reminder: Invoice INV-900 from Acme Co');
    expect(result).toEqual({
      message: 'Reminder emailed to joan@example.com',
      emailSent: true,
      emailId: 'email-42',
      recipientEmail: 'joan@example.com',
    });
    expect(prisma.invoices.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastReminderSentAt: expect.any(Date) }),
      }),
    );
  });

  it('reminder never claims success when email is off, and records nothing', async () => {
    const { service, prisma, emailService } = await build('issued', false);

    await expect(service.sendManualReminder(INVOICE_ID, ORG_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(prisma.invoices.update).not.toHaveBeenCalled();
  });

  it.each(['draft', 'paid', 'void', 'refunded'])(
    'reminder refuses a %s invoice with a clear reason and sends nothing',
    async (status) => {
      const { service, prisma, emailService } = await build(status, true);

      await expect(service.sendManualReminder(INVOICE_ID, ORG_ID)).rejects.toThrow(
        new RegExp(`INV-900 is ${status}.*only be sent for issued, pending or overdue`, 's'),
      );
      expect(emailService.sendEmail).not.toHaveBeenCalled();
      expect(prisma.invoices.update).not.toHaveBeenCalled();
    },
  );
});
