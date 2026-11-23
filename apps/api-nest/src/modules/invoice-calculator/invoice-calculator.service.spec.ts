/**
 * Parity test for InvoiceCalculatorService.simulateRevenue.
 *
 * Negative assertion: the simulateRevenue response must contain NO
 * cost/margin-flavored fields anywhere in its payload, such as
 * `costAmount` / `marginAmount` / `totalDeliveryCost` / `totalMargin` /
 * `yearlyMargin` / `usageCost`. The simulator has no real unit cost, so
 * the NestJS endpoint matches the dashboard server-action equivalent
 * and both are revenue-only.
 *
 * An executable assertion keeps cost/margin fields out of the simulator, so
 * no change can silently introduce margin numbers built on a cost it does
 * not have.
 *
 * Forbidden field names (exact match, case-insensitive): cost, margin,
 * unitCost, usageCost, costAmount, marginAmount, totalDeliveryCost,
 * totalMargin, yearlyMargin. "setupCosts / recurringCosts /
 * usageBasedCosts / seatBasedCosts" are intentionally allowed. Those
 * are revenue-summary aliases, not margin fields.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { InvoiceCalculatorService } from './invoice-calculator.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const PLAN = 'plan-uuid';
const AGENT = 'agent-uuid';
const SIGNAL = 'signal-uuid';

/**
 * Deep-walk an object, collecting every property key at any depth.
 * Used by the forbidden-field assertion. Exact name match (not
 * substring) so legitimate fields like `setupCosts` don't trip.
 */
function collectAllKeys(obj: unknown): Set<string> {
  const keys = new Set<string>();
  function walk(x: unknown): void {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
      return;
    }
    for (const k of Object.keys(x as Record<string, unknown>)) {
      keys.add(k);
      walk((x as Record<string, unknown>)[k]);
    }
  }
  walk(obj);
  return keys;
}

function buildMockPrismaWithPlan(pricingPlan: any) {
  return {
    getClient: function () {
      return this;
    },
    pricing_plans: {
      findUnique: ({ where }: any) => {
        if (where.id !== pricingPlan.id) return Promise.resolve(null);
        return Promise.resolve(pricingPlan);
      },
    },
  };
}

async function buildService(mockPrisma: any): Promise<InvoiceCalculatorService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [InvoiceCalculatorService, { provide: PrismaService, useValue: mockPrisma }],
  }).compile();
  return module.get<InvoiceCalculatorService>(InvoiceCalculatorService);
}

describe('InvoiceCalculatorService.simulateRevenue is revenue-only', () => {
  // Mix of all four charge types to exercise every branch of the
  // simulator. The assertion must hold regardless of which branches are
  // traversed.
  const pricingPlan = {
    id: PLAN,
    name: 'Test Plan',
    description: 'Parity fixture',
    orgId: ORG,
    agents: { id: AGENT, name: 'Test Agent', agentCode: 'TA' },
    pricing_strategies: [
      {
        id: 'strat-onetime',
        name: 'Setup Fee',
        chargeType: 'onetime',
        pricingModel: 'flat',
        rate: new Decimal(500),
        tiers: null,
        billingFrequency: 'monthly',
        minimumCommitment: null,
        signalId: null,
        signals: null,
      },
      {
        id: 'strat-recurring',
        name: 'Monthly Platform',
        chargeType: 'recurring',
        pricingModel: 'flat',
        rate: new Decimal(100),
        tiers: null,
        billingFrequency: 'monthly',
        minimumCommitment: null,
        signalId: null,
        signals: null,
      },
      {
        id: 'strat-seat',
        name: 'Per Seat',
        chargeType: 'seat_based',
        pricingModel: 'flat',
        rate: new Decimal(10),
        tiers: null,
        billingFrequency: 'monthly',
        minimumCommitment: null,
        signalId: null,
        signals: null,
      },
      {
        id: 'strat-usage',
        name: 'Per Call',
        chargeType: 'usage',
        pricingModel: 'flat',
        rate: new Decimal(0.01),
        tiers: null,
        billingFrequency: 'monthly',
        minimumCommitment: null,
        signalId: SIGNAL,
        signals: { id: SIGNAL, name: 'API Call', shortName: 'api_call' },
      },
    ],
  };

  it('response payload contains no fake-margin field names at any depth', async () => {
    const svc = await buildService(buildMockPrismaWithPlan(pricingPlan));
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: { api_call: 1000 },
      billingCycle: 'monthly',
      seatsCount: 5,
    } as any);

    const forbiddenExact = new Set([
      'cost',
      'margin',
      'unitcost',
      'usagecost',
      'costamount',
      'marginamount',
      'totaldeliverycost',
      'totalmargin',
      'yearlymargin',
    ]);

    const keys = collectAllKeys(res);
    const violations: string[] = [];
    for (const key of keys) {
      if (forbiddenExact.has(key.toLowerCase())) {
        violations.push(key);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `simulateRevenue response contains forbidden fake-margin fields: ${violations.join(', ')}`,
      );
    }
  });

  // Positive assertion: revenue math is still correct end-to-end so we
  // don't accidentally ship an empty response while claiming "clean".
  // Independent recompute: setup $500 + recurring $100 + seats 5×$10 +
  // usage 1000×$0.01 = $500 + $100 + $50 + $10 = $660 for the first
  // invoice; recurring $160; yearly $500 + 12×$160 = $2,420.
  it('revenue totals compute correctly', async () => {
    const svc = await buildService(buildMockPrismaWithPlan(pricingPlan));
    const res: any = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: { api_call: 1000 },
      billingCycle: 'monthly',
      seatsCount: 5,
    } as any);

    expect(res.initialCharges.total).toBeCloseTo(660, 2);
    expect(res.recurringCharges.total).toBeCloseTo(160, 2);
    expect(res.annualProjection).toBeCloseTo(2420, 2);
    expect(res.simulationSummary.firstInvoiceTotal).toBeCloseTo(660, 2);
    expect(res.simulationSummary.typicalInvoiceTotal).toBeCloseTo(160, 2);
    expect(res.simulationSummary.yearlyTotal).toBeCloseTo(2420, 2);
    expect(res.simulationSummary.setupCosts).toBeCloseTo(500, 2);
    expect(res.simulationSummary.recurringCosts).toBeCloseTo(100, 2);
    expect(res.simulationSummary.seatBasedCosts).toBeCloseTo(50, 2);
    expect(res.simulationSummary.usageBasedCosts).toBeCloseTo(10, 2);
  });
});

/**
 * InvoiceCalculatorService.calculateInvoice tests.
 *
 * Tests the real composition path: calculateInvoice walks active pricing_strategies on the subscription's plan
 * and dispatches each by chargeType to a canon primitive from @marginfront/db:
 *
 *   usage      → calculateStrategyCharge (already routes through calcFlat /
 *                calcGraduatedWithBreakdown / calcVolumeWithBreakdown /
 *                calcCreditPoolWithBreakdown)
 *   recurring  → calcRecurringRevenue(strategy, proration)
 *   seat_based → calcSeatRevenue(strategy, seats, proration)
 *   onetime    → calcOnetimeRevenue(strategy, startDate, windowStart, windowEnd)
 *
 * Per canon: an invoice contains EVERYTHING the customer owes
 * for the cycle, not just usage. So a plan with all four chargeTypes produces
 * a 4-line-item invoice when generated, not four separate invoices.
 *
 * Tests use the canonical `BadRequestException` / `NotFoundException` from
 * @nestjs/common as the failure-mode contract. Mock Prisma below mimics the
 * subset of the real client these tests exercise (no findUnique-on-anything
 * fallback — fail loudly if a test forgets to mock a query).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';

const SUB = 'sub-uuid';
const CUSTOMER = 'cust-uuid';
const PLAN_ID = 'plan-uuid';
const SIGNAL_A = 'sig-a-uuid';
const SIGNAL_B = 'sig-b-uuid';
const STRAT_USAGE = 'strat-usage';
const STRAT_RECURRING = 'strat-recurring';
const STRAT_SEAT = 'strat-seat';
const STRAT_ONETIME = 'strat-onetime';
const STRAT_GRADUATED = 'strat-graduated';

// A full calendar month for proration math (May 2026 = 31 days). PERIOD_END
// is exactly 1 calendar month after PERIOD_START so the calendar-aware
// cycleLengthDays helper produces proration = 1.0 for a fully-active sub.
// (May 30 23:59 would be a hair short of a calendar month, and calendar-aware
// math would price it at ~30/31 of the rate.)
const PERIOD_START = new Date('2026-05-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-06-01T00:00:00.000Z');

interface MockSubscriptionInput {
  startDate?: Date;
  endDate?: Date | null;
  cycleNumber?: number;
  seatsCount?: number;
  billingCycle?: string;
  currentBillingPeriodStart?: Date | null;
  currentBillingPeriodEnd?: Date | null;
  strategies: any[];
}

function makeSubscription(input: MockSubscriptionInput) {
  return {
    id: SUB,
    customerId: CUSTOMER,
    organizationId: ORG,
    planId: PLAN_ID,
    startDate: input.startDate ?? new Date('2026-04-01T00:00:00.000Z'),
    endDate: input.endDate ?? null,
    cycleNumber: input.cycleNumber ?? 1,
    seatsCount: input.seatsCount ?? 0,
    billingCycle: input.billingCycle ?? 'monthly',
    customCycleDays: null,
    currentBillingPeriodStart:
      input.currentBillingPeriodStart === undefined
        ? PERIOD_START
        : input.currentBillingPeriodStart,
    currentBillingPeriodEnd:
      input.currentBillingPeriodEnd === undefined ? PERIOD_END : input.currentBillingPeriodEnd,
    pricing_plans: {
      id: PLAN_ID,
      pricing_strategies: input.strategies,
    },
  };
}

function buildMockPrismaForCalculate(opts: {
  subscription: any | null;
  events?: Array<{ signalId: string; quantity: number }>;
}) {
  return {
    getClient: function () {
      return this;
    },
    subscriptions: {
      findUnique: ({ where }: any) => {
        if (where.id !== SUB) return Promise.resolve(null);
        return Promise.resolve(opts.subscription);
      },
    },
    signal_events: {
      findMany: () => Promise.resolve(opts.events ?? []),
    },
  };
}

describe('InvoiceCalculatorService.calculateInvoice', () => {
  it('throws NotFoundException when subscription is missing', async () => {
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: null }));
    await expect(svc.calculateInvoice({ subscriptionId: SUB } as any)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws BadRequestException when subscription has no billing period and none provided', async () => {
    const sub = makeSubscription({
      strategies: [],
      currentBillingPeriodStart: null,
      currentBillingPeriodEnd: null,
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    await expect(svc.calculateInvoice({ subscriptionId: SUB } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns empty line items + $0 totals when plan has no active strategies', async () => {
    const sub = makeSubscription({ strategies: [] });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toEqual([]);
    expect(res.calculationDetails.subtotal).toBe(0);
    expect(res.calculationDetails.total).toBe(0);
    // `breakdown` mirrors `lineItems`.
    expect(res.breakdown).toEqual([]);
    expect(res.calculationDetails.breakdown).toEqual([]);
  });

  it('builds one usage line for a flat-rate signal with 100 events @ $0.10 = $10', async () => {
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call', shortName: 'api_call' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 100 }],
      }),
    );

    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'usage',
      pricingStrategyId: STRAT_USAGE,
      quantity: 100,
      amount: 10,
    });
    expect(res.calculationDetails.subtotal).toBeCloseTo(10, 4);
    expect(res.calculationDetails.total).toBeCloseTo(10, 4);
  });

  it('sums quantities across multiple events for the same signal before pricing', async () => {
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.5),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call', shortName: 'api_call' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [
          { signalId: SIGNAL_A, quantity: 3 },
          { signalId: SIGNAL_A, quantity: 7 },
          { signalId: SIGNAL_A, quantity: 10 },
        ],
      }),
    );

    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems[0].quantity).toBe(20);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(10, 4);
  });

  it('emits no usage line when events for a usage signal are zero', async () => {
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call' },
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub, events: [] }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems).toEqual([]);
  });

  it('builds one recurring line at full rate when subscription spans the entire window', async () => {
    const sub = makeSubscription({
      // Sub started before the window and never ended → proration = 1.0
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Monthly Platform Fee',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'recurring',
      pricingStrategyId: STRAT_RECURRING,
      quantity: 1,
    });
    // toBeCloseTo, not strict equality: canon's calcProrationFactor returns
    // ~0.99999998 for a "full" window because PERIOD_END is 23:59:59.999
    // (1ms short of 30 full days). The math is correct; the assertion just
    // tolerates IEEE-754 float drift.
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(50, 4);
    expect(res.calculationDetails.lineItems[0].description).toBe('Monthly Platform Fee');
  });

  it('prorates a recurring line for a mid-window subscription start', async () => {
    // 30-day window starts 2026-05-01. Sub starts 2026-05-16 → ~15 days of
    // coverage → ~50% proration. Canon's calcProrationFactor handles the exact
    // math; this test asserts the line item is materially less than full rate
    // and the description signals proration. Tight numeric assertion would
    // couple this test to internal date-math details that the canon owns.
    const sub = makeSubscription({
      startDate: new Date('2026-05-16T00:00:00.000Z'),
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Monthly Platform Fee',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(100),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    const line = res.calculationDetails.lineItems[0];
    expect(line.amount).toBeGreaterThan(0);
    expect(line.amount).toBeLessThan(100);
    // Within ~15-day shave of a $100/month rate → bracket ~$45–$55 inclusive.
    expect(line.amount).toBeGreaterThan(40);
    expect(line.amount).toBeLessThan(60);
    expect(line.description).toMatch(/prorated/);
  });

  it('builds one seat line at full rate when subscription spans the entire window', async () => {
    const sub = makeSubscription({
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      seatsCount: 5,
      strategies: [
        {
          id: STRAT_SEAT,
          name: 'Per Seat',
          chargeType: 'seat_based',
          pricingModel: 'flat',
          rate: new Decimal(20),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'seat_based',
      pricingStrategyId: STRAT_SEAT,
      quantity: 5,
    });
    // toBeCloseTo for the same float-drift reason as the recurring test above.
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(100, 4);
  });

  it('emits one onetime line when subscription started inside the window', async () => {
    const sub = makeSubscription({
      // Sub started 2026-05-10, inside [2026-05-01, 2026-05-30] → fee applies.
      startDate: new Date('2026-05-10T00:00:00.000Z'),
      strategies: [
        {
          id: STRAT_ONETIME,
          name: 'Setup Fee',
          chargeType: 'onetime',
          pricingModel: 'flat',
          rate: new Decimal(500),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'onetime',
      pricingStrategyId: STRAT_ONETIME,
      amount: 500,
    });
  });

  it('omits onetime line on cycles after the start cycle', async () => {
    const sub = makeSubscription({
      // Sub started months ago, well before this window → no onetime fee.
      startDate: new Date('2026-01-15T00:00:00.000Z'),
      strategies: [
        {
          id: STRAT_ONETIME,
          name: 'Setup Fee',
          chargeType: 'onetime',
          pricingModel: 'flat',
          rate: new Decimal(500),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems).toEqual([]);
  });

  it('builds a combined invoice with usage + recurring + seat lines per canon ("invoice = everything")', async () => {
    const sub = makeSubscription({
      // Full-cycle (proration = 1.0) to make assertion math clean.
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      seatsCount: 5,
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call' },
        },
        {
          id: STRAT_RECURRING,
          name: 'Monthly Platform Fee',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
        {
          id: STRAT_SEAT,
          name: 'Per Seat',
          chargeType: 'seat_based',
          pricingModel: 'flat',
          rate: new Decimal(10),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 100 }],
      }),
    );
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(3);
    // usage 100×$0.10 + recurring $50 + seat 5×$10 = $10 + $50 + $50 = $110
    expect(res.calculationDetails.subtotal).toBeCloseTo(110, 4);
    expect(res.calculationDetails.total).toBeCloseTo(110, 4);

    const byType = Object.fromEntries(
      res.calculationDetails.lineItems.map((li: any) => [li.chargeType, li]),
    );
    expect(byType.usage.amount).toBeCloseTo(10, 4);
    expect(byType.recurring.amount).toBeCloseTo(50, 4);
    expect(byType.seat_based.amount).toBeCloseTo(50, 4);
  });

  it('computes graduated-tier usage via canon (200 events across two tiers)', async () => {
    // Canon: upper bound INCLUSIVE.
    //   tier 0–100 at $0.10 → 100 × $0.10 = $10
    //   tier 101–null at $0.05 → 100 × $0.05 = $5
    //   total = $15
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_GRADUATED,
          name: 'Graduated API Calls',
          chargeType: 'usage',
          pricingModel: 'graduated',
          rate: null,
          tiers: [
            { lower: 0, upper: 100, rate: 0.1 },
            { lower: 101, upper: null, rate: 0.05 },
          ],
          minimumCommitment: null,
          signalId: SIGNAL_B,
          signals: { id: SIGNAL_B, name: 'API Call' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_B, quantity: 200 }],
      }),
    );
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(15, 4);
    expect(res.calculationDetails.lineItems[0].tiersUsed.length).toBe(2);
  });

  it('applies minimumCommitment to usage quantity before pricing', async () => {
    // 5 actual events, minimumCommitment = 50 → priced as 50 events × $0.10 = $5
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call (Min 50)',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: 50,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 5 }],
      }),
    );
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems[0].quantity).toBe(50);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(5, 4);
  });

  it('honors DTO billingPeriod overrides over subscription currentBillingPeriod', async () => {
    // Subscription says current period is May. DTO overrides to a different
    // window. The events query (and proration) must use the overridden window.
    const overrideStart = new Date('2026-06-01T00:00:00.000Z');
    const overrideEnd = new Date('2026-06-30T23:59:59.999Z');

    const sub = makeSubscription({
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Monthly Platform Fee',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({
      subscriptionId: SUB,
      billingPeriodStart: overrideStart,
      billingPeriodEnd: overrideEnd,
    } as any);

    // Full-cycle proration → full $50.
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(50, 4);
  });

  // Calendar-aware proration tests — the gym-membership behavior. A monthly
  // recurring fee bills the same amount EVERY calendar month regardless of
  // whether the month is 28, 29, 30, or 31 days. Customers think in calendar
  // cycles; invoices follow that mental model.

  it('calendar-aware: 31-day May bills the FULL monthly rate (not 31/30 over-bill)', async () => {
    const may1 = new Date('2026-05-01T00:00:00.000Z');
    const jun1 = new Date('2026-06-01T00:00:00.000Z');
    const sub = makeSubscription({
      startDate: new Date('2025-01-01T00:00:00.000Z'),
      currentBillingPeriodStart: may1,
      currentBillingPeriodEnd: jun1,
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Gym Membership',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(50, 4);
  });

  it('calendar-aware: 28-day February bills the FULL monthly rate (not 28/30 under-bill)', async () => {
    const feb1 = new Date('2026-02-01T00:00:00.000Z');
    const mar1 = new Date('2026-03-01T00:00:00.000Z');
    const sub = makeSubscription({
      startDate: new Date('2025-01-01T00:00:00.000Z'),
      currentBillingPeriodStart: feb1,
      currentBillingPeriodEnd: mar1,
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Gym Membership',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(50, 4);
  });

  it('calendar-aware: leap-year February (2028, 29 days) also bills the FULL monthly rate', async () => {
    const feb1 = new Date('2028-02-01T00:00:00.000Z');
    const mar1 = new Date('2028-03-01T00:00:00.000Z');
    const sub = makeSubscription({
      startDate: new Date('2025-01-01T00:00:00.000Z'),
      currentBillingPeriodStart: feb1,
      currentBillingPeriodEnd: mar1,
      strategies: [
        {
          id: STRAT_RECURRING,
          name: 'Gym Membership',
          chargeType: 'recurring',
          pricingModel: 'flat',
          rate: new Decimal(50),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(50, 4);
  });

  it('LEGACY POOL PIN (negative control): a creditRates-null pool bills raw units', async () => {
    // 1,250 raw units on the pool's own signal, 1,000-unit pool @ $99,
    // overage $0.03 → $99 + 250 × $0.03 = $106.50. Exactly the section-5
    // fixture arithmetic in credit-ledger.test.ts.
    const sub = makeSubscription({
      strategies: [
        {
          id: 'strat-pool',
          name: 'Credit Pool',
          chargeType: 'usage',
          pricingModel: 'credit_pool',
          rate: null,
          tiers: [
            { lower: 0, upper: 1000, rate: 99 },
            { lower: 1000, upper: null, rate: 0.03 },
          ],
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call' },
          creditRates: null,
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 1250 }],
      }),
    );
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0].quantity).toBe(1250);
    expect(res.calculationDetails.lineItems[0].amount).toBe(99 + 250 * 0.03);
  });

  it('exposes both `lineItems` AND `breakdown` arrays with identical contents (backward compat)', async () => {
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'API Call' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 10 }],
      }),
    );
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    // The same array is readable under all three names.
    expect(res.calculationDetails.lineItems).toEqual(res.calculationDetails.breakdown);
    expect(res.calculationDetails.lineItems).toEqual(res.breakdown);
  });
});

/**
 * The pool line bills the RATED credit quantity.
 *
 * A credit pool with creditRates burns member-signal units at per-signal
 * rates; the invoice must bill Σ member SUM(quantity) × rate as the pool
 * quantity. Member signals have no strategy rows, so the batch events query
 * has to request them explicitly — the mock below filters by the query's own
 * `signalId: { in }` list, so an implementation that forgets to fetch a
 * member's events under-counts and goes red here rather than passing on a
 * mock that returns everything.
 */

const SIGNAL_C = 'sig-c-uuid';
const STRAT_POOL = 'strat-pool';

const RATED_POOL_TIERS = [
  { lower: 0, upper: 1000, rate: 99 },
  { lower: 1000, upper: null, rate: 0.03 },
];

function ratedPoolStrategy(creditRates: unknown) {
  return {
    id: STRAT_POOL,
    name: 'Credit Pool',
    chargeType: 'usage',
    pricingModel: 'credit_pool',
    rate: null,
    tiers: RATED_POOL_TIERS,
    minimumCommitment: null,
    signalId: SIGNAL_A,
    signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
    creditRates,
  };
}

function buildMockPrismaWithEventFilter(opts: {
  subscription: any;
  events: Array<{ signalId: string; quantity: number }>;
}) {
  const eventQueries: any[] = [];
  const prisma = {
    getClient: function () {
      return this;
    },
    subscriptions: {
      findUnique: ({ where }: any) => Promise.resolve(where.id === SUB ? opts.subscription : null),
    },
    signal_events: {
      findMany: ({ where }: any) => {
        eventQueries.push(where);
        return Promise.resolve(opts.events.filter((e) => where.signalId.in.includes(e.signalId)));
      },
    },
  };
  return { prisma, eventQueries };
}

describe('InvoiceCalculatorService.calculateInvoice — rated pool quantity', () => {
  it('bills the rated credit sum: 2 reports × 4 + 3 notes × 2 = 14 credits, inside the pool', async () => {
    const sub = makeSubscription({
      strategies: [ratedPoolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
    });
    const { prisma, eventQueries } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [
        { signalId: SIGNAL_A, quantity: 2 },
        { signalId: SIGNAL_B, quantity: 3 },
      ],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'usage',
      pricingStrategyId: STRAT_POOL,
      quantity: 14,
      amount: 99,
    });
    // The batch query asked for BOTH member signals in one fetch.
    expect(eventQueries).toHaveLength(1);
    expect([...eventQueries[0].signalId.in].sort()).toEqual([SIGNAL_A, SIGNAL_B].sort());
  });

  it('overage is computed on CREDITS, the invoice way: 800 + 500 = 1,300 credits → $99 + 300 × $0.03', async () => {
    const sub = makeSubscription({
      strategies: [ratedPoolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
    });
    const { prisma } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [
        { signalId: SIGNAL_A, quantity: 200 },
        { signalId: SIGNAL_B, quantity: 250 },
      ],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const line = res.calculationDetails.lineItems[0];
    expect(line.quantity).toBe(1300);
    expect(line.amount).toBe(99 + 300 * 0.03);
    // The overage tier row carries the credits past the pool boundary.
    const overageRow = line.tiersUsed.find((t: any) => t.lower === 1000);
    expect(overageRow.quantity).toBe(300);
  });

  it('member signals produce NO standalone line; a non-member signal is neither fetched nor billed', async () => {
    const sub = makeSubscription({
      strategies: [ratedPoolStrategy({ [SIGNAL_B]: 2 })],
    });
    const { prisma, eventQueries } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [
        { signalId: SIGNAL_A, quantity: 10 },
        { signalId: SIGNAL_B, quantity: 5 },
        // Present in the org's data, NOT a pool member: must not count.
        { signalId: SIGNAL_C, quantity: 999 },
      ],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    // ONE line for the whole pool — the invoice never grows per-member lines.
    expect(res.calculationDetails.lineItems).toHaveLength(1);
    // Own signal absent from creditRates burns at rate 1: 10 × 1 + 5 × 2 = 20.
    expect(res.calculationDetails.lineItems[0].quantity).toBe(20);
    expect(eventQueries[0].signalId.in).not.toContain(SIGNAL_C);
  });

  it('a rated pool with zero member usage still bills the pool fee', async () => {
    const sub = makeSubscription({
      strategies: [ratedPoolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
    });
    const { prisma } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0]).toMatchObject({
      chargeType: 'usage',
      pricingStrategyId: STRAT_POOL,
      quantity: 1,
      unitPrice: 99,
      effectiveUnitPrice: 99,
      amount: 99,
    });
    expect(res.calculationDetails.total).toBe(99);
  });
});

/**
 * THE POOL FEE FOLLOWS THE PLAN'S CONFIGURATION, NOT THE
 * CUSTOMER'S ACTIVITY.
 *
 * The rule, as a table. The first row is the case that matters most: a
 * customer on a $99 pool who used nothing must still be billed $99, so the
 * credit-pool branch cannot sit behind the `quantity <= 0` guard shared with
 * every other usage model.
 *
 *   poolPrice > 0, no usage at all   → the pool fee
 *   poolPrice > 0, inside the pool   → the pool fee
 *   poolPrice > 0, past the pool     → the pool fee + overage
 *   poolPrice = 0, any usage         → no fee (the pool still exists and still
 *                                      counts down; it costs nothing to hold)
 *   platform/flat fee on the plan    → bills normally, independent of the pool
 *
 * Overage stays usage-driven: only credits burned past the pool size.
 */

/** A pool priced at $0 — the pool exists, holding it is free. */
function freePoolStrategy() {
  return {
    ...ratedPoolStrategy(null),
    tiers: [
      { lower: 0, upper: 1000, rate: 0 },
      { lower: 1000, upper: null, rate: 0.03 },
    ],
  };
}

function platformFeeStrategy() {
  return {
    id: STRAT_RECURRING,
    name: 'Monthly Platform Fee',
    chargeType: 'recurring',
    pricingModel: 'flat',
    rate: new Decimal(50),
    tiers: null,
    minimumCommitment: null,
    signalId: null,
    signals: null,
  };
}

/**
 * A shape this calculator does not know how to price must stop the
 * invoice, not guess at it.
 *
 * If the pricingModel switch fell through to `quantity × rate` for anything
 * it did not recognise, or the chargeType switch had no default, an
 * unhandled shape would be mispriced or contribute no line and the invoice
 * would go out short. Both failures produce an invoice whose totals agree with
 * themselves all the way to the payment provider, which is exactly the kind of
 * wrong number nobody finds. Canon already throws on this for the same
 * strategy (revenue-calc.ts calcRouted), and the two must not disagree.
 */
describe('InvoiceCalculatorService.calculateInvoice — an unpriceable shape stops the invoice', () => {
  const unknownModel = {
    id: 'strat-unknown-model',
    name: 'Sub-pool credits',
    chargeType: 'usage',
    pricingModel: 'credit_sub_pool',
    rate: new Decimal(2),
    tiers: null,
    minimumCommitment: null,
    signalId: SIGNAL_A,
    signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
  };

  it('refuses a pricing model it has no math for instead of billing rate × quantity', async () => {
    const sub = makeSubscription({ strategies: [unknownModel] });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 50 }],
      }),
    );

    await expect(svc.calculateInvoice({ subscriptionId: SUB } as any)).rejects.toThrow(
      /credit_sub_pool/,
    );
  });

  it('NEGATIVE CONTROL: the number a quantity × rate fallback would bill', async () => {
    // 50 events × the strategy's $2 rate. For a tiered model that figure is
    // wrong, and nothing would flag it.
    expect(50 * 2).toBe(100);
  });

  it('refuses a charge type it has no math for instead of dropping the line', async () => {
    const sub = makeSubscription({
      strategies: [
        {
          id: 'strat-unknown-charge',
          name: 'Overage penalty',
          chargeType: 'penalty',
          pricingModel: 'flat',
          rate: new Decimal(25),
          tiers: null,
          minimumCommitment: null,
          signalId: null,
          signals: null,
        },
      ],
    });
    const svc = await buildService(buildMockPrismaForCalculate({ subscription: sub }));

    await expect(svc.calculateInvoice({ subscriptionId: SUB } as any)).rejects.toThrow(/penalty/);
  });

  it('a strategy with no pricing model at all still bills rate × quantity', async () => {
    // The legitimate null case, and the arm canon takes too. Pinned so the
    // throw above cannot swallow it.
    const sub = makeSubscription({
      strategies: [
        {
          id: 'strat-no-model',
          name: 'Flat per report',
          chargeType: 'usage',
          pricingModel: null,
          rate: new Decimal(0.5),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_A,
          signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
        },
      ],
    });
    const svc = await buildService(
      buildMockPrismaForCalculate({
        subscription: sub,
        events: [{ signalId: SIGNAL_A, quantity: 40 }],
      }),
    );

    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);
    expect(res.calculationDetails.total).toBe(20);
  });
});

describe('InvoiceCalculatorService.calculateInvoice — pool fee follows configuration', () => {
  it('poolPrice > 0 + NO usage at all: bills the pool fee, not $0', async () => {
    const sub = makeSubscription({ strategies: [ratedPoolStrategy(null)] });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const line = res.calculationDetails.lineItems[0];
    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(line.amount).toBe(99);
    // The fee bills as one unit at its own price, the same shape a recurring
    // or one-time charge uses. Stripe multiplies unit price by quantity to
    // decide what to collect, so a quantity of 0 here would collect nothing.
    expect(line.quantity).toBe(1);
    expect(line.unitPrice).toBe(99);
    expect(line.effectiveUnitPrice).toBe(99);
    // The pool tier row still carries the whole fee at zero credits drawn, so
    // total === sum(tiersUsed.subtotal) holds and the credits detail stays
    // honest about how much of the pool was actually used.
    expect(line.tiersUsed).toHaveLength(1);
    expect(line.tiersUsed[0].quantity).toBe(0);
    expect(line.tiersUsed[0].subtotal).toBe(99);
    expect(res.calculationDetails.total).toBe(99);
  });

  it('the zero-usage line names the fee — never "0 × $0.0000" against a real charge', async () => {
    const sub = makeSubscription({ strategies: [ratedPoolStrategy(null)] });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const description = res.calculationDetails.lineItems[0].description;
    // Same signal label the used-pool line uses (shortName wins over name).
    // Reads as a sentence beside quantity 1 and unit price $99.00.
    expect(description).toBe('report: credit pool fee (no usage this period)');
    expect(description).not.toMatch(/0 × \$0\.0000/);
  });

  it('poolPrice > 0 + usage inside the pool: still exactly the pool fee', async () => {
    const sub = makeSubscription({ strategies: [ratedPoolStrategy(null)] });
    const { prisma } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [{ signalId: SIGNAL_A, quantity: 400 }],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems[0].quantity).toBe(400);
    expect(res.calculationDetails.lineItems[0].amount).toBe(99);
  });

  it('poolPrice > 0 + usage past the pool: pool fee + overage, overage unchanged', async () => {
    const sub = makeSubscription({ strategies: [ratedPoolStrategy(null)] });
    const { prisma } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [{ signalId: SIGNAL_A, quantity: 1250 }],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const line = res.calculationDetails.lineItems[0];
    expect(line.amount).toBe(99 + 250 * 0.03);
    // Only what burned PAST the pool is overage — the fee never inflates it.
    expect(line.tiersUsed.find((t: any) => t.lower === 1000).quantity).toBe(250);
  });

  it('poolPrice = 0 + no usage: no fee AND no line (never a $0 line)', async () => {
    const sub = makeSubscription({ strategies: [freePoolStrategy()] });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toEqual([]);
    expect(res.calculationDetails.total).toBe(0);
  });

  it('poolPrice = 0 + usage past the pool: the overage bills, the pool costs nothing', async () => {
    const sub = makeSubscription({ strategies: [freePoolStrategy()] });
    const { prisma } = buildMockPrismaWithEventFilter({
      subscription: sub,
      events: [{ signalId: SIGNAL_A, quantity: 1250 }],
    });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems[0].amount).toBeCloseTo(250 * 0.03, 6);
  });

  it('a platform fee on the same plan bills normally beside a zero-usage pool', async () => {
    const sub = makeSubscription({
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      strategies: [ratedPoolStrategy(null), platformFeeStrategy()],
    });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const byType = Object.fromEntries(
      res.calculationDetails.lineItems.map((li: any) => [li.chargeType, li]),
    );
    // The two are independent: neither absorbs nor suppresses the other.
    expect(byType.recurring.amount).toBeCloseTo(50, 6);
    expect(byType.usage.amount).toBe(99);
    expect(res.calculationDetails.total).toBeCloseTo(149, 6);
  });

  it('a platform fee bills unchanged when the plan carries a FREE pool and no usage', async () => {
    const sub = makeSubscription({
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      strategies: [freePoolStrategy(), platformFeeStrategy()],
    });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    // Only the platform fee — the free pool contributes no line at all.
    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0].chargeType).toBe('recurring');
    expect(res.calculationDetails.total).toBeCloseTo(50, 6);
  });

  it('a NON-pool usage strategy with zero events still emits no line', async () => {
    // The rule is about pools only. Everything else stays usage-driven, and
    // a guard relaxed one notch too wide would start billing empty flat lines.
    const sub = makeSubscription({
      strategies: [
        {
          id: STRAT_USAGE,
          name: 'Per API Call',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(0.1),
          tiers: null,
          minimumCommitment: null,
          signalId: SIGNAL_B,
          signals: { id: SIGNAL_B, name: 'API Call' },
        },
        ratedPoolStrategy(null),
      ],
    });
    const { prisma } = buildMockPrismaWithEventFilter({ subscription: sub, events: [] });
    const svc = await buildService(prisma);
    const res: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    expect(res.calculationDetails.lineItems).toHaveLength(1);
    expect(res.calculationDetails.lineItems[0].pricingStrategyId).toBe(STRAT_POOL);
  });
});

/**
 * SIM-VS-INVOICE PARITY on rated pools.
 *
 * The quoted number and the billed number must be the same number: identical
 * usage pushed through simulateRevenue (name-keyed projectedEvents) and
 * calculateInvoice (id-keyed signal_events) has to produce an identical pool
 * line — quantity AND amount, exact equality on float-exact fixtures. A
 * simulator that under-counts a rated pool recreates the quoted-vs-billed
 * confusion this feature exists to kill.
 */

const MEMBER_SIGNALS = [
  { id: SIGNAL_B, name: 'Note', shortName: 'note' },
  { id: SIGNAL_C, name: 'Half', shortName: 'half' },
];

function buildParityMock(opts: {
  pricingPlan: any;
  subscription: any;
  events: Array<{ signalId: string; quantity: number }>;
}) {
  return {
    getClient: function () {
      return this;
    },
    pricing_plans: {
      findUnique: ({ where }: any) =>
        Promise.resolve(where.id === PLAN_ID ? opts.pricingPlan : null),
    },
    signals: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          MEMBER_SIGNALS.filter((s) => where.id.in.includes(s.id) && where.orgId === ORG),
        ),
    },
    subscriptions: {
      findUnique: ({ where }: any) => Promise.resolve(where.id === SUB ? opts.subscription : null),
    },
    signal_events: {
      findMany: ({ where }: any) =>
        Promise.resolve(opts.events.filter((e) => where.signalId.in.includes(e.signalId))),
    },
  };
}

function ratedPoolPlan(strategy: any) {
  return {
    id: PLAN_ID,
    name: 'Rated Pool Plan',
    description: 'parity fixture',
    orgId: ORG,
    agents: null,
    pricing_strategies: [strategy],
  };
}

describe('InvoiceCalculatorService — sim-vs-invoice pool parity', () => {
  const parityCases = [
    {
      label: 'inside the pool: 2 × 4 + 3 × 2 = 14 credits',
      creditRates: { [SIGNAL_A]: 4, [SIGNAL_B]: 2 },
      projectedEvents: { report: 2, note: 3 },
      events: [
        { signalId: SIGNAL_A, quantity: 2 },
        { signalId: SIGNAL_B, quantity: 3 },
      ],
      quantity: 14,
      invoiceQuantity: 14,
      amount: 99,
      denomination: 'credits',
    },
    {
      label: 'credits overage: 800 + 500 = 1,300 → $99 + 300 × $0.03',
      creditRates: { [SIGNAL_A]: 4, [SIGNAL_B]: 2 },
      projectedEvents: { report: 200, note: 250 },
      events: [
        { signalId: SIGNAL_A, quantity: 200 },
        { signalId: SIGNAL_B, quantity: 250 },
      ],
      quantity: 1300,
      invoiceQuantity: 1300,
      amount: 99 + 300 * 0.03,
      denomination: 'credits',
    },
    {
      label: 'fractional rate hand pin: 113 × 4 + 75 × 2 + 33 × 0.5 = 618.5',
      creditRates: { [SIGNAL_A]: 4, [SIGNAL_B]: 2, [SIGNAL_C]: 0.5 },
      projectedEvents: { report: 113, note: 75, half: 33 },
      events: [
        { signalId: SIGNAL_A, quantity: 113 },
        { signalId: SIGNAL_B, quantity: 75 },
        { signalId: SIGNAL_C, quantity: 33 },
      ],
      quantity: 618.5,
      invoiceQuantity: 618.5,
      amount: 99,
      denomination: 'credits',
    },
    {
      label: 'legacy rate-less pool: raw units, unrated arithmetic',
      creditRates: null,
      projectedEvents: { report: 1250 },
      events: [{ signalId: SIGNAL_A, quantity: 1250 }],
      quantity: 1250,
      invoiceQuantity: 1250,
      amount: 99 + 250 * 0.03,
      denomination: 'units',
    },
    {
      // The quote and the bill agree at ZERO usage too. A simulator that
      // kept a zero-quantity guard would quote $0 against a $99 invoice — the exact quoted-vs-billed confusion
      // the rest of this block exists to prevent.
      //
      // The one case where the two lines carry a different quantity, on
      // purpose. The quote's number is projected credits, and the operator
      // typed zero. The invoice's number is what the merchant charges for, and
      // it is one pool fee — the shape Stripe multiplies out to collect $99.
      // Amounts are what have to match, and they do.
      label: 'no usage at all: the pool fee, quoted and billed alike',
      creditRates: { [SIGNAL_A]: 4, [SIGNAL_B]: 2 },
      projectedEvents: {},
      events: [],
      quantity: 0,
      invoiceQuantity: 1,
      amount: 99,
      denomination: 'credits',
    },
  ];

  it.each(parityCases)(
    'simulator and invoice bill the SAME pool line — $label',
    async ({
      creditRates,
      projectedEvents,
      events,
      quantity,
      invoiceQuantity,
      amount,
      denomination,
    }) => {
      const strategy = ratedPoolStrategy(creditRates);
      const svc = await buildService(
        buildParityMock({
          pricingPlan: ratedPoolPlan(strategy),
          subscription: makeSubscription({ strategies: [strategy] }),
          events,
        }),
      );

      const sim: any = await svc.simulateRevenue({
        pricingPlanId: PLAN_ID,
        projectedEvents,
        billingCycle: 'monthly',
        seatsCount: 0,
      } as any);
      const invoice: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

      const simLine = sim.recurringCharges.lineItems.find(
        (li: any) => li.pricingStrategyId === STRAT_POOL,
      );
      const invoiceLine = invoice.calculationDetails.lineItems.find(
        (li: any) => li.pricingStrategyId === STRAT_POOL,
      );

      // The hand pins, exact — float-exact fixtures need no tolerance.
      expect(simLine.quantity).toBe(quantity);
      expect(simLine.amount).toBe(amount);
      expect(invoiceLine.quantity).toBe(invoiceQuantity);
      // THE parity: quoted === billed, on the same usage. The money is what
      // has to agree. Quantity agrees too everywhere except the zero-usage
      // fee, where the invoice bills one fee and the quote reports zero
      // credits — see the fixture's note.
      expect(simLine.amount).toBe(invoiceLine.amount);
      // One pool line on each side — members never grow their own lines.
      expect(sim.recurringCharges.lineItems).toHaveLength(1);
      expect(invoice.calculationDetails.lineItems).toHaveLength(1);
      // The noun matches what the number IS. A rated pool
      // quoting "14 units" tells the customer the opposite of what it bills.
      expect(simLine.description).toBe(`Credit Pool (${quantity} ${denomination})`);
    },
  );

  it('a LEGACY rate-less pool with no usage quotes and bills the same fee', async () => {
    // The most common pool shape. Rate-less pools must
    // move for the fee rule and for nothing else, so this pins the pair
    // rather than only the invoice half.
    const strategy = ratedPoolStrategy(null);
    const svc = await buildService(
      buildParityMock({
        pricingPlan: ratedPoolPlan(strategy),
        subscription: makeSubscription({ strategies: [strategy] }),
        events: [],
      }),
    );

    const sim: any = await svc.simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);
    const invoice: any = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const simLine = sim.recurringCharges.lineItems[0];
    const invoiceLine = invoice.calculationDetails.lineItems[0];
    expect(simLine.amount).toBe(99);
    expect(invoiceLine.amount).toBe(99);
    // Rate-less means units, at zero usage as at any other.
    expect(simLine.description).toBe('Credit Pool (0 units)');
    // The bill charges one fee. See the parity fixture note above for why the
    // two quantities read differently here and only here.
    expect(invoiceLine.quantity).toBe(1);
    expect(invoiceLine.description).toBe('report: credit pool fee (no usage this period)');
  });

  it('the rate-less pool description is byte-identical to the unrated sentence', () => {
    // Spelled out rather than templated: the exact string a rate-less pool
    // produces. Rated pools must not move it.
    const legacy = parityCases.find((c) => c.creditRates === null)!;
    expect(`Credit Pool (${legacy.quantity} ${legacy.denomination})`).toBe(
      'Credit Pool (1250 units)',
    );
  });

  it('a non-pool usage strategy keeps saying units, whatever its signal', async () => {
    const flat = {
      id: 'strat-flat',
      name: 'Flat Usage',
      chargeType: 'usage',
      pricingModel: 'flat',
      rate: 0.5,
      tiers: [],
      minimumCommitment: null,
      signalId: SIGNAL_A,
      signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
      // Stray rates on a non-pool row must not flip the denomination: only a
      // credit pool has credits to speak of.
      creditRates: { [SIGNAL_A]: 4 },
    };
    const svc = await buildService(
      buildParityMock({
        pricingPlan: ratedPoolPlan(flat),
        subscription: makeSubscription({ strategies: [flat] }),
        events: [],
      }),
    );
    const sim: any = await svc.simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 10 },
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);
    expect(sim.recurringCharges.lineItems[0].description).toBe('Flat Usage (10 units)');
  });

  it('a degenerate creditRates map never promotes the pool to credits', async () => {
    // Rotten JSON reads as "no rate stored", so the quantity is still raw
    // units — the label has to agree with the arithmetic, not with the mere
    // presence of a creditRates column.
    const strategy = ratedPoolStrategy({ [SIGNAL_A]: 'four' });
    const svc = await buildService(
      buildParityMock({
        pricingPlan: ratedPoolPlan(strategy),
        subscription: makeSubscription({ strategies: [strategy] }),
        events: [],
      }),
    );
    const sim: any = await svc.simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 10 },
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);
    expect(sim.recurringCharges.lineItems[0].description).toBe('Credit Pool (10 units)');
  });

  it('a projected key for a NON-member signal never inflates the simulated pool', async () => {
    const strategy = ratedPoolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 });
    const svc = await buildService(
      buildParityMock({
        pricingPlan: ratedPoolPlan(strategy),
        subscription: makeSubscription({ strategies: [strategy] }),
        events: [],
      }),
    );
    const sim: any = await svc.simulateRevenue({
      pricingPlanId: PLAN_ID,
      projectedEvents: { report: 2, note: 3, half: 999, rogue: 999 },
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);
    expect(
      sim.recurringCharges.lineItems.find((li: any) => li.pricingStrategyId === STRAT_POOL)
        .quantity,
    ).toBe(14);
  });
});
