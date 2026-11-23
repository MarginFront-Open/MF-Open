/**
 * money: the currency-aware scaling every payment provider call goes through.
 *
 * Pure, no DB hit. Standalone assert script, the packages/db src convention:
 *
 *   npx tsx packages/db/src/lib/money.test.ts
 *
 * WHY THIS IS LOAD-BEARING: a hard-coded `× 100` multiplies every amount by
 * 100 regardless of currency. A ¥10,000 invoice would go to Stripe as
 * 1,000,000, and since the yen has no smaller unit, that is a ¥1,000,000
 * charge. A 100x overcharge with no error raised. The NEGATIVE CONTROL below
 * replays a hard-coded `× 100` and shows exactly that, so this file can fail.
 */

import assert from "node:assert/strict";

import {
  ZERO_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  currencyExponent,
  formatMinorUnits,
  fromMinorUnits,
  minorUnitStep,
  normalizeCurrency,
  toMinorUnits,
  unchargeableReason,
} from "./money";

// --- exponents ---------------------------------------------------------

assert.equal(currencyExponent("USD"), 2);
assert.equal(currencyExponent("eur"), 2);
assert.equal(currencyExponent("JPY"), 0);
assert.equal(currencyExponent("krw"), 0);
assert.equal(currencyExponent("KWD"), 3);
assert.equal(currencyExponent("  gbp  "), 2);

// ISK and UGX are zero-decimal currencies that Stripe still requires as
// two-decimal values (docs.stripe.com/currencies, "Special cases"). Treating
// them as exponent 0 would bill 1/100th of the invoice.
assert.equal(currencyExponent("ISK"), 2);
assert.equal(currencyExponent("UGX"), 2);
assert.ok(!ZERO_DECIMAL_CURRENCIES.has("ISK"));
assert.ok(!ZERO_DECIMAL_CURRENCIES.has("UGX"));
// HUF and TWD are zero-decimal for payouts only; charges are two-decimal.
assert.equal(currencyExponent("HUF"), 2);
assert.equal(currencyExponent("TWD"), 2);

// The two sets must stay disjoint or the lookup order silently decides.
for (const code of ZERO_DECIMAL_CURRENCIES) {
  assert.ok(
    !THREE_DECIMAL_CURRENCIES.has(code),
    `${code} is in both the zero- and three-decimal sets`,
  );
}

// --- scaling -----------------------------------------------------------

assert.equal(toMinorUnits(99, "USD"), 9900);
assert.equal(toMinorUnits(99.005, "USD"), 9901, "half-up at the cent");
assert.equal(toMinorUnits(0.1 + 0.2, "USD"), 30, "float noise rounds away");
assert.equal(
  toMinorUnits(-19.16, "USD"),
  -1916,
  "negatives round symmetrically",
);
assert.equal(
  toMinorUnits("108.00", "USD"),
  10800,
  "decimal strings from Prisma",
);

// Zero- and three-decimal currencies scale by their own exponent.
assert.equal(toMinorUnits(10000, "JPY"), 10000);
assert.equal(toMinorUnits(10.25, "KWD"), 10250);

// NEGATIVE CONTROL — a hard-coded × 100. This is the number Stripe would
// receive.
const legacyCents = (amount: number) => Math.round(amount * 100);
assert.equal(legacyCents(10000), 1_000_000);
assert.equal(
  legacyCents(10000) / toMinorUnits(10000, "JPY"),
  100,
  "a hard-coded × 100 bills a JPY invoice one hundred times over",
);

// Non-numbers are a charge of unknown size, not a zero.
assert.throws(() => toMinorUnits(undefined, "USD"), /not a number/);
assert.throws(() => toMinorUnits(NaN, "USD"), /not a number/);
assert.throws(() => toMinorUnits("nine dollars", "USD"), /not a number/);
assert.throws(() => toMinorUnits(1e15, "USD"), /too large to bill/);

// A malformed currency must not fall back to "probably cents".
assert.throws(() => toMinorUnits(10, ""), /not a currency code/);
assert.throws(() => toMinorUnits(10, "US"), /not a currency code/);
assert.throws(() => toMinorUnits(10, "dollars"), /not a currency code/);
assert.equal(normalizeCurrency(" usd "), "USD");

// --- round trip + formatting -------------------------------------------

assert.equal(fromMinorUnits(9900, "USD"), 99);
assert.equal(fromMinorUnits(10000, "JPY"), 10000);
assert.equal(formatMinorUnits(9900, "USD"), "99.00");
assert.equal(formatMinorUnits(10000, "JPY"), "10000");
assert.equal(formatMinorUnits(10250, "KWD"), "10.250");
assert.throws(() => formatMinorUnits(99.5, "USD"), /whole number/);

for (const currency of ["USD", "JPY", "KWD", "EUR"]) {
  for (const amount of [0, 1, 19.16, 99, 108.35, 1234.5]) {
    const minor = toMinorUnits(amount, currency);
    assert.equal(
      toMinorUnits(fromMinorUnits(minor, currency), currency),
      minor,
      `${amount} ${currency} does not survive a round trip`,
    );
  }
}

// --- what a currency can and cannot be charged in ------------------------

// Almost every currency charges in single minor units.
assert.equal(minorUnitStep("USD"), 1);
assert.equal(minorUnitStep("JPY"), 1);
assert.equal(minorUnitStep("KWD"), 1);
// ISK and UGX do not. Same Stripe "Special cases" table: they are sent at two
// decimals but "the decimal amount is always 00... You can't charge fractions
// of ISK." A session below that step is a 400, i.e. a Pay link that does nothing.
assert.equal(minorUnitStep("ISK"), 100);
assert.equal(minorUnitStep("ugx"), 100);

// Ordinary amounts are chargeable and say nothing.
assert.equal(unchargeableReason(99, "USD"), null);
assert.equal(unchargeableReason(19.16, "USD"), null);
assert.equal(unchargeableReason(0.005 + 0.005, "USD"), null);
assert.equal(unchargeableReason(10000, "JPY"), null);
assert.equal(unchargeableReason(19.16, "KWD"), null);
assert.equal(unchargeableReason(1234, "ISK"), null);

// numeric(12,2) can hold a JPY amount finer than the yen. toMinorUnits would
// round 1.50 to 2 and 6999.62 to 7000 — correct arithmetic, wrong bill.
assert.match(unchargeableReason(1.5, "JPY") ?? "", /no unit smaller than 1/);
assert.match(
  unchargeableReason(6999.62, "JPY") ?? "",
  /smaller than JPY can be split/,
);
assert.equal(toMinorUnits(6999.62, "JPY"), 7000);
assert.equal(
  toMinorUnits(1.5, "JPY"),
  2,
  "the rounding is right; charging it against a 1.50 invoice is not",
);

// A three-decimal currency has three, not four.
assert.equal(unchargeableReason(19.161, "KWD"), null);
assert.match(unchargeableReason(19.1615, "KWD") ?? "", /decimal places/);

// ISK/UGX: representable at two decimals, still not chargeable.
assert.equal(toMinorUnits(1234.56, "ISK"), 123456);
assert.match(unchargeableReason(1234.56, "ISK") ?? "", /whole units/);
assert.match(unchargeableReason(1234.5, "UGX") ?? "", /whole units/);

// "Not a number" stays toMinorUnits' complaint — it words it better.
assert.equal(unchargeableReason(undefined, "USD"), null);
assert.equal(unchargeableReason("nine", "USD"), null);

console.log("money.test.ts: all assertions passed");
