export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /**
   * Optional per-call FROM override. When omitted, EmailService uses the
   * RESEND_FROM_EMAIL config. Set this when a specific email type needs a
   * different From: end-customer emails
   * override to the RESEND_INVOICE_FROM_EMAIL value.
   */
  from?: string;
}

export interface SendPaymentReceiptOptions {
  to: string;
  customerName?: string;
  invoiceNumber: string;
  amount: number | string;
  currency?: string;
  paymentDate: Date | string;
  cardLast4?: string;
  cardBrand?: string;
  transactionId?: string;
  invoiceTotal: number | string;
  amountDue: number | string;
  // `receiptUrl` is Stripe's own receipt PDF link, a secondary action.
  receiptUrl?: string;
  companyName?: string;
  companyEmail?: string;
}

/**
 * Sent to a MarginFront user's end-customer when an invoice draft auto-finalizes (or the
 * MarginFront user clicks "Send"). Distinct from SendPaymentReceiptOptions — receipt fires
 * AFTER the customer pays; this fires BEFORE, with the payment link they need to pay.
 */
export interface SendInvoiceReadyOptions {
  to: string;
  customerName?: string;
  invoiceNumber: string;
  amountDue: number | string;
  currency?: string;
  dueDate: Date | string;
  /**
   * Where the "Pay Now" button takes the customer: the dashboard route
   * handler `/i/{id}/pay`, which server-side mints a fresh Stripe Checkout
   * Session and 302s the customer to it.
   */
  paymentUrl: string;
  companyName?: string;
  companyEmail?: string;
  /**
   * Itemized line items rendered as a table inside the email so the
   * customer sees the actual breakdown of what they're paying for instead of
   * just a mystery total. When omitted or empty, the email shows only the total
   * (callers may omit it).
   */
  lineItems?: Array<{
    description: string;
    quantity: number | string;
    unitPrice: number | string;
    amount: number | string;
  }>;
}

/**
 * Sent to the MERCHANT (the platform's own user) each time the `dispatch`
 * cron auto-issues a usage invoice to one of their end-customers.
 *
 * This is the "operator" channel — it comes FROM the default RESEND_FROM_EMAIL so a
 * merchant reply reaches whoever runs this deployment. It is the opposite recipient of
 * SendInvoiceReadyOptions: that one goes to the end-customer from
 * RESEND_INVOICE_FROM_EMAIL; THIS one goes to the merchant.
 *
 * Why it exists: an auto-issued invoice reaches the customer without the merchant
 * clicking anything. This notification makes every send immediately visible so the
 * merchant can void/fix fast if something's off.
 */
export interface SendMerchantInvoiceSentOptions {
  /**
   * The org's billing contact (billing_email, then billingIdentity.email), or a
   * current owner-role member's email as the last-resort fallback.
   */
  to: string;
  /** Org / merchant display name, used in the greeting. */
  organizationName?: string;
  /** The end-customer's display name (appears in the subject so inbox search works). */
  customerName?: string;
  /** The email address we sent (or tried to send) the invoice to. */
  customerEmail?: string;
  invoiceNumber: string;
  /** Invoice total — raw number/string; formatted into currency in the body. */
  amount: number | string;
  currency?: string;
  /** Full URL to the merchant-side invoice detail page (e.g. /invoices/{id}). */
  invoiceDetailUrl: string;
  /** Full URL to the merchant-side customer detail page (e.g. /customers/{id}). */
  customerDetailUrl: string;
  /**
   * Line items for the "first 3 + N more" summary. Same shape the customer email uses.
   */
  lineItems?: Array<{
    description: string;
    quantity: number | string;
    unitPrice: number | string;
    amount: number | string;
  }>;
  /**
   * When set, the body renders a warning that we could NOT deliver the invoice to the
   * customer — so the merchant knows to follow up. 'failed' = send threw; 'no-email' =
   * customer has no email on file. Omitted when the customer email went out fine.
   */
  customerDeliveryIssue?: 'failed' | 'no-email';
}

/**
 * A ladder-alert email ("the warnings before the
 * wall"). Sent to the org's billing contact when internal AI spend passes
 * a rung (50/80/100% by default) of a cap. All the copy that must never blur
 * "alert" and "block" is built by buildCapAlertContent; this carries the raw
 * facts it needs. The CTA always lands on the Spend Controls money tab.
 */
export interface SendCapAlertOptions {
  /** One address from resolveAlertRecipients. */
  to: string;
  /** 'track' | 'enforce' — only the copy differs per mode, never the ladder. */
  mode: string;
  /** The rung that fired, a whole percent (50/80/100 or a custom ladder entry). */
  rung: number;
  /** 'org' | 'team' | 'dev' — who the cap governs. */
  scope: string;
  /** The scope's target (dev email / team label), or null for an org ceiling. */
  scopeValue: string | null;
  /** 'all' or a single provider. */
  providerScope: string;
  amountUsd: number;
  /** 'day' | 'week' | 'month'. */
  period: string;
  spentUsd: number;
  /** Actual spend as a percent of the cap (may sit above the rung that fired). */
  percentOfCap: number;
  /** Freshness stamp for the spend figure. */
  asOf: Date;
}

/**
 * A staged pool alert, sibling of the cap alert
 * above. Sent to the org's billing contact when a subscription's credit pool
 * crosses a stage (50/80/95%/exhausted). All the track-only-truth copy is
 * built by buildPoolAlertContent; this carries the raw facts it needs. The
 * CTA always lands on the needs-attention page.
 */
export interface SendPoolAlertOptions {
  to: string;
  /** 'pool_50' | 'pool_80' | 'pool_95' | 'pool_exhausted'. */
  stage: string;
  /** The end-customer the subscription bills; null when the row has none. */
  customerName: string | null;
  subscriptionName: string;
  /** The period grant's size in usage units. */
  poolSizeUnits: number;
  /** Drawable units left (negative = overage-in-progress). */
  remainingUnits: number;
  /** Actual percent used (may sit above the stage that fired). */
  percentUsed: number;
  /** The plan's overage rate in dollars per unit, when the tiers carry one. */
  overageRate: number | null;
  /** True on a boundary evaluation: the described period already ended. */
  periodClosed: boolean;
  /** Freshness stamp for the balance figures. */
  asOf: Date;
}

/** A customer-watch trigger email (the tripwire fired). */
export interface SendCustomerAlertOptions {
  /** The watch's stored recipientEmail (resolved once at create). */
  to: string;
  customerName: string;
  /** Internal customer UUID — the deep link is FRONTEND_URL/customers/{id}. */
  customerId: string;
  /** 'cost' | 'revenue'. */
  metric: string;
  thresholdUsd: number;
  /** The measured canonical value at fire time. */
  valueUsd: number;
  /** 'month' | 'rolling' | 'custom'. */
  windowMode: string;
  customStartDate: Date | null;
  customEndDate: Date | null;
  asOf: Date;
}

/**
 * The revoked-key-in-use owner notice. Sent to the org's alert
 * recipients (billing contact, else owner/finance members) when a key they
 * revoked is still being presented. Cooldown-gated upstream (one email per
 * org per hour).
 */
export interface SendRevokedKeyInUseOptions {
  to: string;
  /** api_keys.name — the label the owner gave the key. */
  keyLabel: string;
  revokedAt: Date;
  /** Rejected attempts observed in the current cooldown window at send time. */
  attempts: number;
}

/** The create-time confirmation ("your watch is live"). */
export interface SendCustomerAlertConfirmationOptions {
  to: string;
  customerName: string;
  customerId: string;
  metric: string;
  thresholdUsd: number;
  windowMode: string;
  customStartDate: Date | null;
  customEndDate: Date | null;
  asOf: Date;
}
