/**
 * DB-GATED — requires a live Postgres connection via DATABASE_URL. Written
 * to the established *.integration.test.ts conventions (see
 * finops-close-reconciliation.integration.test.ts). Run it only against
 * a disposable database where
 * `prisma migrate deploy` has been applied.
 *
 * The CRUD roundtrip THROUGH THE REAL
 * WRITE ACTIONS (createInitiative / setInitiativeTargets / updateInitiative
 * / deleteInitiative, exercised, not re-tested):
 * create+targets(with baselineValue) → getRoiOverview shows a real actual;
 * narrowing the window MOVES the actual; archive drops actuals; delete
 * cascades targets (FK). Tests in this file are SEQUENTIAL by design — each
 * step consumes the previous step's state, exactly like a user session.
 *
 * Unlike the read-only suites, the money-write gate needs a REAL user +
 * ba_member(owner) row, so this file seeds both and mocks the session with
 * a user id (buildAuthMock carries none).
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

let sessionOrgId: string | null = null
let sessionUserId: string | null = null

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionOrgId
          ? {
              session: { activeOrganizationId: sessionOrgId },
              user: { id: sessionUserId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (_name: string) => undefined,
    getAll: () => [],
    has: () => false,
  }),
}))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))

const prisma = new PrismaClient()
const EPSILON = 0.01

type InitiativesModule = typeof import('../initiatives')
type RoiOverviewModule = typeof import('../roi-overview')
let createInitiative: InitiativesModule['createInitiative']
let updateInitiative: InitiativesModule['updateInitiative']
let deleteInitiative: InitiativesModule['deleteInitiative']
let setInitiativeTargets: InitiativesModule['setInitiativeTargets']
let getInitiatives: InitiativesModule['getInitiatives']
let getRoiOverview: RoiOverviewModule['getRoiOverview']

// Fixture math: April events cost 1.5 (day 10) + 2.25 (day 12) = 3.75.
// Cost target lte 2 with baseline 10 ⇒ progress (10 − 3.75) / (10 − 2) =
// 78.125%, not met. Narrowed to end Apr 11 ⇒ only the 1.5 event remains.
const FULL_WINDOW_COST = 3.75
const NARROW_WINDOW_COST = 1.5

let orgId: string
let userId: string
let agentId: string
let customerId: string
let customerExternalId: string
let signalId: string
let rawIngestEventId: string
let initiativeId: string
const createdEventIds: string[] = []

beforeAll(async () => {
  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-roi-roundtrip',
      createdAt: now,
      updatedAt: now,
    },
  })

  userId = randomUUID()
  await prisma.users.create({
    data: {
      id: userId,
      name: 'roundtrip-user',
      email: `${userId.slice(0, 8)}@example.test`,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.ba_member.create({
    data: {
      id: randomUUID(),
      organizationId: orgId,
      userId,
      role: 'owner',
      createdAt: now,
    },
  })

  sessionOrgId = orgId
  sessionUserId = userId
  ;({
    createInitiative,
    updateInitiative,
    deleteInitiative,
    setInitiativeTargets,
    getInitiatives,
  } = await import('../initiatives'))
  ;({ getRoiOverview } = await import('../roi-overview'))

  agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      name: 'roundtrip-agent',
      agentCode: 'roundtrip-agent',
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  customerId = randomUUID()
  customerExternalId = `rt-customer-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: 'roundtrip-customer',
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  signalId = randomUUID()
  await prisma.signals.create({
    data: {
      id: signalId,
      name: 'roundtrip-signal',
      agentId,
      orgId,
      costCategory: 'UNCLASSIFIED',
      createdAt: now,
      updatedAt: now,
    },
  })

  rawIngestEventId = randomUUID()
  await prisma.raw_ingest_events.create({
    data: {
      id: rawIngestEventId,
      organizationId: orgId,
      payload: { source: 'roundtrip-fixture' },
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })

  const seedEvent = async (usageDate: Date, usageCost: number) => {
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
        usageDate,
        usageCost,
        quantity: 1,
        environment: 'production',
        idempotencyKey: `rt-event-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  await seedEvent(new Date('2026-04-10T12:00:00.000Z'), 1.5)
  await seedEvent(new Date('2026-04-12T12:00:00.000Z'), 2.25)
})

afterAll(async () => {
  await prisma.initiative_targets.deleteMany({
    where: { initiatives: { orgId } },
  })
  await prisma.initiatives.deleteMany({ where: { orgId } })
  await prisma.signal_events.deleteMany({
    where: { id: { in: createdEventIds } },
  })
  await prisma.signals.deleteMany({ where: { orgId } })
  await prisma.raw_ingest_events.deleteMany({
    where: { id: rawIngestEventId },
  })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.agents.deleteMany({ where: { orgId } })
  await prisma.ba_member.deleteMany({ where: { organizationId: orgId } })
  await prisma.users.deleteMany({ where: { id: userId } })
  await prisma.organizations.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

function aprilTarget(
  overview: Awaited<ReturnType<RoiOverviewModule['getRoiOverview']>>
) {
  const view = overview.data!.initiatives.find((i) => i.id === initiativeId)!
  expect(view).toBeDefined()
  return { view, target: view.targets[0] }
}

describe('ROI CRUD roundtrip through the real actions (sequential)', () => {
  it('create + setInitiativeTargets(baselineValue) roundtrips the baseline', async () => {
    const created = await createInitiative({
      name: 'roundtrip-initiative',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    expect(created.success).toBe(true)
    initiativeId = created.data!.id

    const targets = await setInitiativeTargets(initiativeId, [
      {
        metric: 'cost',
        targetValue: 2,
        direction: 'lte',
        baselineValue: 10,
      },
    ])
    expect(targets.success).toBe(true)
    expect(targets.data![0].baselineValue).toBe(10)

    const listed = await getInitiatives()
    const mine = listed.data!.find((i) => i.id === initiativeId)!
    expect(mine.targets[0].baselineValue).toBe(10)
  })

  it('getRoiOverview returns the card view with a REAL canon actual + baseline progress', async () => {
    const overview = await getRoiOverview()
    expect(overview.success).toBe(true)
    const { view, target } = aprilTarget(overview)

    expect(view.status).toBe('active')
    expect(Math.abs(target.actual! - FULL_WINDOW_COST)).toBeLessThanOrEqual(
      EPSILON
    )
    expect(target.baseline).toBe(10)
    expect(target.met).toBe(false)
    // Spend is a running total, so the bar reads against the cap, not from
    // last window: $3.75 against a $2 cap fills it and the goal is unmet.
    expect(target.progressPct).toBe(100)
  })

  it('narrowing the window via updateInitiative MOVES the actual', async () => {
    const updated = await updateInitiative(initiativeId, {
      endDate: '2026-04-11',
    })
    expect(updated.success).toBe(true)

    const overview = await getRoiOverview()
    const { target } = aprilTarget(overview)
    expect(Math.abs(target.actual! - NARROW_WINDOW_COST)).toBeLessThanOrEqual(
      EPSILON
    )
  })

  it('archive drops the initiative from actuals computation (health archived, actual null)', async () => {
    const archived = await updateInitiative(initiativeId, {
      status: 'archived',
    })
    expect(archived.success).toBe(true)

    const overview = await getRoiOverview()
    const { view, target } = aprilTarget(overview)
    expect(view.health).toBe('archived')
    expect(target.actual).toBeNull()
    expect(target.progressPct).toBeNull()
    expect(overview.data!.activeCount).toBe(0)
  })

  it('deleteInitiative cascades targets (FK) — child rows gone by direct count', async () => {
    const deleted = await deleteInitiative(initiativeId)
    expect(deleted.success).toBe(true)

    expect(
      await prisma.initiatives.count({ where: { id: initiativeId } })
    ).toBe(0)
    expect(
      await prisma.initiative_targets.count({ where: { initiativeId } })
    ).toBe(0)
  })
})
