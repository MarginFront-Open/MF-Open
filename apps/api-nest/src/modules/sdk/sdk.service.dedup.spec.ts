/**
 * WHAT THIS FILE DOES: proves the exactly-once dedup half of
 * SdkService.recordUsage — the server-side "no doubles" behavior. A repeat ingest
 * carrying the same idempotencyKey (per org) must collapse to the original event
 * instead of creating a duplicate; distinct keys and other orgs must NOT be
 * deduped; the true-concurrent race (both requests pass the pre-check, the unique
 * index rejects the loser with P2002) must resolve to a no-op, not an error; and
 * the common SDK path (no key at all) must store every event.
 *
 * WHY IT EXISTS: without dedup, a collector restart or a double-POST creates a
 * duplicate signal_events row and inflates the spend number. These tests cover
 * replay no-op, mutation sensitivity, no false dedup, cross-tenant scoping, the
 * concurrent-race backstop, and the no-key happy path.
 *
 * CONNECTS TO: sdk.service.ts recordUsage (STEP 0 pre-check + P2002 catch),
 * signal-event.utils.ts (carries idempotencyKey onto the parent), and the
 * (organizationId, idempotencyKey) @@unique in schema.prisma.
 *
 * Mocked Prisma + mocked ModelPricingService, same harness shape as
 * sdk.service.multi-service.spec.ts. The real DB-level dedup behavior (the actual
 * @@unique + before/after row counts) needs a real database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { resolveEventPrice } from '@marginfront/db';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG_A = 'org-a-uuid';
const ORG_B = 'org-b-uuid';
const CUSTOMER_ID = 'cust-uuid';
const AGENT_ID = 'agent-uuid';
const SIGNAL_ID = 'signal-uuid';
const KEY = 'turn-key-abc123';

// A stored prior signal_event the pre-check / race re-query can find.
interface PriorEvent {
  organizationId: string;
  idempotencyKey: string;
  id: string;
  usageCost: Decimal | null;
  rawIngestEventId: string;
}

interface MockCalls {
  rawIngestCreate: jest.Mock;
  signalEventsFindFirst: jest.Mock;
  signalEventsCreate: jest.Mock;
  signalEventServicesCreate: jest.Mock;
}

/**
 * Build a mocked PrismaService + ModelPricingService for one dedup test.
 *  - `priorEvents`: events that already exist (the pre-check / race re-query
 *    consult these, scoped by organizationId + idempotencyKey).
 *  - `throwP2002OnCreate`: simulate the concurrent race — signal_events.create
 *    registers a "winner" and then rejects with Prisma P2002, exactly as the
 *    unique index would for the losing request.
 */
function buildMocks(opts: { priorEvents?: PriorEvent[]; throwP2002OnCreate?: boolean }): {
  prisma: any;
  modelPricing: any;
  calls: MockCalls;
  priors: PriorEvent[];
} {
  const priors: PriorEvent[] = opts.priorEvents ? [...opts.priorEvents] : [];
  const calls: MockCalls = {
    rawIngestCreate: jest.fn(),
    signalEventsFindFirst: jest.fn(),
    signalEventsCreate: jest.fn(),
    signalEventServicesCreate: jest.fn(),
  };

  const prisma: any = {
    raw_ingest_events: {
      create: (args: any) => {
        calls.rawIngestCreate(args);
        return Promise.resolve({ id: 'raw-' + Math.random().toString(36).slice(2, 8) });
      },
      update: () => Promise.resolve({}),
    },
    customers: {
      findFirst: () =>
        Promise.resolve({ id: CUSTOMER_ID, externalId: 'cust-ext-1', organizationId: ORG_A }),
      create: () => Promise.resolve({ id: CUSTOMER_ID }),
    },
    agents: {
      findFirst: () => Promise.resolve({ id: AGENT_ID, agentCode: 'agent-code-1', orgId: ORG_A }),
      create: () => Promise.resolve({ id: AGENT_ID }),
    },
    signals: {
      upsert: () => Promise.resolve({ id: SIGNAL_ID, name: 'sig-1', orgId: ORG_A }),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
    },
    signal_events: {
      // The STEP 0 pre-check AND the catch-block P2002 re-query both call this.
      // Scoped by org + key, exactly like the real findFirst.
      findFirst: ({ where }: any) => {
        calls.signalEventsFindFirst(where);
        const hit = priors.find(
          (e) =>
            e.organizationId === where.organizationId && e.idempotencyKey === where.idempotencyKey,
        );
        return Promise.resolve(hit ?? null);
      },
      create: (args: any) => {
        calls.signalEventsCreate(args);
        if (opts.throwP2002OnCreate) {
          // The winner committed first; register it so the loser's catch-block
          // re-query finds it, then reject the loser with the real P2002 error
          // the (organizationId, idempotencyKey) unique index would raise.
          priors.push({
            organizationId: args.data.organizationId,
            idempotencyKey: args.data.idempotencyKey,
            id: 'winner-evt-id',
            usageCost: new Decimal(2),
            rawIngestEventId: 'winner-raw-id',
          });
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['organizationId', 'idempotencyKey'] },
            }),
          );
        }
        return Promise.resolve(args.data);
      },
    },
    signal_event_services: {
      create: (args: any) => {
        calls.signalEventServicesCreate(args);
        return Promise.resolve(args.data);
      },
    },
    signal_services: {
      upsert: () => Promise.resolve({}),
    },
    // RecordUsage loads matter attribution context per batch.
    matters: { findMany: () => Promise.resolve([]) },
    matter_routing_rules: { findMany: () => Promise.resolve([]) },
    $transaction: (cb: any) => cb(prisma),
  };

  const modelPricing: any = {
    lookupModel: () =>
      Promise.resolve({
        servicePricingId: 'pricing-claude-uuid',
        costUnit: '1M tokens',
        cacheReadCost: undefined,
        cacheWriteCost: undefined,
      }),
    calculateCost: (_model: string, inputTokens: number, outputTokens: number) => {
      const inputCost = new Decimal(inputTokens).mul('0.001');
      const outputCost = new Decimal(outputTokens).mul('0.002');
      return Promise.resolve({
        totalCostUsd: inputCost.add(outputCost),
        inputCostUsd: inputCost,
        outputCostUsd: outputCost,
        inputCostPerToken: 0.001,
        outputCostPerToken: 0.002,
        cacheReadCostUsd: new Decimal(0),
        cacheWriteCostUsd: new Decimal(0),
        cacheReadCostPerToken: 0,
        cacheWriteCostPerToken: 0,
      });
    },
  };

  // sdk.service prices through resolveCost. The refuse/allow verdict
  // comes from the REAL canonical guard — stubbing it would make every
  // missing-cache-rate assertion in these specs test the stub instead of the
  // rule. Only the arithmetic stays mocked, via this mock's own calculateCost,
  // so each spec keeps its cost behaviour and its call recording.
  (modelPricing as any).resolveCost = async (
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    quantity: number,
    provider: string,
    preFetchedEntry?: any,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    cacheWriteTtl?: unknown,
  ) => {
    const entry = preFetchedEntry ?? (await (modelPricing as any).lookupModel(modelId, provider));
    const verdict = resolveEventPrice({
      inputTokens,
      outputTokens,
      quantity,
      // These mocks' lookupModel returns only a subset of fields, so
      // inputCost/outputCost are often absent. The refusal verdict depends only
      // on the CACHE rates and the token counts, so defaulting the token rates
      // to 0 keeps the verdict exact while giving the real math valid operands.
      entry: { inputCost: 0, outputCost: 0, ...entry },
      cacheReadTokens,
      cacheWriteTokens,
      provider,
      cacheWriteTtl,
      model: modelId,
    });
    if (!verdict.ok) return { ...verdict, modelKey: modelId };
    const cost = await (modelPricing as any).calculateCost(
      modelId,
      inputTokens,
      outputTokens,
      quantity,
      provider,
      entry,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteTtl,
    );
    return { ok: true, cost };
  };

  return { prisma, modelPricing, calls, priors };
}

// Shared across tests so the ingest->trigger wiring is assertable; reset per use.
const capAlertTriggerMock = { maybeTrigger: jest.fn() };

async function buildService(prisma: any, modelPricing: any): Promise<SdkService> {
  capAlertTriggerMock.maybeTrigger.mockClear();
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      RevenueMetricsService,
      { provide: ModelPricingService, useValue: modelPricing },
      { provide: PrismaService, useValue: prisma },
      { provide: CapAlertTriggerService, useValue: capAlertTriggerMock },
      { provide: CreditLedgerService, useValue: { consumeForEvent: jest.fn() } },
      { provide: PoolAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CustomerAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

const baseRecord = {
  customerExternalId: 'cust-ext-1',
  agentCode: 'agent-code-1',
  signalName: 'sig-1',
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

// ─── replay = no-op ───────────────────────────────────────────

describe('recordUsage dedup — replay of a known key is a no-op', () => {
  it('creates NO raw_ingest_events and NO signal_events row, returns the ORIGINAL event', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      priorEvents: [
        {
          organizationId: ORG_A,
          idempotencyKey: KEY,
          id: 'original-evt-id',
          usageCost: new Decimal('1.2345'),
          rawIngestEventId: 'original-raw-id',
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    // The pre-check ran and short-circuited BEFORE any write.
    expect(calls.signalEventsFindFirst).toHaveBeenCalledTimes(1);
    expect(calls.rawIngestCreate).not.toHaveBeenCalled();
    expect(calls.signalEventsCreate).not.toHaveBeenCalled();

    // The response carries the ORIGINAL event id + cost (idempotent), formatted
    // with the same .toFixed(10) the live success path uses.
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    const success = result.results.success[0];
    expect(success.eventId).toBe('original-evt-id');
    expect(success.rawEventId).toBe('original-raw-id');
    expect(success.totalCostUsd).toBe('1.2345000000');
  });
});

// ─── mutation sensitivity ─────────────────────────────────────
// The pair proves the dedup mechanism is load-bearing: same record, the ONLY
// difference is whether a prior exists for the key. Prior present -> no write
// (the no-op above). Prior absent (dedup "off") -> the duplicate row DOES appear.

describe('recordUsage dedup — mutation sensitivity', () => {
  it('with NO prior for the key, the event IS created (the dedup-off / red case)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({ priorEvents: [] });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    // Pre-check ran, found nothing -> the full create path executed.
    expect(calls.signalEventsFindFirst).toHaveBeenCalledTimes(1);
    expect(calls.rawIngestCreate).toHaveBeenCalledTimes(1);
    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);
    // And the created parent carries the key so the NEXT replay collides.
    expect(calls.signalEventsCreate.mock.calls[0][0].data.idempotencyKey).toBe(KEY);
  });
});

// ─── no false dedup ───────────────────────────────────────────

describe('recordUsage dedup — distinct keys are never collapsed', () => {
  it('a DIFFERENT key does not match an existing prior — the second turn lands', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      priorEvents: [
        {
          organizationId: ORG_A,
          idempotencyKey: 'key-for-turn-1',
          id: 'evt-1',
          usageCost: new Decimal(2),
          rawIngestEventId: 'raw-1',
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    // A genuinely different turn (different key) must NOT dedup against turn 1.
    await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: 'key-for-turn-2' }],
    } as any);

    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);
    expect(calls.signalEventsCreate.mock.calls[0][0].data.idempotencyKey).toBe('key-for-turn-2');
  });
});

// ─── cross-tenant safety ──────────────────────────────────────

describe('recordUsage dedup — dedup is per-org, never global', () => {
  it('the same key value under a DIFFERENT org does not dedup against org A', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      // The key is already used by ORG_A.
      priorEvents: [
        {
          organizationId: ORG_A,
          idempotencyKey: KEY,
          id: 'org-a-evt',
          usageCost: new Decimal(2),
          rawIngestEventId: 'org-a-raw',
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    // ORG_B sends the SAME key value — must land (different tuple), not dedup.
    await svc.recordUsage(ORG_B, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    // The pre-check was scoped to ORG_B and found nothing -> a new row is created.
    const whereArg = calls.signalEventsFindFirst.mock.calls[0][0];
    expect(whereArg.organizationId).toBe(ORG_B);
    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);
    expect(calls.signalEventsCreate.mock.calls[0][0].data.organizationId).toBe(ORG_B);
  });
});

// ─── Concurrent-race backstop: P2002 -> no-op, not an error ─────────────────

describe('recordUsage dedup — concurrent double-POST race (P2002)', () => {
  it('a unique-violation on create resolves to the winner event as success, not INTERNAL_ERROR', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      priorEvents: [], // pre-check sees nothing (both requests raced past it)
      throwP2002OnCreate: true, // the create then loses the unique race
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    // create was attempted (the race) and threw P2002; the catch re-queried and
    // found the winner -> success, NOT a failed/INTERNAL_ERROR result.
    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results.success[0].eventId).toBe('winner-evt-id');
    expect(result.results.success[0].rawEventId).toBe('winner-raw-id');
  });

  it('a P2002 with NO recoverable winner still surfaces as a real error (not swallowed)', async () => {
    // throwP2002OnCreate registers a winner, so to test the "no winner" fall-through
    // we build mocks that throw P2002 but leave priors empty by overriding create.
    const { prisma, modelPricing } = buildMocks({ priorEvents: [] });
    prisma.signal_events.create = () =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    // No winner found on re-query -> falls through to generic error handling.
    expect(result.failed).toBe(1);
    expect(result.results.failed[0].code).toBe('INTERNAL_ERROR');
  });
});

// ─── the no-key happy path ────────────────────────────────────

describe('recordUsage dedup — no-key path records normally', () => {
  it('a record with NO idempotencyKey skips the pre-check entirely and records normally', async () => {
    const { prisma, modelPricing, calls } = buildMocks({ priorEvents: [] });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord }], // no idempotencyKey
    } as any);

    // The pre-check is presence-gated: with no key it must NEVER run.
    expect(calls.signalEventsFindFirst).not.toHaveBeenCalled();
    expect(calls.rawIngestCreate).toHaveBeenCalledTimes(1);
    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);
    // The created parent stores a null key (NULLs never dedup).
    expect(calls.signalEventsCreate.mock.calls[0][0].data.idempotencyKey).toBeNull();
    expect(result.successful).toBe(1);
  });
});

// ─── a successful ingest pokes the cap-alert trigger ────

describe('recordUsage -> cap-alert trigger wiring (evaluate at the point of spend)', () => {
  it('calls maybeTrigger with the org and the record agentCode on a successful event', async () => {
    const { prisma, modelPricing } = buildMocks({});
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(capAlertTriggerMock.maybeTrigger).toHaveBeenCalledWith(ORG_A, baseRecord.agentCode);
  });

  it('does not trigger on a dedup replay (no new spend landed)', async () => {
    const { prisma, modelPricing } = buildMocks({
      priorEvents: [
        {
          organizationId: ORG_A,
          idempotencyKey: KEY,
          id: 'original-evt-id',
          usageCost: new Decimal('1.2345'),
          rawIngestEventId: 'original-raw-id',
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    expect(result.successful).toBe(1);
    expect(capAlertTriggerMock.maybeTrigger).not.toHaveBeenCalled();
  });
});
