/**
 * Minor units — the ONE place a dollar amount becomes the integer a payment
 * provider actually charges.
 *
 * Stripe's API (`unit_amount`) is denominated in
 * the currency's smallest unit. For USD that is cents, so `× 100`. For JPY the
 * smallest unit IS the yen, so `× 100` bills a customer one hundred times what
 * the invoice says. The multiplier is a property of the CURRENCY, never a
 * constant, and this module is where that lookup lives so no call site gets to
 * hard-code 100.
 *
 * SOURCES
 *   - ISO 4217 assigns each currency a "minor unit" exponent. That is the
 *     authority used below.
 *   - Stripe documents two backwards-compatibility exceptions, both verified
 *     against https://docs.stripe.com/currencies (the "Special cases"
 *     table): ISK and UGX are zero-decimal currencies that must still be
 *     sent as two-decimal values ending in 00. They are therefore NOT in the
 *     zero-decimal set here — sending them as exponent 0 would under-charge by
 *     100x. HUF and TWD are zero-decimal for PAYOUTS only and charge normally
 *     at two decimals, so they are absent for the same reason.
 *
 * KNOWN RESIDUAL RISK: the default is exponent 2. A currency with a non-2
 * exponent that is missing from the sets below would be mis-scaled. The sets
 * cover ISO 4217; a currency ISO adds (or a provider that disagrees with ISO)
 * needs a line here and a case in money.test.ts.
 */

/**
 * ISO 4217 exponent 0 — the smallest unit is the currency itself, so an amount
 * crosses to the provider unmultiplied. ISK and UGX are deliberately excluded;
 * see the header.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** ISO 4217 exponent 3 — 1.000 of these is 1000 minor units. */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

/**
 * The two currencies that are sent at exponent 2 but can only be charged in
 * whole units. Same Stripe "Special cases" table as the header: ISK and UGX
 * "must be represented as a two-decimal value, where the decimal amount is
 * always 00... You can't charge fractions of ISK."
 *
 * So a 1234.56 ISK invoice is not a rounding question, it is a request Stripe
 * answers with a 400 — which the merchant experiences as a Pay link that does
 * nothing at all.
 */
export const WHOLE_UNIT_ONLY_CURRENCIES: ReadonlySet<string> = new Set([
  "ISK",
  "UGX",
]);

/** How many minor units make one unit of this currency, as a power of ten. */
export function currencyExponent(currency: string): number {
  const code = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * The smallest step a provider will actually charge in, in minor units. 1 for
 * almost everything; 100 for the whole-unit-only currencies above.
 */
export function minorUnitStep(currency: string): number {
  return WHOLE_UNIT_ONLY_CURRENCIES.has(normalizeCurrency(currency)) ? 100 : 1;
}

/**
 * Floating point noise, not real precision. numeric(12,2) round-trips through
 * JS as 19.16 × 100 = 1915.9999999999998, and that is a whole cent.
 */
const SCALING_NOISE = 1e-6;

/**
 * Why this amount cannot be charged EXACTLY in this currency, in a sentence
 * the merchant can act on. Null when it can.
 *
 * toMinorUnits ROUNDS, which is the correct arithmetic and the wrong answer to
 * "does this invoice bill what it says". A JPY invoice can hold 6999.62 in a
 * numeric(12,2) column, and the customer would be charged 7000 yen against an
 * invoice that prints 6999.62. Ask this first and refuse, rather than move
 * somebody's money by a rounding rule they never saw.
 */
export function unchargeableReason(
  amount: unknown,
  currency: string,
): string | null {
  const code = normalizeCurrency(currency);
  const value = Number(amount);
  // Not a number at all is toMinorUnits' complaint to make, and it says it better.
  if (!Number.isFinite(value)) return null;

  const exponent = currencyExponent(code);
  const scaled = value * 10 ** exponent;
  if (Math.abs(scaled - Math.round(scaled)) > SCALING_NOISE) {
    return (
      `${value} ${code} is smaller than ${code} can be split. ` +
      (exponent === 0
        ? `${code} has no unit smaller than 1, so a fraction of one cannot be charged. `
        : `${code} goes to ${exponent} decimal places, and this has more. `) +
      `Change the invoice to an amount ${code} can express.`
    );
  }

  const step = minorUnitStep(code);
  if (step > 1 && Math.round(scaled) % step !== 0) {
    return (
      `${value} ${code} cannot be charged: payment providers only accept ${code} ` +
      `in whole units, so the amount has to end in .00. Round the invoice to a ` +
      `whole ${code}.`
    );
  }

  return null;
}

/**
 * Uppercase, trimmed ISO code. Throws on anything that isn't three letters —
 * `invoices.currency` is a free-text VarChar(3) with no allowlist behind it
 * (packages/db/prisma/schema.prisma), and guessing at a malformed code is how
 * you charge the wrong denomination.
 */
export function normalizeCurrency(currency: string): string {
  const code = String(currency ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `"${currency}" is not a currency code. MarginFront needs a three-letter ` +
        `ISO 4217 code (USD, EUR, JPY) to know how many decimal places the ` +
        `payment provider expects. Fix the invoice's currency field.`,
    );
  }
  return code;
}

/**
 * Dollars (or yen, or dinars) → the integer the provider charges.
 *
 * Rounds half-away-from-zero at the currency's own precision. Throws rather
 * than returning NaN: a non-finite amount reaching a provider is a charge of an
 * unknown size.
 */
export function toMinorUnits(amount: unknown, currency: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Cannot bill ${JSON.stringify(amount)} — it is not a number. ` +
        `Something upstream produced an empty or corrupt amount; check the ` +
        `invoice's line items and totals.`,
    );
  }
  const factor = 10 ** currencyExponent(currency);
  const minor = Math.round(Math.abs(value) * factor) * Math.sign(value);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(
      `Amount ${value} ${normalizeCurrency(currency)} is too large to bill ` +
        `precisely (${minor} minor units exceeds JavaScript's safe integer ` +
        `range). Split the invoice.`,
    );
  }
  // Math.sign(0) is 0, and -0 serializes as 0 anyway; normalise so callers
  // never see a negative zero in a payload.
  return minor === 0 ? 0 : minor;
}

/** The integer the provider charges → the number we store and display. */
export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

/**
 * The amount as a decimal string with exactly as many decimal places as the
 * currency has, never more.
 */
export function formatMinorUnits(minor: number, currency: string): string {
  if (!Number.isInteger(minor)) {
    throw new Error(
      `Minor units must be a whole number, got ${minor}. A fractional minor ` +
        `unit means an amount was scaled with the wrong currency exponent.`,
    );
  }
  return fromMinorUnits(minor, currency).toFixed(currencyExponent(currency));
}
