import { Test, TestingModule } from '@nestjs/testing';
import { isCostRefused, ModelPricingService } from './model-pricing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('ModelPricingService', () => {
  let service: ModelPricingService;
  let prisma: PrismaService;

  // LLM row: $3.00 per 1M input tokens, $15.00 per 1M output tokens
  const mockLlmEntry = {
    id: 'test-id',
    externalId: 'anthropic/claude-sonnet-4-6',
    canonicalName: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    serviceType: 'LLM',
    inputCost: new Decimal(3.0),
    outputCost: new Decimal(15.0),
    costUnit: '1M tokens',
    contextWindow: 200000,
    source: 'openrouter',
    isApi: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Per-1K-unit row: $1.50 per 1K pages (AWS Textract-style)
  const mockPer1KEntry = {
    ...mockLlmEntry,
    externalId: 'api/aws-textract',
    canonicalName: 'aws-textract',
    displayName: 'AWS Textract',
    provider: 'aws',
    serviceType: 'Document AI',
    inputCost: new Decimal(1.5),
    outputCost: null,
    costUnit: '1K pages',
    contextWindow: null,
    isApi: true,
  };

  // Flat per-unit row: $0.04 per image
  const mockFlatEntry = {
    ...mockLlmEntry,
    externalId: 'openai/dall-e-3',
    canonicalName: 'dall-e-3',
    displayName: 'DALL·E 3',
    provider: 'openai',
    serviceType: 'Image Generation',
    inputCost: new Decimal(0.04),
    outputCost: null,
    costUnit: 'image',
    contextWindow: null,
    isApi: true,
  };

  // Per-1M-unit row: $2.00 per 1M read units (Pinecone Serverless-style).
  // A naive implementation falls through to the flat branch and bills
  // 1,000,000× too high.
  const mockPer1MEntry = {
    ...mockLlmEntry,
    externalId: 'api/pinecone',
    canonicalName: 'pinecone',
    displayName: 'Pinecone Serverless',
    provider: 'pinecone',
    serviceType: 'Vector DB',
    inputCost: new Decimal(2.0),
    outputCost: null,
    costUnit: '1M read units',
    contextWindow: null,
    isApi: true,
  };

  // resolveCost is the cache-aware entry point: it returns a
  // guarded union so a missing cache rate cannot be read as $0. These tests
  // assert on priced outcomes, so unwrap here and fail loudly on any refusal
  // the test did not intend. Refusal behaviour itself is asserted separately.
  const priceWithCache = async (...args: Parameters<ModelPricingService['resolveCost']>) => {
    const r = await service.resolveCost(...args);
    if (isCostRefused(r)) throw new Error(`unexpected price refusal: ${r.reason}`);
    return r.cost;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelPricingService,
        {
          provide: PrismaService,
          useValue: {
            service_pricing: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ModelPricingService>(ModelPricingService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should calculate cost correctly for known LLM model', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

    const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 1, 'anthropic');

    // input: 1000 tokens * ($3.00 / 1,000,000) = $0.003
    // output: 500 tokens * ($15.00 / 1,000,000) = $0.0075
    // total: $0.0105
    expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.0105, 6);
    expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.003, 6);
    expect(result.outputCostUsd.toNumber()).toBeCloseTo(0.0075, 6);
    expect(result.modelKey).toBe('claude-sonnet-4-6');
  });

  it('should throw for unrecognized model', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.calculateCost('nonexistent-model', 1000, 500, 1, 'openai'),
    ).rejects.toThrow('Model not recognized: nonexistent-model');
  });

  it('should handle zero tokens on an LLM model', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

    const result = await service.calculateCost('claude-sonnet-4-6', 0, 0, 1, 'anthropic');

    expect(result.totalCostUsd.toNumber()).toBe(0);
    expect(result.inputCostUsd.toNumber()).toBe(0);
    expect(result.outputCostUsd.toNumber()).toBe(0);
  });

  it('should handle null costs in service_pricing (defaults to 0)', async () => {
    const entryWithNullCosts = {
      ...mockLlmEntry,
      inputCost: null,
      outputCost: null,
    };
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(entryWithNullCosts);

    const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 1, 'anthropic');

    expect(result.totalCostUsd.toNumber()).toBe(0);
    expect(result.inputCostPerToken).toBe(0);
    expect(result.outputCostPerToken).toBe(0);
  });

  it('should return null from lookupModel for missing model', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.lookupModel('nonexistent', 'openai');
    expect(result).toBeNull();
  });

  it('should handle high-precision decimal math', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

    // Large token counts — should not lose precision
    const result = await service.calculateCost('claude-sonnet-4-6', 100000, 50000, 1, 'anthropic');

    // input: 100000 * 0.000003 = 0.3
    // output: 50000 * 0.000015 = 0.75
    // total: 1.05
    expect(result.totalCostUsd.toNumber()).toBeCloseTo(1.05, 4);
  });

  it('should ignore quantity for LLM models (token math only)', async () => {
    // On LLM rows quantity is metadata only (packages/db/CANON.md rule V3):
    // cost is token math.
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

    const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 12, 'anthropic');

    // Should match the quantity=1 result exactly.
    expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.0105, 6);
  });

  it('should calculate cost for per-1K-unit services (AWS Textract $1.50 / 1K pages)', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockPer1KEntry);

    // 10 pages × $1.50 / 1000 = $0.015
    const result = await service.calculateCost('aws-textract', 0, 0, 10, 'aws');

    expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.015, 6);
    expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.015, 6);
    expect(result.outputCostUsd.toNumber()).toBe(0);
    expect(result.inputCostPerToken).toBe(0);
    expect(result.outputCostPerToken).toBe(0);
  });

  it('should scale per-1K cost with quantity', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockPer1KEntry);

    // 5000 pages × $1.50 / 1000 = $7.50
    const result = await service.calculateCost('aws-textract', 0, 0, 5000, 'aws');

    expect(result.totalCostUsd.toNumber()).toBeCloseTo(7.5, 6);
  });

  it('should calculate cost for flat per-unit services (DALL·E 3 $0.04 / image)', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockFlatEntry);

    // 5 images × $0.04 = $0.20
    const result = await service.calculateCost('dall-e-3', 0, 0, 5, 'openai');

    expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.2, 6);
    expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.2, 6);
    expect(result.outputCostUsd.toNumber()).toBe(0);
  });

  // ============================================================
  // Per-1M-unit cost math ("1M <non-token>" units)
  //
  // These three unit shapes ("1M read units", "1M requests", "1M characters")
  // start with "1M " but are NOT "1M tokens". They must not fall past the
  // token branch AND the "1K " branch into the flat fallback (quantity × cost,
  // no division), which would bill 1,000,000× too high. Each test asserts
  // quantity × inputCost ÷ 1,000,000.
  // ============================================================
  describe('per-1M-unit cost math', () => {
    it('prices "1M read units" (Pinecone $2.00 / 1M) — the headline worked example', async () => {
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockPer1MEntry);

      // 5,000,000 reads × $2.00 ÷ 1,000,000 = $10.00 (NOT $10,000,000).
      const result = await service.calculateCost('pinecone', 0, 0, 5_000_000, 'pinecone');

      expect(result.totalCostUsd.toNumber()).toBeCloseTo(10.0, 6);
      expect(result.inputCostUsd.toNumber()).toBeCloseTo(10.0, 6);
      expect(result.outputCostUsd.toNumber()).toBe(0);
      expect(result.inputCostPerToken).toBe(0);
      expect(result.outputCostPerToken).toBe(0);
    });

    it('never falls back to flat math for per-1M units (flat would charge $10,000,000)', async () => {
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockPer1MEntry);

      const result = await service.calculateCost('pinecone', 0, 0, 5_000_000, 'pinecone');

      // Flat math would be quantity × inputCost = 5,000,000 × $2 = $10,000,000.
      expect(result.totalCostUsd.toNumber()).not.toBeCloseTo(10_000_000, 0);
      expect(result.totalCostUsd.toNumber()).toBeLessThan(11);
    });

    it('prices "1M requests" (Cloud Run $0.40 / 1M requests)', async () => {
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue({
        ...mockPer1MEntry,
        canonicalName: 'cloud-run-request',
        provider: 'google',
        inputCost: new Decimal(0.4),
        costUnit: '1M requests',
      });

      // 2,000,000 requests × $0.40 ÷ 1,000,000 = $0.80
      const result = await service.calculateCost('cloud-run-request', 0, 0, 2_000_000, 'google');

      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.8, 6);
      expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.8, 6);
      expect(result.outputCostUsd.toNumber()).toBe(0);
    });

    it('prices "1M characters" and survives the sync\'s multiply-then-divide round-trip', async () => {
      // The pricing sync stores these rows as inputCost = per_char × 1,000,000
      // (packages/db/scripts/sync-service-pricing.ts). So a $0.000016/char TTS model is stored
      // as inputCost = $16.00 with costUnit "1M characters". The engine then
      // divides by 1,000,000 — the two operations must cancel exactly, leaving
      // the real per-character price. This guards that round-trip end to end.
      const perCharPrice = 0.000016;
      const storedInputCost = perCharPrice * 1_000_000; // = 16.0, what the sync writes
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue({
        ...mockPer1MEntry,
        canonicalName: 'premium-tts',
        provider: 'elevenlabs',
        inputCost: new Decimal(storedInputCost),
        costUnit: '1M characters',
      });

      const characters = 500_000;
      const result = await service.calculateCost('premium-tts', 0, 0, characters, 'elevenlabs');

      // 500,000 chars × $16.00 ÷ 1,000,000 = $8.00
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(8.0, 6);
      // …and that $8.00 IS the real per-char price × character count.
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(perCharPrice * characters, 6);
      expect(result.outputCostUsd.toNumber()).toBe(0);
    });

    it('does NOT divert "1M tokens" into the per-1M-unit branch (LLM math still wins)', async () => {
      // Ordering guard: "1M tokens" is matched by === before the startsWith("1M ")
      // check, so an LLM row must still get per-direction token math, not the
      // flat-style quantity × cost ÷ 1M. If anyone reorders the branches this fails.
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

      const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 1, 'anthropic');

      // Token math: 1000 × $3/1M + 500 × $15/1M = $0.0105 (quantity ignored).
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.0105, 6);
      expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.003, 6);
      expect(result.outputCostUsd.toNumber()).toBeCloseTo(0.0075, 6);
    });
  });

  // ============================================================
  // Provider-scoped matching + date-strip fallback
  // ============================================================

  it('should look up by canonicalName + provider (exact match, case-insensitive)', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(mockLlmEntry);

    // Customer sends with uppercase/whitespace — we normalize both sides
    const result = await service.lookupModel('  Claude-Sonnet-4-6  ', 'Anthropic');

    expect(result).not.toBeNull();
    expect(result!.costUnit).toBe('1M tokens');
    // Confirm the query was scoped to both canonicalName and provider
    expect(prisma.service_pricing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          canonicalName: 'claude-sonnet-4-6',
          provider: 'anthropic',
          isActive: true,
        }),
      }),
    );
  });

  it('should fall back to date-stripped form for pinned LLM snapshots (gpt-4o-2024-08-06 → gpt-4o)', async () => {
    // First call returns null (no exact match for the pinned form),
    // second call returns the entry (date-stripped match hits).
    (prisma.service_pricing.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...mockLlmEntry, canonicalName: 'gpt-4o', provider: 'openai' });

    const result = await service.lookupModel('gpt-4o-2024-08-06', 'openai');

    expect(result).not.toBeNull();
    expect(prisma.service_pricing.findFirst).toHaveBeenCalledTimes(2);
    // Second call should use the stripped form
    expect(prisma.service_pricing.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ canonicalName: 'gpt-4o' }),
      }),
    );
  });

  it('should fall back to date-stripped form for 3-digit version suffixes (gemini-2.0-flash-001 → gemini-2.0-flash)', async () => {
    (prisma.service_pricing.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...mockLlmEntry,
        canonicalName: 'gemini-2.0-flash',
        provider: 'google',
      });

    const result = await service.lookupModel('gemini-2.0-flash-001', 'google');

    expect(result).not.toBeNull();
    expect(prisma.service_pricing.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ canonicalName: 'gemini-2.0-flash' }),
      }),
    );
  });

  it('should return null when no match exists even after date-strip', async () => {
    (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.lookupModel('totally-made-up-model-xyz', 'openai');

    expect(result).toBeNull();
  });

  it('should return null when model or provider is empty after normalization', async () => {
    const result1 = await service.lookupModel('', 'openai');
    const result2 = await service.lookupModel('gpt-4o', '   ');
    const result3 = await service.lookupModel('  ', '  ');

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toBeNull();
    // Should not have hit the database at all for any of these
    expect(prisma.service_pricing.findFirst).not.toHaveBeenCalled();
  });

  it('should use preFetchedEntry when provided and skip the DB query', async () => {
    // The caller (recordUsage) has already looked up the entry;
    // calculateCost should accept it directly without re-querying.
    const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 1, 'anthropic', {
      inputCost: 3.0,
      outputCost: 15.0,
      costUnit: '1M tokens',
    });

    expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.0105, 6);
    // findFirst must NOT have been called — preFetchedEntry short-circuits
    expect(prisma.service_pricing.findFirst).not.toHaveBeenCalled();
  });

  // ============================================================
  // prompt-cache pricing (the cache terms of CANON.md rule V3)
  //
  // Worked example: a Claude Code turn whose true cost is $0.303383. Folding
  // cache tokens into input would price it at $0.25626 (wrong). These tests
  // prove the cache terms match the true cost to the cent.
  //
  // Token split:
  //   fresh input  = 12118   (51232 total input - 15626 cacheRead - 23488 cacheWrite;
  //                           inputTokens here excludes cache tokens)
  //   output       = 4
  //   cacheRead    = 15626   (cache_read_input_tokens)
  //   cacheWrite   = 23488   (cache_creation_input_tokens)
  //
  // Opus 4.8 rates (standard tier — there is NO 1M-context premium for
  // Opus 4.8):
  //   input  $5 / MTok, output $25 / MTok, cache-read $0.50 / MTok,
  //   cache-write 5-min $6.25 / MTok, cache-write 1-hour $10 / MTok.
  // ============================================================
  describe('prompt-cache pricing', () => {
    // Opus 4.8 with the 1-HOUR cache-write rate ($10) — the TTL this example
    // assumes. The pricing sync stores this 1-hour ceiling on Anthropic rows;
    // per-event 5-minute resolution is tested below.
    const opus48OneHour = {
      inputCost: 5.0,
      outputCost: 25.0,
      cacheReadCost: 0.5,
      cacheWriteCost: 10.0,
      costUnit: '1M tokens',
    };

    it('prices the sample Claude Code turn to ~$0.30 (cache read + write priced separately)', async () => {
      const result = await priceWithCache(
        'claude-opus-4-8',
        12118, // fresh input
        4, // output
        1,
        'anthropic',
        opus48OneHour,
        15626, // cacheReadTokens
        23488, // cacheWriteTokens
      );

      // 12118×5e-6 + 4×25e-6 + 15626×0.5e-6 + 23488×10e-6 = 0.303383
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.303383, 6);
      // And the split is surfaced for the cost-by-service breakdown.
      expect(result.cacheReadCostUsd.toNumber()).toBeCloseTo(0.007813, 6);
      expect(result.cacheWriteCostUsd.toNumber()).toBeCloseTo(0.23488, 6);
      expect(result.inputCostUsd.toNumber()).toBeCloseTo(0.06059, 6);
    });

    it('NEGATIVE CONTROL: folding cache into input gives $0.256, not $0.303', async () => {
      // cacheRead+cacheWrite folded into inputTokens (51232) bills all of it
      // at the $5 input rate. Same call shape, no cache token args (they
      // default to 0) → the wrong number.
      const result = await service.calculateCost(
        'claude-opus-4-8',
        51232, // folded input
        4,
        1,
        'anthropic',
        opus48OneHour,
      );
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.25626, 6);
      // 16% understated vs the true $0.303383 — and for the wrong reason
      // (cache-read overcharged 10×, cache-write undercharged).
      expect(result.totalCostUsd.toNumber()).toBeLessThan(0.303383);
    });

    it('is honest about the cache-write TTL: the 5-minute rate under-prices a 1-hour session', async () => {
      // Same real token split, but with the 5-minute cache-write rate ($6.25).
      // Lands at $0.2153, not the full $0.303, because this turn used
      // 1-hour cache. This is exactly WHY
      // the sync stores the 1-hour ceiling and the 5m rate is applied only on
      // per-event proof (metadata.cacheWriteTtl, tested below).
      const opus48FiveMin = { ...opus48OneHour, cacheWriteCost: 6.25 };
      const result = await priceWithCache(
        'claude-opus-4-8',
        12118,
        4,
        1,
        'anthropic',
        opus48FiveMin,
        15626,
        23488,
      );
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.215303, 6);
    });

    it('is backward-compatible: cache RATES present but ZERO cache tokens = identical to no-cache math', async () => {
      // An entry that carries cache rates, called with 6 args (no cache
      // token counts). Cache contributes exactly $0 — a non-cache event prices
      // byte-for-byte as it does without a TTL hint.
      const result = await service.calculateCost('claude-sonnet-4-6', 1000, 500, 1, 'anthropic', {
        inputCost: 3.0,
        outputCost: 15.0,
        cacheReadCost: 0.3,
        cacheWriteCost: 3.75,
        costUnit: '1M tokens',
      });
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.0105, 6);
      expect(result.cacheReadCostUsd.toNumber()).toBe(0);
      expect(result.cacheWriteCostUsd.toNumber()).toBe(0);
    });

    it('maps the cache columns through the DB lookup path (toLookupResult)', async () => {
      // Exercise the real lookup → toLookupResult → calculateEventCost chain,
      // proving the cacheReadCost/cacheWriteCost columns survive the Decimal→number
      // conversion in the lib. Rates here are the Opus 4.8 1-hour set as Decimals.
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue({
        ...mockLlmEntry,
        canonicalName: 'claude-opus-4-8',
        inputCost: new Decimal(5.0),
        outputCost: new Decimal(25.0),
        cacheReadCost: new Decimal(0.5),
        cacheWriteCost: new Decimal(10.0),
      });

      const entry = await service.lookupModel('claude-opus-4-8', 'anthropic');
      expect(entry).not.toBeNull();
      expect(entry!.cacheReadCost).toBe(0.5);
      expect(entry!.cacheWriteCost).toBe(10.0);

      const result = await priceWithCache(
        'claude-opus-4-8',
        12118,
        4,
        1,
        'anthropic',
        entry!,
        15626,
        23488,
      );
      expect(result.totalCostUsd.toNumber()).toBeCloseTo(0.303383, 6);
    });

    // A missing cache rate must never count as $0 when cache tokens are sent:
    // the refusal lives here so every write path gets it, not only ingest.
    it('REFUSES a missing cache rate (null column → undefined) when cache tokens are sent', async () => {
      const resolution = await service.resolveCost(
        'gpt-4o',
        1000,
        500,
        1,
        'openai',
        { inputCost: 3.0, outputCost: 15.0, costUnit: '1M tokens' }, // no cache rates
        9999,
        9999,
      );

      expect(resolution.ok).toBe(false);
      if (!isCostRefused(resolution)) throw new Error('unreachable');
      expect(resolution.missingRates).toEqual(['cacheReadCost', 'cacheWriteCost']);
      expect(resolution.modelKey).toBe('gpt-4o');
      // Pricing it anyway would bill $0.0105: the input+output total with
      // both cache terms silently dropped.
      expect(resolution.reason).toContain('would under-state cost');
    });

    it('prices a row with a genuine $0 cache rate — priced zero is not a missing rate', async () => {
      // deepseek-v3 in the price catalog carries cacheWriteCost = 0.00. That is a real free
      // rate, not an absent one, and must never be refused.
      const result = await priceWithCache(
        'deepseek-v3',
        1000,
        500,
        1,
        'deepseek',
        {
          inputCost: 0.27,
          outputCost: 1.1,
          cacheReadCost: 0.07,
          cacheWriteCost: 0,
          costUnit: '1M tokens',
        },
        9999,
        9999,
      );
      expect(result.cacheWriteCostUsd.toNumber()).toBe(0);
      expect(result.cacheReadCostUsd.toNumber()).toBeCloseTo(0.00069993, 8);
    });

    // ============================================================
    // Per-event cache-write TTL through the DI wrapper.
    // The wrapper's 9th arg is the event's raw metadata.cacheWriteTtl hint;
    // applyCacheWriteTtl in @marginfront/db validates it. Only "5m" on an
    // Anthropic row re-bases the write rate to 1.25× input — everything
    // else prices at the stored 1-hour ceiling, byte-identical to no hint.
    // ============================================================
    describe('cache-write TTL threading', () => {
      // As the sync stores it: cacheWriteCost = 2× input (the 1h ceiling).
      const anthropicCeilingEntry = {
        inputCost: 3.0,
        outputCost: 15.0,
        cacheReadCost: 0.3,
        cacheWriteCost: 6.0,
        costUnit: '1M tokens',
      };

      it('"5m" re-bases the cache-write rate to 1.25× input (1M write tokens: $3.75, not $6)', async () => {
        const result = await priceWithCache(
          'claude-sonnet-4-6',
          0,
          0,
          1,
          'anthropic',
          anthropicCeilingEntry,
          0,
          1_000_000,
          '5m',
        );
        expect(result.cacheWriteCostUsd.toNumber()).toBeCloseTo(3.75, 6);
        expect(result.totalCostUsd.toNumber()).toBeCloseTo(3.75, 6);
      });

      it.each([[undefined], ['1h'], ['banana'], [42]])(
        'hint %p keeps the stored ceiling, byte-identical to the 8-arg call',
        async (hint) => {
          const withHint = await priceWithCache(
            'claude-sonnet-4-6',
            1000,
            500,
            1,
            'anthropic',
            anthropicCeilingEntry,
            2000,
            1_000_000,
            hint,
          );
          const without = await priceWithCache(
            'claude-sonnet-4-6',
            1000,
            500,
            1,
            'anthropic',
            anthropicCeilingEntry,
            2000,
            1_000_000,
          );
          expect(withHint).toEqual(without);
          expect(withHint.cacheWriteCostUsd.toNumber()).toBeCloseTo(6.0, 6);
        },
      );

      it('"5m" on a NON-Anthropic provider is ignored (feed rates are not ratio-derivable)', async () => {
        const result = await priceWithCache(
          'some-model',
          0,
          0,
          1,
          'openrouter',
          anthropicCeilingEntry,
          0,
          1_000_000,
          '5m',
        );
        expect(result.cacheWriteCostUsd.toNumber()).toBeCloseTo(6.0, 6);
      });
    });

    it('preserves a genuine $0 cache rate as 0 (not undefined) through toLookupResult', async () => {
      // A row priced with an EXPLICIT $0.00 cache rate is not the same thing as a
      // row with no cache pricing at all. The lookup must surface a real 0, so
      // the ingest detector reads `modelEntry.cacheReadCost == null` as FALSE and
      // never flags a fully-priced event. A truthy check would collapse the
      // falsy 0 to undefined and false-flag it — this guards the `!= null`
      // check in model-pricing.ts toLookupResult.
      (prisma.service_pricing.findFirst as jest.Mock).mockResolvedValue({
        ...mockLlmEntry,
        canonicalName: 'free-cache-model',
        cacheReadCost: new Decimal(0),
        cacheWriteCost: new Decimal(0),
      });

      const entry = await service.lookupModel('free-cache-model', 'anthropic');
      expect(entry).not.toBeNull();
      expect(entry!.cacheReadCost).toBe(0);
      expect(entry!.cacheWriteCost).toBe(0);
      // The distinction the detector keys on: a real 0 is NOT "missing".
      expect(entry!.cacheReadCost == null).toBe(false);
      expect(entry!.cacheWriteCost == null).toBe(false);
    });
  });
});
