/**
 * WHAT THIS FILE DOES: proves the api-nest model-remap door prices prompt-cache
 *   exactly like the other two doors — SDK ingest and the dashboard's
 *   `mapModelAndBackfill`. An admin repairing an unpriced model must get the
 *   same dollars whichever door they walk through.
 *
 * WHY IT CANNOT PASS BY ACCIDENT: the pricing row and the child token counts
 *   below are a frozen synthetic event shaped like a real cache-heavy Claude
 *   Code turn. The expected usageCostData is worked out by hand from the
 *   published per-token rates, not a number this test computed by calling the
 *   code under test. Every cache assertion fails if the service omits the
 *   cache columns from its select, strips the cache rates off the pre-fetched
 *   entry, passes no cache token counts, or skips applyCacheWriteTtl.
 *
 * WHAT IS REAL HERE: the service under test, `ModelPricingService`, and the
 *   canonical `calculateEventCost` / `applyCacheWriteTtl` in @marginfront/db are
 *   all the real artifacts. Only Prisma is a fake — it is the data store, not
 *   the thing under test.
 *
 * TWIN: apps/dashboard/app/actions/__tests__/signal-events-map-model-parity.test.ts
 *   runs the dashboard door against this same frozen event. The two files
 *   deliberately keep independent copies of the golden so neither can satisfy
 *   itself; if they ever disagree, the doors have diverged.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { SignalEventsService } from './signal-events.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const SIGNAL_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '44444444-4444-4444-8444-444444444444';
const PRICING_ID = '55555555-5555-4555-8555-555555555555';

// ─── Frozen synthetic event ──────────────────────────────────────────────
// service_pricing row for claude-opus-5/anthropic at its published rates.
// cacheWriteCost is 2× inputCost — the 1-hour TTL ceiling the sync script
// stores so an unknown TTL can never under-bill.
const OPUS_PRICING = {
  id: PRICING_ID,
  canonicalName: 'claude-opus-5',
  provider: 'anthropic',
  inputCost: new Decimal('5.0000000000'),
  outputCost: new Decimal('25.0000000000'),
  cacheReadCost: new Decimal('0.5000000000'),
  cacheWriteCost: new Decimal('10.0000000000'),
  costUnit: '1M tokens',
};

// signal_event_services child. A cache-heavy Claude Code turn (synthetic):
// 5,240 fresh input tokens against 1,900,000 cache-write and 45,001
// cache-read tokens — 98% of the bill is cache.
const SAMPLE_CHILD_TOKENS = {
  inputTokens: 5240,
  outputTokens: 11760,
  quantity: null as Decimal | null,
  cacheReadTokens: 45001,
  cacheWriteTokens: 1900000,
};

// What the SDK ingest door stores for that row: tokens × rate, line by line.
const EXPECTED_USAGE_COST_DATA = {
  'claude-opus-5/input': {
    cost: 0.0262,
    units: 5240,
    costPerUnit: 0.000005,
  },
  'claude-opus-5/output': {
    cost: 0.294,
    units: 11760,
    costPerUnit: 0.000025,
  },
  'claude-opus-5/cache_read': {
    cost: 0.0225005,
    units: 45001,
    costPerUnit: 0.0000005,
  },
  'claude-opus-5/cache_write': {
    cost: 19,
    units: 1900000,
    costPerUnit: 0.00001,
  },
};

// 0.0262 + 0.294 + 0.0225005 + 19 = 19.3427005, and usageCost is
// numeric(18,6), so the stored value rounds half-up to 19.342701.
const EXPECTED_USAGE_COST_EXACT = '19.3427005';
const EXPECTED_USAGE_COST_AS_STORED = '19.342701';

interface ChildSeed {
  id: string;
  signalEventId: string;
  model: string;
  modelProvider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  quantity: Decimal | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

function buildHarness(opts: {
  children: ChildSeed[];
  pricing?: typeof OPUS_PRICING;
  /** Parent signal_events.metadata — carries the cacheWriteTtl hint. */
  parentMetadata?: Record<string, unknown> | null;
}) {
  const pricing = opts.pricing ?? OPUS_PRICING;
  const writes: { id: string; data: any }[] = [];
  const parentWrites: { id: string; data: any }[] = [];

  const prisma: any = {
    service_pricing: {
      findUnique: async () => pricing,
      findFirst: async () => pricing,
    },
    org_model_mappings: {
      upsert: async () => ({ id: 'mapping-id' }),
    },
    signal_event_services: {
      findMany: async (args: any) => {
        // recomputeParentUsageCost re-reads a single parent's children.
        if (args.where?.signalEventId && !args.where?.eventStatus) {
          return opts.children
            .filter((c) => c.signalEventId === args.where.signalEventId)
            .map((c) => {
              const w = writes.find((x) => x.id === c.id);
              return {
                usageCost: w ? w.data.usageCost : null,
                eventStatus: w ? w.data.eventStatus : 'NEEDS_COST_BACKFILL',
              };
            });
        }
        return opts.children.map((c) => ({
          ...c,
          signal_events: {
            signalId: SIGNAL_ID,
            metadata: opts.parentMetadata ?? null,
          },
        }));
      },
      update: async (args: any) => {
        writes.push({ id: args.where.id, data: args.data });
        return args.data;
      },
    },
    signal_events: {
      update: async (args: any) => {
        parentWrites.push({ id: args.where.id, data: args.data });
        return args.data;
      },
      findUnique: async () => ({ usageCost: null, eventProcessed: 'PENDING' }),
    },
    signal_services: { upsert: async () => ({}) },
    $transaction: async (cb: any) => cb(prisma),
  };

  // The REAL pricing service over the REAL canonical math — only its Prisma
  // dependency is the fake, and mapModel always hands it a pre-fetched entry
  // so it never reaches the DB anyway.
  const modelPricing = new ModelPricingService(prisma as PrismaService);
  const service = new SignalEventsService(prisma as PrismaService, modelPricing);

  return { service, writes, parentWrites };
}

const cacheHeavyChild: ChildSeed = {
  id: CHILD_ID,
  signalEventId: PARENT_ID,
  model: 'claude-opus-5',
  modelProvider: 'anthropic',
  ...SAMPLE_CHILD_TOKENS,
};

async function remap(harness: ReturnType<typeof buildHarness>) {
  return harness.service.mapModel(ORG, {
    sourceModel: 'claude-opus-5',
    sourceProvider: 'anthropic',
    targetPricingId: PRICING_ID,
  });
}

// ─── Parity: the api-nest door reproduces the ingest door's dollars ──────

describe('mapModel cache parity — cache-heavy Claude Code event', () => {
  it('reproduces the hand-worked usageCost for that event', async () => {
    const harness = buildHarness({ children: [cacheHeavyChild] });
    await remap(harness);

    expect(harness.writes).toHaveLength(1);
    const usageCost = harness.writes[0].data.usageCost as Decimal;
    expect(usageCost.toString()).toBe(EXPECTED_USAGE_COST_EXACT);
    expect(usageCost.toFixed(6)).toBe(EXPECTED_USAGE_COST_AS_STORED);
  });

  it('reproduces the hand-worked usageCostData for that event', async () => {
    const harness = buildHarness({ children: [cacheHeavyChild] });
    await remap(harness);

    expect(harness.writes[0].data.usageCostData).toEqual(EXPECTED_USAGE_COST_DATA);
  });

  it('emits the four cost lines in the canonical key set', async () => {
    const harness = buildHarness({ children: [cacheHeavyChild] });
    await remap(harness);

    expect(Object.keys(harness.writes[0].data.usageCostData).sort()).toEqual([
      'claude-opus-5/cache_read',
      'claude-opus-5/cache_write',
      'claude-opus-5/input',
      'claude-opus-5/output',
    ]);
  });

  it('rolls the cache-inclusive total up to the parent', async () => {
    const harness = buildHarness({ children: [cacheHeavyChild] });
    await remap(harness);

    expect(harness.parentWrites).toHaveLength(1);
    expect(harness.parentWrites[0].data.eventProcessed).toBe('PROCESSED');
    expect((harness.parentWrites[0].data.usageCost as Decimal).toFixed(6)).toBe(
      EXPECTED_USAGE_COST_AS_STORED,
    );
  });

  it('does not silently drop the cache majority of the bill', async () => {
    // The wrong answer: input + output only. Stated as its own assertion so
    // the failure is legible if it ever happens.
    const harness = buildHarness({ children: [cacheHeavyChild] });
    await remap(harness);

    const inputPlusOutput = 0.0262 + 0.294;
    const total = (harness.writes[0].data.usageCost as Decimal).toNumber();
    expect(total).toBeGreaterThan(inputPlusOutput * 60);
  });
});

// ─── Cache-write TTL ─────────────────────────────────────────

describe('mapModel re-derives the cache-write rate from the stored TTL hint', () => {
  it('prices a 5m Anthropic cache write at 1.25x input, not the 2x ceiling', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      parentMetadata: { cacheWriteTtl: '5m' },
    });
    await remap(harness);

    const line = harness.writes[0].data.usageCostData['claude-opus-5/cache_write'];
    // 1.25 × $5.00 per 1M = $6.25 per 1M = 0.00000625 per token.
    expect(line.costPerUnit).toBeCloseTo(0.00000625, 12);
    expect(line.cost).toBeCloseTo(1900000 * 0.00000625, 8);
    // Strictly cheaper than the 1h ceiling the row stores.
    expect(line.cost).toBeLessThan(EXPECTED_USAGE_COST_DATA['claude-opus-5/cache_write'].cost);
  });

  it('NEGATIVE CONTROL: a 1h hint keeps the stored 2x ceiling', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      parentMetadata: { cacheWriteTtl: '1h' },
    });
    await remap(harness);

    expect(harness.writes[0].data.usageCostData).toEqual(EXPECTED_USAGE_COST_DATA);
  });

  it('NEGATIVE CONTROL: an unrecognised hint keeps the stored 2x ceiling', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      parentMetadata: { cacheWriteTtl: 'ten minutes' },
    });
    await remap(harness);

    expect(harness.writes[0].data.usageCostData).toEqual(EXPECTED_USAGE_COST_DATA);
  });

  it('NEGATIVE CONTROL: a 5m hint on a non-Anthropic row keeps the stored rate', async () => {
    const openaiPricing = {
      ...OPUS_PRICING,
      canonicalName: 'gpt-5.6',
      provider: 'openai',
      inputCost: new Decimal('5.0000000000'),
      // Deliberately NOT 1.25× input: if the Anthropic-only derivation leaked
      // it would price this at 0.00000625/token instead of the feed's rate.
      cacheWriteCost: new Decimal('1.0000000000'),
    };
    const harness = buildHarness({
      children: [
        {
          ...cacheHeavyChild,
          model: 'gpt-5.6',
          modelProvider: 'openai',
        },
      ],
      pricing: openaiPricing,
      parentMetadata: { cacheWriteTtl: '5m' },
    });
    await harness.service.mapModel(ORG, {
      sourceModel: 'gpt-5.6',
      sourceProvider: 'openai',
      targetPricingId: PRICING_ID,
    });

    // The feed rate stands: $1.00 per 1M. If the Anthropic 5m derivation
    // leaked to OpenAI this would read 0.00000625 instead.
    const line = harness.writes[0].data.usageCostData['gpt-5.6/cache_write'];
    expect(line.costPerUnit).toBeCloseTo(0.000001, 12);
    expect(line.costPerUnit).not.toBeCloseTo(0.00000625, 12);
  });

  it('NEGATIVE CONTROL: a 5m hint cannot invent a rate on a row with none', async () => {
    // `costPerUnit === 0 && cost === 0` would accept the fabricated $0.00
    // line this guard exists to kill. A 5m hint cannot invent a rate, and the
    // correct answer is a refusal, not a zero: 1,900,000 unpriced cache-write tokens is a 98.2% under-bill.
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: { ...OPUS_PRICING, cacheWriteCost: null as unknown as Decimal },
      parentMetadata: { cacheWriteTtl: '5m' },
    });
    const result = await remap(harness);

    expect(harness.writes).toHaveLength(0);
    expect(result.refused).toBe(1);
    expect(result.refusedRates).toEqual(['cacheWriteCost']);
  });
});

// ─── The guard: a missing cache rate refuses, it does not fabricate $0 ───
//
// Both doors must refuse the same event the same way. The dashboard twin runs
// the identical cases against mapModelAndBackfill.

describe('mapModel refuses rather than under-bill when a cache rate is missing', () => {
  const noCacheWriteRate = {
    ...OPUS_PRICING,
    cacheWriteCost: null as unknown as Decimal,
  };

  it('writes NOTHING for the refused child — no cost, no PROCESSED stamp', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: noCacheWriteRate,
    });
    await remap(harness);

    expect(harness.writes).toHaveLength(0);
    expect(harness.parentWrites).toHaveLength(0);
  });

  it('emits NO fabricated $0.00 cache_write line anywhere', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: noCacheWriteRate,
    });
    await remap(harness);

    const everyLine = harness.writes.flatMap((w) =>
      Object.entries(w.data.usageCostData as Record<string, { costPerUnit: number }>),
    );
    expect(everyLine.filter(([key]) => key.endsWith('/cache_write'))).toEqual([]);
  });

  it('reports the refusal on the result, and counts it as NOT backfilled', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: noCacheWriteRate,
    });
    const result = await remap(harness);

    expect(result.refused).toBe(1);
    expect(result.refusedRates).toEqual(['cacheWriteCost']);
    expect(result.childrenUpdated).toBe(0);
    expect(result.backfilled).toBe(0);
  });

  it('names BOTH directions when the row prices neither', async () => {
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: {
        ...OPUS_PRICING,
        cacheReadCost: null as unknown as Decimal,
        cacheWriteCost: null as unknown as Decimal,
      },
    });
    const result = await remap(harness);

    expect(result.refusedRates).toEqual(['cacheReadCost', 'cacheWriteCost']);
  });

  it('refuses ONLY the cache-bearing child; a clean sibling still prices', async () => {
    // The mixed batch: one child prices, one refuses, and a caller reading only
    // `backfilled` would see an unqualified success.
    const harness = buildHarness({
      children: [
        cacheHeavyChild,
        {
          id: 'sibling',
          signalEventId: PARENT_ID,
          model: 'claude-opus-5',
          modelProvider: 'anthropic',
          inputTokens: 5240,
          outputTokens: 11760,
          quantity: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      ],
      pricing: noCacheWriteRate,
    });
    const result = await remap(harness);

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].id).toBe('sibling');
    expect(result.childrenUpdated).toBe(1);
    expect(result.refused).toBe(1);
  });

  it('PRICED-ZERO TWIN: a genuine $0.00 cache rate prices and is NOT refused', async () => {
    // The distinction the whole guard rests on. NULL means "no rate published"
    // and must refuse; 0 is a real, free rate and must price.
    const freeCacheWrite = {
      ...OPUS_PRICING,
      cacheWriteCost: new Decimal('0'),
    };
    const harness = buildHarness({
      children: [cacheHeavyChild],
      pricing: freeCacheWrite,
    });
    const result = await remap(harness);

    expect(result.refused).toBe(0);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].data.usageCostData['claude-opus-5/cache_write']).toEqual({
      cost: 0,
      units: 1900000,
      costPerUnit: 0,
    });
    // input + output + cache_read, with cache_write genuinely free.
    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.3427005');
  });

  it('NEGATIVE CONTROL: a NULL cache rate the event never used does not refuse', async () => {
    // Most active "1M tokens" catalog rows carry no cacheWriteCost. A
    // guard that fired on the NULL alone would refuse almost every mapping.
    const harness = buildHarness({
      children: [
        {
          id: CHILD_ID,
          signalEventId: PARENT_ID,
          model: 'claude-opus-5',
          modelProvider: 'anthropic',
          inputTokens: 5240,
          outputTokens: 11760,
          quantity: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      ],
      pricing: noCacheWriteRate,
    });
    const result = await remap(harness);

    expect(result.refused).toBe(0);
    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.3202');
  });

  it('NEGATIVE CONTROL: a non-token cost unit never refuses on a NULL cache rate', async () => {
    // Only the "1M tokens" branch prices cache at all; the 1K branch returns a
    // hard 0 whatever counts it is handed, so its total is already correct.
    const harness = buildHarness({
      children: [
        {
          id: CHILD_ID,
          signalEventId: PARENT_ID,
          model: 'WebSearch',
          modelProvider: 'tool',
          inputTokens: null,
          outputTokens: null,
          quantity: new Decimal(88),
          cacheReadTokens: 45001,
          cacheWriteTokens: 1900000,
        },
      ],
      pricing: {
        ...OPUS_PRICING,
        canonicalName: 'websearch',
        provider: 'tool',
        inputCost: new Decimal('10.0000000000'),
        outputCost: new Decimal('0'),
        cacheReadCost: null as unknown as Decimal,
        cacheWriteCost: null as unknown as Decimal,
        costUnit: '1K calls',
      },
    });
    const result = await harness.service.mapModel(ORG, {
      sourceModel: 'websearch',
      sourceProvider: 'tool',
      targetPricingId: PRICING_ID,
    });

    expect(result.refused).toBe(0);
    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.88');
  });
});

// ─── Non-cache paths price without cache lines ───────────────────────────

describe('mapModel leaves non-cache backfills byte-identical', () => {
  const nonCacheChild: ChildSeed = {
    id: CHILD_ID,
    signalEventId: PARENT_ID,
    model: 'claude-opus-5',
    modelProvider: 'anthropic',
    inputTokens: 5240,
    outputTokens: 11760,
    quantity: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };

  it('NEGATIVE CONTROL: NULL cache columns produce NO cache lines', async () => {
    const harness = buildHarness({ children: [nonCacheChild] });
    await remap(harness);

    expect(harness.writes[0].data.usageCostData).toEqual({
      'claude-opus-5/input': {
        cost: 0.0262,
        units: 5240,
        costPerUnit: 0.000005,
      },
      'claude-opus-5/output': {
        cost: 0.294,
        units: 11760,
        costPerUnit: 0.000025,
      },
    });
  });

  it('NEGATIVE CONTROL: a NULL-cache child costs what it costed before', async () => {
    const harness = buildHarness({ children: [nonCacheChild] });
    await remap(harness);

    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.3202');
  });

  it('a stored ZERO cache count is a real count and earns its line', async () => {
    // Codex sends cache_read=0 on an uncached turn. NULL means "never sent";
    // 0 means "sent, and it was zero" — the two must not collapse.
    const harness = buildHarness({
      children: [{ ...nonCacheChild, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    });
    await remap(harness);

    const data = harness.writes[0].data.usageCostData;
    expect(data['claude-opus-5/cache_read']).toEqual({
      cost: 0,
      units: 0,
      costPerUnit: 0.0000005,
    });
    expect(data['claude-opus-5/cache_write']).toEqual({
      cost: 0,
      units: 0,
      costPerUnit: 0.00001,
    });
    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.3202');
  });

  it('a non-LLM child still routes through the flat/per-1K branches untouched', async () => {
    // WebSearch: $10 per 1K calls. The 1K branch reads quantity only — cache
    // is an LLM concept and must contribute nothing. 88 calls = $0.88, and
    // the wrong branch here would bill $880.
    const webSearchPricing = {
      ...OPUS_PRICING,
      canonicalName: 'websearch',
      provider: 'tool',
      inputCost: new Decimal('10.0000000000'),
      outputCost: new Decimal('0'),
      cacheReadCost: null as unknown as Decimal,
      cacheWriteCost: null as unknown as Decimal,
      costUnit: '1K calls',
    };
    const harness = buildHarness({
      children: [
        {
          id: CHILD_ID,
          signalEventId: PARENT_ID,
          model: 'WebSearch',
          modelProvider: 'tool',
          inputTokens: null,
          outputTokens: null,
          quantity: new Decimal(88),
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      ],
      pricing: webSearchPricing,
    });
    await harness.service.mapModel(ORG, {
      sourceModel: 'websearch',
      sourceProvider: 'tool',
      targetPricingId: PRICING_ID,
    });

    expect((harness.writes[0].data.usageCost as Decimal).toString()).toBe('0.88');
    expect(Object.keys(harness.writes[0].data.usageCostData)).toEqual([
      'WebSearch/input',
      'WebSearch/output',
    ]);
  });

  it('pins the ONE field where the two doors still disagree: null token units', async () => {
    // api-nest writes `units: null` for an absent token count, matching the SDK
    // ingest door; the dashboard twin coerces the same field to 0. The dollars
    // are identical either way — only this display field differs. Pinned so a
    // change to stored JSON on a money table is deliberate.
    const harness = buildHarness({
      children: [
        {
          id: CHILD_ID,
          signalEventId: PARENT_ID,
          model: 'claude-opus-5',
          modelProvider: 'anthropic',
          inputTokens: null,
          outputTokens: null,
          quantity: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      ],
    });
    await remap(harness);

    expect(harness.writes[0].data.usageCostData['claude-opus-5/input'].units).toBeNull();
  });
});
