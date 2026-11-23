import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sync-service-pricing imports PrismaClient at module scope purely to write rows.
// Nothing under test here touches the database, and CI runs this task BEFORE
// `prisma generate`, so a real import dies with "@prisma/client did not
// initialize yet". Stubbing the client keeps the functions under test real.
vi.mock("@prisma/client", () => ({ PrismaClient: class {} }));

import { fetchOpenRouter, parseFeedCacheRate } from "../sync-service-pricing";

/**
 * The sync must not destroy the priced-zero distinction.
 *
 * `cacheReadCost > 0 ? cacheReadCost * 1e6 : null` would collapse a
 * vendor-reported ZERO into NULL. Downstream those mean opposite things: a 0 is
 * a price and prices at $0; a NULL means "no rate published" and REFUSES any
 * event carrying cache tokens. A genuinely-free model would stay stuck, and
 * rerunning the sync would write the same NULL every time.
 *
 * The payloads below are shaped like the OpenRouter models API
 * (https://openrouter.ai/api/v1/models): pricing values are
 * per-token decimal STRINGS, and a model that publishes no cache rate omits
 * the key entirely rather than sending "0".
 */

const realFetch = globalThis.fetch;

function feed(models: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: models }),
  } as unknown as Response;
}

function model(id: string, pricing: Record<string, string>) {
  return {
    id,
    name: `Vendor: ${id}`,
    context_length: 200000,
    pricing: { prompt: "0.000005", completion: "0.000015", ...pricing },
  };
}

async function normalize(models: unknown[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(feed(models));
  const entries = await fetchOpenRouter();
  return entries;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe("a vendor-reported zero cache rate survives the sync", () => {
  it("keeps a reported 0 cache-READ rate as a priced 0, not NULL", async () => {
    const [entry] = await normalize([
      model("vendor/free-cache-reads", { input_cache_read: "0" }),
    ]);
    expect(entry.cacheReadCost).toBe(0);
    expect(entry.cacheReadCost).not.toBeNull();
  });

  it("keeps a reported 0 cache-WRITE rate as a priced 0, not NULL", async () => {
    const [entry] = await normalize([
      model("vendor/free-cache-writes", { input_cache_write: "0" }),
    ]);
    expect(entry.cacheWriteCost).toBe(0);
    expect(entry.cacheWriteCost).not.toBeNull();
  });

  it("keeps both directions independently — a reported 0 read beside a real write rate", async () => {
    const [entry] = await normalize([
      model("vendor/mixed", {
        input_cache_read: "0",
        input_cache_write: "0.00000625",
      }),
    ]);
    expect(entry.cacheReadCost).toBe(0);
    expect(entry.cacheWriteCost).toBeCloseTo(6.25, 10);
  });

  it("REGRESSION: an ABSENT cache rate is still NULL, never a priced 0", async () => {
    const [entry] = await normalize([model("vendor/no-cache-pricing", {})]);
    expect(entry.cacheReadCost).toBeNull();
    expect(entry.cacheWriteCost).toBeNull();
  });

  it("REGRESSION: a positive rate is still scaled to dollars per 1M tokens", async () => {
    const [entry] = await normalize([
      model("anthropic/claude-opus-5", {
        input_cache_read: "0.0000005",
        input_cache_write: "0.00001",
      }),
    ]);
    expect(entry.cacheReadCost).toBeCloseTo(0.5, 10);
    expect(entry.cacheWriteCost).toBeCloseTo(10, 10);
    expect(entry.inputCost).toBeCloseTo(5, 10);
    expect(entry.outputCost).toBeCloseTo(15, 10);
  });

  it("NEGATIVE CONTROL: garbage in a cache field is NULL, not 0 and not NaN", async () => {
    const [entry] = await normalize([
      model("vendor/garbage", {
        input_cache_read: "not-a-number",
        input_cache_write: "   ",
      }),
    ]);
    expect(entry.cacheReadCost).toBeNull();
    expect(entry.cacheWriteCost).toBeNull();
  });
});

describe("parseFeedCacheRate — the three outcomes, held apart", () => {
  it("treats absence as no published rate", () => {
    expect(parseFeedCacheRate(undefined)).toBeNull();
    expect(parseFeedCacheRate(null)).toBeNull();
    expect(parseFeedCacheRate("")).toBeNull();
    expect(parseFeedCacheRate("   ")).toBeNull();
  });

  it("treats a reported zero as a price", () => {
    expect(parseFeedCacheRate("0")).toBe(0);
    expect(parseFeedCacheRate("0.0")).toBe(0);
    expect(parseFeedCacheRate(0)).toBe(0);
  });

  it("scales a real rate to dollars per 1M tokens", () => {
    expect(parseFeedCacheRate("0.0000005")).toBeCloseTo(0.5, 10);
    expect(parseFeedCacheRate(0.00001)).toBeCloseTo(10, 10);
  });

  it("refuses to invent a number out of garbage", () => {
    expect(parseFeedCacheRate("abc")).toBeNull();
    expect(parseFeedCacheRate({})).toBeNull();
    expect(parseFeedCacheRate(NaN)).toBeNull();
    expect(parseFeedCacheRate(Infinity)).toBeNull();
  });
});
