/**
 * Breakdown tab totals reconcile to canon C1.
 *
 * `getFullCommandCenterBreakdown()` returns 5 dimension tabs (Model/"service",
 * Plan, Task, Agent, Customer). Each tab must total to canon C1 — the SUM of
 * `signal_events.usageCost` over the rolling now()-30d window with NO
 * subscription filter (packages/db/CANON.md C1). The Model tab is the risky one:
 * grouping ONLY by `signal_event_services` children would DROP every childless
 * event (no service row) and under-report the Model tab badly.
 *
 * The Model tab groups model-bearing events by RESOLVED model:
 *   child `signal_event_services.model`  (childed events)
 *     ELSE `raw_ingest_events.payload->>'model'`  (childless-WITH-model = the
 *          coding-meter case)
 * A genuinely model-less event carries no cost (cost⇒model invariant — it's a
 * needs-cost-backfill event) and is dropped from the Model tab; there is no
 * "No model" row. Dropping a $0 slice leaves canon
 * C1 intact.
 *
 * WHY THIS TEST SEEDS DATA: the sample data has no childless events at all,
 * so ambient data alone can't
 * exercise the "childless-WITH-model rides its real model, not 'No model'"
 * branch (the coding-meter case). It also can't isolate a cost-only ($0-revenue)
 * row to prove the no-NaN margin guard. So this test ADDITIVELY seeds, inside
 * the window and removed in afterAll (seed, verify, restore):
 *   - ONE childless event whose raw_ingest_events.payload carries a distinctive
 *     sentinel model + real cost → must surface UNDER that model.
 *   - ONE childless event whose raw payload has NO model + null cost
 *     (needs-cost-backfill) → must NOT produce a "No model" row.
 *   - both attach to a fresh cost-only customer with NO subscription and NO
 *     invoices, so its only revenue is $0 → its margin is a real loss and the
 *     marginPct guard must yield null, never NaN.
 *
 * MUTATION / ANTI-TAUTOLOGY PROOF: the seeded childless cost is provably part
 * of canon C1 (raw SUM of signal_events.usageCost) and provably ABSENT from the
 * childed-only Model total (raw SUM of signal_event_services.usageCost).
 * The Model tab is asserted strictly closer to canon than the childed-only
 * number is, so a childed-only grouping misses the seeded slice and FAILS
 * this suite. This makes the test failing-capable on ANY database, not only
 * one whose ambient data happens to contain childless-with-model rows.
 *
 * Asserts RELATIONSHIPS (every tab == canon, tabs == each other, gap >=
 * seeded slice), never hardcoded dollar absolutes — the database is shared.
 */

import { randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

// Mocks must be declared before the action module is loaded.
const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type FullCommandCenterModule = typeof import('../full-command-center')
let fullActions: FullCommandCenterModule

const prisma = new PrismaClient()
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Distinctive 6-dp values (fit Decimal(18,6)) — large enough that the sentinel
// model is comfortably inside the Model tab's top-19 row cap (it won't get
// folded into the "Other" tail), and so the deltas read cleanly in failures.
const SENTINEL_MODEL = 'test-sentinel-model'
const SENTINEL_COST_MODEL = 511.511511
// The model-less childless event is a needs-cost-backfill event: per the
// cost⇒model invariant it carries NO cost, so it adds $0 to canon C1 and
// produces no "No model" row. The only seeded
// childless cost is therefore the with-model slice.
const SEEDED_CHILDLESS_COST = SENTINEL_COST_MODEL
const COST_ONLY_CUSTOMER_NAME = `cost-only ${randomUUID().slice(0, 8)}`

let orgId = ''
const cleanup: {
  eventIds: string[]
  rawIds: string[]
  customerId: string
} = { eventIds: [], rawIds: [], customerId: '' }

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  fullActions = await import('../full-command-center')

  // Borrow an agent id from any existing event so the seeded rows satisfy the
  // agents FK without fabricating an agent.
  const template = await prisma.signal_events.findFirst({
    where: { organizationId: orgId },
    select: { agentId: true },
  })
  if (!template) {
    throw new Error(
      'No signal_events in the test organization to template the seed from. Run ' +
        '`npm run db:setup` before this test so the sample data can be priced.'
    )
  }

  const now = new Date()
  // 1h inside the window so neither the test's nor the action's slightly later
  // now()-30d boundary can clip the seeded rows.
  const usageDate = new Date(now.getTime() - 60 * 60 * 1000)

  // Fresh cost-only customer: no subscription, no invoices → $0 revenue, so its
  // only margin is a pure loss (drives the no-NaN marginPct guard assertion).
  cleanup.customerId = randomUUID()
  await prisma.customers.create({
    data: {
      id: cleanup.customerId,
      organizationId: orgId,
      name: COST_ONLY_CUSTOMER_NAME,
      externalId: `test-${cleanup.customerId}`,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Two raw_ingest_events: one whose payload carries a model (coding-meter case),
  // one with no model at all (genuinely model-less).
  const rawWithModel = randomUUID()
  const rawNoModel = randomUUID()
  cleanup.rawIds.push(rawWithModel, rawNoModel)
  await prisma.raw_ingest_events.createMany({
    data: [
      {
        id: rawWithModel,
        organizationId: orgId,
        payload: { model: SENTINEL_MODEL, source: 'breakdown-parity-test' },
        receivedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: rawNoModel,
        organizationId: orgId,
        payload: { source: 'breakdown-parity-test', note: 'no model key' },
        receivedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })

  // Two CHILDLESS signal_events (no signal_event_services children created):
  //   - childless-WITH-model (real cost) → resolves to SENTINEL_MODEL
  //   - genuinely model-less (needs-cost-backfill, null cost) → dropped from the
  //     Model tab, no "No model" row
  // Both: cost-only customer, no subscription (null plan → "No plan" bucket),
  // no signal (null signal → "No task" bucket). $0 revenue.
  const evWithModel = randomUUID()
  const evNoModel = randomUUID()
  cleanup.eventIds.push(evWithModel, evNoModel)
  await prisma.signal_events.createMany({
    data: [
      {
        id: evWithModel,
        organizationId: orgId,
        customerId: cleanup.customerId,
        customerExternalId: `test-${cleanup.customerId}`,
        agentId: template.agentId,
        signalId: null,
        rawIngestEventId: rawWithModel,
        subscriptionId: null,
        usageDate,
        quantity: 1,
        usageCost: SENTINEL_COST_MODEL,
        idempotencyKey: `breakdown-parity-${evWithModel}`,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: evNoModel,
        organizationId: orgId,
        customerId: cleanup.customerId,
        customerExternalId: `test-${cleanup.customerId}`,
        agentId: template.agentId,
        signalId: null,
        rawIngestEventId: rawNoModel,
        subscriptionId: null,
        usageDate,
        quantity: 1,
        // needs-cost-backfill: model-less ⇒ no cost (drives the no-"No model"
        // assertion — a costless model-less event must not surface any row).
        usageCost: null,
        idempotencyKey: `breakdown-parity-${evNoModel}`,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
})

afterAll(async () => {
  // Delete in FK order: events (reference raw_ingest_events via NoAction) → raw
  // events → customer. Each guarded so a partial failure still sweeps the rest.
  for (const id of cleanup.eventIds) {
    await prisma.signal_events
      .delete({ where: { id } })
      .catch(() => console.warn(`Breakdown parity test: failed to delete seeded event ${id}`))
  }
  if (cleanup.rawIds.length > 0) {
    await prisma.raw_ingest_events
      .deleteMany({ where: { id: { in: cleanup.rawIds } } })
      .catch(() => console.warn('Breakdown parity test: failed to delete seeded raw events'))
  }
  if (cleanup.customerId) {
    await prisma.customers
      .delete({ where: { id: cleanup.customerId } })
      .catch(() =>
        console.warn(`Breakdown parity test: failed to delete seeded customer ${cleanup.customerId}`)
      )
  }
  await prisma.$disconnect()
})

function last30DaysWindow() {
  const now = new Date()
  return { start: new Date(now.getTime() - 30 * MS_PER_DAY), end: now }
}

function toNum(x: unknown): number {
  if (x === null || x === undefined) return 0
  return Number((x as { toString(): string }).toString())
}

/**
 * Independent ground truth: raw Prisma aggregate of signal_events.usageCost over
 * the window = canon C1 (DB SUM ignores NULLs, exactly C1's "null counts as $0"
 * rule). Deliberately NOT getCostMetrics — that is the very helper the action
 * delegates to, so reusing it would make the parity check circular.
 *
 * `childedOnly` = raw SUM of signal_event_services.usageCost for children whose
 * parent event is in the window = what childed-only grouping would report
 * for the Model tab. The gap between the two is the childless slice.
 */
async function rawWindowSums(window: { start: Date; end: Date }) {
  const [parentAgg, childAgg] = await Promise.all([
    prisma.signal_events.aggregate({
      where: {
        organizationId: orgId,
        usageDate: { gte: window.start, lte: window.end },
      },
      _sum: { usageCost: true },
    }),
    prisma.signal_event_services.aggregate({
      where: {
        signal_events: {
          organizationId: orgId,
          usageDate: { gte: window.start, lte: window.end },
        },
      },
      _sum: { usageCost: true },
    }),
  ])
  return {
    canonC1: toNum(parentAgg._sum.usageCost),
    childedOnly: toNum(childAgg._sum.usageCost),
  }
}

function sumCost(rows: Array<{ cost: number }>): number {
  return rows.reduce((s, r) => s + r.cost, 0)
}

function expectCloseEnough(
  actual: number,
  expected: number,
  label: string,
  tol = 0.01
): void {
  const diff = Math.abs(actual - expected)
  if (diff > tol) {
    throw new Error(
      `${label}: expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (diff ${diff.toFixed(4)}, tol ${tol})`
    )
  }
}

describe('every breakdown tab reconciles to canon C1', () => {
  it('the seeded childless slice exists and is dropped by a childed-only Model total', async () => {
    const { canonC1, childedOnly } = await rawWindowSums(last30DaysWindow())
    // Guard against a vacuous green: discriminating slice must be present.
    expect(canonC1).toBeGreaterThan(0)
    // canon C1 exceeds the childed-only total by AT LEAST the seeded
    // childless cost — i.e. a childed-only grouping under-reports by that slice.
    expect(canonC1 - childedOnly).toBeGreaterThanOrEqual(
      SEEDED_CHILDLESS_COST - 0.01
    )
  })

  it('Model == Plan == Task == Agent == Customer == canon C1 (cross-dimension invariant)', async () => {
    const { canonC1 } = await rawWindowSums(last30DaysWindow())
    const bd = await fullActions.getFullCommandCenterBreakdown()

    const modelTotal = sumCost(bd.service)
    const planTotal = sumCost(bd.plan)
    const taskTotal = sumCost(bd.task)
    const agentTotal = sumCost(bd.agent)
    const customerTotal = sumCost(bd.customer)

    // Each dimension is a partition of the same event set → each totals to C1.
    expectCloseEnough(modelTotal, canonC1, 'Model tab total vs canon C1')
    expectCloseEnough(planTotal, canonC1, 'Plan tab total vs canon C1')
    expectCloseEnough(taskTotal, canonC1, 'Task tab total vs canon C1')
    expectCloseEnough(agentTotal, canonC1, 'Agent tab total vs canon C1')
    expectCloseEnough(customerTotal, canonC1, 'Customer tab total vs canon C1')

    // And the tabs agree with each other (same internal window, no drift).
    expectCloseEnough(modelTotal, planTotal, 'Model vs Plan')
    expectCloseEnough(modelTotal, taskTotal, 'Model vs Task')
    expectCloseEnough(modelTotal, agentTotal, 'Model vs Agent')
    expectCloseEnough(modelTotal, customerTotal, 'Model vs Customer')
  })

  it('MUTATION PROOF: Model total reconciles to canon; childed-only does not', async () => {
    const { canonC1, childedOnly } = await rawWindowSums(last30DaysWindow())
    const bd = await fullActions.getFullCommandCenterBreakdown()
    const modelTotal = sumCost(bd.service)

    // The Model grouping lands on canon C1; the childed-only number misses
    // by at least the seeded childless slice. Framed as "strictly closer to
    // canon than the childed-only number" so boundary pennies can't flip it,
    // while a childed-only grouping fails outright.
    expect(Math.abs(modelTotal - canonC1)).toBeLessThan(
      Math.abs(childedOnly - canonC1)
    )
    expect(Math.abs(childedOnly - canonC1)).toBeGreaterThanOrEqual(
      SEEDED_CHILDLESS_COST - 0.01
    )
  })
})

describe('model resolution — childless-with-model rides its real model, model-less produces no row', () => {
  it('the childless-WITH-payload-model event surfaces UNDER its real model, not "No model"', async () => {
    const bd = await fullActions.getFullCommandCenterBreakdown()
    const modelRow = bd.service.find((r) => r.name === SENTINEL_MODEL)
    expect(modelRow).toBeDefined()
    // Its only event is the seeded cost-only one → exact cost, $0 revenue.
    expectCloseEnough(
      modelRow!.cost,
      SENTINEL_COST_MODEL,
      'sentinel model row cost'
    )
    expect(modelRow!.revenue).toBe(0)
    // $0-revenue cost-only row → real loss, marginPct null (canon M1), NOT NaN.
    expect(modelRow!.margin).toBeLessThan(0)
    expect(modelRow!.marginPct).toBeNull()
  })

  it('a genuinely model-less (needs-cost-backfill) event produces NO "No model" row', async () => {
    const bd = await fullActions.getFullCommandCenterBreakdown()
    // There is no "No model" bucket. The model-less event carries no cost,
    // so dropping it from the Model tab is lossless.
    const noModelRow = bd.service.find((r) => r.name === 'No model')
    expect(noModelRow).toBeUndefined()
    // And the Model tab still reconciles to canon C1 (the dropped slice is $0).
    const { canonC1 } = await rawWindowSums(last30DaysWindow())
    expectCloseEnough(
      sumCost(bd.service),
      canonC1,
      'Model tab total vs canon C1 (model-less dropped)'
    )
  })
})

describe('a cost-only ($0-revenue) customer reads a real loss with no NaN', () => {
  it('the cost-only customer row has cost>0, revenue 0, margin<0, marginPct null', async () => {
    const bd = await fullActions.getFullCommandCenterBreakdown()
    const row = bd.customer.find((r) => r.name === COST_ONLY_CUSTOMER_NAME)
    expect(row).toBeDefined()
    expectCloseEnough(
      row!.cost,
      SEEDED_CHILDLESS_COST,
      'cost-only customer cost'
    )
    expect(row!.revenue).toBe(0)
    expect(row!.margin).toBeLessThan(0)
    // The guard under test: revenue=0 → marginPct null (canon M1), never NaN.
    expect(row!.marginPct).toBeNull()
    expect(Number.isNaN(row!.marginPct as unknown as number)).toBe(false)
  })

  it('NO-NaN sweep: no row in any tab carries a NaN numeric or a NaN marginPct', async () => {
    const bd = await fullActions.getFullCommandCenterBreakdown()
    const allRows = [
      ...bd.service,
      ...bd.task,
      ...bd.agent,
      ...bd.customer,
      ...bd.plan,
    ]
    expect(allRows.length).toBeGreaterThan(0)
    for (const r of allRows) {
      for (const [field, val] of [
        ['cost', r.cost],
        ['qty', r.qty],
        ['events', r.events],
        ['avgCost', r.avgCost],
        ['revenue', r.revenue],
        ['earned', r.earned],
        ['margin', r.margin],
      ] as const) {
        if (!Number.isFinite(val)) {
          throw new Error(
            `Row "${r.name}" has non-finite ${field}=${String(val)}`
          )
        }
      }
      // marginPct is intentionally nullable (canon M1) but must never be NaN.
      if (r.marginPct !== null && !Number.isFinite(r.marginPct)) {
        throw new Error(
          `Row "${r.name}" has non-finite marginPct=${String(r.marginPct)}`
        )
      }
    }
  })
})
