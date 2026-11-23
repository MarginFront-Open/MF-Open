/**
 * Canon math must subtract refunded amounts from collected revenue
 * (packages/db/src/lib/revenue-metrics.ts:getInvoiceTotals reads
 * invoice_payments.refunded_amount):
 *     - A $100 paid invoice with a $40 partial refund shows +$60 collected.
 *     - A $100 paid invoice with 2 payments of $50, one fully refunded,
 *       shows +$50 collected. Invoice status stays 'paid' per canon I2
 *       (the Finalizer only flips to 'refunded' when ALL payments on the
 *       invoice are fully refunded).
 *
 * Fully-refunded single-payment invoices are handled by the status filter:
 * the Finalizer flips status to 'refunded' and the canon query excludes
 * that status, so this file doesn't cover that case.
 *
 * The tests seed against the sample test organization but use a far-future
 * window (2099) so they cannot collide with real seed data. Seed shape
 * mirrors what InvoiceRefundFinalizer writes to the DB after a webhook
 * lands: invoices + invoice_payments (with refunded_amount + refund_status)
 * + refunds (status='succeeded').
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getInvoiceTotals } from '@marginfront/db'
import { getSampleOrgIdForTests } from './_helpers/mock-session'

const prisma = new PrismaClient()

const WINDOW = {
  start: new Date('2099-01-01T00:00:00Z'),
  end: new Date('2099-12-31T23:59:59Z'),
}

const TEST_DATE = new Date('2099-06-15T12:00:00Z')

let orgId: string
let customerId: string
const createdInvoiceIds: string[] = []

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()
  const cust = await prisma.customers.findFirst({
    where: { organizationId: orgId, deletedAt: null, isInternal: false },
    select: { id: true },
  })
  if (!cust) {
    throw new Error(
      'The test organization has no customers. Run `npm run db:setup` before running these tests so the sample data can be priced.'
    )
  }
  customerId = cust.id
})

afterEach(async () => {
  if (createdInvoiceIds.length > 0) {
    // Cascade deletes via FK: invoices → invoice_payments → refunds
    await prisma.invoices.deleteMany({
      where: { id: { in: createdInvoiceIds } },
    })
    createdInvoiceIds.length = 0
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

/**
 * Seed an invoice with one payment, optionally with a partial refund.
 * If refundDollars is 0, no refund row is created.
 */
async function seedSinglePaymentInvoice(args: {
  totalDollars: number
  refundDollars: number
}): Promise<{ invoiceId: string }> {
  const { totalDollars, refundDollars } = args
  const invoiceId = randomUUID()
  const paymentId = randomUUID()
  const invoiceNumber = `REFUND-TEST-${invoiceId.slice(0, 8)}`
  const now = new Date()

  const hasRefund = refundDollars > 0
  // Partial-refund path: payment.refund_status='partial', invoice.status stays 'paid'
  // (matches canon I2 — full refund of the only payment WOULD flip status to
  // 'refunded' via the Finalizer, and the status filter handles that case,
  // so it's not exercised here.)
  const refundStatus = hasRefund ? 'partial' : 'none'

  await prisma.invoices.create({
    data: {
      id: invoiceId,
      organizationId: orgId,
      customerId,
      invoiceDate: TEST_DATE,
      dueDate: TEST_DATE,
      billingPeriodStart: TEST_DATE,
      billingPeriodEnd: TEST_DATE,
      totalAmount: totalDollars,
      subtotal: totalDollars,
      amountPaid: totalDollars,
      amountDue: 0,
      invoiceNumber,
      status: 'paid' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  await prisma.invoice_payments.create({
    data: {
      id: paymentId,
      invoiceId,
      amount: totalDollars,
      paymentDate: TEST_DATE,
      paymentMethod: 'stripe',
      status: 'succeeded',
      refunded_amount: refundDollars,
      refund_status: refundStatus as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  if (hasRefund) {
    await prisma.refunds.create({
      data: {
        id: randomUUID(),
        invoice_payment_id: paymentId,
        amount: refundDollars,
        status: 'succeeded' as any,
        created_at: now,
        updated_at: now,
        processed_at: now,
      },
    })
  }

  return { invoiceId }
}

/**
 * Seed an invoice with two payments. Payment 1 is fully refunded; payment 2
 * is untouched. Invoice stays status='paid' (canon I2).
 */
async function seedMultiPaymentOneRefunded(args: {
  totalDollars: number
  payment1Dollars: number
  payment2Dollars: number
}): Promise<{ invoiceId: string }> {
  const { totalDollars, payment1Dollars, payment2Dollars } = args
  const invoiceId = randomUUID()
  const payment1Id = randomUUID()
  const payment2Id = randomUUID()
  const invoiceNumber = `REFUND-TEST-${invoiceId.slice(0, 8)}`
  const now = new Date()

  await prisma.invoices.create({
    data: {
      id: invoiceId,
      organizationId: orgId,
      customerId,
      invoiceDate: TEST_DATE,
      dueDate: TEST_DATE,
      billingPeriodStart: TEST_DATE,
      billingPeriodEnd: TEST_DATE,
      totalAmount: totalDollars,
      subtotal: totalDollars,
      amountPaid: totalDollars,
      amountDue: 0,
      invoiceNumber,
      status: 'paid' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Payment 1: fully refunded
  await prisma.invoice_payments.create({
    data: {
      id: payment1Id,
      invoiceId,
      amount: payment1Dollars,
      paymentDate: TEST_DATE,
      paymentMethod: 'stripe',
      status: 'succeeded',
      refunded_amount: payment1Dollars,
      refund_status: 'full' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Payment 2: untouched
  await prisma.invoice_payments.create({
    data: {
      id: payment2Id,
      invoiceId,
      amount: payment2Dollars,
      paymentDate: TEST_DATE,
      paymentMethod: 'stripe',
      status: 'succeeded',
      refunded_amount: 0,
      refund_status: 'none' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Refund attached to payment 1
  await prisma.refunds.create({
    data: {
      id: randomUUID(),
      invoice_payment_id: payment1Id,
      amount: payment1Dollars,
      status: 'succeeded' as any,
      created_at: now,
      updated_at: now,
      processed_at: now,
    },
  })

  return { invoiceId }
}

/**
 * Variant seed for the subscriptionId + agentId filter tests.
 * Lets the test override customerId (to match a real sample subscription's
 * customer) and supply a subscriptionId so the canon filters can find it.
 */
async function seedSinglePaymentInvoiceForSub(args: {
  totalDollars: number
  customerId: string
  subscriptionId: string
}): Promise<{ invoiceId: string }> {
  const { totalDollars, customerId: custOverride, subscriptionId } = args
  const invoiceId = randomUUID()
  const paymentId = randomUUID()
  const invoiceNumber = `REFUND-TEST-${invoiceId.slice(0, 8)}`
  const now = new Date()

  await prisma.invoices.create({
    data: {
      id: invoiceId,
      organizationId: orgId,
      customerId: custOverride,
      subscriptionId,
      invoiceDate: TEST_DATE,
      dueDate: TEST_DATE,
      billingPeriodStart: TEST_DATE,
      billingPeriodEnd: TEST_DATE,
      totalAmount: totalDollars,
      subtotal: totalDollars,
      amountPaid: totalDollars,
      amountDue: 0,
      invoiceNumber,
      status: 'paid' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  await prisma.invoice_payments.create({
    data: {
      id: paymentId,
      invoiceId,
      amount: totalDollars,
      paymentDate: TEST_DATE,
      paymentMethod: 'stripe',
      status: 'succeeded',
      refunded_amount: 0,
      refund_status: 'none' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  return { invoiceId }
}

/**
 * Seed a paid invoice where invoiceDate and paymentDate can DIVERGE.
 * That divergence is the whole point of cash-basis Collected — money is counted
 * by when it landed, not by the date stamped on the invoice. Pass
 * `withPaymentRow: false` to seed a paid invoice with NO payment row at all and
 * exercise the invoiceDate fallback.
 */
async function seedPaidInvoiceWithDates(args: {
  totalDollars: number
  invoiceDate: Date
  paymentDate?: Date
  withPaymentRow?: boolean
}): Promise<{ invoiceId: string }> {
  const { totalDollars, invoiceDate, paymentDate, withPaymentRow = true } = args
  const invoiceId = randomUUID()
  const invoiceNumber = `REFUND-CASH-${invoiceId.slice(0, 8)}`
  const now = new Date()

  await prisma.invoices.create({
    data: {
      id: invoiceId,
      organizationId: orgId,
      customerId,
      invoiceDate,
      dueDate: invoiceDate,
      billingPeriodStart: invoiceDate,
      billingPeriodEnd: invoiceDate,
      totalAmount: totalDollars,
      subtotal: totalDollars,
      amountPaid: totalDollars,
      amountDue: 0,
      invoiceNumber,
      status: 'paid' as any,
      createdAt: now,
      updatedAt: now,
    },
  })

  if (withPaymentRow && paymentDate) {
    await prisma.invoice_payments.create({
      data: {
        id: randomUUID(),
        invoiceId,
        amount: totalDollars,
        paymentDate,
        paymentMethod: 'stripe',
        status: 'succeeded',
        refunded_amount: 0,
        refund_status: 'none' as any,
        createdAt: now,
        updatedAt: now,
      },
    })
  }

  return { invoiceId }
}

describe('canon getInvoiceTotals refund subtraction', () => {
  it('baseline: $100 paid invoice with no refund → collected adds $100', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    const { invoiceId } = await seedSinglePaymentInvoice({
      totalDollars: 100,
      refundDollars: 0,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    const delta = after.collected - before.collected
    expect(delta).toBeCloseTo(100, 2)
  })

  it('partial refund: $100 paid invoice + $40 refund → collected adds $60', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    const { invoiceId } = await seedSinglePaymentInvoice({
      totalDollars: 100,
      refundDollars: 40,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    const delta = after.collected - before.collected
    // Net, not gross: ignoring the refund would give 100.
    expect(delta).toBeCloseTo(60, 2)
  })

  it('multi-payment one-fully-refunded: $100 paid invoice (2×$50) + $50 refund of payment #1 → collected adds $50', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    const { invoiceId } = await seedMultiPaymentOneRefunded({
      totalDollars: 100,
      payment1Dollars: 50,
      payment2Dollars: 50,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    const delta = after.collected - before.collected
    // Net of the $50 refund on payment #1: ignoring the refund would give 100.
    expect(delta).toBeCloseTo(50, 2)
  })

  // ===== Canon extensions =====

  it('extension: deletedAt: null filter — soft-deleted paid invoices do NOT count', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    const { invoiceId } = await seedSinglePaymentInvoice({
      totalDollars: 100,
      refundDollars: 0,
    })
    createdInvoiceIds.push(invoiceId)

    // Mark the invoice soft-deleted
    await prisma.invoices.update({
      where: { id: invoiceId },
      data: { deletedAt: new Date() },
    })

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    // Soft-deleted invoice should NOT contribute to collected
    expect(after.collected - before.collected).toBeCloseTo(0, 2)
  })

  it('extension: refunded field — exposes gross refund total for paid invoices in window', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    const { invoiceId } = await seedSinglePaymentInvoice({
      totalDollars: 100,
      refundDollars: 40,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    // collected: $100 paid minus $40 refunded = $60 net
    expect(after.collected - before.collected).toBeCloseTo(60, 2)
    // refunded: $40 (gross refund amount, exposed for detail-page callouts)
    expect(after.refunded - before.refunded).toBeCloseTo(40, 2)
  })

  it('extension: subscriptionId filter — narrows to that subscription only', async () => {
    // Find an existing sample subscription tied to our test customer
    const sampleSub = await prisma.subscriptions.findFirst({
      where: { organizationId: orgId, deletedAt: null, customerId },
      select: { id: true },
    })
    if (!sampleSub) {
      throw new Error(
        'Test customer has no subscriptions. Run `npm run db:setup` first.'
      )
    }

    const beforeFiltered = await getInvoiceTotals(prisma, orgId, WINDOW, {
      subscriptionId: sampleSub.id,
    })
    const beforeUnfiltered = await getInvoiceTotals(prisma, orgId, WINDOW)

    // Seed two invoices: one with the sample sub, one without
    const { invoiceId: withSubId } = await seedSinglePaymentInvoiceForSub({
      totalDollars: 100,
      customerId,
      subscriptionId: sampleSub.id,
    })
    createdInvoiceIds.push(withSubId)

    const { invoiceId: withoutSubId } = await seedSinglePaymentInvoice({
      totalDollars: 50,
      refundDollars: 0,
    })
    createdInvoiceIds.push(withoutSubId)

    const afterFiltered = await getInvoiceTotals(prisma, orgId, WINDOW, {
      subscriptionId: sampleSub.id,
    })
    const afterUnfiltered = await getInvoiceTotals(prisma, orgId, WINDOW)

    // Filtered call sees only the with-sub invoice ($100)
    expect(afterFiltered.collected - beforeFiltered.collected).toBeCloseTo(
      100,
      2
    )
    // Unfiltered call sees both ($150)
    expect(afterUnfiltered.collected - beforeUnfiltered.collected).toBeCloseTo(
      150,
      2
    )
  })

  it('extension: agentId filter — narrows to subs owned by that agent', async () => {
    // Find a sample sub linked to an agent through the customer relation
    const sampleSub = await prisma.subscriptions.findFirst({
      where: { organizationId: orgId, deletedAt: null, customerId },
      select: { id: true, agentId: true },
    })
    if (!sampleSub) {
      throw new Error(
        'Test customer has no subscriptions. Run `npm run db:setup` first.'
      )
    }

    const beforeFiltered = await getInvoiceTotals(prisma, orgId, WINDOW, {
      agentId: sampleSub.agentId,
    })

    // Seed an invoice linked to the sample sub. The agent filter routes through
    // the sub relation: invoice.subscriptions.agentId === filter.agentId.
    const { invoiceId } = await seedSinglePaymentInvoiceForSub({
      totalDollars: 100,
      customerId,
      subscriptionId: sampleSub.id,
    })
    createdInvoiceIds.push(invoiceId)

    const afterFiltered = await getInvoiceTotals(prisma, orgId, WINDOW, {
      agentId: sampleSub.agentId,
    })

    // The agent filter should pick up our $100 invoice via the sub→agent relation
    expect(afterFiltered.collected - beforeFiltered.collected).toBeCloseTo(
      100,
      2
    )
  })

  // ===== cash-basis (payment-date) windowing =====
  // These are the load-bearing tests: Collected counts cash by
  // the date it landed (paymentDate), NOT by the invoice date.

  const OUTSIDE_BEFORE = new Date('2098-06-15T12:00:00Z') // before WINDOW
  const OUTSIDE_AFTER = new Date('2100-06-15T12:00:00Z') // after WINDOW

  it('cash-basis: invoice dated BEFORE the window but PAID inside it → counts', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    // invoiceDate is before the window, but the cash landed inside it. An
    // invoiceDate basis would miss this; cash-basis counts it.
    const { invoiceId } = await seedPaidInvoiceWithDates({
      totalDollars: 249,
      invoiceDate: OUTSIDE_BEFORE,
      paymentDate: TEST_DATE,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)
    expect(after.collected - before.collected).toBeCloseTo(249, 2)
  })

  it('cash-basis: invoice dated INSIDE the window but PAID outside it → does NOT count', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    // The inverse: invoice is dated in-window, but the cash hasn't landed in
    // the window. An invoiceDate basis would wrongly count this; cash-basis
    // excludes it (the cash will show up in the window it actually arrives in).
    const { invoiceId } = await seedPaidInvoiceWithDates({
      totalDollars: 500,
      invoiceDate: TEST_DATE,
      paymentDate: OUTSIDE_AFTER,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)
    expect(after.collected - before.collected).toBeCloseTo(0, 2)
  })

  it('fallback: paid invoice with NO payment row → counts by invoiceDate AND logs loudly', async () => {
    const before = await getInvoiceTotals(prisma, orgId, WINDOW)

    // Spy only across the post-seed read so we know OUR no-payment-row invoice
    // triggered the warning (not some pre-existing sample-data gap).
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const { invoiceId } = await seedPaidInvoiceWithDates({
      totalDollars: 77,
      invoiceDate: TEST_DATE,
      withPaymentRow: false,
    })
    createdInvoiceIds.push(invoiceId)

    const after = await getInvoiceTotals(prisma, orgId, WINDOW)

    // No cash date to window on → fall back to invoiceDate so it isn't dropped.
    expect(after.collected - before.collected).toBeCloseTo(77, 2)
    // ...and the data gap must be LOUD, not silent.
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
