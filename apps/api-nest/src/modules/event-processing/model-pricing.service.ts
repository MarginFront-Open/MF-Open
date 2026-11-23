import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  resolveEventPrice,
  isPriceRefused,
  lookupModelInCatalog,
  type CatalogLookupResult,
  type CostEntry,
  type PriceRefusalKind,
  type UnpricedCacheRate,
} from '@marginfront/db';

/**
 * USD, written straight into the Decimal(18,6) column.
 * Non-LLM rows (costUnit !== '1M tokens') put the FULL total in inputCostUsd and
 * leave outputCostUsd and every per-token field at 0 — tokens don't apply there.
 */
export interface TokenCostResult {
  inputCostUsd: Decimal;
  outputCostUsd: Decimal;
  cacheReadCostUsd: Decimal;
  cacheWriteCostUsd: Decimal;
  totalCostUsd: Decimal;
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  modelKey: string;
}

/**
 * Narrow on `.ok`: a refusal carries no cost field at all, which is what stops a
 * caller from reading an unpriced cache rate as $0.
 */
export interface CostRefused {
  ok: false;
  /** 'missing-rate' needs a pricing sync; 'unreadable-count' needs the event's tokens fixed. */
  kind: PriceRefusalKind;
  missingRates: UnpricedCacheRate[];
  reason: string;
  modelKey: string;
}

export type ResolvedCost = { ok: true; cost: TokenCostResult } | CostRefused;

/**
 * api-nest compiles with strictNullChecks OFF, where TypeScript will not narrow
 * a union on its `ok` literal — `if (!r.ok)` leaves both arms merged. Use this.
 */
export function isCostRefused(resolution: ResolvedCost): resolution is CostRefused {
  return !resolution.ok;
}

/**
 * DI wrapper over the canonical pricing library in @marginfront/db, which the seed
 * script and the dashboard backfill import too. Cost arithmetic and the
 * missing-cache-rate guard live there and must never be hand-rolled here.
 */
@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);

  /** Unrecognized costUnits already warned about, so repeat events can't spam the log. */
  private readonly warnedUnits = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Matches exact → date-stripped → org_model_mappings.
   * Null means no match: the caller must leave the cost null, never invent one.
   */
  async lookupModel(
    model: string,
    provider: string,
    organizationId?: string,
  ): Promise<CatalogLookupResult | null> {
    return lookupModelInCatalog(this.prisma, model, provider, organizationId);
  }

  /**
   * The ONE cost path in api-nest. A refusal is a normal outcome, not an error:
   * the caller flags the child NEEDS_COST_BACKFILL with a null cost rather than
   * writing a fabricated $0.
   */
  async resolveCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    quantity: number,
    provider: string,
    preFetchedEntry?: CostEntry,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0,
    // metadata.cacheWriteTtl, untyped on purpose: applyCacheWriteTtl is
    // Anthropic-gated and acts only on the exact string "5m". The
    // stored rate is the 1-hour ceiling, so an unknown TTL can never under-bill.
    cacheWriteTtl?: unknown,
  ): Promise<ResolvedCost> {
    const entry = preFetchedEntry ?? (await this.lookupModel(modelId, provider));

    if (!entry) {
      throw new Error(`Model not recognized: ${modelId} (provider: ${provider})`);
    }

    // One-time warn per unrecognized costUnit (the pure lib doesn't log). Every
    // shape with its own branch in calculateEventCost — "1M tokens", "1K …",
    // "1M …" — must stay excluded, or a "1M " unit would bill 1,000,000× too high.
    const { costUnit } = entry;
    if (
      costUnit !== '1M tokens' &&
      !costUnit.startsWith('1K ') &&
      !costUnit.startsWith('1M ') &&
      !this.warnedUnits.has(costUnit)
    ) {
      this.warnedUnits.add(costUnit);
      this.logger.warn(
        `Non-LLM costUnit "${costUnit}" — using flat per-unit math (quantity × cost). Add explicit handling if this unit appears frequently.`,
      );
    }

    const resolution = resolveEventPrice({
      inputTokens,
      outputTokens,
      quantity,
      entry,
      cacheReadTokens,
      cacheWriteTokens,
      provider,
      cacheWriteTtl,
      model: modelId,
    });

    if (isPriceRefused(resolution)) {
      return {
        ok: false,
        kind: resolution.kind,
        missingRates: resolution.missingRates,
        reason: resolution.reason,
        modelKey: modelId,
      };
    }
    return { ok: true, cost: { ...resolution.price, modelKey: modelId } };
  }

  /**
   * For paths where cache tokens are structurally absent, so they read
   * straight-line instead of narrowing a union that can never refuse. Branded
   * cache params on `calculateEventCost` keep a caller holding real cache counts
   * out of here and on `resolveCost`.
   */
  async calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    quantity: number,
    provider: string,
    preFetchedEntry?: CostEntry,
  ): Promise<TokenCostResult> {
    const resolution = await this.resolveCost(
      modelId,
      inputTokens,
      outputTokens,
      quantity,
      provider,
      preFetchedEntry,
    );
    if (isCostRefused(resolution)) {
      // Unreachable: zero cache tokens can never trip the missing-rate guard.
      throw new Error(`calculateCost refused to price a no-cache event: ${resolution.reason}`);
    }
    return resolution.cost;
  }
}
