/**
 * DB-GATED: requires a live Postgres connection via DATABASE_URL. Follows the
 * established apps/dashboard/app/actions/__tests__/*.integration.test.ts
 * conventions (see metrics-resolver-parity.integration.test.ts,
 * full-command-center.integration.test.ts): mock '@/app/lib/auth' +
 * 'next/headers', point the session at an org, call the Server Action
 * as a plain async function.
 *
 * getFinopsCloseStatus is
 * composition glue over four close-engine reads
 * (getPeriodLockStatus, getDefensibilityScore, getJournalExport,
 * getMismatchedSignalCount). finops-close-status-source.test.ts proves it
 * imports exactly those four and adds no SQL of its own (source-assert half,
 * jest is node-only so it can't run the DB half). This file proves the
 * COMPOSITION is correct: for one seeded org+window, every fact the action
 * returns deep-equals what the same four reads return when called directly.
 * A failure here means the action dropped or reshaped a value on the
 * way out, not that the underlying math is wrong (that's each read's own
 * test suite's job).
 *
 * WHY A THROWAWAY ORG: other
 * integration suites reuse the shared sample test organization
 * (getSampleOrgIdForTests()) and isolate their fixture with a fresh
 * customerId filter (see metrics-resolver-parity's beforeAll comment). That
 * trick does not work for this seam: getJournalExport / getDefensibilityScore
 * / getMismatchedSignalCount are ORG + WINDOW scoped with NO per-customer
 * filter anywhere in their signature. Layering onto the shared test organization
 * would mix this fixture's numbers with whatever real sample data already
 * exists in the same calendar month, breaking the exact-number assertions
 * below. This suite creates and tears down its own throwaway organization
 * instead — the only way to get deterministic whole-org aggregate numbers.
 *
 * FIXTURE-ID HYGIENE NOTE: every actual row id below is a real
 * crypto.randomUUID() (required — every relevant column in schema.prisma is
 * a native Postgres `@db.Uuid`, not text, so a literal "fixture-*" string
 * would fail at the database level with an invalid-uuid error). Only the
 * human-readable fields (org/agent/signal names, GL names, external ids,
 * idempotency keys) carry a "fixture-*" prefix. The ids are generated at
 * runtime, so no UUID-shaped literal appears in source.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  buildAuthMock,
  buildHeadersMock,
  buildMoneyManagerMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
jest.mock('../_shared/assert-money-manager', () =>
  buildMoneyManagerMock(authMock)
)

const prisma = new PrismaClient()

type FinopsCloseStatusModule = typeof import('../finops-close-status')
type FinancePeriodLockModule = typeof import('../finance-period-lock')
type FinanceMetricsModule = typeof import('../finance-metrics')
type JournalExportModule = typeof import('../journal-export')
type ChartOfAccountsModule = typeof import('../chart-of-accounts')

let getFinopsCloseStatus: FinopsCloseStatusModule['getFinopsCloseStatus']
let getPeriodLockStatus: FinancePeriodLockModule['getPeriodLockStatus']
let getDefensibilityScore: FinanceMetricsModule['getDefensibilityScore']
let getJournalExport: JournalExportModule['getJournalExport']
let getMismatchedSignalCount: ChartOfAccountsModule['getMismatchedSignalCount']

// A fully-elapsed calendar month (relative to any "today" this suite could
// plausibly run on) so getPeriodLockStatus's closable/lock-window math is
// stable and the fixture never depends on "now".
const WINDOW = { startDate: '2026-05-01', endDate: '2026-05-31' }

let orgId: string
let agentId: string
let customerId: string
let customerExternalId: string
let rawIngestEventId: string
let gl5100Id: string
let gl6800Id: string
let gl7100Id: string
let signalAId: string // PRODUCTION_COGS, direct GL mapping (5100)
let signalBId: string // DEVELOPMENT_RD, no GL: falls back to 6800
let signalCId: string // UNCLASSIFIED, no GL — stays unmapped
let signalDId: string // PRODUCTION_COGS mapped to an OPEX_GA account — mismatch
const createdEventIds: string[] = []

beforeAll(async () => {
  // Sanity check: prove the database's schema matches what this Prisma client
  // expects before seeding anything. This suite needs no migrations, but the
  // target database's schema is never assumed current.
  await prisma.chart_of_accounts.count()
  await prisma.finance_period_locks.count()

  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-close-status',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ getFinopsCloseStatus } = await import('../finops-close-status'))
  ;({ getPeriodLockStatus } = await import('../finance-period-lock'))
  ;({ getDefensibilityScore } = await import('../finance-metrics'))
  ;({ getJournalExport } = await import('../journal-export'))
  ;({ getMismatchedSignalCount } = await import('../chart-of-accounts'))

  agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      name: 'fixture-agent',
      agentCode: 'agent',
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  customerId = randomUUID()
  customerExternalId = `customer-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: 'fixture-customer',
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  gl5100Id = randomUUID()
  gl6800Id = randomUUID()
  gl7100Id = randomUUID()
  await prisma.chart_of_accounts.createMany({
    data: [
      {
        id: gl5100Id,
        orgId,
        glCode: '5100',
        glName: 'fixture-gl-5100',
        costCategory: 'PRODUCTION_COGS',
        accountingType: 'COGS',
        isDefault: false,
      },
      {
        id: gl6800Id,
        orgId,
        glCode: '6800',
        glName: 'fixture-gl-6800',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
        isDefault: false,
      },
      {
        id: gl7100Id,
        orgId,
        glCode: '7100',
        glName: 'fixture-gl-7100',
        costCategory: 'INTERNAL_TOOL',
        accountingType: 'OPEX_GA',
        isDefault: false,
      },
    ],
  })

  signalAId = randomUUID()
  signalBId = randomUUID()
  signalCId = randomUUID()
  signalDId = randomUUID()
  await prisma.signals.createMany({
    data: [
      {
        id: signalAId,
        name: 'signal-a-mapped',
        agentId,
        orgId,
        costCategory: 'PRODUCTION_COGS',
        glCodeId: gl5100Id,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: signalBId,
        name: 'signal-b-fallback',
        agentId,
        orgId,
        costCategory: 'DEVELOPMENT_RD',
        glCodeId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: signalCId,
        name: 'signal-c-unclassified',
        agentId,
        orgId,
        costCategory: 'UNCLASSIFIED',
        glCodeId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: signalDId,
        name: 'signal-d-mismatched',
        agentId,
        orgId,
        // Expected accounting type for PRODUCTION_COGS is COGS
        // (CATEGORY_TO_ACCOUNTING_TYPE), but this signal is mapped to the
        // 7100 (OPEX_GA) account above — deliberately mismatched so
        // getMismatchedSignalCount has something real to count.
        costCategory: 'PRODUCTION_COGS',
        glCodeId: gl7100Id,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })

  rawIngestEventId = randomUUID()
  await prisma.raw_ingest_events.create({
    data: {
      id: rawIngestEventId,
      organizationId: orgId,
      payload: { source: 'fixture' },
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })

  const seedEvent = async (signalId: string, usageCost: number) => {
    const id = randomUUID()
    await prisma.signal_events.create({
      data: {
        id,
        organizationId: orgId,
        agentId,
        customerId,
        customerExternalId,
        signalId,
        rawIngestEventId,
        usageDate: new Date('2026-05-15T12:00:00.000Z'),
        usageCost,
        quantity: 1,
        environment: 'production',
        idempotencyKey: `event-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  await seedEvent(signalAId, 100)
  await seedEvent(signalBId, 40)
  await seedEvent(signalCId, 7)
  await seedEvent(signalDId, 25)
})

afterAll(async () => {
  await prisma.signal_events.deleteMany({
    where: { id: { in: createdEventIds } },
  })
  await prisma.raw_ingest_events.deleteMany({ where: { id: rawIngestEventId } })
  await prisma.signals.deleteMany({ where: { orgId } })
  await prisma.chart_of_accounts.deleteMany({ where: { orgId } })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.agents.deleteMany({ where: { orgId } })
  await prisma.organizations.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('getFinopsCloseStatus — composition deep-equal against the four direct reads (DB half)', () => {
  it('the fixture actually produces the numbers the deep-equal proof depends on (guards the guard)', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    expect(result.success).toBe(true)
    const facts = result.data!
    // 4 events (A/B/C/D), one each — proves eventCount isn't vacuously
    // equal on both sides of every comparison below.
    expect(facts.eventCount).toBe(4)
    expect(facts.totalCost).toBeCloseTo(172, 6) // 100 + 40 + 7 + 25
    expect(facts.unclassifiedCost).toBeCloseTo(7, 6) // signal C only
    expect(facts.unmappedAmount).toBeCloseTo(7, 6) // signal C only
    expect(facts.unmappedSignalCount).toBe(1) // signal C only
    expect(facts.mismatchedSignalCount).toBe(1) // signal D only
    expect(facts.lock.locked).toBe(false)
  })

  it('facts.lock deep-equals a direct getPeriodLockStatus call for the same window', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    const directLock = await getPeriodLockStatus(WINDOW)
    expect(result.data!.lock).toEqual(directLock)
  })

  it('facts.journal deep-equals a direct getJournalExport call for the same window', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    const directJournal = await getJournalExport(WINDOW)
    expect(result.data!.journal).toEqual(directJournal)
  })

  it('facts.unmappedAmount / unmappedSignalCount match the journal fields they are lifted from', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    const directJournal = await getJournalExport(WINDOW)
    expect(result.data!.unmappedAmount).toBe(directJournal!.unmappedAmount)
    expect(result.data!.unmappedSignalCount).toBe(
      directJournal!.unmappedSignalCount ?? null
    )
  })

  it('facts.totalCost / unclassifiedCost / classifiedShare match a direct getDefensibilityScore call', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    const directScore = await getDefensibilityScore(WINDOW)
    expect(result.data!.totalCost).toBeCloseTo(directScore!.totalCost, 9)
    expect(result.data!.unclassifiedCost).toBeCloseTo(
      directScore!.unclassifiedCost,
      9
    )
    expect(result.data!.classifiedShare).toBeCloseTo(
      directScore!.classifiedShare!,
      9
    )
  })

  it('facts.mismatchedSignalCount matches a direct getMismatchedSignalCount call', async () => {
    const result = await getFinopsCloseStatus(WINDOW)
    const direct = await getMismatchedSignalCount()
    expect(result.data!.mismatchedSignalCount).toBe(direct.count)
  })
})
