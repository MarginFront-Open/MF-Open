/**
 * Tests for SubscriptionBillingService's billing cron, dispatchUsageInvoices():
 * daily 04:00 UTC, issue usage invoices for subs whose period closed and email them.
 *
 * The method composes existing helpers on the same class (createUsageDraftInvoice,
 * updateUsageDraftInvoice, calculateBillingPeriodAndDates) — we spy on those so we can
 * prove the orchestration logic without re-testing the helpers themselves.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SubscriptionBillingService } from './subscription-billing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InvoiceCalculatorService } from '../invoice-calculator/invoice-calculator.service';
import { PdfService } from '../pdf/pdf.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { EmailService } from '../email/email.service';

// ───────────────────────── dispatchUsageInvoices ─────────────────────────
//
// The single-pass cron. We spy the leaf helpers
// (createUsageDraftInvoice / updateUsageDraftInvoice / generatePDFForInvoice /
// calculateBillingPeriodAndDates) and mock the calculator + payment service, so these
// tests prove the orchestration (issue, advance-once, idempotency CAS, zero-usage
// advances-without-issuing, failure isolation) without re-testing the helpers.

const DISPATCH_SUB = 'dddd4444-4444-4444-4444-444444444444';

function freshDispatchPrismaMock() {
  const mock: any = {
    subscriptions: {
      findMany: jest.fn(),
      update: jest.fn(async (a: any) => a.data),
      // CAS advance/idempotency guard. Default: the claim succeeds (count 1).
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    invoices: {
      // Mirrors Prisma returning the full updated row: a base invoice merged with the
      // status/date writes dispatch applies. Tests read invoiceNumber/amountDue/etc off this.
      update: jest.fn(async (a: any) => ({
        id: a.where.id,
        invoiceNumber: 'INV-DISPATCH',
        amountDue: '249.00',
        totalAmount: '249.00',
        currency: 'USD',
        autoCollectPayment: false,
        ...a.data,
      })),
      // Zero-usage path discards the empty draft before advancing the period.
      delete: jest.fn(async (a: any) => ({ id: a.where.id })),
      // The issue path mints a real INV-YYYYMM-NNNNN number via
      // generateIssuedUsageInvoiceNumber, which reads count + findFirst. Empty
      // org: the first candidate is free.
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
    },
    invoice_line_items: {
      findMany: jest.fn(async () => [
        { description: 'API calls', quantity: 1000, unitPrice: 0.2, amount: 200 },
        { description: 'Storage GB', quantity: 49, unitPrice: 1, amount: 49 },
      ]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    // Merchant-recipient fallback: current owner-ROLE members. Default: none.
    ba_member: {
      findMany: jest.fn(async () => []),
    },
  };
  // Run the callback inline with `mock` as the tx client. A throw propagates, so
  // DispatchSkip and real errors reach the caller.
  mock.$transaction = jest.fn(async (cb: (tx: any) => Promise<any>) => cb(mock));
  return mock;
}

function freshDispatchEmailMock() {
  return {
    sendInvoiceReadyEmail: jest.fn().mockResolvedValue({}),
    sendMerchantInvoiceSentNotification: jest.fn().mockResolvedValue({}),
  };
}

async function buildDispatchService(prisma: any, email: any, calculator: any, payment: any) {
  const module = await Test.createTestingModule({
    providers: [
      SubscriptionBillingService,
      { provide: PrismaService, useValue: prisma },
      { provide: InvoiceCalculatorService, useValue: calculator },
      { provide: PdfService, useValue: {} },
      { provide: PaymentProcessingService, useValue: payment },
      { provide: EmailService, useValue: email },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) =>
            key === 'FRONTEND_URL' ? 'https://billing.example.com' : undefined,
          ),
        },
      },
    ],
  }).compile();
  return module.get(SubscriptionBillingService);
}

function dueSub(overrides: any = {}) {
  return {
    id: DISPATCH_SUB,
    organizationId: 'org-1',
    customerId: 'cust-1',
    status: 'active',
    billingModel: 'usage',
    billingCycle: 'monthly',
    cycleNumber: 3,
    netTerms: 30,
    currentBillingPeriodStart: new Date('2026-04-01'),
    currentBillingPeriodEnd: new Date('2026-04-30'),
    nextUsageInvoiceAt: new Date('2026-04-30'),
    timezone: 'UTC',
    customers: { id: 'cust-1', name: 'Joan Customer', email: 'joan@example.com' },
    organizations: {
      id: 'org-1',
      name: 'Acme Co',
      billing_email: 'bill@acme.test',
    },
    ...overrides,
  };
}

function stubDispatchHelpers(service: any, opts: { totalAmount?: string } = {}) {
  jest.spyOn(service, 'createUsageDraftInvoice').mockResolvedValue({
    id: 'draft-1',
    billingPeriodStart: new Date('2026-04-01'),
    billingPeriodEnd: new Date('2026-04-30'),
  });
  jest
    .spyOn(service, 'updateUsageDraftInvoice')
    .mockResolvedValue({ id: 'draft-1', totalAmount: opts.totalAmount ?? '249.00' });
  jest.spyOn(service, 'generatePDFForInvoice').mockResolvedValue({ s3Location: 's3://pdf' });
  jest.spyOn(service, 'calculateBillingPeriodAndDates').mockReturnValue({
    billingPeriodStart: new Date('2026-05-01'),
    billingPeriodEnd: new Date('2026-05-31'),
    subscriptionInvoiceIssuanceDate: new Date('2026-05-31'),
  });
}

describe('SubscriptionBillingService.dispatchUsageInvoices', () => {
  // Pin the clock to the dispatch tick after the fixtures' April period closes:
  // the service stamps `new Date()` into invoiceDate/dueDate + the INV-YYYYMM
  // prefix, so an unpinned clock drifts. Date only — faking setTimeout would
  // hang awaits. The blocks above use now-relative fixtures; they stay real-time.
  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
      now: new Date('2026-05-01T04:00:00.000Z'),
    });
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  function freshCalculator() {
    return {
      calculateInvoice: jest.fn().mockResolvedValue({
        calculationDetails: {
          subtotal: 249,
          total: 249,
          lineItems: [
            { description: 'API calls', amount: 200 },
            { description: 'Storage GB', amount: 49 },
          ],
        },
      }),
    };
  }
  function freshPayment() {
    return { createCheckoutSession: jest.fn().mockResolvedValue({ url: 'https://pay.test/x' }) };
  }

  it('happy path: issues invoice, sends BOTH emails, advances period + cycleNumber exactly once', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(1);
    expect(result.merchantEmailsSent).toBe(1);
    expect(result.skippedZeroEvents).toBe(0);
    expect(result.skippedConcurrent).toBe(0);
    expect(result.errors).toEqual([]);

    // Issued directly (not left as draft).
    const issueCall = prisma.invoices.update.mock.calls[0][0];
    expect(issueCall.where.id).toBe('draft-1');
    expect(issueCall.data.status).toBe('issued');
    expect(issueCall.data.isFinalizedUsage).toBe(true);

    // Period + cycleNumber advanced EXACTLY ONCE via the CAS updateMany.
    expect(prisma.subscriptions.updateMany).toHaveBeenCalledTimes(1);
    const advanceCall = prisma.subscriptions.updateMany.mock.calls[0][0];
    expect(advanceCall.where.id).toBe(DISPATCH_SUB);
    expect(advanceCall.where.nextUsageInvoiceAt).toEqual({ lte: expect.any(Date) }); // CAS condition
    expect(advanceCall.data.nextUsageInvoiceAt).toEqual(new Date('2026-05-31'));
    expect(advanceCall.data.cycleNumber).toBe(4); // 3 + 1
    expect(advanceCall.data.currentUsageDraftInvoiceId).toBeNull();
    // The plain subscriptions.update must NOT fire — dispatch advances ONCE, via the CAS.
    expect(prisma.subscriptions.update).not.toHaveBeenCalled();

    // Customer email: noreply path, /i/{id}/pay link.
    expect(email.sendInvoiceReadyEmail).toHaveBeenCalledTimes(1);
    const custCall = email.sendInvoiceReadyEmail.mock.calls[0][0];
    expect(custCall.to).toBe('joan@example.com');
    expect(custCall.paymentUrl).toBe('https://billing.example.com/i/draft-1/pay');

    // Merchant email: team@ path, billing_email recipient, both detail links.
    expect(email.sendMerchantInvoiceSentNotification).toHaveBeenCalledTimes(1);
    const merchCall = email.sendMerchantInvoiceSentNotification.mock.calls[0][0];
    expect(merchCall.to).toBe('bill@acme.test');
    expect(merchCall.invoiceDetailUrl).toBe('https://billing.example.com/invoices/draft-1');
    expect(merchCall.customerDetailUrl).toBe('https://billing.example.com/customers/cust-1');
    expect(merchCall.customerDeliveryIssue).toBeUndefined();
  });

  it('zero billable usage: issues NO invoice + NO emails, but STILL advances the period', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service, { totalAmount: '0' }); // zero total → no billable usage

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(0);
    expect(result.skippedZeroEvents).toBe(1);
    expect(result.errors).toEqual([]);

    // No invoice issued and no emails sent for an empty period…
    expect(prisma.invoices.update).not.toHaveBeenCalled();
    expect(email.sendInvoiceReadyEmail).not.toHaveBeenCalled();
    expect(email.sendMerchantInvoiceSentNotification).not.toHaveBeenCalled();

    // …the empty draft is discarded (line items first, then the draft row)…
    expect(prisma.invoice_line_items.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: 'draft-1' },
    });
    expect(prisma.invoices.delete).toHaveBeenCalledWith({ where: { id: 'draft-1' } });

    // …but the period STILL advances exactly once (rolling back here would freeze
    // the sub on the dead period forever).
    expect(prisma.subscriptions.updateMany).toHaveBeenCalledTimes(1);
    const advanceCall = prisma.subscriptions.updateMany.mock.calls[0][0];
    expect(advanceCall.where.nextUsageInvoiceAt).toEqual({ lte: expect.any(Date) });
    expect(advanceCall.data.nextUsageInvoiceAt).toEqual(new Date('2026-05-31'));
    expect(advanceCall.data.cycleNumber).toBe(4); // 3 + 1
    expect(advanceCall.data.currentUsageDraftInvoiceId).toBeNull();
  });

  it('negative total (credits exceed usage) also advances and issues nothing', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service, { totalAmount: '-15.00' }); // credits > usage → total < 0

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(0);
    expect(result.skippedZeroEvents).toBe(1);
    expect(prisma.invoices.update).not.toHaveBeenCalled();
    expect(prisma.invoices.delete).toHaveBeenCalledWith({ where: { id: 'draft-1' } });
    expect(prisma.subscriptions.updateMany).toHaveBeenCalledTimes(1); // still advanced
    expect(email.sendMerchantInvoiceSentNotification).not.toHaveBeenCalled();
  });

  it('regression: a zero-usage period advances, then real usage the NEXT period issues (sub NOT frozen)', async () => {
    // ── Period N: zero usage. The sub must advance, not freeze. ──
    const prisma1 = freshDispatchPrismaMock();
    prisma1.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email1 = freshDispatchEmailMock();
    const service1 = await buildDispatchService(prisma1, email1, freshCalculator(), freshPayment());
    stubDispatchHelpers(service1, { totalAmount: '0' });

    const run1 = await service1.dispatchUsageInvoices();
    expect(run1.skippedZeroEvents).toBe(1);
    expect(run1.issuedCount).toBe(0);
    expect(prisma1.subscriptions.updateMany).toHaveBeenCalledTimes(1); // advanced past the dead period
    expect(prisma1.invoices.update).not.toHaveBeenCalled(); // nothing issued

    // ── Period N+1: usage returns. The SAME sub (now on cycle 4) bills normally. ──
    const prisma2 = freshDispatchPrismaMock();
    prisma2.subscriptions.findMany.mockResolvedValue([dueSub({ cycleNumber: 4 })]);
    const email2 = freshDispatchEmailMock();
    const service2 = await buildDispatchService(prisma2, email2, freshCalculator(), freshPayment());
    stubDispatchHelpers(service2, { totalAmount: '249.00' });

    const run2 = await service2.dispatchUsageInvoices();
    expect(run2.issuedCount).toBe(1); // proves the empty period did NOT brick future billing
    expect(run2.skippedZeroEvents).toBe(0);
    expect(prisma2.invoices.update).toHaveBeenCalledTimes(1);
    expect(email2.sendInvoiceReadyEmail).toHaveBeenCalledTimes(1);
  });

  it('idempotency: a concurrent run already advanced the sub (CAS count 0) → skip, no duplicate', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    // Simulate the other run winning the race: our CAS matches 0 rows.
    prisma.subscriptions.updateMany.mockResolvedValue({ count: 0 });
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(0);
    expect(result.skippedConcurrent).toBe(1);
    expect(result.errors).toEqual([]);
    // The CAS was attempted, but because it lost, NO emails go out (emails are post-commit).
    expect(email.sendInvoiceReadyEmail).not.toHaveBeenCalled();
    expect(email.sendMerchantInvoiceSentNotification).not.toHaveBeenCalled();
  });

  it('PDF failure does NOT block issue — invoice still issued, both emails still sent', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);
    // Even an unexpected throw from PDF generation must be swallowed by dispatch.
    jest.spyOn(service, 'generatePDFForInvoice').mockRejectedValue(new Error('PDF service down'));

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(1);
    expect(result.merchantEmailsSent).toBe(1);
    expect(result.errors).toEqual([]);
    expect(prisma.subscriptions.updateMany).toHaveBeenCalledTimes(1); // still advanced
  });

  it('email turned off: the invoice is issued but neither email is counted as sent', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    email.sendInvoiceReadyEmail.mockResolvedValue(null);
    email.sendMerchantInvoiceSentNotification.mockResolvedValue(null);
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(0);
    expect(result.merchantEmailsSent).toBe(0);
    expect(result.errors).toEqual([]);
    const merchantCall = email.sendMerchantInvoiceSentNotification.mock.calls[0][0];
    expect(merchantCall.customerDeliveryIssue).toBe('failed');
    expect(warn.mock.calls.map(([line]) => line).join('\n')).toContain(
      '1 invoice(s) were issued but not emailed because email is turned off',
    );
  });

  it('customer email fails: invoice still issued, merchant STILL notified with inline failure note', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    email.sendInvoiceReadyEmail.mockRejectedValue(new Error('Resend 5xx'));
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(0);
    expect(result.merchantEmailsSent).toBe(1);
    const merchCall = email.sendMerchantInvoiceSentNotification.mock.calls[0][0];
    expect(merchCall.customerDeliveryIssue).toBe('failed');
  });

  it('customer has no email: merchant notified with no-email note, customer email skipped', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({ customers: { id: 'cust-1', name: 'Joan Customer', email: null } }),
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(0);
    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendInvoiceReadyEmail).not.toHaveBeenCalled();
    const merchCall = email.sendMerchantInvoiceSentNotification.mock.calls[0][0];
    expect(merchCall.customerDeliveryIssue).toBe('no-email');
  });

  it('merchant email fails: invoice still issued, customer email still sent, NO retry', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([dueSub()]);
    const email = freshDispatchEmailMock();
    email.sendMerchantInvoiceSentNotification.mockRejectedValue(new Error('Resend 5xx'));
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(1);
    expect(result.merchantEmailsSent).toBe(0);
    expect(result.errors).toEqual([]);
    // No retry: exactly one attempt.
    expect(email.sendMerchantInvoiceSentNotification).toHaveBeenCalledTimes(1);
  });

  it('billing_email wins over billingIdentity.email and the owner-member lookup never runs', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: {
          id: 'org-1',
          name: 'Acme Co',
          billing_email: 'bill@acme.test',
          billingIdentity: { email: 'identity@acme.test' },
        },
      }),
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe('bill@acme.test');
    expect(prisma.ba_member.findMany).not.toHaveBeenCalled();
  });

  it('billing_email null: merchant email goes to billingIdentity.email (the dashboard Billing email field) and owners are NOT queried', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: {
          id: 'org-1',
          name: 'Acme Co',
          billing_email: null,
          billingIdentity: { email: 'identity@acme.test' },
        },
      }),
    ]);
    prisma.ba_member.findMany.mockResolvedValue([{ users: { email: 'owner@acme.test' } }]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe(
      'identity@acme.test',
    );
    expect(prisma.ba_member.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['string', 'not-an-object'],
    ['number', 42],
    ['non-string email', { email: 42 }],
    ['blank email', { email: '' }],
    ['not email-shaped', { email: 'not-an-email' }],
  ])(
    'malformed billingIdentity (%s) falls through to owner-role members without throwing',
    async (_label, billingIdentity) => {
      const prisma = freshDispatchPrismaMock();
      prisma.subscriptions.findMany.mockResolvedValue([
        dueSub({
          organizations: { id: 'org-1', name: 'Acme Co', billing_email: null, billingIdentity },
        }),
      ]);
      prisma.ba_member.findMany.mockResolvedValue([{ users: { email: 'owner@acme.test' } }]);
      const email = freshDispatchEmailMock();
      const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
      stubDispatchHelpers(service);

      const result = await service.dispatchUsageInvoices();

      expect(result.errors).toEqual([]);
      expect(result.merchantEmailsSent).toBe(1);
      expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe('owner@acme.test');
    },
  );

  it('customer "invoice ready" contact address comes from billingIdentity.email when billing_email is null', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: {
          id: 'org-1',
          name: 'Acme Co',
          billing_email: null,
          billingIdentity: { email: 'identity@acme.test' },
        },
      }),
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    await service.dispatchUsageInvoices();

    expect(email.sendInvoiceReadyEmail).toHaveBeenCalledTimes(1);
    expect(email.sendInvoiceReadyEmail.mock.calls[0][0].companyEmail).toBe('identity@acme.test');
  });

  it('owner emails NEVER reach the customer-facing email: companyEmail is omitted even while the merchant notification goes to the owner', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: { id: 'org-1', name: 'Acme Co', billing_email: null, billingIdentity: null },
      }),
    ]);
    prisma.ba_member.findMany.mockResolvedValue([{ users: { email: 'owner@acme.test' } }]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe('owner@acme.test');
    expect(email.sendInvoiceReadyEmail).toHaveBeenCalledTimes(1);
    expect(email.sendInvoiceReadyEmail.mock.calls[0][0].companyEmail).toBeUndefined();
  });

  it('falls back to current owner-ROLE members (ba_member) when billing_email is null', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: { id: 'org-1', name: 'Acme Co', billing_email: null },
      }),
    ]);
    prisma.ba_member.findMany.mockResolvedValue([{ users: { email: 'owner@acme.test' } }]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe('owner@acme.test');
    expect(prisma.ba_member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', role: 'owner' } }),
    );
  });

  it('dangling owner_id (removed user) can NEVER receive the notification, only the current owner-role member does', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: {
          id: 'org-1',
          name: 'Acme Co',
          billing_email: null,
          // The create-time owner_id stamp still points at a user who was since
          // REMOVED from the org. This address must be ignored entirely.
          users_organizations_owner_idTousers: { email: 'removed-owner@acme.test' },
        },
      }),
    ]);
    prisma.ba_member.findMany.mockResolvedValue([{ users: { email: 'current-owner@acme.test' } }]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(1);
    expect(email.sendMerchantInvoiceSentNotification).toHaveBeenCalledTimes(1);
    expect(email.sendMerchantInvoiceSentNotification.mock.calls[0][0].to).toBe(
      'current-owner@acme.test',
    );
    const allRecipients = email.sendMerchantInvoiceSentNotification.mock.calls.map(
      (call: any[]) => call[0].to,
    );
    expect(allRecipients).not.toContain('removed-owner@acme.test');
  });

  it('multiple current owners: EVERY owner gets the notification, duplicate emails deduped', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: { id: 'org-1', name: 'Acme Co', billing_email: null },
      }),
    ]);
    prisma.ba_member.findMany.mockResolvedValue([
      { users: { email: 'owner-a@acme.test' } },
      { users: { email: 'owner-b@acme.test' } },
      // Same human, different casing — must NOT produce a third email.
      { users: { email: 'Owner-A@acme.test' } },
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.merchantEmailsSent).toBe(2);
    const recipients = email.sendMerchantInvoiceSentNotification.mock.calls.map(
      (call: any[]) => call[0].to,
    );
    expect(recipients).toEqual(['owner-a@acme.test', 'owner-b@acme.test']);
  });

  it('issues the customer invoice even when merchant has NO recipient at all (billing_email null + no owner-role members)', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: { id: 'org-1', name: 'Acme Co', billing_email: null },
      }),
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(1);
    expect(result.merchantEmailsSent).toBe(0); // nobody to notify, but billing was NOT blocked
    expect(email.sendMerchantInvoiceSentNotification).not.toHaveBeenCalled();
  });

  it('owner-member lookup failing does NOT block billing or the rest of the batch', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({
        organizations: { id: 'org-1', name: 'Acme Co', billing_email: null },
      }),
    ]);
    prisma.ba_member.findMany.mockRejectedValue(new Error('db connection lost'));
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());
    stubDispatchHelpers(service);

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.customerEmailsSent).toBe(1);
    expect(result.merchantEmailsSent).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('one sub erroring mid-batch does not stop the others', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([
      dueSub({ id: 'sub-broken', customerId: 'cust-broken' }),
      dueSub({ id: 'sub-ok', customerId: 'cust-ok' }),
    ]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());

    jest
      .spyOn(service, 'createUsageDraftInvoice')
      .mockRejectedValueOnce(new Error('signal_events read failed'))
      .mockResolvedValue({
        id: 'draft-ok',
        billingPeriodStart: new Date('2026-04-01'),
        billingPeriodEnd: new Date('2026-04-30'),
      });
    jest
      .spyOn(service, 'updateUsageDraftInvoice')
      .mockResolvedValue({ id: 'draft-ok', totalAmount: '249.00' });
    jest.spyOn(service, 'generatePDFForInvoice').mockResolvedValue({ s3Location: 's3://pdf' });
    jest.spyOn(service, 'calculateBillingPeriodAndDates').mockReturnValue({
      billingPeriodStart: new Date('2026-05-01'),
      billingPeriodEnd: new Date('2026-05-31'),
      subscriptionInvoiceIssuanceDate: new Date('2026-05-31'),
    });

    const result = await service.dispatchUsageInvoices();

    expect(result.issuedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].subscriptionId).toBe('sub-broken');
    expect(result.errors[0].error).toContain('signal_events read failed');
  });

  it('returns all-zero counts when no subscriptions are due', async () => {
    const prisma = freshDispatchPrismaMock();
    prisma.subscriptions.findMany.mockResolvedValue([]);
    const email = freshDispatchEmailMock();
    const service = await buildDispatchService(prisma, email, freshCalculator(), freshPayment());

    const result = await service.dispatchUsageInvoices();

    expect(result).toEqual({
      issuedCount: 0,
      customerEmailsSent: 0,
      merchantEmailsSent: 0,
      skippedZeroEvents: 0,
      skippedConcurrent: 0,
      errors: [],
    });
    expect(prisma.invoices.update).not.toHaveBeenCalled();
  });
});
