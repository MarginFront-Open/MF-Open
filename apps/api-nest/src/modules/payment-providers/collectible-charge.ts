/**
 * THE COLLECTIBLE CHARGE — the one description of "what this invoice charges"
 * that any payment provider is allowed to see.
 *
 * THE BUG CLASS THIS RULES OUT. An invoice line carries three money
 * columns — quantity, unitPrice, amount — and only `amount` is the bill.
 * `quantity × unitPrice` is a sentence about the bill, and for any blended
 * price it is a false one: a credit pool's real per-unit price on 400 credits
 * is $0.2475, numeric(12,2) stores it as $0.25, and Stripe Checkout charges
 * `unit_amount × quantity`. $99.00 invoiced, $100.00 collected, no error.
 * The same rounding can move money in either direction on pools, graduated
 * tiers, volume tiers and proration.
 *
 * A check inside one adapter would leave every other adapter free to make the
 * same mistake, because the wrong thing would still be expressible.
 *
 * HOW THIS MAKES IT INEXPRESSIBLE. A CollectibleCharge can only come out of
 * `buildCollectibleCharge` (the type is branded with a module-private symbol,
 * so no adapter and no test can hand-roll one), and it guarantees, for every
 * charge it ever produces:
 *
 *   1. Σ lines[].amountMinor === totalMinor.
 *   2. For every line, unitAmountMinor × quantity === amountMinor.
 *   3. Every amount is a non-negative integer in the currency's OWN minor
 *      unit — cents for USD, whole yen for JPY.
 *
 * (2) is the load-bearing one. A provider that multiplies out a per-unit price
 * and a provider that bills the line total arrive at the same number, so an
 * adapter has nothing left to get wrong. When a real per-unit price cannot
 * survive the round trip, the collapse to `quantity: 1` happens HERE, once, for
 * every provider — never in an adapter.
 *
 * WHAT IT COLLECTS. The balance still owed (`amountDue`), not the header total.
 * A customer who wired $60 against a $100 invoice and then clicked the Pay link
 * would otherwise be charged $100 again.
 *
 * WHEN THE BREAKDOWN CANNOT BE SHOWN. Itemization is a courtesy; collecting the
 * right total is not. Whenever the rows cannot be shown honestly — a partial
 * payment, a header discount that would need a negative row, more rows than the
 * provider accepts, or rows that simply do not add up — the charge collapses to
 * a single row at the amount owed and says WHY in `bundleReason`. Exactly one
 * of those reasons, `lines-do-not-reconcile`, means something is actually
 * wrong; the rest are ordinary invoices. Keeping them apart is the difference
 * between an alarm and noise.
 */
import {
  formatMinorUnits,
  minorUnitStep,
  normalizeCurrency,
  toMinorUnits,
  unchargeableReason,
} from '@marginfront/db';

declare const COLLECTIBLE_BRAND: unique symbol;

/**
 * One row a provider may display. `amountMinor` is what it collects;
 * quantity and unitAmountMinor are the same number said out loud.
 */
export interface CollectibleLine {
  readonly label: string;
  readonly amountMinor: number;
  readonly quantity: number;
  readonly unitAmountMinor: number;
}

/**
 * Why a charge is a single row instead of a breakdown. Only
 * `lines-do-not-reconcile` is a defect; the others are invoices doing normal
 * things that a provider's row format cannot express.
 */
export type BundleReason =
  | 'no-line-items'
  | 'partially-settled'
  | 'header-discount'
  | 'negative-line'
  | 'too-many-lines'
  | 'rounding-drift'
  | 'row-below-currency-step'
  | 'lines-do-not-reconcile';

/**
 * Each line amount is stored rounded, but the invoice total is the sum of the
 * UNROUNDED amounts rounded once. Put two sub-cent lines on one invoice and the
 * two can differ by a single minor unit. That is arithmetic, not a defect, and
 * it must not raise the alarm that a genuinely wrong invoice raises.
 *
 * This threshold only ever decides which NAME the gap gets. It never decides
 * what we collect: a charge always bills the invoice, to the unit.
 */
const ROUNDING_DRIFT_TOLERANCE_MINOR = 1;

export interface CollectibleCharge {
  /** Branded so this shape can only be built by buildCollectibleCharge. */
  readonly [COLLECTIBLE_BRAND]: true;
  /** Normalized ISO 4217 code. */
  readonly currency: string;
  /** What the provider must collect, in the currency's minor unit. */
  readonly totalMinor: number;
  /** Σ amountMinor === totalMinor. Never empty. */
  readonly lines: readonly CollectibleLine[];
  readonly itemized: boolean;
  readonly bundleReason: BundleReason | null;
  /** What the line rows added up to, when that is not what we collect. */
  readonly offeredRowsMinor: number;
  /**
   * How much of this charge is tax MarginFront has already computed. A provider
   * with its own tax engine has to be told to keep it off for this session, or
   * it adds a second tax on top of the first one and the customer pays twice.
   */
  readonly taxMinor: number;
}

export interface CollectibleChargeInput {
  invoiceNumber: string;
  currency: string;
  /** Header total, in currency units (dollars). */
  totalAmount: unknown;
  /** Balance still owed. Undefined/null means "the whole total". */
  amountDue?: unknown;
  taxAmount?: unknown;
  discountAmount?: unknown;
  lines: ReadonlyArray<{
    description: string;
    quantity: unknown;
    unitPrice: unknown;
    amount: unknown;
  }>;
}

/**
 * Stripe documents a maximum of 100 line items for a `payment`-mode Checkout
 * Session (docs.stripe.com/api/checkout/sessions/create).
 * Past that we bundle rather than
 * hand the provider a request it will reject, which would leave the customer
 * with a Pay link that does nothing.
 */
export const MAX_PROVIDER_LINE_ITEMS = 100;

/** Row labels are truncated to what providers accept for a product name. */
const MAX_LABEL_LENGTH = 250;

/**
 * The ONLY way to describe money to a payment provider.
 *
 * Throws when the invoice cannot be charged at all (unusable currency, a total
 * that is not a number, an amount finer than the currency can be split). A
 * caller that wants a friendlier message should catch and re-throw — do not
 * defend by guessing an amount.
 */
export function buildCollectibleCharge(input: CollectibleChargeInput): CollectibleCharge {
  const currency = normalizeCurrency(input.currency);
  const totalMinor = exactMinor(input.totalAmount, currency, `Invoice ${input.invoiceNumber}`);

  // Never collect more than the invoice's own total, even if amountDue has
  // drifted above it — an over-collection is the failure this file exists to
  // prevent, and a stale balance must not become a licence for one.
  const dueRaw = Number(input.amountDue);
  const collectMinor =
    input.amountDue === null || input.amountDue === undefined || !Number.isFinite(dueRaw)
      ? totalMinor
      : Math.min(
          totalMinor,
          exactMinor(dueRaw, currency, `The balance owing on invoice ${input.invoiceNumber}`),
        );

  const taxMinor = optionalMinor(input.taxAmount, currency);

  const bundled = (reason: BundleReason, offeredRowsMinor: number): CollectibleCharge =>
    seal({
      currency,
      totalMinor: collectMinor,
      lines: [
        {
          label: label(`Invoice ${input.invoiceNumber}`),
          amountMinor: collectMinor,
          quantity: 1,
          unitAmountMinor: collectMinor,
        },
      ],
      itemized: false,
      bundleReason: reason,
      offeredRowsMinor,
      taxMinor,
    });

  const rows = input.lines.map((line) => {
    const amountMinor = toMinorUnits(line.amount, currency);
    const unitAmountMinor = toMinorUnits(line.unitPrice, currency);
    const quantity = Number(line.quantity);
    // Keep the per-unit sentence only when it is true. A fractional quantity
    // and a per-unit price flattened by numeric(12,2) storage both
    // break it, and a provider multiplying either one collects a different
    // number than the invoice.
    const multipliesOut =
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      Number.isSafeInteger(unitAmountMinor * quantity) &&
      unitAmountMinor * quantity === amountMinor;

    return {
      label: label(line.description),
      amountMinor,
      quantity: multipliesOut ? quantity : 1,
      unitAmountMinor: multipliesOut ? unitAmountMinor : amountMinor,
    };
  });

  // Header tax is not a line item, but Stripe charges the rows and nothing
  // else, so an un-itemized tax is tax we never collect. Give it a row.
  if (taxMinor > 0) {
    rows.push({
      label: 'Sales tax',
      amountMinor: taxMinor,
      quantity: 1,
      unitAmountMinor: taxMinor,
    });
  }

  const offeredRowsMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);

  if (rows.length === 0) return bundled('no-line-items', 0);
  if (rows.length > MAX_PROVIDER_LINE_ITEMS) return bundled('too-many-lines', offeredRowsMinor);
  // A discount has to come off the rows somewhere, and providers reject a
  // negative row. One honest row at the discounted balance beats a breakdown
  // that adds up to more than the customer pays.
  if (optionalMinor(input.discountAmount, currency) > 0)
    return bundled('header-discount', offeredRowsMinor);
  if (rows.some((row) => row.amountMinor < 0)) return bundled('negative-line', offeredRowsMinor);
  // ISK and UGX are charged in whole units only, so a row of 12.34 is a request
  // the provider rejects outright. The TOTAL still has to clear that bar — seal
  // refuses if it does not — but a breakdown is a courtesy, and one row at the
  // amount owed is a courtesy the provider will accept.
  const step = minorUnitStep(currency);
  if (step > 1 && rows.some((row) => row.unitAmountMinor % step !== 0))
    return bundled('row-below-currency-step', offeredRowsMinor);
  if (collectMinor !== totalMinor) return bundled('partially-settled', offeredRowsMinor);
  if (offeredRowsMinor !== collectMinor) {
    return bundled(
      Math.abs(offeredRowsMinor - collectMinor) <= ROUNDING_DRIFT_TOLERANCE_MINOR
        ? 'rounding-drift'
        : 'lines-do-not-reconcile',
      offeredRowsMinor,
    );
  }

  return seal({
    currency,
    totalMinor: collectMinor,
    lines: rows,
    itemized: true,
    bundleReason: null,
    offeredRowsMinor,
    taxMinor,
  });
}

/** Human-readable amount for logs and error copy. Never a raw minor-unit int. */
export function formatCharge(charge: CollectibleCharge): string {
  return `${formatMinorUnits(charge.totalMinor, charge.currency)} ${charge.currency}`;
}

function label(text: string): string {
  return String(text ?? '').slice(0, MAX_LABEL_LENGTH);
}

function optionalMinor(value: unknown, currency: string): number {
  if (value === null || value === undefined) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return toMinorUnits(numeric, currency);
}

/**
 * A minor-unit amount, or a refusal.
 *
 * toMinorUnits rounds, and rounding is the right arithmetic and the wrong
 * answer here: `invoices.currency` is a free-text VarChar(3), so a JPY invoice
 * can hold 6999.62 and quietly collect 7000 yen. The invariant this module
 * exists for is that the customer pays what the invoice says, and an amount the
 * currency cannot express has no such number. Refuse and say why.
 */
function exactMinor(value: unknown, currency: string, what: string): number {
  const reason = unchargeableReason(value, currency);
  if (reason) throw new Error(`${what} cannot be charged. ${reason}`);
  return toMinorUnits(value, currency);
}

/**
 * The last gate. Every promise in this file's header is re-checked here, so an
 * edit to the logic above cannot quietly ship a charge that breaks one:
 * it throws instead, and no session is created at all.
 */
function seal(charge: Omit<CollectibleCharge, typeof COLLECTIBLE_BRAND>): CollectibleCharge {
  const { totalMinor, lines, currency } = charge;
  const step = minorUnitStep(currency);

  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new Error(`Collectible total ${totalMinor} is not a whole non-negative amount.`);
  }
  if (totalMinor % step !== 0) {
    throw new Error(
      `${formatMinorUnits(totalMinor, currency)} ${currency} cannot be charged: ${currency} is ` +
        `only accepted in whole units. Round the invoice to a whole ${currency}.`,
    );
  }

  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0) {
      throw new Error(`Line "${line.label}" bills ${line.amountMinor}, which cannot be charged.`);
    }
    if (line.unitAmountMinor % step !== 0) {
      throw new Error(
        `Line "${line.label}" charges ${formatMinorUnits(line.unitAmountMinor, currency)} ` +
          `${currency} per unit, and ${currency} is only accepted in whole units.`,
      );
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new Error(`Line "${line.label}" has quantity ${line.quantity}.`);
    }
    if (line.unitAmountMinor * line.quantity !== line.amountMinor) {
      throw new Error(
        `Line "${line.label}" says ${line.quantity} × ${line.unitAmountMinor} but bills ` +
          `${line.amountMinor}. A provider would collect the product, not the amount.`,
      );
    }
  }

  const summed = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (summed !== totalMinor) {
    throw new Error(
      `Collectible rows add up to ${summed} but the charge is ${totalMinor}. ` +
        `Refusing to send a provider rows that collect the wrong amount.`,
    );
  }

  return Object.freeze(charge) as CollectibleCharge;
}
