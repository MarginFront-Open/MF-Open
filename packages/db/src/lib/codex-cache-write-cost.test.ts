/**
 * Codex cache-write pricing: the dollar half.
 *
 * Standalone assert script, the packages/db src convention:
 *
 *   npx tsx packages/db/src/lib/codex-cache-write-cost.test.ts
 *
 * The token counts come out of the SAME real capture fixture the forwarder test
 * uses, read off disk here so the two halves cannot drift: the forwarder test proves
 * input_token_count splits into fresh + cache-read + cache-write, and this file
 * proves what those three buckets cost once the real calculateEventCost prices them
 * at the real catalog rates.
 *
 * WHY THIS IS LOAD-BEARING: OpenAI nests the cache-write tokens INSIDE
 * input_token_count. Adding a cacheWriteTokens field without also removing those
 * tokens from the input bucket bills them twice — once at 1.0x input and again at
 * 1.25x — a 2.25x charge on the single largest slice of a cache-cold Codex turn.
 * The NEGATIVE CONTROL at the bottom replays exactly that mistake and shows the
 * number it produces, so this file can fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Decimal } from "@prisma/client/runtime/library";

import { calculateEventCost, type CostEntry } from "./model-pricing";

// service_pricing rows from the price catalog. gpt-5.6-sol is the
// model in the capture; gpt-5.5 is a Codex model with NO cache-write rate at all.
const GPT_56_SOL: CostEntry = {
  inputCost: 5.0,
  outputCost: 30.0,
  cacheReadCost: 0.5,
  cacheWriteCost: 6.25,
  costUnit: "1M tokens",
};
const GPT_55_NO_WRITE_RATE: CostEntry = {
  inputCost: 5.0,
  outputCost: 30.0,
  cacheReadCost: 0.5,
  costUnit: "1M tokens",
};

const capturePath = fileURLToPath(
  new URL(
    "../../../code-cost-clarity/test/fixtures/codex-cache-write-capture.json",
    import.meta.url,
  ),
);
const capture = JSON.parse(readFileSync(capturePath, "utf8"));

function counts(fixtureKey: string) {
  const attributes =
    capture[fixtureKey].resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  const read = (key: string) => {
    const value = attributes.find((a: { key: string }) => a.key === key)?.value;
    return value === undefined
      ? 0
      : Number(value.intValue ?? value.stringValue);
  };
  const input = read("input_token_count");
  const cached = read("cached_token_count");
  const written = read("cache_write_token_count");
  return {
    input,
    cached,
    written,
    output: read("output_token_count"),
    fresh: input - cached - written,
  };
}

const usd = (result: { toFixed: (n: number) => string }) => result.toFixed(10);

// --- the catalog relationship the whole split leans on ---------------------
// OpenRouter's input_cache_write and LiteLLM's cache_creation_input_token_cost both
// put a GPT-5.6 cache write at 1.25x input. If a feed ever changes that, the
// expected dollar figures below stop meaning what they say.
assert.equal(
  GPT_56_SOL.cacheWriteCost,
  GPT_56_SOL.inputCost * 1.25,
  "gpt-5.6-sol cache-write rate must be 1.25x input",
);

// --- a cache-COLD turn: almost the whole prompt is written into the cache ---
{
  const c = counts("codexSolColdBigWrite");
  assert.equal(c.input, 13175);
  assert.equal(c.cached, 0);
  assert.equal(c.written, 13172);
  assert.equal(c.fresh, 3);

  const result = calculateEventCost(
    c.fresh,
    c.output,
    1,
    GPT_56_SOL,
    c.cached,
    c.written,
  );

  // Hand-computed, not read back from the function under test:
  //   fresh   3      x $5.00 /1M = $0.000015
  //   output  89     x $30.00/1M = $0.002670
  //   write   13,172 x $6.25 /1M = $0.082325
  assert.equal(usd(result.inputCostUsd), "0.0000150000");
  assert.equal(usd(result.outputCostUsd), "0.0026700000");
  assert.equal(usd(result.cacheReadCostUsd), "0.0000000000");
  assert.equal(usd(result.cacheWriteCostUsd), "0.0823250000");
  assert.equal(usd(result.totalCostUsd), "0.0850100000");

  // The written tokens are billed at 1.25x input, ONCE.
  assert.equal(
    usd(result.cacheWriteCostUsd),
    usd(new Decimal(c.written).mul(new Decimal(1.25 * 5.0).div(1_000_000))),
    "written tokens must price at 1.25x the input rate",
  );

  // What a mapping without cache-write would bill: the whole 13,175 as fresh
  // input, no write line at all. 19.4% light on this one turn.
  const withoutCacheWrite = calculateEventCost(c.input, c.output, 1, GPT_56_SOL);
  assert.equal(usd(withoutCacheWrite.totalCostUsd), "0.0685450000");
  assert.ok(
    withoutCacheWrite.totalCostUsd.lt(result.totalCostUsd),
    "a mapping without cache-write under-bills this turn",
  );

  // NEGATIVE CONTROL — the 2.25x trap. Add the write field but forget to take the
  // written tokens back out of the input bucket and the same tokens carry both a
  // 1.0x and a 1.25x line. This is the shape of over-bill the pricing must NOT produce.
  const doubleCounted = calculateEventCost(
    c.input,
    c.output,
    1,
    GPT_56_SOL,
    c.cached,
    c.written,
  );
  assert.equal(usd(doubleCounted.totalCostUsd), "0.1508700000");
  assert.notEqual(
    usd(result.totalCostUsd),
    usd(doubleCounted.totalCostUsd),
    "the shipped mapping must not be the double-counting one",
  );
  assert.ok(
    doubleCounted.totalCostUsd.gt(result.totalCostUsd.mul(1.7)),
    "the double-count is a 1.7x+ over-bill on this turn",
  );
}

// --- a cache-WARM turn: all three buckets non-zero -------------------------
{
  const c = counts("codexSolWarmBothSlices");
  assert.equal(c.input, 13301);
  assert.equal(c.cached, 13172);
  assert.equal(c.written, 126);
  assert.equal(c.fresh, 3);

  const result = calculateEventCost(
    c.fresh,
    c.output,
    1,
    GPT_56_SOL,
    c.cached,
    c.written,
  );

  //   fresh   3      x $5.00 /1M = $0.000015
  //   read    13,172 x $0.50 /1M = $0.006586
  //   write   126    x $6.25 /1M = $0.000787.5
  //   output  34     x $30.00/1M = $0.001020
  assert.equal(usd(result.inputCostUsd), "0.0000150000");
  assert.equal(usd(result.cacheReadCostUsd), "0.0065860000");
  assert.equal(usd(result.cacheWriteCostUsd), "0.0007875000");
  assert.equal(usd(result.outputCostUsd), "0.0010200000");
  assert.equal(usd(result.totalCostUsd), "0.0084085000");

  // A two-way mapping would put the 126 written tokens in the fresh bucket, billing
  // 129 at the input rate and nothing at the write rate.
  const withoutCacheWrite = calculateEventCost(
    c.input - c.cached,
    c.output,
    1,
    GPT_56_SOL,
    c.cached,
  );
  assert.equal(usd(withoutCacheWrite.inputCostUsd), "0.0006450000");
  assert.equal(usd(withoutCacheWrite.cacheWriteCostUsd), "0.0000000000");
}

// --- the revenue gate: a pre-5.6 model with no cache-write rate ------------
// sdk.service.ts flips any event with cacheWriteTokens > 0 against a row whose
// cacheWriteCost is NULL to NEEDS_COST_BACKFILL with a null cost — billed revenue
// becomes unbilled. calculateEventCost on its own would quietly price that slice at
// $0, which is why the forwarder must never send a zero-or-absent write count as a
// field at all. This asserts the $0 that makes the flag necessary.
{
  const priced = calculateEventCost(
    1000,
    100,
    1,
    GPT_55_NO_WRITE_RATE,
    500,
    2000,
  );
  assert.equal(GPT_55_NO_WRITE_RATE.cacheWriteCost, undefined);
  assert.equal(usd(priced.cacheWriteCostUsd), "0.0000000000");
  assert.equal(priced.cacheWriteCostPerToken, 0);
}

// --- a no-cache call is untouched -----------------------------------------
// A call with no cache arguments prices tokens only: same rates, same tokens,
// same dollars as the two-term formula.
{
  const noCache = calculateEventCost(10_000, 2_000, 1, GPT_56_SOL);
  assert.equal(usd(noCache.inputCostUsd), "0.0500000000");
  assert.equal(usd(noCache.outputCostUsd), "0.0600000000");
  assert.equal(usd(noCache.totalCostUsd), "0.1100000000");
  assert.equal(usd(noCache.cacheReadCostUsd), "0.0000000000");
  assert.equal(usd(noCache.cacheWriteCostUsd), "0.0000000000");
}

console.log("codex-cache-write-cost.test.ts: all assertions passed");
