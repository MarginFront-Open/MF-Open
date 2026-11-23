/**
 * Parity tests for InvoicePaymentReconciler.
 *
 * These tests prove that recordPayment correctly:
 *   1. Creates (or updates) an invoice_payments row with the right status.
 *   2. Atomically updates invoice.amountPaid / amountDue / status.
 *   3. Flips the invoice to 'paid' when newAmountPaid >= totalAmount.
 *   4. Leaves the invoice status untouched when partial.
 *   5. Matches canonical invoice totals after the write (independent raw-row
 *      recompute from the fixture).
 *
 * The mock Prisma uses in-memory row maps so we can exercise the real
 * read-modify-write contract without a real database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { InvoicePaymentReconciler } from './invoice-payment-reconciler.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_ID = '33333333-3333-3333-3333-333333333333';

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
  provider_checkout_session_id: string | null;
  provider_status: string | null;
  payment_provider_id: string | null;
  reference: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  recordedBy: string | null;
  card_last4: string | null;
  card_brand: string | null;
  provider_fee: string | number | null;
  net_amount: string | number | null;
  receipt_url: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function buildMockPrisma(seedInvoice: InvoiceRow) {
  const invoices = new Map<string, InvoiceRow>();
  invoices.set(seedInvoice.id, { ...seedInvoice });
  const payments = new Map<string, PaymentRow>();

  const client = {
    getClient: function () {
      return this;
    },
    $transaction: async (cb: (tx: any) => Promise<any>) => cb(client),
    invoices: {
      findUnique: async ({ where, select: _select }: any) => {
        const row = invoices.get(where.id);
        if (!row) return null;
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = invoices.get(where.id);
        if (!row) throw new Error('invoice not found');
        Object.assign(row, data);
        invoices.set(where.id, row);
        return row;
      },
      findMany: async ({ where }: any) => {
        const out: InvoiceRow[] = [];
        for (const row of invoices.values()) {
          if (where.organizationId && row.organizationId !== where.organizationId) continue;
          if (where.invoiceDate?.gte && row.invoiceDate < where.invoiceDate.gte) continue;
          if (where.invoiceDate?.lte && row.invoiceDate > where.invoiceDate.lte) continue;
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
          if (typeof where.status === 'string' && row.status !== where.status) continue;
          out.push(row);
        }
        return out;
      },
    },
    invoice_payments: {
      create: async ({ data }: any) => {
        const row: PaymentRow = {
          id: data.id,
          invoiceId: data.invoiceId,
          amount: data.amount,
          paymentMethod: data.paymentMethod,
          status: data.status,
          paymentDate: data.paymentDate,
          currency: data.currency,
          refunded_amount: 0,
          refund_status: 'none',
          provider_transaction_id: data.provider_transaction_id ?? null,
          provider_checkout_session_id: data.provider_checkout_session_id ?? null,
          provider_status: data.provider_status ?? null,
          payment_provider_id: data.payment_provider_id ?? null,
          reference: data.reference ?? null,
          notes: data.notes ?? null,
          metadata: data.metadata ?? {},
          recordedBy: data.recordedBy ?? null,
          card_last4: data.card_last4 ?? null,
          card_brand: data.card_brand ?? null,
          provider_fee: data.provider_fee ?? null,
          net_amount: data.net_amount ?? null,
          receipt_url: data.receipt_url ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
        payments.set(row.id, row);
        return row;
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
        const out: PaymentRow[] = [];
        for (const row of payments.values()) {
          if (where.invoiceId && row.invoiceId !== where.invoiceId) continue;
          if (where.id?.not && row.id === where.id.not) continue;
          if (where.status?.notIn && where.status.notIn.includes(row.status)) continue;
          out.push(row);
        }
        return out;
      },
      findUnique: async ({ where }: any) => payments.get(where.id) ?? null,
    },
    signal_events: {
      findMany: async () => [],
    },
  };

  return {
    client,
    invoices,
    payments,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe('InvoicePaymentReconciler canonical parity', () => {
  let reconciler: InvoicePaymentReconciler;

  async function build(mockPrisma: any) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePaymentReconciler,
        RevenueMetricsService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();
    reconciler = module.get<InvoicePaymentReconciler>(InvoicePaymentReconciler);
    return reconciler;
  }

  describe('recordPayment creates payment and reconciles invoice', () => {
    it('full payment flips invoice status to paid', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '100.00',
        totalAmount: '100.00',
        invoiceNumber: 'INV-001',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices, payments } = buildMockPrisma(invoice);
      await build(client);

      const result = await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 100,
        paymentRecord: {
          paymentMethod: 'credit_card',
          status: 'succeeded',
        },
      });

      // Independent recompute of expected state from the fixture.
      const expectedAmountPaid = 0 + 100;
      const expectedAmountDue = Math.max(0, 100 - expectedAmountPaid);
      const expectedStatus = expectedAmountPaid >= 100 ? 'paid' : 'issued';

      expect(result.invoiceStatus).toBe(expectedStatus);
      expect(result.amountPaid).toBeCloseTo(expectedAmountPaid, 6);
      expect(result.amountDue).toBeCloseTo(expectedAmountDue, 6);

      // Assert the in-memory invoice row reflects the write.
      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(100, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(0, 6);

      // Assert an invoice_payments row was created with the right amount.
      expect(payments.size).toBe(1);
      const [payment] = Array.from(payments.values());
      expect(Number(payment.amount)).toBeCloseTo(100, 6);
      expect(payment.status).toBe('succeeded');
    });

    it('partial payment does not flip status, amountDue reduced', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '500.00',
        totalAmount: '500.00',
        invoiceNumber: 'INV-002',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices } = buildMockPrisma(invoice);
      await build(client);

      const result = await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 200,
        paymentRecord: {
          paymentMethod: 'credit_card',
        },
      });

      const expectedAmountPaid = 0 + 200;
      const expectedAmountDue = 500 - expectedAmountPaid;

      expect(result.invoiceStatus).toBe('issued');
      expect(result.amountPaid).toBeCloseTo(expectedAmountPaid, 6);
      expect(result.amountDue).toBeCloseTo(expectedAmountDue, 6);

      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('issued');
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(200, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(300, 6);
    });

    it('second partial payment on same invoice tips it into paid', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '60.00',
        amountDue: '40.00',
        totalAmount: '100.00',
        invoiceNumber: 'INV-003',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices } = buildMockPrisma(invoice);
      await build(client);

      await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 40,
        paymentRecord: {
          paymentMethod: 'credit_card',
        },
      });

      // Independent recompute: 60 + 40 = 100 = totalAmount, so status flips.
      const expectedAmountPaid = 60 + 40;
      const expectedStatus = expectedAmountPaid >= 100 ? 'paid' : 'issued';

      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe(expectedStatus);
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(100, 6);
    });

    it('rejects zero or negative payment amount', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '100.00',
        totalAmount: '100.00',
        invoiceNumber: 'INV-004',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client } = buildMockPrisma(invoice);
      await build(client);

      await expect(
        reconciler.recordPayment({
          invoiceId: INVOICE_ID,
          paymentAmount: 0,
          paymentRecord: { paymentMethod: 'credit_card' },
        }),
      ).rejects.toThrow(/paymentAmount > 0/);

      await expect(
        reconciler.recordPayment({
          invoiceId: INVOICE_ID,
          paymentAmount: -5,
          paymentRecord: { paymentMethod: 'credit_card' },
        }),
      ).rejects.toThrow(/paymentAmount > 0/);
    });

    it('updates existing pending payment row when existingPaymentId provided', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '75.00',
        totalAmount: '75.00',
        invoiceNumber: 'INV-005',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, payments } = buildMockPrisma(invoice);

      // Pre-seed a pending payment (as the checkout-init step would have).
      const pendingId = '44444444-4444-4444-4444-444444444444';
      payments.set(pendingId, {
        id: pendingId,
        invoiceId: INVOICE_ID,
        amount: '75.00',
        paymentMethod: 'credit_card',
        status: 'pending',
        paymentDate: new Date(),
        currency: 'USD',
        refunded_amount: 0,
        refund_status: 'none',
        provider_transaction_id: null,
        provider_checkout_session_id: 'cs_test_123',
        provider_status: null,
        payment_provider_id: null,
        reference: null,
        notes: null,
        metadata: {},
        recordedBy: null,
        card_last4: null,
        card_brand: null,
        provider_fee: null,
        net_amount: null,
        receipt_url: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await build(client);

      await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 75,
        paymentRecord: {
          existingPaymentId: pendingId,
          paymentMethod: 'credit_card',
          status: 'succeeded',
          provider_transaction_id: 'pi_test_abc',
        },
      });

      // Still 1 payment row. Existing one was updated, no new row created.
      expect(payments.size).toBe(1);
      const updatedPayment = payments.get(pendingId)!;
      expect(updatedPayment.status).toBe('succeeded');
      expect(updatedPayment.provider_transaction_id).toBe('pi_test_abc');
    });
  });

  describe('overpayment ceiling', () => {
    // Scenario: invoice is already fully paid (a prior recordPayment landed
    // and flipped status to paid). A SECOND payment then lands referencing a
    // different cs_* session. Without the ceiling,
    // amountPaid would jump from totalAmount to 2*totalAmount.
    it('blocks a second payment that would push amountPaid past totalAmount', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'paid', // first payment already landed
        amountPaid: '2.25',
        amountDue: '0.00',
        totalAmount: '2.25',
        invoiceNumber: 'INV-OVERPAY',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices, payments } = buildMockPrisma(invoice);
      await build(client);

      const result = await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 2.25,
        paymentRecord: {
          paymentMethod: 'credit_card',
          status: 'succeeded',
          provider_checkout_session_id: 'cs_test_second_session_id',
        },
      });

      // The ceiling short-circuits — invoice header reflects the FIRST payment's
      // state, not 2x. amountPaid stays at totalAmount.
      expect(result.amountPaid).toBeCloseTo(2.25, 6);
      expect(result.amountDue).toBeCloseTo(0, 6);
      expect(result.invoiceStatus).toBe('paid');

      // Invoice row in-memory: unchanged (still at first-payment values).
      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(Number(finalInvoice.amountPaid)).toBeCloseTo(2.25, 6);
      expect(Number(finalInvoice.amountDue)).toBeCloseTo(0, 6);
      expect(finalInvoice.status).toBe('paid');

      // The payment row is still created (money moved at the provider), but
      // it is not applied to the invoice header.
      expect(payments.size).toBe(1);
      const [createdPayment] = Array.from(payments.values());
      expect(createdPayment.provider_checkout_session_id).toBe('cs_test_second_session_id');
      expect(createdPayment.status).toBe('succeeded');
    });

    it('allows exact-total payment (no false positives at the boundary)', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '100.00',
        totalAmount: '100.00',
        invoiceNumber: 'INV-EXACT',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices } = buildMockPrisma(invoice);
      await build(client);

      const result = await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 100,
        paymentRecord: { paymentMethod: 'credit_card' },
      });

      // Boundary case: 0 + 100 == 100. The ceiling must NOT block this.
      expect(result.invoiceStatus).toBe('paid');
      expect(result.amountPaid).toBeCloseTo(100, 6);
      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
    });

    it('tolerates 1-cent float drift (does not block at total + 0.005)', async () => {
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '99.995',
        amountDue: '0.005',
        totalAmount: '100.00',
        invoiceNumber: 'INV-EPS',
        invoiceDate: new Date(Date.UTC(2026, 3, 10)),
      };
      const { client, invoices } = buildMockPrisma(invoice);
      await build(client);

      // 99.995 + 0.01 = 100.005, total = 100, epsilon = 0.01.
      // 100.005 > 100 + 0.01 == 100.01? No. So the ceiling lets it through.
      const result = await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 0.01,
        paymentRecord: { paymentMethod: 'credit_card' },
      });

      expect(result.invoiceStatus).toBe('paid');
      const finalInvoice = invoices.get(INVOICE_ID)!;
      expect(finalInvoice.status).toBe('paid');
    });
  });

  describe('parity with canonical invoice totals', () => {
    // This asserts the independent raw-row recompute from the in-memory
    // invoices map matches what canonGetInvoiceTotals would produce. We
    // don't actually call the canonical function through the mock (the mock
    // prisma stub would need full findMany fidelity); instead we do the
    // recompute here and assert the invoice row is consistent with I2.
    it('after recordPayment, invoice row matches canon I2 classification', async () => {
      const invoiceDate = new Date(Date.UTC(2026, 3, 10));
      const invoice: InvoiceRow = {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        status: 'issued',
        amountPaid: '0',
        amountDue: '200.00',
        totalAmount: '200.00',
        invoiceNumber: 'INV-P1',
        invoiceDate,
      };
      const { client, invoices } = buildMockPrisma(invoice);
      await build(client);

      await reconciler.recordPayment({
        invoiceId: INVOICE_ID,
        paymentAmount: 200,
        paymentRecord: { paymentMethod: 'credit_card' },
      });

      const finalInvoice = invoices.get(INVOICE_ID)!;
      // I2: invoices with status='paid' and invoiceDate in window go to Collected.
      // Independent recompute:
      const allInvoices = [finalInvoice];
      const collected = allInvoices
        .filter((inv) => inv.status === 'paid')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);
      const billed = allInvoices
        .filter((inv) => inv.status === 'issued' || inv.status === 'overdue')
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);

      expect(collected).toBeCloseTo(200, 6);
      expect(billed).toBeCloseTo(0, 6);
    });
  });
});
