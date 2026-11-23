/**
 * PaymentAdapter Interface
 *
 * The plug shape between the billing code and a payment provider. Stripe is
 * the one adapter in this repo. To add another provider, implement this
 * interface and return it from PaymentAdapterFactory.
 */
import type { CollectibleCharge } from '../collectible-charge';

// What we send to the provider to create a checkout session
// (the hosted payment page the customer gets redirected to)
export interface CreateCheckoutParams {
  invoiceId: string;
  invoiceNumber: string;
  organizationName: string;
  // Nullable (customers.email is optional). The Stripe adapter omits
  // customer_email when empty.
  customerEmail: string | null;
  // The ONLY description of money an adapter gets. It carries the amount to
  // collect and the rows to show, already denominated in the currency's own
  // minor unit and already guaranteed to multiply back out to that amount (see
  // collectible-charge.ts). There is deliberately no separate amount, no unit
  // price and no currency field beside it: an adapter that cannot reach a
  // second version of the number cannot bill a second version of the number.
  charge: CollectibleCharge;
  description: string; // e.g. "Payment for invoice INV-0042"
  successUrl: string; // Where to send the customer after they pay
  cancelUrl: string; // Where to send them if they bail
  metadata: Record<string, string>; // Extra data that comes back in webhooks
  // When true, the Stripe adapter passes `automatic_tax: { enabled: true }` to
  // Stripe Checkout. Requires Stripe Tax and active tax registrations on the
  // Stripe account, otherwise Stripe returns an error at session-create time.
  // Driven by `organizations.stripeAutomaticTax`.
  automaticTax?: boolean;
}

export interface CheckoutSessionResult {
  sessionId: string; // Provider's session ID (we store this for tracking)
  url: string; // The URL to redirect the customer to
  expiresAt: string; // ISO timestamp of when the payment link expires
}

// `amountMinor` is denominated in the currency's own smallest unit, and
// `currency` says which currency that is. An amount with no currency attached
// is not an amount.
export interface RefundRequest {
  providerTransactionId: string;
  /** Omit to refund the payment in full. */
  amountMinor?: number;
  /** ISO 4217 code of the ORIGINAL payment. */
  currency: string;
  reason?: string;
}

export interface RefundResult {
  id: string; // Provider's refund ID
  amount: number; // In major units (dollars, not cents), matching how we store amounts
  currency: string;
  status: string; // Normalized: "succeeded", "pending", "failed"
  reason: string | null;
}

export interface PaymentDetails {
  id: string; // Provider's transaction ID
  amount: number; // In major units
  currency: string;
  status: string;
  paymentMethodLabel: string | null; // e.g. "Visa ending in 4242"
  receiptUrl: string | null;
  fee: number | null; // Provider's processing fee
  netAmount: number | null; // What you actually receive after fees
}

// Normalized webhook event. The adapter translates the provider's event types
// to these.
//
// `ignored` is every event the adapter does not act on. The webhook service
// acknowledges it and changes nothing. An adapter must never map an event it
// does not recognise to `checkout.completed`.
//
// Stripe sends `refund.created` (first attempt; status pending or succeeded)
// and `refund.updated` (later state changes; status succeeded or failed). The
// handler dispatches off `RefundCompletedData.status`, not the event type.
export interface WebhookEvent {
  eventId: string; // Provider's unique event ID (used for deduplication)
  eventType:
    | 'checkout.completed'
    | 'payment.failed'
    | 'refund.created'
    | 'refund.updated'
    | 'ignored';
  rawEventType: string; // Provider's original event type (for logging)
  payload: any; // Provider-specific payload. Only the adapter knows how to read it
}

export interface CheckoutCompletedData {
  providerTransactionId: string; // Stripe: PaymentIntent ID
  checkoutSessionId: string;
  invoiceId: string;
  paymentStatus: string;
  cardLast4: string | null;
  cardBrand: string | null;
  receiptUrl: string | null;
  fee: number | null;
  netAmount: number | null;
}

export interface PaymentFailedData {
  providerTransactionId: string;
  errorCode: string | null;
  errorMessage: string | null;
  providerStatus: string;
}

// `status` drives the handler: 'pending' records the refund row but does not
// touch invoice_payments.refunded_amount; 'succeeded' runs the
// InvoiceRefundFinalizer; 'failed' / 'canceled' marks the row failed without
// propagating.
export interface RefundCompletedData {
  providerRefundId: string; // Stripe: re_xxx
  providerTransactionId: string; // The original payment that was refunded
  amount: number; // Refund amount in major units
  currency: string;
  status: string; // 'pending' | 'succeeded' | 'failed' | 'canceled'
  reason: string | null;
}

/**
 * The contract a payment provider adapter implements.
 *
 * Each adapter receives its decrypted API keys when created (via the factory).
 * Adapters are created per request because each organization has different keys.
 */
export interface PaymentAdapter {
  readonly providerType: string;

  // Create a hosted checkout page and return the URL to redirect the customer to
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSessionResult>;

  // Refund a payment (full or partial)
  createRefund(request: RefundRequest): Promise<RefundResult>;

  // Get details about a specific payment (card info, fees, receipt)
  getPaymentDetails(providerTransactionId: string): Promise<PaymentDetails>;

  // Verify a webhook signature and parse the event into our standard format
  verifyWebhook(rawBody: Buffer, signature: string): Promise<WebhookEvent>;

  // Extract payment success data from a verified webhook payload
  extractCheckoutCompleted(payload: any): Promise<CheckoutCompletedData>;

  // Extract payment failure data from a verified webhook payload
  extractPaymentFailed(payload: any): Promise<PaymentFailedData>;

  // Extract refund data from a verified webhook payload
  extractRefundCompleted(payload: any): Promise<RefundCompletedData>;
}
