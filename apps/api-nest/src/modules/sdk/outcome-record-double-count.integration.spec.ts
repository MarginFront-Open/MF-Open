/**
 * The double-count assertion, through the REAL ingest lane.
 *
 * The claim this file defends is the one a customer would notice first: a
 * finished thing they record must add NOTHING to their reported AI cost, and
 * must not turn up as unpriced spend. Those are two different
 * ways to be wrong and both are silent, so all four legs run together on the
 * SAME rows, before and after:
 *
 *   1. AFTER.cost      = BEFORE.cost                (exact, no epsilon)
 *   2. AFTER.unpriced  = BEFORE.unpriced            (a real $0, not a null)
 *   3. AFTER.count     = BEFORE.count + N           (liveness: leg 1 also
 *                                                    passes if ingest dropped them)
 *   4. the N new rows sum to the quantities sent, every one PROCESSED, every
 *      usageCost 0 AND NOT NULL
 *
 * Leg 1 alone is not a test. Without leg 3 it passes when ingest rejected
 * every record; without leg 2 it passes when the records landed unpriced and
 * the customer's "not priced yet" number quietly climbed.
 *
 * WHAT IS REAL HERE: the real PrismaService, the real ModelPricingService
 * (so the real service_pricing lookup and the real calculateEventCost branch
 * for costUnit 'item'), and the real SdkService.recordUsage. Stubbed: the four
 * after-storage pokes (credit ledger, cap / pool / customer alert triggers) and
 * RevenueMetricsService, none of which recordUsage's pricing or storage path
 * reads — they are fire-and-forget calls made after the event is already
 * written.
 *
 * Skipped unless FINISHED_WORK_TEST_DATABASE_URL is set. NEVER point that at
 * production: this suite writes events into an org it creates and deletes.
 *
 *   FINISHED_WORK_TEST_DATABASE_URL='<throwaway branch url>' \
 *     npx jest outcome-record-double-count
 */

import { randomUUID } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { getCostBreakdown } from '@marginfront/db';
import { SdkService } from './sdk.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';

const TEST_DB_URL = process.env.FINISHED_WORK_TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console -- explains why the suite skipped
  console.warn(
    '[outcome-record-double-count] FINISHED_WORK_TEST_DATABASE_URL not set — skipping (DB-gated).',
  );
}
const suite = TEST_DB_URL ? describe : describe.skip;

const WINDOW_START = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-30T23:59:59.999Z');
const USAGE_DATE = '2026-09-15T12:00:00.000Z';

/** What the meter sends when someone runs `code-cost-clarity done`. */
function doneRecord(opts: {
  developer: string;
  signalName: string;
  quantity: number;
  label?: string;
}) {
  return {
    customerExternalId: opts.developer,
    agentCode: 'claude-code',
    signalName: opts.signalName,
    model: 'work-item',
    modelProvider: 'outcome',
    quantity: opts.quantity,
    usageDate: USAGE_DATE,
    environment: 'development' as const,
    idempotencyKey: `test-${randomUUID()}`,
    metadata: {
      source: 'outcome',
      doneAt: USAGE_DATE,
      ...(opts.label ? { matterId: opts.label } : {}),
    },
  };
}

interface Snapshot {
  cost: Decimal;
  eventCount: number;
  unpriced: number;
}

suite('a finished thing adds no cost and no unpriced spend (real ingest)', () => {
  let prisma: any;
  let service: SdkService;
  let orgId: string;
  const createdOrgIds: string[] = [];

  /** The assertion's own SQL, verbatim: the same statement you can run
   *  against a deployed database to check it. */
  async function snapshot(): Promise<Snapshot> {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(COALESCE(e."usageCost",0)),0)::numeric AS cost,
              COUNT(*)::int AS event_count,
              (COUNT(*) FILTER (WHERE e."usageCost" IS NULL))::int AS unpriced
       FROM signal_events e
       WHERE e."organizationId" = $1::uuid
         AND e."usageDate" BETWEEN $2::timestamptz AND $3::timestamptz`,
      orgId,
      WINDOW_START.toISOString(),
      WINDOW_END.toISOString(),
    )) as { cost: unknown; event_count: number; unpriced: number }[];
    const row = rows[0];
    return {
      cost: new Decimal(String(row.cost)),
      eventCount: row.event_count,
      unpriced: row.unpriced,
    };
  }

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the env check so a skipped suite never constructs it
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();

    const now = new Date();
    orgId = randomUUID();
    createdOrgIds.push(orgId);
    await prisma.organizations.create({
      data: {
        id: orgId,
        name: `outcome ingest ${orgId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      },
    });

    // The price-list row the data migration ships. Created here with the SAME
    // statement, so this suite proves the migration's row, not a hand-made twin.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "service_pricing" (
         "id","externalId","displayName","provider","serviceType",
         "inputCost","outputCost","costUnit","source","isApi","isActive",
         "canonicalName","createdAt","updatedAt"
       ) VALUES (
         gen_random_uuid(),'outcome/work-item','Finished work item','outcome',
         'Finished work',0,NULL,'item','builtin',true,true,'work-item',now(),now()
       )
       ON CONFLICT ("externalId") DO UPDATE SET
         "isActive" = true, "inputCost" = 0, "updatedAt" = now()`,
    );

    const noop = { maybeTrigger: () => undefined } as any;
    service = new SdkService(
      prisma,
      new ModelPricingService(prisma),
      { getCostMetrics: async () => ({}) } as any,
      noop,
      { consumeForEvent: async () => null } as any,
      noop,
      noop,
    );
  }, 180_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const id of createdOrgIds) {
      await prisma.signal_events.deleteMany({ where: { organizationId: id } });
      await prisma.raw_ingest_events.deleteMany({ where: { organizationId: id } });
      await prisma.signals.deleteMany({ where: { orgId: id } });
      await prisma.subscriptions
        .deleteMany({ where: { organizations: { id } } })
        .catch(() => undefined);
      await prisma.customers.deleteMany({ where: { organizationId: id } });
      await prisma.agents.deleteMany({ where: { orgId: id } });
      await prisma.organizations.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  }, 180_000);

  it('the price-list row resolves a finished thing to a real $0, not to no price', async () => {
    const entry = await new ModelPricingService(prisma).lookupModel('work-item', 'outcome', orgId);
    expect(entry).not.toBeNull();
    expect(entry!.inputCost).toBe(0);
    expect(entry!.costUnit).toBe('item');
  });

  it('all four legs hold across N real done records', async () => {
    const before = await snapshot();

    const quantities = [1, 3, 2];
    const result = await service.recordUsage(orgId, {
      records: [
        doneRecord({
          developer: 'ada@example.test',
          signalName: 'Contract summarized',
          quantity: quantities[0],
          label: 'PROJ-123',
        }),
        doneRecord({
          developer: 'ada@example.test',
          signalName: 'Contract summarized',
          quantity: quantities[1],
          label: 'PROJ-123',
        }),
        doneRecord({
          developer: 'bo@example.test',
          signalName: 'Release cut',
          quantity: quantities[2],
        }),
      ],
    } as any);

    // recordUsage answers { processed, successful, failed, results }. A record
    // that lands NEEDS_COST_BACKFILL is STORED but reported failed, so counting
    // successes is what proves the row priced them — and these same two counts
    // are what the controller sends to api:usage_recorded, which is what the
    // unpriced-spend alert reads. failed: 0 IS the alert staying quiet.
    expect(result.failed).toBe(0);
    expect(result.successful).toBe(quantities.length);

    const after = await snapshot();

    // LEG 1 — exact Decimal equality. No epsilon: a finished thing costs zero,
    // not approximately zero.
    expect(after.cost.equals(before.cost)).toBe(true);

    // LEG 2 — the zero is a real zero. A null here would climb the customer's
    // "not priced yet" number while leg 1 still passed.
    expect(after.unpriced).toBe(before.unpriced);

    // LEG 3 — liveness. Without it, leg 1 also passes when ingest refused
    // every record and nothing landed at all.
    expect(after.eventCount).toBe(before.eventCount + quantities.length);

    // LEG 4 — the rows themselves.
    const rows = await prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: WINDOW_START, lte: WINDOW_END },
        signal_event_services: { some: { modelProvider: 'outcome' } },
      },
      select: { id: true, quantity: true, usageCost: true, eventProcessed: true },
    });
    expect(rows).toHaveLength(quantities.length);
    const summed = rows.reduce((total: number, row: any) => total + Number(row.quantity), 0);
    expect(summed).toBe(quantities.reduce((a, b) => a + b, 0));
    for (const row of rows) {
      expect(row.eventProcessed).toBe('PROCESSED');
      expect(row.usageCost).not.toBeNull();
      expect(new Decimal(String(row.usageCost)).equals(0)).toBe(true);
    }
  }, 180_000);

  it('the marker the ROI read looks for is on the child row, and carries no tokens', async () => {
    const children = await prisma.signal_event_services.findMany({
      where: { signal_events: { organizationId: orgId }, modelProvider: 'outcome' },
      select: {
        model: true,
        modelProvider: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    });
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.model).toBe('work-item');
      expect(child.modelProvider).toBe('outcome');
      expect(child.inputTokens).toBeNull();
      expect(child.outputTokens).toBeNull();
      expect(child.cacheReadTokens).toBeNull();
      expect(child.cacheWriteTokens).toBeNull();
    }
  });

  // --- The two reds, pinned so they can never go quietly green -------------

  it('RED 1: with the price-list row gone, legs 2 and 4 break', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE "service_pricing" SET "isActive" = false WHERE "externalId" = 'outcome/work-item'`,
    );
    try {
      const before = await snapshot();
      const result = await service.recordUsage(orgId, {
        records: [
          doneRecord({ developer: 'ada@example.test', signalName: 'Red one', quantity: 1 }),
        ],
      } as any);
      const after = await snapshot();

      // The record is STORED either way — which is exactly why leg 3 alone
      // proves nothing.
      expect(result.failed).toBe(1);
      expect(result.results.failed[0].stored).toBe(true);
      expect(after.eventCount).toBe(before.eventCount + 1);
      // Leg 2 breaks: the record landed as unpriced spend.
      expect(after.unpriced).toBe(before.unpriced + 1);
      // Leg 4 breaks: null cost, and a status that is not PROCESSED.
      const row = await prisma.signal_events.findFirst({
        where: { organizationId: orgId, signals: { name: 'Red one' } },
        select: { usageCost: true, eventProcessed: true },
      });
      expect(row.usageCost).toBeNull();
      expect(row.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE "service_pricing" SET "isActive" = true WHERE "externalId" = 'outcome/work-item'`,
      );
    }
  }, 180_000);

  it('RED 2: with token fields on the record, leg 1 breaks', async () => {
    const before = await snapshot();
    await service.recordUsage(orgId, {
      records: [
        {
          ...doneRecord({ developer: 'ada@example.test', signalName: 'Red two', quantity: 1 }),
          model: 'claude-sonnet-4',
          modelProvider: 'anthropic',
          inputTokens: 100_000,
          outputTokens: 10_000,
        },
      ],
    } as any);
    const after = await snapshot();
    expect(after.cost.equals(before.cost)).toBe(false);
    expect(after.cost.greaterThan(before.cost)).toBe(true);
  }, 180_000);

  it('the three tiles above the table do not move', async () => {
    // What the ROI action puts on screen, read the same way it reads it.
    const tiles = async () => {
      const breakdown = await getCostBreakdown(
        prisma,
        orgId,
        { start: WINDOW_START, end: WINDOW_END },
        'agent',
        {},
        {
          page: 1,
          pageSize: 500,
          includeOtherRollup: false,
          finishedWork: { agentIds: null },
        },
      );
      const finished = breakdown.totals.eventCountFinishedWork ?? 0;
      const usageEvents = breakdown.totals.eventCount - finished;
      return {
        cost: breakdown.totals.cost,
        usageEvents,
        costPerUsageEvent: usageEvents === 0 ? null : breakdown.totals.cost / usageEvents,
        finished,
        rows: breakdown.rows.map((row) => ({
          key: row.key,
          usageEvents: row.eventCount - (row.eventCountFinishedWork ?? 0),
        })),
      };
    };

    const before = await tiles();
    const n = 4;
    await service.recordUsage(orgId, {
      records: Array.from({ length: n }, (_unused, index) =>
        doneRecord({
          developer: 'ada@example.test',
          signalName: `Twin thing ${index}`,
          quantity: 1,
          label: 'PROJ-123',
        }),
      ),
    } as any);
    const after = await tiles();

    expect(after.cost).toBe(before.cost);
    expect(after.usageEvents).toBe(before.usageEvents);
    expect(after.costPerUsageEvent).toBe(before.costPerUsageEvent);
    expect(after.finished).toBe(before.finished + n);
    // The agents column moves with the tile, or the table stops adding up.
    expect(after.rows).toEqual(before.rows);
  }, 180_000);

  /**
   * CONTRACT the code-cost-clarity meter owes: `code-cost-clarity done` MUST always
   * send a quantity, defaulting to 1. The API does not fill one in, so
   * nothing here papers over a malformed client, and the shape below is what a
   * customer would get: a thing they finished, still counted and still
   * subtracted from Usage events, reading as unpriced spend.
   */
  it('a done record with no quantity lands unpriced and still counts, so the meter always sends one', async () => {
    const before = await snapshot();
    const { quantity: _dropped, ...noQuantity } = doneRecord({
      developer: 'ada@example.test',
      signalName: 'No quantity',
      quantity: 1,
    });
    await service.recordUsage(orgId, { records: [noQuantity] } as any);
    const after = await snapshot();
    expect(after.unpriced).toBe(before.unpriced + 1);
    const row = await prisma.signal_events.findFirst({
      where: { organizationId: orgId, signals: { name: 'No quantity' } },
      select: { id: true, eventProcessed: true },
    });
    expect(row.eventProcessed).toBe('MISSING_VOLUME_DATA');
    const child = await prisma.signal_event_services.findFirst({
      where: { signalEventId: row.id },
      select: { modelProvider: true, usageCost: true },
    });
    expect(child.modelProvider).toBe('outcome');
    expect(child.usageCost).toBeNull();
  }, 180_000);
});
