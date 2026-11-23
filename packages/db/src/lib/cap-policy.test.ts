/**
 * cap-policy: the ceiling rule + the UTC period-window helper.
 *
 * Pure, no DB hit. Runs under tsx in <1s (the packages/db src test convention —
 * standalone assert scripts, NOT vitest suites):
 *
 *   npx tsx packages/db/src/lib/cap-policy.test.ts
 *
 * WHY this test is load-bearing: the ceiling rule IS the product's structural
 * promise — a team/dev cap can never be raised above the decision-maker's org
 * ceiling. The NEGATIVE CONTROL below proves the test can fail: it replays the
 * "no ceiling check" behavior (always allow) against a cap that is $500 over the
 * $200 ceiling and shows it sails through — the exact red the real check turns
 * green. If someone neutered checkCapWithinCeiling to `return { ok: true }`, the
 * real-check assertions would all go red.
 */

import assert from "node:assert/strict";

import {
  CAP_MODES,
  CAP_PERIODS,
  CAP_SCOPES,
  checkCapWithinCeiling,
  currentPeriodWindow,
  isCapMode,
  isCapPeriod,
  isCapScope,
  type OrgCeiling,
} from "./cap-policy";

// ─── NEGATIVE CONTROL — proves these assertions are capable of failing ──────
// "No ceiling check at all": every cap is allowed.
const noCeilingCheck = (): boolean => true;
const overByFiveHundred = {
  scope: "dev" as const,
  providerScope: "all",
  amountUsd: 700,
};
const twoHundredCeiling: OrgCeiling[] = [
  { providerScope: "all", amountUsd: 200 },
];
assert.equal(
  noCeilingCheck(),
  true,
  "NEGATIVE CONTROL: without a ceiling check, a $700 dev cap under a $200 ceiling is wrongly allowed — this is the bug the real check closes",
);

// ─── Rule 1: the unbreakable ceiling ────────────────────────────────────────

// A child cap ABOVE the org ceiling is rejected (the red the negative control models turns green here).
{
  const res = checkCapWithinCeiling({
    ...overByFiveHundred,
    orgCeilings: twoHundredCeiling,
  });
  assert.equal(
    res.ok,
    false,
    "dev cap $700 over a $200 org ceiling must be rejected",
  );
  assert.equal(
    res.ceilingUsd,
    200,
    "the rejection reports the ceiling that applied",
  );
}

// A child cap AT the ceiling is allowed (boundary: <= passes).
{
  const res = checkCapWithinCeiling({
    scope: "team",
    providerScope: "all",
    amountUsd: 200,
    orgCeilings: twoHundredCeiling,
  });
  assert.equal(res.ok, true, "a team cap exactly at the ceiling is allowed");
}

// A child cap BELOW the ceiling is allowed.
{
  const res = checkCapWithinCeiling({
    scope: "dev",
    providerScope: "all",
    amountUsd: 150,
    orgCeilings: twoHundredCeiling,
  });
  assert.equal(res.ok, true, "a dev cap under the ceiling is allowed");
}

// An ORG cap has nothing above it — always ok, regardless of amount.
{
  const res = checkCapWithinCeiling({
    scope: "org",
    providerScope: "all",
    amountUsd: 999999,
    orgCeilings: twoHundredCeiling,
  });
  assert.equal(res.ok, true, "an org ceiling has no ceiling above it");
  assert.equal(res.ceilingUsd, null, "org scope reports no applicable ceiling");
}

// No applicable ceiling at all → nothing to violate, child cap allowed.
{
  const res = checkCapWithinCeiling({
    scope: "dev",
    providerScope: "anthropic",
    amountUsd: 5000,
    orgCeilings: [],
  });
  assert.equal(
    res.ok,
    true,
    "with no org ceiling set, a child cap is unconstrained",
  );
  assert.equal(res.ceilingUsd, null, "no ceiling applied");
}

// Provider resolution: an exact provider ceiling wins over the 'all' ceiling.
{
  const ceilings: OrgCeiling[] = [
    { providerScope: "all", amountUsd: 1000 },
    { providerScope: "anthropic", amountUsd: 200 },
  ];
  const res = checkCapWithinCeiling({
    scope: "dev",
    providerScope: "anthropic",
    amountUsd: 500,
    orgCeilings: ceilings,
  });
  assert.equal(
    res.ok,
    false,
    "a $500 anthropic dev cap is bound by the $200 anthropic ceiling, not the $1000 all-ceiling",
  );
  assert.equal(
    res.ceilingUsd,
    200,
    "the same-provider ceiling is the one that applies",
  );
}

// Provider resolution: a provider-specific child with no matching provider
// ceiling falls back to the org 'all' ceiling.
{
  const ceilings: OrgCeiling[] = [{ providerScope: "all", amountUsd: 300 }];
  const res = checkCapWithinCeiling({
    scope: "dev",
    providerScope: "openai",
    amountUsd: 400,
    orgCeilings: ceilings,
  });
  assert.equal(
    res.ok,
    false,
    "an openai dev cap with no openai ceiling is bound by the all-ceiling",
  );
  assert.equal(res.ceilingUsd, 300, "the all-provider ceiling applied");
}

// ─── Rule 2: UTC period windows ─────────────────────────────────────────────

// A Wednesday resolves 'week' back to Monday 00:00 UTC.
{
  const now = new Date(Date.UTC(2026, 6, 22, 14, 30)); // Wed 2026-07-22 14:30 UTC
  const { start, end } = currentPeriodWindow("week", now);
  assert.equal(
    start.toISOString(),
    "2026-07-20T00:00:00.000Z",
    "week starts the preceding Monday 00:00 UTC",
  );
  assert.equal(end.getTime(), now.getTime(), "end is now (spend-so-far)");
}

// A Sunday is 6 days into the ISO week, not the start.
{
  const now = new Date(Date.UTC(2026, 6, 26, 9, 0)); // Sun 2026-07-26 09:00 UTC
  const { start } = currentPeriodWindow("week", now);
  assert.equal(
    start.toISOString(),
    "2026-07-20T00:00:00.000Z",
    "Sunday still maps back to the same Monday",
  );
}

// Monday itself is the start.
{
  const now = new Date(Date.UTC(2026, 6, 20, 3, 0)); // Mon 2026-07-20 03:00 UTC
  const { start } = currentPeriodWindow("week", now);
  assert.equal(
    start.toISOString(),
    "2026-07-20T00:00:00.000Z",
    "Monday is its own week start",
  );
}

// 'day' truncates to 00:00 UTC of the same date.
{
  const now = new Date(Date.UTC(2026, 6, 22, 23, 59)); // Wed 23:59 UTC
  const { start } = currentPeriodWindow("day", now);
  assert.equal(
    start.toISOString(),
    "2026-07-22T00:00:00.000Z",
    "day starts at 00:00 UTC",
  );
}

// 'month' truncates to the 1st 00:00 UTC.
{
  const now = new Date(Date.UTC(2026, 6, 22, 12, 0));
  const { start } = currentPeriodWindow("month", now);
  assert.equal(
    start.toISOString(),
    "2026-07-01T00:00:00.000Z",
    "month starts on the 1st 00:00 UTC",
  );
}

// ─── Closed-vocabulary guards ───────────────────────────────────────────────

assert.deepEqual(
  [...CAP_MODES],
  ["track", "enforce"],
  "mode names are exactly track/enforce",
);
assert.deepEqual([...CAP_PERIODS], ["day", "week", "month"]);
assert.deepEqual([...CAP_SCOPES], ["org", "team", "dev"]);
assert.equal(isCapMode("enforce"), true);
assert.equal(
  isCapMode("monitor"),
  false,
  "'monitor' is not a valid mode — only track/enforce",
);
assert.equal(isCapMode("fire-and-forget"), false);
assert.equal(isCapPeriod("week"), true);
assert.equal(isCapPeriod("year"), false);
assert.equal(isCapScope("dev"), true);
assert.equal(isCapScope("machine"), false);

console.log("cap-policy.test.ts: all assertions passed");
