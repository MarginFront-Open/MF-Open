/**
 * DB-GATED — requires a live Postgres connection via DATABASE_URL. Real-DB
 * confirmation of journal-export-category-fallback.test.ts's mocked A/B/C
 * fixture: that suite proves the
 * unmappedSignalCount logic against a fully-mocked '@/app/lib/db'; this file
 * proves the SAME semantics against real Postgres: the
 * category-default-GL fallback, the chart-of-accounts join, and the
 * signal_events aggregation all have to actually work together for the
 * count to come out right, which a mock can't verify.
 *
 * Session/org injection + fixture-id hygiene follow the same pattern (and
 * the same rationale for a throwaway org instead of the shared test organization) as
 * finops-close-status.integration.test.ts in this directory — see that
 * file's header comment for the full explanation.
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

type JournalExportModule = typeof import('../journal-export')
let getJournalExport: JournalExportModule['getJournalExport']

const FILTER = { startDate: '2026-06-01', endDate: '2026-06-30' }

let orgId: string
let agentId: string
let customerId: string
let customerExternalId: string
let gl5100Id: string
let gl6800Id: string
// sigRd  : DEVELOPMENT_RD, NO glCodeId        → must fall back to 6800
// sigCogs: PRODUCTION_COGS, explicit glCodeId → must stay on its mapped 5100
// sigUnc : UNCLASSIFIED, NO glCodeId          → must stay __unmapped
let sigRdId: string
let sigCogsId: string
let sigUncId: string

beforeAll(async () => {
  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-unmapped-count',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ getJournalExport } = await import('../journal-export'))

  agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      name: 'fixture-agent-2',
      agentCode: 'agent-2',
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  customerId = randomUUID()
  customerExternalId = `customer-2-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: 'fixture-customer-2',
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  gl5100Id = randomUUID()
  gl6800Id = randomUUID()
  await prisma.chart_of_accounts.createMany({
    data: [
      {
        id: gl5100Id,
        orgId,
        glCode: '5100',
        glName: 'fixture-gl-5100b',
        costCategory: 'PRODUCTION_COGS',
        accountingType: 'COGS',
        isDefault: false,
      },
      {
        id: gl6800Id,
        orgId,
        glCode: '6800',
        glName: 'fixture-gl-6800b',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
        isDefault: false,
      },
    ],
  })

  sigRdId = randomUUID()
  sigCogsId = randomUUID()
  sigUncId = randomUUID()
  await prisma.signals.createMany({
    data: [
      {
        id: sigRdId,
        name: 'signal-rd',
        agentId,
        orgId,
        costCategory: 'DEVELOPMENT_RD',
        glCodeId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: sigCogsId,
        name: 'signal-cogs',
        agentId,
        orgId,
        costCategory: 'PRODUCTION_COGS',
        glCodeId: gl5100Id,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: sigUncId,
        name: 'signal-unc',
        agentId,
        orgId,
        costCategory: 'UNCLASSIFIED',
        glCodeId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
})

afterAll(async () => {
  await prisma.signals.deleteMany({ where: { orgId } })
  await prisma.chart_of_accounts.deleteMany({ where: { orgId } })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.agents.deleteMany({ where: { orgId } })
  await prisma.organizations.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

/** One raw_ingest_events row + N signal_events rows, all cleaned up in the
 * caller's `finally` — keeps each test's event set from leaking into the
 * next test in this file, so the suite stays rerunnable and order-independent. */
async function withEvents<T>(
  events: Array<{ signalId: string | null; usageCost: number }>,
  run: () => Promise<T>
): Promise<T> {
  const now = new Date()
  const rawIngestEventId = randomUUID()
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
  const eventIds: string[] = []
  try {
    for (const ev of events) {
      const id = randomUUID()
      await prisma.signal_events.create({
        data: {
          id,
          organizationId: orgId,
          agentId,
          customerId,
          customerExternalId,
          signalId: ev.signalId,
          rawIngestEventId,
          usageDate: new Date('2026-06-15T12:00:00.000Z'),
          usageCost: ev.usageCost,
          quantity: 1,
          environment: ev.signalId ? 'production' : null,
          idempotencyKey: `event-${id}`,
          createdAt: now,
          updatedAt: now,
        },
      })
      eventIds.push(id)
    }
    return await run()
  } finally {
    await prisma.signal_events.deleteMany({ where: { id: { in: eventIds } } })
    await prisma.raw_ingest_events.deleteMany({
      where: { id: rawIngestEventId },
    })
  }
}

describe('getJournalExport.unmappedSignalCount — journal semantics against a REAL database', () => {
  it('counts only the signal behind __unmapped: 1 — a glCodeId-null count would read 2', async () => {
    await withEvents(
      [
        { signalId: sigRdId, usageCost: 10 }, // falls back to 6800, NOT unmapped
        { signalId: sigCogsId, usageCost: 20 }, // direct mapping to 5100
        { signalId: sigUncId, usageCost: 5 }, // UNCLASSIFIED, stays unmapped
      ],
      async () => {
        const out = await getJournalExport(FILTER)
        expect(out).not.toBeNull()

        const row6800 = out!.rows.find((r) => r.glCode === '6800')
        expect(row6800?.amount).toBeCloseTo(10, 6)
        const row5100 = out!.rows.find((r) => r.glCode === '5100')
        expect(row5100?.amount).toBeCloseTo(20, 6)
        const unmapped = out!.rows.find((r) => r.glCode === null)
        expect(unmapped?.amount).toBeCloseTo(5, 6)

        expect(out!.totalAmount).toBeCloseTo(35, 6)
        // sigRd AND sigUnc both have glCodeId === null, but sigRd books to
        // 6800 via the category fallback — only sigUnc is truly
        // unmapped. This assertion goes red if the count ever keys off
        // glCodeId === null instead of the '__unmapped' booking key.
        expect(out!.unmappedSignalCount).toBe(1)
        expect(out!.unmappedAmount).toBeCloseTo(5, 6)
      }
    )
  })

  it('two unmapped events with NO signal collapse to a single synthetic member (+1, not +2)', async () => {
    await withEvents(
      [
        { signalId: sigCogsId, usageCost: 20 }, // mapped — contributes 0 unmapped
        { signalId: null, usageCost: 3 },
        { signalId: null, usageCost: 4 },
      ],
      async () => {
        const out = await getJournalExport(FILTER)
        expect(out).not.toBeNull()
        expect(out!.unmappedSignalCount).toBe(1)
        // The count never reads 0 while unmapped dollars are nonzero.
        expect(out!.unmappedAmount).toBeCloseTo(7, 6)
      }
    )
  })
})
