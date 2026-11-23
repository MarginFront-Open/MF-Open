/**
 * Tests for SignalEventsService.mapModel + fillVolume in the
 * backfill flow. Covers the per-child loop, parent
 * recompute via the shared utility, signal_services auto-declare gating
 * + dedupe, and the no-matches early return.
 *
 * Mocked Prisma + mocked ModelPricingService.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SignalEventsService } from './signal-events.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const SIGNAL_ID = 'signal-uuid';
const PRICING_ID = 'pricing-uuid';

interface MockChild {
  id: string;
  signalEventId: string;
  model: string;
  modelProvider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  quantity: Decimal | number | null;
  signal_events: { signalId: string };
}

interface MockSibling {
  id: string;
  usageCost: Decimal | null;
  eventStatus: string;
}

function buildMocks(opts: {
  childrenToBackfill: MockChild[];
  /** Per-parentId, the OTHER siblings (besides the matched ones) used by recomputeParentUsageCost. */
  siblingsByParent?: Record<string, MockSibling[]>;
}) {
  const calls = {
    childrenFindMany: jest.fn(),
    childrenUpdate: jest.fn(),
    parentUpdate: jest.fn(),
    signalServicesUpsert: jest.fn(),
    orgMappingsUpsert: jest.fn(),
    servicePricingFindFirst: jest.fn(),
    servicePricingFindUnique: jest.fn(),
    calculateCost: jest.fn(),
    childrenFindManyForParent: jest.fn(),
    parentFindUnique: jest.fn(),
  };

  // Track what each child was updated to so we can simulate
  // recomputeParentUsageCost reading "current" state.
  const updatedChildren = new Map<string, { usageCost: Decimal; eventStatus: string }>();

  const prisma: any = {
    service_pricing: {
      findUnique: (args: any) => {
        calls.servicePricingFindUnique(args);
        return Promise.resolve({
          id: PRICING_ID,
          inputCost: 1.0,
          outputCost: 2.0,
          costUnit: '1M tokens',
          canonicalName: 'claude-sonnet-4-6',
          provider: 'anthropic',
        });
      },
      findFirst: (args: any) => {
        calls.servicePricingFindFirst(args);
        return Promise.resolve({
          id: PRICING_ID,
          inputCost: 1.0,
          outputCost: 2.0,
          costUnit: '1M tokens',
          canonicalName: 'claude-sonnet-4-6',
          provider: 'anthropic',
        });
      },
    },
    org_model_mappings: {
      upsert: (args: any) => {
        calls.orgMappingsUpsert(args);
        return Promise.resolve({ id: 'mapping-uuid' });
      },
    },
    signal_event_services: {
      findMany: (args: any) => {
        calls.childrenFindMany(args);
        return Promise.resolve(opts.childrenToBackfill);
      },
      update: (args: any) => {
        calls.childrenUpdate(args);
        // Simulate the post-update state for recomputeParentUsageCost.
        updatedChildren.set(args.where.id, {
          usageCost: args.data.usageCost,
          eventStatus: args.data.eventStatus,
        });
        return Promise.resolve(args.data);
      },
    },
    signal_events: {
      update: (args: any) => {
        calls.parentUpdate(args);
        return Promise.resolve(args.data);
      },
      findUnique: (args: any) => {
        calls.parentFindUnique(args);
        return Promise.resolve({ usageCost: null, eventProcessed: 'PENDING' });
      },
    },
    signal_services: {
      upsert: (args: any) => {
        calls.signalServicesUpsert(args);
        return Promise.resolve({});
      },
    },
    $transaction: (cb: any) => cb(prisma),
  };

  // recomputeParentUsageCost (called by the service) re-queries children.
  // Patch the children.findMany to return the post-update state when
  // called with a single signalEventId filter, vs the bulk filter when
  // called by the backfill itself.
  const originalFindMany = prisma.signal_event_services.findMany;
  prisma.signal_event_services.findMany = (args: any) => {
    // recomputeParentUsageCost uses { where: { signalEventId } }
    if (args.where?.signalEventId && !args.where?.eventStatus) {
      calls.childrenFindManyForParent(args);
      const parentId = args.where.signalEventId;
      const matchedChild = opts.childrenToBackfill.find((c) => c.signalEventId === parentId);
      const matchedUpdated = matchedChild ? updatedChildren.get(matchedChild.id) : undefined;
      const otherSiblings = opts.siblingsByParent?.[parentId] ?? [];
      const result = [
        ...(matchedChild
          ? [
              {
                usageCost: matchedUpdated?.usageCost ?? null,
                eventStatus: matchedUpdated?.eventStatus ?? matchedChild.signal_events.signalId,
              },
            ]
          : []),
        ...otherSiblings,
      ];
      return Promise.resolve(result);
    }
    return originalFindMany(args);
  };

  // Predictable: input * 0.001 + output * 0.002 (same as multi-service spec).
  // Zero cache terms — these children carry no cache tokens; the
  // cache behaviour of both doors is covered in
  // signal-events.backfill-cache-cost.spec.ts against the REAL pricing service.
  const stubCost = (inputTokens: number, outputTokens: number) => {
    const inputCost = new Decimal(inputTokens).mul('0.001');
    const outputCost = new Decimal(outputTokens).mul('0.002');
    return {
      totalCostUsd: inputCost.add(outputCost),
      inputCostUsd: inputCost,
      outputCostUsd: outputCost,
      cacheReadCostUsd: new Decimal(0),
      cacheWriteCostUsd: new Decimal(0),
      inputCostPerToken: 0.001,
      outputCostPerToken: 0.002,
      cacheReadCostPerToken: 0,
      cacheWriteCostPerToken: 0,
    };
  };

  const modelPricing: any = {
    calculateCost: (
      _model: string,
      inputTokens: number,
      outputTokens: number,
      quantity: number,
    ) => {
      calls.calculateCost(inputTokens, outputTokens, quantity);
      return Promise.resolve(stubCost(inputTokens, outputTokens));
    },
    resolveCost: (_model: string, inputTokens: number, outputTokens: number, quantity: number) => {
      calls.calculateCost(inputTokens, outputTokens, quantity);
      return Promise.resolve({ ok: true, cost: stubCost(inputTokens, outputTokens) });
    },
  };

  return { prisma, modelPricing, calls };
}

async function buildService(prisma: any, modelPricing: any): Promise<SignalEventsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SignalEventsService,
      { provide: ModelPricingService, useValue: modelPricing },
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get<SignalEventsService>(SignalEventsService);
}

const baseChild: Omit<MockChild, 'id' | 'signalEventId'> = {
  model: 'claude-sonnet-7',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
  quantity: null,
  signal_events: { signalId: SIGNAL_ID },
};

// ─── mapModel ──────────────────────────────────────────────────────────

describe('SignalEventsService.mapModel — fractional quantity (children loop)', () => {
  it('single-service: 1 child → PROCESSED, parent recomputed PROCESSED', async () => {
    const childrenToBackfill: MockChild[] = [
      { id: 'child-1', signalEventId: 'parent-1', ...baseChild },
    ];
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill,
      // No other siblings: this parent has only the one matched child.
      siblingsByParent: {},
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.mapModel(ORG, {
      sourceModel: 'claude-sonnet-7',
      sourceProvider: 'anthropic',
      targetPricingId: PRICING_ID,
    });

    // Child got updated with cost.
    expect(calls.childrenUpdate).toHaveBeenCalledTimes(1);
    const childUpdate = calls.childrenUpdate.mock.calls[0][0];
    expect(childUpdate.where.id).toBe('child-1');
    expect(childUpdate.data.eventStatus).toBe('PROCESSED');
    expect(childUpdate.data.servicePricingId).toBe(PRICING_ID);
    expect((childUpdate.data.usageCost as Decimal).toString()).toBe('2'); // 1000*0.001 + 500*0.002

    // Parent recomputed: 1 child resolved, no unresolved siblings → PROCESSED.
    expect(calls.parentUpdate).toHaveBeenCalledTimes(1);
    const parentUpdate = calls.parentUpdate.mock.calls[0][0];
    expect(parentUpdate.where.id).toBe('parent-1');
    expect(parentUpdate.data.eventProcessed).toBe('PROCESSED');
    expect((parentUpdate.data.usageCost as Decimal).toString()).toBe('2');

    // Auto-declare on signal_services for the resolved (signal, pricing) pair.
    expect(calls.signalServicesUpsert).toHaveBeenCalledTimes(1);

    expect(result.backfilled).toBe(1);
    expect(result.childrenUpdated).toBe(1);
  });

  it('multi-service: 1 of 2 children resolved → parent stays NEEDS_COST_BACKFILL', async () => {
    const childrenToBackfill: MockChild[] = [
      { id: 'child-1', signalEventId: 'parent-1', ...baseChild },
    ];
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill,
      siblingsByParent: {
        // Sibling still NEEDS_COST_BACKFILL (different model, not matched here).
        'parent-1': [{ id: 'child-2', usageCost: null, eventStatus: 'NEEDS_COST_BACKFILL' }],
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.mapModel(ORG, {
      sourceModel: 'claude-sonnet-7',
      sourceProvider: 'anthropic',
      targetPricingId: PRICING_ID,
    });

    // Child got resolved.
    const childUpdate = calls.childrenUpdate.mock.calls[0][0];
    expect(childUpdate.data.eventStatus).toBe('PROCESSED');

    // Parent: cost stays null (one sibling unresolved) and status stays NEEDS_COST_BACKFILL.
    const parentUpdate = calls.parentUpdate.mock.calls[0][0];
    expect(parentUpdate.data.eventProcessed).toBe('NEEDS_COST_BACKFILL');
    expect(parentUpdate.data.usageCost).toBeNull();
  });

  it('signal_services auto-declare dedupes across multiple children of same signal', async () => {
    // Two children of the SAME signal both match the mapped model. Auto-declare
    // should fire once per (signal, pricing) pair, not twice.
    const childrenToBackfill: MockChild[] = [
      { id: 'child-1', signalEventId: 'parent-1', ...baseChild },
      { id: 'child-2', signalEventId: 'parent-2', ...baseChild },
    ];
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill,
      siblingsByParent: {},
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.mapModel(ORG, {
      sourceModel: 'claude-sonnet-7',
      sourceProvider: 'anthropic',
      targetPricingId: PRICING_ID,
    });

    // Both children updated.
    expect(calls.childrenUpdate).toHaveBeenCalledTimes(2);
    // But signal_services only called ONCE (deduped).
    expect(calls.signalServicesUpsert).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when no children match the source model', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill: [],
      siblingsByParent: {},
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.mapModel(ORG, {
      sourceModel: 'unknown-model',
      sourceProvider: 'custom',
      targetPricingId: PRICING_ID,
    });

    expect(calls.childrenUpdate).not.toHaveBeenCalled();
    expect(calls.parentUpdate).not.toHaveBeenCalled();
    expect(calls.signalServicesUpsert).not.toHaveBeenCalled();
    expect(result.backfilled).toBe(0);
    expect(result.childrenUpdated).toBe(0);
  });
});

// ─── fillVolume ────────────────────────────────────────────────────────

describe('SignalEventsService.fillVolume — fractional quantity (children loop)', () => {
  it('single-service: 1 child filled → PROCESSED, parent recomputed PROCESSED', async () => {
    const childrenToBackfill: MockChild[] = [
      {
        id: 'child-1',
        signalEventId: 'parent-1',
        ...baseChild,
        inputTokens: null, // missing volume
        outputTokens: null,
      },
    ];
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill,
      siblingsByParent: {},
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'claude-sonnet-4-6',
      sourceProvider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 1000,
    });

    expect(calls.childrenUpdate).toHaveBeenCalledTimes(1);
    const childUpdate = calls.childrenUpdate.mock.calls[0][0];
    expect(childUpdate.data.inputTokens).toBe(2000);
    expect(childUpdate.data.outputTokens).toBe(1000);
    expect(childUpdate.data.eventStatus).toBe('PROCESSED');
    // Cost: 2000*0.001 + 1000*0.002 = 4
    expect((childUpdate.data.usageCost as Decimal).toString()).toBe('4');

    const parentUpdate = calls.parentUpdate.mock.calls[0][0];
    expect(parentUpdate.data.eventProcessed).toBe('PROCESSED');
    expect((parentUpdate.data.usageCost as Decimal).toString()).toBe('4');

    expect(result.backfilled).toBe(1);
    expect(result.childrenUpdated).toBe(1);
  });

  it('multi-service: 1 of 2 children filled → parent stays MISSING_VOLUME_DATA', async () => {
    const childrenToBackfill: MockChild[] = [
      {
        id: 'child-1',
        signalEventId: 'parent-1',
        ...baseChild,
        inputTokens: null,
        outputTokens: null,
      },
    ];
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill,
      siblingsByParent: {
        // Sibling still missing volume (different model).
        'parent-1': [{ id: 'child-2', usageCost: null, eventStatus: 'MISSING_VOLUME_DATA' }],
      },
    });
    const svc = await buildService(prisma, modelPricing);

    await svc.fillVolume(ORG, {
      sourceModel: 'claude-sonnet-4-6',
      sourceProvider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 1000,
    });

    // Child got filled.
    const childUpdate = calls.childrenUpdate.mock.calls[0][0];
    expect(childUpdate.data.eventStatus).toBe('PROCESSED');

    // Parent: cost stays null + status stays MISSING_VOLUME_DATA.
    const parentUpdate = calls.parentUpdate.mock.calls[0][0];
    expect(parentUpdate.data.eventProcessed).toBe('MISSING_VOLUME_DATA');
    expect(parentUpdate.data.usageCost).toBeNull();
  });

  it('returns 0 when no children match the source model', async () => {
    const { prisma, modelPricing, calls } = buildMocks({
      childrenToBackfill: [],
      siblingsByParent: {},
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'claude-sonnet-4-6',
      sourceProvider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 1000,
    });

    expect(calls.childrenUpdate).not.toHaveBeenCalled();
    expect(calls.parentUpdate).not.toHaveBeenCalled();
    expect(result.backfilled).toBe(0);
  });
});
