/**
 * canon-math: rollupEventCosts C1 fold.
 *
 * Pure, no DB hit. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/canon-math.test.ts
 *
 * WHY this test is load-bearing: this fold is the ONE legal way to sum event
 * costs from in-memory rows (the matter audit/export builders on both apps).
 * The C1 contract it pins: a null cost adds 0 to the sum, still counts as an
 * event, and increments eventsMissingCost — never silently zeroed. If someone
 * "simplifies" the null branch away, the export totals stay right but the
 * needs-attention count reads 0 and under-billing goes invisible.
 */

import assert from "node:assert/strict";

import { rollupEventCosts } from "./canon-math";

// Mixed rows — the shape every builder feeds it.
const mixed = rollupEventCosts([
  { usageCost: 1.25 },
  { usageCost: null },
  { usageCost: 3.3 },
  { usageCost: 0 },
  { usageCost: null },
]);
assert.deepEqual(mixed, { cost: 4.55, eventCount: 5, eventsMissingCost: 2 });

// A genuine $0 cost is resolved, not missing (same distinction as CANON V3's
// zero-rate rule: zero is a price, null is a gap).
const zeros = rollupEventCosts([{ usageCost: 0 }, { usageCost: 0 }]);
assert.deepEqual(zeros, { cost: 0, eventCount: 2, eventsMissingCost: 0 });

// All-null bucket: honest $0 with every event flagged.
const allNull = rollupEventCosts([{ usageCost: null }, { usageCost: null }]);
assert.deepEqual(allNull, { cost: 0, eventCount: 2, eventsMissingCost: 2 });

// Empty input: zero rollup, nothing flagged.
assert.deepEqual(rollupEventCosts([]), {
  cost: 0,
  eventCount: 0,
  eventsMissingCost: 0,
});

// Extra fields on the rows ride along untouched (builders pass full events).
const widened = rollupEventCosts([
  { usageCost: 2, eventId: "a" } as { usageCost: number | null },
]);
assert.equal(widened.cost, 2);

console.log(
  "[canon-math] OK — rollupEventCosts C1 fold: null adds 0 + flags, zero is a price, empty is zero",
);
