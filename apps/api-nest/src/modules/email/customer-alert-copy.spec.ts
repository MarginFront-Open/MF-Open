/**
 * The honest-copy proofs for customer-watch emails.
 *
 * These pin the copy rules as LITERAL strings so a future edit that implies a
 * watch bills, blocks, or throttles the customer fails CI, not a customer's
 * trust:
 *   - A watch WATCHES: every variant says nothing changed / changes for the
 *     customer, and no variant claims to stop or limit anything.
 *   - The trigger email names the measured value, the threshold, and the
 *     window in the user's own vocabulary (this month / last 30 days / custom).
 *   - The re-fire promise matches the mode: month re-arms monthly, rolling
 *     fires once per crossing, custom fires once and expires.
 *   - Cost reads "costs you", revenue reads "owes you" — the two metrics must
 *     never share a phrase, or a user can't tell which line fired.
 */

import { buildCustomerAlertContent, CustomerAlertCopyInput } from './customer-alert-copy';

const base: CustomerAlertCopyInput = {
  variant: 'trigger',
  customerName: 'Acme',
  metric: 'cost',
  thresholdUsd: 500,
  windowMode: 'month',
  customStartDate: null,
  customEndDate: null,
  valueUsd: 512.4,
  asOf: new Date('2026-08-26T12:00:00.000Z'),
};

const content = (over: Partial<CustomerAlertCopyInput> = {}) =>
  buildCustomerAlertContent({ ...base, ...over });

const allText = (c: ReturnType<typeof buildCustomerAlertContent>) =>
  `${c.subject} ${c.headline} ${c.whatHappened} ${c.whatItMeans} ${c.whatToDo}`;

describe('buildCustomerAlertContent — trigger names value, threshold, and window', () => {
  it('a month cost trigger carries the value, the threshold, and "this month"', () => {
    const c = content();
    expect(c.whatHappened).toContain('$512.40');
    expect(c.whatHappened).toContain('$500.00');
    expect(c.whatHappened).toContain('this month');
    expect(c.subject).toContain('Acme');
    expect(c.subject).toContain('$500.00');
    expect(c.subject).toContain('cost');
  });

  it('a rolling trigger says "the last 30 days"', () => {
    const c = content({ windowMode: 'rolling' });
    expect(c.whatHappened).toContain('the last 30 days');
  });

  it('a custom trigger names both UTC range ends', () => {
    const c = content({
      windowMode: 'custom',
      customStartDate: new Date('2026-08-01T00:00:00.000Z'),
      customEndDate: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(c.whatHappened).toContain('Aug 1, 2026');
    expect(c.whatHappened).toContain('Aug 31, 2026');
  });
});

describe('buildCustomerAlertContent — cost vs revenue phrasing never blurs', () => {
  it("cost reads 'costs you'", () => {
    const c = content({ metric: 'cost' });
    expect(c.whatHappened).toContain('Acme costs you');
    expect(allText(c)).not.toContain('owes you');
  });

  it("revenue reads 'owes you'", () => {
    const c = content({ metric: 'revenue' });
    expect(c.whatHappened).toContain('Acme owes you');
    expect(allText(c)).not.toContain('costs you');
  });
});

describe('buildCustomerAlertContent — the re-fire promise matches the mode', () => {
  it('month promises monthly re-arm', () => {
    expect(content().whatItMeans).toContain('once per calendar month');
  });

  it('rolling promises once per crossing with re-arm on the drop', () => {
    const c = content({ windowMode: 'rolling' });
    expect(c.whatItMeans).toContain('once per crossing');
    expect(c.whatItMeans).toContain('re-arms');
  });

  it('custom promises at most one fire and expiry', () => {
    const c = content({
      windowMode: 'custom',
      customStartDate: new Date('2026-08-01T00:00:00.000Z'),
      customEndDate: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(c.whatItMeans).toContain('at most once');
    expect(c.whatItMeans).toContain('expires');
  });
});

describe('buildCustomerAlertContent — a watch never claims to act on the customer', () => {
  const variants: Array<Partial<CustomerAlertCopyInput>> = [
    {},
    { metric: 'revenue' },
    { windowMode: 'rolling' },
    { variant: 'confirmation', valueUsd: null },
    { variant: 'confirmation', metric: 'revenue', valueUsd: null },
  ];

  it.each(variants.map((v, i) => [i, v] as const))(
    'variant %i says nothing changed and never blocks/limits/bills',
    (_i, over) => {
      const text = allText(content(over)).toLowerCase();
      // "never bills or limits them" is the sanctioned disclaimer; strip it
      // before checking the residue for act-on-the-customer language.
      const residue = text.split('never bills or limits them').join('');
      expect(text).toContain('never bills or limits them');
      expect(residue).not.toContain('block');
      expect(residue).not.toContain('throttle');
      expect(residue).not.toContain('limit');
      expect(residue).not.toContain('bill');
    },
  );
});

describe('buildCustomerAlertContent — confirmation variant', () => {
  it('confirms the tripwire it will watch, and where to manage it', () => {
    const c = content({ variant: 'confirmation', valueUsd: null });
    expect(c.subject).toContain('Watch created');
    expect(c.whatHappened).toContain('$500.00');
    expect(c.whatHappened).toContain('this month');
    expect(c.whatToDo).toContain('customer page');
  });
});
