/**
 * Stripe Payment Adapter
 *
 * Wraps the Stripe SDK to match our PaymentAdapter interface.
 * All the Stripe-specific API calls, data transformations, and
 * webhook handling live here. Nowhere else in the codebase
 * should import the Stripe SDK directly.
 */
import Stripe from 'stripe';
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAdapter,
  CreateCheckoutParams,
  CheckoutSessionResult,
  RefundResult,
  PaymentDetails,
  WebhookEvent,
  CheckoutCompletedData,
  PaymentFailedData,
  RefundCompletedData,
  RefundRequest,
} from '../interfaces';
import { fromMinorUnits } from '@marginfront/db';
import { formatCharge } from '../collectible-charge';

// Stripe's documented minimum charge for USD-denominated Checkout Sessions is
// $0.50. Sessions created below this minimum return a 400 from Stripe with the
// `amount_too_small` error code. We pre-flight here so the merchant gets a
// clear plain-English error from MarginFront instead of a raw Stripe message
// surfaced through the dashboard's error toast or the customer-facing /i/{id}/pay
// branded error page. Non-USD currencies have different minimums; Stripe will
// reject those server-side and the error bubbles back through the same path.
// Only the USD minimum is pre-flighted.
// Reference: https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const STRIPE_MIN_CHARGE_CENTS_USD = 50;

export class StripeAdapter implements PaymentAdapter {
  readonly providerType = 'stripe';
  private readonly logger = new Logger(StripeAdapter.name);
  private stripe: Stripe;
  private webhookSecret: string;
  // When set, this provider was created via Stripe Connect OAuth.
  // The adapter uses the platform's STRIPE_SECRET_KEY and adds `{ stripeAccount: <id> }`
  // to every Stripe API call so charges/refunds run on behalf of the connected merchant.
  // When null, the provider was created via the secret-key form and uses the merchant's own key.
  private readonly stripeAccountId: string | null;

  constructor(
    private readonly secrets: Record<string, string>,
    private readonly configService: ConfigService,
  ) {
    // OAuth-sourced providers carry the connected-account ID inside the secrets envelope
    // (no per-merchant API key). For those rows, the adapter uses the platform's
    // STRIPE_SECRET_KEY + Stripe-Account header. Secret-key-sourced rows use the merchant
    // key directly, no Stripe-Account header.
    const oauthAccountId = secrets.stripeConnectAccountId || null;
    let effectiveSecretKey: string | undefined;

    if (oauthAccountId) {
      effectiveSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
      if (!effectiveSecretKey) {
        throw new Error(
          'Stripe Connect provider needs the platform STRIPE_SECRET_KEY env var to be set. ' +
            'OAuth-sourced providers run charges through the platform key with a Stripe-Account header.',
        );
      }
    } else {
      effectiveSecretKey = secrets.secretKey || secrets.apiKey;
      if (!effectiveSecretKey) {
        throw new Error(
          'Stripe adapter needs a secret key. Check that your payment provider has a secretKey or apiKey configured.',
        );
      }
    }

    this.stripe = new Stripe(effectiveSecretKey, {
      apiVersion: '2026-02-25.clover',
    });
    this.webhookSecret = secrets.webhookSecret || '';
    this.stripeAccountId = oauthAccountId;
  }

  /**
   * The `{ stripeAccount }` request option Stripe expects for Connect platform calls.
   * Empty object for secret-key-sourced providers (i.e., no on-behalf-of header).
   */
  private get stripeAccountOption(): { stripeAccount: string } | undefined {
    return this.stripeAccountId ? { stripeAccount: this.stripeAccountId } : undefined;
  }

  /**
   * Create a Stripe Checkout Session. This is the hosted payment page
   * where the customer enters their card info. We get a URL to redirect them to.
   */
  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSessionResult> {
    const { charge } = params;

    // Pre-flight Stripe's $0.50 minimum charge so the merchant + customer get
    // a clear message instead of Stripe's raw `amount_too_small` 400.
    //
    // Since the charge collects the BALANCE rather than the header total, this
    // also catches a nearly-paid invoice: $100 with $99.60 already in leaves
    // 40 cents Stripe will not take. Telling that merchant to "increase the
    // invoice amount" is nonsense advice — the invoice is fine, the remainder is
    // too small — so the two cases get different sentences.
    if (charge.currency === 'USD' && charge.totalMinor < STRIPE_MIN_CHARGE_CENTS_USD) {
      throw new BadRequestException(
        charge.bundleReason === 'partially-settled'
          ? `Invoice ${params.invoiceNumber} has ${formatCharge(charge)} left to pay, which is ` +
              `below Stripe's $0.50 minimum charge. Stripe will not take a payment this small. ` +
              `Mark the invoice paid to settle the remainder off-platform, or write it off.`
          : `Invoice balance (${formatCharge(charge)}) is below Stripe's $0.50 minimum charge. ` +
              `Increase the invoice amount, or mark the invoice paid manually for off-platform settlement.`,
      );
    }

    // One row per collectible line, and nothing decided here. The charge
    // already guarantees unit_amount × quantity === that line's amount and that
    // the rows add up to the total (collectible-charge.ts), so the itemized
    // shape and the bundled shape collect the same money by construction —
    // there is no branch left for this adapter to get wrong.
    const stripeLineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = charge.lines.map(
      (line) => ({
        price_data: {
          // The Stripe SDK types currency as a plain `string` in the request
          // shape, with no named currency type to cast to.
          currency: charge.currency.toLowerCase() as string,
          // The one-row shape is the customer's only description of what they
          // are paying for, so it keeps the invoice blurb. Display only.
          product_data: charge.itemized
            ? { name: line.label }
            : { name: line.label, description: params.description },
          unit_amount: line.unitAmountMinor,
        },
        quantity: line.quantity,
      }),
    );

    const sessionPayload: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: stripeLineItems,
      client_reference_id: params.invoiceId,
      // Stripe rejects `redirect_on_completion: 'never'` outside
      // `ui_mode: 'embedded'`. In hosted mode, Stripe shows its built-in
      // "Payment successful" panel briefly, then redirects to success_url
      // (the dashboard's /thanks page).
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
      payment_intent_data: {
        metadata: {
          invoiceId: params.invoiceId,
          invoiceNumber: params.invoiceNumber,
          organizationId: params.metadata.organizationId,
        },
      },
      // Checkout session expires in 30 minutes
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    };

    // Stripe rejects a session with "Invalid email address:" for null/empty/
    // whitespace. Omit the field instead so Stripe collects it at checkout.
    if (params.customerEmail && params.customerEmail.trim().length > 0) {
      sessionPayload.customer_email = params.customerEmail;
    }

    // Opt-in Stripe Tax. When the org has `stripeAutomaticTax` on,
    // Stripe computes sales tax against the merchant's own tax registrations and adds
    // it to the session total. If the merchant hasn't set up Stripe Tax / registrations,
    // Stripe returns a 400 — that's the merchant's setup problem, not ours, and the
    // error message points them at the right Stripe Dashboard page.
    if (params.automaticTax) {
      sessionPayload.automatic_tax = { enabled: true };
    }

    const session = await this.stripe.checkout.sessions.create(
      sessionPayload,
      this.stripeAccountOption,
    );

    return {
      sessionId: session.id,
      url: session.url!,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
    };
  }

  /**
   * Refund a payment via Stripe. Can do full or partial refunds.
   */
  async createRefund(request: RefundRequest): Promise<RefundResult> {
    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: request.providerTransactionId,
      reason: (request.reason as Stripe.RefundCreateParams.Reason) || 'requested_by_customer',
    };

    if (request.amountMinor) {
      refundParams.amount = request.amountMinor;
    }

    const refund = await this.stripe.refunds.create(refundParams, this.stripeAccountOption);

    return {
      id: refund.id,
      // Stripe answers in the currency's minor unit, which is not always cents.
      amount: fromMinorUnits(refund.amount, refund.currency),
      currency: refund.currency,
      status: refund.status || 'pending',
      reason: refund.reason,
    };
  }

  /**
   * Get full details about a payment. Card info, fees, receipt URL.
   * Uses the PaymentIntent ID we stored when the checkout completed.
   */
  async getPaymentDetails(providerTransactionId: string): Promise<PaymentDetails> {
    const paymentIntent = await this.stripe.paymentIntents.retrieve(
      providerTransactionId,
      { expand: ['payment_method', 'latest_charge.balance_transaction'] },
      this.stripeAccountOption,
    );

    const charge = paymentIntent.latest_charge as Stripe.Charge;
    const paymentMethod = paymentIntent.payment_method as Stripe.PaymentMethod;
    const balanceTransaction = charge?.balance_transaction as Stripe.BalanceTransaction;

    const cardLast4 = paymentMethod?.card?.last4 || null;
    const cardBrand = paymentMethod?.card?.brand || null;

    return {
      id: paymentIntent.id,
      amount: fromMinorUnits(paymentIntent.amount, paymentIntent.currency),
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      paymentMethodLabel:
        cardLast4 && cardBrand
          ? `${cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)} ending in ${cardLast4}`
          : null,
      receiptUrl: charge?.receipt_url || null,
      // A balance transaction is denominated in the merchant's SETTLEMENT
      // currency, which is not always the one the customer was charged in.
      // Each side scales by its own currency or the two disagree by 100x.
      fee: balanceTransaction?.fee
        ? fromMinorUnits(balanceTransaction.fee, balanceTransaction.currency)
        : null,
      netAmount: balanceTransaction?.net
        ? fromMinorUnits(balanceTransaction.net, balanceTransaction.currency)
        : null,
    };
  }

  /**
   * Verify a Stripe webhook signature and normalize the event.
   * Stripe sends events like "checkout.session.completed". We map those
   * to our standard event types.
   */
  async verifyWebhook(rawBody: Buffer, signature: string): Promise<WebhookEvent> {
    // Reject webhooks if the secret isn't configured. Never skip verification
    if (!this.webhookSecret) {
      throw new Error(
        'Stripe webhook refused: this payment provider has no webhook signing secret saved, so the signature cannot be checked. ' +
          'Copy the signing secret from the webhook endpoint in Stripe and save it on the Stripe card under Settings, then Integrations.',
      );
    }

    const event: Stripe.Event = this.stripe.webhooks.constructEvent(
      rawBody.toString(),
      signature,
      this.webhookSecret,
    );

    // `checkout.session.completed` also fires for delayed payment methods while
    // the money is still pending (`payment_status: 'unpaid'`); those are
    // confirmed later by `checkout.session.async_payment_succeeded`.
    let eventType: WebhookEvent['eventType'];
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        eventType =
          event.data.object.payment_status === 'unpaid' ? 'ignored' : 'checkout.completed';
        break;
      case 'payment_intent.payment_failed':
        eventType = 'payment.failed';
        break;
      case 'refund.created':
        eventType = 'refund.created';
        break;
      case 'refund.updated':
        eventType = 'refund.updated';
        break;
      default:
        eventType = 'ignored';
    }

    return {
      eventId: event.id,
      eventType,
      rawEventType: event.type,
      payload: event,
    };
  }

  /**
   * Extract payment success data from a Stripe checkout.session.completed event.
   * Fetches extra details (card info, fees) from the Stripe API since the
   * webhook payload doesn't include everything we need.
   */
  async extractCheckoutCompleted(payload: Stripe.Event): Promise<CheckoutCompletedData> {
    const session = payload.data.object as Stripe.Checkout.Session;
    const invoiceId = session.client_reference_id || session.metadata?.invoiceId || '';
    const paymentIntentId = session.payment_intent as string;

    // Fetch card details and fees from Stripe (not in the webhook payload)
    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    let receiptUrl: string | null = null;
    let fee: number | null = null;
    let netAmount: number | null = null;

    try {
      const fullSession = await this.stripe.checkout.sessions.retrieve(
        session.id,
        {
          expand: [
            'payment_intent.payment_method',
            'payment_intent.latest_charge.balance_transaction',
          ],
        },
        this.stripeAccountOption,
      );

      const pi = fullSession.payment_intent as Stripe.PaymentIntent;
      const charge = pi?.latest_charge as Stripe.Charge;
      const pm = pi?.payment_method as Stripe.PaymentMethod;
      const bt = charge?.balance_transaction as Stripe.BalanceTransaction;

      cardLast4 = pm?.card?.last4 || null;
      cardBrand = pm?.card?.brand || null;
      receiptUrl = charge?.receipt_url || null;
      // Settlement currency, not the charge's — see getPaymentDetails.
      fee = bt?.fee ? fromMinorUnits(bt.fee, bt.currency) : null;
      netAmount = bt?.net ? fromMinorUnits(bt.net, bt.currency) : null;
    } catch {
      // If we can't fetch extra details, that's okay. We still have the basics
    }

    return {
      providerTransactionId: paymentIntentId,
      checkoutSessionId: session.id,
      invoiceId,
      paymentStatus: session.payment_status,
      cardLast4,
      cardBrand,
      receiptUrl,
      fee,
      netAmount,
    };
  }

  /**
   * Extract failure data from a Stripe payment_intent.payment_failed event.
   */
  async extractPaymentFailed(payload: Stripe.Event): Promise<PaymentFailedData> {
    const paymentIntent = payload.data.object as Stripe.PaymentIntent;

    return {
      providerTransactionId: paymentIntent.id,
      errorCode: paymentIntent.last_payment_error?.code || null,
      errorMessage: paymentIntent.last_payment_error?.message || null,
      providerStatus: paymentIntent.status,
    };
  }

  /**
   * Extract refund data from a Stripe refund.created or refund.updated event.
   *
   * The event payload's data.object IS the Refund (not a Charge wrapping it).
   * From Stripe API version 2026-04-22.dahlia the `charge.refunded` event does
   * not embed `charge.refunds.data[]`, so reading the amount from there would
   * yield 0 and upstream would reject the webhook with a 400.
   *
   * The `status` field on the Stripe Refund object can be 'pending',
   * 'succeeded', 'failed', 'canceled', or 'requires_action'. We pass it
   * through unchanged so the status-aware handler in webhooks.service.ts can
   * dispatch correctly (pending = record only, succeeded = finalize, failed /
   * canceled = mark row without propagating).
   */
  async extractRefundCompleted(payload: Stripe.Event): Promise<RefundCompletedData> {
    const refund = payload.data.object as Stripe.Refund;
    const currency = refund.currency || 'usd';

    return {
      providerRefundId: refund.id,
      providerTransactionId: (refund.payment_intent as string) || (refund.charge as string) || '',
      // This figure lands in invoice_payments.refunded_amount, which moves
      // amountPaid and therefore amountDue — and amountDue is what the next
      // checkout collects. A mis-scaled refund here becomes a wrong charge.
      amount: fromMinorUnits(refund.amount, currency),
      currency,
      status: refund.status || 'pending',
      reason: refund.reason || null,
    };
  }
}
