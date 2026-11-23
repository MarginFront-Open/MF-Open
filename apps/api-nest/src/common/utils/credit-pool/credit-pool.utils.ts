/**
 * The api-nest adapter over the shared
 * @marginfront/db credit-pool rule. The RULE lives in packages/db; this file only
 * does the three things a Nest service needs and the pure module must not do:
 * merge an incoming patch onto the stored row, turn a structured result into a
 * BadRequestException, and hand back the tiers to persist.
 *
 * There are three api-nest lanes that write pricing_strategies.tiers
 * (createBulk, bulkUpdate, update) plus the plan-copy lane in
 * pricing-plans.service. They share this file so the merge semantics —
 * especially "undefined means leave unchanged" — can't drift between them.
 */

import { BadRequestException } from '@nestjs/common';
import {
  compileCreditPool,
  creditPoolErrorMessage,
  validateCreditPoolInput,
  validateCreditPoolTiers,
  validateCreditRatesReferences,
  validateSinglePoolPerPlan,
  type CreditPoolTier,
  type CreditRatesReferenceInput,
  type PlanStrategyState,
} from '@marginfront/db';

/** The stored row's fields the rule cares about. */
export interface StoredStrategyState {
  pricingModel?: unknown;
  chargeType?: unknown;
  tiers?: unknown;
  minimumCommitment?: unknown;
  active?: unknown;
  creditRates?: unknown;
}

/** The incoming patch's fields the rule cares about. */
export interface StrategyPatch {
  pricingModel?: unknown;
  chargeType?: unknown;
  tiers?: unknown;
  minimumCommitment?: unknown;
  active?: unknown;
  creditPool?: unknown;
  creditRates?: unknown;
  signalId?: unknown;
}

export interface MergedStrategyState {
  pricingModel?: unknown;
  chargeType?: unknown;
  tiers?: unknown;
  minimumCommitment?: unknown;
  active?: unknown;
  creditPool?: unknown;
  creditRates?: unknown;
}

/**
 * The five fields whose arrival makes a write a credit-pool write. Anything
 * else (rename, retag, rate change) is never validated, which is what keeps
 * stored degenerate rows editable. `tiers: null` is NOT a tier write; pinned
 * on all eight lanes, null and undefined both mean "leave the tiers alone"
 * (the same holds for creditRates: `{}` clears, null leaves).
 */
export function touchesCreditPoolFields(patch: StrategyPatch): boolean {
  return (
    patch.tiers != null ||
    patch.creditPool != null ||
    patch.creditRates != null ||
    patch.pricingModel !== undefined ||
    patch.minimumCommitment !== undefined
  );
}

/**
 * Also enough to change whether a plan has a SECOND live pool — flipping a
 * dormant pool strategy back on is the hole a tiers-only trigger leaves open.
 * signalId is on the list because moving a live usage strategy onto
 * a signal a pool's creditRates already name is a membership change too.
 */
export function touchesPoolMembership(patch: StrategyPatch): boolean {
  return (
    touchesCreditPoolFields(patch) ||
    patch.chargeType !== undefined ||
    patch.active !== undefined ||
    patch.signalId !== undefined
  );
}

/** `undefined` means "leave unchanged" on every lane. Pinned here, once. */
export function mergeStrategyState(
  existing: StoredStrategyState,
  patch: StrategyPatch,
): MergedStrategyState {
  const pick = (key: keyof StoredStrategyState) =>
    patch[key] !== undefined ? patch[key] : existing[key];
  return {
    pricingModel: pick('pricingModel'),
    chargeType: pick('chargeType'),
    // tiers and creditRates are the fields where null ALSO means "leave
    // unchanged" — see touchesCreditPoolFields. Everywhere else null is a
    // real value. (creditRates has a real clear spelling: `{}`.)
    tiers: patch.tiers != null ? patch.tiers : existing.tiers,
    creditRates: patch.creditRates != null ? patch.creditRates : existing.creditRates,
    minimumCommitment: pick('minimumCommitment'),
    active: pick('active'),
    creditPool: patch.creditPool,
  };
}

/**
 * Rejects a request carrying BOTH creditPool and tiers. Runs on the RAW patch,
 * before any merge: after merging, a sugar-only PATCH always has stored tiers
 * too, so this can only be asked of the request as it arrived.
 */
export function assertCreditPoolInput(patch: StrategyPatch, label?: string): void {
  const result = validateCreditPoolInput(patch, label);
  if (!result.ok) {
    throw new BadRequestException(creditPoolErrorMessage(result));
  }
}

/**
 * Validates one strategy's merged state and returns the tiers to store, or
 * null when the caller's own tiers stand. Throws 400 with a plain-English
 * message naming the fix.
 */
export function assertCreditPoolShape(
  merged: MergedStrategyState,
  label?: string,
): CreditPoolTier[] | null {
  const result = validateCreditPoolTiers({
    pricingModel: merged.pricingModel,
    tiers: merged.tiers,
    creditPool: merged.creditPool,
    creditRates: merged.creditRates,
    minimumCommitment: merged.minimumCommitment,
    label,
  });
  if (!result.ok) {
    throw new BadRequestException(creditPoolErrorMessage(result));
  }
  return result.compiledTiers;
}

/**
 * The DB-aware creditRates checks: every key a live org signal,
 * no member signal double-billed by its own live usage strategy. The rule and
 * both messages live in @marginfront/db so the dashboard funnel rejects with the
 * exact same words; the service loads the rows and calls this.
 */
export function assertCreditRatesReferences(input: CreditRatesReferenceInput): void {
  const result = validateCreditRatesReferences(input);
  if (!result.ok) {
    throw new BadRequestException(creditPoolErrorMessage(result));
  }
}

/** Rejects a write that would leave the plan with more live pools than it started with. */
export function assertSinglePoolPerPlan(
  afterWrite: PlanStrategyState[],
  beforeWrite: PlanStrategyState[],
): void {
  const result = validateSinglePoolPerPlan(afterWrite, beforeWrite);
  if (!result.ok) {
    throw new BadRequestException(creditPoolErrorMessage(result));
  }
}

/** Re-exported so services import one module, not two. */
export { compileCreditPool };
