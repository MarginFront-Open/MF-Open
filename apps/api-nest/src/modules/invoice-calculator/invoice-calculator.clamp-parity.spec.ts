/**
 * WHAT THIS FILE GUARDS: the minimum-commitment clamp is applied
 * BEFORE the zero-quantity guard in simulateRevenue, and invoice line items
 * carry the BILLED quantity, so the simulator can never say $0 (or show a raw
 * count) where a real invoice bills the plan minimum.
 *
 * Canon: R2 (seat fees bill max(seatsCount, minimumCommitment)), R1 (usage
 * has the same floor), R1b (every fixture below includes a minimum-commitment
 * floor, as that rule requires).
 *
 * A 10-seat minimum simulated at 5 seats must show that the minimum was
 * enforced. These tests pin that the response bills 10 and says
 * "minimum commitment, 5 entered" on the line.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { InvoiceCalculatorService } from './invoice-calculator.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const PLAN = 'plan-uuid';
const SUB = 'sub-uuid';
const SIGNAL = 'signal-uuid';

function seatStrategy(id: string, minimumCommitment: number | null) {
  return {
    id,
    name: 'Per Seat',
    chargeType: 'seat_based',
    pricingModel: 'flat',
    rate: new Decimal(10),
    tiers: null,
    billingFrequency: 'monthly',
    minimumCommitment,
    signalId: null,
    signals: null,
  };
}

function usageStrategy(minimumCommitment: number | null) {
  return {
    id: 'strat-usage',
    name: 'Per Call',
    chargeType: 'usage',
    pricingModel: 'flat',
    rate: new Decimal(0.01),
    tiers: null,
    billingFrequency: 'monthly',
    minimumCommitment,
    signalId: SIGNAL,
    signals: { id: SIGNAL, name: 'API Call', shortName: 'api_call' },
  };
}

function planWith(strategies: any[]) {
  return {
    id: PLAN,
    name: 'Clamp Plan',
    description: 'Clamp fixture',
    orgId: ORG,
    agents: null,
    pricing_strategies: strategies,
  };
}

function mockPrisma(overrides: Record<string, any>) {
  return {
    getClient: function () {
      return this;
    },
    ...overrides,
  };
}

async function buildService(prisma: any): Promise<InvoiceCalculatorService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [InvoiceCalculatorService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get<InvoiceCalculatorService>(InvoiceCalculatorService);
}

function simulatePrisma(plan: any) {
  return mockPrisma({
    pricing_plans: {
      findUnique: ({ where }: any) => Promise.resolve(where.id === plan.id ? plan : null),
    },
  });
}

function seatLine(res: any) {
  return res.recurringCharges.lineItems.find((li: any) => li.chargeType === 'seat_based');
}

describe('simulateRevenue — clamp before the zero guard', () => {
  it('0 entered seats still bills the 10-seat minimum, not $0', async () => {
    const svc = await buildService(simulatePrisma(planWith([seatStrategy('strat-seat', 10)])));
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);

    const line = seatLine(res);
    expect(line.quantity).toBe(10);
    expect(line.amount).toBe(100); // max(0, 10) × $10
    expect(line.description).toContain('minimum commitment, 0 entered');
    expect(res.billedSeatsCount).toBe(10);
  });

  it('5 entered seats against a 10-seat minimum bills 10 and says so', async () => {
    const svc = await buildService(simulatePrisma(planWith([seatStrategy('strat-seat', 10)])));
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 5,
    } as any);

    const line = seatLine(res);
    expect(line.quantity).toBe(10);
    expect(line.amount).toBe(100); // max(5, 10) × $10
    expect(line.description).toContain('minimum commitment, 5 entered');
    expect(res.billedSeatsCount).toBe(10);
  });

  it('seats above the minimum bill the real count with no minimum note', async () => {
    const svc = await buildService(simulatePrisma(planWith([seatStrategy('strat-seat', 10)])));
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 12,
    } as any);

    const line = seatLine(res);
    expect(line.quantity).toBe(12);
    expect(line.amount).toBe(120);
    expect(line.description).not.toContain('minimum commitment');
    expect(res.billedSeatsCount).toBe(12);
  });

  it('usage with a minimum floor clamps at 0 projected events too (canon R1 parity)', async () => {
    const svc = await buildService(simulatePrisma(planWith([usageStrategy(100)])));
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 0,
    } as any);

    const line = res.recurringCharges.lineItems.find((li: any) => li.chargeType === 'usage');
    expect(line.quantity).toBe(100);
    expect(line.amount).toBeCloseTo(1, 6); // max(0, 100) × $0.01
    expect(line.description).toContain('minimum commitment, 0 entered');
  });

  it('billedSeatsCount is omitted when the plan has two seat strategies', async () => {
    const svc = await buildService(
      simulatePrisma(planWith([seatStrategy('strat-seat-a', 10), seatStrategy('strat-seat-b', 3)])),
    );
    const res = await svc.simulateRevenue({
      pricingPlanId: PLAN,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 5,
    } as any);

    // With two seat strategies no single count reconciles with the summed
    // dollars, so the field must be absent rather than misleading.
    expect(res).not.toHaveProperty('billedSeatsCount');
  });
});

describe('calculateInvoice — line item carries the BILLED quantity', () => {
  it('a 5-seat subscription on a 10-minimum plan invoices "10 seats" and annotates', async () => {
    // Jan 2026: 31-day window over a 31-day calendar cycle → proration 1.0.
    const windowStart = new Date('2026-01-01T00:00:00Z');
    const windowEnd = new Date('2026-02-01T00:00:00Z');
    const subscription = {
      id: SUB,
      organizationId: ORG,
      seatsCount: 5,
      status: 'active',
      billingCycle: 'monthly',
      customCycleDays: null,
      startDate: new Date('2025-06-01T00:00:00Z'),
      endDate: null,
      currentBillingPeriodStart: windowStart,
      currentBillingPeriodEnd: windowEnd,
      pricing_plans: {
        id: PLAN,
        pricing_strategies: [seatStrategy('strat-seat', 10)],
      },
    };
    const svc = await buildService(
      mockPrisma({
        subscriptions: {
          findUnique: ({ where }: any) => Promise.resolve(where.id === SUB ? subscription : null),
        },
      }),
    );

    const res = await svc.calculateInvoice({ subscriptionId: SUB } as any);

    const line = res.calculationDetails.lineItems.find((li: any) => li.chargeType === 'seat_based');
    expect(line.quantity).toBe(10); // billed, not the raw 5
    expect(line.amount).toBe(100); // 10 × $10 reconciles with it
    expect(line.description).toContain('minimum commitment, 5 entered');
    expect(line.effectiveUnitPrice).toBe(10); // amount / BILLED seats
  });
});
