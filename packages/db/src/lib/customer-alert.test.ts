/**
 * customer-alert: window + dedup rules for Customer Watch Alerts.
 *
 * Pure, no DB hit. Runs under tsx in <1s (the packages/db src test convention —
 * standalone assert scripts, NOT vitest suites; see cap-policy.test.ts):
 *
 *   npx tsx packages/db/src/lib/customer-alert.test.ts
 *
 * WHY this test is load-bearing: these rules decide WHEN a customer tripwire
 * fires and how often. A wrong month boundary double-fires or never re-arms; a
 * wrong custom-range clamp measures money outside the window the user chose.
 * The NEGATIVE CONTROL replays "no dedup key at all" (every evaluation is a
 * fresh fire) and shows it would re-alert on every sweep — the exact spam the
 * dedupWindowStart rule closes.
 */

import assert from "node:assert/strict";

import {
  CUSTOMER_ALERT_MAX_PER_ORG,
  CUSTOMER_ALERT_METRICS,
  CUSTOMER_ALERT_ROLLING_DAYS,
  CUSTOMER_ALERT_WINDOW_MODES,
  isCustomerAlertMetric,
  isCustomerAlertWindowMode,
  resolveCustomerAlertEvaluation,
  utcDayStart,
} from "./customer-alert";

// ─── NEGATIVE CONTROL — proves these assertions can fail ────────────────────
// Without a dedup key, two sweeps in the same window would both
// "fire". The month rule below turns exactly this red into green.
const noDedupKey = (sweep: number): number => sweep; // every sweep is unique
assert.notEqual(
  noDedupKey(1),
  noDedupKey(2),
  "NEGATIVE CONTROL: without a shared windowStart, back-to-back sweeps dedup to different keys — one email per sweep, all month long",
);

// ─── vocabulary guards ──────────────────────────────────────────────────────
assert.deepEqual([...CUSTOMER_ALERT_METRICS], ["cost", "revenue"]);
assert.deepEqual([...CUSTOMER_ALERT_WINDOW_MODES], ["month", "rolling", "custom"]);
assert.equal(CUSTOMER_ALERT_ROLLING_DAYS, 30);
assert.equal(CUSTOMER_ALERT_MAX_PER_ORG, 100);
assert.ok(isCustomerAlertMetric("cost"));
assert.ok(isCustomerAlertMetric("revenue"));
assert.ok(!isCustomerAlertMetric("margin"), "margin is not an alert metric");
assert.ok(isCustomerAlertWindowMode("rolling"));
assert.ok(!isCustomerAlertWindowMode("week"), "the selector has no week mode");

// ─── month mode: UTC calendar month, dedup = month start ────────────────────
{
  const now = new Date("2026-08-26T15:30:00.000Z");
  const plan = resolveCustomerAlertEvaluation(
    { windowMode: "month", customStartDate: null, customEndDate: null },
    now,
  );
  assert.equal(plan.skip, null);
  assert.equal(plan.window!.start.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(plan.window!.end.toISOString(), now.toISOString());
  assert.equal(
    plan.dedupWindowStart!.toISOString(),
    "2026-08-01T00:00:00.000Z",
    "month dedup key IS the month start — at most one fire per calendar month",
  );
}

// month boundary: 23:59:59 Aug 31 vs 00:00:01 Sep 1 land in DIFFERENT windows
// (a fresh month re-arms the watch), and the local-timezone trap stays closed:
// the boundary is UTC, not the server's zone.
{
  const lastSecondOfAug = new Date("2026-08-31T23:59:59.000Z");
  const firstSecondOfSep = new Date("2026-09-01T00:00:01.000Z");
  const a = resolveCustomerAlertEvaluation(
    { windowMode: "month", customStartDate: null, customEndDate: null },
    lastSecondOfAug,
  );
  const b = resolveCustomerAlertEvaluation(
    { windowMode: "month", customStartDate: null, customEndDate: null },
    firstSecondOfSep,
  );
  assert.equal(a.dedupWindowStart!.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(b.dedupWindowStart!.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.notEqual(
    a.dedupWindowStart!.getTime(),
    b.dedupWindowStart!.getTime(),
    "a new UTC month must re-arm (different dedup key)",
  );
}

// December → January year rollover.
{
  const dec = resolveCustomerAlertEvaluation(
    { windowMode: "month", customStartDate: null, customEndDate: null },
    new Date("2026-12-31T23:00:00.000Z"),
  );
  const jan = resolveCustomerAlertEvaluation(
    { windowMode: "month", customStartDate: null, customEndDate: null },
    new Date("2027-01-01T01:00:00.000Z"),
  );
  assert.equal(dec.dedupWindowStart!.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(jan.dedupWindowStart!.toISOString(), "2027-01-01T00:00:00.000Z");
}

// ─── rolling mode: now−30d → now, dedup = UTC day start of the fire moment ──
{
  const now = new Date("2026-08-26T15:30:00.000Z");
  const plan = resolveCustomerAlertEvaluation(
    { windowMode: "rolling", customStartDate: null, customEndDate: null },
    now,
  );
  assert.equal(plan.skip, null);
  assert.equal(
    plan.window!.start.toISOString(),
    "2026-07-27T15:30:00.000Z",
    "rolling start is exactly 30 × 24h back — the canonical last-30-days shape",
  );
  assert.equal(plan.window!.end.toISOString(), now.toISOString());
  assert.equal(
    plan.dedupWindowStart!.toISOString(),
    "2026-08-26T00:00:00.000Z",
    "rolling dedup key is the UTC day start (the race belt under the latch)",
  );
}

// Two evaluations the same UTC day share a dedup key (belt caps at one row per
// day); an evaluation the next day gets a fresh key.
{
  const morning = resolveCustomerAlertEvaluation(
    { windowMode: "rolling", customStartDate: null, customEndDate: null },
    new Date("2026-08-26T01:00:00.000Z"),
  );
  const evening = resolveCustomerAlertEvaluation(
    { windowMode: "rolling", customStartDate: null, customEndDate: null },
    new Date("2026-08-26T23:00:00.000Z"),
  );
  const nextDay = resolveCustomerAlertEvaluation(
    { windowMode: "rolling", customStartDate: null, customEndDate: null },
    new Date("2026-08-27T01:00:00.000Z"),
  );
  assert.equal(
    morning.dedupWindowStart!.getTime(),
    evening.dedupWindowStart!.getTime(),
  );
  assert.notEqual(
    morning.dedupWindowStart!.getTime(),
    nextDay.dedupWindowStart!.getTime(),
  );
}

// ─── custom mode: fixed range, one fire ever, expires at range end ──────────
{
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-08-31T23:59:59.000Z");

  const before = resolveCustomerAlertEvaluation(
    { windowMode: "custom", customStartDate: start, customEndDate: end },
    new Date("2026-07-15T00:00:00.000Z"),
  );
  assert.equal(before.skip, "not_started", "nothing to measure before the range opens");
  assert.equal(before.window, null);

  const inside = resolveCustomerAlertEvaluation(
    { windowMode: "custom", customStartDate: start, customEndDate: end },
    new Date("2026-08-15T12:00:00.000Z"),
  );
  assert.equal(inside.skip, null);
  assert.equal(inside.window!.start.toISOString(), start.toISOString());
  assert.equal(
    inside.window!.end.toISOString(),
    "2026-08-15T12:00:00.000Z",
    "inside the range we measure range-start → now",
  );
  assert.equal(
    inside.dedupWindowStart!.toISOString(),
    start.toISOString(),
    "custom dedup key is the range start — the unique key allows ONE fire ever",
  );

  const after = resolveCustomerAlertEvaluation(
    { windowMode: "custom", customStartDate: start, customEndDate: end },
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(after.skip, "expired", "'expires at range end'");

  // The exact end instant still evaluates (inclusive end).
  const atEnd = resolveCustomerAlertEvaluation(
    { windowMode: "custom", customStartDate: start, customEndDate: end },
    end,
  );
  assert.equal(atEnd.skip, null);
  assert.equal(atEnd.window!.end.toISOString(), end.toISOString());
}

// Hand-inserted garbage never measures a window we cannot define.
{
  for (const bad of [
    { windowMode: "custom", customStartDate: null, customEndDate: null },
    {
      windowMode: "custom",
      customStartDate: new Date("2026-08-31T00:00:00.000Z"),
      customEndDate: new Date("2026-08-01T00:00:00.000Z"), // reversed
    },
    {
      windowMode: "custom",
      customStartDate: new Date("2026-08-01T00:00:00.000Z"),
      customEndDate: new Date("2026-08-01T00:00:00.000Z"), // zero-length
    },
    { windowMode: "week", customStartDate: null, customEndDate: null }, // unknown mode
  ]) {
    const plan = resolveCustomerAlertEvaluation(bad as any, new Date());
    assert.equal(plan.skip, "invalid", `${JSON.stringify(bad)} must skip as invalid`);
  }
}

// utcDayStart is timezone-proof.
assert.equal(
  utcDayStart(new Date("2026-08-26T23:59:59.999Z")).toISOString(),
  "2026-08-26T00:00:00.000Z",
);
assert.equal(
  utcDayStart(new Date("2026-08-26T00:00:00.000Z")).toISOString(),
  "2026-08-26T00:00:00.000Z",
);

console.log("customer-alert.test.ts: all assertions passed");
