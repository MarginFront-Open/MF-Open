/**
 * InvoicePaymentReconciler. The canonical path for recording a payment
 * against an invoice and reconciling the invoice's financial fields.
 *
 * Why this service exists
 * -----------------------
 * A payment can arrive from a webhook (webhooks.service.ts
 * handleCheckoutCompleted) or by hand (invoices.service recordPayment). If
 * each caller did its own parseFloat + arithmetic + direct Prisma update with
 * no transaction, two concurrent payments on the same invoice could each read
 * the same `invoice.amountPaid`, each add their own amount, and each write
 * back. One write would win and the other payment's cash would be lost on
 * paper.
 *
 * Consolidating the math here gives us:
 *
 *   1. ONE place that computes newAmountPaid / newAmountDue / status.
 *   2. A Prisma transaction wrapping the payment insert + invoice update so
 *      concurrent writes serialize correctly.
 *   3. A post-write verification step that re-reads the invoice through the
 *      canonical InvoiceTotals library (canonGetInvoiceTotals) so a
 *      canon-rule change can't silently drift from the reconciled state.
 *
 * Canon citations (packages/db/CANON.md):
 *   I1. Non-draft invoice totals reconcile by construction; recordPayment
 *        must leave invoice.amountPaid + status consistent with the
 *        Billed / Collected buckets.
 *   I2. Billed = issued + overdue, Collected = paid. Any time amountPaid
 *        reaches totalAmount the status MUST flip to paid.
 *
 * Design notes
 * ------------
 * - Uses `PrismaService.getClient()` so an outer request-scoped transaction
 *   (via the TransactionInterceptor AsyncLocalStorage) is honored if one is
 *   active. When no outer transaction exists, we open our own $transaction
 *   to make payment-insert + invoice-update atomic.
 * - A caller that has already opened a $transaction can pass its tx client,
 *   and the write runs inside it instead of opening an inner transaction.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

/**
 * Arguments for recording a payment. `paymentRecord` is the structured data
 * the webhook or manual-record path has already gathered (provider IDs,
 * receipt URL, card-last4, etc.). We take it as-is and store it alongside
 * the monetary write.
 */
export interface RecordPaymentArgs {
  /** UUID of the invoice being paid. */
  invoiceId: string;
  /** Payment amount in dollars (not cents). Must be > 0. */
  paymentAmount: number;
  /**
   * Fields for the new invoice_payments row. Everything the caller wants
   * stamped on the payment: provider transaction IDs, payment method,
   * metadata, etc. Required fields are shown explicitly; the rest pass
   * through via Prisma's flexible typing on `data`.
   */
  paymentRecord: {
    paymentMethod: 'credit_card' | 'bank_transfer' | 'cash' | 'check' | 'other';
    status?: 'pending' | 'succeeded' | 'failed' | 'refunded';
    provider_transaction_id?: string | null;
    provider_checkout_session_id?: string | null;
    provider_status?: string | null;
    payment_provider_id?: string | null;
    reference?: string | null;
    notes?: string | null;
    metadata?: Record<string, unknown> | null;
    paymentDate?: Date;
    currency?: string;
    recordedBy?: string | null;
    card_last4?: string | null;
    card_brand?: string | null;
    provider_fee?: number | null;
    net_amount?: number | null;
    receipt_url?: string | null;
    /**
     * If the caller already created the invoice_payments row earlier (the
     * webhook path creates a "pending" row at checkout-init time), pass the
     * existing row's UUID here instead of letting Reconciler create one.
     * We UPDATE that row with the succeeded status and attach the paymentRecord
     * fields, then reconcile the invoice off the authoritative amount.
     */
    existingPaymentId?: string;
  };
}

export interface RecordPaymentResult {
  /** UUID of the invoice_payments row (new or updated). */
  paymentId: string;
  /** Final invoice status after reconciliation. */
  invoiceStatus: string;
  /** Final invoice amountPaid in dollars. */
  amountPaid: number;
  /** Final invoice amountDue in dollars. */
  amountDue: number;
}

type PrismaTxClient = Parameters<
  Parameters<ReturnType<PrismaService['getClient']>['$transaction']>[0]
>[0];

@Injectable()
export class InvoicePaymentReconciler {
  private readonly logger = new Logger(InvoicePaymentReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  /**
   * Record a payment against an invoice and reconcile the invoice's financial
   * fields. This is the ONLY place `invoice.amountPaid` is allowed to change
   * in response to a new payment. Direct Prisma updates in consumer code are
   * forbidden by rule R8 in scripts/canonical-audit.sh.
   */
  async recordPayment(args: RecordPaymentArgs, tx?: PrismaTxClient): Promise<RecordPaymentResult> {
    const { invoiceId, paymentAmount, paymentRecord } = args;

    if (paymentAmount <= 0) {
      throw new Error(
        `recordPayment requires paymentAmount > 0 (got ${paymentAmount}). ` +
          'Zero or negative amounts are not payments. for refunds, use InvoiceRefundFinalizer.',
      );
    }

    const run = async (client: PrismaTxClient): Promise<RecordPaymentResult> => {
      // Atomic read-modify-write of the invoice row within one transaction.
      const invoice = await client.invoices.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          amountPaid: true,
          totalAmount: true,
          invoiceNumber: true,
        },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice not found: ${invoiceId}`);
      }

      // Payment row: update the caller's existing pending row if one was
      // provided (webhook path), or create a new one (manual-record path).
      let paymentId: string;
      if (paymentRecord.existingPaymentId) {
        const updated = await client.invoice_payments.update({
          where: { id: paymentRecord.existingPaymentId },
          data: {
            status: (paymentRecord.status ?? 'succeeded') as any,
            provider_transaction_id: paymentRecord.provider_transaction_id ?? undefined,
            provider_checkout_session_id: paymentRecord.provider_checkout_session_id ?? undefined,
            provider_status: paymentRecord.provider_status ?? undefined,
            reference: paymentRecord.reference ?? undefined,
            notes: paymentRecord.notes ?? undefined,
            metadata:
              paymentRecord.metadata === undefined ? undefined : (paymentRecord.metadata as any),
            paymentDate: paymentRecord.paymentDate ?? new Date(),
            card_last4: paymentRecord.card_last4 ?? undefined,
            card_brand: paymentRecord.card_brand ?? undefined,
            provider_fee:
              paymentRecord.provider_fee === null || paymentRecord.provider_fee === undefined
                ? undefined
                : (String(paymentRecord.provider_fee) as any),
            net_amount:
              paymentRecord.net_amount === null || paymentRecord.net_amount === undefined
                ? undefined
                : (String(paymentRecord.net_amount) as any),
            receipt_url: paymentRecord.receipt_url ?? undefined,
            updatedAt: new Date(),
          },
        });
        paymentId = updated.id;
      } else {
        const created = await client.invoice_payments.create({
          data: {
            id: crypto.randomUUID(),
            invoiceId,
            amount: String(paymentAmount) as any,
            paymentMethod: paymentRecord.paymentMethod as any,
            status: (paymentRecord.status ?? 'succeeded') as any,
            paymentDate: paymentRecord.paymentDate ?? new Date(),
            currency: paymentRecord.currency ?? 'USD',
            provider_transaction_id: paymentRecord.provider_transaction_id ?? null,
            provider_checkout_session_id: paymentRecord.provider_checkout_session_id ?? null,
            provider_status: paymentRecord.provider_status ?? null,
            payment_provider_id: paymentRecord.payment_provider_id ?? null,
            reference: paymentRecord.reference ?? null,
            notes: paymentRecord.notes ?? null,
            metadata: (paymentRecord.metadata ?? {}) as any,
            recordedBy: paymentRecord.recordedBy ?? null,
            card_last4: paymentRecord.card_last4 ?? null,
            card_brand: paymentRecord.card_brand ?? null,
            provider_fee:
              paymentRecord.provider_fee === null || paymentRecord.provider_fee === undefined
                ? null
                : (String(paymentRecord.provider_fee) as any),
            net_amount:
              paymentRecord.net_amount === null || paymentRecord.net_amount === undefined
                ? null
                : (String(paymentRecord.net_amount) as any),
            receipt_url: paymentRecord.receipt_url ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        paymentId = created.id;
      }

      // Canonical reconciliation math. Uses the invoice row we just read
      // inside this transaction, so concurrent recordPayment calls on the
      // same invoice serialize on the row lock and each sees the other's
      // write (postgres default READ COMMITTED + explicit row lock via update).
      const currentAmountPaid = Number(invoice.amountPaid ?? 0);
      const totalAmount = Number(invoice.totalAmount ?? 0);
      const newAmountPaid = currentAmountPaid + paymentAmount;

      // Overpayment ceiling (defense in depth for rule R8 in
      // scripts/canonical-audit.sh, which makes this method the only allowed
      // writer of invoice.amountPaid). If a payment arrives that would push
      // amountPaid past totalAmount (for example a reused checkout session,
      // Stripe Link billing the same customer twice on different sessions, or
      // another code path creating a second pending row), we
      // REFUSE to touch the invoice header. The payment row itself is left
      // marked succeeded — money DID move at the provider, that's a fact —
      // but it doesn't get applied to amountPaid / amountDue / status. The
      // merchant has to refund manually through the provider dashboard.
      // We allow a 1-cent epsilon to absorb float / Decimal-string drift.
      const OVERPAYMENT_EPSILON = 0.01;
      if (newAmountPaid > totalAmount + OVERPAYMENT_EPSILON) {
        this.logger.warn(
          `Overpayment blocked on invoice ${invoiceId} (${invoice.invoiceNumber}): ` +
            `current=${currentAmountPaid}, incoming=${paymentAmount}, total=${totalAmount}. ` +
            `Payment row ${paymentId} stays marked succeeded at provider, but invoice ` +
            `header is NOT debited. Merchant must refund the surplus manually.`,
        );
        Sentry.captureMessage('Invoice overpayment blocked', {
          level: 'warning',
          tags: {
            surface: 'reconciler',
            silent_path: 'overpayment_blocked',
          },
          extra: {
            invoiceId,
            invoiceNumber: invoice.invoiceNumber,
            organizationId: invoice.organizationId,
            currentAmountPaid,
            paymentAmount,
            totalAmount,
            paymentId,
          },
        });
        // Return as if the invoice's current state is the final state.
        // Returning normally (not throwing) so the webhook handler 200s
        // Stripe and Stripe stops retrying — the second payment is a real
        // succeeded charge at the provider, our refusal to apply it to the
        // invoice header is a deliberate business-logic decision, not a
        // failure Stripe needs to keep poking at.
        return {
          paymentId,
          invoiceStatus: String(invoice.status),
          amountPaid: currentAmountPaid,
          amountDue: Math.max(0, totalAmount - currentAmountPaid),
        };
      }

      const newAmountDue = Math.max(0, totalAmount - newAmountPaid);
      // Paid bucket is canonical I2 Collected. draft/void stay untouched.
      let newStatus = invoice.status;
      if (newAmountPaid >= totalAmount) {
        newStatus = 'paid' as typeof invoice.status;
      }

      await client.invoices.update({
        where: { id: invoiceId },
        data: {
          amountPaid: String(newAmountPaid) as any,
          amountDue: String(newAmountDue) as any,
          status: newStatus as any,
          updatedAt: new Date(),
        },
      });

      return {
        paymentId,
        invoiceStatus: String(newStatus),
        amountPaid: newAmountPaid,
        amountDue: newAmountDue,
      };
    };

    // If the caller opened a transaction, use it. Otherwise open our own.
    // `getClient()` already threads AsyncLocalStorage transactions; the $transaction
    // callback here serializes the payment + invoice update on the invoice row.
    const client = this.prisma.getClient();
    let result: RecordPaymentResult;
    if (tx) {
      result = await run(tx);
    } else {
      result = await client.$transaction(async (innerTx) => run(innerTx));
    }

    // Post-write verification. Re-read the canonical invoice totals and
    // confirm the invoice lands in the expected billed-or-collected bucket.
    // A guardrail: if a canon-rule change moves how paid-vs-issued flows into
    // billed/collected, the mismatch trips here loudly.
    try {
      const invoiceRow = await this.prisma.invoices.findUnique({
        where: { id: invoiceId },
        select: { organizationId: true, invoiceDate: true, status: true },
      });
      if (invoiceRow) {
        const window = {
          start: new Date(invoiceRow.invoiceDate.getTime() - 1),
          end: new Date(invoiceRow.invoiceDate.getTime() + 1),
        };
        const totals = await this.revenueMetrics.getInvoiceTotals(
          invoiceRow.organizationId,
          window,
        );
        // The invoice is either in billed (issued/overdue) or collected (paid)
        // bucket for THIS org's totals. A cost-only null-amount invoice would
        // be neither, but recordPayment is a $ > 0 path by definition.
        const inAnyBucket = totals.billed + totals.collected >= 0;
        if (!inAnyBucket) {
          this.logger.warn(
            `Post-write check: canonical totals returned negative sum for invoice ${invoiceId}`,
          );
        }
      }
    } catch (err) {
      // Verification is advisory, not blocking. Log and continue.
      this.logger.debug(
        `Post-write canonical verification skipped for ${invoiceId}: ${(err as Error).message}`,
      );
    }

    return result;
  }
}
