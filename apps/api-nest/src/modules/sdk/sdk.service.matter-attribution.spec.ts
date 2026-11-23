/**
 * WHAT THIS FILE DOES: proves the matter attribution WIRING through
 * the full recordUsage path — a tagged record lands on its matter with source
 * 'tag' in the actual signal_events write, a rule sweeps an untagged record
 * with source 'rule', an unknown tag still creates the event (Unassigned,
 * never dropped), the batch loads matters/rules at most once, a database
 * missing the matter tables (P2021 — the deploy transient, only
 * the dashboard deploy runs migrations) never fails the ingest, and any
 * OTHER matter-read error fails the request instead of silently landing a
 * tagged batch in Unassigned.
 *
 * WHY IT EXISTS: the pure precedence contract lives in
 * matter-attribution.util.spec.ts; THIS file pins that the service actually
 * calls it and carries the result into the DB row the audit export reads.
 *
 * CONNECTS TO: sdk.service.ts (loadMatterAttributionContext + STEP 9 input),
 * signal-event.utils.ts (matterId/matterSource on the parent create).
 *
 * Mocked Prisma + mocked ModelPricingService, same harness shape as
 * sdk.service.dedup.spec.ts. Real DB behavior (FKs, the SetNull) needs a
 * real database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { resolveEventPrice } from '@marginfront/db';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG_A = 'org-a-uuid';
const CUSTOMER_ID = 'cust-uuid';
const AGENT_ID = 'agent-uuid';
const SIGNAL_ID = 'signal-uuid';
const MATTER_A = 'matter-a-uuid';
const MATTER_B = 'matter-b-uuid';

interface MatterRow {
  id: string;
  matterNumber: string;
}
interface RuleRow {
  matterId: string;
  priority: number;
  agentCode: string | null;
  customerExternalId: string | null;
  signalPattern: string | null;
}

interface MockCalls {
  mattersFindMany: jest.Mock;
  rulesFindMany: jest.Mock;
  signalEventsCreate: jest.Mock;
}

/**
 * Same mock surface as the dedup spec's buildMocks, plus the two matter
 * tables (always present, like the generated client — pre-migration the
 * MODELS exist, the DB tables don't). `matterReadError` makes both matter
 * reads reject with it: a P2021 reproduces the deploy transient, anything
 * else must rethrow out of recordUsage.
 */
function buildMocks(opts: { matters?: MatterRow[]; rules?: RuleRow[]; matterReadError?: Error }): {
  prisma: any;
  modelPricing: any;
  calls: MockCalls;
} {
  const calls: MockCalls = {
    mattersFindMany: jest.fn(),
    rulesFindMany: jest.fn(),
    signalEventsCreate: jest.fn(),
  };

  const prisma: any = {
    raw_ingest_events: {
      create: () => Promise.resolve({ id: 'raw-' + Math.random().toString(36).slice(2, 8) }),
      update: () => Promise.resolve({}),
    },
    customers: {
      findFirst: () =>
        Promise.resolve({
          id: CUSTOMER_ID,
          externalId: 'client-42',
          organizationId: ORG_A,
        }),
      create: () => Promise.resolve({ id: CUSTOMER_ID }),
    },
    agents: {
      findFirst: () => Promise.resolve({ id: AGENT_ID, agentCode: 'intake-agent', orgId: ORG_A }),
      create: () => Promise.resolve({ id: AGENT_ID }),
    },
    signals: {
      upsert: () => Promise.resolve({ id: SIGNAL_ID, name: 'Contract Review', orgId: ORG_A }),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
    },
    signal_events: {
      findFirst: () => Promise.resolve(null),
      create: (args: any) => {
        calls.signalEventsCreate(args);
        return Promise.resolve(args.data);
      },
    },
    signal_event_services: {
      create: (args: any) => Promise.resolve(args.data),
    },
    signal_services: {
      upsert: () => Promise.resolve({}),
    },
    $transaction: (cb: any) => cb(prisma),
  };

  prisma.matters = {
    findMany: (args: any) => {
      calls.mattersFindMany(args);
      if (opts.matterReadError) return Promise.reject(opts.matterReadError);
      const wanted: string[] = args.where.matterNumber.in;
      return Promise.resolve((opts.matters ?? []).filter((m) => wanted.includes(m.matterNumber)));
    },
  };
  prisma.matter_routing_rules = {
    findMany: (args: any) => {
      calls.rulesFindMany(args);
      if (opts.matterReadError) return Promise.reject(opts.matterReadError);
      return Promise.resolve(opts.rules ?? []);
    },
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
  modelPricing.resolveCost = async (
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
    const entry = preFetchedEntry ?? (await modelPricing.lookupModel(modelId, provider));
    const verdict = resolveEventPrice({
      inputTokens,
      outputTokens,
      quantity,
      entry: { inputCost: 0, outputCost: 0, ...entry },
      cacheReadTokens,
      cacheWriteTokens,
      provider,
      cacheWriteTtl,
      model: modelId,
    });
    if (!verdict.ok) return { ...verdict, modelKey: modelId };
    const cost = await modelPricing.calculateCost(
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

  return { prisma, modelPricing, calls };
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
      {
        provide: CustomerAlertTriggerService,
        useValue: { maybeTrigger: jest.fn() },
      },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

const baseRecord = {
  customerExternalId: 'client-42',
  agentCode: 'intake-agent',
  signalName: 'Contract Review',
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

describe('recordUsage matter attribution — wiring into the signal_events write', () => {
  it('a metadata.matterId tag matching an org matter lands with source tag', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      matters: [{ id: MATTER_A, matterNumber: 'MAT-2214' }],
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, metadata: { matterId: 'MAT-2214' } }],
    } as any);

    expect(result.successful).toBe(1);
    const written = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(written.matterId).toBe(MATTER_A);
    expect(written.matterSource).toBe('tag');
  });

  it('an untagged record swept by an agentCode rule lands with source rule', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      rules: [
        {
          matterId: MATTER_B,
          priority: 100,
          agentCode: 'intake-agent',
          customerExternalId: null,
          signalPattern: null,
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG_A, { records: [{ ...baseRecord }] } as any);

    const written = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(written.matterId).toBe(MATTER_B);
    expect(written.matterSource).toBe('rule');
  });

  it('a tag BEATS a rule that also matches the same record', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      matters: [{ id: MATTER_A, matterNumber: 'MAT-2214' }],
      rules: [
        {
          matterId: MATTER_B,
          priority: 1,
          agentCode: 'intake-agent',
          customerExternalId: null,
          signalPattern: null,
        },
      ],
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, metadata: { matterId: 'MAT-2214' } }],
    } as any);

    const written = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(written.matterId).toBe(MATTER_A);
    expect(written.matterSource).toBe('tag');
  });

  it('an UNKNOWN tag still creates the event — Unassigned, not dropped, not auto-created', async () => {
    const { prisma, modelPricing, calls } = buildMocks({ matters: [] });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, metadata: { matterId: 'NOPE-404' } }],
    } as any);

    expect(result.successful).toBe(1);
    const written = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(written.matterId).toBeNull();
    expect(written.matterSource).toBeNull();
  });

  it('loads rules once per batch, and matters only when a tag is present', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      matters: [{ id: MATTER_A, matterNumber: 'MAT-2214' }],
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG_A, {
      records: [
        { ...baseRecord, metadata: { matterId: 'MAT-2214' } },
        { ...baseRecord },
        { ...baseRecord, metadata: { matterId: 'MAT-2214' } },
      ],
    } as any);
    expect(calls.rulesFindMany).toHaveBeenCalledTimes(1);
    expect(calls.mattersFindMany).toHaveBeenCalledTimes(1);
    // Without the createdAt/id tie-breaks, two default-priority-100 rules
    // resolve by database row order — nondeterministic.
    expect(calls.rulesFindMany.mock.calls[0][0].orderBy).toEqual([
      { priority: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);

    calls.rulesFindMany.mockClear();
    calls.mattersFindMany.mockClear();
    await svc.recordUsage(ORG_A, { records: [{ ...baseRecord }] } as any);
    expect(calls.rulesFindMany).toHaveBeenCalledTimes(1);
    expect(calls.mattersFindMany).not.toHaveBeenCalled();
  });

  it('a database missing the matter tables (P2021, the pre-migration transient) never fails the ingest', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      matterReadError: new Prisma.PrismaClientKnownRequestError(
        'The table `public.matter_routing_rules` does not exist in the current database.',
        { code: 'P2021', clientVersion: 'test' },
      ),
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG_A, {
      records: [{ ...baseRecord, metadata: { matterId: 'MAT-2214' } }],
    } as any);

    expect(result.successful).toBe(1);
    const written = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(written.matterId).toBeNull();
    expect(written.matterSource).toBeNull();
  });

  it('any OTHER matter-read error fails the request — never silent Unassigned for a tagged batch', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      matterReadError: new Error('connection reset by peer'),
    });
    const svc = await buildService(prisma, modelPricing);

    await expect(
      svc.recordUsage(ORG_A, {
        records: [{ ...baseRecord, metadata: { matterId: 'MAT-2214' } }],
      } as any),
    ).rejects.toThrow('connection reset by peer');
    expect(calls.signalEventsCreate).not.toHaveBeenCalled();
  });
});
