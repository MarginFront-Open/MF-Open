import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { formatMinorUnits, fromMinorUnits, toMinorUnits } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requireFrontendUrl } from '../../common/config/app-config';
import { PaymentAdapterFactory } from './payment-adapter.factory';
import { buildCollectibleCharge, CollectibleCharge, formatCharge } from './collectible-charge';

/**
 * Payment Processing Service
 *
 * Handles payment operations (checkout, refunds, payment details). All
 * Stripe-specific work is delegated to the adapter created by
 * PaymentAdapterFactory.
 *
 * This service handles the "business logic" side:
 * - Looking up invoices and providers from the database
 * - Creating payment records
 * - Validating amounts and statuses
 *
 * The adapter handles the "talk to the provider's API" side.
 */
@Injectable()
export class PaymentProcessingService {
  private readonly logger = new Logger(PaymentProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly adapterFactory: PaymentAdapterFactory,
  ) {}

  /**
   * Find the organization's active payment provider, preferring the default.
   */
  private async getActiveProvider(organizationId: string) {
    const provider = await this.prisma.payment_providers.findFirst({
      where: {
        organization_id: organizationId,
        is_active: true,
      },
      orderBy: {
        is_default: 'desc', // Prefer the default provider
      },
    });

    if (!provider) {
      throw new NotFoundException(
        'No active payment provider found for this organization. ' +
          'Go to Settings > Integrations to connect Stripe.',
      );
    }

    return provider;
  }

  /**
   * Create a checkout session for an invoice.
   * The customer gets redirected to the Stripe Checkout page.
   */
  async createCheckoutSession(
    invoiceId: string,
    options: {
      successUrl?: string;
      cancelUrl?: string;
    } = {},
  ): Promise<{
    sessionId: string;
    url: string;
    expiresAt: string;
  }> {
    const { successUrl, cancelUrl } = options;

    // Get invoice with customer + organization + line items.
    // Line items are passed to the Stripe adapter so the customer sees the
    // breakdown on Checkout. Soft-deleted lines (deletedAt set) are left out.
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: invoiceId },
      include: {
        customers: true,
        organizations: true,
        invoice_line_items: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    if (!invoice.customers) {
      throw new BadRequestException('Invoice has no associated customer');
    }

    if (!invoice.organizations) {
      throw new BadRequestException('Invoice has no associated organization');
    }

    // Validate invoice is payable
    const amountDue = parseFloat(String(invoice.amountDue || '0'));

    if (amountDue <= 0 || invoice.status === 'paid') {
      throw new BadRequestException('Invoice is already paid');
    }

    // THE ONE DESCRIPTION OF THIS INVOICE'S MONEY. Everything a
    // provider is told about the amount comes from here and nowhere else — the
    // balance to collect, the rows to show, the currency's own minor unit. See
    // collectible-charge.ts for why an adapter is given no other numbers.
    const charge = buildCollectibleCharge({
      invoiceNumber: invoice.invoiceNumber,
      currency: invoice.currency || 'USD',
      totalAmount: invoice.totalAmount,
      // Charge what is still owed, so a part-paid invoice is not charged in
      // full: $60 wired against $100 leaves $40 to collect.
      amountDue: invoice.amountDue,
      taxAmount: invoice.taxAmount,
      discountAmount: invoice.discountAmount,
      lines: (invoice.invoice_line_items ?? []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        amount: li.amount,
      })),
    });

    if (charge.totalMinor <= 0) {
      throw new BadRequestException('Invoice amount must be greater than zero');
    }

    this.reportUnreconciledLines(invoice.invoiceNumber, charge);

    // Idempotent checkout init.
    // If the customer (or a refresh / second click on the email link) hits this
    // endpoint twice, we MUST hand back the same Checkout URL the first call
    // minted — not a new one. Otherwise the customer can sit on two live
    // sessions and pay both, leaving amountPaid = 2x totalAmount.
    //
    // A cached link is
    // only the same link while it still collects the same money and still
    // works, so re-use needs all three of these to hold:
    //
    //   1. the pending row carries a session id, a URL and an expiry — a row
    //      may lack them, and a missing field means mint a new one rather than
    //      500 on a bad metadata read;
    //   2. that expiry is still in the future. The stored figure is the
    //      provider's own, and Stripe's is 30 MINUTES (stripe.adapter.ts), so
    //      a row inside the one-day lookup window can hold a dead session;
    //   3. it collects what a charge built right now would collect. A customer
    //      who wires $60 against a $100 invoice between the two calls must not
    //      be sent back to a link that still charges $100.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const recentPending = await this.prisma.invoice_payments.findFirst({
      where: {
        invoiceId,
        status: 'pending',
        provider_checkout_session_id: { not: null },
        createdAt: { gte: new Date(Date.now() - ONE_DAY_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentPending) {
      const meta = recentPending.metadata as {
        checkoutSessionId?: string;
        checkoutUrl?: string;
        expiresAt?: string;
      } | null;
      if (meta?.checkoutSessionId && meta?.checkoutUrl && meta?.expiresAt) {
        const stillLive = new Date(meta.expiresAt).getTime() > Date.now();
        const collectsTheSameMoney =
          (recentPending.currency || charge.currency) === charge.currency &&
          toMinorUnits(recentPending.amount ?? 0, charge.currency) === charge.totalMinor;

        if (stillLive && collectsTheSameMoney) {
          this.logger.log(
            `Returning existing pending checkout session ${meta.checkoutSessionId} for ` +
              `invoice ${invoice.invoiceNumber} (idempotent re-use; ` +
              `pending row id=${recentPending.id})`,
          );
          return {
            sessionId: meta.checkoutSessionId,
            url: meta.checkoutUrl,
            expiresAt: meta.expiresAt,
          };
        }

        this.logger.log(
          `Not re-using checkout session ${meta.checkoutSessionId} for invoice ` +
            `${invoice.invoiceNumber}: ${
              stillLive
                ? `it collects ${recentPending.amount} ${recentPending.currency} but this ` +
                  `invoice now owes ${formatCharge(charge)}`
                : `it expired at ${meta.expiresAt}`
            }. Creating a new one.`,
        );
      }
    }

    // Get the org's active payment provider and create an adapter for it
    const provider = await this.getActiveProvider(invoice.organizationId);
    const adapter = this.adapterFactory.createAdapter(provider);

    // Read the org's tax preference. When true, Stripe Checkout
    // automatically calculates sales tax via the merchant's Stripe Tax registrations.
    // Read separately so a missing field stays falsy
    // rather than blowing up the type narrowing.
    const orgTaxFlag =
      (invoice.organizations as { stripeAutomaticTax?: boolean }).stripeAutomaticTax === true;

    // Two tax engines on one payment tax the customer twice. An invoice can
    // carry its own taxAmount (invoices.service.ts and the dashboard Server
    // Action both take one from the caller) while the org also has Stripe Tax
    // on; Stripe would then compute its own tax and add it on top of a total
    // that already includes the invoice's.
    //
    // When the invoice states a tax figure, that figure IS the bill and the
    // provider's engine stays off. Say so loudly: the merchant has two tax
    // sources configured and only one of them is being honoured.
    const automaticTax = orgTaxFlag && charge.taxMinor === 0;
    if (orgTaxFlag && !automaticTax) {
      this.logger.warn(
        `Invoice ${invoice.invoiceNumber} already carries ` +
          `${formatMinorUnits(charge.taxMinor, charge.currency)} ${charge.currency} of tax, so ` +
          `Stripe Tax is off for this checkout. Leaving both on would charge the customer tax ` +
          `twice. Pick one: either stop setting taxAmount on the invoice, or turn off ` +
          `automatic tax for this organization.`,
      );
    }

    // success_url lands on the dashboard's public /thanks route,
    // which renders a "Payment received" view from these URL params with no
    // roundtrip. Stripe substitutes {CHECKOUT_SESSION_ID} at redirect time.
    // A cancelled checkout goes back to the dashboard's root.
    const frontendUrl = requireFrontendUrl(this.configService);
    const thanksUrl =
      `${frontendUrl}/thanks` +
      `?org=${encodeURIComponent(invoice.organizations.name)}` +
      `&inv=${encodeURIComponent(invoice.invoiceNumber)}` +
      // What this session collects, which is not the invoice total when the
      // customer has already part-paid it.
      `&amt=${encodeURIComponent(formatMinorUnits(charge.totalMinor, charge.currency))}` +
      `&session_id={CHECKOUT_SESSION_ID}`;

    // Call the adapter — it handles all provider-specific API calls
    try {
      const result = await adapter.createCheckoutSession({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        organizationName: invoice.organizations.name,
        customerEmail: invoice.customers.email,
        charge,
        description: `Payment for invoice from ${invoice.organizations.name}`,
        successUrl: successUrl || thanksUrl,
        cancelUrl: cancelUrl || frontendUrl,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          organizationId: invoice.organizationId,
          customerId: invoice.customerId,
          paymentProviderId: provider.id,
        },
        automaticTax,
      });

      // Create a pending payment record in our database
      // (this is the same regardless of which provider is used)
      await this.prisma.invoice_payments.create({
        data: {
          id: this.generateUuid(),
          invoiceId: invoice.id,
          // What this session collects. InvoicePaymentReconciler carries this
          // figure into the succeeded row (it never rewrites `amount` on the
          // webhook path), so recording the invoice total here would credit a
          // part-paid invoice with money nobody sent.
          amount: String(fromMinorUnits(charge.totalMinor, charge.currency)),
          currency: charge.currency,
          paymentMethod: 'stripe',
          status: 'pending',
          provider_checkout_session_id: result.sessionId,
          payment_provider_id: provider.id,
          paymentDate: new Date(),
          metadata: {
            checkoutSessionId: result.sessionId,
            checkoutUrl: result.url,
            // The provider's own expiry, so the re-use guard above reads a real
            // TTL instead of assuming one.
            expiresAt: result.expiresAt,
            // A durable mark for month-end: which sessions could not show the
            // customer a breakdown, and why. Log lines age out; this does not.
            ...(charge.bundleReason
              ? {
                  collectedAsSingleRow: charge.bundleReason,
                  lineRowsMinor: charge.offeredRowsMinor,
                  collectedMinor: charge.totalMinor,
                }
              : {}),
          } as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Created ${provider.type} checkout session ${result.sessionId} for invoice ${invoice.invoiceNumber}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to create ${provider.type} checkout session for invoice ${invoiceId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to create checkout session: ${error.message}`);
    }
  }

  /**
   * The one bundle reason that means something is broken.
   *
   * A charge collapses to a single row for several ordinary reasons — a
   * discount that would need a negative row, a balance that is no longer the
   * whole total. Those are invoices behaving normally and must stay silent, or
   * the alarm becomes background noise and the real signal disappears into it.
   *
   * `lines-do-not-reconcile` is different: the line items on this invoice do
   * not add up to its own header. The customer is still charged the right
   * amount (the charge guarantees that), but a writer somewhere is producing
   * rows that disagree with the total, and nobody would ever find out.
   */
  private reportUnreconciledLines(invoiceNumber: string, charge: CollectibleCharge): void {
    if (charge.bundleReason !== 'lines-do-not-reconcile') return;

    const collected = formatMinorUnits(charge.totalMinor, charge.currency);
    const rows = formatMinorUnits(charge.offeredRowsMinor, charge.currency);
    this.logger.error(
      `Invoice ${invoiceNumber}: its line items add up to ${rows} ${charge.currency} but the ` +
        `invoice itself says ${collected} ${charge.currency}. Charging the invoice total as one ` +
        `row, so the customer pays the right amount — but this invoice's rows are wrong and ` +
        `need looking at.`,
    );
    Sentry.captureMessage('Invoice line items do not reconcile with the invoice total', {
      level: 'error',
      tags: {
        surface: 'checkout',
        silent_path: 'lines_do_not_reconcile',
      },
      extra: {
        invoiceNumber,
        currency: charge.currency,
        lineRowsMinor: charge.offeredRowsMinor,
        collectedMinor: charge.totalMinor,
      },
    });
  }

  /**
   * Refund a payment. Works with any provider.
   *
   * `amount` is in the payment's OWN currency (dollars, yen, dinars), and the
   * conversion to the provider's minor unit happens here, once, using the
   * currency on the payment row.
   */
  async createRefund(
    providerTransactionId: string,
    amount?: number,
    reason?: string,
  ): Promise<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    reason: string | null;
  }> {
    // Find the payment and its associated provider
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_transaction_id: providerTransactionId },
      include: {
        payment_providers: true,
        invoices: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (!payment.payment_providers) {
      throw new BadRequestException('Payment has no associated provider');
    }

    // Create the right adapter for this payment's provider
    const adapter = this.adapterFactory.createAdapter(payment.payment_providers);

    try {
      const currency = payment.currency || payment.invoices?.currency || 'USD';
      const result = await adapter.createRefund({
        providerTransactionId,
        amountMinor: amount === undefined ? undefined : toMinorUnits(amount, currency),
        currency,
        reason,
      });

      this.logger.log(
        `Created ${payment.payment_providers.type} refund ${result.id} for payment ${providerTransactionId}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to create refund for payment ${providerTransactionId}: ${error.message}`,
      );
      throw new BadRequestException(`Failed to create refund: ${error.message}`);
    }
  }

  /**
   * Get payment details (card info, fees, receipt URL). Works with any provider.
   */
  async getPaymentDetails(providerTransactionId: string): Promise<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    cardLast4: string | null;
    cardBrand: string | null;
    receiptUrl: string | null;
    fee: number | null;
    netAmount: number | null;
  }> {
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_transaction_id: providerTransactionId },
      include: {
        payment_providers: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (!payment.payment_providers) {
      throw new BadRequestException('Payment has no associated provider');
    }

    const adapter = this.adapterFactory.createAdapter(payment.payment_providers);

    try {
      const details = await adapter.getPaymentDetails(providerTransactionId);

      // Map the generic PaymentDetails to the response shape the dashboard reads.
      return {
        id: details.id,
        amount: details.amount,
        currency: details.currency,
        status: details.status,
        cardLast4: details.paymentMethodLabel?.match(/(\d{4})$/)?.[1] || null,
        cardBrand: details.paymentMethodLabel?.split(' ')?.[0] || null,
        receiptUrl: details.receiptUrl,
        fee: details.fee,
        netAmount: details.netAmount,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get payment details for ${providerTransactionId}: ${error.message}`,
      );
      throw new BadRequestException(`Failed to get payment details: ${error.message}`);
    }
  }

  /**
   * Get checkout session details. Works with any provider.
   */
  async getCheckoutSession(sessionId: string): Promise<{
    sessionId: string;
    paymentIntentId: string | null;
    status: string;
    paymentStatus: string | null;
    cardLast4: string | null;
    cardBrand: string | null;
    receiptUrl: string | null;
    fee: number | null;
    netAmount: number | null;
    customerEmail: string | null;
  }> {
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { provider_checkout_session_id: sessionId },
      include: {
        payment_providers: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Checkout session not found');
    }

    if (!payment.payment_providers) {
      throw new BadRequestException('Payment has no associated provider');
    }

    // If we have a transaction ID, get full details from the provider
    if (payment.provider_transaction_id) {
      const adapter = this.adapterFactory.createAdapter(payment.payment_providers);

      try {
        const details = await adapter.getPaymentDetails(payment.provider_transaction_id);

        return {
          sessionId,
          paymentIntentId: payment.provider_transaction_id,
          status: payment.status || 'pending',
          paymentStatus: details.status,
          cardLast4: details.paymentMethodLabel?.match(/(\d{4})$/)?.[1] || null,
          cardBrand: details.paymentMethodLabel?.split(' ')?.[0] || null,
          receiptUrl: details.receiptUrl,
          fee: details.fee,
          netAmount: details.netAmount,
          customerEmail: null,
        };
      } catch (error) {
        this.logger.error(`Failed to get checkout session ${sessionId}: ${error.message}`);
      }
    }

    // Fallback: return what we have in our database
    return {
      sessionId,
      paymentIntentId: payment.provider_transaction_id || null,
      status: payment.status || 'pending',
      paymentStatus: payment.provider_status || null,
      cardLast4: null,
      cardBrand: null,
      receiptUrl: null,
      fee: null,
      netAmount: null,
      customerEmail: null,
    };
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
