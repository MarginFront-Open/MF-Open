/**
 * Utility functions for invoice generation
 */
import { $Enums, PrismaClient } from '@prisma/client';
import * as luxon from 'luxon';
import { v4 as uuidv4 } from 'uuid';

/**
 * `invoices.invoiceType` and `invoices.status` are Postgres enums. Typing these
 * params as the enums, not bare `string`, lets Prisma check that an invoice is
 * never written with a type or status that does not exist.
 */
type InvoiceType = $Enums.enum_invoices_invoiceType;
type InvoiceStatus = $Enums.enum_invoices_status;

/**
 * Generate an invoice based on subscription and calculation data
 * @param data - Invoice data
 * @param prisma - Prisma client instance
 * @returns Generated invoice
 */
export const generateInvoice = async (
  data: {
    subscription: any;
    calculationResult: any;
    invoiceType: InvoiceType;
    transaction?: PrismaClient;
    status?: InvoiceStatus;
  },
  prisma: PrismaClient,
): Promise<any> => {
  const { subscription, calculationResult, invoiceType, transaction, status = 'draft' } = data;

  const client = transaction || prisma;

  const invoiceNumber = `INV-${subscription.id.substring(0, 8)}-${Date.now().toString().substring(7)}`;

  const invoiceDate =
    invoiceType === 'subscription'
      ? subscription.subscriptionInvoiceIssuanceDate
      : subscription.currentBillingPeriodEnd;

  const dueDate = luxon.DateTime.fromJSDate(invoiceDate)
    .plus({ days: subscription.netTerms || 15 })
    .toJSDate();

  const invoice = await client.invoices.create({
    data: {
      id: uuidv4(),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      invoiceDate,
      dueDate,
      billingPeriodStart: subscription.currentBillingPeriodStart,
      billingPeriodEnd: subscription.currentBillingPeriodEnd,
      invoiceType,
      totalAmount: calculationResult.total,
      subtotal: calculationResult.subtotal,
      taxAmount: 0,
      discountAmount: 0,
      status,
      invoiceNumber,
      netTerms: subscription.netTerms || 15,
      memo: subscription.invoiceMemo,
      currency: 'USD',
      amountDue: calculationResult.total,
      autoCollectPayment: subscription.autoCollectPayment || false,
      invoiceGenerationType: 'automatic',
      isFinalizedUsage: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await createOrUpdateInvoiceLineItems(invoice, calculationResult, client, false);

  return invoice;
};

/**
 * Create a usage draft invoice
 * @param data - Draft invoice data
 * @param prisma - Prisma client instance
 * @returns Created draft invoice
 */
export const createDraftInvoice = async (
  data: {
    subscription: any;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
    invoiceDate?: Date;
    dueDate?: Date;
    transaction?: PrismaClient;
    invoiceType?: InvoiceType;
  },
  prisma: PrismaClient,
): Promise<any> => {
  const { subscription, billingPeriodStart, billingPeriodEnd, transaction, invoiceDate, dueDate } =
    data;

  const client = transaction || prisma;

  const invoiceNumber = `DRAFT-${subscription.id.substring(0, 8)}-${Date.now().toString().substring(7)}`;

  const invoice = await client.invoices.create({
    data: {
      id: uuidv4(),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      organizationId:
        subscription.organizationId ||
        (subscription.customer ? subscription.customer.organizationId : null),
      // Null unless provided; finalization sets them.
      invoiceDate: invoiceDate || null,
      dueDate: dueDate || null,
      billingPeriodStart,
      billingPeriodEnd,
      invoiceType: data.invoiceType || 'usage',
      totalAmount: 0,
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      status: 'draft',
      invoiceNumber,
      netTerms: subscription.netTerms || 30,
      memo: subscription.invoiceMemo,
      currency: 'USD',
      amountDue: 0,
      autoCollectPayment: subscription.autoCollectPayment || false,
      invoiceGenerationType: 'automatic',
      isFinalizedUsage: false,
      lastUsageUpdateAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return invoice;
};

/**
 * Generate the customer-facing invoice number we stamp on a usage invoice the
 * moment it flips from "draft" to "issued" (the nightly dispatch cron).
 *
 * WHY THIS EXISTS: a draft is born with a throwaway `DRAFT-…`
 * placeholder (see createDraftInvoice above — that's correct for a draft). Left in
 * place on an issued bill, the paying customer would get an email titled "Invoice
 * DRAFT-… — Ready to Pay" for a genuine, payable invoice, which looks fake. This
 * mints a proper number in the SAME shape the dashboard already shows customers,
 * so the automated cron path and the manual dashboard path are indistinguishable
 * to the person paying.
 *
 * FORMAT (mirrors generateInvoiceNumber in apps/dashboard/app/actions/invoices.ts,
 * the source of truth): `INV-{YYYY}{MM}-{5-digit running count}` → e.g. INV-202606-00007.
 * NOTE: deliberately NOT the `generateInvoice` format above
 * (`INV-{subId8}-{ts7}`) — that one isn't the clean customer-facing number.
 *
 * UNIQUENESS: the running count is an org-scoped count of all invoices, so the
 * number is scoped per org. But that count also includes DRAFT- rows and any
 * dashboard-minted INV- rows, so `count + 1` can already be taken — we walk
 * forward to the first number this org doesn't already use. (A plain "recount"
 * would just hand back the same taken number, so we increment, not recount.) The
 * database has the final say: invoices carry a unique constraint on
 * (organizationId, invoiceNumber) in schema.prisma, so even if two writers
 * race past this read check, the loser's write is rejected with P2002 rather than
 * silently duplicating a number — and the caller's per-sub transaction rolls back
 * and re-issues on the next cron run.
 *
 * Pass the in-flight transaction client so the count/lookup share the same
 * snapshot as the issue write that immediately follows.
 *
 * @param organizationId - the org the invoice belongs to (the uniqueness scope)
 * @param client - Prisma client, ideally the in-flight transaction (tx)
 * @returns a number like "INV-202606-00007"
 */
export const generateIssuedUsageInvoiceNumber = async (
  organizationId: string,
  client: PrismaClient,
): Promise<string> => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}${month}-`;

  // Start where the dashboard starts: one past the org's current invoice count.
  const count = await client.invoices.count({ where: { organizationId } });
  let sequence = count + 1;

  // The count includes drafts + existing INV- rows, so the first candidate may
  // already be taken. Walk forward until we find a free number. Bounded so a
  // logic error can never spin this into an infinite loop; in practice it returns
  // on the first try.
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${prefix}${String(sequence).padStart(5, '0')}`;
    const existing = await client.invoices.findFirst({
      where: { organizationId, invoiceNumber: candidate },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
    sequence++;
  }

  throw new Error(
    `Could not generate a unique invoice number for organization ${organizationId} ` +
      `after 50 attempts (prefix ${prefix}). This usually means the org has an unusual ` +
      `gap pattern in its invoice numbers — inspect the invoices table for that org.`,
  );
};

/**
 * Create or update line items for an invoice
 * @param invoice - Invoice to create/update line items for
 * @param calculationResult - Calculation result with line items
 * @param prisma - Prisma client instance
 * @param isUpdate - Whether to update existing line items (true) or create new ones (false)
 * @returns Created/updated line items
 */
export const createOrUpdateInvoiceLineItems = async (
  invoice: any,
  calculationResult: any,
  prisma: PrismaClient,
  isUpdate: boolean = false,
): Promise<any[]> => {
  const lineItems = [];

  const existingItemMap: Record<string, any> = {};
  if (isUpdate) {
    // Live rows only. Matching a soft-deleted row by pricingStrategyId would
    // update the deleted row instead of creating a live one, and the charge
    // would vanish from the invoice while the header total still counted it.
    const existingItems = await prisma.invoice_line_items.findMany({
      where: { invoiceId: invoice.id, deletedAt: null },
    });

    for (const item of existingItems) {
      if (item.pricingStrategyId) {
        existingItemMap[item.pricingStrategyId] = item;
      }
    }
  }

  for (const item of calculationResult.lineItems) {
    if (isUpdate && item.pricingStrategyId && existingItemMap[item.pricingStrategyId]) {
      const existingItem = existingItemMap[item.pricingStrategyId];
      const updated = await prisma.invoice_line_items.update({
        where: { id: existingItem.id },
        data: {
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.effectiveUnitPrice,
          amount: item.amount,
          metadata: {
            ...((existingItem.metadata as any) || {}),
            effectiveUnitPrice: item.effectiveUnitPrice,
            tiersUsed: item.tiersUsed,
            lastUpdated: new Date(),
          } as any,
          updatedAt: new Date(),
        },
      });

      lineItems.push(updated);
    } else {
      const lineItem = await prisma.invoice_line_items.create({
        data: {
          id: uuidv4(),
          invoiceId: invoice.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.effectiveUnitPrice,
          amount: item.amount,
          type: item.chargeType || 'recurring',
          pricingStrategyId: item.pricingStrategyId,
          metadata: {
            effectiveUnitPrice: item.effectiveUnitPrice,
            tiersUsed: item.tiersUsed,
            createdAt: new Date(),
          } as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      lineItems.push(lineItem);
    }
  }

  return lineItems;
};

/**
 * Finalize a draft invoice
 * @param data - Finalization data
 * @param prisma - Prisma client instance
 * @returns Finalized invoice
 */
export const finalizeDraftInvoice = async (
  data: {
    invoice: any;
    subscription: any;
    calculationResult: any;
    transaction?: PrismaClient;
  },
  prisma: PrismaClient,
): Promise<any> => {
  const { invoice, subscription, calculationResult, transaction } = data;

  const client = transaction || prisma;

  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + (subscription.netTerms || 30));

  const updated = await client.invoices.update({
    where: { id: invoice.id },
    data: {
      status: 'issued',
      invoiceDate: now,
      dueDate,
      isFinalizedUsage: true,
      totalAmount: calculationResult.total,
      subtotal: calculationResult.subtotal,
      amountDue: calculationResult.total,
      lastUsageUpdateAt: now,
      updatedAt: now,
    },
  });

  await createOrUpdateInvoiceLineItems(updated, calculationResult, client, true);

  return updated;
};

/**
 * Find draft invoices for various purposes (update, finalization)
 * @param params - Search parameters
 * @param prisma - Prisma client instance
 * @returns Array of draft invoices
 */
export const findDraftInvoices = async (
  params: {
    referenceDate?: Date;
  },
  prisma: PrismaClient,
): Promise<any[]> => {
  const { referenceDate: _referenceDate = new Date() } = params;

  const draftInvoices = await prisma.invoices.findMany({
    where: {
      status: 'draft',
      invoiceType: 'usage',
    },
    include: {
      subscriptions: {
        include: {
          customers: true,
          agents: true,
          pricing_plans: true,
        },
      },
    },
  });

  return draftInvoices;
};

/**
 * Find invoices that are overdue
 * @param params - Search parameters
 * @param prisma - Prisma client instance
 * @returns Array of overdue invoices
 */
export const findOverdueInvoices = async (
  params: {
    referenceDate?: Date;
  },
  prisma: PrismaClient,
): Promise<any[]> => {
  const { referenceDate = new Date() } = params;

  const overdueInvoices = await prisma.invoices.findMany({
    where: {
      status: 'issued',
      dueDate: {
        lt: referenceDate,
      },
      // A soft-deleted invoice shouldn't resurrect into 'overdue' (matches revenue-metrics.ts).
      deletedAt: null,
    },
    include: {
      customers: true,
      subscriptions: true,
    },
  });

  return overdueInvoices;
};
