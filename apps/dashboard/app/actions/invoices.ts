'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { invoiceLineAmount, invoiceSubtotal } from '@marginfront/db'
import { revalidatePath } from 'next/cache'
// Invoices ARE the books — create/update/finalize/mark-paid/void/
// delete/send and reminder pause/resume are money writes. Gate every one on
// owner/admin/finance. Reads (getInvoices/getInvoice/...) need only a session in the org.
import { assertMoneyManager } from './_shared/assert-money-manager'
import { escapeHtml, safeHttpUrlForHtml } from '@/app/lib/email-html'

export interface Invoice {
  id: string
  customerId: string
  subscriptionId: string | null
  organizationId: string
  invoiceDate: string
  dueDate: string
  billingPeriodStart: string
  billingPeriodEnd: string
  totalAmount: number
  subtotal: number
  taxAmount: number
  discountAmount: number
  amountPaid: number
  amountCredited: number
  amountDue: number
  // Sum of refunded_amount across all invoice_payments rows for this invoice.
  // Powers the per-row refund visibility line in InvoicesTable + customer
  // portal so the merchant sees "−$60 refunded" under the gross totalAmount.
  // 0 when there are no refunds (no rendering, no zone-flood).
  refundedAmount: number
  status: 'pending' | 'paid' | 'overdue' | 'void' | 'draft' | 'issued'
  invoiceNumber: string
  pdfUrl: string | null
  currency: string
  memo: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  // Reminder tracking fields
  reminderStage: string | null
  reminderCount: number
  lastReminderSentAt: string | null
  nextReminderDate: string | null
  reminderPaused: boolean
  escalatedAt: string | null
  escalationReason: string | null
  // Related data
  customer?: {
    id: string
    name: string
    email: string | null
  }
  subscription?: {
    id: string
    name: string
    startDate: string
    endDate: string | null
    status: string
    billingCycle: string
    agent?: {
      id: string
      name: string
    }
    pricingPlan?: {
      id: string
      name: string
    }
  }
  lineItems?: InvoiceLineItem[]
}

export interface InvoiceLineItem {
  id: string
  invoiceId: string
  description: string
  quantity: number
  unitPrice: number
  amount: number
  type: string
  metadata: Record<string, unknown> | null
}

export interface InvoicePayment {
  id: string
  invoiceId: string
  amount: number
  paymentDate: string
  paymentMethod: string
  reference: string | null
  notes: string | null
  status: string
  currency: string
  providerTransactionId: string | null
  cardLast4: string | null
  cardBrand: string | null
  receiptUrl: string | null
  providerFee: number | null
  netAmount: number | null
  refundedAmount: number
  refundStatus: string
  createdAt: string
}

export interface Refund {
  id: string
  invoicePaymentId: string
  amount: number
  currency: string
  reason: string | null
  status: string
  providerRefundId: string | null
  processedAt: string | null
  createdAt: string
}

export interface InvoiceQueryParams {
  subscriptionId?: string
  planId?: string
  agentId?: string
  customerId?: string
  search?: string
  status?: string
  billingCycle?: string
  invoiceDateBefore?: string
  invoiceDateAfter?: string
  /** 'include-scheduled' lifts the default "dated today or earlier" bound. */
  dateScope?: 'include-scheduled'
  dueDateBefore?: string
  dueDateAfter?: string
  includeDetails?: boolean
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface PaginatedResponse<T> {
  results: T[]
  total: number
  totalResults: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateInvoicePayload {
  customerId: string
  subscriptionId?: string | null
  invoiceDate?: string
  dueDate: string
  billingPeriodStart?: string
  billingPeriodEnd?: string
  currency?: string
  taxAmount?: number
  discountAmount?: number
  memo?: string
  status?: 'draft' | 'issued'
  items: {
    description: string
    quantity: number
    unitPrice: number
    // What this line charges. Optional: a human typing "3 hours at $150"
    // states no amount and gets the product. A caller that already knows the
    // charge (the invoice calculator, a re-issue, an import) states it, and it
    // wins over quantity x unitPrice, which cannot reproduce a blended price.
    amount?: number
    type?: string
    metadata?: Record<string, unknown>
  }[]
}

export interface UpdateInvoicePayload {
  customerId?: string
  invoiceDate?: string
  dueDate?: string
  billingPeriodStart?: string
  billingPeriodEnd?: string
  taxAmount?: number
  discountAmount?: number
  memo?: string
  items?: {
    id?: string
    description: string
    quantity: number
    unitPrice: number
    /** See CreateInvoicePayload.items.amount. */
    amount?: number
    type?: string
    metadata?: Record<string, unknown>
  }[]
}

export interface MarkPaidPayload {
  paymentMethod?: string
  reference?: string
  notes?: string
}

const generateInvoiceNumber = async (orgId: string): Promise<string> => {
  const count = await db.invoices.count({
    where: { organizationId: orgId },
  })
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `INV-${year}${month}-${String(count + 1).padStart(5, '0')}`
}

const mapInvoice = (
  invoice: any,
  includeDetails = false,
  refundedAmount = 0
): Invoice => ({
  id: invoice.id,
  customerId: invoice.customerId,
  subscriptionId: invoice.subscriptionId,
  organizationId: invoice.organizationId,
  invoiceDate: invoice.invoiceDate.toISOString(),
  dueDate: invoice.dueDate.toISOString(),
  billingPeriodStart: invoice.billingPeriodStart.toISOString(),
  billingPeriodEnd: invoice.billingPeriodEnd.toISOString(),
  totalAmount: Number(invoice.totalAmount),
  subtotal: Number(invoice.subtotal),
  taxAmount: Number(invoice.taxAmount || 0),
  discountAmount: Number(invoice.discountAmount || 0),
  amountPaid: Number(invoice.amountPaid || 0),
  amountCredited: Number(invoice.amountCredited || 0),
  amountDue: Number(invoice.amountDue || 0),
  refundedAmount,
  status: (invoice.status || 'draft') as Invoice['status'],
  invoiceNumber: invoice.invoiceNumber,
  pdfUrl: invoice.pdfUrl,
  currency: invoice.currency || 'USD',
  memo: invoice.memo,
  metadata: invoice.metadata as Record<string, unknown> | null,
  createdAt: invoice.createdAt.toISOString(),
  updatedAt: invoice.updatedAt.toISOString(),
  reminderStage: invoice.reminderStage,
  reminderCount: invoice.reminderCount || 0,
  lastReminderSentAt: invoice.lastReminderSentAt?.toISOString() ?? null,
  nextReminderDate: invoice.nextReminderDate?.toISOString() ?? null,
  reminderPaused: invoice.reminderPaused || false,
  escalatedAt: invoice.escalatedAt?.toISOString() ?? null,
  escalationReason: invoice.escalationReason,
  customer: invoice.customers
    ? {
        id: invoice.customers.id,
        name: invoice.customers.name,
        email: invoice.customers.email,
      }
    : undefined,
  subscription: invoice.subscriptions
    ? {
        id: invoice.subscriptions.id,
        name: invoice.subscriptions.name,
        startDate: invoice.subscriptions.startDate.toISOString(),
        endDate: invoice.subscriptions.endDate?.toISOString() ?? null,
        status: invoice.subscriptions.status || 'pending',
        billingCycle: invoice.subscriptions.billingCycle || 'monthly',
        agent: invoice.subscriptions.agents
          ? {
              id: invoice.subscriptions.agents.id,
              name: invoice.subscriptions.agents.name,
            }
          : undefined,
        pricingPlan: invoice.subscriptions.pricing_plans
          ? {
              id: invoice.subscriptions.pricing_plans.id,
              name: invoice.subscriptions.pricing_plans.name,
            }
          : undefined,
      }
    : undefined,
  lineItems:
    includeDetails && invoice.invoice_line_items
      ? invoice.invoice_line_items.map((item: any) => ({
          id: item.id,
          invoiceId: item.invoiceId,
          description: item.description,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          amount: Number(item.amount),
          type: item.type,
          metadata: item.metadata as Record<string, unknown> | null,
        }))
      : undefined,
})

export async function getInvoices(params: InvoiceQueryParams = {}): Promise<{
  success: boolean
  data?: PaginatedResponse<Invoice>
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const {
      limit = 10,
      page = 1,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status,
      customerId,
      subscriptionId,
      search,
      invoiceDateAfter,
      invoiceDateBefore,
      dateScope,
      dueDateAfter,
      dueDateBefore,
      includeDetails = true,
    } = params

    const where: Prisma.invoicesWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    }

    if (status) {
      where.status = status as any
    }

    if (customerId) {
      where.customerId = customerId
    }

    if (subscriptionId) {
      where.subscriptionId = subscriptionId
    }

    if (search) {
      where.OR = [
        { invoiceNumber: { contains: search, mode: 'insensitive' } },
        { customers: { name: { contains: search, mode: 'insensitive' } } },
        { customers: { email: { contains: search, mode: 'insensitive' } } },
      ]
    }

    if (invoiceDateAfter) {
      where.invoiceDate = {
        ...(where.invoiceDate as any),
        gte: new Date(invoiceDateAfter),
      }
    }

    if (invoiceDateBefore) {
      where.invoiceDate = {
        ...(where.invoiceDate as any),
        lte: new Date(invoiceDateBefore),
      }
    } else if (!search && dateScope !== 'include-scheduled') {
      // Search is exempt, or the list reads "no results" for an invoice
      // that exists.
      where.OR = [{ status: 'draft' }, { invoiceDate: { lte: new Date() } }]
    }

    if (dueDateAfter) {
      where.dueDate = { ...(where.dueDate as any), gte: new Date(dueDateAfter) }
    }

    if (dueDateBefore) {
      where.dueDate = {
        ...(where.dueDate as any),
        lte: new Date(dueDateBefore),
      }
    }

    const total = await db.invoices.count({ where })

    const invoices = await db.invoices.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
      include: includeDetails
        ? {
            customers: {
              select: { id: true, name: true, email: true },
            },
            subscriptions: {
              select: {
                id: true,
                name: true,
                startDate: true,
                endDate: true,
                status: true,
                billingCycle: true,
                agents: {
                  select: { id: true, name: true },
                },
                pricing_plans: {
                  select: { id: true, name: true },
                },
              },
            },
            invoice_line_items: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
            },
          }
        : undefined,
    })

    // Per-invoice refunded total. Single groupBy across the page of invoices
    // (paid status only — drafts/issued/overdue can't have refunds). Powers
    // the per-row "−$X refunded" line in InvoicesTable + customer portal.
    const paidIds = invoices.filter((i) => i.status === 'paid').map((i) => i.id)
    const refundsByInvoiceId = new Map<string, number>()
    if (paidIds.length > 0) {
      const refundSums = await db.invoice_payments.groupBy({
        by: ['invoiceId'],
        where: { invoiceId: { in: paidIds } },
        _sum: { refunded_amount: true },
      })
      for (const row of refundSums) {
        refundsByInvoiceId.set(
          row.invoiceId,
          Number(row._sum.refunded_amount ?? 0)
        )
      }
    }

    const results = invoices.map((inv) =>
      mapInvoice(inv, includeDetails, refundsByInvoiceId.get(inv.id) ?? 0)
    )

    return {
      success: true,
      data: {
        results,
        total,
        totalResults: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    }
  } catch (error) {
    console.error('[getInvoices] Error:', error)
    return { success: false, error: 'Failed to fetch invoices' }
  }
}

export async function getInvoice(
  invoiceId: string,
  includeDetails: boolean = true
): Promise<{
  success: boolean
  data?: Invoice
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const invoice = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
      include: includeDetails
        ? {
            customers: {
              select: { id: true, name: true, email: true },
            },
            subscriptions: {
              select: {
                id: true,
                name: true,
                startDate: true,
                endDate: true,
                status: true,
                billingCycle: true,
                agents: {
                  select: { id: true, name: true },
                },
                pricing_plans: {
                  select: { id: true, name: true },
                },
              },
            },
            invoice_line_items: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
            },
          }
        : undefined,
    })

    if (!invoice) {
      return { success: false, error: 'Invoice not found' }
    }

    return {
      success: true,
      data: mapInvoice(invoice, includeDetails),
    }
  } catch (error) {
    console.error('[getInvoice] Error:', error)
    return { success: false, error: 'Failed to fetch invoice' }
  }
}

// Generate invoice from subscription via api-nest internal endpoint.

export interface GenerateInvoicePayload {
  customerId: string
  subscriptionId: string
  billingPeriodStart?: string | Date
  billingPeriodEnd?: string | Date
}

/**
 * Build a real draft invoice from a subscription's actual usage events. Calls api-nest's
 * /v1/invoices/generate-internal endpoint (server-to-server auth via shared CRON_SECRET) so
 * we get the same composition logic the cron uses — no Prisma-direct duplication of the
 * billing math in the dashboard layer.
 *
 * Requires `CRON_SECRET` env var in the dashboard's environment (same value as the
 * API server's). Without it, this Server Action returns a configuration error.
 */
export async function generateInvoice(
  payload: GenerateInvoicePayload
): Promise<{ success: boolean; data?: Invoice; error?: string }> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error(
        '[generateInvoice] CRON_SECRET not configured on dashboard env'
      )
      return {
        success: false,
        error:
          'Invoice generation is off because CRON_SECRET is not set on the dashboard. Set CRON_SECRET to the same value the API uses, then restart the dashboard.',
      }
    }

    const apiBaseUrl = (
      process.env.API_BASE_URL ||
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      'http://localhost:4000/v1'
    ).replace(/\/+$/, '')

    const response = await fetch(`${apiBaseUrl}/invoices/generate-internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })

    if (!response.ok) {
      let errMessage = `HTTP ${response.status}`
      try {
        const body = await response.json()
        errMessage = body?.message || body?.error || errMessage
      } catch {
        // Body wasn't JSON — keep the status code we have.
      }
      console.error('[generateInvoice] api-nest call failed:', errMessage)
      return { success: false, error: errMessage }
    }

    const invoice = (await response.json()) as Invoice
    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoice.id}`)
    return { success: true, data: invoice }
  } catch (error) {
    console.error('[generateInvoice] Error:', error)
    return { success: false, error: 'Failed to generate invoice' }
  }
}

export async function createInvoice(data: CreateInvoicePayload): Promise<{
  success: boolean
  data?: Invoice
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId
    const invoiceNumber = await generateInvoiceNumber(orgId)

    // Totals follow what each line charges, never a recomputed
    // quantity x unitPrice.
    const subtotal = invoiceSubtotal(data.items)
    const taxAmount = data.taxAmount || 0
    const discountAmount = data.discountAmount || 0
    const totalAmount = subtotal + taxAmount - discountAmount

    const now = new Date()
    const invoiceDate = data.invoiceDate ? new Date(data.invoiceDate) : now
    const billingPeriodStart = data.billingPeriodStart
      ? new Date(data.billingPeriodStart)
      : now
    const billingPeriodEnd = data.billingPeriodEnd
      ? new Date(data.billingPeriodEnd)
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    const invoice = await db.invoices.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: orgId,
        customerId: data.customerId,
        subscriptionId: data.subscriptionId || null,
        invoiceNumber,
        invoiceDate,
        dueDate: new Date(data.dueDate),
        billingPeriodStart,
        billingPeriodEnd,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount,
        amountDue: totalAmount,
        currency: data.currency || 'USD',
        memo: data.memo,
        status: data.status || 'draft',
        createdAt: now,
        updatedAt: now,
        invoice_line_items: {
          create: data.items.map((item) => ({
            id: crypto.randomUUID(),
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: invoiceLineAmount(item),
            type: (item.type as any) || 'recurring',
            metadata: item.metadata as Prisma.InputJsonValue,
            createdAt: now,
            updatedAt: now,
          })),
        },
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        subscriptions: {
          select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            status: true,
            billingCycle: true,
            agents: {
              select: { id: true, name: true },
            },
            pricing_plans: {
              select: { id: true, name: true },
            },
          },
        },
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    revalidatePath('/invoices')

    return {
      success: true,
      data: mapInvoice(invoice, true),
    }
  } catch (error) {
    console.error('[createInvoice] Error:', error)
    return { success: false, error: 'Failed to create invoice' }
  }
}

/**
 * Update an invoice (only drafts can be updated)
 */
export async function updateInvoice(
  invoiceId: string,
  data: UpdateInvoicePayload
): Promise<{
  success: boolean
  data?: Invoice
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify invoice exists and is a draft
    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    if (existing.status !== 'draft') {
      return { success: false, error: 'Only draft invoices can be updated' }
    }

    const now = new Date()

    let updateData: any = {
      updatedAt: now,
    }

    if (data.customerId) updateData.customerId = data.customerId
    if (data.invoiceDate) updateData.invoiceDate = new Date(data.invoiceDate)
    if (data.dueDate) updateData.dueDate = new Date(data.dueDate)
    if (data.billingPeriodStart)
      updateData.billingPeriodStart = new Date(data.billingPeriodStart)
    if (data.billingPeriodEnd)
      updateData.billingPeriodEnd = new Date(data.billingPeriodEnd)
    if (data.memo !== undefined) updateData.memo = data.memo
    if (data.taxAmount !== undefined) updateData.taxAmount = data.taxAmount
    if (data.discountAmount !== undefined)
      updateData.discountAmount = data.discountAmount

    if (data.items) {
      // Retire the old lines and write the new ones. Soft, not hard: every read
      // of invoice_line_items filters `deletedAt: null`, so a
      // retired row is invisible everywhere it matters, and what a draft
      // charged before somebody edited it stays on record. Rows that carry
      // money are deactivated, never destroyed.
      await db.invoice_line_items.updateMany({
        where: { invoiceId, deletedAt: null },
        data: { deletedAt: now, updatedAt: now },
      })

      const subtotal = invoiceSubtotal(data.items)
      const taxAmount = data.taxAmount ?? Number(existing.taxAmount || 0)
      const discountAmount =
        data.discountAmount ?? Number(existing.discountAmount || 0)
      const totalAmount = subtotal + taxAmount - discountAmount

      updateData.subtotal = subtotal
      updateData.totalAmount = totalAmount
      updateData.amountDue = totalAmount - Number(existing.amountPaid || 0)
    }

    const invoice = await db.invoices.update({
      where: { id: invoiceId },
      data: updateData,
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        subscriptions: {
          select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            status: true,
            billingCycle: true,
            agents: {
              select: { id: true, name: true },
            },
            pricing_plans: {
              select: { id: true, name: true },
            },
          },
        },
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    if (data.items) {
      await db.invoice_line_items.createMany({
        data: data.items.map((item) => ({
          id: crypto.randomUUID(),
          invoiceId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: invoiceLineAmount(item),
          type: (item.type as any) || 'recurring',
          metadata: item.metadata as Prisma.InputJsonValue,
          createdAt: now,
          updatedAt: now,
        })),
      })
    }

    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)

    return {
      success: true,
      data: mapInvoice(invoice, true),
    }
  } catch (error) {
    console.error('[updateInvoice] Error:', error)
    return { success: false, error: 'Failed to update invoice' }
  }
}

/**
 * Finalize a draft invoice (change status to issued)
 */
export async function finalizeInvoice(invoiceId: string): Promise<{
  success: boolean
  data?: Invoice
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    if (existing.status !== 'draft') {
      return { success: false, error: 'Only draft invoices can be finalized' }
    }

    const invoice = await db.invoices.update({
      where: { id: invoiceId },
      data: {
        status: 'issued',
        updatedAt: new Date(),
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)

    return {
      success: true,
      data: mapInvoice(invoice, true),
    }
  } catch (error) {
    console.error('[finalizeInvoice] Error:', error)
    return { success: false, error: 'Failed to finalize invoice' }
  }
}

export async function markInvoicePaid(
  invoiceId: string,
  payload?: MarkPaidPayload
): Promise<{
  success: boolean
  data?: { invoice: Invoice; payment: InvoicePayment }
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    if (existing.status === 'paid') {
      return { success: false, error: 'Invoice is already paid' }
    }

    if (existing.status === 'void') {
      return { success: false, error: 'Cannot mark a voided invoice as paid' }
    }

    const now = new Date()
    const amountDue = Number(existing.amountDue || existing.totalAmount)

    const payment = await db.invoice_payments.create({
      data: {
        id: crypto.randomUUID(),
        invoiceId,
        amount: amountDue,
        paymentDate: now,
        paymentMethod: (payload?.paymentMethod as any) || 'other',
        reference: payload?.reference,
        notes: payload?.notes,
        status: 'succeeded',
        currency: existing.currency,
        createdAt: now,
        updatedAt: now,
      },
    })

    const invoice = await db.invoices.update({
      where: { id: invoiceId },
      data: {
        status: 'paid',
        amountPaid: Number(existing.amountPaid || 0) + amountDue,
        amountDue: 0,
        updatedAt: now,
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)

    return {
      success: true,
      data: {
        invoice: mapInvoice(invoice, true),
        payment: {
          id: payment.id,
          invoiceId: payment.invoiceId,
          amount: Number(payment.amount),
          paymentDate: payment.paymentDate.toISOString(),
          paymentMethod: payment.paymentMethod,
          reference: payment.reference,
          notes: payment.notes,
          status: payment.status,
          currency: payment.currency,
          providerTransactionId: payment.provider_transaction_id,
          cardLast4: payment.card_last4,
          cardBrand: payment.card_brand,
          receiptUrl: payment.receipt_url,
          providerFee: payment.provider_fee
            ? Number(payment.provider_fee)
            : null,
          netAmount: payment.net_amount ? Number(payment.net_amount) : null,
          refundedAmount: Number(payment.refunded_amount || 0),
          refundStatus: payment.refund_status,
          createdAt: payment.createdAt.toISOString(),
        },
      },
    }
  } catch (error) {
    console.error('[markInvoicePaid] Error:', error)
    return { success: false, error: 'Failed to mark invoice as paid' }
  }
}

export async function voidInvoice(
  invoiceId: string,
  reason?: string
): Promise<{
  success: boolean
  data?: Invoice
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    if (existing.status === 'paid') {
      return { success: false, error: 'Cannot void a paid invoice' }
    }

    if (existing.status === 'void') {
      return { success: false, error: 'Invoice is already voided' }
    }

    const invoice = await db.invoices.update({
      where: { id: invoiceId },
      data: {
        status: 'void',
        statusReason: reason,
        updatedAt: new Date(),
      },
      include: {
        customers: {
          select: { id: true, name: true, email: true },
        },
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)

    return {
      success: true,
      data: mapInvoice(invoice, true),
    }
  } catch (error) {
    console.error('[voidInvoice] Error:', error)
    return { success: false, error: 'Failed to void invoice' }
  }
}

export async function getInvoicePayments(invoiceId: string): Promise<{
  success: boolean
  data?: {
    payments: InvoicePayment[]
    summary: {
      totalPaid: number
      totalRefunded: number
      netAmount: number
      paymentCount: number
    }
  }
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    // Verify invoice belongs to org
    const invoice = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!invoice) {
      return { success: false, error: 'Invoice not found' }
    }

    const payments = await db.invoice_payments.findMany({
      where: {
        invoiceId,
        deletedAt: null,
      },
      orderBy: { paymentDate: 'desc' },
    })

    const mappedPayments: InvoicePayment[] = payments.map((p) => ({
      id: p.id,
      invoiceId: p.invoiceId,
      amount: Number(p.amount),
      paymentDate: p.paymentDate.toISOString(),
      paymentMethod: p.paymentMethod,
      reference: p.reference,
      notes: p.notes,
      status: p.status,
      currency: p.currency,
      providerTransactionId: p.provider_transaction_id,
      cardLast4: p.card_last4,
      cardBrand: p.card_brand,
      receiptUrl: p.receipt_url,
      providerFee: p.provider_fee ? Number(p.provider_fee) : null,
      netAmount: p.net_amount ? Number(p.net_amount) : null,
      refundedAmount: Number(p.refunded_amount || 0),
      refundStatus: p.refund_status,
      createdAt: p.createdAt.toISOString(),
    }))

    const totalPaid = mappedPayments.reduce((sum, p) => sum + p.amount, 0)
    const totalRefunded = mappedPayments.reduce(
      (sum, p) => sum + p.refundedAmount,
      0
    )

    return {
      success: true,
      data: {
        payments: mappedPayments,
        summary: {
          totalPaid,
          totalRefunded,
          netAmount: totalPaid - totalRefunded,
          paymentCount: mappedPayments.length,
        },
      },
    }
  } catch (error) {
    console.error('[getInvoicePayments] Error:', error)
    return { success: false, error: 'Failed to fetch invoice payments' }
  }
}

export async function getReminderStatus(invoiceId: string): Promise<{
  success: boolean
  data?: {
    invoiceId: string
    status: string
    dueDate: string
    daysFromDue: number
    isOverdue: boolean
    reminderStage: string
    reminderCount: number
    lastReminderSentAt: string | null
    nextReminderDate: string | null
    reminderPaused: boolean
    escalatedAt: string | null
    escalationReason: string | null
  }
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const invoice = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!invoice) {
      return { success: false, error: 'Invoice not found' }
    }

    const now = new Date()
    const dueDate = new Date(invoice.dueDate)
    const daysFromDue = Math.floor(
      (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
    )
    const isOverdue =
      daysFromDue > 0 && invoice.status !== 'paid' && invoice.status !== 'void'

    return {
      success: true,
      data: {
        invoiceId: invoice.id,
        status: invoice.status || 'draft',
        dueDate: invoice.dueDate.toISOString(),
        daysFromDue,
        isOverdue,
        reminderStage: invoice.reminderStage || 'none',
        reminderCount: invoice.reminderCount || 0,
        lastReminderSentAt: invoice.lastReminderSentAt?.toISOString() ?? null,
        nextReminderDate: invoice.nextReminderDate?.toISOString() ?? null,
        reminderPaused: invoice.reminderPaused || false,
        escalatedAt: invoice.escalatedAt?.toISOString() ?? null,
        escalationReason: invoice.escalationReason,
      },
    }
  } catch (error) {
    console.error('[getReminderStatus] Error:', error)
    return { success: false, error: 'Failed to fetch reminder status' }
  }
}

export async function pauseReminders(
  invoiceId: string,
  _reason?: string
): Promise<{
  success: boolean
  data?: { invoiceId: string; reminderPaused: boolean; message: string }
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    await db.invoices.update({
      where: { id: invoiceId },
      data: {
        reminderPaused: true,
        updatedAt: new Date(),
      },
    })

    return {
      success: true,
      data: {
        invoiceId,
        reminderPaused: true,
        message: 'Reminders paused successfully',
      },
    }
  } catch (error) {
    console.error('[pauseReminders] Error:', error)
    return { success: false, error: 'Failed to pause reminders' }
  }
}

export async function resumeReminders(invoiceId: string): Promise<{
  success: boolean
  data?: { invoiceId: string; reminderPaused: boolean; message: string }
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    await db.invoices.update({
      where: { id: invoiceId },
      data: {
        reminderPaused: false,
        updatedAt: new Date(),
      },
    })

    return {
      success: true,
      data: {
        invoiceId,
        reminderPaused: false,
        message: 'Reminders resumed successfully',
      },
    }
  } catch (error) {
    console.error('[resumeReminders] Error:', error)
    return { success: false, error: 'Failed to resume reminders' }
  }
}

/**
 * Delete an invoice (soft delete - only drafts)
 */
export async function deleteInvoice(invoiceId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const existing = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Invoice not found' }
    }

    if (existing.status !== 'draft') {
      return { success: false, error: 'Only draft invoices can be deleted' }
    }

    await db.invoices.update({
      where: { id: invoiceId },
      data: { deletedAt: new Date() },
    })

    revalidatePath('/invoices')

    return { success: true }
  } catch (error) {
    console.error('[deleteInvoice] Error:', error)
    return { success: false, error: 'Failed to delete invoice' }
  }
}

// ============================================================================
// EMAIL ACTIONS
// ============================================================================

export interface SendInvoiceEmailPayload {
  recipientEmail?: string
  subject?: string
  message?: string
}

export async function sendInvoiceEmail(
  invoiceId: string,
  payload?: SendInvoiceEmailPayload
): Promise<{
  success: boolean
  data?: {
    emailId: string | null
    recipientEmail: string
  }
  error?: string
}> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    const invoice = await db.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        customers: true,
        organizations: true,
        invoice_line_items: {
          where: { deletedAt: null },
        },
      },
    })

    if (!invoice) {
      return { success: false, error: 'Invoice not found' }
    }

    const customer = invoice.customers
    const organization = invoice.organizations

    if (!customer) {
      return { success: false, error: 'Customer not found for this invoice' }
    }

    if (!organization) {
      return {
        success: false,
        error: 'Organization not found for this invoice',
      }
    }

    const recipientEmail = payload?.recipientEmail || customer.email

    if (!recipientEmail) {
      return { success: false, error: 'No recipient email address available' }
    }

    const formatAmount = (amount: number | Prisma.Decimal | null): string => {
      const num = Number(amount) || 0
      const currency = invoice.currency || 'USD'
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
      }).format(num)
    }

    const formatEmailDate = (date: Date | null): string => {
      if (!date) return '—'
      return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }

    // Emails drop the customer straight onto Stripe Checkout via `/i/{id}/pay`
    // (a server-side route handler that mints a fresh Stripe Checkout Session
    // and 302s). VERCEL_URL / better-auth fallbacks keep preview deploys
    // building valid links.
    const frontendUrl =
      process.env.FRONTEND_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
      process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
      'http://localhost:3000'
    const payInvoiceUrl = `${frontendUrl}/i/${invoice.id}/pay`

    const designJson = (organization as any).designJson as Record<
      string,
      unknown
    > | null
    const brandColor = (designJson?.headerColor as string) || '#0f172a'
    const logoUrl = safeHttpUrlForHtml(organization.logo)

    // Custom message section
    const customMessageHtml = payload?.message
      ? `<tr><td style="padding: 0 0 24px 0;"><p style="margin: 0; padding: 16px; background-color: #fafafa; border-radius: 6px; color: #525252; font-size: 14px; line-height: 1.6;">${escapeHtml(payload.message)}</p></td></tr>`
      : ''

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${escapeHtml(invoice.invoiceNumber)} from ${escapeHtml(organization.name)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; -webkit-font-smoothing: antialiased;">
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
                  ? `<img src="${logoUrl}" alt="${escapeHtml(organization.name)}" style="height: 32px; width: auto; display: block;">`
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
              <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.6; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                ${
                  invoice.status === 'paid'
                    ? `Thanks for your payment. Here's your receipt from ${escapeHtml(organization.name)}.`
                    : `<strong style="color: #171717;">${escapeHtml(organization.name)}</strong> has issued you invoice <strong style="color: #171717;">${escapeHtml(invoice.invoiceNumber)}</strong> for <strong style="color: #171717;">${formatAmount(invoice.totalAmount)}</strong>.`
                }
              </p>
              ${
                invoice.status === 'paid'
                  ? ''
                  : `<p style="margin: 0; font-size: 15px; line-height: 1.6; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                Click the button below to pay. Your payment is processed by Stripe.
              </p>`
              }
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
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Itemized line items table so the customer sees what
               they're actually paying for instead of just a mystery total.
               Mirrors the api-nest sendInvoiceEmail layout. Renders only when
               the invoice has line items. -->
          ${
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
                      (li: {
                        description: string
                        quantity: Prisma.Decimal | number
                        unitPrice: Prisma.Decimal | number
                        amount: Prisma.Decimal | number
                      }) => `
                  <tr style="border-top: 1px solid #f0f0f0;">
                    <td style="padding: 12px 16px; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(li.description)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${Number(li.quantity)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #525252; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${formatAmount(li.unitPrice)}</td>
                    <td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 500;">${formatAmount(li.amount)}</td>
                  </tr>`
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

          <!-- CTA Button — only render for unpaid invoices. Paid invoices
               have no payable link (Stripe already received the funds) and
               no invoice view page, so there's nothing to "View" either. -->
          ${
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
                      Secure checkout powered by Stripe.
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
              <p style="margin: 0; font-size: 12px; color: #a3a3a3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                ${escapeHtml(organization.name)}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `

    const emailSubject =
      payload?.subject ||
      `Invoice ${invoice.invoiceNumber} from ${organization.name}`

    const { Resend } = await import('resend')
    const resendApiKey = process.env.RESEND_API_KEY
    // Invoice emails go from
    // RESEND_INVOICE_FROM_EMAIL (e.g. noreply@yourdomain.com) when set, falling
    // back to the generic RESEND_FROM_EMAIL (e.g. team@yourdomain.com) so a
    // missing invoice env never breaks the send. Other email paths
    // (auth, magic-link, OTP, welcome, portal-link, invitation) keep using
    // RESEND_FROM_EMAIL directly. One env var per intent.
    const fromEmail =
      process.env.RESEND_INVOICE_FROM_EMAIL?.trim() ||
      process.env.RESEND_FROM_EMAIL
    if (!fromEmail) {
      console.error(
        '[sendInvoiceEmail] RESEND_INVOICE_FROM_EMAIL / RESEND_FROM_EMAIL not configured'
      )
      return {
        success: false,
        error:
          'Email service not configured: RESEND_INVOICE_FROM_EMAIL / RESEND_FROM_EMAIL not set',
      }
    }

    if (!resendApiKey) {
      console.error('[sendInvoiceEmail] RESEND_API_KEY not configured')
      return { success: false, error: 'Email service not configured' }
    }

    const resend = new Resend(resendApiKey)

    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: recipientEmail,
      subject: emailSubject,
      html: htmlContent,
    })

    if (error) {
      console.error('[sendInvoiceEmail] Resend error:', error)
      return { success: false, error: `Failed to send email: ${error.message}` }
    }

    console.log(
      `[sendInvoiceEmail] Email sent to ${recipientEmail} for invoice ${invoice.invoiceNumber}`
    )

    if (invoice.status === 'draft') {
      await db.invoices.update({
        where: { id: invoiceId },
        data: {
          status: 'issued',
          updatedAt: new Date(),
        },
      })
      revalidatePath('/invoices')
      revalidatePath(`/invoices/${invoiceId}`)
    }

    return {
      success: true,
      data: {
        emailId: data?.id || null,
        recipientEmail,
      },
    }
  } catch (error) {
    console.error('[sendInvoiceEmail] Error:', error)
    return { success: false, error: 'Failed to send invoice email' }
  }
}
