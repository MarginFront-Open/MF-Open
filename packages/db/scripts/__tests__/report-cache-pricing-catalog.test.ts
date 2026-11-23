/**
 * The cache-completeness check run against a real price catalog.
 *
 * fixtures/price-catalog-2026-08-17.json holds the LiteLLM rows of a public
 * price catalog captured on 2026-08-17: 958 rows, vendor model names and
 * public list prices only. Hand-built fixtures can miss real
 * shapes; this suite grades the rule against the catalog it has to survive.
 *
 * The assertions are INVARIANTS, not a pinned row list. The feeds re-price
 * weekly, so a list of "these 17 externalIds" would go red on vendor churn.
 * What must never drift: the check stays a rare signal, it never fires on
 * either non-partial state, and it still catches a family of :batch tiers
 * that left out the cache-write rate their sibling publishes.
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
import PRICE_CATALOG from "./fixtures/price-catalog-2026-08-17.json";

// An invented model family: the base tier publishes a cache-write rate and six
// :batch tiers leave it out. Mixed into the real catalog, the check must find
// exactly these six.
const HALF_PRICED_BATCH_ROWS = [
  "acme/zephyr-9-pro:batch",
  "acme/zephyr-9:batch",
  "acme/zephyr-9-mini:batch",
  "acme/zephyr-9-mini-pro:batch",
  "acme/zephyr-9-nano:batch",
  "acme/zephyr-9-nano-pro:batch",
];

function inventedRow(
  externalId: string,
  cacheWriteCost: string | null,
): CachePricingRow {
  const canonicalName = externalId.split("/")[1];
  return {
    externalId,
    displayName: canonicalName,
    provider: "acme",
    source: "litellm",
    canonicalName,
    costUnit: "1M tokens",
    inputCost: "2.0000000000",
    cacheReadCost: "0.2000000000",
    cacheWriteCost,
  };
}

const INVENTED_FAMILY: CachePricingRow[] = [
  ...HALF_PRICED_BATCH_ROWS.map((externalId) =>
    inventedRow(externalId.replace(":batch", ""), "2.5000000000"),
  ),
  ...HALF_PRICED_BATCH_ROWS.map((externalId) => inventedRow(externalId, null)),
];

// psql renders Decimal as a string and NULL as JSON null, which is exactly the
// null-vs-priced-zero distinction the check turns on.
const REAL_CATALOG = PRICE_CATALOG as CachePricingRow[];
const CATALOG = [...REAL_CATALOG, ...INVENTED_FAMILY];

const FINDINGS = findIncompleteCachePricing(CATALOG);
const FLAGGED = new Set(FINDINGS.map((f) => f.externalId));

describe("the real price catalog", () => {
  it("has 958 active rows", () => {
    expect(REAL_CATALOG).toHaveLength(958);
  });

  it("flags all six half-priced :batch rows", () => {
    for (const externalId of HALF_PRICED_BATCH_ROWS) {
      expect(FLAGGED.has(externalId), `${externalId} must be flagged`).toBe(
        true,
      );
    }
  });

  it("stays a rare signal: under 3% of the catalog", () => {
    expect(FINDINGS.length).toBeGreaterThan(0);
    expect(FINDINGS.length / CATALOG.length).toBeLessThan(0.03);
  });

  it("kills the naive rule: the raw read-priced/write-null shape hits hundreds of rows, the check hits a fraction of them", () => {
    const naive = CATALOG.filter(
      (r) => r.cacheReadCost !== null && r.cacheWriteCost === null,
    );
    const tightened = FINDINGS.filter(
      (f) => f.signature === "READ-PRICED-WRITE-MISSING",
    );

    expect(naive.length).toBeGreaterThan(100);
    expect(tightened.length).toBeLessThan(naive.length / 10);
  });

  it("NEGATIVE CONTROL: never flags a row with no cache pricing at all", () => {
    const noCachePricing = CATALOG.filter(
      (r) => r.cacheReadCost === null && r.cacheWriteCost === null,
    );

    expect(noCachePricing.length).toBeGreaterThan(0);
    for (const row of noCachePricing) {
      expect(FLAGGED.has(row.externalId), `${row.externalId}`).toBe(false);
    }
  });

  it("NEGATIVE CONTROL: never flags a fully-priced cache row", () => {
    const fullyPriced = CATALOG.filter(
      (r) => r.cacheReadCost !== null && r.cacheWriteCost !== null,
    );

    expect(fullyPriced.length).toBeGreaterThan(0);
    for (const row of fullyPriced) {
      expect(FLAGGED.has(row.externalId), `${row.externalId}`).toBe(false);
    }
  });

  it("every finding is genuinely half-priced, and every READ-PRICED one names a real witness row", () => {
    const byExternalId = new Map(CATALOG.map((r) => [r.externalId, r]));

    for (const finding of FINDINGS) {
      const row = byExternalId.get(finding.externalId)!;
      const halves = [row.cacheReadCost, row.cacheWriteCost];
      expect(halves.filter((h) => h !== null)).toHaveLength(1);

      if (finding.signature !== "READ-PRICED-WRITE-MISSING") continue;
      const base = variantBase(row.canonicalName);
      const witness = CATALOG.find(
        (candidate) =>
          candidate.provider === row.provider &&
          variantBase(candidate.canonicalName) === base &&
          candidate.cacheWriteCost !== null,
      );
      expect(witness, `no witness for ${finding.externalId}`).toBeDefined();
    }
  });

  it("a witness only ever comes from the same provider", () => {
    for (const finding of FINDINGS) {
      if (finding.signature !== "READ-PRICED-WRITE-MISSING") continue;
      expect(finding.evidence).toContain(`${finding.provider}/`);
    }
  });
});
