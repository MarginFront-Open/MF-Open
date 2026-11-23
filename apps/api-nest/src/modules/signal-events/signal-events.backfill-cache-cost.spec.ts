/**
 * Cache spend survives both api-nest backfill doors.
 *
 * `fillVolume` and `mapModel` must select the child's cache token counts and
 * price through the cache-aware path. A child that carries cacheReadTokens /
 * cacheWriteTokens would otherwise have that spend dropped from its usageCost
 * and be stamped PROCESSED. This is a different failure from the missing-rate
 * one: nothing is unknown. The tokens and the rates are both on hand and the
 * cost would leave them out.
 *
 * Unlike signal-events.service.spec.ts this wires the REAL ModelPricingService
 * so the cache arithmetic and the missing-rate guard are the ones production
 * runs, not a stub that returns a fixed shape.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SignalEventsService } from './signal-events.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const SIGNAL_ID = 'signal-uuid';

// A realistic child, claude-opus-5 / anthropic.
const CACHE_READ_TOKENS = 1_306_052;
const CACHE_WRITE_TOKENS = 26_907;

// The published service_pricing row for claude-opus-5 / anthropic.
const FULLY_PRICED_ROW = {
  id: 'pricing-uuid',
  canonicalName: 'claude-opus-5',
  provider: 'anthropic',
  inputCost: 5,
  outputCost: 25,
  cacheReadCost: 0.5,
  cacheWriteCost: 10,
  costUnit: '1M tokens',
};

const NULL_CACHE_WRITE_ROW = { ...FULLY_PRICED_ROW, cacheWriteCost: null };
const PRICED_ZERO_WRITE_ROW = { ...FULLY_PRICED_ROW, cacheWriteCost: 0 };
const NON_TOKEN_ROW = {
  id: 'pricing-web-search',
  canonicalName: 'anthropic-web-search',
  provider: 'anthropic',
  inputCost: 10,
  outputCost: null,
  cacheReadCost: null,
  cacheWriteCost: null,
  costUnit: '1K requests',
};

interface ChildOverrides {
  model?: string;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  metadata?: Record<string, unknown> | null;
  id?: string;
}

function child(overrides: ChildOverrides = {}) {
  return {
    id: overrides.id ?? 'child-1',
    signalEventId: 'parent-1',
    model: overrides.model ?? 'claude-opus-5',
    modelProvider: 'anthropic',
    cacheReadTokens:
      overrides.cacheReadTokens === undefined ? CACHE_READ_TOKENS : overrides.cacheReadTokens,
    cacheWriteTokens:
      overrides.cacheWriteTokens === undefined ? CACHE_WRITE_TOKENS : overrides.cacheWriteTokens,
    signal_events: {
      signalId: SIGNAL_ID,
      metadata: overrides.metadata ?? null,
    },
  };
}

function buildMocks(opts: { row: Record<string, unknown>; children: unknown[] }) {
  const childUpdate = jest.fn();
  const prisma: any = {
    service_pricing: {
      findFirst: () => Promise.resolve(opts.row),
      findUnique: () => Promise.resolve(opts.row),
    },
    signal_event_services: {
      findMany: (args: any) => {
        // recomputeParentUsageCost re-queries by parent; return a resolved child.
        if (args.where?.signalEventId && !args.where?.eventStatus) {
          return Promise.resolve([{ usageCost: new Decimal(1), eventStatus: 'PROCESSED' }]);
        }
        return Promise.resolve(opts.children);
      },
      update: (args: any) => {
        childUpdate(args);
        return Promise.resolve(args.data);
      },
    },
    signal_events: {
      update: () => Promise.resolve({}),
      findUnique: () => Promise.resolve({ usageCost: null, eventProcessed: 'PENDING' }),
    },
    signal_services: { upsert: () => Promise.resolve({}) },
    $transaction: (cb: any) => cb(prisma),
  };
  return { prisma, childUpdate };
}

async function buildService(prisma: any): Promise<SignalEventsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SignalEventsService,
      ModelPricingService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  module.useLogger(false);
  return module.get<SignalEventsService>(SignalEventsService);
}

describe('SignalEventsService.fillVolume — cache spend survives the fill', () => {
  it('prices the cache tokens the child was already carrying', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: FULLY_PRICED_ROW,
      children: [child()],
    });
    const svc = await buildService(prisma);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 2000,
    } as any);

    // 0.005 + 0.05 + 0.653026 + 0.26907 = 0.977096
    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    expect(written.toFixed(6)).toBe('0.977096');
    expect(childUpdate.mock.calls[0][0].data.eventStatus).toBe('PROCESSED');
    expect(result.childrenUpdated).toBe(1);
    expect(result.refused).toBe(0);
    // The wrong answer: the prompt spend alone.
    expect(written.toFixed(6)).not.toBe('0.055000');
  });

  it('emits the cache lines in the cost-by-service breakdown', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: FULLY_PRICED_ROW,
      children: [child()],
    });
    const svc = await buildService(prisma);

    await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 2000,
    } as any);

    const data = childUpdate.mock.calls[0][0].data.usageCostData;
    expect(data['claude-opus-5/cache_read'].units).toBe(CACHE_READ_TOKENS);
    expect(data['claude-opus-5/cache_read'].cost).toBeCloseTo(0.653026, 9);
    expect(data['claude-opus-5/cache_write'].units).toBe(CACHE_WRITE_TOKENS);
    expect(data['claude-opus-5/cache_write'].cost).toBeCloseTo(0.26907, 9);
  });

  it('re-bases a 5m cache write through the same TTL rule as ingest', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: FULLY_PRICED_ROW,
      children: [child({ cacheReadTokens: 0, metadata: { cacheWriteTtl: '5m' } })],
    });
    const svc = await buildService(prisma);

    await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 0,
      outputTokens: 0,
    } as any);

    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    // 5m writes bill at 1.25x input ($6.25/1M), not the stored 2x ceiling.
    expect(written.toFixed(9)).toBe(
      new Decimal(CACHE_WRITE_TOKENS).mul(6.25).div(1_000_000).toFixed(9),
    );
  });

  it('TWIN: a missing cache rate leaves the child unresolved, never filled at $0', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: NULL_CACHE_WRITE_ROW,
      children: [child()],
    });
    const svc = await buildService(prisma);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 2000,
    } as any);

    expect(childUpdate).not.toHaveBeenCalled();
    expect(result.childrenUpdated).toBe(0);
    expect(result.refused).toBe(1);
    expect(result.refusedRates).toEqual(['cacheWriteCost']);
  });

  it('PRICED ZERO: a genuinely free cache write still fills', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: PRICED_ZERO_WRITE_ROW,
      children: [child()],
    });
    const svc = await buildService(prisma);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 2000,
    } as any);

    expect(result.refused).toBe(0);
    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    expect(written.toFixed(6)).toBe('0.708026');
    expect(childUpdate.mock.calls[0][0].data.usageCostData['claude-opus-5/cache_write'].cost).toBe(
      0,
    );
  });

  it('NON-TOKEN ROW: the cache guard does not change the fill', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: NON_TOKEN_ROW,
      children: [child({ model: 'anthropic-web-search' })],
    });
    const svc = await buildService(prisma);

    const result = await svc.fillVolume(ORG, {
      sourceModel: 'anthropic-web-search',
      sourceProvider: 'anthropic',
      quantity: 250,
    } as any);

    expect(result.refused).toBe(0);
    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    // 250 requests x $10 per 1K = $2.50. Cache is inert in this branch.
    expect(written.toFixed(6)).toBe('2.500000');
    expect(childUpdate.mock.calls[0][0].data.eventStatus).toBe('PROCESSED');
  });

  it('NEGATIVE CONTROL: a child with no cache tokens keeps the input/output-only shape', async () => {
    const { prisma, childUpdate } = buildMocks({
      row: FULLY_PRICED_ROW,
      children: [child({ cacheReadTokens: null, cacheWriteTokens: null })],
    });
    const svc = await buildService(prisma);

    await svc.fillVolume(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 2000,
    } as any);

    const update = childUpdate.mock.calls[0][0].data;
    expect((update.usageCost as Decimal).toFixed(6)).toBe('0.055000');
    expect(Object.keys(update.usageCostData)).toEqual([
      'claude-opus-5/input',
      'claude-opus-5/output',
    ]);
  });
});

/**
 * The same rule holds one method up, on the api-nest `mapModel` door
 * (POST /events/map-model). Selecting no cache tokens and pricing through the
 * no-cache wrapper would drop a cache-bearing child's cache spend on a REST
 * remap and stamp it PROCESSED, while the dashboard twin of the same screen
 * refuses. Cache-bearing children can sit in the
 * NEEDS_COST_BACKFILL queue.
 */
describe('SignalEventsService.mapModel — cache spend survives the remap', () => {
  function mapMocks(opts: { row: Record<string, unknown>; children: unknown[] }) {
    const childUpdate = jest.fn();
    const prisma: any = {
      service_pricing: {
        findUnique: () => Promise.resolve(opts.row),
        findFirst: () => Promise.resolve(opts.row),
      },
      org_model_mappings: { upsert: () => Promise.resolve({ id: 'mapping-uuid' }) },
      signal_event_services: {
        findMany: (args: any) => {
          if (args.where?.signalEventId && !args.where?.eventStatus) {
            return Promise.resolve([{ usageCost: new Decimal(1), eventStatus: 'PROCESSED' }]);
          }
          return Promise.resolve(opts.children);
        },
        update: (args: any) => {
          childUpdate(args);
          return Promise.resolve(args.data);
        },
      },
      signal_events: {
        update: () => Promise.resolve({}),
        findUnique: () => Promise.resolve({ usageCost: null, eventProcessed: 'PENDING' }),
      },
      signal_services: { upsert: () => Promise.resolve({}) },
      $transaction: (cb: any) => cb(prisma),
    };
    return { prisma, childUpdate };
  }

  function backfillChild(overrides: ChildOverrides = {}) {
    return {
      ...child(overrides),
      inputTokens: 1000,
      outputTokens: 2000,
      quantity: null,
    };
  }

  it('prices the cache tokens the child was already carrying', async () => {
    const { prisma, childUpdate } = mapMocks({
      row: FULLY_PRICED_ROW,
      children: [backfillChild()],
    });
    const svc = await buildService(prisma);

    const result = await svc.mapModel(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      targetPricingId: 'pricing-uuid',
    } as any);

    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    expect(written.toFixed(6)).toBe('0.977096');
    expect(result.refused).toBe(0);
    expect(result.childrenUpdated).toBe(1);
    // The wrong answer.
    expect(written.toFixed(6)).not.toBe('0.055000');
  });

  it('TWIN: a missing cache rate leaves the child unresolved', async () => {
    const { prisma, childUpdate } = mapMocks({
      row: NULL_CACHE_WRITE_ROW,
      children: [backfillChild()],
    });
    const svc = await buildService(prisma);

    const result = await svc.mapModel(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      targetPricingId: 'pricing-uuid',
    } as any);

    expect(childUpdate).not.toHaveBeenCalled();
    expect(result.refused).toBe(1);
    expect(result.refusedRates).toEqual(['cacheWriteCost']);
    expect(result.childrenUpdated).toBe(0);
  });

  it('NON-TOKEN ROW: remapping onto a "1K requests" row still prices', async () => {
    const { prisma, childUpdate } = mapMocks({
      row: NON_TOKEN_ROW,
      children: [{ ...backfillChild({ model: 'anthropic-web-search' }), quantity: 250 }],
    });
    const svc = await buildService(prisma);

    const result = await svc.mapModel(ORG, {
      sourceModel: 'anthropic-web-search',
      sourceProvider: 'anthropic',
      targetPricingId: 'pricing-web-search',
    } as any);

    expect(result.refused).toBe(0);
    const written = childUpdate.mock.calls[0][0].data.usageCost as Decimal;
    expect(written.toFixed(6)).toBe('2.500000');
  });

  it('NEGATIVE CONTROL: a child with no cache tokens keeps the input/output-only shape', async () => {
    const { prisma, childUpdate } = mapMocks({
      row: FULLY_PRICED_ROW,
      children: [backfillChild({ cacheReadTokens: null, cacheWriteTokens: null })],
    });
    const svc = await buildService(prisma);

    await svc.mapModel(ORG, {
      sourceModel: 'claude-opus-5',
      sourceProvider: 'anthropic',
      targetPricingId: 'pricing-uuid',
    } as any);

    const update = childUpdate.mock.calls[0][0].data;
    expect((update.usageCost as Decimal).toFixed(6)).toBe('0.055000');
    expect(Object.keys(update.usageCostData)).toEqual([
      'claude-opus-5/input',
      'claude-opus-5/output',
    ]);
  });
});
