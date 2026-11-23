import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requireFrontendUrl } from '../../common/config/app-config';
import { InvoiceCalculatorService } from '../invoice-calculator/invoice-calculator.service';
import { PdfService } from '../pdf/pdf.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { EmailService } from '../email/email.service';
import { calculateBillingPeriod } from '../../common/utils/date/date.utils';
import {
  generateInvoice,
  createDraftInvoice,
  generateIssuedUsageInvoiceNumber,
  findDraftInvoices,
  findOverdueInvoices,
  createOrUpdateInvoiceLineItems,
} from '../../common/utils/invoice/invoice.utils';
import { resolveOrgBillingContactEmail } from '../../common/utils/billing-contact/billing-contact.utils';
// Credit-pool grant minting at activation + dispatch post-commit.
import { mintPeriodGrant } from '@marginfront/db';
import { DateTime } from 'luxon';
import { PrismaClient } from '@prisma/client';

/**
 * Internal sentinel thrown inside the dispatch per-sub transaction to
 * abort + roll back WITHOUT recording it as an error. The one legitimate non-error
 * reason to bail mid-transaction:
 *   - 'concurrent'   : a simultaneous dispatch run already claimed + advanced this
 *                      sub (double-fire idempotency guard), so we discard our work.
 * Throwing rolls back every write in the transaction; the caller catches this,
 * classifies it as a skip (not a failure), and moves on.
 *
 * NOTE: a period with no billable usage is NOT a DispatchSkip. We must still advance
 * the period in that case (see dispatchUsageInvoices step 3'/5) — rolling back on
 * zero usage would freeze the subscription forever, since dispatch is the only thing
 * that moves `nextUsageInvoiceAt`. So zero-usage commits (period advanced, no invoice).
 */
class DispatchSkip extends Error {
  constructor(public readonly reason: 'concurrent') {
    super(`dispatch-skip:${reason}`);
    this.name = 'DispatchSkip';
  }
}

/**
 * Service for managing subscription billing, periods, and invoices
 * Centralizes logic for consistent handling across cron jobs
 */
@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceCalculator: InvoiceCalculatorService,
    private readonly pdfService: PdfService,
    private readonly paymentProcessingService: PaymentProcessingService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Calculate billing period and issuance date for a subscription
   * @param params - Calculation parameters
   * @param params.subscription - Subscription object containing billing details
   * @param params.startDate - Start date for the calculation
   * @returns Object containing billing period dates and invoice issuance date
   */
  calculateBillingPeriodAndDates(params: { subscription: any; startDate: Date }): {
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
    subscriptionInvoiceIssuanceDate: Date;
  } {
    const { subscription, startDate } = params;
    const timezone = subscription.timezone || 'UTC';

    const validStartDate =
      startDate instanceof Date && !isNaN(startDate.getTime()) ? startDate : new Date();

    const period = calculateBillingPeriod({
      startDate: validStartDate,
      billingCycle: subscription.billingCycle || 'monthly',
      customCycleDays: subscription.customCycleDays,
      timezone,
    });

    let startDt = DateTime.fromJSDate(validStartDate).setZone(timezone);

    if (!startDt.isValid) {
      this.logger.warn(`Invalid timezone "${timezone}", falling back to UTC`);
      startDt = DateTime.fromJSDate(validStartDate).setZone('UTC');
    }

    const effectiveBillingDay = subscription.billingDay || startDt.day || 1;

    // For the first period, use the billing day in the current period if possible
    let issuanceDt = startDt.set({ day: effectiveBillingDay });

    // If the billing day already passed this month or is invalid for this month,
    // move to the next period's first day
    if (!issuanceDt.isValid || issuanceDt < startDt) {
      issuanceDt = startDt.plus({ months: 1 }).set({ day: 1 });
      // Try to set to the billing day, fallback to last day of month if invalid
      const daysInMonth = issuanceDt.daysInMonth || 28;
      const effectiveDay = Math.min(effectiveBillingDay, daysInMonth);
      issuanceDt = issuanceDt.set({ day: effectiveDay });
    }

    if (!issuanceDt.isValid) {
      this.logger.warn('Issuance date calculation failed, using startDate + 30 days');
      issuanceDt = startDt.plus({ days: 30 });
    }

    return {
      billingPeriodStart: period.billingPeriodStart,
      billingPeriodEnd: period.billingPeriodEnd,
      subscriptionInvoiceIssuanceDate: issuanceDt.toUTC().toJSDate(),
    };
  }

  /**
   * Activate a subscription when its start date arrives
   * @param subscription - Subscription to activate
   * @param transaction - Prisma transaction client
   * @returns Updated subscription
   */
  async activateSubscription(subscription: any, transaction?: PrismaClient): Promise<any> {
    const client = transaction || this.prisma;
    const startDate = subscription.startDate;

    const { billingPeriodStart, billingPeriodEnd, subscriptionInvoiceIssuanceDate } =
      this.calculateBillingPeriodAndDates({
        subscription,
        startDate,
      });

    const updates = {
      status: 'active' as any,
      currentBillingPeriodStart: billingPeriodStart,
      currentBillingPeriodEnd: billingPeriodEnd,
      subscriptionInvoiceIssuanceDate,
      updatedAt: new Date(),
    };

    const updated = await client.subscriptions.update({
      where: { id: subscription.id },
      data: updates,
    });

    this.logger.log(`Activated subscription ${subscription.id}`);

    await this.createInitialDraftInvoices(updated, transaction);

    // Mint on this.prisma, NOT the caller's transaction — a caught
    // failed write inside an open tx aborts the whole tx in Postgres. That tx
    // may not have committed the period fields yet, so the just-computed
    // period is passed explicitly. Non-fatal; lazy mint is the safety net.
    try {
      const mint = await mintPeriodGrant(this.prisma, {
        subscriptionId: updated.id,
        createdBy: 'activation',
        subscription: {
          id: updated.id,
          organizationId: updated.organizationId ?? null,
          planId: updated.planId,
          currentBillingPeriodStart: billingPeriodStart,
          currentBillingPeriodEnd: billingPeriodEnd,
        },
      });
      if (mint.minted) {
        this.logger.log(
          `Minted credit-pool grant for activated subscription ${updated.id}: ${mint.amountUnits} units`,
        );
      }
    } catch (mintError) {
      const message = mintError instanceof Error ? mintError.message : String(mintError);
      this.logger.error(
        `Credit-pool mint failed for activated subscription ${updated.id} (non-fatal, lazy mint covers): ${message}`,
      );
    }

    return updated;
  }

  /**
   * Create initial draft invoices for a newly activated subscription
   * @param subscription - Active subscription
   * @param transaction - Prisma transaction client
   */
  async createInitialDraftInvoices(subscription: any, transaction?: PrismaClient): Promise<void> {
    if (subscription.billingModel !== 'usage') {
      await this.createSubscriptionDraftInvoice(subscription, transaction);
    }

    if (subscription.billingModel !== 'subscription') {
      await this.createUsageDraftInvoice(subscription, transaction);
    }
  }

  /**
   * End a subscription that has reached its end date
   * @param subscription - Subscription to end
   * @param transaction - Prisma transaction client
   * @returns Updated subscription
   */
  async endSubscription(subscription: any, transaction?: PrismaClient): Promise<any> {
    const client = transaction || this.prisma;

    const updated = await client.subscriptions.update({
      where: { id: subscription.id },
      data: {
        status: 'ended' as any,
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Ended subscription ${subscription.id}`);
    return updated;
  }

  /**
   * Create a subscription draft invoice
   * @param subscription - Subscription to create draft for
   * @param transaction - Prisma transaction client
   * @returns Generated draft invoice
   */
  async createSubscriptionDraftInvoice(
    subscription: any,
    transaction?: PrismaClient,
  ): Promise<any> {
    const client = transaction || this.prisma;

    try {
      const { currentBillingPeriodStart, currentBillingPeriodEnd } = subscription;

      if (!currentBillingPeriodStart || !currentBillingPeriodEnd) {
        throw new Error(`Subscription ${subscription.id} missing billing period dates`);
      }

      const isNewSubscription = subscription.cycleNumber === 0;
      const calcResult = await this.invoiceCalculator.calculateInvoice({
        subscriptionId: subscription.id,
        billingPeriodStart: currentBillingPeriodStart,
        billingPeriodEnd: currentBillingPeriodEnd,
        isNewSubscription,
        invoiceType: 'subscription',
        transaction: client as any,
      });

      const _invoiceDate = subscription.subscriptionInvoiceIssuanceDate;

      const invoice = await generateInvoice(
        {
          subscription,
          calculationResult: calcResult.calculationDetails,
          invoiceType: 'subscription',
          status: 'draft',
          transaction: client as any,
        },
        client as any,
      );

      await client.subscriptions.update({
        where: { id: subscription.id },
        data: {
          currentSubscriptionDraftInvoiceId: invoice.id,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Created subscription draft invoice for subscription ${subscription.id}`);
      return invoice;
    } catch (error) {
      this.logger.error(`Error creating subscription draft for ${subscription.id}:`, error);
      throw error;
    }
  }

  /**
   * Issue a subscription draft invoice
   * @param invoice - Draft invoice to issue
   * @param subscription - Related subscription
   * @param transaction - Prisma transaction client
   * @returns Issued invoice
   */
  async issueSubscriptionInvoice(
    invoice: any,
    subscription: any,
    transaction?: PrismaClient,
  ): Promise<any> {
    const client = transaction || this.prisma;

    try {
      const now = new Date();
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + (subscription.netTerms || 30));

      const updated = await client.invoices.update({
        where: { id: invoice.id },
        data: {
          status: 'issued' as any,
          invoiceDate: now,
          dueDate,
          updatedAt: new Date(),
        },
      });

      // Generate PDF for the invoice
      const calcResult = await this.invoiceCalculator.calculateInvoice({
        subscriptionId: subscription.id,
        billingPeriodStart: invoice.billingPeriodStart,
        billingPeriodEnd: invoice.billingPeriodEnd,
        invoiceType: 'subscription',
        transaction: client as any,
      });

      await this.generatePDFForInvoice(updated, calcResult.calculationDetails, transaction);

      await this.advanceCycleAfterSubscriptionInvoice(subscription, transaction);

      this.logger.log(
        `Issued subscription invoice ${invoice.id} for subscription ${subscription.id}`,
      );
      return updated;
    } catch (error) {
      this.logger.error(`Error issuing subscription invoice ${invoice.id}:`, error);
      throw error;
    }
  }

  /**
   * Create a usage draft invoice
   * @param subscription - Subscription to create draft for
   * @param transaction - Prisma transaction client
   * @returns Generated draft invoice
   */
  async createUsageDraftInvoice(subscription: any, transaction?: PrismaClient): Promise<any> {
    const client = transaction || this.prisma;

    try {
      const { currentBillingPeriodStart, currentBillingPeriodEnd } = subscription;

      if (!currentBillingPeriodStart || !currentBillingPeriodEnd) {
        throw new Error(`Subscription ${subscription.id} missing billing period dates`);
      }

      const invoice = await createDraftInvoice(
        {
          subscription,
          billingPeriodStart: currentBillingPeriodStart,
          billingPeriodEnd: currentBillingPeriodEnd,
          transaction: client as any,
          invoiceDate: currentBillingPeriodEnd,
          dueDate: currentBillingPeriodEnd,
        },
        client as any,
      );

      await client.subscriptions.update({
        where: { id: subscription.id },
        data: {
          currentUsageDraftInvoiceId: invoice.id,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Created usage draft invoice for subscription ${subscription.id}`);
      return invoice;
    } catch (error) {
      this.logger.error(`Error creating usage draft for ${subscription.id}:`, error);
      throw error;
    }
  }

  /**
   * Update a usage draft invoice with latest usage data
   * @param invoice - Draft invoice to update
   * @param subscription - Related subscription
   * @param transaction - Prisma transaction client
   * @returns Updated invoice
   */
  async updateUsageDraftInvoice(
    invoice: any,
    subscription: any,
    transaction?: PrismaClient,
  ): Promise<any> {
    const client = transaction || this.prisma;

    try {
      const calcResult = await this.invoiceCalculator.calculateInvoice({
        subscriptionId: subscription.id,
        billingPeriodStart: invoice.billingPeriodStart,
        billingPeriodEnd: invoice.billingPeriodEnd,
        invoiceType: 'usage',
        transaction: client as any,
      });

      await createOrUpdateInvoiceLineItems(
        invoice,
        calcResult.calculationDetails,
        client as any,
        true,
      );

      const updated = await client.invoices.update({
        where: { id: invoice.id },
        data: {
          subtotal: String(calcResult.calculationDetails.subtotal),
          totalAmount: String(calcResult.calculationDetails.total),
          amountDue: String(calcResult.calculationDetails.total),
          lastUsageUpdateAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Updated usage draft invoice ${invoice.id} for subscription ${subscription.id}`,
      );
      return updated;
    } catch (error) {
      this.logger.error(`Error updating usage draft ${invoice.id}:`, error);
      throw error;
    }
  }

  /**
   * Update subscription after issuing a subscription invoice
   * @param subscription - Subscription to update
   * @param transaction - Prisma transaction client
   * @returns Updated subscription
   */
  async advanceCycleAfterSubscriptionInvoice(
    subscription: any,
    transaction?: PrismaClient,
  ): Promise<any> {
    const client = transaction || this.prisma;

    const cycleNumber = subscription.cycleNumber + 1;

    const timezone = subscription.timezone || 'UTC';
    const currentDate = DateTime.fromJSDate(
      subscription.subscriptionInvoiceIssuanceDate || new Date(),
    ).setZone(timezone);

    const billingDay = subscription.billingDay || currentDate.day;
    let nextIssuanceDt: DateTime;

    switch (subscription.billingCycle) {
      case 'yearly':
        nextIssuanceDt = currentDate.plus({ years: 1 });
        break;
      case 'custom':
        if (subscription.customCycleDays && subscription.customCycleDays > 0) {
          nextIssuanceDt = currentDate.plus({ days: subscription.customCycleDays });
        } else {
          nextIssuanceDt = currentDate.plus({ months: 1 });
        }
        break;
      case 'monthly':
      default:
        nextIssuanceDt = currentDate.plus({ months: 1 });
        break;
    }

    if (subscription.billingCycle !== 'custom') {
      // Handle month length differences
      const daysInMonth = nextIssuanceDt.daysInMonth;
      const effectiveDay = Math.min(billingDay, daysInMonth);
      nextIssuanceDt = nextIssuanceDt.set({ day: effectiveDay });
    }

    const updated = await client.subscriptions.update({
      where: { id: subscription.id },
      data: {
        cycleNumber,
        currentSubscriptionDraftInvoiceId: null,
        subscriptionInvoiceIssuanceDate: nextIssuanceDt.toUTC().toJSDate(),
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Updated subscription ${subscription.id} after subscription invoice`);
    return updated;
  }

  /**
   * Find subscriptions needing subscription draft invoices
   * @returns Array of subscriptions
   */
  async findSubscriptionsNeedingSubscriptionDrafts(): Promise<any[]> {
    const today = new Date();

    const subscriptions = await this.prisma.subscriptions.findMany({
      where: {
        status: 'active',
        currentSubscriptionDraftInvoiceId: null,
        currentBillingPeriodStart: {
          lte: today, // Billing period has started
        },
        billingModel: {
          not: 'usage', // Not usage-only
        },
      },
      include: {
        customers: true,
      },
    });

    return subscriptions;
  }

  /**
   * Find subscriptions needing usage draft invoices
   * @returns Array of subscriptions
   */
  async findSubscriptionsNeedingUsageDrafts(): Promise<any[]> {
    const subscriptions = await this.prisma.subscriptions.findMany({
      where: {
        status: 'active',
        currentUsageDraftInvoiceId: null,
        billingModel: {
          not: 'subscription', // Not subscription-only
        },
      },
      include: {
        customers: true,
      },
    });

    return subscriptions;
  }

  /**
   * Find subscription draft invoices ready to be issued based on billingDay
   * @returns Array of subscriptions with draft invoices
   */
  async findSubscriptionDraftsReadyForIssuance(): Promise<any[]> {
    const today = new Date();

    const subscriptions = await this.prisma.subscriptions.findMany({
      where: {
        status: 'active',
        currentSubscriptionDraftInvoiceId: {
          not: null, // Has a draft invoice
        },
        subscriptionInvoiceIssuanceDate: {
          lte: today, // Issuance date has arrived
        },
      },
      include: {
        invoices_subscriptions_currentSubscriptionDraftInvoiceIdToinvoices: true,
        customers: true,
      },
    });

    // Filter to only include those where the draft invoice is actually in draft status
    return subscriptions.filter(
      (sub) =>
        sub.invoices_subscriptions_currentSubscriptionDraftInvoiceIdToinvoices &&
        sub.invoices_subscriptions_currentSubscriptionDraftInvoiceIdToinvoices.status === 'draft',
    );
  }

  /**
   * Find draft invoices that need to be updated with usage
   * @returns Array of invoices with subscriptions
   */
  async findDraftInvoicesForUpdate(): Promise<any[]> {
    return findDraftInvoices({ readyForFinalization: false }, this.prisma as any);
  }

  /**
   * Find usage draft invoices ready for finalization (period has ended)
   * @returns Array of subscriptions with usage drafts
   */
  async findUsageDraftsReadyForFinalization(): Promise<any[]> {
    const today = new Date();

    const subscriptions = await this.prisma.subscriptions.findMany({
      where: {
        status: 'active',
        currentUsageDraftInvoiceId: {
          not: null, // Has a usage draft
        },
        currentBillingPeriodEnd: {
          lte: today, // Billing period has ended
        },
      },
      include: {
        invoices_subscriptions_currentUsageDraftInvoiceIdToinvoices: true,
        customers: true,
      },
    });

    // Filter to only include those where the usage draft is in draft status
    return subscriptions.filter(
      (sub) =>
        sub.invoices_subscriptions_currentUsageDraftInvoiceIdToinvoices &&
        sub.invoices_subscriptions_currentUsageDraftInvoiceIdToinvoices.status === 'draft' &&
        sub.invoices_subscriptions_currentUsageDraftInvoiceIdToinvoices.invoiceType === 'usage' &&
        !sub.invoices_subscriptions_currentUsageDraftInvoiceIdToinvoices.isFinalizedUsage,
    );
  }

  /**
   * Find issued invoices that are now overdue
   * @returns Array of overdue invoices
   */
  async findOverdueInvoices(): Promise<any[]> {
    return findOverdueInvoices({}, this.prisma as any);
  }

  /**
   * Mark an invoice as overdue
   * @param invoice - Invoice to mark as overdue
   * @param transaction - Prisma transaction client
   * @returns Updated invoice
   */
  async markInvoiceOverdue(invoice: any, transaction?: PrismaClient): Promise<any> {
    const client = transaction || this.prisma;

    const updated = await client.invoices.update({
      where: { id: invoice.id },
      data: {
        status: 'overdue' as any,
        statusReason: 'past_due',
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Marked invoice ${invoice.id} as overdue`);
    return updated;
  }

  /**
   * CRON: flip every issued, past-due invoice to `overdue`. Idempotent — an
   * already-overdue invoice does not match the `issued` filter, so each run only
   * catches invoices still sitting in `issued` past their due date.
   * Per-invoice errors are logged and skipped, never allowed to kill the run.
   */
  async markOverdueInvoices(): Promise<{
    scanned: number;
    marked: number;
    errors: number;
  }> {
    const overdue = await this.findOverdueInvoices();
    let marked = 0;
    let errors = 0;
    for (const invoice of overdue) {
      try {
        await this.markInvoiceOverdue(invoice);
        marked += 1;
      } catch (err) {
        errors += 1;
        this.logger.error(
          `Failed to mark invoice ${invoice.id} overdue: ${(err as Error)?.message}`,
        );
      }
    }
    this.logger.log(
      `markOverdueInvoices: scanned ${overdue.length}, marked ${marked}, errors ${errors}`,
    );
    return { scanned: overdue.length, marked, errors };
  }

  /**
   * Generate PDF for an invoice
   * @param invoice - Invoice to generate PDF for
   * @param calculationDetails - Calculation details
   * @param transaction - Prisma transaction client
   * @returns PDF generation result with S3 URL
   */
  async generatePDFForInvoice(
    invoice: any,
    calculationDetails: any,
    transaction?: PrismaClient,
  ): Promise<any> {
    const client = transaction || this.prisma;

    try {
      if (!invoice) {
        this.logger.warn('No invoice data available for PDF generation');
        return null;
      }

      const pdfResult = await this.pdfService.generateInvoicePDF(invoice, calculationDetails);

      await client.invoices.update({
        where: { id: invoice.id },
        data: {
          pdfUrl: pdfResult.s3Location,
          s3Key: pdfResult.s3Key,
          updatedAt: new Date(),
        },
      });

      return pdfResult;
    } catch (error) {
      this.logger.error('Error generating PDF for invoice:', error);
      return null;
    }
  }

  /**
   * Creates a subscription draft invoice for a specific manual billing period
   * @param subscription - The subscription to create the draft for
   * @param billingPeriodStart - Start date of the billing period
   * @param billingPeriodEnd - End date of the billing period
   * @param transaction - Prisma transaction client
   * @param invoiceDate - Optional invoice date (defaults to billingPeriodEnd + 1 day)
   * @param dueDate - Optional due date (defaults to billing period end + net terms)
   * @param customInvoiceNumber - Optional custom invoice number
   * @returns The created draft invoice
   */
  async createManualSubscriptionDraftInvoice(
    subscription: any,
    billingPeriodStart: Date,
    billingPeriodEnd: Date,
    transaction?: PrismaClient,
    invoiceDate?: Date,
    dueDate?: Date,
    customInvoiceNumber?: string,
  ): Promise<any> {
    const client = transaction || this.prisma;

    this.logger.log(
      `Creating manual subscription draft invoice for subscription ${subscription.id} with custom billing period`,
    );

    const invoiceNumber =
      customInvoiceNumber ||
      `MANUAL-${subscription.id.substring(0, 8)}-${Date.now().toString().substring(7)}`;

    // Default invoice date is the day after billing period ends — matches
    // canon I3 (invoice send date, not billing-period boundary).
    const defaultInvoiceDate = new Date(billingPeriodEnd.getTime() + 24 * 60 * 60 * 1000);

    const finalInvoiceDate = invoiceDate || defaultInvoiceDate;
    const finalDueDate =
      dueDate ||
      new Date(billingPeriodEnd.getTime() + (subscription.netTerms || 15) * 24 * 60 * 60 * 1000);

    const draftInvoice = await client.invoices.create({
      data: {
        id: this.generateUuid(),
        customerId: subscription.customerId,
        organizationId:
          subscription.organizationId || subscription.customer?.organizationId || null,
        subscriptionId: subscription.id,
        invoiceType: 'subscription' as any,
        status: 'draft' as any,
        dueDate: finalDueDate,
        billingPeriodStart,
        billingPeriodEnd,
        totalAmount: '0',
        subtotal: '0',
        taxAmount: '0',
        discountAmount: '0',
        amountDue: '0',
        amountPaid: '0',
        amountCredited: '0',
        createdBy: 'system',
        isFinalizedUsage: false,
        invoiceGenerationType: 'manual' as any,
        invoiceDate: finalInvoiceDate,
        invoiceNumber: invoiceNumber,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const calcResult = await this.invoiceCalculator.calculateInvoice({
      subscriptionId: subscription.id,
      billingPeriodStart,
      billingPeriodEnd,
      invoiceType: 'subscription',
      transaction: client as any,
    });

    await createOrUpdateInvoiceLineItems(
      draftInvoice,
      calcResult.calculationDetails,
      client as any,
      false,
    );

    return client.invoices.findUnique({
      where: { id: draftInvoice.id },
      include: { invoice_line_items: { where: { deletedAt: null } } },
    });
  }

  /**
   * Creates a usage draft invoice for a specific manual billing period
   * @param subscription - The subscription to create the draft for
   * @param billingPeriodStart - Start date of the billing period
   * @param billingPeriodEnd - End date of the billing period
   * @param transaction - Prisma transaction client
   * @param invoiceDate - Optional invoice date (defaults to billingPeriodEnd + 1 day)
   * @param dueDate - Optional due date (defaults to billing period end + net terms)
   * @param customInvoiceNumber - Optional custom invoice number
   * @returns The created draft invoice
   */
  async createManualUsageDraftInvoice(
    subscription: any,
    billingPeriodStart: Date,
    billingPeriodEnd: Date,
    transaction?: PrismaClient,
    invoiceDate?: Date,
    dueDate?: Date,
    customInvoiceNumber?: string,
  ): Promise<any> {
    const client = transaction || this.prisma;

    this.logger.log(
      `Creating manual usage draft invoice for subscription ${subscription.id} with custom billing period`,
    );

    const invoiceNumber =
      customInvoiceNumber ||
      `MANUAL-U-${subscription.id.substring(0, 8)}-${Date.now().toString().substring(7)}`;

    // Default invoice date for usage is billingPeriodEnd + 1 day
    const defaultInvoiceDate = new Date(billingPeriodEnd);
    defaultInvoiceDate.setDate(defaultInvoiceDate.getDate() + 1);

    const finalInvoiceDate = invoiceDate || defaultInvoiceDate;
    const finalDueDate =
      dueDate ||
      new Date(billingPeriodEnd.getTime() + (subscription.netTerms || 15) * 24 * 60 * 60 * 1000);

    const draftInvoice = await client.invoices.create({
      data: {
        id: this.generateUuid(),
        customerId: subscription.customerId,
        organizationId:
          subscription.organizationId || subscription.customer?.organizationId || null,
        subscriptionId: subscription.id,
        invoiceType: 'usage' as any,
        status: 'draft' as any,
        dueDate: finalDueDate,
        billingPeriodStart,
        billingPeriodEnd,
        totalAmount: '0',
        subtotal: '0',
        taxAmount: '0',
        discountAmount: '0',
        amountDue: '0',
        amountPaid: '0',
        amountCredited: '0',
        createdBy: 'system',
        lastUsageUpdateAt: null,
        isFinalizedUsage: false,
        invoiceGenerationType: 'manual' as any,
        invoiceDate: finalInvoiceDate,
        invoiceNumber: invoiceNumber,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return client.invoices.findUnique({
      where: { id: draftInvoice.id },
      include: { invoice_line_items: { where: { deletedAt: null } } },
    });
  }

  /**
   * Finalizes and issues a manual usage invoice
   * @param invoice - Draft invoice to finalize
   * @param subscription - Related subscription
   * @param transaction - Prisma transaction client
   * @param invoiceDate - Optional invoice date (defaults to billingPeriodEnd + 1 day)
   * @param dueDate - Optional due date (defaults to invoice date + net terms)
   * @returns Finalized invoice
   */
  async finalizeManualUsageInvoice(
    invoice: any,
    subscription: any,
    transaction?: PrismaClient,
    invoiceDate?: Date,
    dueDate?: Date,
  ): Promise<any> {
    const client = transaction || this.prisma;

    this.logger.log(
      `Finalizing manual usage invoice ${invoice.id} for subscription ${subscription.id}`,
    );

    await this.updateUsageDraftInvoice(invoice, subscription, transaction);

    const _now = new Date();

    // For usage invoices, default to billingPeriodEnd + 1 day if not provided
    const defaultInvoiceDate = new Date(invoice.billingPeriodEnd);
    defaultInvoiceDate.setDate(defaultInvoiceDate.getDate() + 1);

    const finalInvoiceDate = invoiceDate || defaultInvoiceDate;
    const calculatedDueDate = new Date(finalInvoiceDate);
    calculatedDueDate.setDate(calculatedDueDate.getDate() + (subscription.netTerms || 30));
    const finalDueDate = dueDate || calculatedDueDate;

    const calcResult = await this.invoiceCalculator.calculateInvoice({
      subscriptionId: subscription.id,
      billingPeriodStart: invoice.billingPeriodStart,
      billingPeriodEnd: invoice.billingPeriodEnd,
      invoiceType: 'usage',
      transaction: client as any,
    });

    const updated = await client.invoices.update({
      where: { id: invoice.id },
      data: {
        status: 'issued' as any,
        invoiceDate: finalInvoiceDate,
        dueDate: finalDueDate,
        isFinalizedUsage: true,
        subtotal: String(calcResult.calculationDetails.subtotal),
        totalAmount: String(calcResult.calculationDetails.total),
        amountDue: String(calcResult.calculationDetails.total),
        updatedAt: new Date(),
      },
    });

    // Generate PDF for the invoice
    await this.generatePDFForInvoice(updated, calcResult.calculationDetails, transaction);

    this.logger.log(`Successfully finalized manual usage invoice ${invoice.id}`);
    return updated;
  }

  /**
   * Issues a manual subscription invoice
   * @param invoice - Draft invoice to issue
   * @param subscription - Related subscription
   * @param transaction - Prisma transaction client
   * @param invoiceDate - Optional invoice date (defaults to billingPeriodEnd + 1 day)
   * @param dueDate - Optional due date (defaults to invoice date + net terms)
   * @returns Issued invoice
   */
  async issueManualSubscriptionInvoice(
    invoice: any,
    subscription: any,
    transaction?: PrismaClient,
    invoiceDate?: Date,
    dueDate?: Date,
  ): Promise<any> {
    const client = transaction || this.prisma;

    this.logger.log(
      `Issuing manual subscription invoice ${invoice.id} for subscription ${subscription.id}`,
    );

    // Default invoice date is the day after billing period ends — matches
    // canon I3 (invoice send date, not billing-period boundary).
    const defaultInvoiceDate = new Date(invoice.billingPeriodEnd.getTime() + 24 * 60 * 60 * 1000);

    const finalInvoiceDate = invoiceDate || defaultInvoiceDate;
    const calculatedDueDate = new Date(finalInvoiceDate);
    calculatedDueDate.setDate(calculatedDueDate.getDate() + (subscription.netTerms || 30));
    const finalDueDate = dueDate || calculatedDueDate;

    // Calculate invoice details again to ensure we have the most up-to-date totals
    const calcResult = await this.invoiceCalculator.calculateInvoice({
      subscriptionId: subscription.id,
      billingPeriodStart: invoice.billingPeriodStart,
      billingPeriodEnd: invoice.billingPeriodEnd,
      invoiceType: 'subscription',
      transaction: client as any,
    });

    const updated = await client.invoices.update({
      where: { id: invoice.id },
      data: {
        status: 'issued' as any,
        invoiceDate: finalInvoiceDate,
        dueDate: finalDueDate,
        subtotal: String(calcResult.calculationDetails.subtotal),
        totalAmount: String(calcResult.calculationDetails.total),
        amountDue: String(calcResult.calculationDetails.total),
        updatedAt: new Date(),
      },
    });

    // Generate PDF for the invoice
    await this.generatePDFForInvoice(updated, calcResult.calculationDetails, transaction);

    this.logger.log(`Successfully issued manual subscription invoice ${invoice.id}`);
    return updated;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Single-pass billing cron
  //
  // ONE pass issues each due invoice immediately AND notifies the merchant per
  // invoice, so every send is visible the moment it happens.
  //
  // Wired to GET /v1/subscriptions/cron/dispatch (vercel.json, 04:00 UTC daily).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issue usage invoices in a single pass: for every active usage/hybrid subscription
   * whose `nextUsageInvoiceAt` has passed, build the invoice straight to `issued`,
   * generate its PDF, email the end-customer, notify the merchant, and advance the
   * billing period — all in one run.
   *
   * It composes the LEAF helpers (createUsageDraftInvoice / updateUsageDraftInvoice /
   * generatePDFForInvoice) and advances the period exactly ONCE itself, including
   * `nextUsageInvoiceAt` (the field the due-query filters on), so a sub is never
   * double-advanced or re-billed in the same run.
   *
   * Idempotency: the single period-advance is written as a conditional
   * compare-and-swap (CAS) on `nextUsageInvoiceAt <= now`. If a concurrent dispatch
   * run already advanced it, our CAS matches 0 rows and we roll the whole transaction
   * back — so a double-fire can never produce a duplicate ISSUED + EMAILED invoice
   * (fail-closed, which matters more here than for drafts). The same pass advances
   * cycleNumber on the usage path.
   *
   * Zero-usage periods: if a period has no billable usage (total `<= 0`), we issue NO
   * invoice and send NO emails — but we STILL advance the period (discarding the empty
   * draft first). This matters because dispatch is the only thing that moves
   * `nextUsageInvoiceAt`; rolling back on zero usage would freeze the subscription on
   * that dead period forever and silently stop billing all future usage.
   * So an empty cycle moves the clock forward and the sub keeps going.
   *
   * Failure isolation: DB writes happen inside a per-sub transaction; emails and
   * auto-collect happen AFTER commit so an email can never fire for an
   * invoice that then rolls back. Each side effect has its own try/catch — a failed
   * customer email still lets the merchant notification go out (with an inline "we
   * couldn't reach the customer" note), a failed merchant email never blocks the
   * customer invoice, and neither is retried.
   */
  async dispatchUsageInvoices(): Promise<{
    issuedCount: number;
    customerEmailsSent: number;
    merchantEmailsSent: number;
    skippedZeroEvents: number;
    skippedConcurrent: number;
    errors: { subscriptionId: string; error: string }[];
  }> {
    const now = new Date();

    const dueSubscriptions = await this.prisma.subscriptions.findMany({
      where: {
        nextUsageInvoiceAt: { lte: now },
        status: 'active' as any,
        billingModel: { in: ['usage', 'hybrid'] as any[] },
        deletedAt: null,
      },
      include: {
        pricing_plans: true,
        customers: { select: { id: true, name: true, email: true } },
        organizations: {
          select: {
            id: true,
            name: true,
            billing_email: true,
            billingIdentity: true,
          },
        },
      },
    });

    this.logger.log(
      `[cron:dispatch] Found ${dueSubscriptions.length} subscription(s) due for usage invoice dispatch`,
    );

    const errors: { subscriptionId: string; error: string }[] = [];
    let issuedCount = 0;
    let customerEmailsSent = 0;
    let merchantEmailsSent = 0;
    let notEmailedBecauseEmailIsOff = 0;
    let skippedZeroEvents = 0;
    let skippedConcurrent = 0;

    const baseUrl = requireFrontendUrl(this.configService);

    for (const sub of dueSubscriptions as any[]) {
      // Holds the just-issued invoice once the transaction commits; the post-commit
      // side effects (emails, auto-collect, analytics) read from it.
      let issued: any = null;
      // True when the just-closed period had no billable usage. We still advance the
      // period (so the sub keeps moving), but issue no invoice and send no emails —
      // so the post-commit side-effect block is skipped for this sub.
      let zeroUsage = false;

      try {
        // Compute the next period ONCE up front so both the CAS WHERE and the advance
        // data use the same values. Uses the existing date helper so cycle math stays
        // consistent with how periods were first created.
        const next = this.calculateBillingPeriodAndDates({
          subscription: sub,
          startDate: sub.currentBillingPeriodEnd as Date,
        });

        await this.prisma.$transaction(
          async (tx) => {
            // 1. Build the draft shell + populate line items/totals from signal_events.
            //    These read the sub's CURRENT (just-closed) period from the in-memory
            //    object, so advancing the DB row later doesn't affect them.
            const draft = await this.createUsageDraftInvoice(sub, tx as PrismaClient);
            const populated = await this.updateUsageDraftInvoice(draft, sub, tx as PrismaClient);

            // 2. Did this period have billable usage? `<= 0` covers both "no events"
            //    and "credits cancelled out the usage" (negative total). EITHER WAY we
            //    still advance the period in step 5 — we just don't issue an invoice or
            //    email for it.
            //
            //    Rolling the WHOLE transaction back on zero usage would also undo the
            //    period-advance — and because dispatch is the ONLY thing that moves
            //    `nextUsageInvoiceAt` for an active usage sub, the sub would freeze on
            //    that dead period forever: every later run re-checks the same empty
            //    window, finds zero again, and never advances → all future usage
            //    silently un-billed. So on zero/negative usage, discard the empty draft
            //    (so no $0 draft is left behind) but still advance the clock below.
            const hasBillableUsage = Number(populated.totalAmount ?? populated.subtotal ?? 0) > 0;

            let updatedInvoice: any = null;
            if (hasBillableUsage) {
              // 3. Issue directly: status/invoiceDate/dueDate/isFinalizedUsage.
              const dueDate = new Date(now);
              dueDate.setDate(dueDate.getDate() + (sub.netTerms || 30));

              // Swap the throwaway `DRAFT-…` placeholder for a real
              // customer-facing number (INV-YYYYMM-NNNNN) BEFORE we flip to issued —
              // so the "invoice ready" email (step 7) and the PDF (step 4 below) both
              // show a number that looks like a real bill, not a draft. Generated inside this same transaction so
              // the count + write share one snapshot; the org-scoped unique constraint on
              // (organizationId, invoiceNumber) is the final backstop on a race.
              const issuedInvoiceNumber = await generateIssuedUsageInvoiceNumber(
                sub.organizationId,
                tx as PrismaClient,
              );
              updatedInvoice = await tx.invoices.update({
                where: { id: draft.id },
                data: {
                  status: 'issued' as any,
                  invoiceNumber: issuedInvoiceNumber,
                  invoiceDate: now,
                  dueDate,
                  isFinalizedUsage: true,
                  updatedAt: new Date(),
                },
              });

              // 4. PDF — recompute calc details (pdf.service reads line-items ONLY from
              //    calculationDetails, so this is required for a correct breakdown).
              //    Best-effort and wrapped in its own try/catch: a PDF failure must NEVER
              //    block the issue or roll back the transaction (the invoice is valid
              //    without a PDF; one can be regenerated later). generatePDFForInvoice
              //    already swallows its own errors, but this belt-and-suspenders guard
              //    means even an unexpected throw can't undo the issue + period-advance.
              try {
                const calcResult = await this.invoiceCalculator.calculateInvoice({
                  subscriptionId: sub.id,
                  billingPeriodStart: draft.billingPeriodStart,
                  billingPeriodEnd: draft.billingPeriodEnd,
                  invoiceType: 'usage',
                  transaction: tx as PrismaClient,
                });
                await this.generatePDFForInvoice(
                  updatedInvoice,
                  calcResult.calculationDetails,
                  tx as PrismaClient,
                );
              } catch (pdfError) {
                const message = pdfError instanceof Error ? pdfError.message : String(pdfError);
                this.logger.error(
                  `[cron:dispatch] PDF generation failed for invoice ${updatedInvoice.id} (issued anyway): ${message}`,
                );
              }
            } else {
              // 3'. Zero/negative usage → no invoice. Discard the empty draft created in
              //     step 1 so it doesn't linger as a $0 draft in the merchant's invoice
              //     list. Line items first
              //     to satisfy the FK, then the draft row. We still advance the period
              //     in step 5.
              await tx.invoice_line_items.deleteMany({ where: { invoiceId: draft.id } });
              await tx.invoices.delete({ where: { id: draft.id } });
              zeroUsage = true;
            }

            // 5. Advance the period EXACTLY ONCE — for BOTH the issued and the zero-usage
            //    path — and this conditional write IS the double-fire guard. The WHERE
            //    re-checks committed state: if a concurrent run already advanced
            //    nextUsageInvoiceAt past `now`, this matches 0 rows and we throw to roll
            //    everything back. createUsageDraftInvoice set currentUsageDraftInvoiceId
            //    earlier; clearing it here leaves it null (the invoice is now issued, or
            //    on the zero path, deleted — either way there's no pending draft).
            const claim = await tx.subscriptions.updateMany({
              where: { id: sub.id, nextUsageInvoiceAt: { lte: now } },
              data: {
                currentBillingPeriodStart: next.billingPeriodStart,
                currentBillingPeriodEnd: next.billingPeriodEnd,
                nextUsageInvoiceAt: next.billingPeriodEnd,
                cycleNumber: (sub.cycleNumber ?? 0) + 1,
                currentUsageDraftInvoiceId: null,
                updatedAt: new Date(),
              },
            });
            if (claim.count === 0) {
              throw new DispatchSkip('concurrent');
            }

            // Stash the issued invoice for the post-commit side effects (null on the
            // zero-usage path, which the caller skips via the zeroUsage flag).
            issued = updatedInvoice;
          },
          { timeout: 30_000 },
        );

        // ── Transaction committed. ──

        // Mint the NEW period's grant POST-COMMIT on this.prisma —
        // a caught failed write inside the interactive tx above would abort it
        // and roll back the invoice. BEFORE the zero-usage continue so a fresh
        // no-usage period still mints. The re-read inside mintPeriodGrant sees
        // the just-committed advanced period; idempotent by its unique key.
        try {
          const mint = await mintPeriodGrant(this.prisma, {
            subscriptionId: sub.id,
            createdBy: 'dispatch:usage-invoice',
          });
          if (mint.minted) {
            this.logger.log(
              `[cron:dispatch] minted credit-pool grant for subscription ${sub.id}: ` +
                `${mint.amountUnits} units for period starting ${mint.periodStart.toISOString()}`,
            );
          }
        } catch (mintError) {
          const message = mintError instanceof Error ? mintError.message : String(mintError);
          this.logger.error(
            `[cron:dispatch] credit-pool mint failed for subscription ${sub.id} (non-fatal, lazy mint covers): ${message}`,
          );
        }

        // Zero-usage period: the clock advanced (step 5) but no invoice was issued, so
        // there's nothing to email, collect, or report. Count it as a skip and move on.
        if (zeroUsage) {
          skippedZeroEvents++;
          this.logger.log(
            `[cron:dispatch] subscription ${sub.id} had no billable usage this period — period advanced, no invoice issued`,
          );
          continue;
        }

        // Everything below is best-effort and post-commit.
        issuedCount++;

        // Load the committed line items once — reused by both emails.
        const lineItems = await this.prisma.invoice_line_items.findMany({
          where: { invoiceId: issued.id, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        const emailLineItems = lineItems.map((li: any) => ({
          description: li.description,
          quantity: Number(li.quantity),
          unitPrice: Number(li.unitPrice),
          amount: Number(li.amount),
        }));

        // 6. Auto-collect (best-effort).
        if (issued.autoCollectPayment) {
          try {
            const checkoutResult = await this.paymentProcessingService.createCheckoutSession(
              issued.id,
            );
            this.logger.log(
              `[cron:dispatch] auto-collect: checkout session for invoice ${issued.id}: ${checkoutResult?.url}`,
            );
          } catch (paymentError) {
            const message =
              paymentError instanceof Error ? paymentError.message : String(paymentError);
            this.logger.error(
              `[cron:dispatch] auto-collect failed for invoice ${issued.id}: ${message}`,
            );
          }
        }

        // 7. End-customer "invoice ready" email (noreply@). Independent try/catch.
        //    customerDeliveryIssue feeds the merchant note in step 8.
        const customerEmail = sub.customers?.email as string | undefined;
        let customerDeliveryIssue: 'failed' | 'no-email' | undefined;
        if (customerEmail) {
          try {
            const sent = await this.emailService.sendInvoiceReadyEmail({
              to: customerEmail,
              customerName: sub.customers?.name ?? undefined,
              invoiceNumber: issued.invoiceNumber,
              amountDue: issued.amountDue,
              currency: issued.currency ?? 'USD',
              dueDate: issued.dueDate,
              paymentUrl: `${baseUrl}/i/${issued.id}/pay`,
              companyName: sub.organizations?.name ?? undefined,
              companyEmail: resolveOrgBillingContactEmail(sub.organizations) ?? undefined,
              lineItems: emailLineItems,
            });
            if (sent === null) {
              customerDeliveryIssue = 'failed';
              notEmailedBecauseEmailIsOff++;
            } else {
              customerEmailsSent++;
            }
          } catch (emailErr) {
            customerDeliveryIssue = 'failed';
            const message = emailErr instanceof Error ? emailErr.message : String(emailErr);
            this.logger.error(
              `[cron:dispatch] invoice ${issued.id} issued OK but customer email failed: ${message}`,
            );
          }
        } else {
          customerDeliveryIssue = 'no-email';
          this.logger.warn(
            `[cron:dispatch] invoice ${issued.id} issued but customer ${
              sub.customers?.id ?? 'unknown'
            } has no email — customer not notified`,
          );
        }

        // 8. Merchant notification. Each side effect keeps its own
        //    try/catch. Recipients: the org's billing contact (see
        //    resolveOrgBillingContactEmail); when that's null, ALL current
        //    owner-ROLE members (ba_member) — NOT organizations.owner_id, a
        //    create-time stamp that can dangle to a user long since removed from
        //    the org. If nobody resolves we DON'T block billing —
        //    the invoice already issued; we just log.
        let merchantRecipients: string[] = [];
        const orgBillingContact = resolveOrgBillingContactEmail(sub.organizations);
        if (orgBillingContact) {
          merchantRecipients = [orgBillingContact];
        } else if (sub.organizationId) {
          try {
            const currentOwnerMembers = await this.prisma.ba_member.findMany({
              where: { organizationId: sub.organizationId, role: 'owner' },
              select: { users: { select: { email: true } } },
            });
            const ownerEmailsByLowercase = new Map<string, string>();
            for (const member of currentOwnerMembers) {
              const ownerEmail = member.users?.email;
              if (ownerEmail && !ownerEmailsByLowercase.has(ownerEmail.toLowerCase())) {
                ownerEmailsByLowercase.set(ownerEmail.toLowerCase(), ownerEmail);
              }
            }
            merchantRecipients = [...ownerEmailsByLowercase.values()];
          } catch (ownerLookupErr) {
            const message =
              ownerLookupErr instanceof Error ? ownerLookupErr.message : String(ownerLookupErr);
            this.logger.error(
              `[cron:dispatch] invoice ${issued.id} issued OK but the owner lookup for the merchant notification failed: ${message}`,
            );
          }
        }
        if (merchantRecipients.length > 0) {
          for (const merchantTo of merchantRecipients) {
            try {
              const sent = await this.emailService.sendMerchantInvoiceSentNotification({
                to: merchantTo,
                organizationName: sub.organizations?.name ?? undefined,
                customerName: sub.customers?.name ?? undefined,
                customerEmail: customerEmail ?? undefined,
                invoiceNumber: issued.invoiceNumber,
                amount: issued.totalAmount ?? issued.amountDue,
                currency: issued.currency ?? 'USD',
                invoiceDetailUrl: `${baseUrl}/invoices/${issued.id}`,
                customerDetailUrl: `${baseUrl}/customers/${sub.customers?.id ?? sub.customerId}`,
                lineItems: emailLineItems,
                customerDeliveryIssue,
              });
              if (sent !== null) merchantEmailsSent++;
            } catch (merchantErr) {
              const message =
                merchantErr instanceof Error ? merchantErr.message : String(merchantErr);
              this.logger.error(
                `[cron:dispatch] invoice ${issued.id} issued OK but merchant email failed: ${message}`,
              );
            }
          }
        } else {
          this.logger.warn(
            `[cron:dispatch] invoice ${issued.id} issued but org ${
              sub.organizationId ?? 'unknown'
            } has no billing contact (billing_email or billing-identity email) and no current owner-role members — merchant not notified`,
          );
        }
      } catch (err) {
        // A DispatchSkip is expected control flow (a concurrent double-fire lost the
        // CAS race), not a failure — the transaction already rolled back. Classify it
        // as a skip and move on. (Zero usage is NOT a skip-via-throw: it commits with
        // the period advanced, handled above.)
        if (err instanceof DispatchSkip) {
          skippedConcurrent++;
          this.logger.warn(
            `[cron:dispatch] subscription ${sub.id} already dispatched by a concurrent run — skipped (idempotency guard)`,
          );
          continue;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[cron:dispatch] subscription ${sub.id} failed: ${message}`);
        errors.push({ subscriptionId: sub.id, error: message });
      }
    }

    if (notEmailedBecauseEmailIsOff > 0) {
      this.logger.warn(
        `[cron:dispatch] ${notEmailedBecauseEmailIsOff} invoice(s) were issued but not emailed because email is turned off. ` +
          'Neither the customers nor the merchants have been told. Set RESEND_API_KEY and RESEND_FROM_EMAIL and restart, or send these invoices yourself.',
      );
    }
    this.logger.log(
      `[cron:dispatch] Done. Issued ${issuedCount}, customer-emailed ${customerEmailsSent}, ` +
        `merchant-emailed ${merchantEmailsSent}, skipped ${skippedZeroEvents} (no usage) + ` +
        `${skippedConcurrent} (concurrent), ${errors.length} failure(s)`,
    );
    return {
      issuedCount,
      customerEmailsSent,
      merchantEmailsSent,
      skippedZeroEvents,
      skippedConcurrent,
      errors,
    };
  }

  private generateUuid(): string {
    return randomUUID();
  }
}
