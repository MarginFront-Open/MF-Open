/**
 * The ingest response reports created {customer, agent, signal}
 * flags so callers can SEE auto-provisioning happen.
 *
 * customer/agent flags are deterministic booleans at the findFirst->create
 * branch. Signal rides a createdAt-equality heuristic (upsert can't report
 * create-vs-found): millisecond-equal createdAt with the `now` this request
 * passed into upsert's create block means this call minted the row.
 *
 * INTENTIONAL GAP, pinned here: idempotent-replay responses (STEP 0 pre-check
 * and the P2002 race winner, both via buildDeduplicatedSuccess) carry NO
 * created field at all. Callers see `created` on first ingest and `undefined`
 * on replay — undefined means "no provisioning info", NOT "nothing created".
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

const ORG = 'org-uuid';
const KEY = 'turn-key-abc123';
const OLD_DATE = new Date('2026-01-01T00:00:00.000Z');

function buildMocks(opts: {
  customerExists?: boolean;
  agentExists?: boolean;
  signalExists?: boolean;
  knownModel?: boolean;
  priorEventForKey?: boolean;
  throwP2002OnEventCreate?: boolean;
  signalCreatedAtShape?: 'date' | 'string';
}) {
  const {
    customerExists = true,
    agentExists = true,
    signalExists = true,
    knownModel = true,
    priorEventForKey = false,
    throwP2002OnEventCreate = false,
    signalCreatedAtShape = 'date',
  } = opts;

  const priors: any[] = priorEventForKey
    ? [
        {
          id: 'original-evt-id',
          usageCost: new Decimal('1.5'),
          rawIngestEventId: 'original-raw-id',
        },
      ]
    : [];

  const prisma: any = {
    raw_ingest_events: {
      create: () => Promise.resolve({ id: 'raw-1' }),
      update: () => Promise.resolve({}),
    },
    customers: {
      findFirst: ({ where }: any) => {
        if (where.deletedAt === null) {
          return Promise.resolve(customerExists ? { id: 'cust-uuid' } : null);
        }
        return Promise.resolve(null);
      },
      updateMany: () => Promise.resolve({ count: 0 }),
      create: (args: any) => Promise.resolve({ id: 'cust-created', ...args.data }),
    },
    agents: {
      findFirst: ({ where }: any) => {
        if (where.deletedAt === null) {
          return Promise.resolve(agentExists ? { id: 'agent-uuid' } : null);
        }
        return Promise.resolve(null);
      },
      updateMany: () => Promise.resolve({ count: 0 }),
      create: (args: any) => Promise.resolve({ id: 'agent-created', ...args.data }),
    },
    signals: {
      // Found: a pre-existing row with an OLD createdAt (heuristic -> false).
      // Created: echo back the create block, whose createdAt IS this
      // request's `now` (heuristic -> true). The 'string' shape exercises
      // the instanceof guard.
      upsert: (args: any) => {
        if (signalExists) {
          const createdAt = signalCreatedAtShape === 'date' ? OLD_DATE : OLD_DATE.toISOString();
          return Promise.resolve({
            id: 'signal-uuid',
            name: args.where.agentId_name.name,
            costCategory: 'UNCLASSIFIED',
            createdAt,
            deletedAt: null,
          });
        }
        return Promise.resolve({
          id: args.create.id,
          name: args.create.name,
          costCategory: 'UNCLASSIFIED',
          createdAt:
            signalCreatedAtShape === 'date'
              ? args.create.createdAt
              : args.create.createdAt.toISOString(),
          deletedAt: null,
        });
      },
      update: () => Promise.resolve({}),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
    },
    signal_events: {
      findFirst: () => Promise.resolve(priors[0] ?? null),
      create: (args: any) => {
        if (throwP2002OnEventCreate) {
          priors.push({
            id: 'winner-evt-id',
            usageCost: new Decimal('2'),
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
      create: (args: any) => Promise.resolve(args.data),
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
      Promise.resolve(
        knownModel
          ? {
              servicePricingId: 'pricing-claude-uuid',
              costUnit: '1M tokens',
              cacheReadCost: undefined,
              cacheWriteCost: undefined,
            }
          : null,
      ),
    calculateCost: () =>
      Promise.resolve({
        totalCostUsd: new Decimal('2'),
        inputCostUsd: new Decimal('1'),
        outputCostUsd: new Decimal('1'),
        inputCostPerToken: 0.001,
        outputCostPerToken: 0.002,
        cacheReadCostUsd: new Decimal(0),
        cacheWriteCostUsd: new Decimal(0),
        cacheReadCostPerToken: 0,
        cacheWriteCostPerToken: 0,
      }),
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

  return { prisma, modelPricing };
}

async function buildService(prisma: any, modelPricing: any): Promise<SdkService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      RevenueMetricsService,
      { provide: ModelPricingService, useValue: modelPricing },
      { provide: PrismaService, useValue: prisma },
      { provide: CapAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
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

describe('created flags — success path', () => {
  it('first-ever event: all three entities report created: true', async () => {
    const { prisma, modelPricing } = buildMocks({
      customerExists: false,
      agentExists: false,
      signalExists: false,
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(result.results.success[0].created).toEqual({
      customer: true,
      agent: true,
      signal: true,
    });
  });

  it('all entities pre-existing: all three report created: false', async () => {
    const { prisma, modelPricing } = buildMocks({});
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(result.results.success[0].created).toEqual({
      customer: false,
      agent: false,
      signal: false,
    });
  });

  it('mixed: new customer + existing agent/signal reports only customer: true', async () => {
    const { prisma, modelPricing } = buildMocks({ customerExists: false });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.results.success[0].created).toEqual({
      customer: true,
      agent: false,
      signal: false,
    });
  });
});

describe('created flags — stored-failure path', () => {
  it('an unknown-model event (stored: true failure) still reports what it provisioned', async () => {
    const { prisma, modelPricing } = buildMocks({
      customerExists: false,
      agentExists: false,
      signalExists: false,
      knownModel: false,
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.failed).toBe(1);
    const failedRow = result.results.failed[0];
    expect(failedRow.code).toBe('NEEDS_COST_BACKFILL');
    expect(failedRow.stored).toBe(true);
    expect(failedRow.created).toEqual({ customer: true, agent: true, signal: true });
  });
});

describe('created flags — idempotent replay carries NO created key (undefined, not false)', () => {
  it('pre-check replay: the response row has no created property at all', async () => {
    const { prisma, modelPricing } = buildMocks({ priorEventForKey: true });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    expect(result.successful).toBe(1);
    const row = result.results.success[0];
    expect(row.eventId).toBe('original-evt-id');
    // undefined !== false: the replay says NOTHING about provisioning.
    expect('created' in row).toBe(false);
  });

  it('P2002 race-winner replay: the response row has no created property at all', async () => {
    const { prisma, modelPricing } = buildMocks({ throwP2002OnEventCreate: true });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, idempotencyKey: KEY }],
    } as any);

    expect(result.successful).toBe(1);
    const row = result.results.success[0];
    expect(row.eventId).toBe('winner-evt-id');
    expect('created' in row).toBe(false);
  });
});

describe('created.signal heuristic', () => {
  it('a found signal (old createdAt) reports signal: false even when the Date type matches', async () => {
    const { prisma, modelPricing } = buildMocks({ signalExists: true });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.results.success[0].created.signal).toBe(false);
  });

  it('instanceof guard: a non-Date createdAt yields signal: false without breaking ingest', async () => {
    const { prisma, modelPricing } = buildMocks({
      signalExists: false,
      signalCreatedAtShape: 'string',
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    // A created signal would deserve true, but a malformed createdAt must
    // degrade to false rather than throw mid-ingest.
    expect(result.successful).toBe(1);
    expect(result.results.success[0].created.signal).toBe(false);
  });
});
