/**
 * DB-GATED — requires a live Postgres connection via DATABASE_URL.
 *
 * The reconciliation invariant: the page shows ONE cost total everywhere,
 * never a split between "GL month-to-date" and a larger org cost. For a
 * seeded org + month window,
 *
 *   resolveMetrics({scope:'finops', dimension:'costCategory', period})
 *     .data.tiles.cost === getJournalExport(period).totalAmount
 *
 * and the journal's own double-entry lines balance:
 *
 *   sum(buildJournalLines(journal).debits) === journal.totalAmount
 *     === the single credit line's amount
 *
 * Donut total (resolver), table footer (resolver breakdown), and journal
 * credit (getJournalExport + buildJournalLines) all have to render the same
 * number for the same window.
 *
 * Session/org injection + fixture-id hygiene follow the same pattern (and
 * the same "own throwaway org, not the shared test organization" rationale — these
 * reads are org+window scoped with no per-customer filter) as
 * finops-close-status.integration.test.ts in this directory.
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
const EPSILON = 0.01

type MetricsResolverModule = typeof import('../metrics-resolver')
type JournalExportModule = typeof import('../journal-export')
type JournalUtilsModule = typeof import('@/features/cost-management/journal-utils')

let resolveMetrics: MetricsResolverModule['resolveMetrics']
let getJournalExport: JournalExportModule['getJournalExport']
let buildJournalLines: JournalUtilsModule['buildJournalLines']
let OFFSET_ACCOUNT: JournalUtilsModule['OFFSET_ACCOUNT']

const WINDOW = { startDate: '2026-04-01', endDate: '2026-04-30' }

let orgId: string
let agentId: string
let customerId: string
let customerExternalId: string
let glCodeId: string
let signalMappedId: string // PRODUCTION_COGS, direct GL mapping
let signalUnmappedId: string // UNCLASSIFIED, no GL — stays in the journal's __unmapped bucket
let rawIngestEventId: string
const createdEventIds: string[] = []

beforeAll(async () => {
  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-reconciliation',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ resolveMetrics } = await import('../metrics-resolver'))
  ;({ getJournalExport } = await import('../journal-export'))
  ;({ buildJournalLines, OFFSET_ACCOUNT } = await import(
    '@/features/cost-management/journal-utils'
  ))

  agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      name: 'fixture-agent-3',
      agentCode: 'agent-3',
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  customerId = randomUUID()
  customerExternalId = `customer-3-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: 'fixture-customer-3',
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  glCodeId = randomUUID()
  await prisma.chart_of_accounts.create({
    data: {
      id: glCodeId,
      orgId,
      glCode: '5100',
      glName: 'fixture-gl-5100c',
      costCategory: 'PRODUCTION_COGS',
      accountingType: 'COGS',
      isDefault: false,
    },
  })

  signalMappedId = randomUUID()
  signalUnmappedId = randomUUID()
  await prisma.signals.createMany({
    data: [
      {
        id: signalMappedId,
        name: 'signal-mapped',
        agentId,
        orgId,
        costCategory: 'PRODUCTION_COGS',
        glCodeId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: signalUnmappedId,
        name: 'signal-unmapped',
        agentId,
        orgId,
        costCategory: 'UNCLASSIFIED',
        glCodeId: null,
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

  const seedEvent = async (signalId: string, usageCost: number, day: string) => {
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
        usageDate: new Date(`2026-04-${day}T12:00:00.000Z`),
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
  // Split across two days and two categories so the invariant isn't
  // vacuously true for a single-row journal — categorized (mapped) AND
  // unclassified (unmapped) cost both have to reconcile.
  await seedEvent(signalMappedId, 200, '10')
  await seedEvent(signalMappedId, 100, '12')
  await seedEvent(signalUnmappedId, 120, '11')
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

describe('FinOps reconciliation invariant — one total everywhere', () => {
  it('the fixture produces the numbers the invariant depends on (guards the guard)', async () => {
    const journal = await getJournalExport(WINDOW)
    expect(journal).not.toBeNull()
    expect(journal!.totalAmount).toBeCloseTo(420, 6) // 200 + 100 + 120
    expect(journal!.unmappedAmount).toBeCloseTo(120, 6)
    expect(journal!.rows.length).toBe(2) // one mapped GL row, one unmapped row
  })

  it('resolveMetrics(scope:finops).tiles.cost === getJournalExport(window).totalAmount', async () => {
    const resolved = await resolveMetrics({
      scope: 'finops',
      period: WINDOW,
      dimension: 'costCategory',
      filters: {},
    })
    expect(resolved.success).toBe(true)

    const journal = await getJournalExport(WINDOW)
    expect(journal).not.toBeNull()

    expect(
      Math.abs(resolved.data!.tiles.cost - journal!.totalAmount)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('the donut/table breakdown also reconciles to the same total (no fourth "awaiting GL booking" bucket)', async () => {
    const resolved = await resolveMetrics({
      scope: 'finops',
      period: WINDOW,
      dimension: 'costCategory',
      filters: {},
    })
    const data = resolved.data!
    const rowsCost =
      data.breakdown.rows.reduce((s, r) => s + r.cost, 0) +
      (data.breakdown.other?.cost ?? 0)
    expect(Math.abs(rowsCost - data.tiles.cost)).toBeLessThanOrEqual(EPSILON)

    // Exactly two costCategory buckets: PRODUCTION_COGS (mapped) and
    // UNCLASSIFIED — the honest split the real engine produces,
    // never a third "awaiting GL booking" bucket.
    const keys = data.breakdown.rows.map((r) => r.key).sort()
    expect(keys).toEqual(['PRODUCTION_COGS', 'UNCLASSIFIED'])
  })

  it("the journal's double-entry lines balance: sum(debits) === totalAmount === the single credit", async () => {
    const journal = await getJournalExport(WINDOW)
    expect(journal).not.toBeNull()

    const lines = buildJournalLines(journal!)
    const debitLines = lines.filter((l) => l.credit === 0)
    const creditLines = lines.filter((l) => l.debit === 0)

    expect(creditLines.length).toBe(1)
    expect(creditLines[0].glCode).toBe(OFFSET_ACCOUNT.glCode)
    expect(creditLines[0].credit).toBeCloseTo(journal!.totalAmount, 6)

    const sumOfDebits = debitLines.reduce((s, l) => s + l.debit, 0)
    expect(sumOfDebits).toBeCloseTo(journal!.totalAmount, 6)
    expect(sumOfDebits).toBeCloseTo(creditLines[0].credit, 6)

    // One debit line per GL bucket (mapped + unmapped) plus the one credit.
    expect(debitLines.length).toBe(journal!.rows.length)
  })
})
