/**
 * Suite for the cache-pricing completeness check in
 * report-cache-pricing.ts.
 *
 * Model names are invented; every row keeps the field shape a real catalog
 * row has (Decimal-like prices, null versus priced zero, :batch and :thinking
 * tiers), because a shape that drifts from the real one can pass while the
 * real rows are broken.
 *
 * What it pins: the PARTIAL signature is flagged, both non-partial states are
 * NOT (a row with no cache pricing at all, and a fully-priced row), a priced
 * zero is a price and not an absence, and the naive rule (flag every
 * read-priced, write-null row) never fires.
 */

import { describe, expect, it, vi } from "vitest";

// report-cache-pricing.ts does `new PrismaClient()` at module scope, and CI runs
// this package's test task BEFORE `prisma generate` — so importing it there dies
// on "did not initialize yet". Nothing in this file touches a database, so a bare
// stub is enough. sync-service-pricing.test.ts uses the same trick with a proxy
// because it does need a fake client; here there is nothing to fake.
vi.mock("@prisma/client", () => ({ PrismaClient: class {} }));

import {
  findIncompleteCachePricing,
  variantBase,
  type CachePricingRow,
} from "../report-cache-pricing";

/**
 * Prisma hands back Decimal, not number. A Decimal is truthy at zero, a number
 * is not — so a check written against numbers can pass here and still be wrong
 * in production. These stand in for Decimal: object identity, string rendering,
 * and a real 0 that must never be mistaken for null.
 */
function dec(value: string): { toString(): string } {
  return { toString: () => value };
}

function row(overrides: Partial<CachePricingRow>): CachePricingRow {
  return {
    externalId: "acme/example",
    displayName: "Example",
    provider: "acme",
    source: "litellm",
    canonicalName: "example",
    costUnit: "1M tokens",
    inputCost: dec("1"),
    cacheReadCost: null,
    cacheWriteCost: null,
    ...overrides,
  };
}

// The :batch rows are the defect; their non-batch twins are the witness that
// proves it is a defect.
const ZEPHYR_FAMILY: CachePricingRow[] = [
  row({
    externalId: "acme/zephyr-9",
    displayName: "Acme: Zephyr 9",
    canonicalName: "zephyr-9",
    inputCost: dec("5"),
    cacheReadCost: dec("0.5"),
    cacheWriteCost: dec("6.25"),
  }),
  row({
    externalId: "acme/zephyr-9:batch",
    displayName: "Acme: Zephyr 9 (batch)",
    canonicalName: "zephyr-9:batch",
    inputCost: dec("2.5"),
    cacheReadCost: dec("0.25"),
    cacheWriteCost: null,
  }),
  row({
    externalId: "acme/zephyr-9x",
    displayName: "Acme: Zephyr 9X",
    canonicalName: "zephyr-9x",
    inputCost: dec("1"),
    cacheReadCost: dec("0.1"),
    cacheWriteCost: dec("1.25"),
  }),
  row({
    externalId: "acme/zephyr-9x:batch",
    displayName: "Acme: Zephyr 9X (batch)",
    canonicalName: "zephyr-9x:batch",
    inputCost: dec("1"),
    cacheReadCost: dec("0.1"),
    cacheWriteCost: null,
  }),
];

describe("findIncompleteCachePricing — the defect it was built for", () => {
  it("flags acme/zephyr-9:batch: cache-read priced, cache-write null, and its non-batch twin proves writes are billable", () => {
    const findings = findIncompleteCachePricing(ZEPHYR_FAMILY);

    expect(findings.map((f) => f.externalId)).toEqual([
      "acme/zephyr-9:batch",
      "acme/zephyr-9x:batch",
    ]);
    const sol = findings[0];
    expect(sol.signature).toBe("READ-PRICED-WRITE-MISSING");
    expect(sol.cacheReadCost).toBe("0.25");
    expect(sol.cacheWriteCost).toBeNull();
    expect(sol.evidence).toContain("acme/zephyr-9");
  });

  it("flags the reverse partial with no witness needed — paid writes and free reads is not a pricing model anyone sells", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "orbit/orbit-plus-2:thinking",
        displayName: "Orbit: Orbit Plus 2 (thinking)",
        provider: "orbit",
        canonicalName: "orbit-plus-2:thinking",
        inputCost: dec("0.4"),
        cacheReadCost: null,
        cacheWriteCost: dec("0.5"),
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].signature).toBe("WRITE-PRICED-READ-MISSING");
  });
});

describe("negative controls — a check that flags everything is worthless", () => {
  it("a row with NO cache pricing at all is silent: caching does not apply to it", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "acme/zephyr-8-pro",
        canonicalName: "zephyr-8-pro",
        inputCost: dec("30"),
        cacheReadCost: null,
        cacheWriteCost: null,
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("a fully-priced cache row is silent", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "acme/zephyr-9",
        canonicalName: "zephyr-9",
        inputCost: dec("5"),
        cacheReadCost: dec("0.5"),
        cacheWriteCost: dec("6.25"),
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("read-priced + write-null with NO write-priced sibling is silent — that is the naive rule, and it stays dead", () => {
    // A provider that discounts cached reads and charges nothing to write.
    // Nothing in the catalog contradicts the null.
    const findings = findIncompleteCachePricing([
      row({
        externalId: "acme/zephyr-8",
        canonicalName: "zephyr-8",
        inputCost: dec("5"),
        cacheReadCost: dec("0.5"),
        cacheWriteCost: null,
      }),
      row({
        externalId: "acme/zephyr-8:batch",
        canonicalName: "zephyr-8:batch",
        inputCost: dec("2.5"),
        cacheReadCost: dec("0.25"),
        cacheWriteCost: null,
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("the witness does not leak across providers — bedrock_mantle pricing zephyr-9 says nothing about acme's tiers", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "litellm/bedrock_mantle/acme.zephyr-9",
        provider: "bedrock_mantle",
        source: "litellm",
        canonicalName: "acme.zephyr-9",
        inputCost: dec("5.5"),
        cacheReadCost: dec("0.55"),
        cacheWriteCost: dec("6.875"),
      }),
      row({
        externalId: "acme/zephyr-9:batch",
        canonicalName: "zephyr-9:batch",
        inputCost: dec("2.5"),
        cacheReadCost: dec("0.25"),
        cacheWriteCost: null,
      }),
    ]);

    expect(findings).toEqual([]);
  });
});

describe("priced zero is not an absent price", () => {
  it("cacheWriteCost 0 counts as PRICED — the row is complete and stays silent", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "vendor/free-cache-writes",
        canonicalName: "free-cache-writes",
        cacheReadCost: dec("0.1"),
        cacheWriteCost: dec("0"),
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("a priced-zero sibling is still a valid witness against a null sibling", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "vendor/base",
        canonicalName: "base",
        cacheReadCost: dec("0.1"),
        cacheWriteCost: dec("0"),
      }),
      row({
        externalId: "vendor/base:batch",
        canonicalName: "base:batch",
        cacheReadCost: dec("0.05"),
        cacheWriteCost: null,
      }),
    ]);

    expect(findings.map((f) => f.externalId)).toEqual(["vendor/base:batch"]);
  });

  it("cacheReadCost 0 with a null write is still a partial when a witness exists", () => {
    const findings = findIncompleteCachePricing([
      row({
        externalId: "vendor/base",
        canonicalName: "base",
        cacheReadCost: dec("0.1"),
        cacheWriteCost: dec("1.25"),
      }),
      row({
        externalId: "vendor/base:batch",
        canonicalName: "base:batch",
        cacheReadCost: dec("0"),
        cacheWriteCost: null,
      }),
    ]);

    expect(findings.map((f) => f.externalId)).toEqual(["vendor/base:batch"]);
  });
});

describe("variantBase", () => {
  it("strips the price tier and leaves a plain model name alone", () => {
    expect(variantBase("zephyr-9:batch")).toBe("zephyr-9");
    expect(variantBase("orbit-plus-2:thinking")).toBe("orbit-plus-2");
    expect(variantBase("zephyr-9")).toBe("zephyr-9");
  });
});

describe("regression: a catalog full of read-priced, write-null rows", () => {
  it("finds only the real defect among hundreds of rows the naive rule would flag", () => {
    // 340 rows in the most common shape: read priced, write null, no
    // write-priced sibling anywhere. Plus the one real defect.
    const catalog: CachePricingRow[] = [];
    for (let i = 0; i < 340; i++) {
      catalog.push(
        row({
          externalId: `feed/model-${i}`,
          canonicalName: `model-${i}`,
          provider: "assorted",
          cacheReadCost: dec("0.1"),
          cacheWriteCost: null,
        }),
      );
    }
    catalog.push(...ZEPHYR_FAMILY);

    const findings = findIncompleteCachePricing(catalog);

    expect(findings.map((f) => f.externalId)).toEqual([
      "acme/zephyr-9:batch",
      "acme/zephyr-9x:batch",
    ]);
  });
});
