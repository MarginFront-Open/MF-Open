/**
 * InvoiceRefundFinalizer. The canonical path for finalizing a refund
 * against a prior payment and rolling back the invoice's financial fields.
 *
 * Why this service exists
 * -----------------------
 * Every refund path (the provider webhook and the manual invoice refund)
 * finalizes here, so the invoice status is decided in one place. Flipping
 * to 'refunded' on `newAmountPaid <= 0` is wrong when there are MULTIPLE
 * payments on a single invoice: one refund of payment A doesn't necessarily
 * leave amountPaid at 0, and it shouldn't flip the invoice to 'refunded'
 * without accounting for the other payments.
 *
 * The status follows a declarative state machine:
 *
 *   refundAmount == paymentAmount AND no other payments exist for the invoice
 *     → status flips to 'refunded' (the whole invoice is refunded).
 *   refundAmount == paymentAmount AND other payments exist
 *     → status stays (partial refund at the invoice level).
 *   refundAmount < paymentAmount
 *     → status stays, amountPaid and amountDue update arithmetically.
 *   refundAmount > paymentAmount
 *     → reject (you can't refund more than the payment was for).
 *   payment already fully refunded
 *     → reject (double-refund guard).
 *
 * Canon citations (packages/db/CANON.md):
 *   I1. Non-draft invoice totals reconcile by construction; finalizeRefund
 *        must leave amountPaid + status consistent with canonical library.
 *   I2. 'refunded' status is invoice-level. Partial payment refunds don't
 *        change the invoice status, only amountPaid + amountDue.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

/**
 * Arguments for finalizing a refund. The refund may already exist as a
 * pending row (provider-initiated webhook path) or may need to be created
 * fresh (out-of-band refund via provider dashboard, or manual refund).
 */
export interface FinalizeRefundArgs {
  /** The invoice_payments.id this refund is against. */
  paymentId: string;
  /** Refund amount in dollars (not cents). Must be > 0. */
  refundAmount: number;
  /**
   * Refund row fields. If the caller has a pending refund row already
   * (InvoicesService.createRefund writes one when it calls the provider refund
   * API), pass its UUID as `existingRefundId`. We'll UPDATE that row to 'succeeded'.
   * Otherwise a new refund row is created.
   */
  refundRecord: {
    existingRefundId?: string;
    reason?: string | null;
    provider_refund_id?: string | null;
    currency?: string;
    refunded_by?: string | null;
  };
}

export interface FinalizeRefundResult {
  /** UUID of the refunds row (new or updated). */
  refundId: string;
  /** Final invoice status after refund. */
  newStatus: string;
  /** Final invoice.amountPaid after refund. */
  newAmountPaid: number;
  /** Final invoice.amountDue after refund. */
  newAmountDue: number;
  /** Per-payment refund status: none / partial / full. */
  paymentRefundStatus: 'none' | 'partial' | 'full';
}

type PrismaTxClient = Parameters<
  Parameters<ReturnType<PrismaService['getClient']>['$transaction']>[0]
>[0];

@Injectable()
export class InvoiceRefundFinalizer {
  private readonly logger = new Logger(InvoiceRefundFinalizer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  /**
   * Finalize a refund against a prior payment. This is the ONLY place
   * `invoice.amountPaid` or `invoice.status = 'refunded'` may be written in
   * response to a refund. Direct Prisma updates elsewhere are forbidden by
   * rule R8 in scripts/canonical-audit.sh.
   */
  async finalizeRefund(
    args: FinalizeRefundArgs,
    tx?: PrismaTxClient,
  ): Promise<FinalizeRefundResult> {
    const { paymentId, refundAmount, refundRecord } = args;

    if (refundAmount <= 0) {
      throw new BadRequestException(`Refund amount must be > 0 (got ${refundAmount})`);
    }

    const run = async (client: PrismaTxClient): Promise<FinalizeRefundResult> => {
      const payment = await client.invoice_payments.findUnique({
        where: { id: paymentId },
        include: {
          invoices: {
            select: {
              id: true,
              organizationId: true,
              invoiceDate: true,
              status: true,
              amountPaid: true,
              totalAmount: true,
              invoiceNumber: true,
            },
          },
        },
      });

      if (!payment) {
        throw new NotFoundException(`Payment not found: ${paymentId}`);
      }
      if (!payment.invoices) {
        throw new NotFoundException(`Parent invoice missing for payment ${paymentId}`);
      }

      const paymentAmount = Number(payment.amount ?? 0);
      const currentRefundedOnPayment = Number(payment.refunded_amount ?? 0);
      const paymentRemaining = paymentAmount - currentRefundedOnPayment;

      // Double-refund guard. If the payment is already fully refunded OR
      // the requested refund exceeds what's left on this payment, reject.
      if (currentRefundedOnPayment >= paymentAmount) {
        throw new BadRequestException(
          `Payment ${paymentId} is already fully refunded. Cannot apply additional refund.`,
        );
      }
      if (refundAmount > paymentRemaining + 0.0001) {
        // 0.0001 tolerance to absorb floating-point noise on dollar comparisons.
        throw new BadRequestException(
          `Refund amount ${refundAmount} exceeds remaining refundable ` +
            `amount ${paymentRemaining} for payment ${paymentId}`,
        );
      }

      // Create or update the refund row.
      let refundId: string;
      if (refundRecord.existingRefundId) {
        const updated = await client.refunds.update({
          where: { id: refundRecord.existingRefundId },
          data: {
            status: 'succeeded',
            processed_at: new Date(),
            updated_at: new Date(),
          },
        });
        refundId = updated.id;
      } else {
        const created = await client.refunds.create({
          data: {
            id: crypto.randomUUID(),
            invoice_payment_id: paymentId,
            amount: String(refundAmount) as any,
            currency: refundRecord.currency ?? 'USD',
            reason: refundRecord.reason ?? null,
            status: 'succeeded',
            provider_refund_id: refundRecord.provider_refund_id ?? null,
            refunded_by: refundRecord.refunded_by ?? null,
            processed_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
        refundId = created.id;
      }

      // Per-payment refund status. `none` → `partial` → `full` as the cumulative
      // refunded_amount on this payment grows.
      const newRefundedOnPayment = currentRefundedOnPayment + refundAmount;
      let paymentRefundStatus: 'none' | 'partial' | 'full' = 'none';
      if (newRefundedOnPayment >= paymentAmount - 0.0001) {
        paymentRefundStatus = 'full';
      } else if (newRefundedOnPayment > 0) {
        paymentRefundStatus = 'partial';
      }

      await client.invoice_payments.update({
        where: { id: paymentId },
        data: {
          refunded_amount: String(newRefundedOnPayment) as any,
          refund_status: paymentRefundStatus as any,
          updatedAt: new Date(),
        },
      });

      // Declarative invoice-level state machine. We need to know whether this
      // was the ONLY payment on the invoice (for the 'refunded' status flip)
      // or one of several (in which case status stays and only amounts update).
      const invoice = payment.invoices;
      const invoiceTotal = Number(invoice.totalAmount ?? 0);
      const currentInvoiceAmountPaid = Number(invoice.amountPaid ?? 0);
      const newInvoiceAmountPaid = Math.max(0, currentInvoiceAmountPaid - refundAmount);
      const newInvoiceAmountDue = Math.max(0, invoiceTotal - newInvoiceAmountPaid);

      // Count OTHER payments on this invoice that are not fully refunded.
      // (Fully-refunded-other payments contribute 0 to amountPaid, same as no
      // payment. Partial-refund or unrefunded contribute the net.)
      const otherPaymentsActive = await client.invoice_payments.findMany({
        where: {
          invoiceId: invoice.id,
          id: { not: paymentId },
          status: { notIn: ['failed', 'pending'] as any },
        },
        select: { amount: true, refunded_amount: true },
      });
      const otherPaymentsNetContribution = otherPaymentsActive.reduce(
        (sum, p) => sum + Math.max(0, Number(p.amount ?? 0) - Number(p.refunded_amount ?? 0)),
        0,
      );

      let newInvoiceStatus = invoice.status;
      // Whole-invoice refund rule: refunded amount on THIS payment equals the
      // original payment, AND no other payments contribute net revenue to the
      // invoice. Under those conditions the invoice is fully refunded.
      const thisPaymentFullyRefunded =
        paymentRefundStatus === 'full' && Math.abs(refundAmount - paymentAmount) < 0.0001;
      if (thisPaymentFullyRefunded && otherPaymentsNetContribution <= 0.0001) {
        newInvoiceStatus = 'refunded' as typeof invoice.status;
      }
      // Else: invoice status stays. Partial refunds don't change invoice status
      // per canon I2.

      await client.invoices.update({
        where: { id: invoice.id },
        data: {
          amountPaid: String(newInvoiceAmountPaid) as any,
          amountDue: String(newInvoiceAmountDue) as any,
          status: newInvoiceStatus as any,
          updatedAt: new Date(),
        },
      });

      return {
        refundId,
        newStatus: String(newInvoiceStatus),
        newAmountPaid: newInvoiceAmountPaid,
        newAmountDue: newInvoiceAmountDue,
        paymentRefundStatus,
      };
    };

    const client = this.prisma.getClient();
    let result: FinalizeRefundResult;
    if (tx) {
      result = await run(tx);
    } else {
      result = await client.$transaction(async (innerTx) => run(innerTx));
    }

    // Post-write advisory verification. Same shape as Reconciler. Confirm
    // the canonical invoice totals still compute cleanly for this org.
    try {
      const payment = await this.prisma.invoice_payments.findUnique({
        where: { id: paymentId },
        include: { invoices: { select: { organizationId: true, invoiceDate: true } } },
      });
      if (payment?.invoices) {
        const window = {
          start: new Date(payment.invoices.invoiceDate.getTime() - 1),
          end: new Date(payment.invoices.invoiceDate.getTime() + 1),
        };
        await this.revenueMetrics.getInvoiceTotals(payment.invoices.organizationId, window);
      }
    } catch (err) {
      this.logger.debug(
        `Post-refund canonical verification skipped for payment ${paymentId}: ${(err as Error).message}`,
      );
    }

    return result;
  }
}
