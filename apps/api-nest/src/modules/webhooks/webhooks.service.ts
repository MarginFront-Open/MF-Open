import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { PaymentAdapterFactory } from '../payment-providers/payment-adapter.factory';
import { InvoicePaymentReconciler } from '../invoices/invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from '../invoices/invoice-refund-finalizer.service';
import { WebhookDedupeService } from './webhook-dedupe.service';
import { resolveOrgBillingContactEmail } from '../../common/utils/billing-contact/billing-contact.utils';
import {
  CheckoutCompletedData,
  PaymentFailedData,
  RefundCompletedData,
} from '../payment-providers/interfaces';

/**
 * Handles incoming Stripe payment webhooks.
 *
 * 1. A webhook arrives with a raw body and signature
 * 2. We find the organization's Stripe connection, or fall back to the
 *    platform keys when the address names no organization
 * 3. The adapter verifies the signature and normalizes the event
 * 4. We route to a handler based on the normalized event type
 * 5. The handler updates the invoice_payments and invoices tables
 *
 * The handlers work with the normalized shapes in payment-adapter.interface.ts,
 * not with Stripe payloads.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly adapterFactory: PaymentAdapterFactory,
    private readonly paymentReconciler: InvoicePaymentReconciler,
    private readonly refundFinalizer: InvoiceRefundFinalizer,
    private readonly webhookDedupe: WebhookDedupeService,
  ) {}

  /**
   * Handle an incoming Stripe webhook. With an organization ID the message is
   * verified with that organization's own Stripe connection; without one, or
   * when that organization has no active connection, with the platform keys.
   */
  async handleStripeWebhook(rawBody: Buffer, signature: string, organizationId?: string) {
    const provider = await this.findStripeProvider(organizationId);

    if (!provider) {
      return this.handleStripeWebhookFallback(rawBody, signature);
    }

    const adapter = this.adapterFactory.createAdapter(provider);
    const providerType = adapter.providerType;

    // Verify the webhook signature and parse the event
    let event;
    try {
      event = await adapter.verifyWebhook(rawBody, signature);
    } catch (err) {
      this.logger.error(`${providerType} webhook signature verification failed: ${err.message}`);
      Sentry.captureException(err, {
        tags: {
          surface: 'webhook',
          provider: providerType,
          silent_path: 'signature_verification_failed',
        },
      });
      throw new BadRequestException(`Webhook verification failed: ${err.message}`);
    }

    // In-flight dedupe. The DB-layer createWebhookRecord below catches stale
    // retries, where attempt 1 already finished. It does NOT catch in-flight
    // overlap, where attempt 1 is still processing when attempt 2 arrives 50ms
    // later. This Redis SET NX with a 30s TTL closes that window without
    // poisoning failed-attempt retries (the TTL is shorter than Stripe's
    // retry cadence, so a real retry after a failure still gets through).
    const claimed = await this.webhookDedupe.claim(providerType, event.eventId);
    if (!claimed) {
      this.logger.log(`In-flight ${providerType} webhook dedupe-skipped: ${event.eventId}`);
      return { received: true, duplicate: true };
    }

    // Check for duplicate events (prevents processing the same webhook twice)
    const { webhook, isDuplicate } = await this.createWebhookRecord(
      event.eventId,
      providerType,
      event.rawEventType,
      rawBody,
      signature,
      organizationId,
    );

    if (isDuplicate) {
      this.logger.log(`Duplicate ${providerType} webhook ignored: ${event.eventId}`);
      return { received: true, duplicate: true };
    }

    // Process the event based on its normalized type
    try {
      await this.updateWebhookStatus(webhook.id, 'processing');

      switch (event.eventType) {
        case 'checkout.completed': {
          const data = await adapter.extractCheckoutCompleted(event.payload);
          await this.handleCheckoutCompleted(data, providerType, provider.organization_id);
          break;
        }

        case 'payment.failed': {
          const data = await adapter.extractPaymentFailed(event.payload);
          await this.handlePaymentFailed(data, providerType, provider.organization_id);
          break;
        }

        // Stripe sends refund.created when the refund first lands and
        // refund.updated on status changes. Both route to the same
        // status-aware handler.
        case 'refund.created':
        case 'refund.updated': {
          const refundData = await adapter.extractRefundCompleted(event.payload);
          await this.handleRefundCompleted(refundData, providerType, provider.organization_id);
          break;
        }

        case 'ignored':
          this.logger.log(`Ignored ${providerType} event type: ${event.rawEventType}`);
      }

      await this.updateWebhookStatus(webhook.id, 'succeeded');
    } catch (error) {
      this.logger.error(`${providerType} webhook processing error: ${error.message}`, error.stack);
      await this.updateWebhookStatus(webhook.id, 'failed', error.message);
      throw error;
    }

    return { received: true };
  }

  /**
   * Stripe webhooks with no organization-specific connection. Verified with
   * the platform STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET env vars.
   */
  private async handleStripeWebhookFallback(rawBody: Buffer, signature: string) {
    const globalKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const globalWebhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');

    if (!globalKey) {
      throw new BadRequestException(
        'No Stripe payment provider found and no global STRIPE_SECRET_KEY configured',
      );
    }

    const adapter = this.adapterFactory.createPlatformStripeAdapter({
      secretKey: globalKey,
      webhookSecret: globalWebhookSecret || '',
    });

    let event;
    try {
      event = await adapter.verifyWebhook(rawBody, signature);
    } catch (err) {
      this.logger.error(`Stripe webhook signature verification failed (global): ${err.message}`);
      Sentry.captureException(err, {
        tags: {
          surface: 'webhook',
          provider: 'stripe',
          silent_path: 'signature_verification_failed_fallback',
        },
      });
      throw new BadRequestException(`Webhook verification failed: ${err.message}`);
    }

    // In-flight dedupe, same purpose as in handleStripeWebhook above.
    const claimed = await this.webhookDedupe.claim('stripe', event.eventId);
    if (!claimed) {
      this.logger.log(`In-flight stripe webhook dedupe-skipped (fallback): ${event.eventId}`);
      return { received: true, duplicate: true };
    }

    const { webhook, isDuplicate } = await this.createWebhookRecord(
      event.eventId,
      'stripe',
      event.rawEventType,
      rawBody,
      signature,
      undefined,
    );

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    try {
      await this.updateWebhookStatus(webhook.id, 'processing');

      if (event.eventType === 'checkout.completed') {
        const data = await adapter.extractCheckoutCompleted(event.payload);
        await this.handleCheckoutCompleted(data, 'stripe');
      } else if (event.eventType === 'payment.failed') {
        const data = await adapter.extractPaymentFailed(event.payload);
        await this.handlePaymentFailed(data, 'stripe');
      } else if (event.eventType === 'refund.created' || event.eventType === 'refund.updated') {
        const refundData = await adapter.extractRefundCompleted(event.payload);
        await this.handleRefundCompleted(refundData, 'stripe');
      } else {
        this.logger.log(`Ignored Stripe event (global): ${event.rawEventType}`);
      }

      await this.updateWebhookStatus(webhook.id, 'succeeded');
    } catch (error) {
      await this.updateWebhookStatus(webhook.id, 'failed', error.message);
      throw error;
    }

    return { received: true };
  }

  // ─── Provider-Agnostic Event Handlers ──────────────────────────────
  // These work with standardized data. They don't know which provider sent it

  /**
   * Handle a successful checkout/payment completion.
   *
   * Flow:
   *   1. Find the pending invoice_payments row created at checkout init.
   *   2. Delegate the status flip + invoice-amount reconciliation to the
   *      canonical InvoicePaymentReconciler (transactional, race-safe).
   *   3. Send the receipt email.
   *
   * This handler does no parseFloat arithmetic on invoice rows. All monetary
   * math lives inside InvoicePaymentReconciler, per rule R8 in
   * scripts/canonical-audit.sh.
   */
  private async handleCheckoutCompleted(
    data: CheckoutCompletedData,
    providerType: string,
    verifiedOrganizationId?: string,
  ) {
    if (!data.invoiceId) {
      this.logger.warn(`${providerType} checkout completed without invoice ID`);
      Sentry.captureException(
        new Error(`Webhook silent path: ${providerType} checkout completed without invoice ID`),
        {
          tags: {
            surface: 'webhook',
            provider: providerType,
            event_type: 'checkout.completed',
            silent_path: 'missing_invoice_id',
          },
          extra: {
            checkoutSessionId: data.checkoutSessionId,
            providerTransactionId: data.providerTransactionId,
          },
        },
      );
      return;
    }

    // Find the pending payment by checkout session ID
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_checkout_session_id: data.checkoutSessionId },
    });

    if (!payment) {
      this.logger.warn(
        `No payment found for ${providerType} checkout session: ${data.checkoutSessionId}`,
      );
      Sentry.captureException(
        new Error(
          `Webhook silent path: no payment row matches ${providerType} checkout session ${data.checkoutSessionId}`,
        ),
        {
          tags: {
            surface: 'webhook',
            provider: providerType,
            event_type: 'checkout.completed',
            silent_path: 'no_payment_for_session',
          },
          extra: {
            checkoutSessionId: data.checkoutSessionId,
            invoiceId: data.invoiceId,
            providerTransactionId: data.providerTransactionId,
          },
        },
      );
      return;
    }

    if (
      !(await this.belongsToVerifiedOrganization({
        invoiceIds: [data.invoiceId, payment.invoiceId],
        verifiedOrganizationId,
        providerType,
        eventType: 'checkout.completed',
      }))
    ) {
      return;
    }

    const paymentAmount = Number(payment.amount ?? 0);

    // Canonical reconciliation: updates the existing payment row + the invoice
    // financial fields in one transaction, reads the canonical totals for
    // post-write verification, logs on drift.
    await this.paymentReconciler.recordPayment({
      invoiceId: data.invoiceId,
      paymentAmount,
      paymentRecord: {
        existingPaymentId: payment.id,
        paymentMethod: 'credit_card',
        status: 'succeeded',
        provider_transaction_id: data.providerTransactionId,
        provider_status: data.paymentStatus,
        reference: `${providerType}: ${data.providerTransactionId}`,
        metadata: {
          // payment.metadata is Prisma JsonValue (scalar | array | object).
          // Spread only when it's a plain object; otherwise start fresh.
          ...(payment.metadata &&
          typeof payment.metadata === 'object' &&
          !Array.isArray(payment.metadata)
            ? (payment.metadata as Record<string, unknown>)
            : {}),
          cardLast4: data.cardLast4,
          cardBrand: data.cardBrand,
          receiptUrl: data.receiptUrl,
          providerFee: data.fee ? String(data.fee) : null,
          netAmount: data.netAmount ? String(data.netAmount) : null,
        },
      },
    });

    // Re-read the invoice with customer + organization relations for the
    // receipt email. The Reconciler returns the reconciled amounts but not
    // the full invoice row with relations, so a read here is cheaper than
    // changing the Reconciler contract.
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: data.invoiceId },
      include: { customers: true, organizations: true },
    });

    if (invoice) {
      this.logger.log(
        `Invoice ${invoice.invoiceNumber} paid via ${providerType}. Amount: ${payment.amount}`,
      );

      // Send payment receipt email
      try {
        await this.sendPaymentReceipt(payment, invoice);
      } catch (receiptError) {
        this.logger.error(`Failed to send payment receipt: ${receiptError.message}`);
      }
    }
  }

  /**
   * Handle a failed payment.
   */
  private async handlePaymentFailed(
    data: PaymentFailedData,
    providerType: string,
    verifiedOrganizationId?: string,
  ) {
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_transaction_id: data.providerTransactionId },
    });

    if (!payment) {
      this.logger.warn(`No payment found for transaction: ${data.providerTransactionId}`);
      Sentry.captureException(
        new Error(
          `Webhook silent path: no payment row matches transaction ${data.providerTransactionId}`,
        ),
        {
          tags: {
            surface: 'webhook',
            event_type: 'payment.failed',
            silent_path: 'no_payment_for_transaction',
          },
          extra: {
            providerTransactionId: data.providerTransactionId,
            providerStatus: data.providerStatus,
          },
        },
      );
      return;
    }

    if (
      !(await this.belongsToVerifiedOrganization({
        invoiceIds: [payment.invoiceId],
        verifiedOrganizationId,
        providerType,
        eventType: 'payment.failed',
      }))
    ) {
      return;
    }

    await this.prisma.invoice_payments.update({
      where: { id: payment.id },
      data: {
        status: 'failed' as any,
        provider_status: data.providerStatus,
        error_code: data.errorCode || null,
        error_message: data.errorMessage || null,
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Payment failed for transaction: ${data.providerTransactionId}`);
  }

  /**
   * Handle a refund webhook from any provider. Status-aware dispatch:
   *
   *   pending   → record the refunds row (so we have an id to update later)
   *               but do NOT finalize. invoice_payments.refunded_amount is
   *               untouched, so collected revenue does not move yet.
   *               (Stripe refund.created on ACH-funded refunds; rare on cards.)
   *
   *   succeeded → run InvoiceRefundFinalizer. This is the happy path —
   *               creates the refunds row if missing, propagates to
   *               invoice_payments.refunded_amount + invoices.amountPaid +
   *               invoice status. Stripe sends it on refund.created (cards, instant) or
   *               refund.updated (the second event after a pending refund
   *               clears).
   *
   *   failed /  → mark the refunds row failed (if present) and bail.
   *   canceled    invoice_payments stays where it was — a failed refund
   *               never returned money to the customer, so collected should
   *               not get debited. (Stripe refund.updated when the issuer
   *               declines the refund.)
   *
   * Two creation paths converge here:
   *   1. We initiated via the createRefund endpoint — a refunds row with
   *      provider_refund_id already exists. We update it in place.
   *   2. Refund was initiated outside our system (e.g., directly from the
   *      Stripe Dashboard) — no refunds row exists yet. The Finalizer
   *      creates one when status=succeeded; the pending branch creates it
   *      directly.
   *
   * All per-payment + per-invoice refund math goes through
   * InvoiceRefundFinalizer (rule R8 in scripts/canonical-audit.sh). The
   * handler only routes.
   */
  private async handleRefundCompleted(
    data: RefundCompletedData,
    providerType: string,
    verifiedOrganizationId?: string,
  ) {
    this.logger.log(
      `Processing ${providerType} refund webhook: refundId=${data.providerRefundId}, ` +
        `transactionId=${data.providerTransactionId}, amount=${data.amount}, status=${data.status}`,
    );

    // Find an existing refund record (we created it when the user hit "Refund"
    // in our dashboard, OR when an earlier pending event landed for the same
    // refund id).
    const refundRecord = await this.prisma.refunds.findFirst({
      where: { provider_refund_id: data.providerRefundId },
    });

    // Find the original payment this refund applies to.
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_transaction_id: data.providerTransactionId },
    });

    if (!payment) {
      // We can't find the payment this refund is for. Log it but don't crash.
      // This can happen if the payment was made outside our system entirely.
      this.logger.warn(
        `${providerType} refund webhook received for unknown payment: ${data.providerTransactionId}. ` +
          'No matching invoice_payments record found. skipping.',
      );
      Sentry.captureMessage(
        `Webhook silent path: ${providerType} refund for unknown payment ${data.providerTransactionId}`,
        {
          level: 'warning',
          tags: {
            surface: 'webhook',
            provider: providerType,
            event_type: 'refund',
            silent_path: 'refund_unknown_payment',
          },
          extra: {
            providerRefundId: data.providerRefundId,
            providerTransactionId: data.providerTransactionId,
            amount: data.amount,
            status: data.status,
          },
        },
      );
      return;
    }

    const refundedPayment =
      refundRecord && refundRecord.invoice_payment_id !== payment.id
        ? await this.prisma.invoice_payments.findUnique({
            where: { id: refundRecord.invoice_payment_id },
          })
        : null;
    if (
      !(await this.belongsToVerifiedOrganization({
        invoiceIds: [payment.invoiceId, ...(refundedPayment ? [refundedPayment.invoiceId] : [])],
        verifiedOrganizationId,
        providerType,
        eventType: 'refund',
      }))
    ) {
      return;
    }

    // Pending refund (Stripe refund.created on ACH-funded refunds). Record
    // the row so we have something to update when refund.updated arrives,
    // but do NOT propagate to invoice_payments.refunded_amount — the
    // customer has not gotten their money back yet.
    if (data.status === 'pending') {
      if (refundRecord) {
        this.logger.log(`Pending refund ${data.providerRefundId} already recorded; nothing to do`);
        return;
      }

      await this.prisma.refunds.create({
        data: {
          id: this.generateUuid(),
          invoice_payment_id: payment.id,
          amount: data.amount,
          currency: data.currency?.toUpperCase() || 'USD',
          status: 'pending',
          provider_refund_id: data.providerRefundId,
          reason: data.reason || `Refund initiated via ${providerType}`,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      this.logger.log(
        `Recorded pending refund ${data.providerRefundId} for payment ${payment.id} ` +
          '(awaiting refund.updated to finalize)',
      );
      return;
    }

    // Failed / canceled refund (Stripe refund.updated when the issuer
    // declines, or the merchant cancels in the Stripe Dashboard). Mark the
    // row failed so the dashboard surfaces the truth, but do NOT touch
    // invoice_payments — no money was actually returned.
    if (data.status === 'failed' || data.status === 'canceled') {
      if (refundRecord) {
        await this.prisma.refunds.update({
          where: { id: refundRecord.id },
          data: {
            status: data.status === 'canceled' ? 'failed' : 'failed',
            updated_at: new Date(),
            processed_at: new Date(),
          },
        });
        this.logger.log(
          `Marked refund ${data.providerRefundId} ${data.status}; no invoice propagation`,
        );
      } else {
        this.logger.warn(
          `${providerType} refund ${data.providerRefundId} arrived with status=${data.status} ` +
            'but no matching refunds row exists. Logging without propagation.',
        );
      }
      return;
    }

    if (!refundRecord) {
      this.logger.log(
        `Refund ${data.providerRefundId} was initiated outside MarginFront. Finalizer will create record`,
      );
    }

    const result = await this.refundFinalizer.finalizeRefund({
      paymentId: payment.id,
      refundAmount: data.amount,
      refundRecord: {
        existingRefundId: refundRecord?.id,
        reason: data.reason || `Refund initiated via ${providerType}`,
        provider_refund_id: data.providerRefundId,
        currency: data.currency?.toUpperCase() || 'USD',
      },
    });

    this.logger.log(
      `Invoice updated after ${providerType} refund: ` +
        `amountPaid=${result.newAmountPaid}, amountDue=${result.newAmountDue}, ` +
        `status=${result.newStatus}, paymentRefundStatus=${result.paymentRefundStatus}`,
    );
  }

  // ─── Utility Methods ───────────────────────────────────────────────

  /**
   * A webhook's signature is checked with one organization's own secret, and any
   * organization can choose its secret. So a verified message may only touch
   * invoices that organization owns; otherwise a payer could sign a "paid"
   * message with their own secret and name someone else's invoice.
   *
   * No verified organization means the message was verified with the operator's
   * global Stripe secret, which only the operator holds, so nothing is compared.
   */
  private async belongsToVerifiedOrganization({
    invoiceIds,
    verifiedOrganizationId,
    providerType,
    eventType,
  }: {
    invoiceIds: string[];
    verifiedOrganizationId: string | undefined;
    providerType: string;
    eventType: string;
  }): Promise<boolean> {
    if (!verifiedOrganizationId) return true;

    for (const invoiceId of new Set(invoiceIds)) {
      const invoice = await this.prisma.invoices.findUnique({ where: { id: invoiceId } });
      if (invoice?.organizationId === verifiedOrganizationId) continue;

      this.logger.warn(
        `${providerType} ${eventType} webhook refused: it was verified with organization ` +
          `${verifiedOrganizationId}'s secret but names invoice ${invoiceId}, which that ` +
          'organization does not own. Nothing was changed.',
      );
      Sentry.captureMessage(
        `Webhook refused: ${providerType} ${eventType} names an invoice outside the verified organization`,
        {
          level: 'warning',
          tags: {
            surface: 'webhook',
            provider: providerType,
            event_type: eventType,
            silent_path: 'cross_organization_invoice',
          },
          extra: { verifiedOrganizationId, invoiceId },
        },
      );
      return false;
    }
    return true;
  }

  private async findStripeProvider(organizationId?: string) {
    if (!organizationId) return null;

    return this.prisma.payment_providers.findFirst({
      where: {
        organization_id: organizationId,
        type: 'stripe',
        is_active: true,
      },
    });
  }

  /**
   * Send payment receipt email to customer.
   */
  private async sendPaymentReceipt(payment: any, invoice: any) {
    try {
      const customer = invoice.customers;
      const organization = invoice.organizations;

      if (!customer?.email) {
        this.logger.warn(`Cannot send receipt: no customer email for invoice ${invoice.id}`);
        return;
      }

      const sent = await this.emailService.sendPaymentReceiptEmail({
        to: customer.email,
        customerName: customer.name,
        invoiceNumber: invoice.invoiceNumber,
        amount: payment.amount,
        currency: invoice.currency || 'USD',
        paymentDate: payment.paymentDate || payment.createdAt,
        cardLast4: payment.cardLast4,
        cardBrand: payment.cardBrand,
        transactionId: payment.provider_transaction_id,
        invoiceTotal: invoice.totalAmount,
        amountDue: invoice.amountDue,
        receiptUrl: payment.receiptUrl,
        companyName: organization.name,
        companyEmail: resolveOrgBillingContactEmail(organization) ?? undefined,
      });

      if (sent === null) {
        this.logger.warn(
          `Payment receipt for invoice ${invoice.invoiceNumber} was not sent because email is turned off. ` +
            'Set RESEND_API_KEY and RESEND_FROM_EMAIL and restart to send receipts.',
        );
        return;
      }

      await this.prisma.invoice_payments.update({
        where: { id: payment.id },
        data: { receipt_email_sent: true },
      });

      this.logger.log(
        `Payment receipt sent for invoice ${invoice.invoiceNumber} to ${customer.email}`,
      );
    } catch (error) {
      this.logger.error(`Failed to send payment receipt: ${error.message}`);
    }
  }

  /**
   * Create webhook record for deduplication.
   *
   * Status-aware: only a row with status='succeeded' counts as a true
   * duplicate that should be silently skipped. A row with status='failed'
   * means a prior attempt threw mid-processing (e.g., we returned a 400 to
   * Stripe). Stripe retries on non-2xx responses, and those
   * retries MUST be allowed to reprocess. Otherwise a transient failure
   * permanently poisons the event id and the second attempt short-circuits
   * to `{ duplicate: true }` without ever invoking the handler.
   *
   * Rows in status='pending' or 'processing' from a still-in-flight or
   * crashed attempt are also allowed to reprocess — the state machine
   * already overwrites them when handling succeeds.
   */
  private async createWebhookRecord(
    eventId: string,
    source: string,
    eventType: string,
    rawBody: Buffer,
    signature: string,
    organizationId: string | undefined,
  ) {
    const existing = await this.prisma.inbound_webhooks.findFirst({
      where: {
        event_id: eventId,
        source: source as any,
      },
    });

    if (existing) {
      if (existing.status === 'succeeded') {
        return { webhook: existing, isDuplicate: true };
      }
      // Retry attempt of a previously failed / pending / processing event.
      // Reset the row to 'pending' and let the handler run again.
      const reset = await this.prisma.inbound_webhooks.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          error_message: null,
          updated_at: new Date(),
        },
      });
      return { webhook: reset, isDuplicate: false };
    }

    const webhook = await this.prisma.inbound_webhooks.create({
      data: {
        id: this.generateUuid(),
        organization_id: organizationId || null,
        source: source as any,
        event_type: eventType,
        event_id: eventId,
        payload: JSON.parse(rawBody.toString()),
        signature,
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { webhook, isDuplicate: false };
  }

  /**
   * Update webhook processing status.
   */
  private async updateWebhookStatus(webhookId: string, status: string, errorMessage?: string) {
    await this.prisma.inbound_webhooks.update({
      where: { id: webhookId },
      data: {
        status: status as any,
        ...(status === 'processing' && {
          processing_started_at: new Date(),
        }),
        ...(status === 'failed' && { error_message: errorMessage }),
        ...(status === 'succeeded' && { processed_at: new Date() }),
        updated_at: new Date(),
      },
    });
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
