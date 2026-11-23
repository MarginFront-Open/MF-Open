/**
 * Service-level tests for SdkService.recordUsage's multi-service
 * handling. Covers the per-service loop, all-or-nothing
 * status rollup, parent cost sum invariant, signal_services auto-declare
 * gating, and the single-service response shape.
 *
 * Mocked Prisma + mocked ModelPricingService.
 *
 * Cases covered:
 *   single-service known + volume        → PROCESSED, cost = child cost
 *   single-service unknown model         → NEEDS_COST_BACKFILL, cost null
 *   single-service known + missing volume→ MISSING_VOLUME_DATA, cost null
 *   multi-service all known + volume     → PROCESSED, cost = SUM
 *   multi-service one unknown            → NEEDS_COST_BACKFILL on parent
 *   multi-service one missing volume     → MISSING_VOLUME_DATA on parent
 *   multi-service mixed unknown+missing  → NEEDS_COST_BACKFILL wins
 *   multi-service same model x2          → 2 children PROCESSED, sum
 *   signal_services upsert gating        → PROCESSED-only auto-declare
 *   single-service response shape        → top-level model fields echoed
 *   parent.usageCostData merge keys      → sum-on-collision
 */

import { Test, TestingModule } from '@nestjs/testing';
import { resolveEventPrice } from '@marginfront/db';
import { Decimal } from '@prisma/client/runtime/library';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const CUSTOMER_ID = 'cust-uuid';
const AGENT_ID = 'agent-uuid';
const SIGNAL_ID = 'signal-uuid';

// ─── Mock helpers ──────────────────────────────────────────────────────────

interface MockCalls {
  rawIngestCreate: jest.Mock;
  rawIngestUpdate: jest.Mock;
  signalEventsCreate: jest.Mock;
  signalEventServicesCreate: jest.Mock;
  signalServicesUpsert: jest.Mock;
  lookupModel: jest.Mock;
  calculateCost: jest.Mock;
  // Records ONLY the cacheWriteTtl hint (9th arg) per calculateCost
  // call, in a separate recorder so the exact-arg assertions on calculateCost stay simple.
  calculateCostTtl: jest.Mock;
}

interface MockModelEntry {
  servicePricingId: string;
  costUnit: '1M tokens' | 'unit' | 'page' | 'request';
  isLlm: boolean;
  // cache rates the pricing row carries. Omitted = the row has NO
  // cache rate for that token type (lookupModel returns undefined → the ingest
  // detector reads `== null` and flags). Set = the row IS priced for cache.
  cacheReadCost?: number;
  cacheWriteCost?: number;
}

const claudeEntry: MockModelEntry = {
  servicePricingId: 'pricing-claude-uuid',
  costUnit: '1M tokens',
  isLlm: true,
  // No cache rates on this row — a cache-bearing event against it must flag.
};

// a Claude row that DOES carry cache rates — a cache-bearing event
// against this one must stay PROCESSED (the no-false-positive control).
const claudeWithCacheEntry: MockModelEntry = {
  servicePricingId: 'pricing-claude-cache-uuid',
  costUnit: '1M tokens',
  isLlm: true,
  cacheReadCost: 0.3,
  cacheWriteCost: 3.75,
};

const googleMapsEntry: MockModelEntry = {
  servicePricingId: 'pricing-maps-uuid',
  costUnit: 'request',
  isLlm: false,
};

/**
 * Build a mocked PrismaService + ModelPricingService for one test.
 * Caller passes a model resolution map (which (model, provider) → MockModelEntry
 * or null) and the mocks return predictable values.
 */
function buildMocks(opts: {
  /** keyed by `${model}/${provider}` → entry, or null for unknown */
  modelMap: Record<string, MockModelEntry | null>;
}): { prisma: any; modelPricing: any; calls: MockCalls } {
  const calls: MockCalls = {
    rawIngestCreate: jest.fn(),
    rawIngestUpdate: jest.fn(),
    signalEventsCreate: jest.fn(),
    signalEventServicesCreate: jest.fn(),
    signalServicesUpsert: jest.fn(),
    lookupModel: jest.fn(),
    calculateCost: jest.fn(),
    calculateCostTtl: jest.fn(),
  };

  const prisma: any = {
    raw_ingest_events: {
      create: (args: any) => {
        calls.rawIngestCreate(args);
        return Promise.resolve({ id: 'raw-' + Math.random().toString(36).slice(2, 8) });
      },
      update: (args: any) => {
        calls.rawIngestUpdate(args);
        return Promise.resolve({});
      },
    },
    customers: {
      findFirst: () =>
        Promise.resolve({ id: CUSTOMER_ID, externalId: 'cust-ext-1', organizationId: ORG }),
      create: () => Promise.resolve({ id: CUSTOMER_ID }),
    },
    agents: {
      findFirst: () => Promise.resolve({ id: AGENT_ID, agentCode: 'agent-code-1', orgId: ORG }),
      create: () => Promise.resolve({ id: AGENT_ID }),
    },
    signals: {
      upsert: () => Promise.resolve({ id: SIGNAL_ID, name: 'sig-1', orgId: ORG }),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
    },
    signal_events: {
      create: (args: any) => {
        calls.signalEventsCreate(args);
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
      upsert: (args: any) => {
        calls.signalServicesUpsert(args);
        return Promise.resolve({});
      },
    },
    // The transaction callback gets `prisma` itself as its tx client. The
    // utility uses tx for every write inside, so the mock surface IS the
    // transaction surface.
    // RecordUsage loads matter attribution context per batch.
    matters: { findMany: () => Promise.resolve([]) },
    matter_routing_rules: { findMany: () => Promise.resolve([]) },
    $transaction: (cb: any) => cb(prisma),
  };

  // ModelPricingService mock. lookupModel reads the modelMap; calculateCost
  // returns predictable cents-per-token (LLM) or dollars-per-unit (non-LLM).
  const modelPricing: any = {
    lookupModel: (model: string, provider: string) => {
      calls.lookupModel(model, provider);
      const key = `${model}/${provider.toLowerCase()}`;
      const entry = opts.modelMap[key];
      if (!entry) return Promise.resolve(null);
      return Promise.resolve({
        servicePricingId: entry.servicePricingId,
        costUnit: entry.costUnit,
        // pass cache rates through so the ingest detector can tell a
        // priced-for-cache row (number) from one with no cache rate (undefined).
        cacheReadCost: entry.cacheReadCost,
        cacheWriteCost: entry.cacheWriteCost,
      });
    },
    calculateCost: (
      model: string,
      inputTokens: number,
      outputTokens: number,
      quantity: number,
      provider: string,
      modelEntry: any,
      _cacheReadTokens?: number,
      _cacheWriteTokens?: number,
      cacheWriteTtl?: unknown,
    ) => {
      calls.calculateCost(model, inputTokens, outputTokens, quantity, provider);
      calls.calculateCostTtl(cacheWriteTtl);
      // Predictable: LLM = $0.001/input + $0.002/output. Non-LLM = $0.50/unit.
      const isLlm = modelEntry.costUnit === '1M tokens';
      // The real EventCostResult always carries the four cache fields (they're
      // 0 when there's no cache). recordUsage reads cacheReadCostUsd.toNumber()
      // whenever the event sent cache tokens, so the mock must return them or it
      // throws before the child write — the dollar value is irrelevant to these
      // status-focused matrix tests (cache pricing is locked in
      // model-pricing.service.spec.ts), so 0 is fine.
      const cacheFields = {
        cacheReadCostUsd: new Decimal(0),
        cacheWriteCostUsd: new Decimal(0),
        cacheReadCostPerToken: 0,
        cacheWriteCostPerToken: 0,
      };
      if (isLlm) {
        const inputCost = new Decimal(inputTokens).mul('0.001');
        const outputCost = new Decimal(outputTokens).mul('0.002');
        return Promise.resolve({
          totalCostUsd: inputCost.add(outputCost),
          inputCostUsd: inputCost,
          outputCostUsd: outputCost,
          inputCostPerToken: 0.001,
          outputCostPerToken: 0.002,
          ...cacheFields,
        });
      } else {
        const totalCost = new Decimal(quantity).mul('0.5');
        return Promise.resolve({
          totalCostUsd: totalCost,
          inputCostUsd: new Decimal(0),
          outputCostUsd: new Decimal(0),
          inputCostPerToken: 0,
          outputCostPerToken: 0,
          ...cacheFields,
        });
      }
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
      { provide: CustomerAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

const baseRecord = {
  customerExternalId: 'cust-ext-1',
  agentCode: 'agent-code-1',
  signalName: 'sig-1',
};

// ─── single-service known + valid volume ──────────────────────

describe('SdkService.recordUsage — single-service known + valid volume', () => {
  it('writes one child PROCESSED, parent PROCESSED, parent cost equals child cost', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
        },
      ],
    } as any);

    expect(calls.signalEventServicesCreate).toHaveBeenCalledTimes(1);
    expect(calls.signalEventsCreate).toHaveBeenCalledTimes(1);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('PROCESSED');
    expect((child.usageCost as Decimal).toString()).toBe('2'); // 1000*0.001 + 500*0.002

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('PROCESSED');
    expect((parent.usageCost as Decimal).toString()).toBe('2');

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('single-service success response carries model and token fields at the top level', async () => {
    const { prisma, modelPricing } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
        },
      ],
    } as any);

    const success = result.results.success[0];
    expect(success.model).toBe('claude-sonnet-4-6');
    expect(success.modelProvider).toBe('anthropic');
    expect(success.inputTokens).toBe(1000);
    expect(success.outputTokens).toBe(500);
    expect(success.totalCostUsd).toBe('2.0000000000');
    expect(success.services).toBeUndefined(); // no services array on single-service
  });
});

// ─── single-service unknown model ─────────────────────────────

describe('SdkService.recordUsage — single-service unknown model', () => {
  it('writes one child NEEDS_COST_BACKFILL, parent NEEDS_COST_BACKFILL, parent cost null', async () => {
    const { prisma, modelPricing, calls } = buildMocks({ modelMap: {} });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'unknown-model',
          modelProvider: 'custom',
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('NEEDS_COST_BACKFILL');
    expect(child.usageCost).toBeNull();
    expect(child.servicePricingId).toBeNull();

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parent.usageCost).toBeNull();

    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    const failed = result.results.failed[0];
    expect(failed.code).toBe('NEEDS_COST_BACKFILL');
    expect(failed.stored).toBe(true);
    expect(failed.error).toMatch(/not found in service_pricing/);
    expect(failed.error).not.toMatch(/—/); // customer-facing errors carry no em dash
  });
});

// ─── single-service known + missing volume ────────────────────

describe('SdkService.recordUsage — single-service known + missing volume', () => {
  it('LLM without tokens → child + parent MISSING_VOLUME_DATA, cost null', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          // no tokens
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('MISSING_VOLUME_DATA');
    expect(child.usageCost).toBeNull();

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('MISSING_VOLUME_DATA');
    expect(parent.usageCost).toBeNull();

    const failed = result.results.failed[0];
    expect(failed.code).toBe('MISSING_VOLUME_DATA');
    expect(failed.error).toMatch(/requires both inputTokens and outputTokens/);
    expect(failed.error).not.toMatch(/—/);
  });

  it('non-LLM without quantity → child + parent MISSING_VOLUME_DATA', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'twilio-sms/twilio': googleMapsEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'twilio-sms',
          modelProvider: 'twilio',
          // no quantity (note: top-level quantity is signal-level; for
          // single-service the virtual entry inherits it; null here)
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('MISSING_VOLUME_DATA');
    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('MISSING_VOLUME_DATA');
  });
});

// ─── multi-service all known + valid ──────────────────────────

describe('SdkService.recordUsage — multi-service all known + valid', () => {
  it('writes N children all PROCESSED, parent PROCESSED, parent cost equals SUM', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            {
              model: 'google-maps-places',
              modelProvider: 'google',
              quantity: 3,
            },
          ],
        },
      ],
    } as any);

    expect(calls.signalEventServicesCreate).toHaveBeenCalledTimes(2);

    // Child 0 = Claude, $2 (1000*0.001 + 500*0.002)
    const child0 = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child0.model).toBe('claude-sonnet-4-6');
    expect(child0.eventStatus).toBe('PROCESSED');
    expect((child0.usageCost as Decimal).toString()).toBe('2');

    // Child 1 = Google Maps, $1.50 (3 * 0.5)
    const child1 = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect(child1.model).toBe('google-maps-places');
    expect(child1.eventStatus).toBe('PROCESSED');
    expect((child1.usageCost as Decimal).toString()).toBe('1.5');

    // Parent = sum of children
    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('PROCESSED');
    expect((parent.usageCost as Decimal).toString()).toBe('3.5');
  });
});

// ─── multi-service one unknown + one valid ────────────────────

describe('SdkService.recordUsage — multi-service one unknown + one valid', () => {
  it('parent NEEDS_COST_BACKFILL (worst-case wins), parent cost null', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        // unknown-model NOT in map
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            { model: 'unknown-model', modelProvider: 'custom', quantity: 1 },
          ],
        },
      ],
    } as any);

    const child0 = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child0.eventStatus).toBe('PROCESSED');
    expect((child0.usageCost as Decimal).toString()).toBe('2');

    const child1 = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect(child1.eventStatus).toBe('NEEDS_COST_BACKFILL');
    expect(child1.usageCost).toBeNull();

    // Parent: worst-case wins. Cost null because one child is unresolved.
    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parent.usageCost).toBeNull();
  });
});

// ─── multi-service one missing volume + one valid ─────────────

describe('SdkService.recordUsage — multi-service one missing volume + one valid', () => {
  it('parent MISSING_VOLUME_DATA, parent cost null', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            // Maps without quantity
            { model: 'google-maps-places', modelProvider: 'google' },
          ],
        },
      ],
    } as any);

    const child0 = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child0.eventStatus).toBe('PROCESSED');

    const child1 = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect(child1.eventStatus).toBe('MISSING_VOLUME_DATA');
    expect(child1.usageCost).toBeNull();

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('MISSING_VOLUME_DATA');
    expect(parent.usageCost).toBeNull();
  });
});

// ─── multi-service mixed unknown + missing volume ─────────────

describe('SdkService.recordUsage — multi-service mixed unknown + missing volume', () => {
  it('parent NEEDS_COST_BACKFILL (priority over MISSING_VOLUME_DATA)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        // unknown not in map
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            { model: 'unknown-thing', modelProvider: 'custom' }, // NEEDS_COST_BACKFILL
            { model: 'claude-sonnet-4-6', modelProvider: 'anthropic' }, // MISSING_VOLUME_DATA
          ],
        },
      ],
    } as any);

    const child0 = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child0.eventStatus).toBe('NEEDS_COST_BACKFILL');

    const child1 = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect(child1.eventStatus).toBe('MISSING_VOLUME_DATA');

    // NEEDS_COST_BACKFILL wins per worstStatus priority.
    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parent.usageCost).toBeNull();
  });
});

// ─── multi-service same model+provider listed twice ───────────

describe('SdkService.recordUsage — same model+provider listed twice', () => {
  it('writes two children both PROCESSED, parent cost = sum of both', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            }, // $2
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 2000,
              outputTokens: 800,
            }, // 2000*0.001 + 800*0.002 = 2 + 1.6 = $3.6
          ],
        },
      ],
    } as any);

    expect(calls.signalEventServicesCreate).toHaveBeenCalledTimes(2);

    const child0 = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect((child0.usageCost as Decimal).toString()).toBe('2');

    const child1 = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect((child1.usageCost as Decimal).toString()).toBe('3.6');

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('PROCESSED');
    expect((parent.usageCost as Decimal).toString()).toBe('5.6');
  });

  it('parent.usageCostData merges keys with sum-on-collision (same model listed twice)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 2000,
              outputTokens: 800,
            },
          ],
        },
      ],
    } as any);

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    const costData = parent.usageCostData as Record<
      string,
      { cost: number; units: number; costPerUnit: number }
    >;
    // Keys are model-only (no provider in the key).
    expect(costData['claude-sonnet-4-6/input']).toBeDefined();
    expect(costData['claude-sonnet-4-6/output']).toBeDefined();
    // Cost summed: input cost = 1000*0.001 + 2000*0.001 = 3
    expect(costData['claude-sonnet-4-6/input'].cost).toBeCloseTo(3, 6);
    // Units summed: 1000 + 2000 = 3000
    expect(costData['claude-sonnet-4-6/input'].units).toBe(3000);
    // Output cost: 500*0.002 + 800*0.002 = 1 + 1.6 = 2.6
    expect(costData['claude-sonnet-4-6/output'].cost).toBeCloseTo(2.6, 6);
    expect(costData['claude-sonnet-4-6/output'].units).toBe(1300);
  });
});

// ─── signal_services auto-declare gating ──────────────────────

describe('SdkService.recordUsage — signal_services auto-declare gating', () => {
  it('only declares for PROCESSED children, not NEEDS_COST_BACKFILL or MISSING_VOLUME_DATA', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
        // unknown-thing NOT in map
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            }, // PROCESSED
            { model: 'google-maps-places', modelProvider: 'google' }, // MISSING_VOLUME_DATA (no quantity)
            { model: 'unknown-thing', modelProvider: 'custom', quantity: 1 }, // NEEDS_COST_BACKFILL
          ],
        },
      ],
    } as any);

    // Only one upsert: for the Claude PROCESSED child.
    expect(calls.signalServicesUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = calls.signalServicesUpsert.mock.calls[0][0];
    expect(upsertArg.where.signalId_servicePricingId.servicePricingId).toBe(
      claudeEntry.servicePricingId,
    );
  });

  it('declares all PROCESSED children when all are valid', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            { model: 'google-maps-places', modelProvider: 'google', quantity: 3 },
          ],
        },
      ],
    } as any);

    expect(calls.signalServicesUpsert).toHaveBeenCalledTimes(2);
  });
});

// ─── single-service response shape ───────────────────────────

describe('SdkService.recordUsage: response shape', () => {
  it('multi-service success response uses services array, not top-level fields', async () => {
    const { prisma, modelPricing } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            { model: 'google-maps-places', modelProvider: 'google', quantity: 3 },
          ],
        },
      ],
    } as any);

    const success = result.results.success[0];
    expect(success.services).toHaveLength(2);
    expect(success.services[0].model).toBe('claude-sonnet-4-6');
    expect(success.services[0].usageCost).toBe('2.0000000000');
    expect(success.services[1].model).toBe('google-maps-places');
    expect(success.services[1].usageCost).toBe('1.5000000000');
    expect(success.totalCostUsd).toBe('3.5000000000');
    // Single-service top-level fields NOT present on multi-service.
    expect(success.model).toBeUndefined();
    expect(success.modelProvider).toBeUndefined();
    expect(success.inputTokens).toBeUndefined();
  });

  it('multi-service failed response includes per-service status array', async () => {
    const { prisma, modelPricing } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            { model: 'unknown-thing', modelProvider: 'custom', quantity: 1 },
          ],
        },
      ],
    } as any);

    const failed = result.results.failed[0];
    expect(failed.servicesStatus).toHaveLength(2);
    expect(failed.servicesStatus[0].eventStatus).toBe('PROCESSED');
    expect(failed.servicesStatus[1].eventStatus).toBe('NEEDS_COST_BACKFILL');
  });
});

// ─── parent.quantity stays signal-level ──────────────────────

describe('SdkService.recordUsage — parent.quantity stays signal-level', () => {
  it('multi-service: parent.quantity defaults to 1 when caller omits top-level quantity', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          // no top-level quantity
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
            },
            { model: 'google-maps-places', modelProvider: 'google', quantity: 3 },
          ],
        },
      ],
    } as any);

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.quantity).toBe(1); // signal-level default

    // But child Maps quantity is 3 (service-level)
    const childMaps = calls.signalEventServicesCreate.mock.calls[1][0].data;
    expect(childMaps.quantity).toBe(3);
  });

  it('single-service: parent.quantity carries top-level quantity', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'twilio-sms/twilio': googleMapsEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'twilio-sms',
          modelProvider: 'twilio',
          quantity: 5, // 5 SMS messages — single-service: signal-level == service-level
        },
      ],
    } as any);

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.quantity).toBe(5);

    // Single-service: virtual entry inherits top-level quantity, cost = 5*0.5 = 2.5
    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.quantity).toBe(5);
    expect((child.usageCost as Decimal).toString()).toBe('2.5');
  });
});

// ─── cache tokens vs missing cache rate ──────────
//
// The fail-safe-high guardrail. The detector is PER-EVENT: it fires ONLY when
// the event actually reported cache tokens AND the resolved row has no rate for
// that token type. The first test proves it flags (no silent $0); the next two
// prove the no-false-positive guarantee — a priced-for-cache row and a no-cache
// event both stay PROCESSED.

describe('SdkService.recordUsage — cache token has no matching rate', () => {
  it('cache-read tokens + row missing cacheReadCost → child + parent NEEDS_COST_BACKFILL, cost null', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry }, // no cache rate
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 5000, // event DID use cache, but the row can't price it
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('NEEDS_COST_BACKFILL');
    expect(child.usageCost).toBeNull();
    // svcCostData was nulled, which the write utility maps to Prisma.JsonNull
    // (renders as {}) — same null-ish state as the unknown-model child. The
    // point: the bogus $0 cache breakdown is dropped, no cost-by-service keys.
    expect(Object.keys(child.usageCostData as object)).toHaveLength(0);
    // Unlike the unknown-model branch, the model DID resolve — we keep the id so
    // the eventual backfill knows which row to populate.
    expect(child.servicePricingId).toBe('pricing-claude-uuid');

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parent.usageCost).toBeNull();

    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    const failed = result.results.failed[0];
    expect(failed.code).toBe('NEEDS_COST_BACKFILL');
    expect(failed.stored).toBe(true); // stored, do-not-retry — never dropped
    expect(failed.error).toMatch(/missing cacheReadCost/);
    expect(failed.error).toMatch(/usageCost: null/);
    expect(failed.error).not.toMatch(/—/); // em-dash convention on customer-facing errors
  });

  it('cache-write tokens + row missing cacheWriteCost → NEEDS_COST_BACKFILL (the OR-branch fires too)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry }, // no cache rate
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
          cacheWriteTokens: 8000, // cache-write half of the detector
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('NEEDS_COST_BACKFILL');
    expect(child.usageCost).toBeNull();

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parent.usageCost).toBeNull();
  });

  it('NO false positive: cache tokens + row HAS the cache rate → stays PROCESSED, cost intact', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeWithCacheEntry }, // priced for cache
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 5000, // cache used AND priced — must not flag
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('PROCESSED');
    expect(child.usageCost).not.toBeNull();

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('PROCESSED');
    expect(parent.usageCost).not.toBeNull();
  });

  it('NO false positive: NO cache tokens + row missing cache rate → stays PROCESSED (missing rate is irrelevant)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeEntry }, // no cache rate
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
          // no cache tokens at all
        },
      ],
    } as any);

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.eventStatus).toBe('PROCESSED');
    expect((child.usageCost as Decimal).toString()).toBe('2');

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.eventProcessed).toBe('PROCESSED');
  });
});

// ─── fractional quantity end-to-end ──────────────
//
// quantity is validated with @IsNumber() + @Min(0) at the DTO layer
// (record-usage.dto.ts), so fractions are accepted. This proves the fraction survives the full
// recordUsage path — DTO → calculateCost → the Decimal(18,6) usageCost
// written to both the child and the parent — not just DTO validation.

describe('SdkService.recordUsage — fractional quantity end-to-end', () => {
  it('quantity 0.066 flows through to the correct usageCost on child and parent', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'google-maps-places/google': googleMapsEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'google-maps-places',
          modelProvider: 'google',
          quantity: 0.066,
        },
      ],
    } as any);

    expect(calls.calculateCost).toHaveBeenCalledWith('google-maps-places', 0, 0, 0.066, 'google');

    const child = calls.signalEventServicesCreate.mock.calls[0][0].data;
    expect(child.quantity).toBe(0.066);
    expect(child.eventStatus).toBe('PROCESSED');
    expect((child.usageCost as Decimal).toString()).toBe('0.033'); // 0.066 * 0.50

    const parent = calls.signalEventsCreate.mock.calls[0][0].data;
    expect(parent.quantity).toBe(0.066);
    expect(parent.eventProcessed).toBe('PROCESSED');
    expect((parent.usageCost as Decimal).toString()).toBe('0.033');
  });
});

// ─── metadata.cacheWriteTtl threads from ingest to calculateCost ──
//
// The rate branch itself is locked in model-pricing.service.spec.ts and the
// @marginfront/db suite; what THIS block pins is the plumbing — recordUsage must
// hand the event's stored metadata hint to calculateCost, because that same
// stored metadata is what a later backfill re-reads (reproducibility).

describe('SdkService.recordUsage — cacheWriteTtl threading', () => {
  it('passes metadata.cacheWriteTtl to calculateCost on a single-service record', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeWithCacheEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
          cacheWriteTokens: 200,
          metadata: { sessionId: 's-1', cacheWriteTtl: '5m' },
        },
      ],
    } as any);

    expect(calls.calculateCostTtl).toHaveBeenCalledTimes(1);
    expect(calls.calculateCostTtl).toHaveBeenCalledWith('5m');
  });

  it('passes undefined when the record has no metadata hint (older senders)', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: { 'claude-sonnet-4-6/anthropic': claudeWithCacheEntry },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 1000,
          outputTokens: 500,
        },
      ],
    } as any);

    expect(calls.calculateCostTtl).toHaveBeenCalledTimes(1);
    expect(calls.calculateCostTtl).toHaveBeenCalledWith(undefined);
  });

  it('hands the record-level hint to EVERY service of a multi-service record', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      modelMap: {
        'claude-sonnet-4-6/anthropic': claudeWithCacheEntry,
        'google-maps-places/google': googleMapsEntry,
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [
        {
          ...baseRecord,
          metadata: { cacheWriteTtl: '5m' },
          services: [
            {
              model: 'claude-sonnet-4-6',
              modelProvider: 'anthropic',
              inputTokens: 1000,
              outputTokens: 500,
              cacheWriteTokens: 200,
            },
            {
              model: 'google-maps-places',
              modelProvider: 'google',
              quantity: 2,
            },
          ],
        },
      ],
    } as any);

    expect(calls.calculateCostTtl).toHaveBeenCalledTimes(2);
    expect(calls.calculateCostTtl).toHaveBeenNthCalledWith(1, '5m');
    // The non-Anthropic service gets the same raw hint; applyCacheWriteTtl's
    // provider guard (locked in the db suite) is what makes it a no-op there.
    expect(calls.calculateCostTtl).toHaveBeenNthCalledWith(2, '5m');
  });
});
