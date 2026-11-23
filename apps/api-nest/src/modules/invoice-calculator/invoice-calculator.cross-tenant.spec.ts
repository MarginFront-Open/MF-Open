/**
 * Cross-tenant READ tests for InvoiceCalculatorService.
 *
 * The service takes the caller's org and scopes each lookup to it, so a cross-org
 * subscriptionId / pricingPlanId 404s instead of returning another org's billing math.
 * Internal callers (subscription-billing) pass no org and keep the unscoped by-id path,
 * proven here too so the batch-billing cron keeps working.
 */

import { NotFoundException } from '@nestjs/common';
import { InvoiceCalculatorService } from './invoice-calculator.service';

const SUB = 'sub-1';
const PLAN = 'plan-1';
const ORG = 'org-a';
const OTHER_ORG = 'org-b';

const subscription = {
  id: SUB,
  organizationId: ORG,
  billingCycle: 'monthly',
  customCycleDays: null,
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  currentBillingPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentBillingPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  seatsCount: 0,
  status: 'active',
  nextRecurringInvoiceAt: null,
  cycleNumber: 1,
  pricing_plans: { pricing_strategies: [] },
};

const pricingPlan = {
  id: PLAN,
  name: 'Test Plan',
  description: 'fixture',
  orgId: ORG,
  agents: null,
  pricing_strategies: [],
};

function buildPrisma() {
  return {
    subscriptions: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === SUB && where.organizationId === ORG ? subscription : null,
      ),
      findUnique: jest.fn(async ({ where }: any) => (where.id === SUB ? subscription : null)),
    },
    pricing_plans: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === PLAN && where.orgId === ORG ? pricingPlan : null,
      ),
      findUnique: jest.fn(async ({ where }: any) => (where.id === PLAN ? pricingPlan : null)),
    },
    signal_events: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('InvoiceCalculatorService org scoping', () => {
  describe('calculateInvoice', () => {
    it('same-org: returns the calculation and scopes the lookup by organizationId', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      const res = await svc.calculateInvoice({ subscriptionId: SUB } as any, ORG);
      expect(res.subscriptionId).toBe(SUB);
      expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUB, organizationId: ORG } }),
      );
      expect(prisma.subscriptions.findUnique).not.toHaveBeenCalled();
    });

    it('cross-org: another org id 404s (no leak)', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      await expect(
        svc.calculateInvoice({ subscriptionId: SUB } as any, OTHER_ORG),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('internal caller (no org): keeps the unscoped by-id lookup', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      const res = await svc.calculateInvoice({ subscriptionId: SUB } as any);
      expect(res.subscriptionId).toBe(SUB);
      expect(prisma.subscriptions.findUnique).toHaveBeenCalled();
      expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getBillingStatus', () => {
    it('same-org: returns status', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      const res = await svc.getBillingStatus(SUB, ORG);
      expect(res.subscriptionId).toBe(SUB);
      expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUB, organizationId: ORG } }),
      );
    });

    it('cross-org: 404s', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      await expect(svc.getBillingStatus(SUB, OTHER_ORG)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('simulateRevenue', () => {
    it('same-org: returns the plan simulation scoped by orgId', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      const res = await svc.simulateRevenue({ pricingPlanId: PLAN } as any, ORG);
      expect(res.pricingPlan.id).toBe(PLAN);
      expect(prisma.pricing_plans.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PLAN, orgId: ORG } }),
      );
    });

    it('cross-org: another org pricingPlanId 404s', async () => {
      const prisma = buildPrisma();
      const svc = new InvoiceCalculatorService(prisma);
      await expect(
        svc.simulateRevenue({ pricingPlanId: PLAN } as any, OTHER_ORG),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
