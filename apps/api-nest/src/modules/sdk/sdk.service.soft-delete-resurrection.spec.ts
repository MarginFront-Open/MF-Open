/**
 * Re-ingesting a soft-deleted customer/agent must resurrect the row,
 * never P2002 into the retryable INTERNAL_ERROR handler.
 *
 * The failure this guards: the deletedAt:null provisioning lookups can't see a
 * soft-deleted row, so a plain create() collides with it on the DB unique key
 * (neither customers @@unique(externalId, organizationId) nor agents
 * @@unique(agentCode, orgId) includes deletedAt), the P2002 escapes the
 * idempotency winner-check, and the SDK buffer retries a permanent condition
 * 5 times before silently dropping the event.
 *
 * The mock prisma here is STATEFUL and mimics the real index: create() throws
 * P2002 whenever a row (live or soft-deleted) already holds the unique key,
 * exactly like Postgres. The negative-control test proves the harness
 * reproduces that failure when resurrection is disabled, so the green tests
 * are load-bearing, not vacuous.
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
const OLD_DATE = new Date('2026-01-01T00:00:00.000Z');

interface CustomerRow {
  id: string;
  externalId: string;
  organizationId: string;
  deletedAt: Date | null;
}

interface AgentRow {
  id: string;
  agentCode: string;
  orgId: string;
  deletedAt: Date | null;
}

interface SignalRow {
  id: string;
  agentId: string;
  orgId: string;
  name: string;
  costCategory: string;
  createdAt: Date;
  deletedAt: Date | null;
}

function matchesDeletedAt(filter: unknown, value: Date | null): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === null;
  if (typeof filter === 'object' && filter !== null && 'not' in (filter as any)) {
    if ((filter as any).not === null) return value !== null;
  }
  return false;
}

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function buildStatefulMocks(seed: {
  customers?: CustomerRow[];
  agents?: AgentRow[];
  signals?: SignalRow[];
}) {
  const customers: CustomerRow[] = seed.customers ? [...seed.customers] : [];
  const agents: AgentRow[] = seed.agents ? [...seed.agents] : [];
  const signals: SignalRow[] = seed.signals ? [...seed.signals] : [];

  const calls = {
    customersCreate: jest.fn(),
    agentsCreate: jest.fn(),
    signalsUpdate: jest.fn(),
    subscriptionsUpdateMany: jest.fn(),
  };

  const prisma: any = {
    raw_ingest_events: {
      create: () => Promise.resolve({ id: 'raw-1' }),
      update: () => Promise.resolve({}),
    },
    customers: {
      findFirst: ({ where }: any) =>
        Promise.resolve(
          customers.find(
            (c) =>
              c.externalId === where.externalId &&
              c.organizationId === where.organizationId &&
              matchesDeletedAt(where.deletedAt, c.deletedAt),
          ) ?? null,
        ),
      updateMany: ({ where, data }: any) => {
        const hits = customers.filter(
          (c) =>
            c.externalId === where.externalId &&
            c.organizationId === where.organizationId &&
            matchesDeletedAt(where.deletedAt, c.deletedAt),
        );
        for (const hit of hits) hit.deletedAt = data.deletedAt;
        return Promise.resolve({ count: hits.length });
      },
      create: (args: any) => {
        calls.customersCreate(args);
        if (
          customers.some(
            (c) =>
              c.externalId === args.data.externalId &&
              c.organizationId === args.data.organizationId,
          )
        ) {
          return Promise.reject(p2002(['externalId', 'organizationId']));
        }
        const row: CustomerRow = {
          id: args.data.id,
          externalId: args.data.externalId,
          organizationId: args.data.organizationId,
          deletedAt: null,
        };
        customers.push(row);
        return Promise.resolve(row);
      },
    },
    agents: {
      findFirst: ({ where }: any) =>
        Promise.resolve(
          agents.find(
            (a) =>
              a.agentCode === where.agentCode &&
              a.orgId === where.orgId &&
              matchesDeletedAt(where.deletedAt, a.deletedAt),
          ) ?? null,
        ),
      updateMany: ({ where, data }: any) => {
        const hits = agents.filter(
          (a) =>
            a.agentCode === where.agentCode &&
            a.orgId === where.orgId &&
            matchesDeletedAt(where.deletedAt, a.deletedAt),
        );
        for (const hit of hits) hit.deletedAt = data.deletedAt;
        return Promise.resolve({ count: hits.length });
      },
      create: (args: any) => {
        calls.agentsCreate(args);
        if (
          agents.some((a) => a.agentCode === args.data.agentCode && a.orgId === args.data.orgId)
        ) {
          return Promise.reject(p2002(['agentCode', 'orgId']));
        }
        const row: AgentRow = {
          id: args.data.id,
          agentCode: args.data.agentCode,
          orgId: args.data.orgId,
          deletedAt: null,
        };
        agents.push(row);
        return Promise.resolve(row);
      },
    },
    signals: {
      // Real upsert targets the (agentId, name) unique key with NO deletedAt
      // filter — a soft-deleted row is found, not collided with.
      upsert: (args: any) => {
        const found = signals.find(
          (s) =>
            s.agentId === args.where.agentId_name.agentId &&
            s.name === args.where.agentId_name.name,
        );
        if (found) return Promise.resolve(found);
        const row: SignalRow = {
          id: args.create.id,
          agentId: args.create.agentId,
          orgId: args.create.orgId,
          name: args.create.name,
          costCategory: 'UNCLASSIFIED',
          createdAt: args.create.createdAt,
          deletedAt: null,
        };
        signals.push(row);
        return Promise.resolve(row);
      },
      update: (args: any) => {
        calls.signalsUpdate(args);
        const row = signals.find((s) => s.id === args.where.id);
        if (row && 'deletedAt' in args.data) row.deletedAt = args.data.deletedAt;
        return Promise.resolve(row);
      },
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
      updateMany: (args: any) => {
        calls.subscriptionsUpdateMany(args);
        return Promise.resolve({ count: 0 });
      },
    },
    signal_events: {
      findFirst: () => Promise.resolve(null),
      create: (args: any) => Promise.resolve(args.data),
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
      Promise.resolve({
        servicePricingId: 'pricing-claude-uuid',
        costUnit: '1M tokens',
        cacheReadCost: undefined,
        cacheWriteCost: undefined,
      }),
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

  return { prisma, modelPricing, calls, stores: { customers, agents, signals } };
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

const liveCustomer: CustomerRow = {
  id: 'cust-uuid',
  externalId: 'cust-ext-1',
  organizationId: ORG,
  deletedAt: null,
};
const liveAgent: AgentRow = {
  id: 'agent-uuid',
  agentCode: 'agent-code-1',
  orgId: ORG,
  deletedAt: null,
};
const liveSignal: SignalRow = {
  id: 'signal-uuid',
  agentId: 'agent-uuid',
  orgId: ORG,
  name: 'sig-1',
  costCategory: 'UNCLASSIFIED',
  createdAt: OLD_DATE,
  deletedAt: null,
};

describe('re-ingest of a soft-deleted customer resurrects it', () => {
  it('succeeds, revives the row, reports created.customer: false, leaves subscriptions deleted', async () => {
    const { prisma, modelPricing, calls, stores } = buildStatefulMocks({
      customers: [{ ...liveCustomer, deletedAt: OLD_DATE }],
      agents: [liveAgent],
      signals: [liveSignal],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    // The row was revived, not re-created — same id, billing history intact.
    expect(calls.customersCreate).not.toHaveBeenCalled();
    expect(stores.customers).toHaveLength(1);
    expect(stores.customers[0].id).toBe('cust-uuid');
    expect(stores.customers[0].deletedAt).toBeNull();
    // Resurrection is NOT creation.
    expect(result.results.success[0].created).toEqual({
      customer: false,
      agent: false,
      signal: false,
    });
    // Subscriptions soft-deleted alongside the customer stay deleted.
    expect(calls.subscriptionsUpdateMany).not.toHaveBeenCalled();
  });
});

describe('re-ingest of a soft-deleted agent resurrects it', () => {
  it('succeeds, revives the row, reports created.agent: false', async () => {
    const { prisma, modelPricing, calls, stores } = buildStatefulMocks({
      customers: [liveCustomer],
      agents: [{ ...liveAgent, deletedAt: OLD_DATE }],
      signals: [liveSignal],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls.agentsCreate).not.toHaveBeenCalled();
    expect(stores.agents).toHaveLength(1);
    expect(stores.agents[0].id).toBe('agent-uuid');
    expect(stores.agents[0].deletedAt).toBeNull();
    expect(result.results.success[0].created).toEqual({
      customer: false,
      agent: false,
      signal: false,
    });
  });
});

describe('soft-deleted signal is revived by the upsert path', () => {
  it('clears deletedAt on the found signal and reports created.signal: false', async () => {
    const { prisma, modelPricing, calls, stores } = buildStatefulMocks({
      customers: [liveCustomer],
      agents: [liveAgent],
      signals: [{ ...liveSignal, deletedAt: OLD_DATE }],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(calls.signalsUpdate).toHaveBeenCalledTimes(1);
    expect(calls.signalsUpdate.mock.calls[0][0].data.deletedAt).toBeNull();
    expect(stores.signals[0].deletedAt).toBeNull();
    expect(result.results.success[0].created).toEqual({
      customer: false,
      agent: false,
      signal: false,
    });
  });

  it('does not touch a live signal (hot path stays write-free)', async () => {
    const { prisma, modelPricing, calls } = buildStatefulMocks({
      customers: [liveCustomer],
      agents: [liveAgent],
      signals: [liveSignal],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(calls.signalsUpdate).not.toHaveBeenCalled();
  });
});

describe('soft-deleted rows never reach the retryable-INTERNAL_ERROR path', () => {
  it('a soft-deleted customer AND agent cannot reach create(), so no P2002 escapes', async () => {
    const { prisma, modelPricing, calls } = buildStatefulMocks({
      customers: [{ ...liveCustomer, deletedAt: OLD_DATE }],
      agents: [{ ...liveAgent, deletedAt: OLD_DATE }],
      signals: [liveSignal],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.failed).toBe(0);
    expect(result.successful).toBe(1);
    // create() is what throws P2002 — it must never even be attempted.
    expect(calls.customersCreate).not.toHaveBeenCalled();
    expect(calls.agentsCreate).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: with resurrection disabled, the harness reproduces the P2002 failure', async () => {
    // Neuter updateMany (the resurrection CAS) so the code walks the
    // unguarded path: live-lookup miss -> create -> P2002 -> generic
    // INTERNAL_ERROR, stored: false, which the SDK buffer would retry 5x and
    // drop. Proves the stateful mock actually models the collision resurrection
    // prevents.
    const { prisma, modelPricing } = buildStatefulMocks({
      customers: [{ ...liveCustomer, deletedAt: OLD_DATE }],
      agents: [liveAgent],
      signals: [liveSignal],
    });
    prisma.customers.updateMany = () => Promise.resolve({ count: 0 });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.failed).toBe(1);
    expect(result.results.failed[0].code).toBe('INTERNAL_ERROR');
    expect(result.results.failed[0].stored).toBe(false);
  });

  it('concurrent-resurrection loser lane: racer revived the row first, loser finds it live', async () => {
    // Simulate the loser: its live-lookup ran before the racer's commit (miss),
    // by the time its updateMany runs the row is already live (count 0), and
    // the re-find picks up the racer's resurrection. No create, no P2002.
    const { prisma, modelPricing, calls } = buildStatefulMocks({
      customers: [liveCustomer],
      agents: [liveAgent],
      signals: [liveSignal],
    });
    const realFindFirst = prisma.customers.findFirst;
    let firstLookup = true;
    prisma.customers.findFirst = (args: any) => {
      if (firstLookup) {
        firstLookup = false;
        return Promise.resolve(null);
      }
      return realFindFirst(args);
    };
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls.customersCreate).not.toHaveBeenCalled();
    expect(result.results.success[0].created).toEqual({
      customer: false,
      agent: false,
      signal: false,
    });
  });
});
