/**
 * Cross-tenant WRITE isolation tests for InvoicesService.
 *
 * Companion to the read-isolation tests (getInvoiceById/getPayment 404 a cross-tenant id)
 * and the subscription-side spec (subscription-xtenant.service.spec.ts). OrgRoleGuard +
 * @OrgFromUser only proves the CALLER holds a money role in their OWN org; it never checks
 * the target id belongs to that org. Without an ownership check, a finance/admin in org A
 * could refund / void / finalize / mark-paid / edit / record a payment against org B's
 * invoice or payment by guessing the id.
 *
 * Every money-write method resolves and verifies ownership against the CALLER's org (threaded from the
 * authenticated principal — AuthenticatedUser.organizationId, never the URL/body) BEFORE the
 * mutation: invoice writes call getInvoiceById(id, orgId); createRefund resolves the payment
 * through getPayment(paymentId, orgId); both 404 a cross-tenant id. assertOrgContext(orgId)
 * runs first so an undefined org can never silently disable the filter (Prisma drops undefined
 * where-keys).
 *
 * These tests prove, for the main mutations:
 *   1. a principal from org A is DENIED (NotFoundException) mutating org B's invoice/payment
 *   2. the SAME principal CAN mutate its OWN org's record
 *   3. the internal/system seam (id-only resolve + the cron's status-write primitive) still
 *      works with NO caller org: the gate stays out of the ungated internal path
 *   4. a missing/undefined org FAILS CLOSED — the method throws before any query/mutation
 *
 * Convention matches the module: in-memory mock Prisma + NestJS Testing module — fast, no DB.
 * The mock models the exact query shapes so a test only passes if the SERVICE actually threads
 * organizationId into the ownership lookup:
 *   - invoices.findFirst({ where: { id, organizationId } })                 -> org-scoped gate
 *   - invoice_payments.findFirst({ where: { id, invoices: { organizationId } } }) -> payment gate
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { EmailService } from '../email/email.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { SubscriptionBillingService } from '../subscription/subscription-billing.service';
import { InvoicePaymentReconciler } from './invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from './invoice-refund-finalizer.service';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // caller's own org
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // victim org
const INV_A = '1a1a1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a'; // invoice owned by ORG_A
const INV_B = '1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b'; // invoice owned by ORG_B
const PAY_A = '2a2a2a2a-2a2a-2a2a-2a2a-2a2a2a2a2a2a'; // payment under INV_A (ORG_A)
const PAY_B = '2b2b2b2b-2b2b-2b2b-2b2b-2b2b2b2b2b2b'; // payment under INV_B (ORG_B)

function buildHarness() {
  // Two invoices, one per org, each with a payment. The mock resolves a payment's parent
  // invoice to answer the relation-scoped { invoices: { organizationId } } filter exactly the
  // way Prisma would — so getPayment only matches when the payment's invoice belongs to orgId.
  const invoiceRows = [
    {
      id: INV_A,
      organizationId: ORG_A,
      status: 'draft',
      invoice_line_items: [],
      invoice_payments: [],
    },
    {
      id: INV_B,
      organizationId: ORG_B,
      status: 'draft',
      invoice_line_items: [],
      invoice_payments: [],
    },
  ];
  const paymentRows = [
    { id: PAY_A, invoiceId: INV_A, amount: '100.00', provider_transaction_id: null },
    { id: PAY_B, invoiceId: INV_B, amount: '100.00', provider_transaction_id: null },
  ];
  const refundRows = [
    { id: 'refund-1', invoice_payment_id: PAY_A, amount: '100.00', status: 'succeeded' },
  ];

  const prisma = {
    invoices: {
      // org-scoped ownership gate: matches only when BOTH id AND organizationId agree
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          invoiceRows.find((i) => i.id === where.id && i.organizationId === where.organizationId) ??
          null
        );
      }),
      // id-only internal lookup (cron/SDK generate round-trip). Tenant writes must NOT use this.
      findUnique: jest.fn(async ({ where }: any) => {
        return invoiceRows.find((i) => i.id === where.id) ?? null;
      }),
      // the mutation primitive — also exactly what the billing cron calls directly (by id, no org)
      update: jest.fn(async ({ where, data }: any) => {
        const row = invoiceRows.find((i) => i.id === where.id);
        if (!row) throw new Error('record not found');
        Object.assign(row, data);
        return row;
      }),
    },
    invoice_payments: {
      // payment ownership gate: matches by id only when the parent invoice belongs to orgId
      findFirst: jest.fn(async ({ where }: any) => {
        const requiredOrg = where.invoices?.organizationId;
        return (
          paymentRows.find((p) => {
            if (p.id !== where.id) return false;
            if (requiredOrg) {
              const parent = invoiceRows.find((i) => i.id === p.invoiceId);
              if (!parent || parent.organizationId !== requiredOrg) return false;
            }
            return true;
          }) ?? null
        );
      }),
      // id-only (getPaymentInternal + recordPayment result lookup)
      findUnique: jest.fn(async ({ where }: any) => {
        return paymentRows.find((p) => p.id === where.id) ?? null;
      }),
    },
    refunds: {
      findUnique: jest.fn(
        async ({ where }: any) => refundRows.find((r) => r.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => data),
    },
  } as any;

  // recordPayment delegates the actual money-write to the reconciler; we only need it to
  // hand back a paymentId so the service's result-lookup resolves. The gate runs BEFORE this.
  const paymentReconciler = { recordPayment: jest.fn(async () => ({ paymentId: PAY_A })) };
  // manual-refund path delegates the transactional write to the finalizer.
  const refundFinalizer = { finalizeRefund: jest.fn(async () => ({ refundId: 'refund-1' })) };

  return { prisma, paymentReconciler, refundFinalizer };
}

async function buildService(h: ReturnType<typeof buildHarness>): Promise<InvoicesService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: PrismaService, useValue: h.prisma },
      { provide: PdfService, useValue: {} },
      { provide: EmailService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: PaymentProcessingService, useValue: {} },
      { provide: InvoicePaymentReconciler, useValue: h.paymentReconciler },
      { provide: InvoiceRefundFinalizer, useValue: h.refundFinalizer },
      { provide: SubscriptionBillingService, useValue: {} },
    ],
  }).compile();
  return module.get(InvoicesService);
}

describe('InvoicesService — cross-tenant WRITE isolation', () => {
  let h: ReturnType<typeof buildHarness>;
  let service: InvoicesService;

  beforeEach(async () => {
    h = buildHarness();
    service = await buildService(h);
  });

  // ── 1. cross-tenant DENY: org A cannot mutate org B's records ────────────────────────────
  describe('org A is DENIED mutating org B records (404, nothing written)', () => {
    it('updateInvoice cross-tenant -> 404 and never calls invoices.update', async () => {
      await expect(service.updateInvoice(INV_B, ORG_A, { notes: 'pwned' } as any)).rejects.toThrow(
        NotFoundException,
      );
      // proves the org filter is actually on the gate query, not coincidental
      expect(h.prisma.invoices.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: INV_B, organizationId: ORG_A } }),
      );
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('finalizeInvoice cross-tenant -> 404, no write', async () => {
      await expect(service.finalizeInvoice(INV_B, ORG_A)).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('markAsPaid cross-tenant -> 404, no write (cannot mark another org invoice paid)', async () => {
      await expect(service.markAsPaid(INV_B, ORG_A)).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('voidInvoice cross-tenant -> 404, no write', async () => {
      await expect(service.voidInvoice(INV_B, ORG_A)).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('recordPayment cross-tenant -> 404 BEFORE the reconciler records any money', async () => {
      await expect(service.recordPayment(INV_B, ORG_A, { amount: 100 } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(h.paymentReconciler.recordPayment).not.toHaveBeenCalled();
    });

    it('createRefund cross-tenant -> 404 BEFORE the finalizer refunds anything', async () => {
      await expect(service.createRefund(PAY_B, ORG_A, { amount: 100 } as any)).rejects.toThrow(
        NotFoundException,
      );
      // proves the payment lookup joins through the parent invoice's org
      expect(h.prisma.invoice_payments.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAY_B, invoices: { organizationId: ORG_A } } }),
      );
      expect(h.refundFinalizer.finalizeRefund).not.toHaveBeenCalled();
    });
  });

  // ── 2. same principal CAN mutate its OWN org's records ───────────────────────────────────
  describe('org A CAN mutate its OWN records', () => {
    it('finalizeInvoice own-org -> flips status to issued', async () => {
      const res = await service.finalizeInvoice(INV_A, ORG_A);
      expect(res.status).toBe('issued');
      expect(h.prisma.invoices.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: INV_A } }),
      );
    });

    it('voidInvoice own-org -> flips status to void', async () => {
      const res = await service.voidInvoice(INV_A, ORG_A);
      expect(res.status).toBe('void');
    });

    it('updateInvoice own-org -> writes', async () => {
      await service.updateInvoice(INV_A, ORG_A, { notes: 'ok' } as any);
      expect(h.prisma.invoices.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: INV_A } }),
      );
    });

    it('recordPayment own-org -> reconciler records the money', async () => {
      await service.recordPayment(INV_A, ORG_A, { amount: 100 } as any);
      expect(h.paymentReconciler.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: INV_A }),
      );
    });

    it('createRefund own-org (manual payment) -> finalizer refunds', async () => {
      await service.createRefund(PAY_A, ORG_A, { amount: 100 } as any);
      expect(h.refundFinalizer.finalizeRefund).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: PAY_A }),
      );
    });
  });

  // ── 3. internal/system seam works with NO caller org ─────────────────────────────────────
  // The cron/SDK generate round-trip resolves invoices by id alone (getInvoiceByIdInternal),
  // and the billing cron writes invoice status via prisma.invoices.update by id with NO org
  // filter. Org-gating must stay out of these ungated system paths.
  it('INTERNAL: resolves an invoice by id with NO org and the cron status-write still mutates by id', async () => {
    // id-only resolve — succeeds even for "another org's" id, because the system has no caller org
    const inv = await service.getInvoiceByIdInternal(INV_B);
    expect(inv.id).toBe(INV_B);
    expect(h.prisma.invoices.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: INV_B } }),
    );
    // the cron's write primitive: update by id, no organizationId in the where — still works
    const updated = await h.prisma.invoices.update({
      where: { id: INV_B },
      data: { status: 'issued' },
    });
    expect(updated.status).toBe('issued');
    // and the id-only resolve never touched the org-scoped gate query
    expect(h.prisma.invoices.findFirst).not.toHaveBeenCalled();
  });

  // ── 4. missing org FAILS CLOSED (Prisma drops undefined where-keys) ────────────
  describe('a missing/undefined org fails closed — throws before any query/mutation', () => {
    it('updateInvoice with undefined org throws and never queries or writes', async () => {
      await expect(
        service.updateInvoice(INV_A, undefined as any, { notes: 'x' } as any),
      ).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoices.findFirst).not.toHaveBeenCalled();
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('markAsPaid with undefined org throws and never writes', async () => {
      await expect(service.markAsPaid(INV_A, undefined as any)).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('recordPayment with undefined org throws before the reconciler runs', async () => {
      await expect(
        service.recordPayment(INV_A, undefined as any, { amount: 100 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(h.paymentReconciler.recordPayment).not.toHaveBeenCalled();
    });

    it('createRefund with undefined org throws before the payment lookup', async () => {
      await expect(
        service.createRefund(PAY_A, undefined as any, { amount: 100 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(h.prisma.invoice_payments.findFirst).not.toHaveBeenCalled();
      expect(h.refundFinalizer.finalizeRefund).not.toHaveBeenCalled();
    });
  });
});
