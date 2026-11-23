/**
 * The charge builder's own rules. The end-to-end proof that a real invoice
 * survives the whole trip lives in checkout-collects-invoice-total.spec.ts;
 * this file pins the decisions that file relies on.
 *
 * Every assertion here is about a promise the type makes to every adapter,
 * present and future: the rows add up to the charge, each row multiplies out,
 * and the amounts are in the currency's own minor unit.
 */
import { buildCollectibleCharge, CollectibleChargeInput } from './collectible-charge';

function charge(overrides: Partial<CollectibleChargeInput> = {}) {
  return buildCollectibleCharge({
    invoiceNumber: 'INV-001',
    currency: 'USD',
    totalAmount: 100,
    lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
    ...overrides,
  });
}

/** What a provider ends up collecting: it charges the rows, nothing else. */
function collected(built: ReturnType<typeof charge>): number {
  return built.lines.reduce((sum, line) => sum + line.unitAmountMinor * line.quantity, 0);
}

describe('CollectibleCharge — the invariants every adapter is handed', () => {
  it('the rows a provider multiplies out always come to the charge', () => {
    const built = charge({
      totalAmount: 149,
      lines: [
        { description: 'Monthly Platform Fee', quantity: 1, unitPrice: 50, amount: 50 },
        // The credit-pool shape: 400 × $0.25 is $100, but the bill is $99.
        { description: 'report: 400 × $0.2475', quantity: 400, unitPrice: 0.25, amount: 99 },
      ],
    });

    expect(built.itemized).toBe(true);
    expect(collected(built)).toBe(14900);
    expect(built.lines[1]).toEqual({
      label: 'report: 400 × $0.2475',
      amountMinor: 9900,
      quantity: 1,
      unitAmountMinor: 9900,
    });
  });

  it('NEGATIVE CONTROL: the per-unit price it discards is the one that overcharged', () => {
    // What a provider would have collected from the stored per-unit price.
    expect(400 * Math.round(0.25 * 100)).toBe(10000);
    expect(collected(charge({ totalAmount: 99, lines: [poolLine()] }))).toBe(9900);
  });

  it('keeps the breakdown when the per-unit price reproduces the line exactly', () => {
    const built = charge({
      totalAmount: 29.7,
      lines: [{ description: 'Seats', quantity: 3, unitPrice: 9.9, amount: 29.7 }],
    });
    expect(built.lines[0]).toMatchObject({ quantity: 3, unitAmountMinor: 990 });
  });

  it('collapses a fractional quantity rather than sending one a provider rejects', () => {
    const built = charge({
      totalAmount: 3.3,
      lines: [{ description: 'Usage', quantity: 0.066, unitPrice: 50, amount: 3.3 }],
    });
    expect(built.lines[0]).toMatchObject({ quantity: 1, unitAmountMinor: 330 });
  });
});

describe('CollectibleCharge — what it collects', () => {
  it('charges the balance still owed, not the invoice total', () => {
    const built = charge({ totalAmount: 100, amountDue: 40 });
    expect(built.totalMinor).toBe(4000);
    expect(collected(built)).toBe(4000);
    expect(built.bundleReason).toBe('partially-settled');
  });

  it('NEGATIVE CONTROL: charging the header total would double-bill the customer', () => {
    // $60 already wired against a $100 invoice. Charging the total would collect 10000.
    const built = charge({ totalAmount: 100, amountDue: 40 });
    expect(10000 - collected(built)).toBe(6000);
  });

  it('a credited invoice is charged its balance too', () => {
    expect(charge({ totalAmount: 100, amountDue: 60 }).totalMinor).toBe(6000);
  });

  it('never charges more than the invoice total, even if the balance drifted above it', () => {
    expect(charge({ totalAmount: 100, amountDue: 250 }).totalMinor).toBe(10000);
  });

  it('a missing balance means the whole total is owed', () => {
    expect(charge({ totalAmount: 100, amountDue: null }).totalMinor).toBe(10000);
    expect(charge({ totalAmount: 100, amountDue: undefined }).totalMinor).toBe(10000);
  });
});

describe('CollectibleCharge — currency', () => {
  it('a zero-decimal currency is not multiplied by a hundred', () => {
    const built = charge({
      currency: 'JPY',
      totalAmount: 10000,
      lines: [{ description: 'Monthly plan', quantity: 1, unitPrice: 10000, amount: 10000 }],
    });
    expect(built.totalMinor).toBe(10000);
    expect(collected(built)).toBe(10000);
  });

  it('NEGATIVE CONTROL: a blanket × 100 would bill a hundred times the invoice', () => {
    expect(
      Math.round(10000 * 100) / charge({ currency: 'JPY', totalAmount: 10000 }).totalMinor,
    ).toBe(100);
  });

  it('normalises the code so adapters never see a casing surprise', () => {
    expect(charge({ currency: ' usd ' }).currency).toBe('USD');
  });

  it('refuses to guess at a malformed currency', () => {
    expect(() => charge({ currency: 'dollars' })).toThrow(/not a currency code/);
  });
});

describe('CollectibleCharge — when the breakdown cannot be shown honestly', () => {
  it('an invoice with no line items is one row at the total', () => {
    const built = charge({ lines: [] });
    expect(built.lines).toEqual([
      { label: 'Invoice INV-001', amountMinor: 10000, quantity: 1, unitAmountMinor: 10000 },
    ]);
    expect(built.bundleReason).toBe('no-line-items');
  });

  it('header tax gets its own row so the rows still add up to the total', () => {
    const built = charge({
      totalAmount: 108.25,
      taxAmount: 8.25,
      lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
    });
    expect(built.itemized).toBe(true);
    expect(built.lines.map((line) => line.label)).toEqual(['Platform fee', 'Sales tax']);
    expect(collected(built)).toBe(10825);
  });

  it('NEGATIVE CONTROL: without the tax row the customer underpays by the tax', () => {
    const withoutTax = charge({
      totalAmount: 108.25,
      lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
    });
    // Rows sum to the subtotal, so the charge cannot itemize — but it still
    // collects the full 10825, because the total is what it bills.
    expect(withoutTax.bundleReason).toBe('lines-do-not-reconcile');
    expect(collected(withoutTax)).toBe(10825);
  });

  it('a header discount bundles, because a negative row is not a thing providers take', () => {
    const built = charge({
      totalAmount: 85,
      discountAmount: 15,
      lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
    });
    expect(built.bundleReason).toBe('header-discount');
    expect(collected(built)).toBe(8500);
  });

  it('a negative line bundles rather than reaching a provider as a negative row', () => {
    const built = charge({
      totalAmount: 80,
      lines: [
        { description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 },
        { description: 'Goodwill adjustment', quantity: 1, unitPrice: -20, amount: -20 },
      ],
    });
    expect(built.bundleReason).toBe('negative-line');
    expect(built.lines.every((line) => line.unitAmountMinor >= 0)).toBe(true);
    expect(collected(built)).toBe(8000);
  });

  it('more rows than a provider accepts bundles instead of 400ing at checkout', () => {
    const lines = Array.from({ length: 101 }, (_, index) => ({
      description: `Line ${index}`,
      quantity: 1,
      unitPrice: 1,
      amount: 1,
    }));
    const built = charge({ totalAmount: 101, lines });
    expect(built.bundleReason).toBe('too-many-lines');
    expect(built.lines).toHaveLength(1);
    expect(collected(built)).toBe(10100);
  });

  it('exactly the provider maximum still itemizes', () => {
    const lines = Array.from({ length: 100 }, (_, index) => ({
      description: `Line ${index}`,
      quantity: 1,
      unitPrice: 1,
      amount: 1,
    }));
    expect(charge({ totalAmount: 100, lines }).itemized).toBe(true);
  });

  it('a single minor unit of rounding drift is named as such, and stays quiet', () => {
    const built = charge({
      // Two sub-cent lines, each stored rounded, against a total rounded once.
      totalAmount: 100,
      lines: [
        { description: 'Seats, prorated', quantity: 5, unitPrice: 6.38, amount: 31.91 },
        { description: 'Tiered calls', quantity: 1300, unitPrice: 0.05, amount: 68.1 },
      ],
    });
    expect(built.bundleReason).toBe('rounding-drift');
    expect(collected(built)).toBe(10000);
  });

  it('rows that disagree with the header are the one reason that means something is wrong', () => {
    const built = charge({
      totalAmount: 75,
      lines: [
        { description: 'Platform fee', quantity: 1, unitPrice: 50, amount: 50 },
        { description: 'Usage', quantity: 10, unitPrice: 0.1, amount: 1 },
      ],
    });
    expect(built.bundleReason).toBe('lines-do-not-reconcile');
    expect(built.offeredRowsMinor).toBe(5100);
    expect(collected(built)).toBe(7500);
  });
});

describe('CollectibleCharge — the last gate', () => {
  it('refuses an amount that is not a number instead of billing a guess', () => {
    expect(() => charge({ totalAmount: undefined })).toThrow(/not a number/);
    expect(() =>
      charge({
        lines: [{ description: 'Broken', quantity: 1, unitPrice: 1, amount: 'oops' }],
      }),
    ).toThrow(/not a number/);
  });

  it('every charge it hands out satisfies every promise in its own header', () => {
    const shapes: Array<Partial<CollectibleChargeInput>> = [
      {},
      { lines: [] },
      { amountDue: 40 },
      { currency: 'JPY', totalAmount: 10000 },
      { taxAmount: 8.25, totalAmount: 108.25 },
      { discountAmount: 15, totalAmount: 85 },
      { totalAmount: 99, lines: [poolLine()] },
      {
        totalAmount: 3.3,
        lines: [{ description: 'Usage', quantity: 0.066, unitPrice: 50, amount: 3.3 }],
      },
    ];

    for (const shape of shapes) {
      const built = charge(shape);
      expect(built.lines.length).toBeGreaterThan(0);
      expect(collected(built)).toBe(built.totalMinor);
      for (const line of built.lines) {
        expect(Number.isInteger(line.unitAmountMinor)).toBe(true);
        expect(Number.isInteger(line.quantity)).toBe(true);
        expect(line.unitAmountMinor).toBeGreaterThanOrEqual(0);
        expect(line.quantity).toBeGreaterThanOrEqual(1);
        expect(line.unitAmountMinor * line.quantity).toBe(line.amountMinor);
      }
    }
  });

  it('the shape is frozen, so nothing downstream can edit the money', () => {
    const built = charge();
    expect(() => {
      (built as { totalMinor: number }).totalMinor = 1;
    }).toThrow();
  });
});

describe('CollectibleCharge — an amount the currency cannot express', () => {
  it('refuses a JPY total finer than a yen instead of rounding somebody up', () => {
    // numeric(12,2) will hold it and `invoices.currency` is free-text VarChar(3),
    // so this invoice is creatable. toMinorUnits would round 1.50 to 2 yen.
    expect(() =>
      charge({
        currency: 'JPY',
        totalAmount: 1.5,
        lines: [{ description: 'Usage', quantity: 3, unitPrice: 0.5, amount: 1.5 }],
      }),
    ).toThrow(/no unit smaller than 1/);
  });

  it('NEGATIVE CONTROL: this is the number rounding would collect', () => {
    // 6999.62 invoiced, 7000 collected.
    expect(Math.round(6999.62)).toBe(7000);
    expect(() =>
      charge({
        currency: 'JPY',
        totalAmount: 6999.62,
        lines: [{ description: 'Usage', quantity: 12345, unitPrice: 0.57, amount: 6999.62 }],
      }),
    ).toThrow(/JPY/);
  });

  it('refuses a balance the currency cannot express, not just a total', () => {
    expect(() => charge({ currency: 'JPY', totalAmount: 10000, amountDue: 4999.5 })).toThrow(
      /balance owing/,
    );
  });

  it('a whole-yen invoice is untouched', () => {
    const built = charge({
      currency: 'JPY',
      totalAmount: 10000,
      lines: [{ description: 'Fee', quantity: 1, unitPrice: 10000, amount: 10000 }],
    });
    expect(built.totalMinor).toBe(10000);
    expect(collected(built)).toBe(10000);
  });

  it('refuses an ISK total that is not a whole krona, because the provider will', () => {
    // Verified against docs.stripe.com/currencies ("Special cases"): ISK and UGX
    // are sent at two decimals but the decimals must be 00. Without this the
    // session 400s and the merchant sees a Pay link that does nothing.
    expect(() =>
      charge({
        currency: 'ISK',
        totalAmount: 1234.56,
        lines: [{ description: 'Fee', quantity: 1, unitPrice: 1234.56, amount: 1234.56 }],
      }),
    ).toThrow(/whole units/);
  });

  it('an ISK invoice whose rows are not whole krona still collects, as one row', () => {
    // The total clears the bar; only the breakdown cannot be shown. Itemization
    // is a courtesy, collecting the right total is not.
    const built = charge({
      currency: 'ISK',
      totalAmount: 2000,
      lines: [
        { description: 'Fee', quantity: 1, unitPrice: 1234.56, amount: 1234.56 },
        { description: 'Usage', quantity: 1, unitPrice: 765.44, amount: 765.44 },
      ],
    });

    expect(built.bundleReason).toBe('row-below-currency-step');
    expect(built.itemized).toBe(false);
    expect(built.totalMinor).toBe(200000);
    expect(collected(built)).toBe(200000);
    expect(built.lines[0].unitAmountMinor % 100).toBe(0);
  });

  it('a whole-krona ISK invoice keeps its breakdown', () => {
    const built = charge({
      currency: 'ISK',
      totalAmount: 2000,
      lines: [
        { description: 'Fee', quantity: 1, unitPrice: 1200, amount: 1200 },
        { description: 'Usage', quantity: 4, unitPrice: 200, amount: 800 },
      ],
    });

    expect(built.itemized).toBe(true);
    expect(collected(built)).toBe(200000);
  });
});

function poolLine() {
  return { description: 'report: 400 × $0.2475', quantity: 400, unitPrice: 0.25, amount: 99 };
}
