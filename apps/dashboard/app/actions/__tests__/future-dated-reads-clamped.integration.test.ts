/**
 * Eight reads that take no window must stop at today.
 *
 * One test per read site. Each seeds a row dated 2027-01-01 and asserts it
 * is absent from the read that takes no window, while its past-dated twin
 * still comes back.
 *
 * DEVIATION from the convention in this directory (which reuses the seeded
 * sample test organization and asserts deltas): these assertions are exact
 * counts and dollar figures, so they need an org that holds nothing else.
 * A fresh minimal org is created here and torn down in afterAll; the shared
 * test organization is never written to. Same shape as
 * metrics-resolver-org-scoping.integration.test.ts.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { buildAuthMock, buildHeadersMock } from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type FullCommandCenterModule = typeof import('../full-command-center')
type InvoicesModule = typeof import('../invoices')
type SignalEventsModule = typeof import('../signal-events')
type AnalyticsModule = typeof import('../analytics')

let fullCommandCenter: FullCommandCenterModule
let invoiceActions: InvoicesModule
let signalEventActions: SignalEventsModule
let analyticsActions: AnalyticsModule

const prisma = new PrismaClient()

const ORG_ID = randomUUID()
const CUSTOMER_ID = randomUUID()
const AGENT_ID = randomUUID()
const SIGNAL_ID = randomUUID()
const PLAN_ID = randomUUID()
const SUBSCRIPTION_ID = randomUUID()
const RAW_INGEST_EVENT_ID = randomUUID()

const PAST_EVENT_ID = randomUUID()
const FUTURE_EVENT_ID = randomUUID()

const INVOICE_PAST_ISSUED = randomUUID()
const INVOICE_FUTURE_ISSUED = randomUUID()
const INVOICE_FUTURE_PAID = randomUUID()
const INVOICE_FUTURE_OVERDUE = randomUUID()
const INVOICE_FUTURE_DRAFT = randomUUID()

const futureIssuedInvoiceNumber = `CLAMP-${INVOICE_FUTURE_ISSUED.slice(0, 8)}`

const MS_PER_DAY = 24 * 60 * 60 * 1000
const TWO_DAYS_AGO = new Date(Date.now() - 2 * MS_PER_DAY)
const FUTURE_DATE = new Date('2027-01-01T12:00:00.000Z')
const SUBSCRIPTION_END_DATE = new Date('2027-01-01T23:59:59.000Z')

// Powers of two, so a failing assertion names exactly which rows leaked.
const PAST_ISSUED_AMOUNT = 100
const FUTURE_ISSUED_AMOUNT = 200
const FUTURE_PAID_AMOUNT = 400
const FUTURE_OVERDUE_AMOUNT = 800
const FUTURE_DRAFT_AMOUNT = 1600

const PAST_EVENT_COST = 5
const FUTURE_EVENT_COST = 11

const BACKFILL_MODEL = 'clamp-test-backfill-model'
const VOLUME_MODEL = 'clamp-test-volume-model'
const TEST_PROVIDER = 'clamp-test-provider'

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

async function seedInvoice(args: {
  id: string
  invoiceDate: Date
  status: 'draft' | 'issued' | 'paid' | 'overdue'
  amount: number
}) {
  const now = new Date()
  await prisma.invoices.create({
    data: {
      id: args.id,
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      invoiceDate: args.invoiceDate,
      dueDate: args.invoiceDate,
      billingPeriodStart: args.invoiceDate,
      billingPeriodEnd: args.invoiceDate,
      totalAmount: args.amount,
      subtotal: args.amount,
      amountPaid: args.status === 'paid' ? args.amount : 0,
      amountDue: args.status === 'paid' ? 0 : args.amount,
      invoiceNumber: `CLAMP-${args.id.slice(0, 8)}`,
      status: args.status as never,
      createdAt: now,
      updatedAt: now,
    },
  })
}

async function seedEvent(args: { id: string; usageDate: Date; cost: number }) {
  const now = new Date()
  await prisma.signal_events.create({
    data: {
      id: args.id,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      customerId: CUSTOMER_ID,
      customerExternalId: 'clamp-test-customer',
      signalId: SIGNAL_ID,
      subscriptionId: SUBSCRIPTION_ID,
      rawIngestEventId: RAW_INGEST_EVENT_ID,
      usageDate: args.usageDate,
      quantity: 1,
      usageCost: args.cost,
      environment: 'production',
      idempotencyKey: `clamp-test-${args.id}`,
      createdAt: now,
      updatedAt: now,
    },
  })

  await prisma.signal_event_services.createMany({
    data: [
      {
        id: randomUUID(),
        signalEventId: args.id,
        model: BACKFILL_MODEL,
        modelProvider: TEST_PROVIDER,
        inputTokens: 10,
        outputTokens: 20,
        eventStatus: 'NEEDS_COST_BACKFILL',
      },
      {
        id: randomUUID(),
        signalEventId: args.id,
        model: VOLUME_MODEL,
        modelProvider: TEST_PROVIDER,
        eventStatus: 'MISSING_VOLUME_DATA',
      },
    ],
  })
}

beforeAll(async () => {
  const now = new Date()

  await prisma.organizations.create({
    data: { id: ORG_ID, name: `Future-date clamp org ${ORG_ID.slice(0, 8)}` },
  })
  await prisma.customers.create({
    data: {
      id: CUSTOMER_ID,
      organizationId: ORG_ID,
      name: 'Clamp test customer',
      externalId: 'clamp-test-customer',
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.agents.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      name: 'Clamp test agent',
      agentCode: `clamp-test-${ORG_ID.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.signals.create({
    data: {
      id: SIGNAL_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      name: 'Clamp test signal',
      shortName: 'clmps',
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.pricing_plans.create({
    data: {
      id: PLAN_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      name: 'Clamp test plan',
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.subscriptions.create({
    data: {
      id: SUBSCRIPTION_ID,
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      agentId: AGENT_ID,
      planId: PLAN_ID,
      name: 'Clamp test subscription',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: SUBSCRIPTION_END_DATE,
      status: 'active',
      nextRecurringInvoiceAt: SUBSCRIPTION_END_DATE,
      nextUsageInvoiceAt: SUBSCRIPTION_END_DATE,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.raw_ingest_events.create({
    data: {
      id: RAW_INGEST_EVENT_ID,
      organizationId: ORG_ID,
      payload: { model: 'clamp-test-fixture' },
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })

  await seedEvent({
    id: PAST_EVENT_ID,
    usageDate: TWO_DAYS_AGO,
    cost: PAST_EVENT_COST,
  })
  await seedEvent({
    id: FUTURE_EVENT_ID,
    usageDate: FUTURE_DATE,
    cost: FUTURE_EVENT_COST,
  })

  await seedInvoice({
    id: INVOICE_PAST_ISSUED,
    invoiceDate: TWO_DAYS_AGO,
    status: 'issued',
    amount: PAST_ISSUED_AMOUNT,
  })
  await seedInvoice({
    id: INVOICE_FUTURE_ISSUED,
    invoiceDate: FUTURE_DATE,
    status: 'issued',
    amount: FUTURE_ISSUED_AMOUNT,
  })
  await seedInvoice({
    id: INVOICE_FUTURE_PAID,
    invoiceDate: new Date('2027-01-02T12:00:00.000Z'),
    status: 'paid',
    amount: FUTURE_PAID_AMOUNT,
  })
  await seedInvoice({
    id: INVOICE_FUTURE_OVERDUE,
    invoiceDate: new Date('2027-01-03T12:00:00.000Z'),
    status: 'overdue',
    amount: FUTURE_OVERDUE_AMOUNT,
  })
  await seedInvoice({
    id: INVOICE_FUTURE_DRAFT,
    invoiceDate: new Date('2027-01-04T12:00:00.000Z'),
    status: 'draft',
    amount: FUTURE_DRAFT_AMOUNT,
  })

  authMock.__setSessionOrgId(ORG_ID)
  fullCommandCenter = await import('../full-command-center')
  invoiceActions = await import('../invoices')
  signalEventActions = await import('../signal-events')
  analyticsActions = await import('../analytics')
})

afterAll(async () => {
  await prisma.invoices.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.signal_events.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.raw_ingest_events.deleteMany({
    where: { id: RAW_INGEST_EVENT_ID },
  })
  await prisma.subscriptions.deleteMany({ where: { id: SUBSCRIPTION_ID } })
  await prisma.pricing_plans.deleteMany({ where: { id: PLAN_ID } })
  await prisma.signals.deleteMany({ where: { id: SIGNAL_ID } })
  await prisma.agents.deleteMany({ where: { id: AGENT_ID } })
  await prisma.customers.deleteMany({ where: { id: CUSTOMER_ID } })
  await prisma.organizations.deleteMany({ where: { id: ORG_ID } })
  await prisma.$disconnect()
})

describe('reads with no upper date bound stop at today', () => {
  it('site 1 — Invoice Pipeline card counts only invoices dated today or earlier, and drafts stay visible whatever their date', async () => {
    const result = await fullCommandCenter.getFullCommandCenterPipelineAndTypes()
    const stage = (name: string) =>
      result.invoicePipeline.find((s) => s.name === name)!

    expect(stage('Sent').count).toBe(1)
    expect(stage('Sent').amount).toBeCloseTo(PAST_ISSUED_AMOUNT, 2)
    expect(stage('Paid').count).toBe(0)
    expect(stage('Overdue').count).toBe(0)

    // A draft carries no date the customer is bound by, so it is exempt.
    expect(stage('Draft').count).toBe(1)
    expect(stage('Draft').amount).toBeCloseTo(FUTURE_DRAFT_AMOUNT, 2)

    expect(result.invoicesSentTotal).toBeCloseTo(PAST_ISSUED_AMOUNT, 2)
  })

  it('site 2 — invoice ledger with no filters hides future non-draft rows and still returns the past one for an explicit window', async () => {
    const unfiltered = await fullCommandCenter.getFullCommandCenterInvoicesTab()
    const unfilteredIds = unfiltered.map((row) => row.id)

    expect(unfilteredIds).toContain(INVOICE_PAST_ISSUED)
    expect(unfilteredIds).toContain(INVOICE_FUTURE_DRAFT)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_ISSUED)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_PAID)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_OVERDUE)

    const windowed = await fullCommandCenter.getFullCommandCenterInvoicesTab({
      startDate: isoDay(TWO_DAYS_AGO),
      endDate: isoDay(TWO_DAYS_AGO),
    })
    expect(windowed.map((row) => row.id)).toContain(INVOICE_PAST_ISSUED)
  })

  it('site 3 — getInvoices with no date filter hides future non-draft rows, and an explicit invoiceDateBefore brings them back', async () => {
    const unfiltered = await invoiceActions.getInvoices({ limit: 100 })
    expect(unfiltered.success).toBe(true)
    const unfilteredIds = unfiltered.data!.results.map((row) => row.id)

    expect(unfilteredIds).toContain(INVOICE_PAST_ISSUED)
    expect(unfilteredIds).toContain(INVOICE_FUTURE_DRAFT)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_ISSUED)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_PAID)
    expect(unfilteredIds).not.toContain(INVOICE_FUTURE_OVERDUE)

    const explicit = await invoiceActions.getInvoices({
      limit: 100,
      invoiceDateBefore: '2027-12-31',
    })
    expect(explicit.success).toBe(true)
    const explicitIds = explicit.data!.results.map((row) => row.id)
    expect(explicitIds).toContain(INVOICE_FUTURE_ISSUED)
    expect(explicitIds).toContain(INVOICE_FUTURE_PAID)
    expect(explicitIds).toContain(INVOICE_FUTURE_OVERDUE)
  })

  it('site 3 — searching an invoice number finds the invoice whatever its date', async () => {
    const found = await invoiceActions.getInvoices({
      limit: 100,
      search: futureIssuedInvoiceNumber,
    })
    expect(found.success).toBe(true)
    expect(found.data!.results.map((row) => row.id)).toEqual([
      INVOICE_FUTURE_ISSUED,
    ])
  })

  it("site 3 — dateScope 'include-scheduled' brings future-dated rows back into the list", async () => {
    const scheduled = await invoiceActions.getInvoices({
      limit: 100,
      dateScope: 'include-scheduled',
    })
    expect(scheduled.success).toBe(true)
    const ids = scheduled.data!.results.map((row) => row.id)

    expect(ids).toContain(INVOICE_PAST_ISSUED)
    expect(ids).toContain(INVOICE_FUTURE_ISSUED)
    expect(ids).toContain(INVOICE_FUTURE_PAID)
    expect(ids).toContain(INVOICE_FUTURE_OVERDUE)
    expect(ids).toContain(INVOICE_FUTURE_DRAFT)
  })

  it('site 4 — getSignalEvents with neither startDate nor endDate hides future-dated usage and still returns the past event for an explicit window', async () => {
    const unfiltered = await signalEventActions.getSignalEvents({ limit: 100 })
    expect(unfiltered.success).toBe(true)
    expect(unfiltered.data!.totalResults).toBe(1)
    expect(unfiltered.data!.results.map((e) => e.id)).toEqual([PAST_EVENT_ID])

    const windowed = await signalEventActions.getSignalEvents({
      limit: 100,
      startDate: isoDay(TWO_DAYS_AGO),
      endDate: isoDay(TWO_DAYS_AGO),
    })
    expect(windowed.success).toBe(true)
    expect(windowed.data!.results.map((e) => e.id)).toContain(PAST_EVENT_ID)
  })

  it('site 5 — Needs attention cost-backfill groups count only events dated today or earlier', async () => {
    const result = await signalEventActions.getNeedsCostBackfillGroups()
    expect(result.success).toBe(true)
    const group = result.data!.groups.find((g) => g.model === BACKFILL_MODEL)
    expect(group).toBeDefined()
    expect(group!.count).toBe(1)

    // The row the page opens on a click must be the event the count counted.
    expect(group!.samples.map((s) => s.eventId)).toEqual([PAST_EVENT_ID])
  })

  it('site 6 — Needs attention missing-volume groups count only events dated today or earlier', async () => {
    const result = await signalEventActions.getMissingVolumeGroups()
    expect(result.success).toBe(true)
    const group = result.data!.groups.find((g) => g.model === VOLUME_MODEL)
    expect(group).toBeDefined()
    expect(group!.count).toBe(1)

    // Same reason as site 5: Fill volume deep-links to samples[0].
    expect(group!.samples.map((s) => s.eventId)).toEqual([PAST_EVENT_ID])
  })

  it('site 7 — the customer share-of-cost tile ignores future-dated usage', async () => {
    const result = await analyticsActions.getCustomerShareOfCost(CUSTOMER_ID)
    expect(result.success).toBe(true)
    expect(result.data!.customerCost).toBeCloseTo(PAST_EVENT_COST, 2)
    expect(result.data!.orgCost).toBeCloseTo(PAST_EVENT_COST, 2)
  })

  it('site 8 — subscription analytics ends its window at now even when the subscription ends in the future', async () => {
    const result = await analyticsActions.getSubscriptionAnalytics(
      SUBSCRIPTION_ID
    )
    expect(result.success).toBe(true)
    expect(result.data!.summary.totalEvents).toBe(1)
    expect(result.data!.summary.totalCost).toBeCloseTo(PAST_EVENT_COST, 2)

    // An explicit future period end is capped the same way.
    const explicit = await analyticsActions.getSubscriptionAnalytics(
      SUBSCRIPTION_ID,
      { billingPeriodEnd: '2027-06-30T00:00:00.000Z' }
    )
    expect(explicit.success).toBe(true)
    expect(explicit.data!.summary.totalEvents).toBe(1)
  })
})
