/**
 * Canonical scalar derivation helpers (canon M2 + I4).
 *
 * Pure functions, no Prisma, no I/O. One shared copy of "percent of total",
 * "growth vs prior period", "average per unit", and "invoice aging" math so
 * api-nest services and dashboard Server Actions agree on zero-vs-null
 * conventions.
 *
 * Convention (canon M2, same as safeMarginPercent / canon M1): when the
 * denominator makes the ratio undefined, return null — never 0, NaN, or
 * Infinity. Callers render null as "—" (or coalesce deliberately, never
 * silently).
 */

/**
 * Percent change from `previous` to `current`.
 *
 * Returns null when `previous <= 0`: growth from a zero (or negative) base
 * has no honest percentage — a brand-new org's first month is "new", not
 * "+∞%" or "+100%".
 *
 *   growthPercent(110, 100) → 10
 *   growthPercent(90, 100)  → -10
 *   growthPercent(50, 0)    → null
 */
export function growthPercent(
  current: number,
  previous: number,
): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * `part` as a percent of `total`. Returns null when `total === 0` —
 * a share of nothing is undefined, not 0%.
 *
 *   shareOfTotal(25, 100) → 25
 *   shareOfTotal(0, 100)  → 0
 *   shareOfTotal(5, 0)    → null
 */
export function shareOfTotal(part: number, total: number): number | null {
  if (total === 0) return null;
  return (part / total) * 100;
}

/**
 * Average of `sum` over `count` units. Returns null when `count === 0` —
 * an average over nothing is undefined, not $0.
 *
 *   avgPer(10, 4) → 2.5
 *   avgPer(10, 0) → null
 */
export function avgPer(sum: number, count: number): number | null {
  if (count === 0) return null;
  return sum / count;
}

/**
 * Cost per task — avgPer under its domain name, so call sites read as the
 * metric they compute. Same null-when-no-tasks convention.
 */
export function costPerTask(cost: number, taskCount: number): number | null {
  return avgPer(cost, taskCount);
}

export interface EventCostRollup {
  /** SUM of resolved costs; null costs add 0 (canon C1). */
  cost: number;
  /** Every event, resolved or not. */
  eventCount: number;
  /** Events whose cost is still null — the C1 needs-attention count. */
  eventsMissingCost: number;
}

/**
 * C1 fold over in-memory event rows — the pure twin of getMatterCostRollups
 * for paths that already hold per-event rows (the matter audit/export
 * builders). A hand-rolled `+= usageCost ?? 0` outside this function is a
 * canon violation: it zeroes null costs without counting them.
 */
export function rollupEventCosts(
  events: ReadonlyArray<{ usageCost: number | null }>,
): EventCostRollup {
  let cost = 0;
  let eventsMissingCost = 0;
  for (const ev of events) {
    if (ev.usageCost === null) {
      eventsMissingCost += 1;
    } else {
      cost += ev.usageCost;
    }
  }
  return { cost, eventCount: events.length, eventsMissingCost };
}

export interface AgingInvoice {
  /** Open (unpaid, non-draft, non-void) invoice due date; null = no due date set. */
  dueDate: Date | null;
  /** Open amount in dollars (canon U1). */
  amount: number;
}

export interface AgingBucket {
  amount: number;
  count: number;
}

export interface InvoiceAgingBuckets {
  /** Not yet due (daysOverdue <= 0) or no due date. */
  current: AgingBucket;
  /** 1–30 days overdue. */
  days1to30: AgingBucket;
  /** 31–60 days overdue. */
  days31to60: AgingBucket;
  /** 61–90 days overdue. */
  days61to90: AgingBucket;
  /** 91+ days overdue. */
  days90plus: AgingBucket;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDayNumber(d: Date): number {
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY,
  );
}

/**
 * Bucket open invoices by days overdue relative to `now` (canon I4).
 *
 * The caller supplies OPEN invoices only (status issued/overdue — this is
 * pure math and does not filter status). Day difference is computed on UTC
 * calendar days (canon W1), so an invoice due "today" is current until
 * midnight UTC and lands in 1–30 the next UTC day. Bucket edges are
 * inclusive: 1–30 / 31–60 / 61–90 / 91+. An invoice with no due date
 * cannot be overdue, so it counts as current.
 */
export function invoiceAgingBuckets(
  invoices: AgingInvoice[],
  now: Date,
): InvoiceAgingBuckets {
  const buckets: InvoiceAgingBuckets = {
    current: { amount: 0, count: 0 },
    days1to30: { amount: 0, count: 0 },
    days31to60: { amount: 0, count: 0 },
    days61to90: { amount: 0, count: 0 },
    days90plus: { amount: 0, count: 0 },
  };
  const today = utcDayNumber(now);
  for (const inv of invoices) {
    const daysOverdue =
      inv.dueDate === null ? 0 : today - utcDayNumber(inv.dueDate);
    const bucket =
      daysOverdue <= 0
        ? buckets.current
        : daysOverdue <= 30
          ? buckets.days1to30
          : daysOverdue <= 60
            ? buckets.days31to60
            : daysOverdue <= 90
              ? buckets.days61to90
              : buckets.days90plus;
    bucket.amount += inv.amount;
    bucket.count += 1;
  }
  return buckets;
}
