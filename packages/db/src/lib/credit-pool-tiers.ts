/**
 * credit-pool-tiers.ts: the ONE shape rule for a
 * credit-pool strategy, kept pure and dependency-free (no Prisma, no Nest, no
 * clock) so every lane that can write `pricing_strategies.tiers` imports the
 * same rule instead of re-deriving it. Eight lanes write tiers (four in
 * api-nest, four in the dashboard); a pool that is valid on one of them and
 * nonsense on the next is the failure this module exists to prevent.
 *
 * The canonical shape is the one `calcCreditPool` (revenue-calc.ts) already
 * bills and `poolSizeFromTiers` (credit-ledger.ts) already mints against:
 *
 *   tiers[0] = pool     { lower: 0,        upper: poolSize, rate: poolPrice }
 *   tiers[1] = overage  { lower: poolSize, upper: null,     rate: overageRate }
 *
 * tiers[0].rate is a FLAT fee for the whole pool; tiers[1].rate is per-unit.
 * That asymmetry is the documented foot-gun the `creditPool` sugar removes:
 * callers send {poolSize, poolPrice, overageRate} and the server compiles it.
 *
 * Track-only: there is no mode, no enforce, no gating. A pool is a
 * countdown and a bill, never a breaker.
 *
 * Bounds must be real finite numbers, never strings that happen to parse:
 * rows like (upper: 0, non-numeric lower) make the three pool math paths
 * disagree about what the pool even is. Coercing would let new ones in.
 *
 * This validates WRITES, never reads. A row stored in a degenerate shape is
 * never re-validated on read, so it keeps billing rather than failing.
 */

/** The three numbers a human actually thinks in. Input sugar, never stored. */
export interface CreditPoolSugar {
  poolSize: number;
  poolPrice: number;
  overageRate: number;
}

/** One row of the canonical two-tier array. */
export interface CreditPoolTier {
  lower: number;
  upper: number | null;
  rate: number;
}

/**
 * Named codes so callers can branch without string-matching prose. Every code
 * ships with a plain-English `message` that names the fix.
 */
export type CreditPoolIssueCode =
  | "sugarNotAnObject"
  | "partialSugar"
  | "sugarOnNonPoolModel"
  | "poolSizeInvalid"
  | "poolPriceInvalid"
  | "overageRateInvalid"
  | "tiersMissing"
  | "tierCount"
  | "tierNotAnObject"
  | "poolLowerInvalid"
  | "poolUpperInvalid"
  | "poolRateInvalid"
  | "overageLowerMismatch"
  | "overageUpperNotNull"
  | "overageTierRateInvalid"
  | "minimumCommitmentNotAllowed"
  | "secondPoolStrategy"
  | "sugarAndTiers"
  | "creditRatesNotAnObject"
  | "creditRateInvalid"
  | "creditRatesOnNonPoolModel"
  | "creditRateUnknownSignal"
  | "creditRateDoubleBilled";

export interface CreditPoolIssue {
  code: CreditPoolIssueCode;
  message: string;
}

export interface CreditPoolValidationResult {
  ok: boolean;
  issues: CreditPoolIssue[];
  /**
   * The tiers the caller should actually store: the compiled sugar when sugar
   * was supplied, otherwise null (meaning "the tiers you passed in stand").
   * Only ever populated when `ok` is true, so a caller can never persist the
   * output of a rejected write.
   */
  compiledTiers: CreditPoolTier[] | null;
}

/** The merged (existing row + incoming patch) state a write would produce. */
export interface CreditPoolValidationInput {
  pricingModel?: unknown;
  tiers?: unknown;
  /** The raw `creditPool` sugar object off the request, if the caller sent one. */
  creditPool?: unknown;
  minimumCommitment?: unknown;
  /**
   * Per-metric burn rates: {signalId: creditsPerUnit}. Like tiers,
   * validated against the MERGED state. `{}` counts as "no rates" — it is how
   * a caller clears them.
   */
  creditRates?: unknown;
  /** Strategy name or index, prefixed onto messages so bulk lanes stay legible. */
  label?: string;
}

export const CREDIT_POOL_MODEL = "credit_pool";

/**
 * Rejects a request that supplies BOTH the sugar and a raw tiers array.
 *
 * Deliberately checked on the incoming PATCH, never on the merged state: on a
 * sugar-only PATCH the merged tiers are always the stored ones, so a
 * merged-state version of this rule would reject every legitimate update.
 *
 * Silently letting the sugar win would be worse than either input alone. The
 * caller believes both took effect and only one did, and which one is a detail
 * of our implementation they can't see.
 */
export function validateCreditPoolInput(
  patch: { creditPool?: unknown; tiers?: unknown },
  label?: string,
): CreditPoolValidationResult {
  if (patch.creditPool == null || patch.tiers == null) {
    return { ok: true, issues: [], compiledTiers: null };
  }
  return {
    ok: false,
    issues: [
      {
        code: "sugarAndTiers",
        message:
          `${prefix(label)}send either creditPool or tiers, not both. creditPool ` +
          `({poolSize, poolPrice, overageRate}) compiles into tiers, so sending ` +
          `both means one of them is silently ignored.`,
      },
    ],
    compiledTiers: null,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function prefix(label: string | undefined): string {
  return label ? `${label}: ` : "";
}

/**
 * Turn the three human numbers into the canonical tiers. Total over its typed
 * input by construction — validate first (`validateCreditPoolTiers` rejects
 * partial and non-numeric sugar), then compile.
 */
export function compileCreditPool(sugar: CreditPoolSugar): CreditPoolTier[] {
  return [
    { lower: 0, upper: sugar.poolSize, rate: sugar.poolPrice },
    { lower: sugar.poolSize, upper: null, rate: sugar.overageRate },
  ];
}

/**
 * The sugar view of stored tiers, for read lanes. Returns null — never a
 * fabricated pool — on any shape this module would refuse to write, so a
 * degenerate stored row reads back as "no clean pool view", not as a made-up
 * one that disagrees with the invoice.
 */
export function deriveCreditPool(tiers: unknown): CreditPoolSugar | null {
  const check = validateCreditPoolTiers({
    pricingModel: CREDIT_POOL_MODEL,
    tiers,
  });
  if (!check.ok) return null;

  const sorted = sortTiersByLower(tiers as CreditPoolTier[]);
  return {
    poolSize: sorted[0].upper as number,
    poolPrice: sorted[0].rate,
    overageRate: sorted[1].rate,
  };
}

function sortTiersByLower(tiers: CreditPoolTier[]): CreditPoolTier[] {
  return [...tiers].sort((a, b) => a.lower - b.lower);
}

function validateSugar(
  raw: unknown,
  label: string | undefined,
  issues: CreditPoolIssue[],
): CreditPoolSugar | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      code: "sugarNotAnObject",
      message:
        `${prefix(label)}creditPool must be an object with poolSize, poolPrice, ` +
        `and overageRate.`,
    });
    return null;
  }

  const sugar = raw as Record<string, unknown>;
  const missing = (["poolSize", "poolPrice", "overageRate"] as const).filter(
    (k) => sugar[k] === undefined || sugar[k] === null,
  );
  if (missing.length > 0) {
    issues.push({
      code: "partialSugar",
      message:
        `${prefix(label)}creditPool needs all three of poolSize, poolPrice, and ` +
        `overageRate. Missing: ${missing.join(", ")}.`,
    });
    return null;
  }

  let valid = true;
  if (!isFiniteNumber(sugar.poolSize) || sugar.poolSize <= 0) {
    issues.push({
      code: "poolSizeInvalid",
      message:
        `${prefix(label)}creditPool.poolSize must be a number greater than zero. ` +
        `It's how many units the pool covers each cycle.`,
    });
    valid = false;
  }
  if (!isFiniteNumber(sugar.poolPrice) || sugar.poolPrice < 0) {
    issues.push({
      code: "poolPriceInvalid",
      message:
        `${prefix(label)}creditPool.poolPrice must be a number of zero or more. ` +
        `It's the flat fee charged every cycle for the pool.`,
    });
    valid = false;
  }
  if (!isFiniteNumber(sugar.overageRate) || sugar.overageRate < 0) {
    issues.push({
      code: "overageRateInvalid",
      message:
        `${prefix(label)}creditPool.overageRate must be a number of zero or more. ` +
        `It's the per-unit price after the pool runs out.`,
    });
    valid = false;
  }
  if (!valid) return null;

  return {
    poolSize: sugar.poolSize as number,
    poolPrice: sugar.poolPrice as number,
    overageRate: sugar.overageRate as number,
  };
}

function validateTierShape(
  tiers: unknown,
  label: string | undefined,
  issues: CreditPoolIssue[],
): void {
  if (!Array.isArray(tiers)) {
    issues.push({
      code: "tiersMissing",
      message:
        `${prefix(label)}a credit pool needs either a creditPool block ` +
        `({poolSize, poolPrice, overageRate}) or a two-tier tiers array.`,
    });
    return;
  }
  if (tiers.length !== 2) {
    issues.push({
      code: "tierCount",
      message:
        `${prefix(label)}a credit pool needs exactly 2 tiers, the pool and the ` +
        `overage, but got ${tiers.length}.`,
    });
    return;
  }
  if (
    tiers.some((t) => typeof t !== "object" || t === null || Array.isArray(t))
  ) {
    issues.push({
      code: "tierNotAnObject",
      message: `${prefix(label)}each credit-pool tier must be an object with lower, upper, and rate.`,
    });
    return;
  }

  const rows = tiers as Array<Record<string, unknown>>;
  // `lower` is checked BEFORE the sort, on both rows, because the sort is what
  // decides which row is the pool and which is the overage. Sorting on a
  // garbage bound would mislabel the tiers and blame the wrong field.
  if (rows.some((t) => !isFiniteNumber(t.lower) || t.lower < 0)) {
    issues.push({
      code: "poolLowerInvalid",
      message:
        `${prefix(label)}every credit-pool tier's lower bound must be a number of ` +
        `zero or more. The pool starts at 0, the overage starts at the pool size.`,
    });
    return;
  }

  // Both calcCreditPool and poolSizeFromTiers read these sorted by `lower`, so
  // the rule reads them the same way and tier order stops mattering.
  const sorted = [...rows].sort(
    (a, b) => (a.lower as number) - (b.lower as number),
  );
  const pool = sorted[0];
  const overage = sorted[1];

  // compileCreditPool always emits 0, and calcCreditPool bills the pool fee
  // from the first unit regardless. A pool declaring lower:3 would read as
  // "the first 3 units are free" to a human and bill nothing of the sort.
  if (pool.lower !== 0) {
    issues.push({
      code: "poolLowerInvalid",
      message:
        `${prefix(label)}the pool tier must start at 0 (got ${String(pool.lower)}). ` +
        `The pool fee covers usage from the very first unit.`,
    });
  }
  if (!isFiniteNumber(pool.upper) || pool.upper <= 0) {
    issues.push({
      code: "poolUpperInvalid",
      message:
        `${prefix(label)}the pool tier's upper bound is the pool size, so it must ` +
        `be a number greater than zero.`,
    });
  }
  if (!isFiniteNumber(pool.rate) || pool.rate < 0) {
    issues.push({
      code: "poolRateInvalid",
      message:
        `${prefix(label)}the pool tier's rate is the flat fee for the whole pool, ` +
        `so it must be a number of zero or more.`,
    });
  }

  if (isFiniteNumber(pool.upper) && overage.lower !== pool.upper) {
    issues.push({
      code: "overageLowerMismatch",
      message:
        `${prefix(label)}the overage tier must start exactly where the pool ends ` +
        `(lower ${String(overage.lower)} should be ${pool.upper}).`,
    });
  }

  // A missing key round-trips out of JSON the same way an explicit null does,
  // and both mean "unbounded" to calcCreditPool.
  if (overage.upper !== null && overage.upper !== undefined) {
    issues.push({
      code: "overageUpperNotNull",
      message:
        `${prefix(label)}the overage tier has no ceiling, so its upper bound must ` +
        `be null.`,
    });
  }
  if (!isFiniteNumber(overage.rate) || overage.rate < 0) {
    issues.push({
      code: "overageTierRateInvalid",
      message:
        `${prefix(label)}the overage tier's rate is the per-unit price after the ` +
        `pool runs out, so it must be a number of zero or more.`,
    });
  }
}

/**
 * "This input carries rates" — null, undefined, and `{}` all mean it doesn't.
 * `{}` is the documented way to CLEAR rates, so it must pass the non-pool
 * check (clearing rates while flipping the model away is the legitimate exit).
 */
function carriesCreditRates(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return Object.keys(raw as object).length > 0;
  }
  return true;
}

function validateCreditRatesShape(
  raw: unknown,
  label: string | undefined,
  issues: CreditPoolIssue[],
): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      code: "creditRatesNotAnObject",
      message:
        `${prefix(label)}creditRates must be an object mapping signal ids to ` +
        `credits-per-unit numbers, like {"<signalId>": 4}.`,
    });
    return;
  }
  const bad = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => !isFiniteNumber(v) || v <= 0)
    .map(([k]) => k);
  if (bad.length > 0) {
    issues.push({
      code: "creditRateInvalid",
      message:
        `${prefix(label)}every creditRates value must be a number greater than ` +
        `zero — it's how many pool credits one unit of that metric burns. To ` +
        `make a metric free, leave it out of the map instead of setting 0. ` +
        `Fix: ${bad.join(", ")}.`,
    });
  }
}

/**
 * The gate every tier-write lane calls, against the MERGED (existing row +
 * incoming patch) state. Merged, not patch-only, because
 * `PATCH {pricingModel: 'credit_pool'}` and `PATCH {minimumCommitment: 500}`
 * each turn a previously-fine row into a bad pool while touching nothing the
 * patch itself would flag.
 *
 * Never throws. Callers turn `issues` into their own transport's error.
 */
export function validateCreditPoolTiers(
  input: CreditPoolValidationInput,
): CreditPoolValidationResult {
  const issues: CreditPoolIssue[] = [];
  const { label } = input;
  const isPool = input.pricingModel === CREDIT_POOL_MODEL;
  const hasSugar = input.creditPool !== undefined && input.creditPool !== null;

  if (hasSugar && !isPool) {
    issues.push({
      code: "sugarOnNonPoolModel",
      message:
        `${prefix(label)}creditPool only applies to pricingModel 'credit_pool'. ` +
        `Set pricingModel to 'credit_pool' or drop the creditPool block.`,
    });
    return { ok: false, issues, compiledTiers: null };
  }

  if (carriesCreditRates(input.creditRates) && !isPool) {
    issues.push({
      code: "creditRatesOnNonPoolModel",
      message:
        `${prefix(label)}creditRates only applies to pricingModel 'credit_pool'. ` +
        `Keep the model credit_pool, or clear the rates (creditRates: {}) in ` +
        `the same update.`,
    });
    return { ok: false, issues, compiledTiers: null };
  }

  if (!isPool) {
    return { ok: true, issues, compiledTiers: null };
  }

  if (carriesCreditRates(input.creditRates)) {
    validateCreditRatesShape(input.creditRates, label, issues);
  }

  // Zero is not a commitment, it's the absence of one, so it is accepted.
  // Only a real commitment is rejected, which keeps a row carrying 0 editable.
  if (isFiniteNumber(input.minimumCommitment) && input.minimumCommitment > 0) {
    issues.push({
      code: "minimumCommitmentNotAllowed",
      message:
        `${prefix(label)}a credit pool can't have a minimum commitment. The pool ` +
        `fee already is the minimum the customer pays every cycle.`,
    });
  }

  let compiledTiers: CreditPoolTier[] | null = null;
  if (hasSugar) {
    const sugar = validateSugar(input.creditPool, label, issues);
    if (sugar) {
      compiledTiers = compileCreditPool(sugar);
    }
  } else {
    validateTierShape(input.tiers, label, issues);
  }

  const ok = issues.length === 0;
  return { ok, issues, compiledTiers: ok ? compiledTiers : null };
}

/** One error string for a transport to hand back, in the order rules fired. */
export function creditPoolErrorMessage(
  result: CreditPoolValidationResult,
): string {
  return result.issues.map((i) => i.message).join(" ");
}

// ── one pool per plan ───────────────────────────────────────────────────────

/**
 * A plan's strategy as the single-pool rule sees it. Deliberately `unknown`
 * fields: callers pass Prisma rows, DTOs, and merged plain objects, and this
 * module does the narrowing once.
 */
export interface PlanStrategyState {
  id?: string;
  name?: unknown;
  pricingModel?: unknown;
  chargeType?: unknown;
  active?: unknown;
  deletedAt?: unknown;
  /** Only the creditRates reference rule reads these two; other callers may omit them. */
  signalId?: unknown;
  creditRates?: unknown;
}

/**
 * The same predicate `findCreditPoolStrategy` (credit-ledger.ts) uses to pick
 * the pool it mints against. Identical by intent: the rule below is only
 * meaningful if "a live pool" means the same thing to the validator and to the
 * ledger.
 */
export function isLivePoolStrategy(row: PlanStrategyState): boolean {
  return (
    row.pricingModel === CREDIT_POOL_MODEL &&
    row.chargeType === "usage" &&
    row.active === true &&
    (row.deletedAt === null || row.deletedAt === undefined)
  );
}

/**
 * Rejects a plan that would end up with two live credit-pool strategies.
 *
 * Why this is a rule and not a preference: the ledger mints exactly ONE pool
 * per subscription, sized by the OLDEST matching strategy
 * (findCreditPoolStrategy orders by createdAt asc), while the invoice bills
 * every credit-pool strategy separately. Two pools on one plan therefore bill
 * twice and count down once — the balance the customer reads would be a lie
 * about the bill they get.
 *
 * Callers pass the POST-WRITE set of the plan's strategies: untouched siblings
 * plus the merged state of everything this write creates or updates.
 *
 * `strategiesBeforeWrite` is the grandfathering escape hatch, and it matters:
 * without it, a plan that somehow already carries two pools would have BOTH of
 * them frozen — every edit rejected, including the edit that would fix the
 * problem. With it, the rule blocks only writes that ADD a pool, so an
 * existing mess stays editable while no new one can be created.
 */
export function validateSinglePoolPerPlan(
  strategiesAfterWrite: PlanStrategyState[],
  strategiesBeforeWrite?: PlanStrategyState[],
): CreditPoolValidationResult {
  const live = strategiesAfterWrite.filter(isLivePoolStrategy);
  if (live.length <= 1) {
    return { ok: true, issues: [], compiledTiers: null };
  }
  if (strategiesBeforeWrite) {
    const liveBefore = strategiesBeforeWrite.filter(isLivePoolStrategy).length;
    if (live.length <= liveBefore) {
      return { ok: true, issues: [], compiledTiers: null };
    }
  }
  const names = live
    .map((s) => (typeof s.name === "string" && s.name ? s.name : s.id))
    .filter(Boolean)
    .join(", ");
  return {
    ok: false,
    issues: [
      {
        code: "secondPoolStrategy",
        message:
          `A plan can only have one active credit pool, but this would leave ${live.length} ` +
          `(${names}). Deactivate or remove the other pool first, or put this one on its own plan.`,
      },
    ],
    compiledTiers: null,
  };
}

// ── creditRates references ──────────────────────────────────────

export interface CreditRatesReferenceInput {
  /**
   * The creditRates maps this request writes (merged state), for the
   * live-signal check. Entries without rates are skipped.
   */
  writes: Array<{ creditRates?: unknown; label?: string }>;
  /** Ids of the org's live signals (deletedAt null), loaded by the caller. */
  orgLiveSignalIds: ReadonlyArray<string>;
  /**
   * The plan's POST-WRITE strategy set — stored siblings with this request's
   * merged rows substituted in, plus everything it creates (the same set the
   * single-pool rule takes). Rows must carry signalId, and pool rows their
   * creditRates.
   */
  planStrategies: PlanStrategyState[];
}

/**
 * The DB-aware half of the creditRates rule, kept pure by taking the loaded
 * rows as input so both write funnels (api-nest services, dashboard server
 * actions) reject with the SAME message:
 *   (a) every written creditRates key must be a real live signal in the org —
 *       a typo'd or deleted id would sit in the map forever, silently
 *       matching nothing;
 *   (b) on the post-write plan, no pool-member signal may also carry its own
 *       live usage strategy — the event would burn pool credits AND bill
 *       per-unit, and the customer pays twice for one unit of work. Checked
 *       against the whole plan state, not only the rates write, so the back
 *       door (activating a usage strategy on a signal an existing pool's
 *       rates already name) is the same rejection as the front door.
 */
export function validateCreditRatesReferences(
  input: CreditRatesReferenceInput,
): CreditPoolValidationResult {
  const issues: CreditPoolIssue[] = [];

  const liveSignals = new Set(input.orgLiveSignalIds);
  for (const write of input.writes) {
    if (!carriesCreditRates(write.creditRates)) continue;
    if (
      typeof write.creditRates !== "object" ||
      write.creditRates === null ||
      Array.isArray(write.creditRates)
    ) {
      continue; // shape rejection is validateCreditPoolTiers' job
    }
    const unknown = Object.keys(write.creditRates).filter(
      (k) => !liveSignals.has(k),
    );
    if (unknown.length > 0) {
      issues.push({
        code: "creditRateUnknownSignal",
        message:
          `${prefix(write.label)}creditRates names a signal that doesn't exist ` +
          `in this organization (or was deleted): ${unknown.join(", ")}. ` +
          `Every key must be a live signal id.`,
      });
    }
  }

  for (const pool of input.planStrategies.filter(isLivePoolStrategy)) {
    const rates = pool.creditRates;
    if (typeof rates !== "object" || rates === null || Array.isArray(rates)) {
      continue;
    }
    const poolName =
      typeof pool.name === "string" && pool.name
        ? pool.name
        : "the credit pool";
    for (const key of Object.keys(rates)) {
      const rival = input.planStrategies.find(
        (row) =>
          row !== pool &&
          row.signalId === key &&
          row.chargeType === "usage" &&
          row.active === true &&
          (row.deletedAt === null || row.deletedAt === undefined),
      );
      if (rival) {
        const rivalName =
          typeof rival.name === "string" && rival.name ? rival.name : rival.id;
        issues.push({
          code: "creditRateDoubleBilled",
          message:
            `Signal ${key} would both burn credits from ${poolName} and bill ` +
            `through its own usage strategy (${rivalName}) on this plan — the ` +
            `customer would pay twice for one unit of work. A metric either ` +
            `burns pool credits or bills per-unit, never both: deactivate one ` +
            `of them, or take the signal out of creditRates.`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues, compiledTiers: null };
}
