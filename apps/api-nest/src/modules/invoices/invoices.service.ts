import { randomUUID } from 'crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { invoiceLineAmount, invoiceSubtotal } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requireFrontendUrl } from '../../common/config/app-config';
import { PdfService } from '../pdf/pdf.service';
import { EmailService } from '../email/email.service';
import { escapeHtml } from '../email/email-encoding.util';
import { resolveOrgBillingContactEmail } from '../../common/utils/billing-contact/billing-contact.utils';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { SubscriptionBillingService } from '../subscription/subscription-billing.service';
import { InvoicePaymentReconciler } from './invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from './invoice-refund-finalizer.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  RecordPaymentDto,
  CreateRefundDto,
  SendInvoiceDto,
  QueryInvoicesDto,
} from './dto/invoice.dto';

const REMINDABLE_INVOICE_STATUSES: (string | null)[] = ['issued', 'pending', 'overdue'];

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly paymentProcessing: PaymentProcessingService,
    private readonly paymentReconciler: InvoicePaymentReconciler,
    private readonly refundFinalizer: InvoiceRefundFinalizer,
    // Owns the usage-billing line-item math that POST /v1/invoices/generate
    // delegates to. See generateInvoice().
    private readonly subscriptionBilling: SubscriptionBillingService,
  ) {}

  /**
   * Fail CLOSED on a missing tenant org BEFORE any org-scoped query runs.
   *
   * Every tenant read below filters by the caller's organizationId. That value
   * comes from the authenticated principal — but one auth path can arrive with
   * it undefined: a Better Auth JWT (validateJwt in combined-auth.guard.ts sets
   * NO organizationId field), or an org-less session (nullable activeOrganizationId).
   * Prisma SILENTLY DROPS any `where` key whose value is undefined, so a filter of
   * `{ id, organizationId: undefined }` would collapse back to `{ id }` (and the
   * relation variants like `{ invoices: { organizationId: undefined } }` collapse
   * to an unconstrained relation filter) — a cross-tenant read. Throwing here
   * guarantees an undefined/null
   * org can never silently disable the filter, regardless of auth method. Same
   * fail-closed precedent the codebase already uses in get-user-id.ts and
   * OrgRoleGuard. NotFoundException keeps the response
   * opaque and uniform with the cross-tenant deny path in these same methods.
   */
  private assertOrgContext(orgId: string): void {
    if (!orgId) {
      throw new NotFoundException('No organization context');
    }
  }

  async getInvoices(orgId: string, query: QueryInvoicesDto) {
    const { page = 1, limit = 10, ...filters } = query;
    const skip = (page - 1) * limit;

    const where: any = { organizationId: orgId };
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.subscriptionId) where.subscriptionId = filters.subscriptionId;

    const [invoices, totalResults] = await Promise.all([
      this.prisma.invoices.findMany({
        where,
        include: {
          customers: { select: { id: true, name: true, email: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoices.count({ where }),
    ]);

    const transformedInvoices = invoices.map((inv: any) => ({
      ...inv,
      customer: inv.customers,
      lineItems: inv.invoice_line_items || [],
      payments: inv.invoice_payments || [],
    }));

    return {
      results: transformedInvoices,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  // INTERNAL (no tenant scope): used by callers that have no caller org — the
  // generateInvoice round-trip read (cron + SDK draft generation). Looks an
  // invoice up by id alone. Never wire this to a tenant HTTP handler; tenant
  // reads must go through the org-scoped getInvoiceById below so one org can't
  // read another org's invoice by guessing an id.
  async getInvoiceByIdInternal(invoiceId: string) {
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: invoiceId },
      include: {
        customers: true,
        // A soft-deleted line is not on the invoice. Checkout already filters
        // them (payment-processing.service.ts), so leaving them in a read makes
        // the invoice a customer sees disagree with the amount they are charged.
        invoice_line_items: { where: { deletedAt: null } },
        invoice_payments: true,
      },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    const lineItems = (invoice as any).invoice_line_items || [];
    return {
      ...invoice,
      customer: (invoice as any).customers,
      lineItems,
      items: lineItems, // Alias for frontend compatibility
      payments: (invoice as any).invoice_payments || [],
    };
  }

  // Tenant-scoped read: only returns the invoice if it belongs to the CALLER's
  // org (orgId comes from the authenticated principal, never from the URL/body).
  // A cross-tenant id 404s.
  async getInvoiceById(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    const invoice = await this.prisma.invoices.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      include: {
        customers: true,
        // A soft-deleted line is not on the invoice. Checkout already filters
        // them (payment-processing.service.ts), so leaving them in a read makes
        // the invoice a customer sees disagree with the amount they are charged.
        invoice_line_items: { where: { deletedAt: null } },
        invoice_payments: true,
      },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    const lineItems = (invoice as any).invoice_line_items || [];
    return {
      ...invoice,
      customer: (invoice as any).customers,
      lineItems,
      items: lineItems, // Alias for frontend compatibility
      payments: (invoice as any).invoice_payments || [],
    };
  }

  async createInvoice(orgId: string, dto: CreateInvoiceDto) {
    const invoiceNumber = `INV-${Date.now()}`;
    const invoiceDate = dto.invoiceDate || new Date();

    const lineItems = dto.lineItems ?? [];

    // Totals are derived here, never trusted from the caller. Same rule as the
    // dashboard's createInvoice Server Action, through the same shared helper,
    // so REST and Server-Action callers produce identical numbers for the same
    // input. `amount` wins when the caller states one: quantity x unitPrice
    // cannot reproduce a blended price, and recomputing it here would turn a
    // $99 credit-pool line into $100.
    const subtotal = invoiceSubtotal(lineItems);
    const taxAmount = dto.taxAmount ?? 0;
    const discountAmount = dto.discountAmount ?? 0;
    const totalAmount = subtotal + taxAmount - discountAmount;

    const now = new Date();

    return this.prisma.invoices.create({
      data: {
        id: this.generateUuid(),
        organizationId: orgId,
        customerId: dto.customerId,
        subscriptionId: dto.subscriptionId || null,
        invoiceDate: invoiceDate,
        dueDate: dto.dueDate,
        billingPeriodStart: dto.billingPeriodStart || invoiceDate,
        billingPeriodEnd: dto.billingPeriodEnd || dto.dueDate,
        status: (dto.status || 'draft') as any,
        invoiceNumber,
        subtotal: String(subtotal),
        totalAmount: String(totalAmount),
        amountDue: String(totalAmount),
        amountPaid: '0',
        amountCredited: '0',
        taxAmount: String(taxAmount),
        discountAmount: String(discountAmount),
        memo: dto.memo || dto.notes || null,
        currency: dto.currency || 'USD',
        createdAt: now,
        updatedAt: now,
        invoice_line_items: {
          create: lineItems.map((item) => ({
            id: this.generateUuid(),
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: invoiceLineAmount(item),
            type: (item.type as any) || 'recurring',
            metadata: (item.metadata ?? {}) as any,
            createdAt: now,
            updatedAt: now,
          })),
        },
      },
      include: {
        invoice_line_items: { where: { deletedAt: null } },
      },
    });
  }

  async updateInvoice(invoiceId: string, orgId: string, dto: UpdateInvoiceDto) {
    this.assertOrgContext(orgId);
    // WRITE-side cross-tenant gate: prisma.update's where must be a
    // UNIQUE key (id only), so we can't filter the update itself by org. Resolve-
    // and-verify ownership first — getInvoiceById 404s a cross-tenant id — then
    // mutate by id. Without this, a money-role caller in org A could edit org B's
    // invoice by guessing its id (OrgRoleGuard only proves the role, not ownership).
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: {
        ...(dto.dueDate && { dueDate: dto.dueDate }),
        ...(dto.notes !== undefined && { memo: dto.notes }),
        updatedAt: new Date(),
      },
    });
  }

  async finalizeInvoice(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — verify the target invoice belongs to the caller's
    // org before flipping its status. See updateInvoice for the resolve-then-update
    // rationale. The internal caller (sendInvoiceEmail) passes its own verified org.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { status: 'issued', updatedAt: new Date() },
    });
  }

  async markAsPaid(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — confirm ownership before marking paid.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { status: 'paid', updatedAt: new Date() },
    });
  }

  async voidInvoice(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — confirm ownership before voiding.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { status: 'void', updatedAt: new Date() },
    });
  }

  /**
   * Record a manual (offline) payment against an invoice.
   *
   * All invoice monetary state transitions flow through
   * InvoicePaymentReconciler. Reconciler is transactional and atomically
   * updates the invoice row. Concurrent recordPayment calls can't race.
   */
  async recordPayment(invoiceId: string, orgId: string, dto: RecordPaymentDto) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — verify the target invoice belongs to the caller's
    // org BEFORE the reconciler records money against it. The reconciler updates by
    // invoiceId with no org filter, so the ownership check has to happen here, not
    // there. (The Stripe webhook path calls paymentReconciler.recordPayment
    // directly — webhooks.service.ts — and is correctly NOT gated by this.)
    await this.getInvoiceById(invoiceId, orgId);
    const result = await this.paymentReconciler.recordPayment({
      invoiceId,
      paymentAmount: dto.amount,
      paymentRecord: {
        paymentMethod: 'other',
        status: 'succeeded',
        provider_transaction_id: dto.transactionId || null,
        notes: dto.notes || null,
        paymentDate: new Date(),
      },
    });

    // Callers expect the invoice_payments row shape, not the reconciler's
    // result object.
    const payment = await this.prisma.invoice_payments.findUnique({
      where: { id: result.paymentId },
    });
    return payment;
  }

  async getInvoicePayments(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // invoice_payments has no org column, so confirm the parent invoice belongs
    // to the caller's org first — cross-tenant ids 404 here instead of returning
    // another org's payments.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoice_payments.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // INTERNAL (no tenant scope): used by createRefund (a write), which already
  // arrives via an org-gated controller route and only needs the raw payment row.
  // Looks a payment up by id alone — never wire this to a tenant read handler.
  async getPaymentInternal(paymentId: string) {
    const payment = await this.prisma.invoice_payments.findUnique({
      where: { id: paymentId },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  // Tenant-scoped read: only returns the payment if its parent invoice belongs
  // to the caller's org. A cross-tenant payment id 404s.
  async getPayment(paymentId: string, orgId: string) {
    this.assertOrgContext(orgId);
    const payment = await this.prisma.invoice_payments.findFirst({
      where: { id: paymentId, invoices: { organizationId: orgId } },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * Create a refund against a prior payment.
   *
   * For manual (offline) refunds, the invoice + payment state transition is
   * delegated to InvoiceRefundFinalizer, whose declarative state machine
   * handles multi-payment invoices.
   *
   * For provider-backed refunds, this method still creates the pending
   * `refunds` row synchronously; the provider webhook later triggers
   * Finalizer via handleRefundCompleted to flip the row to 'succeeded' and
   * apply the invoice-level math.
   */
  async createRefund(paymentId: string, orgId: string, dto: CreateRefundDto) {
    // Cross-tenant write gate — resolve the payment through the org-scoped lookup
    // (asserts org context + 404s a cross-tenant paymentId) so a money-role caller
    // in org A can't refund org B's payment by guessing its id.
    const payment = await this.getPayment(paymentId, orgId);

    const refundAmountDollars = dto.amount ?? parseFloat(String(payment.amount || '0'));

    // A provider transaction means the money moves back through the provider.
    // A manual/offline payment's refund is only recorded in the database.
    const hasProviderTransaction = !!payment.provider_transaction_id;

    if (hasProviderTransaction) {
      // Provider-backed payment: call the provider's refund API.
      // This hits Stripe to actually move the money back.
      // We create the DB record with status='pending' and wait for the
      // webhook confirmation to flip it to 'succeeded'. When the webhook
      // arrives, InvoiceRefundFinalizer updates this pending row and
      // reconciles the invoice.
      try {
        // In the payment's own currency. PaymentProcessingService converts to
        // the provider's minor unit using the currency on the payment row —
        // scaling here would have to guess at it.
        const providerResult = await this.paymentProcessing.createRefund(
          payment.provider_transaction_id!,
          refundAmountDollars,
          dto.reason || undefined,
        );

        this.logger.log(
          `Provider refund initiated: ${providerResult.id} for payment ${paymentId}. ` +
            `amount: ${refundAmountDollars}, status: ${providerResult.status}`,
        );

        return this.prisma.refunds.create({
          data: {
            id: this.generateUuid(),
            invoice_payment_id: paymentId,
            amount: String(refundAmountDollars),
            reason: dto.reason || null,
            // Stays pending until the provider webhook confirms it.
            status: 'pending',
            provider_refund_id: providerResult.id,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      } catch (error) {
        this.logger.error(`Refund failed for payment ${paymentId}: ${error.message}`, error.stack);
        throw new BadRequestException(
          `Refund failed: ${error.message}. ` +
            'The payment provider rejected the refund request. ' +
            'Check that the payment is still eligible for refund.',
        );
      }
    }

    // Manual/offline payment: no provider to call. Finalizer creates the
    // refunds row + updates the invoice in one transaction.
    this.logger.log(
      `Recording manual refund for payment ${paymentId}. amount: ${refundAmountDollars}`,
    );

    const result = await this.refundFinalizer.finalizeRefund({
      paymentId,
      refundAmount: refundAmountDollars,
      refundRecord: {
        reason: dto.reason || null,
      },
    });

    // The response is the refunds row, not the Finalizer result.
    return this.prisma.refunds.findUnique({ where: { id: result.refundId } });
  }

  async getPaymentRefunds(paymentId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // refunds has no org column, so confirm the payment (and through it the
    // parent invoice) belongs to the caller's org — cross-tenant 404s here.
    await this.getPayment(paymentId, orgId);
    return this.prisma.refunds.findMany({
      where: { invoice_payment_id: paymentId },
      orderBy: { created_at: 'desc' },
    });
  }

  async sendInvoiceEmail(
    invoiceId: string,
    orgId: string,
    dto: SendInvoiceDto,
    options: { reminder?: boolean } = {},
  ) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — scope the lookup to the caller's org (findFirst +
    // organizationId) so a cross-tenant id falls through to the NotFound below
    // instead of emailing another org's invoice. NOT getInvoiceById here: this path
    // needs the `organizations` relation for branding, which that helper omits.
    const invoice = await this.prisma.invoices.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      include: {
        customers: true,
        organizations: true,
        invoice_line_items: { where: { deletedAt: null } },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    const customer = invoice.customers;
    const organization = invoice.organizations;

    if (!customer) {
      throw new NotFoundException('Customer not found for this invoice');
    }

    if (!organization) {
      throw new NotFoundException('Organization not found for this invoice');
    }

    if (!this.emailService.isEnabled) {
      throw new ServiceUnavailableException(
        'Email is turned off on this server (RESEND_API_KEY is not set), so the invoice was ' +
          'not emailed and nothing was changed. Ask the operator to set RESEND_API_KEY and ' +
          'RESEND_FROM_EMAIL on the API, or send the customer the payment link another way.',
      );
    }

    const recipientEmail = dto.recipientEmail || dto.email || customer.email;

    if (!recipientEmail) {
      throw new BadRequestException('No recipient email address available');
    }

    const formatAmount = (amount: any): string => {
      const num = parseFloat(amount) || 0;
      const currency = invoice.currency || 'USD';
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
      }).format(num);
    };

    const formatEmailDate = (date: any): string => {
      if (!date) return '—';
      return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    };

    // Manual-send emails drop the customer straight onto Stripe Checkout via
    // `/i/{id}/pay`, a thin dashboard route handler that mints a fresh Checkout
    // Session server-side. Stripe sends its own receipt.
    const payInvoiceUrl = `${requireFrontendUrl(this.configService)}/i/${invoice.id}/pay`;

    const billingContactEmail = resolveOrgBillingContactEmail(organization);

    const designJson = (organization as any).designjson as Record<string, any> | null;
    const brandColor = designJson?.headerColor || '#0f172a';
    const logoUrl = organization.logo || null;

    const customMessageHtml = dto.message
      ? `<tr><td style="padding: 0 0 24px 0;"><p style="margin: 0; padding: 16px; background-color: #fafafa; border-radius: 6px; color: #525252; font-size: 14px; line-height: 1.6;">${escapeHtml(dto.message)}</p></td></tr>`
      : '';

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Invoice ${escapeHtml(invoice.invoiceNumber)} from ${escapeHtml(organization.name)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  <!-- Preview Text -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    Invoice ${escapeHtml(invoice.invoiceNumber)} for ${formatAmount(invoice.totalAmount)} from ${escapeHtml(organization.name)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #ffffff;">
    <tr>
      <td align="center" style="padding: 48px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 520px;">

          <!-- Logo -->
          <tr>
            <td style="padding: 0 0 40px 0;">
              ${
                logoUrl
                  ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(organization.name)}" style="height: 32px; width: auto; display: block;">`
                  : `<span style="font-size: 20px; font-weight: 600; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(organization.name)}</span>`
              }
            </td>
          </tr>

          <!-- Invoice Header -->
          <tr>
            <td style="padding: 0 0 32px 0; border-bottom: 1px solid #e5e5e5;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
                <tr>
                  <td>
                    <p style="margin: 0 0 4px 0; font-size: 13px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">Invoice</p>
                    <p style="margin: 0; font-size: 24px; font-weight: 600; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(invoice.invoiceNumber)}</p>
                  </td>
                  <td style="text-align: right; vertical-align: bottom;">
                    <p style="margin: 0; font-size: 32px; font-weight: 700; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatAmount(invoice.totalAmount)}</p>
                    <p style="margin: 4px 0 0 0; font-size: 13px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${invoice.status === 'paid' ? 'Paid' : `Due ${formatEmailDate(invoice.dueDate)}`}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 32px 0 0 0;">
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                Hi${customer.name ? ` ${escapeHtml(customer.name.split(' ')[0])}` : ''},
              </p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                ${
                  invoice.status === 'paid'
                    ? `Thanks for your payment. Here's your receipt from ${escapeHtml(organization.name)}.`
                    : `Here's invoice <strong style="color: #171717;">${escapeHtml(invoice.invoiceNumber)}</strong> from ${escapeHtml(organization.name)} for <strong style="color: #171717;">${formatAmount(invoice.totalAmount)}</strong>.`
                }
              </p>
            </td>
          </tr>

          <!-- Custom Message -->
          ${customMessageHtml}

          <!-- Invoice Details Card -->
          <tr>
            <td style="padding: 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #fafafa; border-radius: 8px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
                      <tr>
                        <td style="padding: 0 0 16px 0;">
                          <p style="margin: 0 0 2px 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">Billed to</p>
                          <p style="margin: 0; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 500;">${escapeHtml(customer.name || customer.email)}</p>
                          <p style="margin: 2px 0 0 0; font-size: 13px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(customer.email)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0 0 0; border-top: 1px solid #e5e5e5;">
                          <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
                            <tr>
                              <td style="width: 50%; vertical-align: top;">
                                <p style="margin: 0 0 2px 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">Invoice date</p>
                                <p style="margin: 0; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatEmailDate(invoice.invoiceDate)}</p>
                              </td>
                              <td style="width: 50%; vertical-align: top;">
                                <p style="margin: 0 0 2px 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">${invoice.status === 'paid' ? 'Paid on' : 'Due date'}</p>
                                <p style="margin: 0; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatEmailDate(invoice.status === 'paid' ? invoice.updatedAt : invoice.dueDate)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      ${
                        invoice.billingPeriodStart && invoice.billingPeriodEnd
                          ? `
                      <tr>
                        <td style="padding: 16px 0 0 0;">
                          <p style="margin: 0 0 2px 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">Billing period</p>
                          <p style="margin: 0; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatEmailDate(invoice.billingPeriodStart)} – ${formatEmailDate(invoice.billingPeriodEnd)}</p>
                        </td>
                      </tr>
                      `
                          : ''
                      }
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${
            // Itemized line items, so the customer sees what they're paying
            // for. Skipped for one-off invoices with no breakdown.
            invoice.invoice_line_items && invoice.invoice_line_items.length > 0
              ? `
          <tr>
            <td style="padding: 8px 0 24px 0;">
              <p style="margin: 0 0 12px 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">What you're paying for</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden;">
                <thead>
                  <tr style="background-color: #fafafa;">
                    <th style="padding: 12px 16px; text-align: left; font-size: 12px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Description</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 12px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Qty</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 12px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Unit</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 12px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${invoice.invoice_line_items
                    .map(
                      (li) => `
                  <tr style="border-top: 1px solid #f0f0f0;">
                    <td style="padding: 12px 16px; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(li.description)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${Number(li.quantity)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatAmount(li.unitPrice)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 500;">${formatAmount(li.amount)}</td>
                  </tr>`,
                    )
                    .join('')}
                  <tr style="border-top: 2px solid #e5e5e5; background-color: #fafafa;">
                    <td colspan="3" style="padding: 12px 16px; text-align: right; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600;">Total</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 700;">${formatAmount(invoice.totalAmount)}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
          `
              : ''
          }

          ${
            // Pay button for unpaid invoices only. A paid invoice has no payable
            // link and there is no hosted invoice page to view.
            invoice.status !== 'paid'
              ? `
          <tr>
            <td style="padding: 8px 0 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(payInvoiceUrl)}" style="display: inline-block; background-color: ${escapeHtml(brandColor)}; color: #ffffff; padding: 14px 28px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                      Pay Invoice
                    </a>
                    <p style="margin: 12px 0 0 0; font-size: 12px; color: #737373; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                      Secure checkout powered by your payment provider.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          `
              : ''
          }

          <!-- Footer -->
          <tr>
            <td style="padding: 32px 0 0 0; border-top: 1px solid #e5e5e5;">
              <p style="margin: 0 0 8px 0; font-size: 13px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                Questions? ${
                  billingContactEmail
                    ? `Contact us at <a href="mailto:${escapeHtml(billingContactEmail)}" style="color: #171717; text-decoration: underline;">${escapeHtml(billingContactEmail)}</a>`
                    : `Contact ${escapeHtml(organization.name)}`
                }
              </p>
              <p style="margin: 0; font-size: 12px; color: #a3a3a3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                ${escapeHtml(organization.name)}${organization.address_line1 ? ` · ${escapeHtml(organization.address_line1)}` : ''}${organization.city ? `, ${escapeHtml(organization.city)}` : ''}${organization.state ? ` ${escapeHtml(organization.state)}` : ''}${organization.zip_code ? ` ${escapeHtml(organization.zip_code)}` : ''}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const invoiceSubject =
      dto.subject || `Invoice ${invoice.invoiceNumber} from ${organization.name}`;
    const emailSubject = options.reminder ? `Reminder: ${invoiceSubject}` : invoiceSubject;

    try {
      const result = await this.emailService.sendEmail({
        to: recipientEmail,
        subject: emailSubject,
        html: htmlContent,
        from: this.emailService.invoiceFromEmail,
      });

      this.logger.log(
        `Invoice email sent successfully to ${recipientEmail} for invoice ${invoice.invoiceNumber}`,
      );

      // Finalize invoice if it's still a draft. Ownership was already verified by
      // the org-scoped lookup above, so passing orgId here can't fail.
      if (invoice.status === 'draft') {
        await this.finalizeInvoice(invoiceId, orgId);
      }

      return {
        success: true,
        message: 'Invoice email sent successfully',
        emailId: result?.id || null,
        recipientEmail,
      };
    } catch (error) {
      this.logger.error(`Failed to send invoice email to ${recipientEmail}:`, error);
      throw new BadRequestException(`Failed to send invoice email: ${error.message}`);
    }
  }

  async getInvoicePdf(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Returns no PDF: pdfUrl is always null here. Tenant /pdf endpoint, so the
    // lookup must be org-scoped.
    const invoice = await this.getInvoiceById(invoiceId, orgId);
    return {
      message: 'PDF generation not yet implemented',
      invoiceId: invoice.id,
      pdfUrl: null,
    };
  }

  async getEnhancedPayments(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // invoice_payments has no org column — confirm the parent invoice belongs to
    // the caller's org first (cross-tenant 404s) before returning payments.
    await this.getInvoiceById(invoiceId, orgId);
    const payments = await this.prisma.invoice_payments.findMany({
      where: { invoiceId },
      include: {
        refunds: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return payments;
  }

  async getReminderStatus(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    const invoice = await this.getInvoiceById(invoiceId, orgId);

    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : new Date();
    const now = new Date();
    const diffTime = dueDate.getTime() - now.getTime();
    const daysFromDue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const isOverdue = daysFromDue < 0;

    let reminderStage = 'none';
    if (isOverdue) {
      const absOverdue = Math.abs(daysFromDue);
      if (absOverdue <= 3) reminderStage = 'post_due_1';
      else if (absOverdue <= 7) reminderStage = 'post_due_2';
      else if (absOverdue <= 14) reminderStage = 'post_due_3';
      else reminderStage = 'escalated';
    } else if (daysFromDue <= 3) {
      reminderStage = 'pre_due_1';
    } else if (daysFromDue === 0) {
      reminderStage = 'pre_due_2';
    }

    const reminderPaused = (invoice as any).reminderPaused || false;
    const nextReminderDate = reminderPaused
      ? null
      : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    return {
      invoiceId: invoice.id,
      status: invoice.status,
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toISOString() : null,
      daysFromDue,
      isOverdue,
      reminderStage,
      reminderCount: (invoice as any).reminderCount || 0,
      lastReminderSentAt: (invoice as any).lastReminderSentAt || null,
      nextReminderDate,
      reminderPaused,
      escalatedAt: reminderStage === 'escalated' ? (invoice as any).escalatedAt || null : null,
      escalationReason: reminderStage === 'escalated' ? 'Invoice significantly overdue' : null,
      pauseReason: (invoice as any).pauseReason || null,
      lastManualReminderAt: (invoice as any).lastManualReminderAt || null,
    };
  }

  async pauseReminders(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — confirm ownership before pausing reminders.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { reminderPaused: true, updatedAt: new Date() },
    });
  }

  async resumeReminders(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — confirm ownership before resuming reminders.
    await this.getInvoiceById(invoiceId, orgId);
    return this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { reminderPaused: false, updatedAt: new Date() },
    });
  }

  async sendManualReminder(invoiceId: string, orgId: string) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — confirm ownership before sending a reminder.
    const invoice = await this.getInvoiceById(invoiceId, orgId);
    if (!REMINDABLE_INVOICE_STATUSES.includes(invoice.status)) {
      throw new BadRequestException(
        `Invoice ${invoice.invoiceNumber} is ${invoice.status ?? 'in an unknown state'}, so there ` +
          'is nothing to remind the customer about. Reminders can only be sent for issued, ' +
          'pending or overdue invoices.',
      );
    }

    const sent = await this.sendInvoiceEmail(invoiceId, orgId, {}, { reminder: true });
    await this.prisma.invoices.update({
      where: { id: invoiceId },
      data: { lastReminderSentAt: new Date(), updatedAt: new Date() },
    });

    return {
      message: `Reminder emailed to ${sent.recipientEmail}`,
      emailSent: true,
      emailId: sent.emailId,
      recipientEmail: sent.recipientEmail,
    };
  }

  /**
   * Build a real draft invoice from a subscription's actual usage events in a billing period.
   *
   * Composition over reinvention: createUsageDraftInvoice creates an empty draft shell;
   * updateUsageDraftInvoice pulls the period's signal_events, runs them through the
   * subscription's pricing strategy, writes invoice_line_items rows, and stamps the
   * computed totals on the invoice. Both methods live in SubscriptionBillingService; this
   * exposes them to REST.
   *
   * When billingPeriodStart/End are omitted, the subscription's currentBillingPeriodStart/End
   * are used. That's the right default for cron-driven "bill this period" flows and for the
   * dashboard's "Generate from Subscription" button.
   *
   * The result is a DRAFT (status='draft'). It stays a draft until someone sends it
   * from the invoice detail page.
   */
  async generateInvoice(
    customerId: string,
    subscriptionId: string,
    billingPeriodStart?: Date,
    billingPeriodEnd?: Date,
    orgId?: string,
  ) {
    // Cross-tenant WRITE. generateInvoice persists a draft invoice
    // INSIDE subscription.organizationId, so the subscription lookup IS the tenant
    // boundary for this write. Two caller shapes:
    //   • TENANT callers (public POST /v1/invoices/generate + the SDK route) pass
    //     the caller's org from the authenticated principal (user.organizationId).
    //     We assert it is present — fail closed, because a blank/undefined org would
    //     let Prisma silently drop the organizationId filter, then resolve the
    //     subscription ORG-SCOPED, so a money-role user in org A can't bill against
    //     org B's subscriptionId (it 404s).
    //   • The CRON_SECRET system path (generateInvoiceInternal handler) carries NO
    //     tenant org and passes orgId === undefined; it keeps the unscoped by-id
    //     lookup, mirroring getInvoiceByIdInternal for cron/system callers.
    const scoped = orgId !== undefined;
    if (scoped) {
      this.assertOrgContext(orgId as string);
    }

    const subscription = scoped
      ? await this.prisma.subscriptions.findFirst({
          where: { id: subscriptionId, organizationId: orgId },
          include: { pricing_plans: true },
        })
      : await this.prisma.subscriptions.findUnique({
          where: { id: subscriptionId },
          include: { pricing_plans: true },
        });

    if (!subscription) {
      throw new NotFoundException(`Subscription ${subscriptionId} not found`);
    }
    if (!subscription.organizationId) {
      throw new NotFoundException(
        `Subscription ${subscriptionId} has no organization — cannot bill`,
      );
    }
    if (subscription.customerId !== customerId) {
      throw new BadRequestException(
        `Customer ${customerId} does not own subscription ${subscriptionId}`,
      );
    }

    // Allow callers to bill a non-current period (e.g. re-billing March in May). When the
    // caller doesn't override, fall through to whatever the subscription currently says is
    // the active period.
    const subscriptionForBilling = {
      ...subscription,
      ...(billingPeriodStart && { currentBillingPeriodStart: billingPeriodStart }),
      ...(billingPeriodEnd && { currentBillingPeriodEnd: billingPeriodEnd }),
    };

    // Step 1: create the empty draft shell.
    const draft = await this.subscriptionBilling.createUsageDraftInvoice(subscriptionForBilling);

    // Step 2: populate line items + totals from real signal_events in the period.
    await this.subscriptionBilling.updateUsageDraftInvoice(draft, subscriptionForBilling);

    // Round-trip read so the response carries the full nested shape (line_items, customer,
    // payments) that the dashboard + portal already expect from getInvoiceById.
    // Uses the INTERNAL (unscoped) read: generateInvoice is reached by the CRON_SECRET
    // endpoint and the SDK controller, neither of which carries a tenant org. This call
    // created the draft, so re-reading it by id alone is safe; the org-scoped variant
    // would 404 the cron/SDK callers on their own freshly-created invoice.
    return this.getInvoiceByIdInternal(draft.id);
  }

  private generateUuid(): string {
    return randomUUID();
  }
}
