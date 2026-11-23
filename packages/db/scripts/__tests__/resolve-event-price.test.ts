import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  calculateEventCost,
  resolveEventPrice,
  unguardedCacheTokens,
  isPriceRefused,
  ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
  type CostEntry,
} from "../../src/lib/model-pricing";

/**
 * The canonical missing-cache-rate guard.
 *
 * Every pricing row below is shaped like a real public list-price row in the
 * service_pricing catalog, and the cache-bearing event is a
 * synthetic signal_event_services child shaped like one stuck in
 * NEEDS_COST_BACKFILL. The point of using real price rows is the priced-zero cases: some catalog rows carry
 * a genuine $0.00 cache rate, and those must PRICE, not refuse.
 */

// claude-opus-5 / anthropic — fully priced, both cache directions.
const CLAUDE_OPUS_5: CostEntry = {
  inputCost: 5,
  outputCost: 25,
  cacheReadCost: 0.5,
  cacheWriteCost: 10,
  costUnit: "1M tokens",
};

// gpt-5.5 / openai — cacheRead priced, cacheWrite NULL, a common shape in the
// price catalog.
const GPT_55_NULL_WRITE: CostEntry = {
  inputCost: 5,
  outputCost: 30,
  cacheReadCost: 0.5,
  cacheWriteCost: undefined,
  costUnit: "1M tokens",
};

// gpt-5.5-pro / openai — BOTH cache rates NULL.
const GPT_55_PRO_BOTH_NULL: CostEntry = {
  inputCost: 30,
  outputCost: 180,
  cacheReadCost: undefined,
  cacheWriteCost: undefined,
  costUnit: "1M tokens",
};

// deepseek-v3 / deepseek — cacheWriteCost is a genuine PRICED ZERO.
const DEEPSEEK_V3_ZERO_WRITE: CostEntry = {
  inputCost: 0.27,
  outputCost: 1.1,
  cacheReadCost: 0.07,
  cacheWriteCost: 0,
  costUnit: "1M tokens",
};

// gpt-oss-120b / tensormesh — the discriminating row: cacheRead is a PRICED
// ZERO and cacheWrite is NULL, on the SAME row.
const GPT_OSS_120B_ZERO_READ_NULL_WRITE: CostEntry = {
  inputCost: 0.15,
  outputCost: 0.6,
  cacheReadCost: 0,
  cacheWriteCost: undefined,
  costUnit: "1M tokens",
};

// A synthetic child, claude-opus-5 / anthropic, eventStatus NEEDS_COST_BACKFILL.
const CACHE_BEARING_CHILD = {
  inputTokens: 30,
  outputTokens: 14800,
  cacheReadTokens: 1250000,
  cacheWriteTokens: 27500,
};

describe("resolveEventPrice — the core refusal", () => {
  it("REFUSES a cache-bearing child against a row with NULL cacheWriteCost", () => {
    const r = resolveEventPrice({
      inputTokens: CACHE_BEARING_CHILD.inputTokens,
      outputTokens: CACHE_BEARING_CHILD.outputTokens,
      quantity: 1,
      entry: GPT_55_NULL_WRITE,
      cacheReadTokens: CACHE_BEARING_CHILD.cacheReadTokens,
      cacheWriteTokens: CACHE_BEARING_CHILD.cacheWriteTokens,
      model: "gpt-5.5",
      provider: "openai",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missingRates).toEqual(["cacheWriteCost"]);
    expect(r.reason).toContain("cacheWriteCost");
    expect(r.reason).toContain("NEEDS_COST_BACKFILL");
    // The refusal must not smuggle a number out.
    expect(r).not.toHaveProperty("price");
  });

  it("quantifies what the refusal prevented: the pure multiplier fabricates a low number", () => {
    const fabricated = calculateEventCost(
      CACHE_BEARING_CHILD.inputTokens,
      CACHE_BEARING_CHILD.outputTokens,
      1,
      { ...CLAUDE_OPUS_5, cacheWriteCost: undefined },
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheReadTokens),
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheWriteTokens),
    ).totalCostUsd;

    const honest = calculateEventCost(
      CACHE_BEARING_CHILD.inputTokens,
      CACHE_BEARING_CHILD.outputTokens,
      1,
      CLAUDE_OPUS_5,
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheReadTokens),
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheWriteTokens),
    ).totalCostUsd;

    expect(honest.toFixed(8)).toBe("1.27015000");
    expect(fabricated.toFixed(8)).toBe("0.99515000");
    // Without the guard, 21.65% of this event's real cost vanishes silently.
    expect(honest.minus(fabricated).toFixed(8)).toBe("0.27500000");
  });

  it("reports BOTH directions when both rates are missing", () => {
    const r = resolveEventPrice({
      inputTokens: 100,
      outputTokens: 100,
      quantity: 1,
      entry: GPT_55_PRO_BOTH_NULL,
      cacheReadTokens: 5000,
      cacheWriteTokens: 5000,
      model: "gpt-5.5-pro",
    });
    expect(isPriceRefused(r)).toBe(true);
    if (r.ok) throw new Error("unreachable");
    expect(r.missingRates).toEqual(["cacheReadCost", "cacheWriteCost"]);
  });
});

describe("PRICED-ZERO SURVIVAL — the twin of the test above", () => {
  it("a genuine $0 cacheWriteCost PRICES at $0 and is NEVER refused", () => {
    const r = resolveEventPrice({
      inputTokens: 1000,
      outputTokens: 500,
      quantity: 1,
      entry: DEEPSEEK_V3_ZERO_WRITE,
      cacheReadTokens: 200000,
      cacheWriteTokens: 900000,
      model: "deepseek-v3",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`refused a priced zero: ${r.reason}`);
    // cacheWrite contributes exactly $0 because the RATE is zero, not absent.
    expect(r.price.cacheWriteCostUsd.toFixed(10)).toBe("0.0000000000");
    // cacheRead at 0.07/1M on 200k tokens = $0.014, still priced normally.
    expect(r.price.cacheReadCostUsd.toFixed(10)).toBe("0.0140000000");
    expect(r.price.totalCostUsd.toFixed(10)).toBe(
      new Decimal(1000)
        .mul(0.27 / 1e6)
        .add(new Decimal(500).mul(1.1 / 1e6))
        .add(new Decimal(200000).mul(0.07 / 1e6))
        .toFixed(10),
    );
  });

  it("SAME ROW, two meanings: priced-zero read prices, NULL write refuses", () => {
    // gpt-oss-120b has cacheReadCost = 0 (real, free) and cacheWriteCost = NULL.
    // Read-only traffic must price; write traffic must refuse.
    const readOnly = resolveEventPrice({
      inputTokens: 1000,
      outputTokens: 1000,
      quantity: 1,
      entry: GPT_OSS_120B_ZERO_READ_NULL_WRITE,
      cacheReadTokens: 500000,
      cacheWriteTokens: 0,
      model: "gpt-oss-120b",
    });
    expect(readOnly.ok).toBe(true);
    if (!readOnly.ok) throw new Error("priced-zero read was refused");
    expect(readOnly.price.cacheReadCostUsd.toFixed(10)).toBe("0.0000000000");

    const withWrite = resolveEventPrice({
      inputTokens: 1000,
      outputTokens: 1000,
      quantity: 1,
      entry: GPT_OSS_120B_ZERO_READ_NULL_WRITE,
      cacheReadTokens: 500000,
      cacheWriteTokens: 1,
      model: "gpt-oss-120b",
    });
    expect(withWrite.ok).toBe(false);
    if (withWrite.ok) throw new Error("unreachable");
    // ONLY the write direction is named — the zero read is a real price.
    expect(withWrite.missingRates).toEqual(["cacheWriteCost"]);
  });

  it("a zero TOKEN count against a NULL rate does not refuse", () => {
    // The guard keys on the event's usage, not the row's completeness.
    const r = resolveEventPrice({
      inputTokens: 1000,
      outputTokens: 500,
      quantity: 1,
      entry: GPT_55_PRO_BOTH_NULL,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "gpt-5.5-pro",
    });
    expect(r.ok).toBe(true);
  });

  it("null/undefined token counts are treated as zero, not as usage", () => {
    for (const counts of [
      { cacheReadTokens: null, cacheWriteTokens: null },
      { cacheReadTokens: undefined, cacheWriteTokens: undefined },
      {},
    ]) {
      const r = resolveEventPrice({
        inputTokens: 10,
        outputTokens: 10,
        quantity: 1,
        entry: GPT_55_PRO_BOTH_NULL,
        ...counts,
      });
      expect(r.ok).toBe(true);
    }
  });
});

describe("NEGATIVE CONTROLS — things that must not move", () => {
  it("a no-cache event against a no-cache row is untouched", () => {
    const noCacheRow: CostEntry = {
      inputCost: 5,
      outputCost: 30,
      costUnit: "1M tokens",
    };
    const viaGuard = resolveEventPrice({
      inputTokens: 1000,
      outputTokens: 500,
      quantity: 1,
      entry: noCacheRow,
    });
    const direct = calculateEventCost(1000, 500, 1, noCacheRow);
    expect(viaGuard.ok).toBe(true);
    if (!viaGuard.ok) throw new Error("unreachable");
    expect(viaGuard.price.totalCostUsd.toFixed(18)).toBe(
      direct.totalCostUsd.toFixed(18),
    );
  });

  it("a fully-priced cache event is untouched", () => {
    const viaGuard = resolveEventPrice({
      inputTokens: CACHE_BEARING_CHILD.inputTokens,
      outputTokens: CACHE_BEARING_CHILD.outputTokens,
      quantity: 1,
      entry: CLAUDE_OPUS_5,
      cacheReadTokens: CACHE_BEARING_CHILD.cacheReadTokens,
      cacheWriteTokens: CACHE_BEARING_CHILD.cacheWriteTokens,
      provider: "anthropic",
    });
    const direct = calculateEventCost(
      CACHE_BEARING_CHILD.inputTokens,
      CACHE_BEARING_CHILD.outputTokens,
      1,
      CLAUDE_OPUS_5,
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheReadTokens),
      unguardedCacheTokens(CACHE_BEARING_CHILD.cacheWriteTokens),
    );
    expect(viaGuard.ok).toBe(true);
    if (!viaGuard.ok) throw new Error("unreachable");
    for (const k of [
      "inputCostUsd",
      "outputCostUsd",
      "cacheReadCostUsd",
      "cacheWriteCostUsd",
      "totalCostUsd",
    ] as const) {
      expect(viaGuard.price[k].toFixed(18)).toBe(direct[k].toFixed(18));
    }
  });
});

describe("5m cache-write TTL still re-bases through the guard", () => {
  it("Anthropic + '5m' re-bases cacheWrite to 1.25x input", () => {
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: CLAUDE_OPUS_5,
      cacheWriteTokens: 1_000_000,
      provider: "anthropic",
      cacheWriteTtl: "5m",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // 1.25 x $5 input = $6.25/1M, NOT the stored $10 ceiling.
    const expected =
      CLAUDE_OPUS_5.inputCost * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER;
    expect(expected).toBe(6.25);
    expect(r.price.cacheWriteCostUsd.toFixed(8)).toBe("6.25000000");
    expect(r.entry.cacheWriteCost).toBe(6.25);
  });

  it("is inert for every other provider and every other hint", () => {
    const cases: Array<[string | null, unknown]> = [
      ["openai", "5m"],
      ["google", "5m"],
      ["anthropic", "1h"],
      ["anthropic", undefined],
      ["anthropic", "garbage"],
      [null, "5m"],
    ];
    for (const [provider, ttl] of cases) {
      const r = resolveEventPrice({
        inputTokens: 0,
        outputTokens: 0,
        quantity: 1,
        entry: CLAUDE_OPUS_5,
        cacheWriteTokens: 1_000_000,
        provider,
        cacheWriteTtl: ttl,
      });
      if (!r.ok) throw new Error("unreachable");
      // Stored $10/1M ceiling survives untouched.
      expect(r.price.cacheWriteCostUsd.toFixed(8)).toBe("10.00000000");
    }
  });

  it("does NOT invent a cache-write rate on a row that has none", () => {
    // applyCacheWriteTtl is null-preserving, so the guard still refuses rather
    // than deriving 1.25x input for a row the catalog never priced.
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: { ...CLAUDE_OPUS_5, cacheWriteCost: undefined },
      cacheWriteTokens: 1_000_000,
      provider: "anthropic",
      cacheWriteTtl: "5m",
    });
    expect(r.ok).toBe(false);
  });
});

describe("all four costUnit branches are byte-identical through the guard", () => {
  // Real costUnit values and rates spread across the price catalog.
  const rows: CostEntry[] = [
    { inputCost: 5, outputCost: 25, costUnit: "1M tokens" },
    { inputCost: 0.27, outputCost: 1.1, costUnit: "1M tokens" },
    { inputCost: 30, outputCost: 180, costUnit: "1M tokens" },
    { inputCost: 1.5, outputCost: 0, costUnit: "1K pages" },
    { inputCost: 0.0825, outputCost: 0, costUnit: "1K emails" },
    { inputCost: 2, outputCost: 0, costUnit: "1M read units" },
    { inputCost: 0.4, outputCost: 0, costUnit: "1M requests" },
    { inputCost: 0.04, outputCost: 0, costUnit: "image" },
    { inputCost: 0.006, outputCost: 0, costUnit: "minute" },
    { inputCost: 0.0001, outputCost: 0, costUnit: "request" },
  ];
  const volumes = [0, 1, 7, 1000, 999_999, 5_000_000];

  it("matches calculateEventCost exactly across a spread of rows and volumes", () => {
    let compared = 0;
    for (const entry of rows) {
      for (const inputTokens of volumes) {
        for (const quantity of volumes) {
          const viaGuard = resolveEventPrice({
            inputTokens,
            outputTokens: Math.floor(inputTokens / 3),
            quantity,
            entry,
          });
          const direct = calculateEventCost(
            inputTokens,
            Math.floor(inputTokens / 3),
            quantity,
            entry,
          );
          if (!viaGuard.ok) throw new Error("no-cache event must never refuse");
          expect(viaGuard.price.totalCostUsd.toFixed(18)).toBe(
            direct.totalCostUsd.toFixed(18),
          );
          expect(viaGuard.price.inputCostUsd.toFixed(18)).toBe(
            direct.inputCostUsd.toFixed(18),
          );
          expect(viaGuard.price.outputCostUsd.toFixed(18)).toBe(
            direct.outputCostUsd.toFixed(18),
          );
          compared++;
        }
      }
    }
    expect(compared).toBe(rows.length * volumes.length * volumes.length);
  });

  it("keeps '1M tokens' distinct from '1M <thing>' (the 1e6x family)", () => {
    const tokens = resolveEventPrice({
      inputTokens: 1_000_000,
      outputTokens: 0,
      quantity: 5_000_000,
      entry: { inputCost: 2, outputCost: 0, costUnit: "1M tokens" },
    });
    const readUnits = resolveEventPrice({
      inputTokens: 1_000_000,
      outputTokens: 0,
      quantity: 5_000_000,
      entry: { inputCost: 2, outputCost: 0, costUnit: "1M read units" },
    });
    if (!tokens.ok || !readUnits.ok) throw new Error("unreachable");
    // tokens: 1M tokens x $2/1M = $2. read units: 5M x $2/1M = $10.
    expect(tokens.price.totalCostUsd.toFixed(8)).toBe("2.00000000");
    expect(readUnits.price.totalCostUsd.toFixed(8)).toBe("10.00000000");
  });
});

/**
 * Non-"1M tokens" catalog rows carry a NULL
 * cacheReadCost AND a NULL cacheWriteCost —
 * cache is an LLM concept and those feeds never publish one. The three
 * non-token branches of calculateEventCost hard-zero every cache term, so
 * those prices are correct with cache tokens present. A guard that keys on
 * the null alone would refuse every one of them.
 *
 * The door: mapModelAndBackfill lets an operator pick ANY active row for a
 * cache-bearing child. Expected values below are calculateEventCost's own
 * output for these rows.
 */
describe("a non-token row is never refused over cache it cannot price", () => {
  const NON_TOKEN_CATALOG_ROWS: Array<{
    label: string;
    entry: CostEntry;
    quantity: number;
    expectedTotal: string;
  }> = [
    {
      label: "anthropic-web-search / 1K requests",
      entry: { inputCost: 10, outputCost: 0, costUnit: "1K requests" },
      quantity: 250,
      expectedTotal: "2.5000000000",
    },
    {
      label: "pinecone reads / 1M read units",
      entry: { inputCost: 2, outputCost: 0, costUnit: "1M read units" },
      quantity: 5_000_000,
      expectedTotal: "10.0000000000",
    },
    {
      label: "flat per-request row",
      entry: { inputCost: 0.0001, outputCost: 0, costUnit: "request" },
      quantity: 3,
      expectedTotal: "0.0003000000",
    },
    {
      label: "flat per-image row",
      entry: { inputCost: 0.04, outputCost: 0, costUnit: "image" },
      quantity: 2,
      expectedTotal: "0.0800000000",
    },
    {
      label: "textract / 1K pages",
      entry: { inputCost: 1.5, outputCost: 0, costUnit: "1K pages" },
      quantity: 1234,
      expectedTotal: "1.8510000000",
    },
  ];

  for (const row of NON_TOKEN_CATALOG_ROWS) {
    it(`prices ${row.label} exactly as the baseline did, cache tokens and all`, () => {
      const r = resolveEventPrice({
        inputTokens: 0,
        outputTokens: 0,
        quantity: row.quantity,
        entry: row.entry,
        cacheReadTokens: CACHE_BEARING_CHILD.cacheReadTokens,
        cacheWriteTokens: CACHE_BEARING_CHILD.cacheWriteTokens,
        model: "some-service",
        provider: "some-provider",
      });
      if (isPriceRefused(r)) {
        throw new Error(
          `refused a ${row.entry.costUnit} row whose price was already correct: ` +
            r.missingRates.join("+"),
        );
      }
      expect(r.price.totalCostUsd.toFixed(10)).toBe(row.expectedTotal);
      // Cache terms are structurally zero in these branches.
      expect(r.price.cacheReadCostUsd.toFixed(10)).toBe("0.0000000000");
      expect(r.price.cacheWriteCostUsd.toFixed(10)).toBe("0.0000000000");
    });

    it(`${row.label} is byte-identical to the unguarded multiplier`, () => {
      const viaGuard = resolveEventPrice({
        inputTokens: 11,
        outputTokens: 13,
        quantity: row.quantity,
        entry: row.entry,
        cacheReadTokens: 645_943,
        cacheWriteTokens: 64_037,
      });
      const direct = calculateEventCost(
        11,
        13,
        row.quantity,
        row.entry,
        unguardedCacheTokens(645_943),
        unguardedCacheTokens(64_037),
      );
      if (isPriceRefused(viaGuard)) throw new Error("refused");
      expect(viaGuard.price.totalCostUsd.toFixed(18)).toBe(
        direct.totalCostUsd.toFixed(18),
      );
    });
  }

  it("TWIN: the same cache tokens against a '1M tokens' row still refuse", () => {
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 250,
      entry: GPT_55_NULL_WRITE,
      cacheReadTokens: CACHE_BEARING_CHILD.cacheReadTokens,
      cacheWriteTokens: CACHE_BEARING_CHILD.cacheWriteTokens,
      model: "gpt-5.5",
      provider: "openai",
    });
    expect(isPriceRefused(r)).toBe(true);
    if (!isPriceRefused(r)) throw new Error("unreachable");
    expect(r.missingRates).toEqual(["cacheWriteCost"]);
  });

  it("NEGATIVE CONTROL: a '1M tokens' row with BOTH rates null still refuses", () => {
    const r = resolveEventPrice({
      inputTokens: 100,
      outputTokens: 100,
      quantity: 1,
      entry: GPT_55_PRO_BOTH_NULL,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      model: "gpt-5.5-pro",
      provider: "openai",
    });
    expect(isPriceRefused(r)).toBe(true);
    if (!isPriceRefused(r)) throw new Error("unreachable");
    expect(r.missingRates).toEqual(["cacheReadCost", "cacheWriteCost"]);
  });
});

/**
 * `Number(x ?? 0)` turns "abc", {} or NaN itself into NaN, and NaN > 0 is
 * false, so a guard built on it stays silent and the multiplier returns a NaN
 * dollar amount that a write path would store.
 */
describe("a non-finite cache count is refused, never priced", () => {
  const GARBAGE: Array<[string, unknown]> = [
    ["NaN", NaN],
    ["a non-numeric string", "not-a-number"],
    ["an object", {}],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ];

  for (const [label, value] of GARBAGE) {
    it(`refuses ${label} as a cacheRead count on a fully-priced row`, () => {
      const r = resolveEventPrice({
        inputTokens: 10,
        outputTokens: 10,
        quantity: 1,
        entry: CLAUDE_OPUS_5,
        cacheReadTokens: value as number,
        model: "claude-opus-5",
        provider: "anthropic",
      });
      expect(isPriceRefused(r)).toBe(true);
    });

    it(`refuses ${label} as a cacheWrite count on a fully-priced row`, () => {
      const r = resolveEventPrice({
        inputTokens: 10,
        outputTokens: 10,
        quantity: 1,
        entry: CLAUDE_OPUS_5,
        cacheWriteTokens: value as number,
        model: "claude-opus-5",
        provider: "anthropic",
      });
      expect(isPriceRefused(r)).toBe(true);
    });
  }

  it("never returns a NaN dollar amount for any of them", () => {
    for (const [, value] of GARBAGE) {
      const r = resolveEventPrice({
        inputTokens: 10,
        outputTokens: 10,
        quantity: 1,
        entry: CLAUDE_OPUS_5,
        cacheReadTokens: value as number,
        cacheWriteTokens: value as number,
      });
      if (!isPriceRefused(r)) {
        expect(r.price.totalCostUsd.isNaN()).toBe(false);
      }
    }
  });

  it("NEGATIVE CONTROL: finite counts, including 0 and null, still price", () => {
    for (const count of [0, null, undefined, 7, 1_250_000]) {
      const r = resolveEventPrice({
        inputTokens: 10,
        outputTokens: 10,
        quantity: 1,
        entry: CLAUDE_OPUS_5,
        cacheReadTokens: count,
        cacheWriteTokens: count,
      });
      expect(isPriceRefused(r)).toBe(false);
    }
  });

  it("names the direction that was unreadable", () => {
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: CLAUDE_OPUS_5,
      cacheReadTokens: NaN,
      cacheWriteTokens: 5,
      model: "claude-opus-5",
    });
    if (!isPriceRefused(r)) throw new Error("expected a refusal");
    expect(r.missingRates).toEqual(["cacheReadCost"]);
    expect(r.reason).toContain("could not be read as a number");
  });
});

/**
 * The refusal sentence has one fixed wording, reproduced literally below. A
 * truthiness test on `provider` would change it for an empty-string provider,
 * which the ingest path can produce.
 */
describe("the refusal reason keeps its fixed wording", () => {
  const originalSvcMessage = (
    model: string,
    provider: string,
    missingRates: string[],
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ) =>
    `Model "${model}" (provider "${provider}") resolved to a pricing ` +
    `row missing ${missingRates.join(" and ")}, but the event reported cache tokens ` +
    `(cacheReadTokens=${cacheReadTokens}, cacheWriteTokens=${cacheWriteTokens}). ` +
    `Pricing the missing cache rate(s) at $0 would under-state cost, so the event is ` +
    `stored with usageCost: null and flagged NEEDS_COST_BACKFILL. Populate the missing ` +
    `cache rate(s) for this model (run the pricing sync), then re-map/backfill to resolve.`;

  const CASES: Array<[string, string, string]> = [
    ["a normal model and provider", "gpt-5.5", "openai"],
    ["an EMPTY provider string", "gpt-5.5", ""],
    ["an EMPTY model string", "", "openai"],
    ["both empty", "", ""],
  ];

  for (const [label, model, provider] of CASES) {
    it(`matches for ${label}`, () => {
      const r = resolveEventPrice({
        inputTokens: 0,
        outputTokens: 0,
        quantity: 1,
        entry: GPT_55_NULL_WRITE,
        cacheReadTokens: 0,
        cacheWriteTokens: 27_500,
        model,
        provider,
      });
      if (!isPriceRefused(r)) throw new Error("expected a refusal");
      expect(r.reason).toBe(
        originalSvcMessage(model, provider, ["cacheWriteCost"], 0, 27_500),
      );
    });
  }

  it("falls back to a generic subject only when the caller names nothing", () => {
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: GPT_55_NULL_WRITE,
      cacheWriteTokens: 1,
    });
    if (!isPriceRefused(r)) throw new Error("expected a refusal");
    expect(
      r.reason.startsWith("The resolved model resolved to a pricing row"),
    ).toBe(true);
  });
});

describe("the non-token rule and the non-finite rule do not collide", () => {
  it("an unreadable cache count on a NON-token row still prices, because the count is inert there", () => {
    const r = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 250,
      entry: { inputCost: 10, outputCost: 0, costUnit: "1K requests" },
      cacheReadTokens: NaN,
      cacheWriteTokens: "garbage" as unknown as number,
      model: "anthropic-web-search",
      provider: "anthropic",
    });
    if (isPriceRefused(r)) throw new Error(`refused: ${r.reason}`);
    expect(r.price.totalCostUsd.toFixed(10)).toBe("2.5000000000");
    expect(r.price.totalCostUsd.isNaN()).toBe(false);
  });

  it("the refusal kind separates 'no rate' from 'no readable count'", () => {
    const noRate = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: GPT_55_NULL_WRITE,
      cacheWriteTokens: 27_500,
      model: "gpt-5.5",
      provider: "openai",
    });
    const noCount = resolveEventPrice({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 1,
      entry: CLAUDE_OPUS_5,
      cacheWriteTokens: NaN,
      model: "claude-opus-5",
      provider: "anthropic",
    });
    if (!isPriceRefused(noRate) || !isPriceRefused(noCount)) {
      throw new Error("both must refuse");
    }
    expect(noRate.kind).toBe("missing-rate");
    expect(noCount.kind).toBe("unreadable-count");
    expect(noRate.reason).toContain("run the pricing sync");
    expect(noCount.reason).not.toContain("run the pricing sync");
  });
});
