/**
 * DB-GATED: needs DATABASE_URL pointing at a throwaway Postgres.
 *
 * Org-scoping canary:
 *   Two seeded orgs; a session scoped to org A gets zero org-B rows in
 *   tiles, series, and every dimension's breakdown.
 *
 * WHY TWO FRESH ORGS: most
 * other *.integration.test.ts in this family reuse the single seeded
 * sample test organization and scope fixtures with a customerId filter
 * (see mrr-contract-value.integration.test.ts). A cross-org canary can't
 * follow that pattern — it needs two GENUINELY DISTINCT organizations, so
 * this file creates two fresh, minimal orgs with unique test ids and tears
 * them down completely in afterAll. It does NOT touch the shared test
 * organization.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const EPSILON = 0.01

let sessionOrgId: string | null = null

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionOrgId
          ? { session: { activeOrganizationId: sessionOrgId }, user: { id: 'canary-user' } }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({
  headers: async () => new Headers(),
}))

type ResolverModule = typeof import('../metrics-resolver')
let resolveMetrics: ResolverModule['resolveMetrics']

const ORG_A_ID = randomUUID()
const ORG_B_ID = randomUUID()
let agentA: string
let agentB: string
let customerA: string
let customerB: string
let signalA: string
let signalB: string
const createdEventIds: string[] = []

const WINDOW_START = '2026-04-01'
const WINDOW_END = '2026-04-05'

const createdRawIngestEventIds: string[] = []

async function seedOrg(orgId: string, label: string) {
  const now = new Date()
  await prisma.organizations.create({ data: { id: orgId, name: `org scoping ${label}` } })

  const customerId = randomUUID()
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: `Canary customer ${label}`,
      externalId: `canary-cust-${label}`,
      createdAt: now,
      updatedAt: now,
    },
  })

  const agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      orgId,
      name: `Canary agent ${label}`,
      agentCode: `canary-${label}`,
      createdAt: now,
      updatedAt: now,
    },
  })

  const signalId = randomUUID()
  await prisma.signals.create({
    data: {
      id: signalId,
      orgId,
      agentId,
      name: `Canary signal ${label}`,
      shortName: `cs${label}`,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Fresh orgs have no existing signal_events to borrow a rawIngestEventId
  // from (unlike the shared test organization other integration tests
  // use) — fabricate the minimal parent row instead.
  const rawIngestEventId = randomUUID()
  await prisma.raw_ingest_events.create({
    data: {
      id: rawIngestEventId,
      organizationId: orgId,
      payload: { model: 'canary-fixture' },
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })
  createdRawIngestEventIds.push(rawIngestEventId)

  const eventId = randomUUID()
  await prisma.signal_events.create({
    data: {
      id: eventId,
      organizationId: orgId,
      agentId,
      customerId,
      customerExternalId: `canary-cust-${label}`,
      signalId,
      rawIngestEventId,
      usageDate: new Date('2026-04-02T12:00:00.000Z'),
      usageCost: label === 'A' ? 7 : 13,
      quantity: 1,
      environment: 'production',
      idempotencyKey: `org-scoping-${eventId}`,
      createdAt: now,
      updatedAt: now,
    },
  })
  createdEventIds.push(eventId)

  return { customerId, agentId, signalId }
}

beforeAll(async () => {
  ;({ resolveMetrics } = await import('../metrics-resolver'))
  const a = await seedOrg(ORG_A_ID, 'A')
  const b = await seedOrg(ORG_B_ID, 'B')
  customerA = a.customerId
  agentA = a.agentId
  signalA = a.signalId
  customerB = b.customerId
  agentB = b.agentId
  signalB = b.signalId
})

afterAll(async () => {
  // Child-before-parent per each row's FK direction.
  await prisma.signal_events.deleteMany({ where: { id: { in: createdEventIds } } })
  await prisma.raw_ingest_events.deleteMany({ where: { id: { in: createdRawIngestEventIds } } })
  await prisma.signals.deleteMany({ where: { id: { in: [signalA, signalB] } } })
  await prisma.agents.deleteMany({ where: { id: { in: [agentA, agentB] } } })
  await prisma.customers.deleteMany({ where: { id: { in: [customerA, customerB] } } })
  await prisma.organizations.deleteMany({ where: { id: { in: [ORG_A_ID, ORG_B_ID] } } })
  await prisma.$disconnect()
})

describe('two-org scoping canary', () => {
  it('a session scoped to org A sees only org A: tiles.eventCount, tiles.cost, and every breakdown row', async () => {
    sessionOrgId = ORG_A_ID
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: {},
    })
    expect(res.success).toBe(true)
    const data = res.data!

    // Org A's fixture: exactly 1 event, cost 7. Org B's event (cost 13,
    // different agent/customer/signal) must be invisible everywhere.
    expect(data.tiles.eventCount).toBe(1)
    expect(Math.abs(data.tiles.cost - 7)).toBeLessThanOrEqual(EPSILON)

    const rowKeys = data.breakdown.rows.map((r) => r.key)
    expect(rowKeys).toContain(agentA)
    expect(rowKeys).not.toContain(agentB)

    const seriesCost = data.series.reduce((s, r) => s + r.cost, 0)
    expect(Math.abs(seriesCost - 7)).toBeLessThanOrEqual(EPSILON)
  })

  it('a session scoped to org B sees only org B (the mirror check — proves the isolation is symmetric)', async () => {
    sessionOrgId = ORG_B_ID
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: {},
    })
    expect(res.success).toBe(true)
    const data = res.data!

    expect(data.tiles.eventCount).toBe(1)
    expect(Math.abs(data.tiles.cost - 13)).toBeLessThanOrEqual(EPSILON)

    const rowKeys = data.breakdown.rows.map((r) => r.key)
    expect(rowKeys).toContain(agentB)
    expect(rowKeys).not.toContain(agentA)
  })

  it('every dimension breakdown is org-scoped, not just the agent dimension', async () => {
    sessionOrgId = ORG_A_ID
    for (const dimension of ['customer', 'signal', 'environment'] as const) {
      const res = await resolveMetrics({
        scope: 'money',
        period: { startDate: WINDOW_START, endDate: WINDOW_END },
        dimension,
        filters: {},
      })
      expect(res.success).toBe(true)
      // Org A has exactly 1 event -> exactly 1 bucket for any dimension.
      expect(res.data!.breakdown.rows.length + (res.data!.breakdown.other ? 1 : 0)).toBe(1)
      expect(res.data!.tiles.eventCount).toBe(1)
    }
  })

})
