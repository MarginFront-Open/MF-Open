/**
 * Parity tests for AnalyticsService on the canonical library.
 *
 * Each test mocks PrismaService with a known fixture, calls the analytics
 * method (which routes through RevenueMetricsService → canonical
 * library), and independently recomputes the expected number from the
 * same fixture, so the service and the library must agree.
 *
 * Coverage focus: the endpoints that read the canonical library
 * (getCostAnalytics trend, getProfitabilityAnalytics M1 safety,
 * getSubscriptionAnalytics I3 + revenue, getCustomerAnalytics revenue,
 * getAgentAnalytics revenue). getUsageAnalytics and aggregateEvents only
 * count events, so they aren't covered here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { AnalyticsService } from './analytics.service';
import { RevenueMetricsService } from './revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { getAgentEarned, safeMarginPercent } from '@marginfront/db';

const ORG = 'org-uuid';
const AGENT = 'agent-uuid';
const CUSTOMER = 'cust-uuid';
const SIGNAL = 'signal-uuid';
const SUB = 'sub-uuid';

// ─── Mock fixture helpers ──────────────────────────────────────────────────

const mkSignalEvent = (overrides: {
  usageDate: Date;
  usageCost: number | null;
  quantity?: number;
  agentId?: string;
  customerId?: string;
  customerExternalId?: string;
  signalId?: string;
  subscriptionId?: string;
  planId?: string;
  model?: string;
}) => ({
  id: `evt-${Math.random().toString(36).slice(2, 8)}`,
  organizationId: ORG,
  agentId: overrides.agentId ?? AGENT,
  customerId: overrides.customerId ?? CUSTOMER,
  customerExternalId: overrides.customerExternalId ?? 'ext-customer-1',
  signalId: overrides.signalId ?? SIGNAL,
  subscriptionId: overrides.subscriptionId ?? SUB,
  usageDate: overrides.usageDate,
  usageCost: overrides.usageCost === null ? null : new Decimal(overrides.usageCost),
  quantity: new Decimal(overrides.quantity ?? 1),
  signals: { id: overrides.signalId ?? SIGNAL, name: 'Signal 1', shortName: 's1' },
  agents: { id: overrides.agentId ?? AGENT, name: 'Agent A', agentCode: 'A' },
  customers: {
    id: overrides.customerId ?? CUSTOMER,
    name: 'Customer 1',
    externalId: overrides.customerExternalId ?? 'ext-customer-1',
  },
  subscriptions: { planId: overrides.planId ?? null },
  raw_ingest_events: overrides.model ? { payload: { model: overrides.model } } : null,
});

const mkInvoice = (overrides: {
  status: 'draft' | 'issued' | 'paid' | 'overdue' | 'void';
  totalAmount: number;
  invoiceDate: Date;
  customerId?: string;
  subscriptionId?: string;
  agentId?: string;
}) => ({
  id: `inv-${Math.random().toString(36).slice(2, 8)}`,
  organizationId: ORG,
  customerId: overrides.customerId ?? CUSTOMER,
  subscriptionId: overrides.subscriptionId ?? SUB,
  status: overrides.status,
  totalAmount: new Decimal(overrides.totalAmount),
  invoiceDate: overrides.invoiceDate,
  dueDate: overrides.invoiceDate,
  customers: {
    id: overrides.customerId ?? CUSTOMER,
    name: 'Customer 1',
    externalId: 'ext-customer-1',
  },
  subscriptions: {
    id: overrides.subscriptionId ?? SUB,
    agentId: overrides.agentId ?? AGENT,
    agents: { id: overrides.agentId ?? AGENT, name: 'Agent A' },
  },
});

function buildMockPrisma({
  events = [] as any[],
  invoices = [] as any[],
  subscriptions = [] as any[],
  customers = [] as any[],
  agents = [] as any[],
  signals = [] as any[],
}) {
  // Generic where-clause filter that covers every lookup the canonical
  // library sends at us: organizationId + invoiceDate/usageDate range +
  // status IN + customerId/agentId/signalId/subscriptionId.
  const filterRows = (rows: any[], where: any): any[] => {
    if (!where) return rows;
    return rows.filter((r) => {
      if (where.organizationId && r.organizationId !== where.organizationId) return false;
      if (where.customerId && r.customerId !== where.customerId) return false;
      if (where.customerExternalId && r.customerExternalId !== where.customerExternalId)
        return false;
      if (where.agentId && r.agentId !== where.agentId) return false;
      if (where.signalId && r.signalId !== where.signalId) return false;
      if (where.subscriptionId) {
        if (typeof where.subscriptionId === 'string') {
          if (r.subscriptionId !== where.subscriptionId) return false;
        } else if (where.subscriptionId.in) {
          if (!where.subscriptionId.in.includes(r.subscriptionId)) return false;
        }
      }
      if (where.status) {
        if (typeof where.status === 'string' && r.status !== where.status) return false;
        if (
          typeof where.status === 'object' &&
          where.status.in &&
          !where.status.in.includes(r.status)
        )
          return false;
      }
      // invoiceDate / usageDate / startDate / endDate window filters.
      for (const field of ['invoiceDate', 'usageDate', 'startDate', 'endDate']) {
        const w = (where as any)[field];
        if (!w) continue;
        const v = r[field];
        if (!v) continue;
        if (w.gte && v < w.gte) return false;
        if (w.lte && v > w.lte) return false;
        if (w.lt && v >= w.lt) return false;
      }
      // Subscription-nested agent filter used by getRevenueAnalytics.
      if (where.subscriptions && where.subscriptions.agentId) {
        if (r.subscriptions?.agentId !== where.subscriptions.agentId) return false;
      }
      return true;
    });
  };

  return {
    getClient: function () {
      return this;
    },
    signal_events: {
      findMany: ({ where }: any) => Promise.resolve(filterRows(events, where)),
      count: ({ where }: any) => Promise.resolve(filterRows(events, where).length),
    },
    invoices: {
      findMany: ({ where, select }: any) => {
        const rows = filterRows(invoices, where);
        if (!select) return Promise.resolve(rows);
        return Promise.resolve(
          rows.map((r) => {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = r[k];
            return out;
          }),
        );
      },
      aggregate: ({ where }: any) => {
        const rows = filterRows(invoices, where);
        return Promise.resolve({
          _sum: {
            totalAmount: rows.reduce((s, r) => s + Number(r.totalAmount), 0),
          },
        });
      },
      count: ({ where }: any) => Promise.resolve(filterRows(invoices, where).length),
    },
    // Canon Collected reads cash from invoice_payments
    // (succeeded payments by paymentDate). These tests seed invoices with no
    // payment rows, so the payment side is empty — Collected for a paid invoice
    // with no payment row flows through the invoiceDate fallback (canon I3),
    // which is the number these parity tests assert.
    invoice_payments: {
      findMany: () => Promise.resolve([]),
      groupBy: () => Promise.resolve([]),
    },
    subscriptions: {
      findMany: ({ where }: any) => Promise.resolve(filterRows(subscriptions, where)),
      findUnique: ({ where }: any) =>
        Promise.resolve(subscriptions.find((s) => s.id === where.id) ?? null),
      count: () => Promise.resolve(0),
    },
    customers: {
      findUnique: ({ where }: any) =>
        Promise.resolve(customers.find((c) => c.id === where.id) ?? null),
    },
    agents: {
      findUnique: ({ where }: any) =>
        Promise.resolve(agents.find((a) => a.id === where.id) ?? null),
      findFirst: ({ where }: any) =>
        Promise.resolve(
          agents.find((a) => a.id === where.id && (!where.orgId || a.orgId === where.orgId)) ??
            null,
        ),
    },
    signals: {
      findUnique: ({ where }: any) =>
        Promise.resolve(signals.find((s) => s.id === where.id) ?? null),
      findMany: ({ where }: any) =>
        Promise.resolve(signals.filter((s) => (where?.id?.in ? where.id.in.includes(s.id) : true))),
    },
  };
}

async function buildService(mockPrisma: any): Promise<AnalyticsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AnalyticsService,
      RevenueMetricsService,
      { provide: PrismaService, useValue: mockPrisma },
    ],
  }).compile();
  return module.get<AnalyticsService>(AnalyticsService);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AnalyticsService canonical parity', () => {
  describe('getCostAnalytics. canon cost + priorWindow', () => {
    // Core cost comes from canonGetCostMetrics. Assert totalCost
    // matches an independent SUM(usageCost) recompute. The priorWindow
    // option drives period-over-period without a second hand-rolled
    // findMany in the service.
    it('stats.totalCost matches independent signal_events.usageCost sum', async () => {
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 5)),
          usageCost: 0.05,
        }),
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.1,
        }),
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 20)),
          usageCost: 0.2,
        }),
        // Outside the window. Must not count.
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 4, 15)),
          usageCost: 99,
        }),
      ];

      // Independent recompute: sum usageCost for events in the window.
      const expected = 0.05 + 0.1 + 0.2;

      const svc = await buildService(buildMockPrisma({ events }));
      const res = await svc.getCostAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      } as any);
      expect(res.stats.totalCost).toBeCloseTo(expected, 6);
      expect(res.stats.totalEvents).toBe(3);
    });

    // Null-cost events count in eventCount but contribute 0 to cost.
    // Canon C1.
    it('null-cost events count in eventCount but not in totalCost', async () => {
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 5)),
          usageCost: 0.5,
        }),
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: null,
        }),
      ];
      const svc = await buildService(buildMockPrisma({ events }));
      const res = await svc.getCostAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      } as any);
      expect(res.stats.totalCost).toBeCloseTo(0.5, 6);
      expect(res.stats.totalEvents).toBe(2);
    });
  });

  describe('getProfitabilityAnalytics. canon M1 safeMarginPercent', () => {
    // Zero-revenue signal rows must render marginPercent as null, never 0%,
    // never NaN%, never Infinity%. A 0 would
    // hide that the row has cost but no revenue to margin against.
    it('zero-revenue signal row returns profitMargin=null (canon M1)', async () => {
      // Build a subscription with a signal but NO usage strategy. So any
      // events that fire against it produce cost but zero calculatedRevenue.
      const subscriptions = [
        {
          id: SUB,
          organizationId: ORG,
          agentId: AGENT,
          customerId: CUSTOMER,
          customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
          agents: { id: AGENT },
          status: 'active',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          pricing_plans: {
            pricing_strategies: [
              // No usage strategy. Profitability finds usage events with
              // no matching strategy → estimatedRevenue stays 0.
            ],
          },
        },
      ];
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.1,
          quantity: 10,
          subscriptionId: SUB,
        }),
      ];

      const svc = await buildService(buildMockPrisma({ events, subscriptions }));
      const res = await svc.getProfitabilityAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });

      // Canon M1: revenue === 0 → marginPercent null. Independent recompute:
      // with no usage strategy, calculatedRevenue = 0, so the formula
      // `(0 - 0.1) / 0 * 100` is undefined. Library must return null.
      expect(res.overall.profitMargin).toBeNull();
      if (res.bySignal.length > 0) {
        expect(res.bySignal[0].profitMargin).toBeNull();
      }
    });

    // Positive-revenue signal returns a real margin percent. Not null.
    // Independent recompute: (rev - cost) / rev * 100.
    it('positive-revenue signal returns canonical profitMargin number', async () => {
      const subscriptions = [
        {
          id: SUB,
          organizationId: ORG,
          agentId: AGENT,
          customerId: CUSTOMER,
          customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
          agents: { id: AGENT },
          status: 'active',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          pricing_plans: {
            pricing_strategies: [
              {
                id: 'strat-1',
                chargeType: 'usage',
                pricingModel: 'flat',
                rate: new Decimal(1.0),
                tiers: [],
                minimumCommitment: null,
                signalId: SIGNAL,
                signals: { id: SIGNAL, name: 'Signal 1', shortName: 's1' },
              },
            ],
          },
        },
      ];
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.2,
          quantity: 10,
          subscriptionId: SUB,
        }),
      ];

      const svc = await buildService(buildMockPrisma({ events, subscriptions }));
      const res = await svc.getProfitabilityAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });

      // Independent recompute: calculatedRevenue = 10 units × $1/unit = 10.
      // cost = 0.2. profit = 9.8. marginPercent = 98.
      expect(res.overall.calculatedRevenue).toBeCloseTo(10, 6);
      expect(res.overall.totalCost).toBeCloseTo(0.2, 6);
      expect(res.overall.profit).toBeCloseTo(9.8, 6);
      expect(res.overall.profitMargin).toBeCloseTo(98, 4);
    });
  });

  describe('getCustomerAnalytics. canon revenue / cost / margin per customer', () => {
    it('usageData.totalCost + totalRevenue match canon getRevenueMetrics', async () => {
      const customers = [
        {
          id: CUSTOMER,
          name: 'Customer 1',
          externalId: 'ext-customer-1',
          organizationId: ORG,
        },
      ];
      const subscriptions = [
        {
          id: SUB,
          organizationId: ORG,
          customerId: CUSTOMER,
          agentId: AGENT,
          planId: 'plan-1',
          customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
          status: 'active',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: null,
          billingCycle: 'monthly',
          customCycleDays: null,
          seatsCount: 0,
          deletedAt: null,
          pricing_plans: {
            pricing_strategies: [
              {
                id: 'strat-1',
                chargeType: 'usage',
                pricingModel: 'flat',
                rate: new Decimal(0.5),
                tiers: [],
                minimumCommitment: null,
                signalId: SIGNAL,
                active: true,
                deletedAt: null,
              },
            ],
            name: 'Plan',
            description: 'desc',
          },
          agents: { name: 'A' },
        },
      ];
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.3,
          quantity: 100,
          subscriptionId: SUB,
        }),
      ];

      const svc = await buildService(buildMockPrisma({ events, subscriptions, customers }));
      const res = await svc.getCustomerAnalytics(ORG, {
        customerId: CUSTOMER,
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });

      // Independent recompute: revenue = 100 × 0.5 = 50. cost = 0.3.
      // margin = 49.7. marginPercent = (49.7 / 50) × 100 = 99.4.
      expect(res.usageData.totalRevenue).toBeCloseTo(50, 6);
      expect(res.usageData.totalCost).toBeCloseTo(0.3, 6);
      expect(res.usageData.margin).toBeCloseTo(49.7, 6);
      expect(res.usageData.marginPercent).toBeCloseTo(99.4, 4);
    });
  });

  describe('getAgentAnalytics. canon agentId filter', () => {
    it('usageData.totalCost + totalRevenue match canon per-agent metrics', async () => {
      const agents = [
        { id: AGENT, name: 'Agent A', agentCode: 'A', orgId: ORG },
        { id: 'agent-B', name: 'Agent B', agentCode: 'B', orgId: ORG },
      ];
      // Each agent owns a distinct subscription. Canon A1 attributes
      // events via subscriptionId first, so an agent filter only captures
      // the subs with that agentId.
      const subB = 'sub-B';
      const subscriptions = [
        {
          id: SUB,
          organizationId: ORG,
          customerId: CUSTOMER,
          agentId: AGENT,
          planId: 'plan-1',
          customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
          status: 'active',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: null,
          billingCycle: 'monthly',
          customCycleDays: null,
          seatsCount: 0,
          deletedAt: null,
          pricing_plans: {
            pricing_strategies: [
              {
                id: 'strat-1',
                chargeType: 'usage',
                pricingModel: 'flat',
                rate: new Decimal(1.0),
                tiers: [],
                minimumCommitment: null,
                signalId: SIGNAL,
                active: true,
                deletedAt: null,
              },
            ],
          },
        },
        {
          id: subB,
          organizationId: ORG,
          customerId: CUSTOMER,
          agentId: 'agent-B',
          planId: 'plan-1',
          customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
          status: 'active',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: null,
          billingCycle: 'monthly',
          customCycleDays: null,
          seatsCount: 0,
          deletedAt: null,
          pricing_plans: {
            pricing_strategies: [
              {
                id: 'strat-2',
                chargeType: 'usage',
                pricingModel: 'flat',
                rate: new Decimal(1.0),
                tiers: [],
                minimumCommitment: null,
                signalId: SIGNAL,
                active: true,
                deletedAt: null,
              },
            ],
          },
        },
      ];
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.5,
          quantity: 50,
          agentId: AGENT,
          subscriptionId: SUB,
        }),
        // Different agent + different sub. Canon A1 scopes via sub first.
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 99,
          quantity: 999,
          agentId: 'agent-B',
          subscriptionId: subB,
        }),
      ];

      const svc = await buildService(buildMockPrisma({ events, subscriptions, agents }));
      const res = await svc.getAgentAnalytics(ORG, {
        agentId: AGENT,
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });

      // Independent recompute: agent-A only. Revenue = 50 × 1.0 = 50,
      // cost = 0.5 (agent-B's 99 + 999 excluded via subscriptionId-based
      // scoping).
      expect(res.usageData.totalCost).toBeCloseTo(0.5, 6);
      expect(res.usageData.totalRevenue).toBeCloseTo(50, 6);
    });
  });

  describe('getSubscriptionAnalytics. canon I3 invoiceDate + revenue metrics', () => {
    it('usage.totalRevenue + totalCost match canon subscriptionId filter', async () => {
      const subscriptions = [
        {
          id: SUB,
          organizationId: ORG,
          customerId: CUSTOMER,
          agentId: AGENT,
          planId: 'plan-1',
          name: 'Sub',
          status: 'active',
          billingCycle: 'monthly',
          customCycleDays: null,
          seatsCount: 0,
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: null,
          currentBillingPeriodStart: new Date(Date.UTC(2026, 3, 1)),
          currentBillingPeriodEnd: new Date(Date.UTC(2026, 3, 30)),
          deletedAt: null,
          customers: {
            id: CUSTOMER,
            name: 'Customer 1',
            externalId: 'ext-customer-1',
          },
          agents: { id: AGENT, name: 'Agent A', agentCode: 'A' },
          pricing_plans: {
            id: 'plan-1',
            name: 'Plan',
            description: 'desc',
            pricing_strategies: [
              {
                id: 'strat-1',
                chargeType: 'usage',
                pricingModel: 'flat',
                rate: new Decimal(2.0),
                tiers: [],
                minimumCommitment: null,
                signalId: SIGNAL,
                active: true,
                deletedAt: null,
                signals: { id: SIGNAL, name: 'Signal 1', shortName: 's1' },
              },
            ],
          },
        },
      ];
      const events = [
        mkSignalEvent({
          usageDate: new Date(Date.UTC(2026, 3, 10)),
          usageCost: 0.1,
          quantity: 25,
          subscriptionId: SUB,
        }),
      ];

      const svc = await buildService(buildMockPrisma({ events, subscriptions }));
      const res = await svc.getSubscriptionAnalytics(ORG, SUB, {
        billingPeriodStart: '2026-04-01',
        billingPeriodEnd: '2026-04-30',
      });

      // Independent recompute: revenue = 25 × 2.0 = 50; cost = 0.1.
      expect(res.usage.totalRevenue).toBeCloseTo(50, 6);
      expect(res.usage.totalCost).toBeCloseTo(0.1, 6);
      expect(res.usage.margin).toBeCloseTo(49.9, 6);
    });
  });

  describe('getRevenueAnalytics. canon invoice totals + MRR trio', () => {
    // Canon I2: the org-wide totalRevenue = billed + collected (non-draft).
    // Draft invoices must not count even though they have a totalAmount.
    it('totalRevenue = billed + collected for non-draft invoices only', async () => {
      const inWindow = new Date(Date.UTC(2026, 3, 10));
      const invoices = [
        mkInvoice({ status: 'issued', totalAmount: 100, invoiceDate: inWindow }),
        mkInvoice({ status: 'paid', totalAmount: 200, invoiceDate: inWindow }),
        mkInvoice({ status: 'overdue', totalAmount: 50, invoiceDate: inWindow }),
        mkInvoice({ status: 'draft', totalAmount: 999, invoiceDate: inWindow }),
      ];

      // Independent recompute: canon I2 Billed = issued + overdue = 150;
      // Collected = 200. totalRevenue = 150 + 200 = 350.
      const expectedBilled = 100 + 50;
      const expectedCollected = 200;

      const svc = await buildService(buildMockPrisma({ invoices }));
      const res = await svc.getRevenueAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });

      expect(res.invoiceTotals.billed).toBeCloseTo(expectedBilled, 6);
      expect(res.invoiceTotals.collected).toBeCloseTo(expectedCollected, 6);
      expect(res.totalRevenue).toBeCloseTo(expectedBilled + expectedCollected, 6);
    });

    // MRR field is populated from the canon trio, not from a hand-rolled
    // calculation.
    it('mrr block carries canonical + runRate + committed numbers', async () => {
      const svc = await buildService(buildMockPrisma({}));
      const res = await svc.getRevenueAnalytics(ORG, {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      });
      // Empty fixture. All MRR variants should resolve to 0, not throw.
      expect(res.mrr.canonical).toBe(0);
      expect(res.mrr.runRate).toBe(0);
      expect(res.mrr.committed).toBe(0);
      expect(res.mrr.arr).toBe(0);
    });
  });
});

// ─── getProfitabilityAnalytics on the canonical revenue and cost reads ───────
//
// getProfitabilityAnalytics makes two canon calls (getAgentEarned + getCostMetrics)
// plus one bounded signals.findMany for display names. calculatedRevenue =
// Agent-Earned (usage-only, tier-correct).
// This fixture has two priced signals (one flat, one graduated) plus one
// orphan event (no matching subscription, null signalId) to prove: (a) graduated
// tiers are priced, not only flat ones, (b) org-wide cost counts orphans while
// revenue attribution can't (no subscription to attribute to), and (c) the
// null-signal bucket surfaces in bySignal.
describe('getProfitabilityAnalytics — canon golden values', () => {
  const SIGNAL_A = 'signal-a-flat';
  const SIGNAL_B = 'signal-b-graduated';
  const SUB_A = 'sub-a';
  const SUB_B = 'sub-b';
  const windowStart = '2026-04-01';
  const windowEnd = '2026-04-30';

  function baseSub(id: string, strategy: Record<string, unknown>) {
    return {
      id,
      organizationId: ORG,
      agentId: AGENT,
      customerId: CUSTOMER,
      customers: { id: CUSTOMER, externalId: 'ext-customer-1' },
      agents: { id: AGENT },
      status: 'active',
      startDate: new Date(Date.UTC(2026, 0, 1)),
      pricing_plans: { pricing_strategies: [strategy] },
    };
  }

  function buildFixture(extraSubs: Array<{ id: string; signalId: string }> = []) {
    const subscriptions = [
      baseSub(SUB_A, {
        id: 'strat-a',
        chargeType: 'usage',
        pricingModel: 'flat',
        rate: new Decimal(2.0),
        tiers: [],
        minimumCommitment: null,
        signalId: SIGNAL_A,
        signals: { id: SIGNAL_A, name: 'Signal A', shortName: 'SA' },
      }),
      baseSub(SUB_B, {
        id: 'strat-b',
        chargeType: 'usage',
        pricingModel: 'graduated',
        rate: null,
        tiers: [
          { lower: 0, upper: 20, rate: 1 },
          { lower: 20, upper: 70, rate: 0.5 },
          { lower: 70, upper: null, rate: 0.25 },
        ],
        minimumCommitment: null,
        signalId: SIGNAL_B,
        signals: { id: SIGNAL_B, name: 'Signal B', shortName: 'SB' },
      }),
      // Extra idle subscriptions (no events) to prove query count doesn't
      // scale with subscription count (query-count discipline, below).
      ...extraSubs.map((s) =>
        baseSub(s.id, {
          id: `strat-${s.id}`,
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: new Decimal(1),
          tiers: [],
          minimumCommitment: null,
          signalId: s.signalId,
          signals: { id: s.signalId, name: s.signalId, shortName: s.signalId },
        }),
      ),
    ];

    const events = [
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 5)),
        usageCost: 1,
        quantity: 10,
        subscriptionId: SUB_A,
        signalId: SIGNAL_A,
      }),
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 10)),
        usageCost: 30,
        quantity: 100,
        subscriptionId: SUB_B,
        signalId: SIGNAL_B,
      }),
      // Orphan: subscriptionId points at nothing in `subscriptions`, and
      // signalId is null outright — canon C1's orphan-events-still-count
      // rule plus the null-signal bucket.
      {
        id: 'evt-orphan',
        organizationId: ORG,
        agentId: AGENT,
        customerId: CUSTOMER,
        customerExternalId: 'ext-customer-1',
        signalId: null,
        subscriptionId: 'sub-does-not-exist',
        usageDate: new Date(Date.UTC(2026, 3, 15)),
        usageCost: new Decimal(5),
        quantity: new Decimal(1),
        signals: null,
        agents: { id: AGENT, name: 'Agent A', agentCode: 'A' },
        customers: { id: CUSTOMER, name: 'Customer 1', externalId: 'ext-customer-1' },
        subscriptions: { planId: null },
        raw_ingest_events: null,
      },
    ];

    const signals = [
      { id: SIGNAL_A, name: 'Signal A', shortName: 'SA' },
      { id: SIGNAL_B, name: 'Signal B', shortName: 'SB' },
      ...extraSubs.map((s) => ({ id: s.signalId, name: s.signalId, shortName: s.signalId })),
    ];

    const mockPrisma = buildMockPrisma({ events, subscriptions, signals });
    return { mockPrisma, events, subscriptions };
  }

  it('structural golden: response keys/types are pinned (dateRange/overall/bySignal)', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    expect(Object.keys(res).sort()).toEqual(['bySignal', 'dateRange', 'overall'].sort());
    expect(Object.keys(res.dateRange).sort()).toEqual(['end', 'start'].sort());
    expect(Object.keys(res.overall).sort()).toEqual(
      [
        'calculatedRevenue',
        'eventCount',
        'profit',
        'profitMargin',
        'totalCost',
        'totalQuantity',
      ].sort(),
    );
    expect(res.bySignal.length).toBeGreaterThan(0);
    for (const row of res.bySignal) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'calculatedRevenue',
          'eventCount',
          'profit',
          'profitMargin',
          'signalId',
          'signalName',
          'signalShortName',
          'totalCost',
          'totalQuantity',
        ].sort(),
      );
      expect(typeof row.totalCost).toBe('number');
      expect(typeof row.calculatedRevenue).toBe('number');
      expect(typeof row.eventCount).toBe('number');
      expect(row.profitMargin === null || typeof row.profitMargin === 'number').toBe(true);
    }
  });

  it('calculatedRevenue is Agent-Earned revenue, independently recomputed', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    // Independent recompute against the SAME mock DB, bypassing the service
    // entirely. A fault in the service's delegation (wrong filters,
    // wrong window) shows up as a diff here even if the service still
    // "looks" reasonable in isolation.
    const independentEarned = await getAgentEarned(
      mockPrisma as any,
      ORG,
      {
        start: new Date(Date.UTC(2026, 3, 1)),
        end: new Date(Date.UTC(2026, 3, 30, 23, 59, 59, 999)),
      },
      {},
    );
    expect(res.overall.calculatedRevenue).toBeCloseTo(independentEarned.revenue, 6);
    // Flat (20) + graduated (52.5) = 72.5; orphan event contributes 0
    // (no subscription to attribute usage to).
    expect(res.overall.calculatedRevenue).toBeCloseTo(72.5, 6);
  });

  it('graduated-pricing signal is priced with tier math, not flat (R1a)', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    const signalB = res.bySignal.find((r) => r.signalId === SIGNAL_B);
    expect(signalB).toBeDefined();
    // Graduated: 20u@$1 + 50u@$0.5 + 30u@$0.25 = 20 + 25 + 7.5 = 52.5.
    // A flat-only pricer would get quantity × tiers[0] rate = 100 × 1 = 100,
    // or quantity × strategy.rate (NaN, rate is null for a graduated
    // strategy). Either way, NOT 52.5.
    expect(signalB!.calculatedRevenue).toBeCloseTo(52.5, 6);
    expect(signalB!.calculatedRevenue).not.toBeCloseTo(100, 1);
  });

  it('profitMargin === safeMarginPercent(calculatedRevenue, profit) at both levels, incl. null at zero revenue', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    expect(res.overall.profitMargin).toBeCloseTo(
      safeMarginPercent(res.overall.calculatedRevenue, res.overall.profit)!,
      6,
    );
    for (const row of res.bySignal) {
      const expected = safeMarginPercent(row.calculatedRevenue, row.profit);
      if (expected === null) {
        expect(row.profitMargin).toBeNull();
      } else {
        expect(row.profitMargin).toBeCloseTo(expected, 6);
      }
    }
    // The orphan/null-signal bucket has calculatedRevenue 0 -> canon M1
    // honest-null, never 0%/NaN%/Infinity%.
    const orphanRow = res.bySignal.find((r) => r.signalId === null);
    expect(orphanRow).toBeDefined();
    expect(orphanRow!.calculatedRevenue).toBe(0);
    expect(orphanRow!.profitMargin).toBeNull();
  });

  it('bySignal is sorted by profit descending', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    const profits = res.bySignal.map((r) => r.profit);
    const sorted = [...profits].sort((a, b) => b - a);
    expect(profits).toEqual(sorted);
    // Concretely: signal B (profit 22.5) > signal A (profit 19) > orphan (profit -5).
    expect(res.bySignal[0].signalId).toBe(SIGNAL_B);
    expect(res.bySignal[1].signalId).toBe(SIGNAL_A);
    expect(res.bySignal[2].signalId).toBeNull();
  });

  it('overall === Σ bySignal for cost, revenue, profit, eventCount, and quantity (by construction)', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    const sum = (
      key: 'totalCost' | 'calculatedRevenue' | 'profit' | 'eventCount' | 'totalQuantity',
    ) => res.bySignal.reduce((s, r) => s + r[key], 0);

    expect(sum('totalCost')).toBeCloseTo(res.overall.totalCost, 6);
    expect(sum('calculatedRevenue')).toBeCloseTo(res.overall.calculatedRevenue, 6);
    expect(sum('profit')).toBeCloseTo(res.overall.profit, 6);
    expect(sum('eventCount')).toBe(res.overall.eventCount);
    expect(sum('totalQuantity')).toBeCloseTo(res.overall.totalQuantity, 6);
  });

  it('org-wide cost/eventCount are canon C1 (orphan events count) — overall.totalCost includes the orphan', async () => {
    const { mockPrisma } = buildFixture();
    const svc = await buildService(mockPrisma);
    const res = await svc.getProfitabilityAnalytics(ORG, {
      startDate: windowStart,
      endDate: windowEnd,
    });

    // 1 (signal A) + 30 (signal B) + 5 (orphan) = 36.
    expect(res.overall.totalCost).toBeCloseTo(36, 6);
    expect(res.overall.eventCount).toBe(3);
  });

  // Query-count discipline: the service composes a small, FIXED number of
  // canon calls, never a per-subscription findMany loop. Proof is that the
  // call count does not grow with subscription count — add idle
  // subscriptions (no events) and the same number of queries fire.
  // (Not literally zero: getAgentEarned/getCostMetrics each internally run
  // one signal_events.findMany. The N+1 this guards against is PER
  // SUBSCRIPTION.)
  describe('query-count discipline (no N+1, O(1) in subscription count)', () => {
    it('signal_events.findMany is called a fixed number of times regardless of subscription count', async () => {
      const small = buildFixture();
      const smallSpy = jest.spyOn(small.mockPrisma.signal_events, 'findMany');
      const svcSmall = await buildService(small.mockPrisma);
      await svcSmall.getProfitabilityAnalytics(ORG, { startDate: windowStart, endDate: windowEnd });
      const smallCallCount = smallSpy.mock.calls.length;

      const large = buildFixture([
        { id: 'sub-idle-1', signalId: 'signal-idle-1' },
        { id: 'sub-idle-2', signalId: 'signal-idle-2' },
        { id: 'sub-idle-3', signalId: 'signal-idle-3' },
        { id: 'sub-idle-4', signalId: 'signal-idle-4' },
      ]);
      const largeSpy = jest.spyOn(large.mockPrisma.signal_events, 'findMany');
      const svcLarge = await buildService(large.mockPrisma);
      await svcLarge.getProfitabilityAnalytics(ORG, { startDate: windowStart, endDate: windowEnd });
      const largeCallCount = largeSpy.mock.calls.length;

      // Exactly 2: one batched findMany inside getAgentEarned's
      // getRevenueMetrics call, one inside getCostMetrics. A per-subscription
      // loop (N+1) would push the count up for the 4 extra idle
      // subscriptions; here it does not.
      expect(smallCallCount).toBe(2);
      expect(largeCallCount).toBe(2);
      expect(largeCallCount).toBe(smallCallCount);
    });

    it('the service never calls signal_events.findMany directly itself (only via canon delegation)', async () => {
      // A direct call inside getProfitabilityAnalytics would show up as a
      // call whose `where` shape doesn't match either canon function's
      // known shape. Simpler and just as load-bearing: confirm the total
      // stays at 2 even with a customer/agent filter applied (a direct
      // ad-hoc query would be a 3rd call with a hand-rolled where clause).
      const { mockPrisma } = buildFixture();
      const spy = jest.spyOn(mockPrisma.signal_events, 'findMany');
      const svc = await buildService(mockPrisma);
      await svc.getProfitabilityAnalytics(ORG, {
        startDate: windowStart,
        endDate: windowEnd,
        customerId: CUSTOMER,
        agentId: AGENT,
      });
      expect(spy.mock.calls.length).toBe(2);
    });
  });
});

// ─── row caps clamp event-derived arrays at 500 ────
describe('getCostAnalytics — row caps clamp top-N-by-cost arrays at ANALYTICS_MAX_ROWS', () => {
  it('serviceBreakdown.summary and every dimension breakdown clamp at 500 rows even with 510 buckets', async () => {
    const ROW_COUNT = 510;
    const events = Array.from({ length: ROW_COUNT }, (_, i) =>
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 1 + (i % 28))),
        // Distinct cost per event so every bucket is distinguishable and
        // none tie for the cutoff rank.
        usageCost: 1 + i * 0.01,
        quantity: 1,
        signalId: `signal-${i}`,
        agentId: `agent-${i}`,
        customerId: `cust-${i}`,
        customerExternalId: `ext-${i}`,
      }),
    );

    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getCostAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-28',
      includeServiceBreakdown: true,
    } as any);

    expect(res.serviceBreakdown.summary.length).toBe(500);
    expect(res.dimensions.signal.summary.length).toBe(500);
    expect(res.dimensions.agent.summary.length).toBe(500);
    expect(res.dimensions.customer.summary.length).toBe(500);
  });
});
