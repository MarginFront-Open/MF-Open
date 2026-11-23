/**
 * Every signal_event.usageCost in the platform — SDK ingest, dashboard backfill,
 * seed — is computed by `calculateEventCost` here.
 *
 * The four costUnit branches are ORDER-SENSITIVE:
 *   '1M tokens'     → per-direction token math (EXACT match, must stay first)
 *   '1K <anything>' → ÷1,000
 *   '1M <anything>' → ÷1,000,000
 *   everything else → flat per-unit
 * Let a '1M tokens' row reach the startsWith('1M ') branch and it bills 1,000,000x wrong.
 */

import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

// ─── Types ───────────────────────────────────────────────────────────

export interface CostEntry {
  inputCost: number;
  outputCost: number;
  /**
   * Cache-READ (prompt-cache hit) rate, same cost unit as inputCost. undefined
   * means the row carries NO cache pricing; a stored 0 is a real, free rate.
   */
  cacheReadCost?: number;
  /**
   * Cache-WRITE (prompt-cache creation) rate. On Anthropic LLM rows the STORED
   * value is the 1-hour-TTL ceiling (2× inputCost, written by
   * scripts/sync-service-pricing.ts) so an unknown TTL can never under-bill; only
   * an event proving the 5m flavor is re-based, via applyCacheWriteTtl.
   */
  cacheWriteCost?: number;
  costUnit: string;
}

/**
 * USD, stored straight into the Decimal(18,6) column. On NON-LLM rows inputCostUsd
 * carries the full total and every other field is 0. The cache terms are already
 * SUMMED into totalCostUsd, so a caller reading only the total already includes cache.
 */
export interface EventCostResult {
  inputCostUsd: Decimal;
  outputCostUsd: Decimal;
  cacheReadCostUsd: Decimal;
  cacheWriteCostUsd: Decimal;
  totalCostUsd: Decimal;
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
}

/**
 * A CostEntry plus the row id the SDK ingest path needs to upsert signal_services.
 * Kept off CostEntry so the math layer stays identity-free.
 */
export interface CatalogLookupResult extends CostEntry {
  servicePricingId: string;
}

// ─── Cache-token brand ───────────────────────────────────

declare const GUARDED_CACHE_TOKENS: unique symbol;

/**
 * Compile-time-only brand: passing a raw cache count to `calculateEventCost` is a
 * type error unless it came from `resolveEventPrice` or `unguardedCacheTokens`.
 */
export type GuardedCacheTokenCount = number & {
  readonly [GUARDED_CACHE_TOKENS]: true;
};

/**
 * Escape hatch for callers that own their own unpriced-rate policy: pure-math
 * tests, seeds, estimators. Named to be greppable — using it on a path that WRITES
 * a billable cost allows a silent under-bill.
 */
export function unguardedCacheTokens(count: number): GuardedCacheTokenCount {
  return count as GuardedCacheTokenCount;
}

// ─── Pure cost calculation ───────────────────────────────────────────

/**
 * Pure USD math for one usage event. It cannot refuse: handed cache tokens against
 * a NULL cache rate it prices them at $0 and returns a number that looks final, so
 * any path that WRITES a billable cost must go through `resolveEventPrice`.
 */
export function calculateEventCost(
  inputTokens: number,
  outputTokens: number,
  quantity: number,
  entry: CostEntry,
  // Default 0: a caller without cache counts gets the two-term cost, since a 0 count contributes $0
  // whatever the rate. Branded, not plain `number`, so the one input shape with no
  // correct answer — a positive count against a NULL rate — cannot arrive unguarded.
  // The literal 0 stays assignable and can never trip the guard.
  cacheReadTokens: GuardedCacheTokenCount | 0 = 0,
  cacheWriteTokens: GuardedCacheTokenCount | 0 = 0,
): EventCostResult {
  const { inputCost, outputCost, costUnit } = entry;
  // Coercing an ABSENT rate to 0 here is exactly what resolveEventPrice guards upstream.
  const cacheReadCost = entry.cacheReadCost ?? 0;
  const cacheWriteCost = entry.cacheWriteCost ?? 0;

  // LLM branch — cost is per 1M tokens, quantity is metadata only.
  if (costUnit === "1M tokens") {
    const inputCostPerToken = inputCost / 1_000_000;
    const outputCostPerToken = outputCost / 1_000_000;
    const cacheReadCostPerToken = cacheReadCost / 1_000_000;
    const cacheWriteCostPerToken = cacheWriteCost / 1_000_000;

    const inputCostUsd = new Decimal(inputTokens).mul(
      new Decimal(inputCostPerToken),
    );
    const outputCostUsd = new Decimal(outputTokens).mul(
      new Decimal(outputCostPerToken),
    );
    // Folded into the single usageCost column rather than a new one, so the parent
    // SUM rollup stays correct (CANON C1).
    const cacheReadCostUsd = new Decimal(cacheReadTokens).mul(
      new Decimal(cacheReadCostPerToken),
    );
    const cacheWriteCostUsd = new Decimal(cacheWriteTokens).mul(
      new Decimal(cacheWriteCostPerToken),
    );
    const totalCostUsd = inputCostUsd
      .add(outputCostUsd)
      .add(cacheReadCostUsd)
      .add(cacheWriteCostUsd);

    return {
      inputCostUsd,
      outputCostUsd,
      cacheReadCostUsd,
      cacheWriteCostUsd,
      totalCostUsd,
      inputCostPerToken,
      outputCostPerToken,
      cacheReadCostPerToken,
      cacheWriteCostPerToken,
    };
  }

  // Per-1K-unit branch — AWS Textract pages, SendGrid emails. Cache is an LLM-only
  // concept, hence the hard zeros.
  if (costUnit.startsWith("1K ")) {
    const totalCostUsd = new Decimal(quantity).mul(inputCost).div(1000);
    return {
      inputCostUsd: totalCostUsd,
      outputCostUsd: new Decimal(0),
      cacheReadCostUsd: new Decimal(0),
      cacheWriteCostUsd: new Decimal(0),
      totalCostUsd,
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheReadCostPerToken: 0,
      cacheWriteCostPerToken: 0,
    };
  }

  // Per-1M-unit branch — Pinecone read units, Cloud Run requests, TTS characters:
  // priced "per 1,000,000 things," exactly as the "1K " rows are per 1,000.
  //
  // ORDER MATTERS: "1M tokens" already returned via the exact check above, so this
  // startsWith only ever sees NON-token units. Move it above that branch, or remove
  // it so these rows fall through to the flat fallback, and they bill
  // 1,000,000x high: 5M Pinecone reads at $2/1M as
  // $10,000,000 instead of $10. Cache is LLM-only, hence the hard zeros.
  if (costUnit.startsWith("1M ")) {
    const totalCostUsd = new Decimal(quantity).mul(inputCost).div(1_000_000);
    return {
      inputCostUsd: totalCostUsd,
      outputCostUsd: new Decimal(0),
      cacheReadCostUsd: new Decimal(0),
      cacheWriteCostUsd: new Decimal(0),
      totalCostUsd,
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheReadCostPerToken: 0,
      cacheWriteCostPerToken: 0,
    };
  }

  // Flat per-unit branch — image, minute, second, request, etc.
  const totalCostUsd = new Decimal(quantity).mul(inputCost);
  return {
    inputCostUsd: totalCostUsd,
    outputCostUsd: new Decimal(0),
    cacheReadCostUsd: new Decimal(0),
    cacheWriteCostUsd: new Decimal(0),
    totalCostUsd,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    cacheReadCostPerToken: 0,
    cacheWriteCostPerToken: 0,
  };
}

// ─── Cache-write TTL resolution ──────────────────────────

// Anthropic's published ratio: 5-minute cache writes bill at 1.25× base input
// (1-hour writes at 2× — the ceiling the sync script stores).
export const ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER = 1.25;

/**
 * Re-base an entry's cacheWriteCost for an event that proved the 5-minute
 * prompt-cache flavor (metadata.cacheWriteTtl === "5m", stamped by the
 * code-cost-clarity meter). service_pricing stores the 1-hour ceiling (2× input) so an unknown
 * TTL never under-bills; this is the ONE place the 5m rate (1.25× input) is derived
 * and EVERY re-pricer must route through it — the dashboard backfill calls
 * calculateEventCost directly, so a wrapper-only branch would silently re-price a
 * 5m event back at 2× on recompute. Returns the SAME entry unless every guard passes.
 */
export function applyCacheWriteTtl<T extends CostEntry>(
  entry: T,
  provider: string | null | undefined,
  cacheWriteTtl: unknown,
): T {
  // The hint is untrusted event metadata: only the exact (trimmed,
  // case-folded) string "5m" acts. "1h", absent, or garbage keep the ceiling.
  if (typeof cacheWriteTtl !== "string") return entry;
  if (cacheWriteTtl.trim().toLowerCase() !== "5m") return entry;
  // The 5m/1h ratio is Anthropic's; other providers' cache rates are feed
  // values, not input-derivable.
  if ((provider ?? "").trim().toLowerCase() !== "anthropic") return entry;
  if (entry.costUnit !== "1M tokens") return entry;
  // A row with NO cache-write pricing must stay that way: deriving a rate here
  // would price cache the catalog never priced, and desync the null-keyed guard.
  if (entry.cacheWriteCost == null) return entry;
  // Mirrors the sync override's inputCost guard; also rejects NaN.
  if (!(entry.inputCost > 0)) return entry;
  return {
    ...entry,
    cacheWriteCost: entry.inputCost * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
  };
}

// ─── Guarded pricing ─────────────────────────────────────

/** Which cache direction's rate the resolved row is missing. */
export type UnpricedCacheRate = "cacheReadCost" | "cacheWriteCost";

/** The two refusals have different remedies — never collapse them into one message. */
export type PriceRefusalKind = "missing-rate" | "unreadable-count";

export interface PriceRefused {
  ok: false;
  kind: PriceRefusalKind;
  /** Always non-empty. Ordered read-then-write for stable log/message text. */
  missingRates: UnpricedCacheRate[];
  /** Operator-facing sentence: what happened, why, what to do. */
  reason: string;
}

export interface PriceResolved {
  ok: true;
  price: EventCostResult;
  /** The entry actually priced — post-TTL re-base, so callers can log the rate used. */
  entry: CostEntry;
}

export type PriceResolution = PriceResolved | PriceRefused;

/**
 * For packages compiled without strictNullChecks (api-nest): there TypeScript will
 * not narrow this union on its `ok` literal, so a bare `if (!resolution.ok)` leaves
 * both arms merged and every field access errors. Strict packages: prefer `!ok`.
 */
export function isPriceRefused(
  resolution: PriceResolution,
): resolution is PriceRefused {
  return !resolution.ok;
}

export interface ResolveEventPriceArgs {
  inputTokens: number;
  outputTokens: number;
  quantity: number;
  entry: CostEntry;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** Gates the Anthropic-only 5m cache-write re-base. */
  provider?: string | null;
  /** Raw, untrusted `metadata.cacheWriteTtl`; only the exact string "5m" acts. */
  cacheWriteTtl?: unknown;
  /** Cosmetic only — names the model in the refusal sentence. */
  model?: string | null;
}

/**
 * Price an event, or refuse to. `calculateEventCost` cannot say no: hand it cache
 * tokens against a row whose cache rate is NULL and it coerces that rate to $0 and
 * returns a number that looks final — the under-bill-in-silence CANON C1 forbids.
 * Most active "1M tokens" rows have no cacheWriteCost, so this is the entry point
 * every path that WRITES a billable cost must use.
 *
 * The refusal is deliberately narrow on both axes:
 *   - per EVENT, not per model: only a POSITIVE reported count for a direction whose
 *     rate is null. A genuine $0 IS a price — `toLookupResult` keeps it as 0, not
 *     undefined, so "free" stays distinguishable from "unknown".
 *   - per COST UNIT: only the "1M tokens" branch prices cache at all; the others
 *     return a hard 0 whatever counts they get, so their totals are already right.
 *     Every active non-token row carries a NULL cache rate, so refusing there would
 *     reject correct prices forever.
 */
export function resolveEventPrice(
  args: ResolveEventPriceArgs,
): PriceResolution {
  const { entry, provider, cacheWriteTtl, model } = args;
  const cacheReadTokens = Number(args.cacheReadTokens ?? 0);
  const cacheWriteTokens = Number(args.cacheWriteTokens ?? 0);
  const named = model != null ? `Model "${model}"` : "The resolved model";
  const withProvider = provider != null ? ` (provider "${provider}")` : "";

  if (entry.costUnit === "1M tokens") {
    // `Number(x ?? 0)` is NaN for a string, an object or a NaN, and `NaN > 0` is
    // false — an unreadable count would slip the rate checks below and the
    // multiplier would return a NaN dollar amount that looks final.
    const unreadableCounts: UnpricedCacheRate[] = [];
    if (!Number.isFinite(cacheReadTokens)) {
      unreadableCounts.push("cacheReadCost");
    }
    if (!Number.isFinite(cacheWriteTokens)) {
      unreadableCounts.push("cacheWriteCost");
    }
    if (unreadableCounts.length > 0) {
      const direction = unreadableCounts
        .map((r) =>
          r === "cacheReadCost" ? "cacheReadTokens" : "cacheWriteTokens",
        )
        .join(" and ");
      return {
        ok: false,
        kind: "unreadable-count",
        missingRates: unreadableCounts,
        reason:
          `${named}${withProvider} reported ${direction} that could not be read as a number ` +
          `(cacheReadTokens=${String(args.cacheReadTokens)}, cacheWriteTokens=${String(args.cacheWriteTokens)}). ` +
          `Multiplying an unreadable count by a rate produces a NaN cost, so the event is stored ` +
          `with usageCost: null and flagged NEEDS_COST_BACKFILL. Correct the reported cache token ` +
          `counts for this event, then re-map/backfill to resolve.`,
      };
    }

    // Checked PRE-TTL: applyCacheWriteTtl is null-preserving, so the post-TTL entry
    // gives the same verdict, keeping this provably equal to the ingest detector.
    const missingRates: UnpricedCacheRate[] = [];
    if (cacheReadTokens > 0 && entry.cacheReadCost == null) {
      missingRates.push("cacheReadCost");
    }
    if (cacheWriteTokens > 0 && entry.cacheWriteCost == null) {
      missingRates.push("cacheWriteCost");
    }

    if (missingRates.length > 0) {
      return {
        ok: false,
        kind: "missing-rate",
        missingRates,
        reason:
          `${named}${withProvider} resolved to a pricing row missing ` +
          `${missingRates.join(" and ")}, but the event reported cache tokens ` +
          `(cacheReadTokens=${cacheReadTokens}, cacheWriteTokens=${cacheWriteTokens}). ` +
          `Pricing the missing cache rate(s) at $0 would under-state cost, so the event is ` +
          `stored with usageCost: null and flagged NEEDS_COST_BACKFILL. Populate the missing ` +
          `cache rate(s) for this model (run the pricing sync), then re-map/backfill to resolve.`,
      };
    }
  }

  const pricedEntry = applyCacheWriteTtl(entry, provider, cacheWriteTtl);
  return {
    ok: true,
    entry: pricedEntry,
    price: calculateEventCost(
      args.inputTokens,
      args.outputTokens,
      args.quantity,
      pricedEntry,
      unguardedCacheTokens(cacheReadTokens),
      unguardedCacheTokens(cacheWriteTokens),
    ),
  };
}

// ─── Model lookup ────────────────────────────────────────────────────

/**
 * Look up a model/service in service_pricing. All three match strategies are
 * provider-scoped, to prevent cross-provider collisions.
 *
 * Returns null when nothing matches — callers must NOT fall back to a made-up cost.
 * The event is stored with usageCost null and eventProcessed = NEEDS_COST_BACKFILL.
 *
 * Takes a plain PrismaClient, not the NestJS PrismaService, so the seed and the
 * dashboard can call it without NestJS DI.
 */
export async function lookupModelInCatalog(
  prisma: PrismaClient,
  model: string,
  provider: string,
  organizationId?: string,
): Promise<CatalogLookupResult | null> {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedModel || !normalizedProvider) return null;

  let entry = await prisma.service_pricing.findFirst({
    where: {
      canonicalName: normalizedModel,
      provider: normalizedProvider,
      isActive: true,
    },
  });
  if (entry) return toLookupResult(entry);

  // Strip a trailing date/version suffix and retry: OpenAI "gpt-4o-2024-08-06",
  // Gemini "-001", Anthropic "-YYYYMMDD".
  const stripped = normalizedModel.replace(
    /-(\d{4}-\d{2}-\d{2}|\d{6,8}|\d{3})$/,
    "",
  );
  if (stripped !== normalizedModel && stripped.length > 0) {
    entry = await prisma.service_pricing.findFirst({
      where: {
        canonicalName: stripped,
        provider: normalizedProvider,
        isActive: true,
      },
    });
    if (entry) return toLookupResult(entry);
  }

  if (organizationId) {
    const mapping = await prisma.org_model_mappings.findUnique({
      where: {
        organizationId_sourceModel_sourceProvider: {
          organizationId,
          sourceModel: normalizedModel,
          sourceProvider: normalizedProvider,
        },
      },
      include: { service_pricing: true },
    });
    if (mapping?.service_pricing) {
      return toLookupResult(mapping.service_pricing);
    }
  }

  return null;
}

/** Prisma hands back Decimal cost columns; the math layer takes plain numbers. */
function toLookupResult(entry: {
  id: string;
  inputCost: unknown;
  outputCost: unknown;
  cacheReadCost?: unknown;
  cacheWriteCost?: unknown;
  costUnit: string;
}): CatalogLookupResult {
  return {
    servicePricingId: entry.id,
    inputCost: entry.inputCost ? Number(entry.inputCost) : 0,
    outputCost: entry.outputCost ? Number(entry.outputCost) : 0,
    // `!= null`, NEVER a truthy check: a stored $0.00 cache rate is falsy, so a
    // truthy test would collapse a legitimately-free row into "no cache pricing at
    // all" and the null-keyed missing-rate guard would false-flag a fully-priced
    // event NEEDS_COST_BACKFILL. A stored 0 is a PRICED zero; null is an ABSENT price.
    cacheReadCost:
      entry.cacheReadCost != null ? Number(entry.cacheReadCost) : undefined,
    cacheWriteCost:
      entry.cacheWriteCost != null ? Number(entry.cacheWriteCost) : undefined,
    costUnit: entry.costUnit,
  };
}
