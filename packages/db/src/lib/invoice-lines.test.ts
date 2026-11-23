/**
 * invoice-lines: which of the three money columns on a line item is the truth.
 *
 * Pure, no DB hit. Standalone assert script, the packages/db src convention:
 *
 *   npx tsx packages/db/src/lib/invoice-lines.test.ts
 *
 * WHY THIS IS LOAD-BEARING: a writer that recomputes
 * `amount = quantity × unitPrice` and derives the header total from it gets
 * the bill wrong. Feed it a credit-pool line as stored — 400 credits, unitPrice $0.25,
 * amount $99.00 — and the invoice comes back out as $100.00. The NEGATIVE
 * CONTROL below replays that recomputation on the same input and shows the
 * dollar it invents.
 */

import assert from "node:assert/strict";

import { invoiceLineAmount, invoiceSubtotal } from "./invoice-lines";

// A blended-price line as numeric(12,2) stores it: the product is NOT the bill.
const pooledCredits = { quantity: 400, unitPrice: 0.25, amount: 99 };

assert.equal(invoiceLineAmount(pooledCredits), 99);

// NEGATIVE CONTROL — recomputing amount from quantity × unitPrice.
const recomputed = pooledCredits.quantity * pooledCredits.unitPrice;
assert.equal(recomputed, 100);
assert.equal(
  recomputed - invoiceLineAmount(pooledCredits),
  1,
  "recomputing the product invents a dollar on this line",
);

// A human typing "3 hours at $150" states no amount, so it is derived.
assert.equal(invoiceLineAmount({ quantity: 3, unitPrice: 150 }), 450);
assert.equal(
  invoiceLineAmount({ quantity: 3, unitPrice: 150, amount: null }),
  450,
);
assert.equal(
  invoiceLineAmount({ quantity: 3, unitPrice: 150, amount: undefined }),
  450,
);

// A stated zero is a real charge of nothing, not a missing value.
assert.equal(invoiceLineAmount({ quantity: 5, unitPrice: 20, amount: 0 }), 0);

// Garbage in the amount field falls back rather than billing NaN.
assert.equal(
  invoiceLineAmount({ quantity: 2, unitPrice: 10, amount: NaN }),
  20,
);

// A credit line is legitimately negative and must survive as stated.
assert.equal(
  invoiceLineAmount({ quantity: 1, unitPrice: -20, amount: -20 }),
  -20,
);

// --- subtotal ----------------------------------------------------------

const mixed = [
  { description: "pool", quantity: 400, unitPrice: 0.25, amount: 99 },
  { description: "platform", quantity: 1, unitPrice: 50, amount: 50 },
  { description: "hours", quantity: 3, unitPrice: 150 },
];
assert.equal(invoiceSubtotal(mixed), 599);

// NEGATIVE CONTROL — the same three lines under the recompute rule.
assert.equal(
  mixed.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  600,
);

assert.equal(invoiceSubtotal([]), 0);

console.log("invoice-lines.test.ts: all assertions passed");
