/**
 * Unit tests for the canonical scalar-derivation helpers in @marginfront/db
 * (canon M2 + I4).
 *
 * Covers growthPercent, shareOfTotal, avgPer, costPerTask, and
 * invoiceAgingBuckets. Pure functions — no Prisma, no I/O, no mocking.
 */

import {
  growthPercent,
  shareOfTotal,
  avgPer,
  costPerTask,
  invoiceAgingBuckets,
  type AgingInvoice,
} from '@marginfront/db';

describe('growthPercent (canon M2)', () => {
  it('growthPercent(110, 100) is +10 and growthPercent(90, 100) is -10', () => {
    expect(growthPercent(110, 100)).toBe(10);
    expect(growthPercent(90, 100)).toBe(-10);
  });

  it('growthPercent(3, 2) is 50 (float sanity)', () => {
    expect(growthPercent(3, 2)).toBe(50);
  });

  it('growthPercent(x, 0) is null — never 0, never +100%', () => {
    expect(growthPercent(50, 0)).toBeNull();
    expect(growthPercent(0, 0)).toBeNull();
  });

  it('growthPercent(x, negative) is null — a negative base is not a meaningful growth base', () => {
    expect(growthPercent(50, -5)).toBeNull();
  });
});

describe('shareOfTotal', () => {
  it('shareOfTotal(25, 100) is 25, and a real zero share is 0, not null', () => {
    expect(shareOfTotal(25, 100)).toBe(25);
    expect(shareOfTotal(0, 100)).toBe(0);
  });

  it('shareOfTotal(x, 0) is null regardless of the part', () => {
    expect(shareOfTotal(5, 0)).toBeNull();
    expect(shareOfTotal(0, 0)).toBeNull();
  });

  it('shareOfTotal(-5, 100) is -5 — negative parts are legal (refunds)', () => {
    expect(shareOfTotal(-5, 100)).toBe(-5);
  });
});

describe('avgPer / costPerTask', () => {
  it('avgPer(10, 4) is 2.5, avgPer(0, 5) is 0, avgPer(10, 0) is null', () => {
    expect(avgPer(10, 4)).toBe(2.5);
    expect(avgPer(0, 5)).toBe(0);
    expect(avgPer(10, 0)).toBeNull();
  });

  it('costPerTask mirrors avgPer exactly — it is the domain-named alias', () => {
    expect(costPerTask(10, 4)).toBe(2.5);
    expect(costPerTask(10, 0)).toBeNull();
  });
});

describe('invoiceAgingBuckets (canon I4)', () => {
  const NOW = new Date(Date.UTC(2026, 6, 2, 12, 0, 0)); // 2026-07-02T12:00:00Z

  it('empty input returns every bucket at { amount: 0, count: 0 }', () => {
    const buckets = invoiceAgingBuckets([], NOW);
    expect(buckets).toEqual({
      current: { amount: 0, count: 0 },
      days1to30: { amount: 0, count: 0 },
      days31to60: { amount: 0, count: 0 },
      days61to90: { amount: 0, count: 0 },
      days90plus: { amount: 0, count: 0 },
    });
  });

  // One invoice at each boundary edge, relative to NOW. Amounts are distinct
  // multiples of 10 so a bucket mixup shows up as a wrong amount, not just a
  // wrong count.
  const boundaryInvoices: AgingInvoice[] = [
    { dueDate: new Date(Date.UTC(2026, 6, 2)), amount: 10 }, // 0 days -> current
    { dueDate: new Date(Date.UTC(2026, 6, 3)), amount: 20 }, // future -> current
    { dueDate: null, amount: 30 }, // no due date -> current
    { dueDate: new Date(Date.UTC(2026, 6, 1)), amount: 40 }, // 1 day -> days1to30
    { dueDate: new Date(Date.UTC(2026, 5, 2)), amount: 50 }, // 30 days -> days1to30
    { dueDate: new Date(Date.UTC(2026, 5, 1)), amount: 60 }, // 31 days -> days31to60
    { dueDate: new Date(Date.UTC(2026, 4, 3)), amount: 70 }, // 60 days -> days31to60
    { dueDate: new Date(Date.UTC(2026, 4, 2)), amount: 80 }, // 61 days -> days61to90
    { dueDate: new Date(Date.UTC(2026, 3, 3)), amount: 90 }, // 90 days -> days61to90
    { dueDate: new Date(Date.UTC(2026, 3, 2)), amount: 100 }, // 91 days -> days90plus
  ];

  it('boundary table: 0 days, future, and no-due-date all land in current', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    expect(buckets.current).toEqual({ amount: 60, count: 3 }); // 10 + 20 + 30
  });

  it('boundary table: 1 and 30 days overdue land in days1to30 (inclusive edges)', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    expect(buckets.days1to30).toEqual({ amount: 90, count: 2 }); // 40 + 50
  });

  it('boundary table: 31 and 60 days overdue land in days31to60 (inclusive edges)', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    expect(buckets.days31to60).toEqual({ amount: 130, count: 2 }); // 60 + 70
  });

  it('boundary table: 61 and 90 days overdue land in days61to90 (inclusive edges)', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    expect(buckets.days61to90).toEqual({ amount: 170, count: 2 }); // 80 + 90
  });

  it('boundary table: 91 days overdue lands in days90plus', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    expect(buckets.days90plus).toEqual({ amount: 100, count: 1 });
  });

  it('partition property: every invoice lands in exactly one bucket', () => {
    const buckets = invoiceAgingBuckets(boundaryInvoices, NOW);
    const rows = Object.values(buckets);
    const totalCount = rows.reduce((sum, b) => sum + b.count, 0);
    const totalAmount = rows.reduce((sum, b) => sum + b.amount, 0);
    expect(totalCount).toBe(boundaryInvoices.length);
    expect(totalAmount).toBe(boundaryInvoices.reduce((sum, inv) => sum + inv.amount, 0));
  });

  // Canon W1 semantics: bucket membership is UTC calendar days, not elapsed
  // hours. Only 2 seconds apart, but they straddle UTC midnight, so this is
  // 1 day overdue, not 0.
  it('UTC-calendar-day semantics: crossing UTC midnight counts as the next day, even seconds later', () => {
    const invoices: AgingInvoice[] = [
      { dueDate: new Date(Date.UTC(2026, 5, 30, 23, 59, 59)), amount: 15 },
    ];
    const now = new Date(Date.UTC(2026, 6, 1, 0, 0, 1));
    const buckets = invoiceAgingBuckets(invoices, now);
    expect(buckets.days1to30).toEqual({ amount: 15, count: 1 });
    expect(buckets.current).toEqual({ amount: 0, count: 0 });
  });

  it('aggregation: two invoices in the same bucket sum amounts and count 2', () => {
    const invoices: AgingInvoice[] = [
      { dueDate: new Date(Date.UTC(2026, 5, 1)), amount: 15 }, // 31 days -> days31to60
      { dueDate: new Date(Date.UTC(2026, 5, 1)), amount: 25 }, // 31 days -> days31to60
    ];
    const buckets = invoiceAgingBuckets(invoices, NOW);
    expect(buckets.days31to60).toEqual({ amount: 40, count: 2 });
  });
});
