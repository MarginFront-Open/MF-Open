/**
 * Suite for applyCacheWriteTtl: per-event cache-write TTL pricing.
 *
 * Two invariants carry the whole feature:
 *
 * 1. NO-HINT = NO CHANGE, byte for byte. An event without metadata.cacheWriteTtl
 *    (clients that send no TTL hint, or a garbage hint) must price
 *    EXACTLY as it would without the helper: it returns the same entry object
 *    and calculateEventCost's output is deep-equal to the un-helped call.
 *
 * 2. REPRODUCIBILITY. The dashboard backfill calls
 *    calculateEventCost directly from @marginfront/db, NOT through the api-nest
 *    DI wrapper. A wrapper-only implementation would re-price a 5m event at
 *    the 2× ceiling on recompute. The "fails without the helper" suite below shows
 *    that exact divergence on the raw direct call, and that routing the same
 *    stored hint through applyCacheWriteTtl makes ingest and backfill agree.
 */

import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
  applyCacheWriteTtl,
  calculateEventCost,
  type CostEntry,
} from "../../src/lib/model-pricing";

// A realistic Anthropic LLM row as the sync script stores it: cacheWriteCost
// is the 1-hour ceiling (2× input).
const anthropicEntry: CostEntry = {
  inputCost: 3,
  outputCost: 15,
  cacheReadCost: 0.3,
  cacheWriteCost: 6,
  costUnit: "1M tokens",
};

describe("applyCacheWriteTtl — the 5m branch", () => {
  it('re-bases cacheWriteCost to 1.25× input for "5m" on an Anthropic LLM row', () => {
    const adjusted = applyCacheWriteTtl(anthropicEntry, "anthropic", "5m");
    expect(adjusted.cacheWriteCost).toBe(
      3 * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
    );
    expect(adjusted.cacheWriteCost).toBe(3.75);
    // Everything else is untouched.
    expect(adjusted.inputCost).toBe(3);
    expect(adjusted.outputCost).toBe(15);
    expect(adjusted.cacheReadCost).toBe(0.3);
    expect(adjusted.costUnit).toBe("1M tokens");
    // And the input object is never mutated.
    expect(anthropicEntry.cacheWriteCost).toBe(6);
  });

  it("normalizes the hint (whitespace + case) and the provider", () => {
    expect(
      applyCacheWriteTtl(anthropicEntry, "Anthropic", " 5M ").cacheWriteCost,
    ).toBe(3.75);
    expect(
      applyCacheWriteTtl(anthropicEntry, "  ANTHROPIC  ", "5m").cacheWriteCost,
    ).toBe(3.75);
  });

  it("prices a 5m event's cache writes at 1.25× through calculateEventCost", () => {
    const result = calculateEventCost(
      0,
      0,
      1,
      applyCacheWriteTtl(anthropicEntry, "anthropic", "5m"),
      0,
      1_000_000,
    );
    expect(result.cacheWriteCostUsd.toNumber()).toBe(3.75);
    expect(result.totalCostUsd.toNumber()).toBe(3.75);
  });
});

describe("applyCacheWriteTtl — everything else keeps the stored ceiling", () => {
  // Returning the SAME object (toBe, not toEqual) is the strongest form of
  // "no hint = unchanged pricing": there is nothing downstream to diverge.
  it.each([
    ["1h", "the explicit 1-hour answer"],
    [undefined, "no hint at all"],
    [null, "a null hint"],
    ["", "an empty-string hint"],
    ["5min", "a near-miss string"],
    ["banana", "garbage"],
    [5, "a non-string (number)"],
    [{ ttl: "5m" }, "a non-string (object)"],
  ])("returns the same entry object for %s (%s)", (hint) => {
    expect(applyCacheWriteTtl(anthropicEntry, "anthropic", hint)).toBe(
      anthropicEntry,
    );
  });

  it('ignores "5m" on non-Anthropic providers (their cache rates are feed values, not ratios)', () => {
    const openrouterEntry: CostEntry = { ...anthropicEntry };
    expect(applyCacheWriteTtl(openrouterEntry, "openrouter", "5m")).toBe(
      openrouterEntry,
    );
    expect(applyCacheWriteTtl(openrouterEntry, "openai", "5m")).toBe(
      openrouterEntry,
    );
    expect(applyCacheWriteTtl(openrouterEntry, undefined, "5m")).toBe(
      openrouterEntry,
    );
    expect(applyCacheWriteTtl(openrouterEntry, null, "5m")).toBe(
      openrouterEntry,
    );
  });

  it('ignores "5m" on non-LLM rows', () => {
    const toolEntry: CostEntry = { ...anthropicEntry, costUnit: "request" };
    expect(applyCacheWriteTtl(toolEntry, "anthropic", "5m")).toBe(toolEntry);
  });

  it("never INVENTS a cache-write rate on a row that has none (detector keys on the null)", () => {
    const noCacheEntry: CostEntry = {
      inputCost: 3,
      outputCost: 15,
      costUnit: "1M tokens",
    };
    expect(applyCacheWriteTtl(noCacheEntry, "anthropic", "5m")).toBe(
      noCacheEntry,
    );
  });

  it("leaves rows without a positive inputCost alone (mirrors the sync override guard)", () => {
    const zeroInput: CostEntry = { ...anthropicEntry, inputCost: 0 };
    const negativeInput: CostEntry = { ...anthropicEntry, inputCost: -1 };
    const nanInput: CostEntry = { ...anthropicEntry, inputCost: Number.NaN };
    expect(applyCacheWriteTtl(zeroInput, "anthropic", "5m")).toBe(zeroInput);
    expect(applyCacheWriteTtl(negativeInput, "anthropic", "5m")).toBe(
      negativeInput,
    );
    expect(applyCacheWriteTtl(nanInput, "anthropic", "5m")).toBe(nanInput);
  });

  it("no-hint cost output is deep-equal to calling calculateEventCost without the helper", () => {
    for (const hint of [undefined, "1h", "junk"]) {
      const helped = calculateEventCost(
        800_000,
        50_000,
        1,
        applyCacheWriteTtl(anthropicEntry, "anthropic", hint),
        2_000_000,
        400_000,
      );
      const raw = calculateEventCost(
        800_000,
        50_000,
        1,
        anthropicEntry,
        2_000_000,
        400_000,
      );
      expect(helped).toStrictEqual(raw);
    }
  });
});

describe("backfill reproducibility (fails without the helper)", () => {
  // 400k cache-write tokens on the row above:
  //   ceiling (2× input = $6/1M)  → $2.40
  //   5m      (1.25× input = $3.75/1M) → $1.50
  const cacheWriteTokens = 400_000;

  it("a wrapper-only implementation leaves the direct-call (dashboard backfill) path at 2×", () => {
    // The dashboard backfill imports calculateEventCost directly and builds
    // its entry from the raw service_pricing row. If the TTL branch lived
    // only in the api-nest wrapper, THIS is the call the backfill would make
    // for a 5m-stamped event — and it re-prices at the ceiling:
    const wrapperOnlyBackfill = calculateEventCost(
      0,
      0,
      1,
      anthropicEntry,
      0,
      cacheWriteTokens,
    );
    expect(wrapperOnlyBackfill.cacheWriteCostUsd.toNumber()).toBe(2.4);

    // The event was ingested at the 5m rate:
    const ingest = calculateEventCost(
      0,
      0,
      1,
      applyCacheWriteTtl(anthropicEntry, "anthropic", "5m"),
      0,
      cacheWriteTokens,
    );
    expect(ingest.cacheWriteCostUsd.toNumber()).toBe(1.5);

    // => recompute would silently change a stored cost. That divergence is
    // what the packages/db placement prevents:
    expect(wrapperOnlyBackfill.cacheWriteCostUsd.toNumber()).not.toBe(
      ingest.cacheWriteCostUsd.toNumber(),
    );
  });

  it("routing the stored hint through the shared helper makes ingest and backfill agree", () => {
    const storedHint = "5m"; // what ingest persisted in the event's metadata
    const ingest = calculateEventCost(
      0,
      0,
      1,
      applyCacheWriteTtl(anthropicEntry, "anthropic", storedHint),
      0,
      cacheWriteTokens,
    );
    const backfill = calculateEventCost(
      0,
      0,
      1,
      applyCacheWriteTtl(anthropicEntry, "anthropic", storedHint),
      0,
      cacheWriteTokens,
    );
    expect(backfill).toStrictEqual(ingest);
    expect(backfill.cacheWriteCostUsd.toNumber()).toBe(1.5);
  });

  it("an unstamped event reproduces at the ceiling on both paths (honest and stable)", () => {
    const ingest = calculateEventCost(
      0,
      0,
      1,
      applyCacheWriteTtl(anthropicEntry, "anthropic", undefined),
      0,
      cacheWriteTokens,
    );
    const backfill = calculateEventCost(
      0,
      0,
      1,
      anthropicEntry,
      0,
      cacheWriteTokens,
    );
    expect(ingest).toStrictEqual(backfill);
    expect(ingest.cacheWriteCostUsd.toNumber()).toBe(2.4);
  });
});
