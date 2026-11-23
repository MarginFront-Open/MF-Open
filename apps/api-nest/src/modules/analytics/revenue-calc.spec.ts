/**
 * Unit tests for the canonical revenue-calc primitives in @marginfront/db.
 *
 * These cover every rule that has math variation (R1, R2, R3, R4, M1). 12
 * fixtures: flat/graduated/volume × full-cycle/partial-start/partial-end ×
 * recurring/seat/onetime hot-paths, plus margin-percent null case.
 *
 * No Prisma, no DB. Pure math. If a surface disagrees with these
 * expected values, the surface is wrong — the library is a fixed point.
 */

import {
  applyMinCommitment,
  calcCreditPool,
  calcCreditPoolWithBreakdown,
  calcFlat,
  calcGraduated,
  calcOnetimeRevenue,
  calcProrationFactor,
  calcRecurringRevenue,
  calcRouted,
  calcSeatRevenue,
  calcUsageRevenue,
  calcVolume,
  creditPoolFee,
  getCommittedMrr,
  getCostMetrics,
  getRunRateMrr,
  type CalcStrategy,
} from '@marginfront/db';
import type { PrismaClient } from '@prisma/client';

// ─── Fixture builders ─────────────────────────────────────────────────────

const flatUsage = (rate: number, min?: number): CalcStrategy => ({
  id: 'strat-flat-usage',
  chargeType: 'usage',
  pricingModel: 'flat',
  rate,
  tiers: [{ lower: 0, upper: null, rate }],
  minimumCommitment: min ?? null,
  signalId: 'signal-1',
});

const graduatedUsage = (
  tiers: { lower: number; upper: number | null; rate: number }[],
): CalcStrategy => ({
  id: 'strat-graduated-usage',
  chargeType: 'usage',
  pricingModel: 'graduated',
  rate: null,
  tiers,
  minimumCommitment: null,
  signalId: 'signal-1',
});

const volumeUsage = (
  tiers: { lower: number; upper: number | null; rate: number }[],
): CalcStrategy => ({
  id: 'strat-volume-usage',
  chargeType: 'usage',
  pricingModel: 'volume',
  rate: null,
  tiers,
  minimumCommitment: null,
  signalId: 'signal-1',
});

const recurring = (rate: number): CalcStrategy => ({
  id: 'strat-recurring',
  chargeType: 'recurring',
  pricingModel: 'flat',
  rate,
  tiers: [],
  minimumCommitment: null,
  signalId: null,
});

const seatBasedFlat = (rate: number, min?: number): CalcStrategy => ({
  id: 'strat-seat',
  chargeType: 'seat_based',
  pricingModel: 'flat',
  rate,
  tiers: [{ lower: 0, upper: null, rate }],
  minimumCommitment: min ?? null,
  signalId: null,
});

const oneTime = (rate: number): CalcStrategy => ({
  id: 'strat-onetime',
  chargeType: 'onetime',
  pricingModel: 'flat',
  rate,
  tiers: [],
  minimumCommitment: null,
  signalId: null,
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('revenue-calc — R1 usage', () => {
  // Flat, simple quantity, no commitment → 100 × 0.50 = 50.00
  it('F1: flat usage with quantity 100 at $0.50 returns $50.00', () => {
    expect(calcUsageRevenue(flatUsage(0.5), 100)).toBeCloseTo(50.0, 6);
  });

  // Flat with minimumCommitment binding (below min → billed at min)
  it('F2: flat usage with quantity 3 below minCommit=10 bills 10 × $0.50 = $5.00', () => {
    expect(calcUsageRevenue(flatUsage(0.5, 10), 3)).toBeCloseTo(5.0, 6);
  });

  // Graduated tiers — crosses boundary
  //   0-100 @ $1.00, 100-500 @ $0.50, 500+ @ $0.25
  //   quantity = 600 → (100×$1) + (400×$0.50) + (100×$0.25) = 100 + 200 + 25 = $325
  it('F3: graduated with 3 tiers at quantity 600 returns $325.00', () => {
    const tiers = [
      { lower: 0, upper: 100, rate: 1.0 },
      { lower: 100, upper: 500, rate: 0.5 },
      { lower: 500, upper: null, rate: 0.25 },
    ];
    expect(calcUsageRevenue(graduatedUsage(tiers), 600)).toBeCloseTo(325.0, 6);
  });

  // Volume — single rate applied to whole quantity based on tier quantity falls into
  //   0-100 @ $1.00, 100-500 @ $0.50, 500+ @ $0.25
  //   quantity = 600 → 600 × $0.25 = $150.00
  it('F4: volume with 3 tiers at quantity 600 returns $150.00 (all at top rate)', () => {
    const tiers = [
      { lower: 0, upper: 100, rate: 1.0 },
      { lower: 100, upper: 500, rate: 0.5 },
      { lower: 500, upper: null, rate: 0.25 },
    ];
    expect(calcUsageRevenue(volumeUsage(tiers), 600)).toBeCloseTo(150.0, 6);
  });

  // Graduated — quantity EXACTLY at tier.upper stays in that tier.
  //   Canon rule: upper is INCLUSIVE. Tier "up to 20" covers units 1-20.
  //   Tiers: upper=20 @ $1, upper=null @ $0.50
  //   quantity = 20 → all 20 units in tier 1 → 20 × $1 = $20.00
  it('F13: graduated — quantity = tier.upper keeps all quantity in that tier (closed bound)', () => {
    const tiers = [
      { lower: 0, upper: 20, rate: 1.0 },
      { lower: 21, upper: null, rate: 0.5 },
    ];
    expect(calcUsageRevenue(graduatedUsage(tiers), 20)).toBeCloseTo(20.0, 6);
  });

  // Graduated — quantity = tier.upper + 1 rolls the overflow to the next tier.
  //   Tiers: upper=20 @ $1, upper=null @ $0.50
  //   quantity = 21 → 20 × $1 (tier 1) + 1 × $0.50 (tier 2) = $20.50
  //   Half-open tier math would give $21.00; $20.50 is correct.
  it('F14: graduated — quantity one past tier.upper rolls unit 21 to tier 2', () => {
    const tiers = [
      { lower: 0, upper: 20, rate: 1.0 },
      { lower: 21, upper: null, rate: 0.5 },
    ];
    expect(calcUsageRevenue(graduatedUsage(tiers), 21)).toBeCloseTo(20.5, 6);
  });

  // Zero quantity → zero revenue (not NaN)
  it('F5: flat usage at quantity 0 returns $0', () => {
    expect(calcUsageRevenue(flatUsage(0.5), 0)).toBe(0);
  });
});

describe('revenue-calc — R2 recurring fees with proration', () => {
  const monthlyCycle = 30;

  // Full-cycle proration — sub started well before window, still active
  it('F6: recurring $100/mo over a 30-day window (sub predates window) returns ~$100', () => {
    const proration = calcProrationFactor({
      windowStart: new Date(Date.UTC(2026, 3, 1)),
      windowEnd: new Date(Date.UTC(2026, 3, 31)), // full 30-day window
      subscriptionStart: new Date(Date.UTC(2026, 0, 1)),
      subscriptionEnd: null,
      cycleLengthDays: monthlyCycle,
    });
    expect(proration).toBeCloseTo(1.0, 6);
    expect(calcRecurringRevenue(recurring(100), proration)).toBeCloseTo(100.0, 6);
  });

  // Partial-start — sub started mid-window, contributes (days-active / cycle-days)
  //   windowStart = 0:00 UTC Apr 1, windowEnd = 0:00 UTC May 1 (exactly 30 days)
  //   subStart = Apr 16 → 15 days active in window out of 30 → 0.5 proration
  it('F7: recurring with sub starting mid-window returns half the rate', () => {
    const proration = calcProrationFactor({
      windowStart: new Date(Date.UTC(2026, 3, 1)),
      windowEnd: new Date(Date.UTC(2026, 4, 1)),
      subscriptionStart: new Date(Date.UTC(2026, 3, 16)),
      subscriptionEnd: null,
      cycleLengthDays: monthlyCycle,
    });
    expect(proration).toBeCloseTo(0.5, 6);
    expect(calcRecurringRevenue(recurring(100), proration)).toBeCloseTo(50.0, 6);
  });

  // Partial-end — sub ended mid-window
  it('F8: recurring with sub ending mid-window returns half the rate', () => {
    const proration = calcProrationFactor({
      windowStart: new Date(Date.UTC(2026, 3, 1)),
      windowEnd: new Date(Date.UTC(2026, 4, 1)),
      subscriptionStart: new Date(Date.UTC(2026, 0, 1)),
      subscriptionEnd: new Date(Date.UTC(2026, 3, 16)),
      cycleLengthDays: monthlyCycle,
    });
    expect(proration).toBeCloseTo(0.5, 6);
    expect(calcRecurringRevenue(recurring(100), proration)).toBeCloseTo(50.0, 6);
  });
});

describe('revenue-calc — R2 seat-based', () => {
  // Seats=5, flat $10/seat, full proration → $50
  it('F9: seat-based 5 seats × $10 flat with full proration returns $50', () => {
    expect(calcSeatRevenue(seatBasedFlat(10), 5, 1.0)).toBeCloseTo(50.0, 6);
  });

  // Seats=0, minimumCommitment=3 — billed at 3 seats
  it('F10: seat-based 0 seats with minCommit=3 at $10/seat returns $30', () => {
    expect(calcSeatRevenue(seatBasedFlat(10, 3), 0, 1.0)).toBeCloseTo(30.0, 6);
  });
});

describe('revenue-calc — R2 onetime', () => {
  const windowStart = new Date(Date.UTC(2026, 3, 1));
  const windowEnd = new Date(Date.UTC(2026, 4, 1));

  // StartDate in window → full onetime fee contributes
  it('F11: onetime with subStart inside window contributes full rate', () => {
    expect(
      calcOnetimeRevenue(oneTime(500), new Date(Date.UTC(2026, 3, 15)), windowStart, windowEnd),
    ).toBe(500);
  });

  // StartDate outside window → 0
  it('F12: onetime with subStart before window contributes $0', () => {
    expect(
      calcOnetimeRevenue(oneTime(500), new Date(Date.UTC(2026, 2, 15)), windowStart, windowEnd),
    ).toBe(0);
  });
});

describe('revenue-calc — primitives', () => {
  it('calcFlat with empty tiers falls back to strategy.rate', () => {
    const strategy: CalcStrategy = {
      id: 's',
      chargeType: 'usage',
      pricingModel: 'flat',
      rate: 0.75,
      tiers: [],
      minimumCommitment: null,
      signalId: null,
    };
    expect(calcFlat(strategy, 10)).toBeCloseTo(7.5, 6);
  });

  it('calcGraduated returns 0 for empty tiers', () => {
    const strategy: CalcStrategy = {
      id: 's',
      chargeType: 'usage',
      pricingModel: 'graduated',
      rate: null,
      tiers: [],
      minimumCommitment: null,
      signalId: null,
    };
    expect(calcGraduated(strategy, 100)).toBe(0);
  });

  it('calcVolume returns 0 for quantity below smallest tier', () => {
    const strategy: CalcStrategy = {
      id: 's',
      chargeType: 'usage',
      pricingModel: 'volume',
      rate: null,
      tiers: [{ lower: 10, upper: null, rate: 1.0 }],
      minimumCommitment: null,
      signalId: null,
    };
    expect(calcVolume(strategy, 5)).toBe(0);
  });

  it('applyMinCommitment uses max(actual, commitment)', () => {
    expect(applyMinCommitment(3, 10)).toBe(10);
    expect(applyMinCommitment(15, 10)).toBe(15);
    expect(applyMinCommitment(5, null)).toBe(5);
    expect(applyMinCommitment(5, 0)).toBe(5);
  });
});

// ─── Credit Pool Tests ───────────────────────────────────────────────────

// Credit pool: flat fee for a pool of units, then per-unit overage.
// Example: 5,000 calls for $99, then $0.03/call after that.
const creditPoolUsage = (
  poolSize: number,
  poolPrice: number,
  overageRate: number,
): CalcStrategy => ({
  id: 'strat-creditpool-usage',
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  rate: null,
  tiers: [
    { lower: 0, upper: poolSize, rate: poolPrice },
    { lower: poolSize, upper: null, rate: overageRate },
  ],
  minimumCommitment: null,
  signalId: 'signal-1',
});

describe('revenue-calc — credit_pool', () => {
  // CP1: usage within pool — pay the flat pool price regardless of quantity
  it('CP1: 3,000 of 5,000 pool @ $99 returns $99 (flat pool fee)', () => {
    expect(calcCreditPool(creditPoolUsage(5000, 99, 0.03), 3000)).toBeCloseTo(99.0, 6);
  });

  // CP2: usage exactly at pool boundary — still just the pool price
  it('CP2: 5,000 of 5,000 pool @ $99 returns $99 (no overage)', () => {
    expect(calcCreditPool(creditPoolUsage(5000, 99, 0.03), 5000)).toBeCloseTo(99.0, 6);
  });

  // CP3: usage exceeds pool — pool price + overage
  //   6,000 of 5,000 pool → $99 + (1,000 × $0.03) = $129
  it('CP3: 6,000 of 5,000 pool @ $99 + $0.03 overage returns $129', () => {
    expect(calcCreditPool(creditPoolUsage(5000, 99, 0.03), 6000)).toBeCloseTo(129.0, 6);
  });

  // CP4: large overage — 15,000 of 5,000 pool → $99 + (10,000 × $0.03) = $399
  it('CP4: 15,000 of 5,000 pool returns $399', () => {
    expect(calcCreditPool(creditPoolUsage(5000, 99, 0.03), 15000)).toBeCloseTo(399.0, 6);
  });

  // CP5: empty tiers fallback — uses strategy.rate × quantity
  it('CP5: credit_pool with no tiers falls back to rate × quantity', () => {
    const noTiers: CalcStrategy = {
      id: 'strat-cp-notiers',
      chargeType: 'usage',
      pricingModel: 'credit_pool',
      rate: 10,
      tiers: [],
      minimumCommitment: null,
      signalId: 'signal-1',
    };
    expect(calcCreditPool(noTiers, 5)).toBeCloseTo(50.0, 6);
  });

  // CP6: credit_pool flows through calcUsageRevenue (integration with calcRouted)
  it('CP6: calcUsageRevenue dispatches credit_pool through calcRouted correctly', () => {
    // 6,000 usage → $99 pool + (1,000 × $0.03) = $129
    expect(calcUsageRevenue(creditPoolUsage(5000, 99, 0.03), 6000)).toBeCloseTo(129.0, 6);
  });

  // CP7: what a period with NO usage reports. The invoice bills the pool fee
  // (the fee follows the plan's configuration, not the customer's activity), so
  // revenue has to report the same number or MarginFront's own books disagree
  // with the invoice it just sent. calcRouted keeps its zero guard — it prices
  // units, and zero units cost nothing — and calcUsageCharge is the one that
  // answers "what does the bill say".
  it('CP7: zero quantity through calcUsageRevenue reports the pool fee the invoice charges', () => {
    expect(calcUsageRevenue(creditPoolUsage(5000, 99, 0.03), 0)).toBeCloseTo(99.0, 6);
    // NEGATIVE CONTROL: calcRouted alone reports $0 while the invoice bills $99.
    expect(calcRouted(creditPoolUsage(5000, 99, 0.03), 0)).toBe(0);
  });

  // CP7b: only a PRICED pool. Every other model, and a pool that costs nothing
  // to hold, still reports zero for a period with no usage.
  it('CP7b: a free pool and a flat usage strategy both still report $0 at zero usage', () => {
    expect(calcUsageRevenue(creditPoolUsage(5000, 0, 0.03), 0)).toBe(0);
    expect(
      calcUsageRevenue(
        {
          id: 'strat-flat',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.05,
          tiers: [],
          minimumCommitment: null,
          signalId: 'signal-1',
        },
        0,
      ),
    ).toBe(0);
  });

  // CP8: credit_pool with per-tier breakdown — qty under pool returns ONE row
  // (pool only), subtotal equals poolPrice, total equals poolPrice.
  it('CP8: breakdown for 3,000 of 5,000 pool @ $99 → 1 pool row, total $99', () => {
    const result = calcCreditPoolWithBreakdown(creditPoolUsage(5000, 99, 0.03), 3000);
    expect(result.total).toBeCloseTo(99.0, 6);
    expect(result.tiersUsed).toHaveLength(1);
    expect(result.tiersUsed[0].subtotal).toBeCloseTo(99.0, 6);
    expect(result.tiersUsed[0].quantity).toBe(3000);
  });

  // CP9: at pool boundary — still one row, no overage
  it('CP9: breakdown for 5,000 of 5,000 pool → 1 pool row, no overage', () => {
    const result = calcCreditPoolWithBreakdown(creditPoolUsage(5000, 99, 0.03), 5000);
    expect(result.total).toBeCloseTo(99.0, 6);
    expect(result.tiersUsed).toHaveLength(1);
    expect(result.tiersUsed[0].subtotal).toBeCloseTo(99.0, 6);
  });

  // CP10: over pool — TWO rows, subtotals sum to total, exact expected numbers
  it('CP10: breakdown for 6,000 of 5,000 pool → 2 rows ($99 pool + $30 overage = $129)', () => {
    const result = calcCreditPoolWithBreakdown(creditPoolUsage(5000, 99, 0.03), 6000);
    expect(result.total).toBeCloseTo(129.0, 6);
    expect(result.tiersUsed).toHaveLength(2);
    expect(result.tiersUsed[0].subtotal).toBeCloseTo(99.0, 6);
    expect(result.tiersUsed[1].subtotal).toBeCloseTo(30.0, 6);
    expect(result.tiersUsed[1].quantity).toBe(1000);
  });

  // CP11: empty tiers fallback — empty tiersUsed array, total = rate*quantity
  it('CP11: breakdown with no tiers → tiersUsed=[], total = rate*qty', () => {
    const noTiers: CalcStrategy = {
      id: 'strat-cp-breakdown-notiers',
      chargeType: 'usage',
      pricingModel: 'credit_pool',
      rate: 10,
      tiers: [],
      minimumCommitment: null,
      signalId: 'signal-1',
    };
    const result = calcCreditPoolWithBreakdown(noTiers, 5);
    expect(result.total).toBeCloseTo(50.0, 6);
    expect(result.tiersUsed).toHaveLength(0);
  });

  // CP12: invariant — sum(tiersUsed.subtotal) === total for any quantity
  it('CP12: invariant — sum(tiersUsed.subtotal) === total across quantities', () => {
    const strat = creditPoolUsage(5000, 99, 0.03);
    for (const qty of [1, 100, 4999, 5000, 5001, 10000, 50000, 100000]) {
      const result = calcCreditPoolWithBreakdown(strat, qty);
      const sum = result.tiersUsed.reduce((acc, t) => acc + t.subtotal, 0);
      expect(sum).toBeCloseTo(result.total, 6);
    }
  });

  // CP13: equivalence — calcCreditPoolWithBreakdown.total === calcCreditPool
  //   across a variety of inputs, so the two can't drift apart.
  it('CP13: total matches calcCreditPool exactly for 12+ combos', () => {
    const strategies = [
      creditPoolUsage(5000, 99, 0.03),
      creditPoolUsage(1000, 29, 0.05),
      creditPoolUsage(10000, 499, 0.01),
    ];
    const quantities = [0, 1, 500, 1000, 5000, 5001, 10000, 100000];
    for (const strat of strategies) {
      for (const qty of quantities) {
        const withBreakdown = calcCreditPoolWithBreakdown(strat, qty).total;
        const original = calcCreditPool(strat, qty);
        expect(withBreakdown).toBeCloseTo(original, 6);
      }
    }
  });

  // ─── the fee follows configuration, not usage ────────────────
  //
  // A plan that HAS a pool fee charges it, whether or not the
  // customer showed up. Overage stays usage-driven. These pin the canon half;
  // invoice-calculator.service.spec.ts pins that the billing surfaces reach it.

  // CP14: zero usage against a priced pool still bills the whole fee.
  it('CP14: 0 of a 5,000 pool @ $99 bills $99 (configuration, not usage)', () => {
    expect(calcCreditPool(creditPoolUsage(5000, 99, 0.03), 0)).toBeCloseTo(99.0, 6);
  });

  // CP15: the breakdown says the same thing, with a zero-quantity pool row
  // carrying the whole fee — the total === sum(subtotal) invariant holds at 0.
  it('CP15: breakdown for 0 of a 5,000 pool → 1 pool row, 0 credits, $99', () => {
    const result = calcCreditPoolWithBreakdown(creditPoolUsage(5000, 99, 0.03), 0);
    expect(result.total).toBeCloseTo(99.0, 6);
    expect(result.tiersUsed).toHaveLength(1);
    expect(result.tiersUsed[0].quantity).toBe(0);
    expect(result.tiersUsed[0].subtotal).toBeCloseTo(99.0, 6);
    // No overage row: nothing was burned past the pool.
    expect(result.tiersUsed.every((t) => t.lower !== 5000)).toBe(true);
  });

  // CP16: creditPoolFee is the ONE question the billing surfaces ask before
  // they let a zero-quantity line through. Negative control on every shape
  // that must answer "nothing to charge".
  it('CP16: creditPoolFee answers the pool tier rate, and 0 for everything else', () => {
    expect(creditPoolFee(creditPoolUsage(5000, 99, 0.03))).toBe(99);
    // A free pool: it still exists and still counts down, it just costs
    // nothing to hold, so its callers emit no line rather than a $0 one.
    expect(creditPoolFee(creditPoolUsage(5000, 0, 0.03))).toBe(0);
    // A negative fee would CREDIT the customer for showing up. Never.
    expect(creditPoolFee(creditPoolUsage(5000, -99, 0.03))).toBe(0);
    // Not a pool at all — a flat usage strategy owes nothing without usage.
    expect(creditPoolFee(flatUsage(0.5))).toBe(0);
    // A pool with no tiers falls back to rate × quantity, which is $0 at 0.
    expect(creditPoolFee({ pricingModel: 'credit_pool', tiers: [] })).toBe(0);
    expect(creditPoolFee({ pricingModel: 'credit_pool', tiers: null })).toBe(0);
    expect(creditPoolFee({ pricingModel: null, tiers: null })).toBe(0);
  });

  // CP17: creditPoolFee reads the SAME tier calcCreditPool bills from, whatever
  // order the JSON stored them in. A guard that picked the overage tier here
  // would bill $0.03 for a $99 pool.
  it('CP17: creditPoolFee picks the pool tier from unsorted stored tiers', () => {
    const unsorted = {
      pricingModel: 'credit_pool',
      tiers: [
        { lower: 5000, upper: null, rate: 0.03 },
        { lower: 0, upper: 5000, rate: 99 },
      ],
    };
    expect(creditPoolFee(unsorted)).toBe(99);
    // And it agrees with what the math actually bills on the same tiers.
    expect(
      calcCreditPool({ ...creditPoolUsage(5000, 99, 0.03), tiers: unsorted.tiers as any }, 0),
    ).toBeCloseTo(creditPoolFee(unsorted), 6);
  });
});

// ─── getCostMetrics byDay / byPlan / byModel / byRepo / priorWindow ──────
//
// getCostMetrics calls db.signal_events.findMany once (or twice if a
// priorWindow is passed). We mock that single method so these stay pure
// unit tests — no DB, no fixtures to seed, consistent with the rest of
// this spec file.

type MockEvent = {
  customerId: string;
  agentId: string;
  signalId: string | null;
  usageDate: Date;
  usageCost: number | null;
  subscriptions: { planId: string } | null;
  raw_ingest_events: { payload: unknown } | null;
};

const makeEvent = (overrides: Partial<MockEvent> = {}): MockEvent => ({
  customerId: 'cust-1',
  agentId: 'agent-1',
  signalId: 'signal-1',
  usageDate: new Date(Date.UTC(2026, 3, 15, 12, 0, 0)),
  usageCost: 0.01,
  subscriptions: { planId: 'plan-A' },
  raw_ingest_events: { payload: { model: 'gpt-4o' } },
  ...overrides,
});

// Returns a Prisma-shaped mock. Each call to signal_events.findMany yields the
// next eventSet (primary call first, then the prior-window call).
function mockDbWithEvents(...eventSets: MockEvent[][]): PrismaClient {
  let callIdx = 0;
  return {
    signal_events: {
      findMany: () => {
        const set = eventSets[callIdx] ?? [];
        callIdx += 1;
        return Promise.resolve(set);
      },
    },
  } as unknown as PrismaClient;
}

const WINDOW = {
  start: new Date(Date.UTC(2026, 3, 1)),
  end: new Date(Date.UTC(2026, 3, 30, 23, 59, 59)),
};
const PRIOR_WINDOW = {
  start: new Date(Date.UTC(2026, 2, 1)),
  end: new Date(Date.UTC(2026, 2, 30, 23, 59, 59)),
};
const ORG = 'org-1';

describe('getCostMetrics dimension breakdowns', () => {
  describe('byDay', () => {
    // Three events at different times on the same UTC day must collapse
    // into a single day-row — the dashboard Time Series chart consumes
    // this directly.
    it('byDay-1: three events on the same UTC day bucket into one row', async () => {
      const events = [
        makeEvent({
          usageDate: new Date(Date.UTC(2026, 3, 15, 2, 0, 0)),
          usageCost: 0.01,
        }),
        makeEvent({
          usageDate: new Date(Date.UTC(2026, 3, 15, 12, 30, 0)),
          usageCost: 0.02,
        }),
        makeEvent({
          usageDate: new Date(Date.UTC(2026, 3, 15, 23, 45, 0)),
          usageCost: 0.03,
        }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byDay).toHaveLength(1);
      expect(result.byDay[0].eventCount).toBe(3);
      expect(result.byDay[0].cost).toBeCloseTo(0.06, 6);
      expect(result.byDay[0].date.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    });

    // Canon W1: day boundaries are UTC midnight. An event at 23:59:59 UTC
    // and one at 00:00:01 UTC the next day are different days, even if a
    // local timezone would call them "the same night."
    it('byDay-2: events straddling UTC midnight land in different buckets', async () => {
      const events = [
        makeEvent({
          usageDate: new Date(Date.UTC(2026, 3, 15, 23, 59, 59)),
          usageCost: 0.1,
        }),
        makeEvent({
          usageDate: new Date(Date.UTC(2026, 3, 16, 0, 0, 1)),
          usageCost: 0.2,
        }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byDay).toHaveLength(2);
      expect(result.byDay[0].date.toISOString()).toBe('2026-04-15T00:00:00.000Z');
      expect(result.byDay[1].date.toISOString()).toBe('2026-04-16T00:00:00.000Z');
      expect(result.byDay[0].cost).toBeCloseTo(0.1, 6);
      expect(result.byDay[1].cost).toBeCloseTo(0.2, 6);
    });

    it('byDay-3: empty window returns empty byDay array', async () => {
      const db = mockDbWithEvents([]);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byDay).toEqual([]);
    });
  });

  describe('byPlan', () => {
    it('byPlan-1: events across two plans produce two rows with correct split', async () => {
      const events = [
        makeEvent({ subscriptions: { planId: 'plan-A' }, usageCost: 0.1 }),
        makeEvent({ subscriptions: { planId: 'plan-A' }, usageCost: 0.2 }),
        makeEvent({ subscriptions: { planId: 'plan-B' }, usageCost: 0.5 }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byPlan).toHaveLength(2);
      const a = result.byPlan.find((r) => r.planId === 'plan-A');
      const b = result.byPlan.find((r) => r.planId === 'plan-B');
      expect(a?.cost).toBeCloseTo(0.3, 6);
      expect(a?.eventCount).toBe(2);
      expect(b?.cost).toBeCloseTo(0.5, 6);
      expect(b?.eventCount).toBe(1);
    });

    // Canon C1: orphan events (no subscription, or sub was deleted) still
    // contribute to cost. They bucket under `planId: null`, which sorts last
    // so named plans surface first in the UI table.
    it('byPlan-2: orphan events (no subscription) bucket under planId null', async () => {
      const events = [
        makeEvent({ subscriptions: { planId: 'plan-A' }, usageCost: 0.1 }),
        makeEvent({ subscriptions: null, usageCost: 0.05 }),
        makeEvent({ subscriptions: null, usageCost: 0.05 }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byPlan).toHaveLength(2);
      const orphan = result.byPlan.find((r) => r.planId === null);
      expect(orphan?.cost).toBeCloseTo(0.1, 6);
      expect(orphan?.eventCount).toBe(2);
      expect(result.byPlan[result.byPlan.length - 1].planId).toBeNull();
    });
  });

  describe('byModel', () => {
    it('byModel-1: two distinct LLM models produce two rows', async () => {
      const events = [
        makeEvent({
          raw_ingest_events: { payload: { model: 'gpt-4o' } },
          usageCost: 0.01,
        }),
        makeEvent({
          raw_ingest_events: { payload: { model: 'gpt-4o' } },
          usageCost: 0.02,
        }),
        makeEvent({
          raw_ingest_events: { payload: { model: 'claude-3-5-sonnet' } },
          usageCost: 0.04,
        }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byModel).toHaveLength(2);
      const gpt = result.byModel.find((r) => r.model === 'gpt-4o');
      const claude = result.byModel.find((r) => r.model === 'claude-3-5-sonnet');
      expect(gpt?.eventCount).toBe(2);
      expect(gpt?.cost).toBeCloseTo(0.03, 6);
      expect(claude?.eventCount).toBe(1);
      expect(claude?.cost).toBeCloseTo(0.04, 6);
    });

    // Non-LLM events + LLM events with a missing or empty model field all
    // share the `model: null` bucket. Empty-string model is still null —
    // we don't want a "" row in the UI.
    it('byModel-2: missing, empty-string, or non-LLM events bucket under null', async () => {
      const events = [
        makeEvent({
          raw_ingest_events: { payload: { model: 'gpt-4o' } },
          usageCost: 0.01,
        }),
        makeEvent({ raw_ingest_events: { payload: {} }, usageCost: 0.02 }),
        makeEvent({
          raw_ingest_events: { payload: { model: '' } },
          usageCost: 0.03,
        }),
        makeEvent({ raw_ingest_events: null, usageCost: 0.04 }),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      const nullRow = result.byModel.find((r) => r.model === null);
      expect(nullRow?.eventCount).toBe(3);
      expect(nullRow?.cost).toBeCloseTo(0.09, 6);
    });
  });

  // The code-cost-clarity connector stamps repo/branch/commitSha into
  // signal_events.metadata; getCostMetrics buckets cost by them. The
  // MockEvent factory leaves `metadata` undefined unless a case sets it,
  // which doubles as the no-metadata case (null bucket).
  describe('byRepo / byBranch', () => {
    it('byRepo-1: two repos split cost correctly; metadata-less events bucket under null', async () => {
      const events = [
        makeEvent({ usageCost: 0.1, metadata: { repo: 'acme/platform', branch: 'main' } } as any),
        makeEvent({ usageCost: 0.2, metadata: { repo: 'acme/platform', branch: 'feat/x' } } as any),
        makeEvent({ usageCost: 0.5, metadata: { repo: 'acme/agents', branch: 'main' } } as any),
        makeEvent({ usageCost: 0.05 }), // no metadata key at all
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byRepo).toHaveLength(3);
      const platform = result.byRepo.find((r) => r.repo === 'acme/platform');
      const nullRow = result.byRepo.find((r) => r.repo === null);
      expect(platform?.cost).toBeCloseTo(0.3, 6);
      expect(platform?.eventCount).toBe(2);
      expect(nullRow?.eventCount).toBe(1);
      // Null bucket sorts last, same convention as byPlan/byModel.
      expect(result.byRepo[result.byRepo.length - 1].repo).toBeNull();
    });

    it('byBranch-1: composite repo#branch keys keep same-named branches in different repos apart', async () => {
      const events = [
        makeEvent({ usageCost: 0.1, metadata: { repo: 'acme/platform', branch: 'main' } } as any),
        makeEvent({ usageCost: 0.5, metadata: { repo: 'acme/agents', branch: 'main' } } as any),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      const keys = result.byBranch.map((r) => r.branch);
      expect(keys).toContain('acme/platform#main');
      expect(keys).toContain('acme/agents#main');
      expect(result.byBranch).toHaveLength(2);
    });

    it('byRepo-2: explicit JSON nulls and non-string values bucket under null, never a fake key', async () => {
      const events = [
        makeEvent({
          usageCost: 0.1,
          metadata: { repo: null, branch: null, commitSha: null },
        } as any),
        makeEvent({ usageCost: 0.2, metadata: { repo: 123, branch: ['main'] } } as any),
      ];
      const db = mockDbWithEvents(events);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.byRepo).toHaveLength(1);
      expect(result.byRepo[0].repo).toBeNull();
      expect(result.byRepo[0].eventCount).toBe(2);
      expect(result.byBranch).toHaveLength(1);
      expect(result.byBranch[0].branch).toBeNull();
    });
  });

  describe('priorWindow', () => {
    // The dashboard uses prior-window numbers to render trend badges on
    // agent cards. A populated `prior` means the lib fired a second
    // findMany and computed the same shape for the earlier period.
    it('priorWindow-1: populates a parallel prior field from a second DB call', async () => {
      const primaryEvents = [makeEvent({ usageCost: 0.5 })];
      const priorEvents = [makeEvent({ usageCost: 0.1 }), makeEvent({ usageCost: 0.2 })];
      const db = mockDbWithEvents(primaryEvents, priorEvents);
      const result = await getCostMetrics(db, ORG, WINDOW, {}, { priorWindow: PRIOR_WINDOW });
      expect(result.cost).toBeCloseTo(0.5, 6);
      expect(result.prior).toBeDefined();
      expect(result.prior?.cost).toBeCloseTo(0.3, 6);
      expect(result.prior?.eventCount).toBe(2);
    });

    it('priorWindow-2: absent options leave prior undefined', async () => {
      const db = mockDbWithEvents([makeEvent()]);
      const result = await getCostMetrics(db, ORG, WINDOW);
      expect(result.prior).toBeUndefined();
    });

    it('priorWindow-3: null-cost events in prior populate eventCountWithNullCost', async () => {
      const primaryEvents = [makeEvent({ usageCost: 0.1 })];
      const priorEvents = [
        makeEvent({ usageCost: null }),
        makeEvent({ usageCost: null }),
        makeEvent({ usageCost: 0.05 }),
      ];
      const db = mockDbWithEvents(primaryEvents, priorEvents);
      const result = await getCostMetrics(db, ORG, WINDOW, {}, { priorWindow: PRIOR_WINDOW });
      expect(result.prior?.eventCountWithNullCost).toBe(2);
      expect(result.prior?.eventCount).toBe(3);
      expect(result.prior?.cost).toBeCloseTo(0.05, 6);
    });

    it('priorWindow-4: empty prior window returns zero totals and empty arrays', async () => {
      const primaryEvents = [makeEvent()];
      const db = mockDbWithEvents(primaryEvents, []);
      const result = await getCostMetrics(db, ORG, WINDOW, {}, { priorWindow: PRIOR_WINDOW });
      expect(result.prior?.cost).toBe(0);
      expect(result.prior?.eventCount).toBe(0);
      expect(result.prior?.byAgent).toEqual([]);
      expect(result.prior?.byDay).toEqual([]);
      expect(result.prior?.byPlan).toEqual([]);
      expect(result.prior?.byModel).toEqual([]);
    });
  });

  // Guard: the byDay/byPlan/byModel aggregation must not
  // shift the byAgent / byCustomer / bySignal shapes. If this breaks, a
  // change silently moved numbers on a surface users already read.
  it('byAgent / byCustomer / bySignal hold for a fixed fixture', async () => {
    const events = [
      makeEvent({
        agentId: 'agent-A',
        customerId: 'cust-X',
        signalId: 'sig-1',
        usageCost: 0.1,
      }),
      makeEvent({
        agentId: 'agent-A',
        customerId: 'cust-Y',
        signalId: 'sig-1',
        usageCost: 0.2,
      }),
      makeEvent({
        agentId: 'agent-B',
        customerId: 'cust-X',
        signalId: 'sig-2',
        usageCost: 0.05,
      }),
    ];
    const db = mockDbWithEvents(events);
    const result = await getCostMetrics(db, ORG, WINDOW);

    expect(result.byAgent).toHaveLength(2);
    expect(result.byAgent.find((r) => r.agentId === 'agent-A')?.cost).toBeCloseTo(0.3, 6);
    expect(result.byAgent.find((r) => r.agentId === 'agent-A')?.eventCount).toBe(2);
    expect(result.byAgent.find((r) => r.agentId === 'agent-B')?.cost).toBeCloseTo(0.05, 6);

    expect(result.byCustomer).toHaveLength(2);
    expect(result.byCustomer.find((r) => r.customerId === 'cust-X')?.eventCount).toBe(2);
    expect(result.byCustomer.find((r) => r.customerId === 'cust-Y')?.eventCount).toBe(1);

    expect(result.bySignal).toHaveLength(2);
    expect(result.bySignal.find((r) => r.signalId === 'sig-1')?.cost).toBeCloseTo(0.3, 6);
  });
});

// ─── getRunRateMrr (MRR2) + getCommittedMrr (MRR3) ────────────────────────
//
// Both functions hit db.subscriptions.findMany (always) and
// db.signal_events.findMany (getRunRateMrr only). We mock both so these
// stay pure unit tests, consistent with the rest of this file.

type MockSubscription = {
  id: string;
  customerId: string;
  agentId: string;
  planId: string;
  billingCycle: 'monthly' | 'yearly' | null;
  seatsCount: number | null;
  pricing_plans: {
    pricing_strategies: Array<{
      id: string;
      chargeType: string;
      pricingModel: string | null;
      rate: number | null;
      tiers: unknown;
      minimumCommitment: number | null;
      signalId: string | null;
    }>;
  } | null;
};

type MockRunRateEvent = {
  subscriptionId: string | null;
  signalId: string | null;
  quantity: number;
};

function mockDbWithSubsAndEvents(
  subs: MockSubscription[],
  events: MockRunRateEvent[] = [],
): PrismaClient {
  return {
    subscriptions: {
      findMany: () => Promise.resolve(subs),
    },
    signal_events: {
      findMany: () => Promise.resolve(events),
    },
  } as unknown as PrismaClient;
}

// Deterministic "now" so monthly-normalization tests don't drift with
// real-time clock. The 30-day window ends at this moment.
const NOW_MRR = new Date(Date.UTC(2026, 3, 15, 0, 0, 0));

const activeSub = (overrides: Partial<MockSubscription> = {}): MockSubscription => ({
  id: 'sub-1',
  customerId: 'cust-1',
  agentId: 'agent-1',
  planId: 'plan-1',
  billingCycle: 'monthly',
  seatsCount: 0,
  pricing_plans: { pricing_strategies: [] },
  ...overrides,
});

describe('getRunRateMrr + getCommittedMrr (MRR2 + MRR3)', () => {
  // MRR2-1: an active sub with recurring + seat + usage produces the sum
  // of all three parts. Events carry the 30-day usage quantity that
  // routes through calcRouted on the usage strategy.
  it('MRR2-1: active sub with recurring + seat + usage sums all three parts', async () => {
    const subs: MockSubscription[] = [
      activeSub({
        seatsCount: 5,
        pricing_plans: {
          pricing_strategies: [
            {
              id: 'strat-rec',
              chargeType: 'recurring',
              pricingModel: 'flat',
              rate: 100,
              tiers: [],
              minimumCommitment: null,
              signalId: null,
            },
            {
              id: 'strat-seat',
              chargeType: 'seat_based',
              pricingModel: 'flat',
              rate: 20,
              tiers: [{ lower: 0, upper: null, rate: 20 }],
              minimumCommitment: null,
              signalId: null,
            },
            {
              id: 'strat-usage',
              chargeType: 'usage',
              pricingModel: 'flat',
              rate: 0.5,
              tiers: [{ lower: 0, upper: null, rate: 0.5 }],
              minimumCommitment: null,
              signalId: 'signal-1',
            },
          ],
        },
      }),
    ];
    const events: MockRunRateEvent[] = [
      { subscriptionId: 'sub-1', signalId: 'signal-1', quantity: 200 },
    ];
    const db = mockDbWithSubsAndEvents(subs, events);
    const result = await getRunRateMrr(db, 'org-1', {}, NOW_MRR);

    expect(result.breakdown).toHaveLength(1);
    const row = result.breakdown[0];
    expect(row.recurring).toBeCloseTo(100, 6);
    expect(row.seatBased).toBeCloseTo(100, 6); // 5 seats × $20
    expect(row.usage).toBeCloseTo(100, 6); // 200 × $0.50
    expect(row.total).toBeCloseTo(300, 6);
    expect(result.mrr).toBeCloseTo(300, 6);
  });

  // MRR2-2: customer with no 30-day usage events gets only the committed
  // floor (recurring + seat). Usage with no min-commitment contributes 0.
  it('MRR2-2: usage with no events and no min-commitment contributes 0', async () => {
    const subs: MockSubscription[] = [
      activeSub({
        pricing_plans: {
          pricing_strategies: [
            {
              id: 'strat-rec',
              chargeType: 'recurring',
              pricingModel: 'flat',
              rate: 50,
              tiers: [],
              minimumCommitment: null,
              signalId: null,
            },
            {
              id: 'strat-usage',
              chargeType: 'usage',
              pricingModel: 'flat',
              rate: 0.5,
              tiers: [{ lower: 0, upper: null, rate: 0.5 }],
              minimumCommitment: null,
              signalId: 'signal-1',
            },
          ],
        },
      }),
    ];
    const db = mockDbWithSubsAndEvents(subs, []);
    const result = await getRunRateMrr(db, 'org-1', {}, NOW_MRR);

    expect(result.mrr).toBeCloseTo(50, 6);
    expect(result.breakdown[0].recurring).toBeCloseTo(50, 6);
    expect(result.breakdown[0].usage).toBe(0);
  });

  // MRR2-3: no active subs returns zero MRR and empty breakdown.
  it('MRR2-3: empty active subs returns mrr=0, breakdown=[]', async () => {
    const db = mockDbWithSubsAndEvents([], []);
    const result = await getRunRateMrr(db, 'org-1', {}, NOW_MRR);
    expect(result.mrr).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });

  // MRR3-1: committed MRR uses strategy.minimumCommitment for usage via
  // calcRouted, independent of actual events. A min=100 @ $0.05 flat ->
  // usage floor = $5, regardless of how many events fired.
  it('MRR3-1: usage strategy with minCommit=100 @ $0.05 contributes $5 usage floor', async () => {
    const subs: MockSubscription[] = [
      activeSub({
        pricing_plans: {
          pricing_strategies: [
            {
              id: 'strat-usage',
              chargeType: 'usage',
              pricingModel: 'flat',
              rate: 0.05,
              tiers: [{ lower: 0, upper: null, rate: 0.05 }],
              minimumCommitment: 100,
              signalId: 'signal-1',
            },
          ],
        },
      }),
    ];
    // Lots of actual events — committed MRR should ignore them.
    const events: MockRunRateEvent[] = [
      { subscriptionId: 'sub-1', signalId: 'signal-1', quantity: 99999 },
    ];
    const db = mockDbWithSubsAndEvents(subs, events);
    const result = await getCommittedMrr(db, 'org-1', {}, NOW_MRR);

    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].usage).toBeCloseTo(5, 6); // 100 × $0.05
    expect(result.mrr).toBeCloseTo(5, 6);
  });

  // MRR3-2: usage strategy with no min-commitment contributes 0 to CMRR.
  // Recurring is still counted.
  it('MRR3-2: usage with no min-commitment contributes 0 to committed MRR', async () => {
    const subs: MockSubscription[] = [
      activeSub({
        pricing_plans: {
          pricing_strategies: [
            {
              id: 'strat-rec',
              chargeType: 'recurring',
              pricingModel: 'flat',
              rate: 200,
              tiers: [],
              minimumCommitment: null,
              signalId: null,
            },
            {
              id: 'strat-usage',
              chargeType: 'usage',
              pricingModel: 'flat',
              rate: 1,
              tiers: [{ lower: 0, upper: null, rate: 1 }],
              minimumCommitment: null,
              signalId: 'signal-1',
            },
          ],
        },
      }),
    ];
    const db = mockDbWithSubsAndEvents(subs, []);
    const result = await getCommittedMrr(db, 'org-1', {}, NOW_MRR);

    expect(result.mrr).toBeCloseTo(200, 6); // recurring only
    expect(result.breakdown[0].usage).toBe(0);
  });

  // MRR2/MRR3 alignment: yearly billing cycle divides recurring and seat
  // by 12 per canon. $12,000/yr recurring -> $1,000/mo.
  it('MRR2-4: yearly billing cycle divides recurring + seat fees by 12', async () => {
    const subs: MockSubscription[] = [
      activeSub({
        billingCycle: 'yearly',
        seatsCount: 10,
        pricing_plans: {
          pricing_strategies: [
            {
              id: 'strat-rec',
              chargeType: 'recurring',
              pricingModel: 'flat',
              rate: 12000,
              tiers: [],
              minimumCommitment: null,
              signalId: null,
            },
            {
              id: 'strat-seat',
              chargeType: 'seat_based',
              pricingModel: 'flat',
              rate: 120,
              tiers: [{ lower: 0, upper: null, rate: 120 }],
              minimumCommitment: null,
              signalId: null,
            },
          ],
        },
      }),
    ];
    const db = mockDbWithSubsAndEvents(subs, []);
    const result = await getRunRateMrr(db, 'org-1', {}, NOW_MRR);

    expect(result.breakdown[0].recurring).toBeCloseTo(1000, 6); // 12000/12
    expect(result.breakdown[0].seatBased).toBeCloseTo(100, 6); // 10 × 120 / 12
    expect(result.mrr).toBeCloseTo(1100, 6);
  });
});
