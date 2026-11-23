/**
 * Invoices Resource
 * Handles invoice retrieval operations
 */

import type { HttpClient } from "../utils/http";
import type {
  InvoiceDetail,
  ListInvoicesParams,
  ListInvoicesResponse,
  SendInvoiceParams,
  SendInvoiceResponse,
} from "../types";
import { validateRequired } from "../utils/validation";

/**
 * Resource for managing invoices
 */
export class InvoicesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List invoices with optional filters
   *
   * @param params - Optional filter parameters
   * @returns Paginated list of invoices
   *
   * @example
   * ```typescript
   * const { invoices, totalResults } = await client.invoices.list({
   *   customerId: 'cust_123',
   *   status: 'issued',
   *   page: 1,
   *   limit: 20
   * });
   * ```
   */
  async list(params?: ListInvoicesParams): Promise<ListInvoicesResponse> {
    return this.http.get<ListInvoicesResponse>(
      "/sdk/invoices",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get a single invoice by ID
   *
   * @param invoiceId - The invoice's ID
   * @returns The invoice with full details including line items and payments
   *
   * @example
   * ```typescript
   * const invoice = await client.invoices.get('inv_abc');
   * console.log(`Invoice ${invoice.invoiceNumber}: ${invoice.totalAmount}`);
   * ```
   */
  async get(invoiceId: string): Promise<InvoiceDetail> {
    validateRequired(invoiceId, "invoiceId");
    return this.http.get<InvoiceDetail>(`/sdk/invoices/${invoiceId}`);
  }

  /**
   * Generate a draft invoice from a subscription's billing period usage events.
   *
   * This is the one-call path from "498 ingested events in April" to "$249 draft invoice
   * with N line items, ready to send." Composes server-side: creates a draft shell, then
   * populates line items + totals by running the period's signal_events through the
   * subscription's pricing strategy. Use this when the line items should come from
   * tracked usage.
   *
   * When `billingPeriodStart` / `billingPeriodEnd` are omitted, the subscription's current
   * billing period is used — that's the right default for cron-style auto-billing and for
   * the dashboard's "Generate from Subscription" button.
   *
   * @param params.customerId - The customer being billed (their MarginFront UUID)
   * @param params.subscriptionId - The subscription whose usage we're invoicing
   * @param params.billingPeriodStart - Optional override; defaults to subscription's current period start
   * @param params.billingPeriodEnd - Optional override; defaults to subscription's current period end
   * @returns The generated draft invoice with line items and totals
   *
   * @example
   * ```typescript
   * const draft = await client.invoices.generate({
   *   customerId: 'cust_abc',
   *   subscriptionId: 'sub_xyz',
   * });
   * console.log(`Draft ${draft.invoiceNumber}: $${draft.totalAmount}`);
   * ```
   */
  async generate(params: {
    customerId: string;
    subscriptionId: string;
    billingPeriodStart?: string | Date;
    billingPeriodEnd?: string | Date;
  }): Promise<InvoiceDetail> {
    validateRequired(params.customerId, "customerId");
    validateRequired(params.subscriptionId, "subscriptionId");
    return this.http.post<InvoiceDetail>("/sdk/invoices/generate", params);
  }

  /**
   * Send an invoice email to the customer with a Stripe Checkout deeplink.
   *
   * Use after `generate()` to deliver a draft (which also auto-finalizes the draft
   * status from "draft" to "issued" as a side effect), or to re-send an already-issued
   * invoice. Customer email defaults to the address stored on the customer record;
   * pass `recipientEmail` to override (e.g. for billing-contact routing).
   *
   * The recipient receives a branded email with line items, total amount, and a
   * "Pay Now" button that opens Stripe Checkout pre-filled with the invoice details.
   * After Stripe confirms payment, the invoice status flips to "paid" automatically
   * via webhook — no extra SDK call needed.
   *
   * @param invoiceId - The invoice's UUID (from `generate()` or `list()`)
   * @param options - Optional overrides. Omit entirely to use stored customer email + defaults.
   * @returns Send confirmation with the Resend message ID and the actual recipient address used
   *
   * @example
   * ```typescript
   * // Generate + send in one go
   * const draft = await client.invoices.generate({
   *   customerId: 'cust_abc',
   *   subscriptionId: 'sub_xyz',
   * });
   * await client.invoices.send(draft.id);
   *
   * // Send to a different email + with a custom note
   * await client.invoices.send('inv_abc', {
   *   recipientEmail: 'billing@customer.example',
   *   subject: "May usage invoice — auto-charged in 5 days",
   *   message: 'See attached. Card on file will be charged automatically.',
   * });
   * ```
   */
  async send(
    invoiceId: string,
    options?: SendInvoiceParams,
  ): Promise<SendInvoiceResponse> {
    validateRequired(invoiceId, "invoiceId");
    return this.http.post<SendInvoiceResponse>(
      `/sdk/invoices/${invoiceId}/send`,
      options ?? {},
    );
  }
}
