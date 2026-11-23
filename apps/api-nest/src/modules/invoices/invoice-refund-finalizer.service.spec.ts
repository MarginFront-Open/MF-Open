/**
 * Parity tests for InvoiceRefundFinalizer.
 *
 * These tests prove that finalizeRefund correctly:
 *   1. Full refund on the only payment → invoice.status flips to 'refunded'.
 *   2. Partial refund → invoice.status stays, amountPaid + amountDue update.
 *   3. Double-refund (already fully refunded) is rejected.
 *   4. Overage refund (refund > remaining payment balance) is rejected.
 *   5. Whole-invoice refund rule only fires when the ONLY active payment is
 *      fully refunded. Other active payments keep the invoice in 'paid' or
 *      'issued' status.
 *   6. After a refund, an independent raw-row recompute of the canonical
 *      invoice-level I2 buckets (issued/overdue/paid/refunded) agrees with
 *      the finalizer's write.
 *
 * Like the Reconciler spec, this uses an in-memory Prisma mock. The
 * "independent recompute" guarantee comes from having a raw data store we
 * can re-aggregate off to assert parity, not from calling the canonical
 * function and comparing it to itself (that would be a tautology).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceRefundFinalizer } from './invoice-refund-finalizer.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_ID = '33333333-3333-3333-3333-333333333333';
const PAYMENT_ID_A = '44444444-4444-4444-4444-444444444444';
const PAYMENT_ID_B = '55555555-5555-5555-5555-555555555555';

// ─── In-memory mock Prisma ─────────────────────────────────────────────────

interface InvoiceRow {
  id: string;
  organizationId: string;
  customerId: string;
  status: string;
  amountPaid: string | number;
  amountDue: string | number;
  totalAmount: string | number;
  invoiceNumber: string;
  invoiceDate: Date;
}

interface PaymentRow {
  id: string;
  invoiceId: string;
  amount: string | number;
  paymentMethod: string;
  status: string;
  paymentDate: Date;
  currency: string;
  refunded_amount: string | number;
  refund_status: string;
  provider_transaction_id: string | null;
  provider_refund_id: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RefundRow {
  id: string;
  invoice_payment_id: string;
  amount: string | number;
  currency: string;
  reason: string | null;
  status: string;
  provider_refund_id: string | null;
  refunded_by: string | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function buildMockPrisma(seedInvoice: InvoiceRow, seedPayments: PaymentRow[]) {
  const invoices = new Map<string, InvoiceRow>();
  invoices.set(seedInvoice.id, { ...seedInvoice });
  const payments = new Map<string, PaymentRow>();
  for (const p of seedPayments) payments.set(p.id, { ...p });
  const refunds = new Map<string, RefundRow>();

  const client = {
    getClient: function () {
      return this;
    },
    $transaction: async (cb: (tx: any) => Promise<any>) => cb(client),
    invoices: {
      findUnique: async ({ where }: any) => invoices.get(where.id) ?? null,
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
      findMany: async ({ where, select: _select }: any) => {
        const out: PaymentRow[] = [];
        for (const row of payments.values()) {
          if (where.invoiceId && row.invoiceId !== where.invoiceId) continue;
          if (where.id?.not && row.id === where.id.not) continue;
          if (where.status?.notIn && where.status.notIn.includes(row.status)) continue;
          out.push(row);
        }
        return out;
      },
    },
    refunds: {
      create: async ({ data }: any) => {
        const row: RefundRow = {
          id: data.id,
          invoice_payment_id: data.invoice_payment_id,
          amount: data.amount,
          currency: data.currency ?? 'USD',
          reason: data.reason ?? null,
          status: data.status ?? 'succeeded',
          provider_refund_id: data.provider_refund_id ?? null,
          refunded_by: data.refunded_by ?? null,
          processed_at: data.processed_at ?? null,
          created_at: data.created_at ?? new Date(),
          updated_at: data.updated_at ?? new Date(),
        };
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
      findMany: async () => Array.from(refunds.values()),
    },
    signal_events: {
      findMany: async () => [],
    },
  };

  return { client, invoices, payments, refunds };
}

function mkPayment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID_A,
    invoiceId: INVOICE_ID,
    amount: '100.00',
    paymentMethod: 'credit_card',
    status: 'succeeded',
    paymentDate: new Date(Date.UTC(2026, 3, 10)),
    currency: 'USD',
    refunded_amount: '0',
    refund_status: 'none',
    provider_transaction_id: null,
    provider_refund_id: null,
    createdAt: new Date(Date.UTC(2026, 3, 10)),
    updatedAt: new Date(Date.UTC(2026, 3, 10)),
    ...overrides,
  };
}

function mkInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: INVOICE_ID,
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    status: 'paid',
    amountPaid: '100.00',
    amountDue: '0',
    totalAmount: '100.00',
    invoiceNumber: 'INV-R1',
    invoiceDate: new Date(Date.UTC(2026, 3, 10)),
    ...overrides,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe('InvoiceRefundFinalizer canonical parity', () => {
  let finalizer: InvoiceRefundFinalizer;

  async function build(mockPrisma: any) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceRefundFinalizer,
        RevenueMetricsService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();
    finalizer = module.get<InvoiceRefundFinalizer>(InvoiceRefundFinalizer);
    return finalizer;
  }

  describe('full refund', () => {
    it('full refund of the only payment flips invoice to refunded', async () => {
      const invoice = mkInvoice();
      const payment = mkPayment();
      const { client, invoices, payments, refunds } = buildMockPrisma(invoice, [payment]);
      await build(client);

      const result = await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 100,
        refundRecord: {
          reason: 'customer request',
        },
      });

      // Independent recompute from the fixture:
      //   original payment: $100. refund: $100. refundedOnPayment: $100.
      //   paymentRefundStatus: full (>= paymentAmount).
      //   otherPaymentsNetContribution: 0 (no other payments).
      //   → invoice.status flips to 'refunded'.
      const expectedAmountPaid = Math.max(0, 100 - 100);
      const expectedAmountDue = Math.max(0, 100 - expectedAmountPaid);
      const expectedStatus = 'refunded';

      expect(result.newStatus).toBe(expectedStatus);
      expect(result.newAmountPaid).toBeCloseTo(expectedAmountPaid, 6);
      expect(result.newAmountDue).toBeCloseTo(expectedAmountDue, 6);
      expect(result.paymentRefundStatus).toBe('full');

      // Assert invoice row state.
      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('refunded');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(0, 6);

      // Assert payment row state.
      const finalPayment = payments.get(PAYMENT_ID_A)!;
      expect(Number(finalPayment.refunded_amount)).toBeCloseTo(100, 6);
      expect(finalPayment.refund_status).toBe('full');

      // Assert refund row was created.
      expect(refunds.size).toBe(1);
      const [refund] = Array.from(refunds.values());
      expect(Number(refund.amount)).toBeCloseTo(100, 6);
      expect(refund.status).toBe('succeeded');
      expect(refund.reason).toBe('customer request');

      // Independent I2 recompute: refunded invoices are neither Billed
      // nor Collected in canon I2.
      const allInvoices = Array.from(invoices.values());
      const billed = allInvoices
        .filter((inv) => inv.status === 'issued' || inv.status === 'overdue')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);
      const collected = allInvoices
        .filter((inv) => inv.status === 'paid')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);
      expect(billed).toBeCloseTo(0, 6);
      expect(collected).toBeCloseTo(0, 6);
    });
  });

  describe('partial refund', () => {
    it('partial refund does not flip status, amountDue updated', async () => {
      const invoice = mkInvoice();
      const payment = mkPayment();
      const { client, invoices, payments } = buildMockPrisma(invoice, [payment]);
      await build(client);

      const result = await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 30,
        refundRecord: {
          reason: 'partial service issue',
        },
      });

      // Independent recompute: original payment $100, refund $30.
      //   refundedOnPayment: $30 (partial), refund_status: partial.
      //   invoice.amountPaid: 100 - 30 = 70, amountDue: 100 - 70 = 30.
      //   Status stays 'paid' per canon I2 (partial refund does NOT change
      //   invoice status). Finalizer applies this rule declaratively.
      const expectedAmountPaid = 100 - 30;
      const expectedAmountDue = 100 - expectedAmountPaid;

      expect(result.newAmountPaid).toBeCloseTo(expectedAmountPaid, 6);
      expect(result.newAmountDue).toBeCloseTo(expectedAmountDue, 6);
      expect(result.paymentRefundStatus).toBe('partial');
      // Status is whatever it was before (we seeded 'paid'); the finalizer
      // only flips to 'refunded' on full whole-invoice refund.
      expect(result.newStatus).toBe('paid');

      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(70, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(30, 6);

      const finalPayment = payments.get(PAYMENT_ID_A)!;
      expect(Number(finalPayment.refunded_amount)).toBeCloseTo(30, 6);
      expect(finalPayment.refund_status).toBe('partial');
    });

    it('sequential partial refunds accumulate correctly', async () => {
      const invoice = mkInvoice();
      const payment = mkPayment();
      const { client, invoices, payments } = buildMockPrisma(invoice, [payment]);
      await build(client);

      await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 20,
        refundRecord: {},
      });
      await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 30,
        refundRecord: {},
      });

      // Independent recompute: two refunds summing to $50 against a $100
      // payment. refundedOnPayment: $50, still partial. invoice.amountPaid:
      // 100 - 50 = 50.
      const finalPayment = payments.get(PAYMENT_ID_A)!;
      expect(Number(finalPayment.refunded_amount)).toBeCloseTo(50, 6);
      expect(finalPayment.refund_status).toBe('partial');

      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(50, 6);
      expect(finalInvoice.status).toBe('paid');
    });
  });

  describe('rejection guards', () => {
    it('rejects zero or negative refund amount', async () => {
      const invoice = mkInvoice();
      const payment = mkPayment();
      const { client } = buildMockPrisma(invoice, [payment]);
      await build(client);

      await expect(
        finalizer.finalizeRefund({
          paymentId: PAYMENT_ID_A,
          refundAmount: 0,
          refundRecord: {},
        }),
      ).rejects.toThrow(/> 0/);

      await expect(
        finalizer.finalizeRefund({
          paymentId: PAYMENT_ID_A,
          refundAmount: -5,
          refundRecord: {},
        }),
      ).rejects.toThrow(/> 0/);
    });

    it('rejects double-refund on already fully-refunded payment', async () => {
      // Pre-seed a payment that's already fully refunded (refunded_amount
      // equals amount). A second refund attempt must reject.
      const invoice = mkInvoice({
        status: 'refunded',
        amountPaid: '0',
        amountDue: '100.00',
      });
      const payment = mkPayment({
        refunded_amount: '100.00',
        refund_status: 'full',
      });
      const { client } = buildMockPrisma(invoice, [payment]);
      await build(client);

      await expect(
        finalizer.finalizeRefund({
          paymentId: PAYMENT_ID_A,
          refundAmount: 10,
          refundRecord: {},
        }),
      ).rejects.toThrow(/already fully refunded/);
    });

    it('rejects refund exceeding remaining refundable balance', async () => {
      // Payment is $100, already $60 refunded. Remaining: $40. A $50 refund
      // attempt must reject.
      const invoice = mkInvoice({
        amountPaid: '40.00',
        amountDue: '60.00',
      });
      const payment = mkPayment({
        refunded_amount: '60.00',
        refund_status: 'partial',
      });
      const { client } = buildMockPrisma(invoice, [payment]);
      await build(client);

      await expect(
        finalizer.finalizeRefund({
          paymentId: PAYMENT_ID_A,
          refundAmount: 50,
          refundRecord: {},
        }),
      ).rejects.toThrow(/exceeds remaining refundable/);
    });
  });

  describe('multi-payment invoice', () => {
    it('full refund on one of two payments does NOT flip invoice to refunded', async () => {
      // $150 invoice with two $75 payments, both succeeded. Full refund of
      // payment A leaves payment B active, so invoice stays 'paid'.
      const invoice = mkInvoice({
        amountPaid: '150.00',
        amountDue: '0',
        totalAmount: '150.00',
      });
      const paymentA = mkPayment({ id: PAYMENT_ID_A, amount: '75.00' });
      const paymentB = mkPayment({ id: PAYMENT_ID_B, amount: '75.00' });
      const { client, invoices, payments } = buildMockPrisma(invoice, [paymentA, paymentB]);
      await build(client);

      const result = await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 75,
        refundRecord: {},
      });

      // Independent recompute:
      //   payment A: refunded in full → refund_status 'full'.
      //   payment B: untouched, contributes $75 net revenue to invoice.
      //   otherPaymentsNetContribution: 75 > 0, so invoice status stays.
      //   invoice.amountPaid: 150 - 75 = 75, amountDue: 150 - 75 = 75.
      expect(result.paymentRefundStatus).toBe('full');
      expect(result.newStatus).toBe('paid'); // NOT 'refunded'; B still active.
      expect(result.newAmountPaid).toBeCloseTo(75, 6);
      expect(result.newAmountDue).toBeCloseTo(75, 6);

      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      const finalPaymentA = payments.get(PAYMENT_ID_A)!;
      expect(finalPaymentA.refund_status).toBe('full');
      const finalPaymentB = payments.get(PAYMENT_ID_B)!;
      expect(finalPaymentB.refund_status).toBe('none');
    });
  });

  describe('existing refund row update path', () => {
    it('updates an existing pending refund row when existingRefundId provided', async () => {
      const invoice = mkInvoice();
      const payment = mkPayment({ provider_transaction_id: 'ch_test_123' });
      const mock = buildMockPrisma(invoice, [payment]);
      const existingRefundId = '66666666-6666-6666-6666-666666666666';
      mock.refunds.set(existingRefundId, {
        id: existingRefundId,
        invoice_payment_id: PAYMENT_ID_A,
        amount: '100.00',
        currency: 'USD',
        reason: 'webhook pending',
        status: 'pending',
        provider_refund_id: 're_test_abc',
        refunded_by: null,
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await build(mock.client);

      await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 100,
        refundRecord: {
          existingRefundId,
          provider_refund_id: 're_test_abc',
        },
      });

      // Still one refund row. The pending one got flipped to 'succeeded'.
      expect(mock.refunds.size).toBe(1);
      const r = mock.refunds.get(existingRefundId)!;
      expect(r.status).toBe('succeeded');
      expect(r.processed_at).not.toBeNull();
    });
  });

  describe('canonical I2 invoice totals parity after refund', () => {
    it('independent raw-row recompute of I2 buckets agrees with finalizer writes', async () => {
      // Seed two invoices in the org. Full-refund invoice A, leave invoice
      // B untouched. Independent recompute of I2 should see: billed=B.total
      // (status stays 'issued'), collected=0, and refunded A drops out of
      // both buckets.
      const invoiceA = mkInvoice({ id: INVOICE_ID, totalAmount: '100.00' });
      const invoiceBId = '77777777-7777-7777-7777-777777777777';
      const invoiceB: InvoiceRow = {
        id: invoiceBId,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '200.00',
        totalAmount: '200.00',
        invoiceNumber: 'INV-B',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };

      const paymentA = mkPayment({ id: PAYMENT_ID_A, invoiceId: INVOICE_ID, amount: '100.00' });

      const { client, invoices } = buildMockPrisma(invoiceA, [paymentA]);
      invoices.set(invoiceBId, { ...invoiceB });
      await build(client);

      await finalizer.finalizeRefund({
        paymentId: PAYMENT_ID_A,
        refundAmount: 100,
        refundRecord: {},
      });

      // Independent recompute of canon I2 over the fixture.
      const all = Array.from(invoices.values());
      const billed = all
        .filter((inv) => inv.status === 'issued' || inv.status === 'overdue')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);
      const collected = all
        .filter((inv) => inv.status === 'paid')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);
      const refunded = all
        .filter((inv) => inv.status === 'refunded')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);

      expect(billed).toBeCloseTo(200, 6); // Invoice B still issued.
      expect(collected).toBeCloseTo(0, 6); // Invoice A is not paid.
      expect(refunded).toBeCloseTo(100, 6); // Invoice A refunded.
    });
  });
});
