/**
 * refunds.provider_refund_id unique constraint.
 *
 * Prevents webhook-retry double-counting. Stripe retries refund
 * webhooks on receipt timeout — without this constraint, the refund
 * finalizer could insert the same provider_refund_id twice and
 * double-subtract from collected revenue.
 *
 * Three scenarios exercised:
 *   1. Insert two refunds rows with the SAME provider_refund_id →
 *      second insert rejected with Prisma P2002 (unique violation).
 *   2. Multiple NULL provider_refund_id values allowed (PostgreSQL
 *      treats NULLs as distinct in unique indexes by default — pre-webhook
 *      refunds rows with status=pending should coexist freely).
 *   3. Error meta correctly identifies the field, so the webhook handler
 *      can pattern-match the violation and either skip silently (already
 *      processed) or look up the existing row.
 *
 * Self-seeding (mirrors refund-canon-subtraction.integration.test.ts): creates
 * its own 2099-dated invoice + payment so the suite never depends on sample
 * invoice/payment seed data existing.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { getSampleOrgIdForTests } from './_helpers/mock-session'

const prisma = new PrismaClient()

const TEST_DATE = new Date('2099-06-15T12:00:00Z')

let orgId: string
let invoiceId: string
let paymentId: string
const createdRefundIds: string[] = []

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()

  const customer = await prisma.customers.findFirst({
    where: { organizationId: orgId, deletedAt: null, isInternal: false },
    select: { id: true },
  })
  if (!customer) {
    throw new Error(
      'The test organization has no customers. Run `npm run db:setup` before running these tests so the sample data can be priced.'
    )
  }

  const now = new Date()
  invoiceId = randomUUID()
  paymentId = randomUUID()
  await prisma.invoices.create({
    data: {
      id: invoiceId,
      organizationId: orgId,
      customerId: customer.id,
      invoiceDate: TEST_DATE,
      dueDate: TEST_DATE,
      billingPeriodStart: TEST_DATE,
      billingPeriodEnd: TEST_DATE,
      totalAmount: 0.01,
      subtotal: 0.01,
      invoiceNumber: `REFUND-UNIQUE-${invoiceId.slice(0, 8)}`,
      status: 'paid' as any,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.invoice_payments.create({
    data: {
      id: paymentId,
      invoiceId,
      amount: 0.01,
      paymentDate: TEST_DATE,
      paymentMethod: 'stripe',
      status: 'succeeded',
      createdAt: now,
      updatedAt: now,
    },
  })
})

afterEach(async () => {
  if (createdRefundIds.length > 0) {
    await prisma.refunds.deleteMany({
      where: { id: { in: createdRefundIds } },
    })
    createdRefundIds.length = 0
  }
})

afterAll(async () => {
  // Cascade deletes via FK: invoices → invoice_payments → refunds
  await prisma.invoices.deleteMany({ where: { id: invoiceId } })
  await prisma.$disconnect()
})

function baseRow() {
  return {
    invoice_payment_id: paymentId,
    amount: '0.01' as unknown as Prisma.Decimal,
    currency: 'USD',
    status: 'succeeded' as const,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

describe('refunds.provider_refund_id unique constraint', () => {
  it('rejects duplicate provider_refund_id with P2002', async () => {
    const dupeProviderId = `re_unique_test_${Date.now()}_${randomUUID().slice(0, 8)}`

    // Insert #1 — should succeed
    const id1 = randomUUID()
    await prisma.refunds.create({
      data: { id: id1, ...baseRow(), provider_refund_id: dupeProviderId },
    })
    createdRefundIds.push(id1)

    // Insert #2 with same provider_refund_id — should fail
    const id2 = randomUUID()
    let caught: unknown = null
    try {
      await prisma.refunds.create({
        data: { id: id2, ...baseRow(), provider_refund_id: dupeProviderId },
      })
      createdRefundIds.push(id2) // for cleanup in case it accidentally succeeds
    } catch (e) {
      caught = e
    }

    expect(caught).not.toBeNull()
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    if (caught instanceof Prisma.PrismaClientKnownRequestError) {
      expect(caught.code).toBe('P2002')
      // Meta.target must include provider_refund_id so the webhook handler
      // can distinguish this from other unique violations and treat as
      // "already processed."
      const meta = caught.meta as { target?: string[] } | undefined
      expect(meta?.target).toContain('provider_refund_id')
    }
  })

  it('allows multiple NULL provider_refund_id values (pre-webhook pending refunds)', async () => {
    // PostgreSQL unique-index NULL semantics: multiple NULLs are distinct.
    // This guards the pending-refund flow where rows are created before the
    // provider has assigned an id.
    const nullId1 = randomUUID()
    const nullId2 = randomUUID()

    await prisma.refunds.create({
      data: { id: nullId1, ...baseRow(), provider_refund_id: null },
    })
    createdRefundIds.push(nullId1)

    // Second NULL insert should also succeed
    await prisma.refunds.create({
      data: { id: nullId2, ...baseRow(), provider_refund_id: null },
    })
    createdRefundIds.push(nullId2)

    // Both rows exist
    const both = await prisma.refunds.findMany({
      where: { id: { in: [nullId1, nullId2] } },
    })
    expect(both).toHaveLength(2)
    expect(both.every((r) => r.provider_refund_id === null)).toBe(true)
  })
})
