/**
 * DB-GATED: needs DATABASE_URL pointing at a throwaway Postgres. Follows the api-nest
 * integration-test convention (see webhook-dedupe.integration.spec.ts):
 * self-skip loudly if the environment isn't ready (checked synchronously at
 * describe-registration time, before any Prisma client is constructed),
 * rather than failing CI.
 *
 * SQL-vs-Map equivalence:
 *   getCostBreakdown ($queryRaw grouping, packages/db/src/lib/
 *   cost-grouping.ts) must produce, for EACH of the 8 dimensions, the exact
 *   same buckets (key, cost, eventCount) as getCostMetrics' in-memory Map
 *   path (packages/db/src/lib/revenue-metrics.ts, computeCostMetricsForWindow
 *   — not separately exported, so this compares against the public
 *   getCostMetrics() wrapper's by<Dimension> arrays, which already surface
 *   every dimension). The fixture below is deliberately hostile:
 *   null usageCost, an orphan event (no subscription), model present /
 *   absent / empty-string / non-string, a null-signal event, null
 *   environment, two events straddling a UTC day boundary, and one
 *   multi-service event (2 signal_event_services children) proving neither
 *   path fans out eventCount for it.
 *
 * ORDERING NOTE (read before trusting a naive "same order" assumption):
 * computeCostMetricsForWindow orders its OWN per-dimension arrays nulls
 * last, day ascending, costCategory in a fixed order (documented in the
 * data layer). getCostBreakdown's `rows` field, however, is
 * ORDER BY cost DESC for every dimension including 'day' (one
 * consistent ranking is what makes pagination + the "Other" rollup work at
 * all); only the separate `series` field is date-ascending. So this file
 * asserts bucket CONTENT equivalence (same keys, same cost, same
 * eventCount) as a set for all 8 dimensions, and checks order only where it
 * actually should match: `series` vs the Map's `byDay`, both ascending.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getCostMetrics, getCostBreakdown, DimensionSchema, type Dimension } from '@marginfront/db';

// Self-skip guard (api-nest integration-test convention — see
// webhook-dedupe.integration.spec.ts): the decision must be made
// synchronously at describe-registration time, and the Prisma client must
// not be constructed at all when DATABASE_URL is absent.
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  // eslint-disable-next-line no-console -- explains why the suite skipped
  console.warn(
    '[cost-breakdown-sql-parity.integration.spec] DATABASE_URL not set, skipping (DB-gated).',
  );
}
const describeIfDb = HAS_DB ? describe : describe.skip;

const FLOAT_TOLERANCE = 1e-9;
const WINDOW_START = new Date('2026-05-10T00:00:00.000Z');
const WINDOW_END = new Date('2026-05-13T00:00:00.000Z');

type BucketKey = string | null;
interface Bucket {
  cost: number;
  eventCount: number;
}

function toBucketMap(
  rows: Array<Record<string, unknown>>,
  keyField: string,
): Map<BucketKey, Bucket> {
  const map = new Map<BucketKey, Bucket>();
  for (const row of rows) {
    let key = row[keyField] as unknown;
    if (key instanceof Date) key = key.toISOString().slice(0, 10);
    map.set((key as BucketKey) ?? null, {
      cost: row.cost as number,
      eventCount: row.eventCount as number,
    });
  }
  return map;
}

const DIMENSION_TO_MAP_FIELD: Record<Dimension, { arrayField: string; keyField: string }> = {
  agent: { arrayField: 'byAgent', keyField: 'agentId' },
  customer: { arrayField: 'byCustomer', keyField: 'customerId' },
  signal: { arrayField: 'bySignal', keyField: 'signalId' },
  day: { arrayField: 'byDay', keyField: 'date' },
  plan: { arrayField: 'byPlan', keyField: 'planId' },
  model: { arrayField: 'byModel', keyField: 'model' },
  costCategory: { arrayField: 'byCostCategory', keyField: 'costCategory' },
  environment: { arrayField: 'byEnvironment', keyField: 'environment' },
};

describeIfDb(
  'getCostBreakdown vs getCostMetrics — bucket equivalence across all 8 dimensions',
  () => {
    // Constructed only when HAS_DB is true (module-scope construction with no
    // DATABASE_URL can throw before the skip guard even takes effect).
    let prisma: PrismaClient;

    let orgId: string;
    let customerId: string;
    let agentId: string;
    let signalId: string;
    let subscriptionId: string;
    let planId: string;
    let strategyId: string;
    const createdEventIds: string[] = [];
    const createdRawIngestEventIds: string[] = [];
    const createdServiceRowIds: string[] = [];

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the env check so a skipped suite never constructs it
      const { PrismaClient: RealPrismaClient } = require('@prisma/client');
      prisma = new RealPrismaClient();

      // Any org with agents/signals will do, since every event below is
      // created by this test and customer-scoped.
      const anyOrg = await prisma.organizations.findFirst({ select: { id: true } });
      if (!anyOrg) throw new Error('No organizations in this environment — run the seed first.');
      orgId = anyOrg.id;

      const agent = await prisma.agents.findFirst({
        where: { orgId, deletedAt: null },
        select: { id: true },
      });
      if (!agent) throw new Error('Org has no agents — run the seed first.');
      agentId = agent.id;

      const sig = await prisma.signals.findFirst({
        where: { orgId, deletedAt: null },
        select: { id: true },
      });
      if (!sig) throw new Error('Org has no signals — run the seed first.');
      signalId = sig.id;

      const now = new Date();

      customerId = randomUUID();
      await prisma.customers.create({
        data: {
          id: customerId,
          organizationId: orgId,
          name: `sql parity customer ${customerId.slice(0, 8)}`,
          externalId: `test-${customerId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
        },
      });

      planId = randomUUID();
      await prisma.pricing_plans.create({
        data: {
          id: planId,
          orgId,
          agentId,
          name: `sql parity plan`,
          createdAt: now,
          updatedAt: now,
        },
      });
      strategyId = randomUUID();
      await prisma.pricing_strategies.create({
        data: {
          id: strategyId,
          planId,
          orgId,
          agentId,
          signalId,
          name: 'sql parity strategy',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 1,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
      });
      subscriptionId = randomUUID();
      const farFuture = new Date('2099-12-31T00:00:00Z');
      await prisma.subscriptions.create({
        data: {
          id: subscriptionId,
          organizationId: orgId,
          customerId,
          agentId,
          planId,
          name: 'sql parity subscription',
          status: 'active',
          billingCycle: 'monthly',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          nextRecurringInvoiceAt: farFuture,
          nextUsageInvoiceAt: farFuture,
          createdAt: now,
          updatedAt: now,
        },
      });

      const makeRawIngestEvent = async (
        payload: Record<string, string | number | boolean | null>,
      ) => {
        const id = randomUUID();
        await prisma.raw_ingest_events.create({
          data: {
            id,
            organizationId: orgId,
            payload,
            receivedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        createdRawIngestEventIds.push(id);
        return id;
      };
      const riePresent = await makeRawIngestEvent({ model: 'gpt-4' });
      const rieAbsent = await makeRawIngestEvent({ note: 'no model key at all' });
      const rieEmpty = await makeRawIngestEvent({ model: '' });
      const rieNonString = await makeRawIngestEvent({ model: 123 });

      const makeEvent = async (opts: {
        day: string;
        usageCost: number | null;
        rawIngestEventId: string;
        subscriptionId: string | null;
        signalId: string | null;
        environment: 'production' | 'staging' | null;
      }) => {
        const id = randomUUID();
        await prisma.signal_events.create({
          data: {
            id,
            organizationId: orgId,
            agentId,
            customerId,
            customerExternalId: `test-${customerId.slice(0, 8)}`,
            signalId: opts.signalId,
            subscriptionId: opts.subscriptionId,
            rawIngestEventId: opts.rawIngestEventId,
            usageDate: new Date(opts.day),
            usageCost: opts.usageCost,
            quantity: 1,
            environment: opts.environment,
            idempotencyKey: `sql-parity-${id}`,
            createdAt: now,
            updatedAt: now,
          },
        });
        createdEventIds.push(id);
        return id;
      };

      // E1: subscribed, cost present, model present, production.
      await makeEvent({
        day: '2026-05-10T10:00:00.000Z',
        usageCost: 1.5,
        rawIngestEventId: riePresent,
        subscriptionId,
        signalId,
        environment: 'production',
      });
      // E2: orphan (no subscription), NULL usageCost, model absent, NULL environment.
      await makeEvent({
        day: '2026-05-10T14:00:00.000Z',
        usageCost: null,
        rawIngestEventId: rieAbsent,
        subscriptionId: null,
        signalId,
        environment: null,
      });
      // E3: subscribed, model empty-string (-> null bucket), staging, 1 minute
      // before a UTC day boundary.
      await makeEvent({
        day: '2026-05-11T23:59:00.000Z',
        usageCost: 2.25,
        rawIngestEventId: rieEmpty,
        subscriptionId,
        signalId,
        environment: 'staging',
      });
      // E4: orphan, model non-string (-> null bucket), production, 1 minute
      // after the same UTC day boundary as E3 (day-straddle pair).
      await makeEvent({
        day: '2026-05-12T00:01:00.000Z',
        usageCost: 3.0,
        rawIngestEventId: rieNonString,
        subscriptionId: null,
        signalId,
        environment: 'production',
      });
      // E5: multi-service event (2 signal_event_services children) — must
      // still count as exactly 1 event in every dimension on both paths.
      const e5Id = await makeEvent({
        day: '2026-05-10T11:00:00.000Z',
        usageCost: 4.0,
        rawIngestEventId: riePresent,
        subscriptionId,
        signalId,
        environment: 'production',
      });
      const s1 = await prisma.signal_event_services.create({
        data: {
          signalEventId: e5Id,
          model: 'claude-3',
          modelProvider: 'anthropic',
          usageCost: 2.5,
        },
      });
      const s2 = await prisma.signal_event_services.create({
        data: { signalEventId: e5Id, model: 'gpt-4', modelProvider: 'openai', usageCost: 1.5 },
      });
      createdServiceRowIds.push(s1.id, s2.id);
      // E6: null signalId (orphan signal bucket), subscribed.
      await makeEvent({
        day: '2026-05-10T12:00:00.000Z',
        usageCost: 0.5,
        rawIngestEventId: rieAbsent,
        subscriptionId,
        signalId: null,
        environment: 'production',
      });
    });

    afterAll(async () => {
      await prisma.signal_event_services.deleteMany({
        where: { id: { in: createdServiceRowIds } },
      });
      await prisma.signal_events.deleteMany({ where: { id: { in: createdEventIds } } });
      await prisma.raw_ingest_events.deleteMany({
        where: { id: { in: createdRawIngestEventIds } },
      });
      await prisma.subscriptions.deleteMany({ where: { id: subscriptionId } });
      await prisma.pricing_strategies.deleteMany({ where: { id: strategyId } });
      await prisma.pricing_plans.deleteMany({ where: { id: planId } });
      await prisma.customers.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    it.each(DimensionSchema.options)(
      'dimension "%s": same buckets, same cost, same eventCount',
      async (dimension) => {
        const window = { start: WINDOW_START, end: WINDOW_END };
        const filters = { customerId };

        const mapResult = await getCostMetrics(prisma as any, orgId, window, filters);
        const { arrayField, keyField } = DIMENSION_TO_MAP_FIELD[dimension];
        const mapBuckets = toBucketMap((mapResult as any)[arrayField], keyField);

        const sqlResult = await getCostBreakdown(prisma as any, orgId, window, dimension, filters, {
          pageSize: 500,
        });
        expect(sqlResult.other).toBeNull(); // fixture has far fewer than 500 buckets
        const sqlBuckets = new Map<BucketKey, Bucket>(
          sqlResult.rows.map((r) => [r.key, { cost: r.cost, eventCount: r.eventCount }]),
        );

        expect([...sqlBuckets.keys()].sort()).toEqual([...mapBuckets.keys()].sort());
        for (const [key, mapBucket] of mapBuckets) {
          const sqlBucket = sqlBuckets.get(key);
          expect(sqlBucket).toBeDefined();
          expect(Math.abs(sqlBucket!.cost - mapBucket.cost)).toBeLessThanOrEqual(FLOAT_TOLERANCE);
          expect(sqlBucket!.eventCount).toBe(mapBucket.eventCount);
        }

        // Totals must also agree — same WHERE, same window, same filters.
        expect(Math.abs(sqlResult.totals.cost - mapResult.cost)).toBeLessThanOrEqual(
          FLOAT_TOLERANCE,
        );
        expect(sqlResult.totals.eventCount).toBe(mapResult.eventCount);
        expect(sqlResult.totals.eventCountWithNullCost).toBe(mapResult.eventCountWithNullCost);
      },
    );

    it('the multi-service event (E5) counts as exactly 1 event on both paths, not 2', async () => {
      const window = { start: WINDOW_START, end: WINDOW_END };
      const filters = { customerId };
      const mapResult = await getCostMetrics(prisma as any, orgId, window, filters);
      const sqlResult = await getCostBreakdown(prisma as any, orgId, window, 'agent', filters, {
        pageSize: 500,
      });
      // 6 events total in the fixture (E1-E6), never 7 (which a
      // signal_event_services fan-out would produce).
      expect(mapResult.eventCount).toBe(6);
      expect(sqlResult.totals.eventCount).toBe(6);
    });

    it('day bucketing: series (date-ascending) matches the Map byDay content and order', async () => {
      const window = { start: WINDOW_START, end: WINDOW_END };
      const filters = { customerId };
      const mapResult = await getCostMetrics(prisma as any, orgId, window, filters);
      const sqlResult = await getCostBreakdown(prisma as any, orgId, window, 'day', filters, {
        pageSize: 500,
      });

      // Both should have exactly 3 UTC-day buckets: 05-10 (E1,E2,E5,E6),
      // 05-11 (E3), 05-12 (E4).
      expect(mapResult.byDay.length).toBe(3);
      expect(sqlResult.series.length).toBe(3);

      const mapDays = mapResult.byDay.map((d) => d.date.toISOString().slice(0, 10));
      const sqlDays = sqlResult.series.map((d) => d.date.toISOString().slice(0, 10));
      expect(sqlDays).toEqual(mapDays); // both ascending — this is the one field where order truly matches
      expect(mapDays).toEqual(['2026-05-10', '2026-05-11', '2026-05-12']);

      for (let i = 0; i < mapDays.length; i++) {
        expect(Math.abs(sqlResult.series[i].cost - mapResult.byDay[i].cost)).toBeLessThanOrEqual(
          FLOAT_TOLERANCE,
        );
        expect(sqlResult.series[i].eventCount).toBe(mapResult.byDay[i].eventCount);
      }
    });

    it("rows (the breakdown, any dimension) are ORDER BY cost DESC — not the Map's own key order", async () => {
      const window = { start: WINDOW_START, end: WINDOW_END };
      const sqlResult = await getCostBreakdown(
        prisma as any,
        orgId,
        window,
        'agent',
        { customerId },
        {
          pageSize: 500,
        },
      );
      const costs = sqlResult.rows.map((r) => r.cost);
      const sortedDesc = [...costs].sort((a, b) => b - a);
      expect(costs).toEqual(sortedDesc);
    });

    it('model dimension resolves via raw_ingest_events, never signal_event_services (a landmine)', async () => {
      const window = { start: WINDOW_START, end: WINDOW_END };
      const sqlResult = await getCostBreakdown(
        prisma as any,
        orgId,
        window,
        'model',
        { customerId },
        {
          pageSize: 500,
        },
      );
      // If model came from signal_event_services, E5 (1 signal_events row, 2
      // service children: claude-3 + gpt-4) would fan out into 2 buckets
      // contributing 2 eventCounts total instead of 1. gpt-4 (E1 + E5's
      // raw_ingest_events payload, both riePresent) should show eventCount 2,
      // not 3 — proving the join is against raw_ingest_events, not services.
      const gpt4 = sqlResult.rows.find((r) => r.key === 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4!.eventCount).toBe(2); // E1 + E5, both riePresent — NOT E5's service child too
    });
  },
);
