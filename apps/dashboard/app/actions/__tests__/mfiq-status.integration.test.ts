/**
 * DB-GATED: needs packages/db/.env pointing at a throwaway database.
 * Seed-and-restore
 * per the established *.integration.test.ts conventions
 * (metrics-resolver-parity.integration.test.ts + _helpers/mock-session.ts):
 * mock '@/app/lib/auth' + 'next/headers', point the session at a seeded org,
 * call the Server Action as a plain async function.
 *
 * DB half: getMfiqStatus is composition glue
 * over five reads. mfiq-status-source.test.ts proves it imports
 * exactly those five and adds no SQL (source half); the failure-domain suite
 * proves the allSettled tolerance with mocks. This file proves the LIVE
 * COMPOSITION: for one seeded org, every fact the action returns deep-equals
 * what the same reads return when called directly. Composed math is NOT
 * re-tested here — it has its own suites (finops-close-status.integration,
 * build-agents-reconciliation.integration).
 *
 * FIXTURE POSTURE (same reasoning as finops-close-status.integration): the
 * composed reads are ORG-scoped with no per-customer filter, so this suite
 * creates and tears down its own throwaway organization rather than layering
 * onto the shared test organization. All row ids are runtime crypto.randomUUID()
 * (native @db.Uuid columns); only human-readable fields carry the
 * "fixture-*" prefix.
 *
 * WINDOW NOTE: getMfiqStatus pins its agent read to {} (rolling 30d anchored
 * at call-time `now`). The direct comparison call below passes EXPLICIT
 * pinned date strings instead of {} — two now-anchored windows could in
 * principle straddle a millisecond boundary. Fixture events sit hours inside
 * both windows, so row membership cannot differ.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  buildAuthMock,
  buildHeadersMock,
  buildMoneyManagerMock,
} from './_helpers/mock-session'
import { monthPeriod } from '@/features/_shared/billing-period'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
jest.mock('../_shared/assert-money-manager', () =>
  buildMoneyManagerMock(authMock)
)

const prisma = new PrismaClient()

type MfiqStatusModule = typeof import('../mfiq-status')
type FinopsCloseStatusModule = typeof import('../finops-close-status')
type FinancePeriodLockModule = typeof import('../finance-period-lock')
type BuildAgentsOverviewModule = typeof import('../build-agents-overview')
type SignalEventsModule = typeof import('../signal-events')
type ChartOfAccountsModule = typeof import('../chart-of-accounts')

let getMfiqStatus: MfiqStatusModule['getMfiqStatus']
let getFinopsCloseStatus: FinopsCloseStatusModule['getFinopsCloseStatus']
let getPeriodLockStatus: FinancePeriodLockModule['getPeriodLockStatus']
let getBuildAgentsOverview: BuildAgentsOverviewModule['getBuildAgentsOverview']
let getNeedsCostBackfillGroups: SignalEventsModule['getNeedsCostBackfillGroups']
let getMissingVolumeGroups: SignalEventsModule['getMissingVolumeGroups']
let getMismatchedSignalCount: ChartOfAccountsModule['getMismatchedSignalCount']

let orgId: string
let agentId: string
let customerId: string
let customerExternalId: string
let rawIngestEventId: string
let gl5100Id: string
let gl7100Id: string
let signalMappedId: string // PRODUCTION_COGS → 5100 (COGS): clean
let signalMismatchedId: string // PRODUCTION_COGS → 7100 (OPEX_GA): the mismatch
const createdEventIds: string[] = []

// Explicit pinned strings for the direct agents comparison (see WINDOW NOTE).
const TODAY_ISO_DATE = new Date().toISOString().slice(0, 10)
const TEN_DAYS_AGO_ISO_DATE = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10)

beforeAll(async () => {
  // Schema sanity: this suite needs no migrations of its own, but the target
  // database's schema is never assumed current.
  await prisma.chart_of_accounts.count()
  await prisma.signal_event_services.count()

  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-mfiq-status',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ getMfiqStatus } = await import('../mfiq-status'))
  ;({ getFinopsCloseStatus } = await import('../finops-close-status'))
  ;({ getPeriodLockStatus } = await import('../finance-period-lock'))
  ;({ getBuildAgentsOverview } = await import('../build-agents-overview'))
  ;({ getNeedsCostBackfillGroups, getMissingVolumeGroups } = await import(
    '../signal-events'
  ))
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

  signalMappedId = randomUUID()
  signalMismatchedId = randomUUID()
  await prisma.signals.createMany({
    data: [
      {
        id: signalMappedId,
        name: 'signal-mapped',
        agentId,
        orgId,
        costCategory: 'PRODUCTION_COGS',
        glCodeId: gl5100Id,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: signalMismatchedId,
        name: 'signal-mismatched',
        agentId,
        orgId,
        // PRODUCTION_COGS expects a COGS account; 7100 is OPEX_GA — a real
        // mismatch so R4's count is non-vacuous on both sides of the compare.
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

  // usageDate = now: inside monthPeriod(0) (the books window), inside the
  // rolling 30d (the agents window), and hours inside the explicit pinned
  // window used for the direct comparison.
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
        usageDate: now,
        usageCost,
        quantity: 1,
        environment: 'production',
        idempotencyKey: `event-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
    return id
  }
  await seedEvent(signalMappedId, 100)
  await seedEvent(signalMismatchedId, 25)

  // One event in each fix-loop queue so R1's two counts are non-vacuous.
  const backfillParentId = await seedEvent(signalMappedId, 0)
  const missingVolumeParentId = await seedEvent(signalMappedId, 0)
  await prisma.signal_event_services.createMany({
    data: [
      {
        id: randomUUID(),
        signalEventId: backfillParentId,
        model: 'unknown-model',
        modelProvider: 'provider',
        eventStatus: 'NEEDS_COST_BACKFILL',
      },
      {
        id: randomUUID(),
        signalEventId: missingVolumeParentId,
        model: 'known-model',
        modelProvider: 'provider',
        eventStatus: 'MISSING_VOLUME_DATA',
      },
    ],
  })
})

afterAll(async () => {
  // signal_event_services rows cascade with their parent signal_events.
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

describe('getMfiqStatus — live composition deep-equals the direct reads', () => {
  it('the fixture actually produces non-vacuous numbers (guards the guard)', async () => {
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    const facts = result.data!
    expect(facts.books).not.toBeNull()
    expect(facts.books!.mismatchedSignalCount).toBe(1)
    expect(facts.backfillEvents).toBe(1)
    expect(facts.missingVolumeEvents).toBe(1)
    expect(facts.prevMonth).not.toBeNull()
    expect(facts.prevMonth!.locked).toBe(false)
    expect(facts.agents).not.toBeNull()
    expect(facts.agents!.rows.length).toBeGreaterThan(0)
  })

  it('facts.books equals the reduced direct getFinopsCloseStatus(monthPeriod(0)) payload', async () => {
    const current = monthPeriod(0)
    const result = await getMfiqStatus()
    const direct = await getFinopsCloseStatus({
      startDate: current.startDate,
      endDate: current.endDate,
    })
    expect(direct.success).toBe(true)
    const close = direct.data!
    expect(result.data!.books).toEqual({
      monthLabel: close.monthLabel,
      eventCount: close.eventCount,
      unmappedAmount: close.unmappedAmount,
      unmappedSignalCount: close.unmappedSignalCount,
      unclassifiedCost: close.unclassifiedCost,
      classifiedShare: close.classifiedShare,
      mismatchedSignalCount: close.mismatchedSignalCount,
    })
  })

  it('facts.books.mismatchedSignalCount === a direct getMismatchedSignalCount().count', async () => {
    const result = await getMfiqStatus()
    const direct = await getMismatchedSignalCount()
    expect(result.data!.books!.mismatchedSignalCount).toBe(direct.count)
  })

  it('facts.backfillEvents / missingVolumeEvents === the direct queue totals', async () => {
    const result = await getMfiqStatus()
    const backfill = await getNeedsCostBackfillGroups()
    const missingVolume = await getMissingVolumeGroups()
    expect(result.data!.backfillEvents).toBe(backfill.data!.totalEvents)
    expect(result.data!.missingVolumeEvents).toBe(
      missingVolume.data!.totalEvents
    )
  })

  it('facts.prevMonth mirrors a direct getPeriodLockStatus(monthPeriod(1) bounds)', async () => {
    const previous = monthPeriod(1)
    const result = await getMfiqStatus()
    const direct = await getPeriodLockStatus({
      startDate: previous.startDate,
      endDate: previous.endDate,
    })
    expect(result.data!.prevMonth).toEqual({
      monthLabel: previous.monthLabel,
      periodEndIso: `${previous.endDate}T23:59:59.999Z`,
      locked: direct.locked,
      closable: direct.closable,
    })
  })

  it('facts.agents.rows deep-equal the direct getBuildAgentsOverview rows (explicit pinned window), reduced to the mfiq shape', async () => {
    const result = await getMfiqStatus()
    const direct = await getBuildAgentsOverview({
      startDate: TEN_DAYS_AGO_ISO_DATE,
      endDate: TODAY_ISO_DATE,
    })
    expect(direct.success).toBe(true)
    expect(result.data!.agents!.rows).toEqual(
      direct.data!.rows.map(
        ({ agentId: rowAgentId, name, isActive, cost, earned, marginPercent }) => ({
          agentId: rowAgentId,
          name,
          isActive,
          cost,
          earned,
          marginPercent,
        })
      )
    )
    expect(result.data!.agents!.pausedCount).toBe(direct.data!.pausedCount)
  })
})
