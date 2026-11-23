/**
 * WHAT THIS FILE DOES: a health report over service_pricing that lists the
 * rows half-priced for prompt caching: one of cacheReadCost / cacheWriteCost
 * filled in and the other absent. See findIncompleteCachePricing for why
 * "half" is narrower than it first looks.
 *
 * Exits 1 when it finds any, so a scheduled job can tell "all good" from
 * "rates need a human eyeball" without parsing text.
 *
 * WHY IT EXISTS: a row with a cache-read rate and no cache-write rate fires no
 * other signal, and the missing direction prices at nothing.
 *
 * Uses whatever DATABASE_URL is set, same as the sync script.
 *
 * Run with: npx tsx packages/db/scripts/report-cache-pricing.ts [--json]
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type CacheGapSignature =
  | "READ-PRICED-WRITE-MISSING"
  | "WRITE-PRICED-READ-MISSING";

export interface CachePricingRow {
  externalId: string;
  displayName: string;
  provider: string;
  source: string;
  canonicalName: string;
  costUnit: string;
  inputCost: { toString(): string } | null;
  cacheReadCost: { toString(): string } | null;
  cacheWriteCost: { toString(): string } | null;
}

export interface CacheGapFinding {
  externalId: string;
  displayName: string;
  provider: string;
  source: string;
  costUnit: string;
  signature: CacheGapSignature;
  inputCost: string | null;
  cacheReadCost: string | null;
  cacheWriteCost: string | null;
  /** The catalog fact that makes this row's null indefensible. */
  evidence: string;
}

// ":batch" / ":thinking" / ":free" is a price TIER of one model, not a
// separate model — so the tiers must agree about whether writes are billable.
export function variantBase(canonicalName: string): string {
  return canonicalName.split(":")[0];
}

// NUL separator: no provider or model name contains one, so "openai" + "x:y"
// can never collide with "openai:x" + "y".
function familyKey(provider: string, base: string): string {
  return `${provider}\u0000${base}`;
}

// A stored 0 is a PRICED ZERO, only absence is an absent price. Never a
// truthiness check: Decimal(0) is truthy where number 0 is not, so that
// mistake would show up only against real Prisma rows.
function isPriced(value: { toString(): string } | null | undefined): boolean {
  return value !== null && value !== undefined;
}

function money(
  value: { toString(): string } | null | undefined,
): string | null {
  return isPriced(value) ? value!.toString() : null;
}

/**
 * Finds rows that are half-priced for prompt caching.
 *
 * Each signature must carry its own proof that the null is a DEFECT and not a
 * fact about the vendor. The naive "read priced, write null" shape matches a
 * seventh of a real catalog: providers whose cache writes are genuinely free,
 * reported correctly by the feeds. Do not loosen either signature into that
 * shape; a monitor firing on that much of the catalog hides the real gaps.
 */
export function findIncompleteCachePricing(
  rows: CachePricingRow[],
): CacheGapFinding[] {
  const writePricedBases = new Set<string>();
  for (const row of rows) {
    if (isPriced(row.cacheWriteCost)) {
      writePricedBases.add(
        familyKey(row.provider, variantBase(row.canonicalName)),
      );
    }
  }

  const findings: CacheGapFinding[] = [];
  for (const row of rows) {
    const readPriced = isPriced(row.cacheReadCost);
    const writePriced = isPriced(row.cacheWriteCost);
    if (readPriced === writePriced) continue;

    let signature: CacheGapSignature;
    let evidence: string;
    if (writePriced) {
      signature = "WRITE-PRICED-READ-MISSING";
      evidence =
        "bills to write the prompt cache but has no read rate; no provider sells paid writes with free reads";
    } else {
      const base = variantBase(row.canonicalName);
      if (!writePricedBases.has(familyKey(row.provider, base))) continue;
      signature = "READ-PRICED-WRITE-MISSING";
      evidence = `another active ${row.provider}/${base} tier carries a cache-write rate, so this one's null contradicts it`;
    }

    findings.push({
      externalId: row.externalId,
      displayName: row.displayName,
      provider: row.provider,
      source: row.source,
      costUnit: row.costUnit,
      signature,
      inputCost: money(row.inputCost),
      cacheReadCost: money(row.cacheReadCost),
      cacheWriteCost: money(row.cacheWriteCost),
      evidence,
    });
  }

  findings.sort((a, b) => a.externalId.localeCompare(b.externalId));
  return findings;
}

function printCacheGapReport(findings: CacheGapFinding[]) {
  console.log("=== Cache-Pricing Completeness ===\n");
  console.log(`Half-priced cache rows: ${findings.length}\n`);
  for (const finding of findings) {
    console.log(`  ${finding.externalId}  [${finding.displayName}]`);
    console.log(
      `    ${finding.signature} — input ${finding.inputCost ?? "null"}, ` +
        `cacheRead ${finding.cacheReadCost ?? "null"}, ` +
        `cacheWrite ${finding.cacheWriteCost ?? "null"} per ${finding.costUnit} (${finding.source})`,
    );
    console.log(`    why: ${finding.evidence}`);
  }
  if (findings.length > 0) console.log("");
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const jsonMode = argv.includes("--json");

  const cacheRows = await prisma.service_pricing.findMany({
    where: { isActive: true },
    select: {
      externalId: true,
      displayName: true,
      provider: true,
      source: true,
      canonicalName: true,
      costUnit: true,
      inputCost: true,
      cacheReadCost: true,
      cacheWriteCost: true,
    },
    orderBy: { externalId: "asc" },
  });

  const cachePricingGaps = findIncompleteCachePricing(cacheRows);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          counts: { cachePricingGaps: cachePricingGaps.length },
          cachePricingGaps,
        },
        null,
        2,
      ),
    );
  } else {
    printCacheGapReport(cachePricingGaps);
  }

  // 1 means "rates need a human"; 2 is kept for a crash.
  if (cachePricingGaps.length > 0) {
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

// Guarded so tests can import the check without firing a DB read on load.
if (require.main === module) {
  main().catch((err) => {
    console.error("Cache-pricing report failed:", err);
    prisma.$disconnect();
    process.exit(2);
  });
}
