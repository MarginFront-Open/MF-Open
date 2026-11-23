/**
 * WebhooksService: a verified Stripe event reaches the right handler, and the
 * handlers hand all invoice math to InvoicePaymentReconciler and
 * InvoiceRefundFinalizer.
 *
 * Most tests mock the adapter's extracted event data and the Prisma layer,
 * then recompute the expected invoice state from the in-memory fixture and
 * compare it against what the service wrote. The "platform Stripe webhook"
 * block at the end runs the real factory, the real adapter and real signature
 * verification on hand-built events.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { CryptoService } from '../../common/crypto/crypto.service';
import { WebhooksService } from './webhooks.service';
import { WebhookDedupeService } from './webhook-dedupe.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { PaymentAdapterFactory } from '../payment-providers/payment-adapter.factory';
import { InvoicePaymentReconciler } from '../invoices/invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from '../invoices/invoice-refund-finalizer.service';
import type { CheckoutCompletedData, RefundCompletedData } from '../payment-providers/interfaces';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_ID = '33333333-3333-3333-3333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-4444-444444444444';
const CHECKOUT_SESSION_ID = 'cs_test_abc123';

// ─── Minimal in-memory Prisma mock ─────────────────────────────────────────
// Narrowly focused on the methods the webhook handlers and the downstream
// canonical services actually call. findFirst + findUnique on payments,
// findUnique + update on invoices, findMany on payments for multi-payment
// accounting, refunds findFirst + create + update.

function buildMockPrisma() {
  const invoices = new Map<string, any>();
  const payments = new Map<string, any>();
  const refunds = new Map<string, any>();
  const inboundWebhooks = new Map<string, any>();

  const client = {
    getClient: function () {
      return this;
    },
    $transaction: async (cb: (tx: any) => Promise<any>) => cb(client),
    inbound_webhooks: {
      findFirst: async ({ where }: any) => {
        for (const w of inboundWebhooks.values()) {
          if (where.event_id && w.event_id !== where.event_id) continue;
          if (where.source && w.source !== where.source) continue;
          return w;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const row = { ...data };
        inboundWebhooks.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = inboundWebhooks.get(where.id);
        if (!row) throw new Error('inbound_webhook not found');
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) (row as any)[k] = v;
        }
        inboundWebhooks.set(row.id, row);
        return row;
      },
    },
    invoices: {
      findUnique: async ({ where, include }: any) => {
        const row = invoices.get(where.id);
        if (!row) return null;
        if (include?.customers || include?.organizations) {
          return {
            ...row,
            customers: { id: row.customerId, email: 'test@example.com', name: 'Test Customer' },
            organizations: {
              id: row.organizationId,
              name: 'Test Org',
              billing_email: 'billing@test.example',
            },
          };
        }
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = invoices.get(where.id);
        if (!row) throw new Error('invoice not found');
        Object.assign(row, data);
        invoices.set(where.id, row);
        return row;
      },
      findMany: async () => Array.from(invoices.values()),
    },
    invoice_payments: {
      findFirst: async ({ where }: any) => {
        for (const p of payments.values()) {
          if (
            where.provider_checkout_session_id &&
            p.provider_checkout_session_id === where.provider_checkout_session_id
          ) {
            return p;
          }
          if (
            where.provider_transaction_id &&
            p.provider_transaction_id === where.provider_transaction_id
          ) {
            return p;
          }
        }
        return null;
      },
      findUnique: async ({ where, include }: any) => {
        const p = payments.get(where.id);
        if (!p) return null;
        if (include?.invoices) {
          return { ...p, invoices: invoices.get(p.invoiceId) ?? null };
        }
        return p;
      },
      update: async ({ where, data }: any) => {
        const row = payments.get(where.id);
        if (!row) throw new Error('payment not found');
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) (row as any)[k] = v;
        }
        payments.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: any) => {
        const out: any[] = [];
        for (const p of payments.values()) {
          if (where.invoiceId && p.invoiceId !== where.invoiceId) continue;
          if (where.id?.not && p.id === where.id.not) continue;
          if (where.status?.notIn && where.status.notIn.includes(p.status)) continue;
          out.push(p);
        }
        return out;
      },
      create: async ({ data }: any) => {
        const row = { ...data };
        payments.set(row.id, row);
        return row;
      },
    },
    refunds: {
      findFirst: async ({ where }: any) => {
        for (const r of refunds.values()) {
          if (where.provider_refund_id && r.provider_refund_id === where.provider_refund_id) {
            return r;
          }
        }
        return null;
      },
      create: async ({ data }: any) => {
        const row = { ...data };
        refunds.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = refunds.get(where.id);
        if (!row) throw new Error('refund not found');
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) (row as any)[k] = v;
        }
        refunds.set(row.id, row);
        return row;
      },
    },
    signal_events: {
      findMany: async () => [],
    },
  };

  return { client, invoices, payments, refunds, inboundWebhooks };
}

// Build a default invoice + pending payment for the checkout-completed path.
function seedInvoiceAndPendingPayment(mock: ReturnType<typeof buildMockPrisma>) {
  mock.invoices.set(INVOICE_ID, {
    id: INVOICE_ID,
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    status: 'issued',
    amountPaid: '0',
    amountDue: '100.00',
    totalAmount: '100.00',
    invoiceNumber: 'INV-WBK-1',
    invoiceDate: new Date(Date.UTC(2026, 3, 10)),
    currency: 'USD',
  });
  mock.payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    invoiceId: INVOICE_ID,
    amount: '100.00',
    paymentMethod: 'credit_card',
    status: 'pending',
    paymentDate: new Date(Date.UTC(2026, 3, 10)),
    currency: 'USD',
    refunded_amount: '0',
    refund_status: 'none',
    provider_transaction_id: null,
    provider_checkout_session_id: CHECKOUT_SESSION_ID,
    provider_status: null,
    reference: null,
    notes: null,
    metadata: {},
    card_last4: null,
    card_brand: null,
    provider_fee: null,
    net_amount: null,
    receipt_url: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// Build a default invoice + succeeded payment for the refund-completed path.
function seedInvoiceAndSucceededPayment(mock: ReturnType<typeof buildMockPrisma>) {
  mock.invoices.set(INVOICE_ID, {
    id: INVOICE_ID,
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    status: 'paid',
    amountPaid: '100.00',
    amountDue: '0',
    totalAmount: '100.00',
    invoiceNumber: 'INV-WBK-2',
    invoiceDate: new Date(Date.UTC(2026, 3, 10)),
    currency: 'USD',
  });
  mock.payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    invoiceId: INVOICE_ID,
    amount: '100.00',
    paymentMethod: 'credit_card',
    status: 'succeeded',
    paymentDate: new Date(Date.UTC(2026, 3, 10)),
    currency: 'USD',
    refunded_amount: '0',
    refund_status: 'none',
    provider_transaction_id: 'ch_test_xyz',
    provider_checkout_session_id: CHECKOUT_SESSION_ID,
    provider_status: 'succeeded',
    reference: null,
    notes: null,
    metadata: {},
    card_last4: '4242',
    card_brand: 'visa',
    provider_fee: null,
    net_amount: null,
    receipt_url: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ─── Reflection helper ────────────────────────────────────────────────────
// handleCheckoutCompleted and handleRefundCompleted are private. Invoking
// them directly via bracket-access is the cleanest way to unit-test their
// canonical-path routing without spinning up the full HTTP request cycle.
function invokeHandleCheckoutCompleted(
  service: WebhooksService,
  data: CheckoutCompletedData,
  providerType: string,
  verifiedOrganizationId?: string,
): Promise<void> {
  return (service as any).handleCheckoutCompleted(data, providerType, verifiedOrganizationId);
}
function invokeHandleRefundCompleted(
  service: WebhooksService,
  data: RefundCompletedData,
  providerType: string,
  verifiedOrganizationId?: string,
): Promise<void> {
  return (service as any).handleRefundCompleted(data, providerType, verifiedOrganizationId);
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe('WebhooksService canonical routing parity', () => {
  let service: WebhooksService;
  let reconcilerSpy: jest.SpyInstance;
  let finalizerSpy: jest.SpyInstance;
  let reconciler: InvoicePaymentReconciler;
  let finalizer: InvoiceRefundFinalizer;

  async function build(mockPrisma: any) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        InvoicePaymentReconciler,
        InvoiceRefundFinalizer,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: ConfigService,
          useValue: { get: () => 'http://localhost' },
        },
        {
          provide: EmailService,
          useValue: {
            sendPaymentReceiptEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PaymentAdapterFactory,
          useValue: {},
        },
        {
          // The parity tests invoke the private handlers
          // directly (handleCheckoutCompleted / handleRefundCompleted) which
          // never call the dedupe service. A no-op stub is enough to satisfy DI.
          provide: WebhookDedupeService,
          useValue: { claim: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: 'RevenueMetricsService',
          useValue: { getInvoiceTotals: jest.fn().mockResolvedValue({ billed: 0, collected: 0 }) },
        },
        {
          // The Reconciler / Finalizer depend on RevenueMetricsService. Provide
          // a stub so they don't try to reach beyond the mock.
          provide: (await import('../analytics/revenue-metrics.service')).RevenueMetricsService,
          useValue: {
            getInvoiceTotals: jest.fn().mockResolvedValue({ billed: 0, collected: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
    reconciler = module.get<InvoicePaymentReconciler>(InvoicePaymentReconciler);
    finalizer = module.get<InvoiceRefundFinalizer>(InvoiceRefundFinalizer);
    reconcilerSpy = jest.spyOn(reconciler, 'recordPayment');
    finalizerSpy = jest.spyOn(finalizer, 'finalizeRefund');
    return service;
  }

  describe('handleCheckoutCompleted routes through InvoicePaymentReconciler', () => {
    it('Stripe checkout.completed → Reconciler invoked with correct args', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);

      const data: CheckoutCompletedData = {
        providerTransactionId: 'pi_test_stripe_1',
        checkoutSessionId: CHECKOUT_SESSION_ID,
        invoiceId: INVOICE_ID,
        paymentStatus: 'succeeded',
        cardLast4: '4242',
        cardBrand: 'visa',
        receiptUrl: 'https://pay.stripe.com/receipt/abc',
        fee: 2.9,
        netAmount: 97.1,
      };
      await invokeHandleCheckoutCompleted(service, data, 'stripe');

      // Reconciler was called exactly once with our payment args.
      expect(reconcilerSpy).toHaveBeenCalledTimes(1);
      const [callArg] = reconcilerSpy.mock.calls[0];
      expect(callArg.invoiceId).toBe(INVOICE_ID);
      expect(callArg.paymentAmount).toBeCloseTo(100, 6);
      expect(callArg.paymentRecord.existingPaymentId).toBe(PAYMENT_ID);
      expect(callArg.paymentRecord.provider_transaction_id).toBe('pi_test_stripe_1');
      expect(callArg.paymentRecord.status).toBe('succeeded');

      // Independent recompute: invoice started with amountPaid=0, payment
      // is $100, totalAmount=$100 → status must flip to 'paid'.
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(100, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(0, 6);
    });

    it('email turned off → the payment is recorded but the receipt is not marked as sent', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);
      ((service as any).emailService.sendPaymentReceiptEmail as jest.Mock).mockResolvedValue(null);

      await invokeHandleCheckoutCompleted(
        service,
        {
          providerTransactionId: 'pi_email_off',
          checkoutSessionId: CHECKOUT_SESSION_ID,
          invoiceId: INVOICE_ID,
          paymentStatus: 'succeeded',
          cardLast4: null,
          cardBrand: null,
          receiptUrl: null,
          fee: null,
          netAmount: null,
        },
        'stripe',
      );

      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('paid');
      expect(mock.payments.get(PAYMENT_ID)!.receipt_email_sent).toBeUndefined();
    });

    it('a sent receipt is marked as sent', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);

      await invokeHandleCheckoutCompleted(
        service,
        {
          providerTransactionId: 'pi_email_on',
          checkoutSessionId: CHECKOUT_SESSION_ID,
          invoiceId: INVOICE_ID,
          paymentStatus: 'succeeded',
          cardLast4: null,
          cardBrand: null,
          receiptUrl: null,
          fee: null,
          netAmount: null,
        },
        'stripe',
      );

      expect(mock.payments.get(PAYMENT_ID)!.receipt_email_sent).toBe(true);
    });

    it('no invoice ID → handler returns without invoking Reconciler', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);

      const data: CheckoutCompletedData = {
        providerTransactionId: 'pi_no_invoice',
        checkoutSessionId: CHECKOUT_SESSION_ID,
        invoiceId: '',
        paymentStatus: 'succeeded',
        cardLast4: null,
        cardBrand: null,
        receiptUrl: null,
        fee: null,
        netAmount: null,
      };
      await invokeHandleCheckoutCompleted(service, data, 'stripe');
      expect(reconcilerSpy).not.toHaveBeenCalled();
    });

    it('no matching pending payment → handler returns without invoking Reconciler', async () => {
      const mock = buildMockPrisma();
      mock.invoices.set(INVOICE_ID, {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '100.00',
        totalAmount: '100.00',
        invoiceNumber: 'INV-NO-PAYMENT',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
        currency: 'USD',
      });
      // NOT seeding any payment row.
      await build(mock.client);

      const data: CheckoutCompletedData = {
        providerTransactionId: 'pi_no_payment',
        checkoutSessionId: 'cs_unknown',
        invoiceId: INVOICE_ID,
        paymentStatus: 'succeeded',
        cardLast4: null,
        cardBrand: null,
        receiptUrl: null,
        fee: null,
        netAmount: null,
      };
      await invokeHandleCheckoutCompleted(service, data, 'stripe');
      expect(reconcilerSpy).not.toHaveBeenCalled();
    });
  });

  describe("a webhook verified for one organization cannot touch another organization's invoice", () => {
    const OTHER_ORG_ID = '99999999-9999-9999-9999-999999999999';
    const checkout: CheckoutCompletedData = {
      providerTransactionId: 'pi_forged',
      checkoutSessionId: CHECKOUT_SESSION_ID,
      invoiceId: INVOICE_ID,
      paymentStatus: 'succeeded',
      cardLast4: null,
      cardBrand: null,
      receiptUrl: null,
      fee: null,
      netAmount: null,
    };
    const refund: RefundCompletedData = {
      providerRefundId: 're_forged',
      providerTransactionId: 'ch_test_xyz',
      amount: 100,
      currency: 'usd',
      status: 'succeeded',
      reason: null,
    } as RefundCompletedData;

    it("checkout.completed verified for org B naming org A's invoice changes nothing", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);

      await invokeHandleCheckoutCompleted(service, checkout, 'stripe', OTHER_ORG_ID);

      expect(reconcilerSpy).not.toHaveBeenCalled();
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('issued');
      expect(mock.invoices.get(INVOICE_ID)!.amountPaid).toBe('0');
      expect(mock.payments.get(PAYMENT_ID)!.status).toBe('pending');
    });

    it("checkout.completed verified for the invoice's own organization still pays it", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      await build(mock.client);

      await invokeHandleCheckoutCompleted(service, checkout, 'stripe', ORG_ID);

      expect(reconcilerSpy).toHaveBeenCalledTimes(1);
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('paid');
    });

    it("a real session of org B cannot be pointed at org A's invoice", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      const otherInvoiceId = '88888888-8888-8888-8888-888888888888';
      mock.invoices.set(otherInvoiceId, {
        ...mock.invoices.get(INVOICE_ID),
        id: otherInvoiceId,
        organizationId: OTHER_ORG_ID,
      });
      mock.payments.get(PAYMENT_ID)!.invoiceId = otherInvoiceId;
      await build(mock.client);

      await invokeHandleCheckoutCompleted(service, checkout, 'stripe', OTHER_ORG_ID);

      expect(reconcilerSpy).not.toHaveBeenCalled();
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('issued');
    });

    it("a refund verified for org B naming org A's payment changes nothing", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      await invokeHandleRefundCompleted(service, refund, 'stripe', OTHER_ORG_ID);

      expect(finalizerSpy).not.toHaveBeenCalled();
      expect(mock.refunds.size).toBe(0);
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('paid');
      expect(mock.payments.get(PAYMENT_ID)!.refunded_amount).toBe('0');
    });

    it("a pending refund verified for org B records no refund row on org A's payment", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      await invokeHandleRefundCompleted(
        service,
        { ...refund, status: 'pending' },
        'stripe',
        OTHER_ORG_ID,
      );

      expect(mock.refunds.size).toBe(0);
    });

    it("payment.failed verified for org B leaves org A's payment alone", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      await (service as any).handlePaymentFailed(
        { providerTransactionId: 'ch_test_xyz', providerStatus: 'failed' },
        'stripe',
        OTHER_ORG_ID,
      );

      expect(mock.payments.get(PAYMENT_ID)!.status).toBe('succeeded');
    });

    it("handleStripeWebhook passes the verifying provider's organization to the handler", async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndPendingPayment(mock);
      (mock.client as any).payment_providers = {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'provider-b', type: 'stripe', organization_id: OTHER_ORG_ID }),
      };
      await build(mock.client);
      (service as any).adapterFactory = {
        createAdapter: () => ({
          verifyWebhook: async () => ({
            eventId: 'evt_forged',
            rawEventType: 'checkout.session.completed',
            eventType: 'checkout.completed',
            payload: {},
          }),
          extractCheckoutCompleted: async () => checkout,
        }),
      };

      await service.handleStripeWebhook(Buffer.from('{}'), 'sig_forged', OTHER_ORG_ID);

      expect(reconcilerSpy).not.toHaveBeenCalled();
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('issued');
    });
  });

  describe('handleRefundCompleted routes through InvoiceRefundFinalizer', () => {
    it('Stripe charge.refunded (full refund) → Finalizer invoked, invoice flips to refunded', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      // Pre-seed the pending refunds row created when the user hit "Refund"
      // in the dashboard. Webhook should update-in-place, not create a new one.
      const refundId = '55555555-5555-5555-5555-555555555555';
      mock.refunds.set(refundId, {
        id: refundId,
        invoice_payment_id: PAYMENT_ID,
        amount: '100.00',
        currency: 'USD',
        reason: 'pending from dashboard',
        status: 'pending',
        provider_refund_id: 're_test_stripe_1',
        refunded_by: null,
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_test_stripe_1',
        providerTransactionId: 'ch_test_xyz',
        amount: 100,
        currency: 'usd',
        status: 'succeeded',
        reason: 'requested_by_customer',
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).toHaveBeenCalledTimes(1);
      const [callArg] = finalizerSpy.mock.calls[0];
      expect(callArg.paymentId).toBe(PAYMENT_ID);
      expect(callArg.refundAmount).toBeCloseTo(100, 6);
      expect(callArg.refundRecord.existingRefundId).toBe(refundId);

      // Independent recompute: $100 payment, $100 refund, no other payments
      // → invoice flips to 'refunded'.
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('refunded');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(0, 6);

      // Existing refund row got flipped to 'succeeded'. No new row was created.
      expect(mock.refunds.size).toBe(1);
      expect(mock.refunds.get(refundId)!.status).toBe('succeeded');
    });

    it('partial refund webhook → Finalizer invoked, status stays paid', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_partial',
        providerTransactionId: 'ch_test_xyz',
        amount: 25,
        currency: 'usd',
        status: 'succeeded',
        reason: 'partial refund',
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).toHaveBeenCalledTimes(1);

      // Independent recompute: $100 payment, $25 partial refund → status
      // stays 'paid' (a partial refund does NOT change invoice status).
      // amountPaid: 100 - 25 = 75, amountDue: 100 - 75 = 25.
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(75, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(25, 6);

      const finalPayment = mock.payments.get(PAYMENT_ID)!;
      expect(Number(finalPayment.refunded_amount)).toBeCloseTo(25, 6);
      expect(finalPayment.refund_status).toBe('partial');
    });

    it('refund webhook for unknown payment → handler logs and returns (no Finalizer call)', async () => {
      const mock = buildMockPrisma();
      // No payment seeded for this transaction id.
      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_orphan',
        providerTransactionId: 'ch_never_existed',
        amount: 50,
        currency: 'usd',
        status: 'succeeded',
        reason: null,
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).not.toHaveBeenCalled();
    });
  });

  /**
   * Status-aware dispatch.
   *
   * The handler branches on `data.status` so a Stripe refund.created with
   * status=pending doesn't accidentally call the Finalizer (which would
   * subtract money from invoice_payments.refunded_amount before the customer
   * has actually gotten their money back). Three cases:
   *
   *   pending → record the row only, do NOT propagate
   *   failed / canceled → mark row failed, do NOT propagate
   *   succeeded → existing happy path through Finalizer (covered by tests above)
   */
  describe('handleRefundCompleted status-aware dispatch', () => {
    it('status=pending creates a refunds row but does NOT invoke Finalizer', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_pending_ach',
        providerTransactionId: 'ch_test_xyz',
        amount: 25,
        currency: 'usd',
        status: 'pending',
        reason: 'requested_by_customer',
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      // Finalizer must NOT have been called — pending refunds don't move money.
      expect(finalizerSpy).not.toHaveBeenCalled();

      // A refunds row was recorded so refund.updated can find it later.
      expect(mock.refunds.size).toBe(1);
      const recorded = Array.from(mock.refunds.values())[0];
      expect(recorded.provider_refund_id).toBe('re_pending_ach');
      expect(recorded.status).toBe('pending');
      expect(recorded.invoice_payment_id).toBe(PAYMENT_ID);

      // Invoice state must be untouched — pending refund means the customer
      // has not gotten their money back yet, so collected revenue stays put.
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(100, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(0, 6);
    });

    it('status=pending is idempotent — duplicate event does not double-create the row', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);

      // Pre-seed the pending row as if the first refund.created already landed.
      const existingRefundId = 'aaaa1111-1111-1111-1111-111111111111';
      mock.refunds.set(existingRefundId, {
        id: existingRefundId,
        invoice_payment_id: PAYMENT_ID,
        amount: '25.00',
        currency: 'USD',
        reason: 'first event',
        status: 'pending',
        provider_refund_id: 're_pending_ach',
        refunded_by: null,
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_pending_ach',
        providerTransactionId: 'ch_test_xyz',
        amount: 25,
        currency: 'usd',
        status: 'pending',
        reason: 'requested_by_customer',
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).not.toHaveBeenCalled();
      // Same one row, not two.
      expect(mock.refunds.size).toBe(1);
    });

    it('status=failed marks the refunds row failed and does NOT touch invoice_payments', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);

      // Pre-seed a pending row from a prior refund.created. refund.updated
      // arrives with status=failed (issuer declined).
      const refundId = 'bbbb2222-2222-2222-2222-222222222222';
      mock.refunds.set(refundId, {
        id: refundId,
        invoice_payment_id: PAYMENT_ID,
        amount: '50.00',
        currency: 'USD',
        reason: 'requested_by_customer',
        status: 'pending',
        provider_refund_id: 're_declined',
        refunded_by: null,
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_declined',
        providerTransactionId: 'ch_test_xyz',
        amount: 50,
        currency: 'usd',
        status: 'failed',
        reason: 'issuer_declined',
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).not.toHaveBeenCalled();

      // Refunds row got flipped to failed.
      const failedRow = mock.refunds.get(refundId)!;
      expect(failedRow.status).toBe('failed');
      expect(failedRow.processed_at).toBeInstanceOf(Date);

      // Invoice + payment untouched — a failed refund never returned money,
      // so collected revenue must NOT get reduced.
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(100, 6);
      const finalPayment = mock.payments.get(PAYMENT_ID)!;
      expect(Number(finalPayment.refunded_amount)).toBeCloseTo(0, 6);
    });

    it('status=canceled marks row failed (same propagation rule as failed)', async () => {
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);

      const refundId = 'cccc3333-3333-3333-3333-333333333333';
      mock.refunds.set(refundId, {
        id: refundId,
        invoice_payment_id: PAYMENT_ID,
        amount: '30.00',
        currency: 'USD',
        reason: 'requested_by_customer',
        status: 'pending',
        provider_refund_id: 're_canceled',
        refunded_by: null,
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await build(mock.client);

      const data: RefundCompletedData = {
        providerRefundId: 're_canceled',
        providerTransactionId: 'ch_test_xyz',
        amount: 30,
        currency: 'usd',
        status: 'canceled',
        reason: null,
      };
      await invokeHandleRefundCompleted(service, data, 'stripe');

      expect(finalizerSpy).not.toHaveBeenCalled();
      expect(mock.refunds.get(refundId)!.status).toBe('failed');
      expect(Number(mock.payments.get(PAYMENT_ID)!.refunded_amount)).toBeCloseTo(0, 6);
    });

    it('two-event Stripe lifecycle: pending row created, then succeeded finalizes via existing row', async () => {
      // Real ACH refund flow: refund.created with status=pending lands first,
      // then refund.updated with status=succeeded lands minutes/hours later.
      // The succeeded event should finalize against the existing pending row
      // (existingRefundId set on the Finalizer call), not create a duplicate.
      const mock = buildMockPrisma();
      seedInvoiceAndSucceededPayment(mock);
      await build(mock.client);

      // Event 1: refund.created, status=pending
      await invokeHandleRefundCompleted(
        service,
        {
          providerRefundId: 're_ach_flow',
          providerTransactionId: 'ch_test_xyz',
          amount: 40,
          currency: 'usd',
          status: 'pending',
          reason: 'requested_by_customer',
        },
        'stripe',
      );

      expect(finalizerSpy).not.toHaveBeenCalled();
      expect(mock.refunds.size).toBe(1);
      const pendingRowId = Array.from(mock.refunds.values())[0].id;

      // Event 2: refund.updated, status=succeeded
      await invokeHandleRefundCompleted(
        service,
        {
          providerRefundId: 're_ach_flow',
          providerTransactionId: 'ch_test_xyz',
          amount: 40,
          currency: 'usd',
          status: 'succeeded',
          reason: 'requested_by_customer',
        },
        'stripe',
      );

      expect(finalizerSpy).toHaveBeenCalledTimes(1);
      const [callArg] = finalizerSpy.mock.calls[0];
      // Critical: the Finalizer call reuses the pending row's id, not a fresh one.
      expect(callArg.refundRecord.existingRefundId).toBe(pendingRowId);

      // Net effect: invoice partial-refunded by $40. Status stays paid (partial).
      const finalInvoice = mock.invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(60, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(40, 6);
    });
  });

  /**
   * Status-aware dedupe.
   *
   * Treating ANY existing row with the same event_id as a duplicate would let
   * a row left in status='failed' (from an attempt that threw mid-handler)
   * block the provider's automatic retry, so a refund would never land.
   *
   * Only status='succeeded' = true duplicate. failed / pending /
   * processing rows get reset and reprocessed. The state machine already
   * overwrites them on success.
   */
  describe('createWebhookRecord status-aware dedupe', () => {
    const callCreateWebhookRecord = (
      svc: WebhooksService,
      eventId: string,
      source: string,
      eventType: string,
      payload: object,
      organizationId?: string,
    ): Promise<{ webhook: any; isDuplicate: boolean }> => {
      const body = Buffer.from(JSON.stringify(payload));
      return (svc as any).createWebhookRecord(
        eventId,
        source,
        eventType,
        body,
        'sig_test',
        organizationId,
      );
    };

    it('no existing row creates new pending row, isDuplicate=false', async () => {
      const mock = buildMockPrisma();
      await build(mock.client);

      const result = await callCreateWebhookRecord(
        service,
        'evt_brand_new',
        'stripe',
        'refund.created',
        { hello: 'world' },
      );

      expect(result.isDuplicate).toBe(false);
      expect(mock.inboundWebhooks.size).toBe(1);
      expect(result.webhook.status).toBe('pending');
    });

    it('existing succeeded row returns isDuplicate=true, does NOT reset', async () => {
      const mock = buildMockPrisma();
      const existingId = 'aabb1111-1111-1111-1111-111111111111';
      mock.inboundWebhooks.set(existingId, {
        id: existingId,
        organization_id: null,
        source: 'stripe',
        event_type: 'refund.updated',
        event_id: 'evt_already_done',
        payload: {},
        signature: 'sig_test',
        status: 'succeeded',
        created_at: new Date(),
        updated_at: new Date(),
        processed_at: new Date(),
      });
      await build(mock.client);

      const result = await callCreateWebhookRecord(
        service,
        'evt_already_done',
        'stripe',
        'refund.updated',
        { hello: 'world' },
      );

      expect(result.isDuplicate).toBe(true);
      // Row stays succeeded; no reset, no new row.
      expect(mock.inboundWebhooks.size).toBe(1);
      expect(mock.inboundWebhooks.get(existingId)!.status).toBe('succeeded');
    });

    it('existing failed row resets to pending and returns isDuplicate=false', async () => {
      // Stripe attempt 1 returned 400 → row marked failed. Stripe attempt 2 for the
      // same event id MUST be allowed to reprocess, not short-circuit as
      // duplicate, or a refund that failed once could never land.
      const mock = buildMockPrisma();
      const existingId = 'aabb2222-2222-2222-2222-222222222222';
      mock.inboundWebhooks.set(existingId, {
        id: existingId,
        organization_id: null,
        source: 'stripe',
        event_type: 'refund.created',
        event_id: 'evt_failed_first_attempt',
        payload: {},
        signature: 'sig_test',
        status: 'failed',
        error_message: 'Refund amount must be > 0 (got 0)',
        created_at: new Date(),
        updated_at: new Date(),
      });
      await build(mock.client);

      const result = await callCreateWebhookRecord(
        service,
        'evt_failed_first_attempt',
        'stripe',
        'refund.created',
        { hello: 'world' },
      );

      expect(result.isDuplicate).toBe(false);
      // Same row, reset to pending, error_message cleared so a fresh
      // attempt's failure (if any) overwrites cleanly.
      expect(mock.inboundWebhooks.size).toBe(1);
      expect(mock.inboundWebhooks.get(existingId)!.status).toBe('pending');
      expect(mock.inboundWebhooks.get(existingId)!.error_message).toBeNull();
    });

    it('existing pending row (prior attempt crashed pre-handler) also resets to pending and reprocesses', async () => {
      // If the row was left in 'pending' or 'processing' (process died
      // mid-handler before either the success or failure branch wrote), the
      // retry must be allowed to drive it forward.
      const mock = buildMockPrisma();
      const existingId = 'aabb3333-3333-3333-3333-333333333333';
      mock.inboundWebhooks.set(existingId, {
        id: existingId,
        organization_id: null,
        source: 'stripe',
        event_type: 'refund.updated',
        event_id: 'evt_stuck_pending',
        payload: {},
        signature: 'sig_test',
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      });
      await build(mock.client);

      const result = await callCreateWebhookRecord(
        service,
        'evt_stuck_pending',
        'stripe',
        'refund.updated',
        { hello: 'world' },
      );

      expect(result.isDuplicate).toBe(false);
      expect(mock.inboundWebhooks.get(existingId)!.status).toBe('pending');
    });
  });

  /**
   * In-flight dedupe call-site contract.
   *
   * When WebhookDedupeService.claim returns false (another worker already
   * claimed this event id within the Redis TTL window), handleStripeWebhook MUST
   * short-circuit BEFORE touching `inbound_webhooks`. If it doesn't, we'd
   * still race the DB-layer dedupe, which is the window this Redis layer
   * closes.
   */
  describe('in-flight dedupe call-site', () => {
    async function buildWithDedupe(claimReturns: boolean) {
      const mock = buildMockPrisma();
      // findStripeProvider returns null when no org id is passed, so the main
      // handler falls through to handleStripeWebhookFallback. The fallback
      // is the cleanest path to exercise here because it has fewer deps.
      const fakeEvent = {
        eventId: 'evt_inflight_test',
        rawEventType: 'checkout.session.completed',
        eventType: 'ignored',
        payload: {},
      };
      const fakeAdapter = {
        verifyWebhook: jest.fn().mockResolvedValue(fakeEvent),
      };
      const adapterFactory = {
        createAdapter: jest.fn().mockReturnValue(fakeAdapter),
        createPlatformStripeAdapter: jest.fn().mockReturnValue(fakeAdapter),
      };
      const dedupeStub = { claim: jest.fn().mockResolvedValue(claimReturns) };

      const module = await Test.createTestingModule({
        providers: [
          WebhooksService,
          InvoicePaymentReconciler,
          InvoiceRefundFinalizer,
          { provide: PrismaService, useValue: mock.client },
          {
            provide: ConfigService,
            useValue: {
              get: (k: string) => (k === 'STRIPE_SECRET_KEY' ? 'sk_test' : 'http://localhost'),
            },
          },
          { provide: EmailService, useValue: { sendPaymentReceiptEmail: jest.fn() } },
          { provide: PaymentAdapterFactory, useValue: adapterFactory },
          { provide: WebhookDedupeService, useValue: dedupeStub },
          {
            provide: (await import('../analytics/revenue-metrics.service')).RevenueMetricsService,
            useValue: {
              getInvoiceTotals: jest.fn().mockResolvedValue({ billed: 0, collected: 0 }),
            },
          },
        ],
      }).compile();
      const svc = module.get<WebhooksService>(WebhooksService);
      return { svc, mock, dedupeStub };
    }

    it('claim()=false → short-circuits to { received: true, duplicate: true } and does NOT touch inbound_webhooks', async () => {
      const { svc, mock, dedupeStub } = await buildWithDedupe(false);

      const result = await svc.handleStripeWebhook(Buffer.from('{}'), 'sig_test');

      expect(result).toEqual({ received: true, duplicate: true });
      expect(dedupeStub.claim).toHaveBeenCalledWith('stripe', 'evt_inflight_test');
      // The DB layer must NOT have been touched. If a row landed here, the
      // dedupe call was AFTER createWebhookRecord and we lost the race.
      expect(mock.inboundWebhooks.size).toBe(0);
    });

    it('claim()=true → proceeds into createWebhookRecord (normal path)', async () => {
      const { svc, mock, dedupeStub } = await buildWithDedupe(true);

      const result = await svc.handleStripeWebhook(Buffer.from('{}'), 'sig_test');

      expect(result).toEqual({ received: true }); // not a duplicate
      expect(dedupeStub.claim).toHaveBeenCalledWith('stripe', 'evt_inflight_test');
      // The DB layer DID run: an ignored event writes no invoice data, but a
      // webhook row is created.
      expect(mock.inboundWebhooks.size).toBe(1);
    });
  });

  describe('platform Stripe webhook with no organization', () => {
    const webhookSecret = 'whsec_platform_test';
    const signer = new Stripe('sk_test_platform');

    function signedWith(secret: string, payload: string): string {
      return signer.webhooks.generateTestHeaderString({ payload, secret });
    }

    function checkoutSessionEvent(id: string, type: string, paymentStatus: string): string {
      return JSON.stringify({
        id,
        object: 'event',
        type,
        data: {
          object: {
            id: CHECKOUT_SESSION_ID,
            object: 'checkout.session',
            client_reference_id: INVOICE_ID,
            payment_intent: 'pi_test_platform',
            payment_status: paymentStatus,
          },
        },
      });
    }

    // Real factory, real adapter, real signature check. The one stub is the
    // adapter's outbound call to Stripe for card details, so nothing leaves
    // the machine.
    async function buildWithRealFactory() {
      const mock = buildMockPrisma();
      const config: Record<string, string> = {
        STRIPE_SECRET_KEY: 'sk_test_platform',
        STRIPE_WEBHOOK_SECRET: webhookSecret,
      };
      const module = await Test.createTestingModule({
        providers: [
          WebhooksService,
          PaymentAdapterFactory,
          InvoicePaymentReconciler,
          InvoiceRefundFinalizer,
          { provide: PrismaService, useValue: mock.client },
          { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
          { provide: CryptoService, useValue: {} },
          { provide: EmailService, useValue: { sendPaymentReceiptEmail: jest.fn() } },
          { provide: WebhookDedupeService, useValue: { claim: jest.fn().mockResolvedValue(true) } },
          {
            provide: (await import('../analytics/revenue-metrics.service')).RevenueMetricsService,
            useValue: {
              getInvoiceTotals: jest.fn().mockResolvedValue({ billed: 0, collected: 0 }),
            },
          },
        ],
      }).compile();

      const factory = module.get<PaymentAdapterFactory>(PaymentAdapterFactory);
      const buildRealAdapter = factory.createPlatformStripeAdapter.bind(factory);
      jest.spyOn(factory, 'createPlatformStripeAdapter').mockImplementation((secrets) => {
        const adapter = buildRealAdapter(secrets);
        (adapter as any).stripe.checkout.sessions.retrieve = jest
          .fn()
          .mockRejectedValue(new Error('no outbound Stripe calls in tests'));
        return adapter;
      });

      return { svc: module.get<WebhooksService>(WebhooksService), mock };
    }

    it('a signed checkout.session.completed marks the invoice paid', async () => {
      const { svc, mock } = await buildWithRealFactory();
      seedInvoiceAndPendingPayment(mock);
      const payload = checkoutSessionEvent('evt_paid', 'checkout.session.completed', 'paid');

      const result = await svc.handleStripeWebhook(
        Buffer.from(payload),
        signedWith(webhookSecret, payload),
      );

      expect(result).toEqual({ received: true });
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('paid');
      expect(mock.payments.get(PAYMENT_ID)!.status).toBe('succeeded');
      expect(mock.payments.get(PAYMENT_ID)!.provider_transaction_id).toBe('pi_test_platform');
    });

    it('a signed event of another type is acknowledged and leaves the invoice unpaid', async () => {
      const { svc, mock } = await buildWithRealFactory();
      seedInvoiceAndPendingPayment(mock);
      const payload = checkoutSessionEvent('evt_expired', 'checkout.session.expired', 'unpaid');

      const result = await svc.handleStripeWebhook(
        Buffer.from(payload),
        signedWith(webhookSecret, payload),
      );

      expect(result).toEqual({ received: true });
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('issued');
      expect(mock.payments.get(PAYMENT_ID)!.status).toBe('pending');
      const [recorded] = [...mock.inboundWebhooks.values()];
      expect(recorded.event_type).toBe('checkout.session.expired');
      expect(recorded.status).toBe('succeeded');
    });

    it('a checkout.session.completed with a forged signature is refused', async () => {
      const { svc, mock } = await buildWithRealFactory();
      seedInvoiceAndPendingPayment(mock);
      const payload = checkoutSessionEvent('evt_forged', 'checkout.session.completed', 'paid');

      await expect(
        svc.handleStripeWebhook(Buffer.from(payload), signedWith('whsec_someone_else', payload)),
      ).rejects.toThrow('Webhook verification failed');

      expect(mock.inboundWebhooks.size).toBe(0);
      expect(mock.invoices.get(INVOICE_ID)!.status).toBe('issued');
      expect(mock.payments.get(PAYMENT_ID)!.status).toBe('pending');
    });
  });
});
