/**
 * credit-pool-tiers: the ONE credit-pool shape rule. Runs
 * under tsx in <1s with no database (packages/db src test convention —
 * standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/credit-pool-tiers.test.ts
 *
 * WHAT THESE PROVE: the pure rule set — every rejection reason, the
 * compile/derive round trip, the merged-state cases a PATCH creates, and the
 * agreement between this module and the two math paths that read the same
 * tiers (calcCreditPool bills them, poolSizeFromTiers mints against them).
 * WHAT THEY DON'T: that the eight write lanes actually CALL it — that's
 * pinned by the api-nest service specs and the dashboard action tests.
 *
 * Covered:
 *   1.  Compile → derive round trip returns the input.
 *   2.  Compiled tiers agree with calcCreditPool and poolSizeFromTiers.
 *   3.  Happy path: a well-formed two-tier array validates.
 *   4.  Every degenerate shape is rejected with its named code.
 *   5.  Partial / non-numeric / non-object sugar rejected by name.
 *   6.  minimumCommitment rejected on credit_pool; zero tolerated; allowed
 *       on every other model.
 *   7.  Merged-state cases: pricingModel flip onto tierless rows, sugar on a
 *       non-pool model.
 *   8.  deriveCreditPool returns honest null on degenerate shapes, and
 *       tolerates an unsorted array and an absent overage `upper` key.
 *   9.  Non-credit-pool writes are never validated (grandfathering).
 *   10. One-live-pool-per-plan, using the ledger's own liveness predicate.
 *   11. creditRates shape: positive finite values only, {} =
 *       clear, rejected by name on non-pool models incl. the merged-state
 *       model-flip trap.
 *   12. creditRates references: every key a live org signal; no member signal
 *       with its own live usage strategy (double billing); the pool's own row
 *       excluded.
 */

import assert from "node:assert/strict";

import {
  compileCreditPool,
  creditPoolErrorMessage,
  deriveCreditPool,
  isLivePoolStrategy,
  validateCreditPoolInput,
  validateCreditPoolTiers,
  validateCreditRatesReferences,
  validateSinglePoolPerPlan,
  type CreditPoolIssueCode,
} from "./credit-pool-tiers";
import { poolSizeFromTiers } from "./credit-ledger";
import { calcCreditPool } from "./revenue-calc";

const POOL = { poolSize: 5000, poolPrice: 99, overageRate: 0.03 };
const GOOD_TIERS = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
];

/** Assert a write is rejected, and that it's rejected for the stated reason. */
function expectRejected(
  input: Parameters<typeof validateCreditPoolTiers>[0],
  code: CreditPoolIssueCode,
  what: string,
): void {
  const res = validateCreditPoolTiers(input);
  assert.equal(res.ok, false, `${what}: expected rejection`);
  assert.ok(
    res.issues.some((i) => i.code === code),
    `${what}: expected issue '${code}', got [${res.issues.map((i) => i.code).join(", ")}]`,
  );
  assert.equal(
    res.compiledTiers,
    null,
    `${what}: a rejected write must never hand back tiers to store`,
  );
  assert.ok(
    creditPoolErrorMessage(res).length > 0,
    `${what}: every rejection needs a plain-English message`,
  );
}

function main(): void {
  // ─── 1. compile → derive round trip ──────────────────────────────────────
  {
    const tiers = compileCreditPool(POOL);
    assert.deepEqual(tiers, GOOD_TIERS, "compile produces the canonical shape");
    assert.deepEqual(
      deriveCreditPool(tiers),
      POOL,
      "derive(compile(x)) === x — what you wrote is what you read back",
    );

    // And through the validator's own compile path (the one the lanes use).
    const viaValidator = validateCreditPoolTiers({
      pricingModel: "credit_pool",
      creditPool: POOL,
    });
    assert.equal(viaValidator.ok, true);
    assert.deepEqual(viaValidator.compiledTiers, GOOD_TIERS);
    assert.deepEqual(deriveCreditPool(viaValidator.compiledTiers), POOL);
  }

  // ─── 2. the compiled tiers mean the same thing to the biller and the ledger ─
  {
    const tiers = compileCreditPool(POOL);
    assert.equal(
      poolSizeFromTiers(tiers),
      POOL.poolSize,
      "the ledger mints a grant of exactly poolSize",
    );
    const strategy = { rate: 0, tiers } as Parameters<typeof calcCreditPool>[0];
    assert.equal(
      calcCreditPool(strategy, 3000),
      99,
      "inside the pool: the flat fee, nothing more",
    );
    assert.equal(
      calcCreditPool(strategy, 6000),
      99 + 1000 * 0.03,
      "past the pool: flat fee plus per-unit overage",
    );
  }

  // ─── 3. happy paths ──────────────────────────────────────────────────────
  {
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
      }).ok,
      true,
      "a well-formed raw two-tier array is still a first-class input",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: [{ lower: 5000, upper: null, rate: 0.03 }, ...[GOOD_TIERS[0]]],
      }).ok,
      true,
      "tier order doesn't matter — the rule sorts by lower first",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 5000, rate: 99 },
          { lower: 5000, rate: 0.03 },
        ],
      }).ok,
      true,
      "an absent overage `upper` key means unbounded, same as explicit null",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        creditPool: { poolSize: 100, poolPrice: 0, overageRate: 0 },
      }).ok,
      true,
      "a free pool with free overage is odd but not incoherent",
    );
  }

  // ─── 4. degenerate tier shapes, each by name ─────────────────────────────
  {
    expectRejected(
      { pricingModel: "credit_pool", tiers: null },
      "tiersMissing",
      "credit_pool with no tiers and no sugar",
    );
    expectRejected(
      { pricingModel: "credit_pool", tiers: [] },
      "tierCount",
      "empty tiers array",
    );
    expectRejected(
      { pricingModel: "credit_pool", tiers: [GOOD_TIERS[0]] },
      "tierCount",
      "pool tier with no overage tier",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [...GOOD_TIERS, { lower: 9000, upper: null, rate: 0.01 }],
      },
      "tierCount",
      "three tiers",
    );
    expectRejected(
      { pricingModel: "credit_pool", tiers: [1, 2] },
      "tierNotAnObject",
      "tiers of the wrong type",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 0, rate: 99 },
          { lower: 0, upper: null, rate: 0.03 },
        ],
      },
      "poolUpperInvalid",
      "upper:0 is a degenerate pool",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: null, rate: 99 },
          { lower: 0, upper: null, rate: 0.03 },
        ],
      },
      "poolUpperInvalid",
      "an unbounded pool tier is not a pool",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: "0", upper: 5000, rate: 99 },
          { lower: 5000, upper: null, rate: 0.03 },
        ],
      },
      "poolLowerInvalid",
      "non-numeric lower — the other shape the three math paths disagree on",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: "5000", rate: 99 },
          { lower: 5000, upper: null, rate: 0.03 },
        ],
      },
      "poolUpperInvalid",
      "a stringy pool size that happens to parse is still not a number",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 5000, rate: -1 },
          { lower: 5000, upper: null, rate: 0.03 },
        ],
      },
      "poolRateInvalid",
      "negative pool fee",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 5000, rate: 99 },
          { lower: 4000, upper: null, rate: 0.03 },
        ],
      },
      "overageLowerMismatch",
      "a gap/overlap between the pool and its overage",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 5000, rate: 99 },
          { lower: 5000, upper: 9000, rate: 0.03 },
        ],
      },
      "overageUpperNotNull",
      "a capped overage tier: nothing stops at the ceiling",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 5000, rate: 99 },
          { lower: 5000, upper: null, rate: -0.03 },
        ],
      },
      "overageTierRateInvalid",
      "negative overage rate",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 3, upper: 5000, rate: 99 },
          { lower: 5000, upper: null, rate: 0.03 },
        ],
      },
      "poolLowerInvalid",
      "a pool starting at 3 reads as '3 free units' and bills nothing of the sort",
    );
  }

  // ─── 5. sugar shapes ─────────────────────────────────────────────────────
  {
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: 5000, poolPrice: 99 },
      },
      "partialSugar",
      "sugar missing overageRate — compileCreditPool needs all three",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: 5000, poolPrice: 99, overageRate: null },
      },
      "partialSugar",
      "an explicitly null third field is still partial",
    );
    expectRejected(
      { pricingModel: "credit_pool", creditPool: "5000/99/0.03" },
      "sugarNotAnObject",
      "sugar as a string",
    );
    expectRejected(
      { pricingModel: "credit_pool", creditPool: [5000, 99, 0.03] },
      "sugarNotAnObject",
      "sugar as an array",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: 0, poolPrice: 99, overageRate: 0.03 },
      },
      "poolSizeInvalid",
      "a pool of zero units",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: "5000", poolPrice: 99, overageRate: 0.03 },
      },
      "poolSizeInvalid",
      "stringy poolSize",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: 5000, poolPrice: -1, overageRate: 0.03 },
      },
      "poolPriceInvalid",
      "negative pool price",
    );
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: { poolSize: 5000, poolPrice: 99, overageRate: -0.03 },
      },
      "overageRateInvalid",
      "negative overage rate in sugar",
    );
  }

  // ─── 5b. sending BOTH sugar and tiers is rejected, loudly ────────────────
  {
    const both = validateCreditPoolInput({
      creditPool: POOL,
      tiers: [{ lower: 0, upper: 1, rate: 1 }],
    });
    assert.equal(both.ok, false, "both inputs at once is rejected");
    assert.equal(both.issues[0].code, "sugarAndTiers");
    assert.match(
      both.issues[0].message,
      /not both/i,
      "the error names the fix",
    );

    // Each alone is fine — and the case this rule must NOT break: a sugar-only
    // patch, whose MERGED state always carries the stored tiers alongside it.
    // That is exactly why this check reads the raw patch, not the merge.
    for (const patch of [
      { creditPool: POOL },
      { tiers: GOOD_TIERS },
      { creditPool: POOL, tiers: null },
      { creditPool: null, tiers: GOOD_TIERS },
      {},
    ]) {
      assert.equal(
        validateCreditPoolInput(patch).ok,
        true,
        `one input at a time is fine: ${JSON.stringify(patch)}`,
      );
    }
  }

  // ─── 6. minimumCommitment ────────────────────────────────────────────────
  {
    expectRejected(
      {
        pricingModel: "credit_pool",
        creditPool: POOL,
        minimumCommitment: 500,
      },
      "minimumCommitmentNotAllowed",
      "a minimum commitment on a pool double-charges the floor",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        minimumCommitment: 0,
      }).ok,
      true,
      "zero is the absence of a commitment — legacy rows carrying it stay editable",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        minimumCommitment: null,
      }).ok,
      true,
      "null commitment is fine",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "graduated",
        tiers: [{ lower: 0, upper: null, rate: 1 }],
        minimumCommitment: 500,
      }).ok,
      true,
      "every other model keeps its minimum commitment",
    );
  }

  // ─── 7. merged-state cases (what a PATCH creates) ────────────────────────
  {
    // PATCH {pricingModel:'credit_pool'} onto a flat row whose tiers are null.
    expectRejected(
      { pricingModel: "credit_pool", tiers: undefined },
      "tiersMissing",
      "flipping a tierless row to credit_pool",
    );
    // PATCH {pricingModel:'credit_pool'} onto a graduated row's 3-tier array.
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: [
          { lower: 0, upper: 100, rate: 1 },
          { lower: 100, upper: 1000, rate: 0.5 },
          { lower: 1000, upper: null, rate: 0.1 },
        ],
      },
      "tierCount",
      "flipping a graduated row to credit_pool",
    );
    // PATCH {minimumCommitment} onto an existing, otherwise-fine pool.
    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        minimumCommitment: 250,
      },
      "minimumCommitmentNotAllowed",
      "adding a commitment to a live pool",
    );
    // PATCH {creditPool} onto a flat row.
    expectRejected(
      { pricingModel: "flat", creditPool: POOL },
      "sugarOnNonPoolModel",
      "sugar on a non-pool model would silently give flat pricing two tiers",
    );
  }

  // ─── 8. derive is honest ─────────────────────────────────────────────────
  {
    assert.equal(deriveCreditPool(null), null, "no tiers, no sugar view");
    assert.equal(deriveCreditPool([]), null, "empty tiers, no sugar view");
    assert.equal(
      deriveCreditPool([{ lower: 0, upper: 0, rate: 99 }]),
      null,
      "a degenerate legacy row reads back as null, never as a made-up pool",
    );
    assert.equal(
      deriveCreditPool([
        { lower: 0, upper: 5000, rate: 99 },
        { lower: 4000, upper: null, rate: 0.03 },
      ]),
      null,
      "mismatched bounds have no honest sugar view",
    );
    assert.equal(
      deriveCreditPool([
        { lower: 3, upper: 5000, rate: 99 },
        { lower: 5000, upper: null, rate: 0.03 },
      ]),
      null,
      "derive refuses exactly what validate refuses — a pool must start at 0",
    );
    assert.deepEqual(
      deriveCreditPool([GOOD_TIERS[1], GOOD_TIERS[0]]),
      POOL,
      "derive sorts by lower before reading",
    );
    assert.deepEqual(
      deriveCreditPool([
        { lower: 0, upper: 5000, rate: 99 },
        { lower: 5000, rate: 0.03 },
      ]),
      POOL,
      "an absent overage upper still derives",
    );
  }

  // ─── 9. grandfathering: non-pool writes are never validated ──────────────
  {
    for (const model of ["flat", "graduated", "volume", null, undefined]) {
      const res = validateCreditPoolTiers({
        pricingModel: model,
        tiers: [{ lower: 0, upper: 0, rate: 0 }],
        minimumCommitment: 999,
      });
      assert.equal(
        res.ok,
        true,
        `pricingModel ${String(model)} is none of this module's business`,
      );
      assert.equal(res.issues.length, 0);
    }
  }

  // ─── 10. one live pool per plan ──────────────────────────────────────────
  {
    const livePool = {
      id: "a",
      name: "Task Pool",
      pricingModel: "credit_pool",
      chargeType: "usage",
      active: true,
      deletedAt: null,
    };
    assert.equal(isLivePoolStrategy(livePool), true);

    assert.equal(
      validateSinglePoolPerPlan([livePool]).ok,
      true,
      "one pool is the whole point",
    );
    assert.equal(
      validateSinglePoolPerPlan([
        livePool,
        { ...livePool, id: "b", pricingModel: "flat" },
      ]).ok,
      true,
      "a pool alongside other pricing models is fine",
    );

    const two = validateSinglePoolPerPlan([
      livePool,
      { ...livePool, id: "b", name: "Second Pool" },
    ]);
    assert.equal(two.ok, false, "two live pools on one plan is rejected");
    assert.equal(two.issues[0].code, "secondPoolStrategy");
    assert.ok(
      two.issues[0].message.includes("Task Pool") &&
        two.issues[0].message.includes("Second Pool"),
      "the error names both offenders so the fix is obvious",
    );

    // The liveness predicate must match findCreditPoolStrategy's WHERE, or the
    // rule would block plans the ledger never sees as ambiguous.
    for (const dead of [
      { active: false },
      { deletedAt: new Date() },
      { chargeType: "recurring" },
    ]) {
      assert.equal(
        validateSinglePoolPerPlan([livePool, { ...livePool, id: "b", ...dead }])
          .ok,
        true,
        `a ${JSON.stringify(dead)} sibling is invisible to the ledger, so it can't collide`,
      );
    }

    // Grandfathering: a plan that already carries two pools stays editable.
    const alreadyTwo = [
      livePool,
      { ...livePool, id: "b", name: "Second Pool" },
    ];
    assert.equal(
      validateSinglePoolPerPlan(alreadyTwo, alreadyTwo).ok,
      true,
      "editing a pre-existing two-pool plan is allowed — freezing it would block the fix too",
    );
    assert.equal(
      validateSinglePoolPerPlan(
        [...alreadyTwo, { ...livePool, id: "c" }],
        alreadyTwo,
      ).ok,
      false,
      "...but adding a THIRD pool to that plan is still rejected",
    );
    assert.equal(
      validateSinglePoolPerPlan(alreadyTwo, [livePool]).ok,
      false,
      "going from one pool to two is the case this rule exists for",
    );
  }

  // ─── 11. creditRates shape ───────────────────────────────────
  {
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        creditRates: { "sig-a": 4, "sig-b": 0.5 },
      }).ok,
      true,
      "finite positive rates on a pool validate",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        creditRates: {},
      }).ok,
      true,
      "{} means 'no rates' (the documented clear) and is always fine",
    );
    assert.equal(
      validateCreditPoolTiers({
        pricingModel: "flat",
        creditRates: {},
      }).ok,
      true,
      "{} passes on a non-pool model too — clearing rates while flipping the model away is the exit path",
    );

    expectRejected(
      {
        pricingModel: "credit_pool",
        tiers: GOOD_TIERS,
        creditRates: ["sig-a"],
      },
      "creditRatesNotAnObject",
      "array creditRates",
    );
    expectRejected(
      { pricingModel: "credit_pool", tiers: GOOD_TIERS, creditRates: "4" },
      "creditRatesNotAnObject",
      "string creditRates",
    );
    for (const bad of [0, -2, NaN, Infinity, "4", null]) {
      expectRejected(
        {
          pricingModel: "credit_pool",
          tiers: GOOD_TIERS,
          creditRates: { "sig-a": bad },
        },
        "creditRateInvalid",
        `rate value ${String(bad)}`,
      );
    }
    expectRejected(
      {
        pricingModel: "graduated",
        tiers: GOOD_TIERS,
        creditRates: { "sig-a": 4 },
      },
      "creditRatesOnNonPoolModel",
      "rates on a non-pool model",
    );
    // The merged-state PATCH trap: flipping the model away while stored rates
    // survive the merge must be rejected, not silently half-applied.
    expectRejected(
      { pricingModel: "flat", creditRates: { "sig-a": 4 } },
      "creditRatesOnNonPoolModel",
      "model flipped away from credit_pool with rates still on the row",
    );
  }

  // ─── 12. creditRates references (the DB-aware half) ───────────
  {
    const poolRow = {
      id: "pool-strat",
      name: "Credit pool",
      signalId: "sig-pool",
      chargeType: "usage",
      active: true,
      deletedAt: null,
      pricingModel: "credit_pool",
      creditRates: { "sig-a": 4, "sig-pool": 2 },
    };
    const okRefs = validateCreditRatesReferences({
      writes: [{ creditRates: poolRow.creditRates, label: poolRow.name }],
      orgLiveSignalIds: ["sig-a", "sig-pool", "sig-idle"],
      planStrategies: [
        poolRow,
        // A recurring sibling on a member signal is NOT double billing.
        {
          id: "seat",
          name: "Seats",
          signalId: "sig-a",
          chargeType: "recurring",
          active: true,
          deletedAt: null,
        },
        // An INACTIVE usage sibling is not double billing either.
        {
          id: "dormant",
          name: "Old per-call",
          signalId: "sig-a",
          chargeType: "usage",
          active: false,
          deletedAt: null,
        },
      ],
    });
    assert.equal(okRefs.ok, true, "live keys + no live usage rival = ok");
    assert.equal(
      okRefs.issues.length,
      0,
      "the pool's own row never flags its own signal's rate (sig-pool is a key AND the pool's signal)",
    );

    assert.equal(
      validateCreditRatesReferences({
        writes: [{ creditRates: null }, { creditRates: {} }, {}],
        orgLiveSignalIds: [],
        planStrategies: [],
      }).ok,
      true,
      "rate-less writes and an empty plan short-circuit to ok",
    );

    const unknownSig = validateCreditRatesReferences({
      writes: [{ creditRates: { "sig-ghost": 4 }, label: "Pool" }],
      orgLiveSignalIds: ["sig-a"],
      planStrategies: [],
    });
    assert.equal(unknownSig.ok, false);
    assert.ok(
      unknownSig.issues.some((i) => i.code === "creditRateUnknownSignal"),
      "a key that isn't a live org signal is rejected by name",
    );
    assert.ok(
      creditPoolErrorMessage(unknownSig).includes("sig-ghost"),
      "the message names the offending key",
    );

    // Front door: writing rates that name an already-priced signal.
    const rival = {
      id: "rival",
      name: "Per-call pricing",
      signalId: "sig-a",
      chargeType: "usage",
      active: true,
      deletedAt: null,
    };
    const doubled = validateCreditRatesReferences({
      writes: [{ creditRates: poolRow.creditRates, label: poolRow.name }],
      orgLiveSignalIds: ["sig-a", "sig-pool"],
      planStrategies: [poolRow, rival],
    });
    assert.equal(doubled.ok, false);
    assert.ok(
      doubled.issues.some((i) => i.code === "creditRateDoubleBilled"),
      "a live usage sibling on a member signal is double billing",
    );
    assert.ok(
      creditPoolErrorMessage(doubled).includes("Per-call pricing"),
      "the message names the rival strategy",
    );

    // Back door: the RATES aren't being written — the rival usage strategy
    // is being activated while the stored pool already names its signal. The
    // plan-state formulation rejects both doors with the same message.
    const backDoor = validateCreditRatesReferences({
      writes: [],
      orgLiveSignalIds: ["sig-a", "sig-pool"],
      planStrategies: [poolRow, rival],
    });
    assert.equal(backDoor.ok, false, "back door caught with zero rated writes");
    assert.deepEqual(
      backDoor.issues,
      doubled.issues.filter((i) => i.code === "creditRateDoubleBilled"),
      "both doors produce the identical rejection",
    );

    // A single-metric pool (no creditRates) constrains nothing.
    assert.equal(
      validateCreditRatesReferences({
        writes: [],
        orgLiveSignalIds: ["sig-a"],
        planStrategies: [{ ...poolRow, creditRates: null }, rival],
      }).ok,
      true,
      "rate-less pools never flag siblings, so unrated plans are untouched",
    );
  }

  console.log("credit-pool-tiers.test.ts: all assertions passed");
}

main();
