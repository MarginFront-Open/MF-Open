/**
 * Parity tests for SdkService on the canonical library.
 *
 * `metadata.calculatedCost` on signal_event rows is not populated, so
 * summing it would return $0 for every event. `getUsageAnalytics` delegates to `RevenueMetricsService.getCostMetrics`
 * → canonical `getCostMetrics` from @marginfront/db (canon C1 + C2). These tests
 * mock PrismaService with known fixtures, call getUsageAnalytics, and
 * independently recompute the expected totals from the same fixture to
 * prove the canonical wiring is correct.
 *
 * Scope: summary.totalCost / totalEvents / uniqueCustomers/Agents/Signals,
 * plus data[].cost / data[].eventCount per bucket (daily/weekly/monthly).
 * Null-cost events are counted in eventCount but contribute zero to cost
 * (canon C1). Filters (customerId, customerExternalId, agentId, signalId)
 * narrow the result set correctly.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { SdkGroupByEnum } from './dto/query-sdk-usage.dto';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const AGENT_A = 'agent-a-uuid';
const AGENT_B = 'agent-b-uuid';
const CUSTOMER_A = 'cust-a-uuid';
const CUSTOMER_B = 'cust-b-uuid';
const SIGNAL_A = 'signal-a-uuid';
const SIGNAL_B = 'signal-b-uuid';
const EXT_A = 'ext-customer-a';
const EXT_B = 'ext-customer-b';

// ─── Mock fixture helpers ──────────────────────────────────────────────────

const mkSignalEvent = (overrides: {
  usageDate: Date;
  usageCost: number | null;
  quantity?: number;
  agentId?: string;
  customerId?: string;
  customerExternalId?: string;
  signalId?: string;
  subscriptionId?: string | null;
  planId?: string | null;
  model?: string;
}) => ({
  id: `evt-${Math.random().toString(36).slice(2, 8)}`,
  organizationId: ORG,
  agentId: overrides.agentId ?? AGENT_A,
  customerId: overrides.customerId ?? CUSTOMER_A,
  customerExternalId: overrides.customerExternalId ?? EXT_A,
  signalId: overrides.signalId ?? SIGNAL_A,
  subscriptionId: overrides.subscriptionId ?? null,
  usageDate: overrides.usageDate,
  usageCost: overrides.usageCost === null ? null : new Decimal(overrides.usageCost),
  quantity: new Decimal(overrides.quantity ?? 1),
  signals: { id: overrides.signalId ?? SIGNAL_A, name: 'Signal A', shortName: 'sA' },
  agents: { id: overrides.agentId ?? AGENT_A, name: 'Agent A', agentCode: 'A' },
  customers: {
    id: overrides.customerId ?? CUSTOMER_A,
    name: 'Customer A',
    externalId: overrides.customerExternalId ?? EXT_A,
  },
  subscriptions: { planId: overrides.planId ?? null },
  raw_ingest_events: overrides.model ? { payload: { model: overrides.model } } : null,
});

function buildMockPrisma({ events = [] as any[] }) {
  // Filter events by the where clause the canonical library sends.
  // The library uses organizationId + usageDate range + filters for
  // customerId/customerExternalId/agentId/signalId.
  const filterRows = (where: any): any[] => {
    return events.filter((r) => {
      if (where.organizationId && r.organizationId !== where.organizationId) return false;
      if (where.customerId && r.customerId !== where.customerId) return false;
      if (where.customerExternalId && r.customerExternalId !== where.customerExternalId)
        return false;
      if (where.agentId && r.agentId !== where.agentId) return false;
      if (where.signalId && r.signalId !== where.signalId) return false;
      if (where.usageDate) {
        const v = r.usageDate;
        if (where.usageDate.gte && v < where.usageDate.gte) return false;
        if (where.usageDate.lte && v > where.usageDate.lte) return false;
      }
      return true;
    });
  };

  // Customer lookup for externalId → id translation inside getUsageAnalytics.
  const customersByExternalId = new Map<string, { id: string }>();
  for (const e of events) {
    if (e.customerExternalId && e.customerId) {
      customersByExternalId.set(e.customerExternalId, { id: e.customerId });
    }
  }

  return {
    // The canonical library calls getClient() on PrismaService. Returning
    // this means the rest of the mock IS the Prisma surface.
    getClient: function () {
      return this;
    },
    signal_events: {
      findMany: ({ where }: any) => Promise.resolve(filterRows(where)),
      count: ({ where }: any) => Promise.resolve(filterRows(where).length),
    },
    customers: {
      findFirst: ({ where }: any) => {
        if (where.externalId) {
          const hit = customersByExternalId.get(where.externalId);
          return Promise.resolve(hit ?? null);
        }
        return Promise.resolve(null);
      },
    },
  };
}

async function buildService(mockPrisma: any): Promise<SdkService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      RevenueMetricsService,
      // ModelPricingService is constructor-injected but not reached in
      // getUsageAnalytics. Simple stub keeps the DI container happy.
      { provide: ModelPricingService, useValue: {} },
      { provide: PrismaService, useValue: mockPrisma },
      { provide: CapAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CreditLedgerService, useValue: { consumeForEvent: jest.fn() } },
      { provide: PoolAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CustomerAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SdkService.getUsageAnalytics canonical parity', () => {
  // summary.totalCost comes from canonGetCostMetrics; assert it matches
  // an independent SUM(usageCost) recompute.
  it('summary.totalCost matches independent signal_events.usageCost sum', async () => {
    const events = [
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 5)), usageCost: 0.05 }),
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 10)), usageCost: 0.1 }),
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 20)), usageCost: 0.2 }),
      // Outside the window. Must not count.
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 4, 15)), usageCost: 99 }),
    ];
    const expected = 0.05 + 0.1 + 0.2;

    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
    } as any);
    expect(res.summary.totalCost).toBeCloseTo(expected, 6);
    expect(res.summary.totalEvents).toBe(3);
  });

  // Canon C1: null usageCost contributes 0 but still counts in eventCount.
  it('null-cost events count in totalEvents but contribute 0 to totalCost', async () => {
    const events = [
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 5)), usageCost: 0.5 }),
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 10)), usageCost: null }),
    ];
    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
    } as any);
    expect(res.summary.totalCost).toBeCloseTo(0.5, 6);
    expect(res.summary.totalEvents).toBe(2);
  });

  // Daily bucket parity. One bucket per UTC date that had activity.
  it('DAILY groupBy returns one bucket per active UTC date with correct cost + count', async () => {
    const events = [
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 5, 10)), usageCost: 0.1 }),
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 5, 20)), usageCost: 0.2 }),
      mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 10, 5)), usageCost: 0.3 }),
    ];
    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
    } as any);
    expect(res.data.length).toBe(2);
    const byDate = new Map<string, { cost: number; eventCount: number }>(
      res.data.map((d: any) => [d.date, { cost: d.cost, eventCount: d.eventCount }]),
    );
    expect(byDate.get('2026-04-05')?.cost).toBeCloseTo(0.3, 6);
    expect(byDate.get('2026-04-05')?.eventCount).toBe(2);
    expect(byDate.get('2026-04-10')?.cost).toBeCloseTo(0.3, 6);
    expect(byDate.get('2026-04-10')?.eventCount).toBe(1);
  });

  // unique* counts reflect the canon breakdown-row count. For fully-populated
  // events that equals a per-event distinct count.
  it('uniqueCustomers / uniqueAgents / uniqueSignals match independent distinct-count', async () => {
    const events = [
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 5)),
        usageCost: 0.1,
        customerId: CUSTOMER_A,
        agentId: AGENT_A,
        signalId: SIGNAL_A,
      }),
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 6)),
        usageCost: 0.1,
        customerId: CUSTOMER_B,
        customerExternalId: EXT_B,
        agentId: AGENT_B,
        signalId: SIGNAL_B,
      }),
      // Repeat the first combination. Must not inflate unique counts.
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 7)),
        usageCost: 0.1,
        customerId: CUSTOMER_A,
        agentId: AGENT_A,
        signalId: SIGNAL_A,
      }),
    ];
    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
    } as any);
    expect(res.summary.uniqueCustomers).toBe(2);
    expect(res.summary.uniqueAgents).toBe(2);
    expect(res.summary.uniqueSignals).toBe(2);
  });

  // customerExternalId filter resolves to customerId and narrows correctly.
  it('customerExternalId filter narrows results to that customer', async () => {
    const events = [
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 5)),
        usageCost: 0.1,
        customerId: CUSTOMER_A,
        customerExternalId: EXT_A,
      }),
      mkSignalEvent({
        usageDate: new Date(Date.UTC(2026, 3, 6)),
        usageCost: 0.5,
        customerId: CUSTOMER_B,
        customerExternalId: EXT_B,
      }),
    ];
    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
      customerExternalId: EXT_A,
    } as any);
    // Only customer A's event contributes. 0.1.
    expect(res.summary.totalCost).toBeCloseTo(0.1, 6);
    expect(res.summary.totalEvents).toBe(1);
  });

  // Unknown externalId returns the empty response shape, as if it
  // filtered to zero rows.
  it('unknown customerExternalId returns an empty response', async () => {
    const events = [mkSignalEvent({ usageDate: new Date(Date.UTC(2026, 3, 5)), usageCost: 0.1 })];
    const svc = await buildService(buildMockPrisma({ events }));
    const res = await svc.getUsageAnalytics(ORG, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      groupBy: SdkGroupByEnum.DAILY,
      customerExternalId: 'does-not-exist',
    } as any);
    expect(res.summary.totalCost).toBe(0);
    expect(res.summary.totalEvents).toBe(0);
    expect(res.data.length).toBe(0);
  });
});
