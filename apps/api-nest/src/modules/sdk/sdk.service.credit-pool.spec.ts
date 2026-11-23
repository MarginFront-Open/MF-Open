/**
 * WHAT THIS FILE DOES: pins the credit-pool consume seam in
 * SdkService.recordUsage (STEP 11.5) — the draw happens AFTER event storage,
 * BEFORE the cap-alert trigger, for EVERY stored event, and a draw failure
 * can never block the event (a billing-feature bug must never cost a
 * customer their usage data).
 *
 * The parity pin worth naming: the draw fires for stored-but-failed events
 * (NEEDS_COST_BACKFILL etc.) too, because the invoice selection
 * (in InvoiceCalculatorService) has no status filter — those
 * events still bill their quantity, so the pool must draw the same units.
 *
 * Mocked Prisma + mocked ModelPricingService, same harness shape as
 * sdk.service.dedup.spec.ts. What these prove: the seam's call shape, order,
 * and non-fatality against a mocked CreditLedgerService. What they don't:
 * real ledger writes (packages/db credit-ledger.test.ts) or end-to-end
 * behavior against a live database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { resolveEventPrice } from '@marginfront/db';
import { Decimal } from '@prisma/client/runtime/library';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-a-uuid';
const CUSTOMER_ID = 'cust-uuid';
const AGENT_ID = 'agent-uuid';
const SIGNAL_ID = 'signal-uuid';
const SUB_ROW = {
  id: 'sub-uuid',
  organizationId: ORG,
  planId: 'plan-uuid',
  currentBillingPeriodStart: new Date('2026-06-15T00:00:00.000Z'),
  currentBillingPeriodEnd: new Date('2026-07-15T00:00:00.000Z'),
};

function buildMocks(opts: { subscription?: any; unknownModel?: boolean } = {}) {
  const signalEventsCreate = jest.fn();
  const prisma: any = {
    raw_ingest_events: {
      create: () => Promise.resolve({ id: 'raw-' + Math.random().toString(36).slice(2, 8) }),
      update: () => Promise.resolve({}),
    },
    customers: {
      findFirst: () =>
        Promise.resolve({ id: CUSTOMER_ID, externalId: 'cust-ext-1', organizationId: ORG }),
      create: () => Promise.resolve({ id: CUSTOMER_ID }),
    },
    agents: {
      findFirst: () => Promise.resolve({ id: AGENT_ID, agentCode: 'agent-code-1', orgId: ORG }),
      create: () => Promise.resolve({ id: AGENT_ID }),
    },
    signals: {
      upsert: () => Promise.resolve({ id: SIGNAL_ID, name: 'sig-1', orgId: ORG }),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(opts.subscription ?? null),
    },
    signal_events: {
      findFirst: () => Promise.resolve(null),
      create: (args: any) => {
        signalEventsCreate(args);
        return Promise.resolve(args.data);
      },
    },
    signal_event_services: {
      create: (args: any) => Promise.resolve(args.data),
    },
    signal_services: {
      upsert: () => Promise.resolve({}),
    },
    // RecordUsage loads matter attribution context per batch.
    matters: { findMany: () => Promise.resolve([]) },
    matter_routing_rules: { findMany: () => Promise.resolve([]) },
    $transaction: (cb: any) => cb(prisma),
  };

  const modelPricing: any = {
    lookupModel: () =>
      opts.unknownModel
        ? Promise.resolve(null)
        : Promise.resolve({
            servicePricingId: 'pricing-claude-uuid',
            costUnit: '1M tokens',
            cacheReadCost: undefined,
            cacheWriteCost: undefined,
          }),
    calculateCost: (_model: string, inputTokens: number, outputTokens: number) => {
      const inputCost = new Decimal(inputTokens).mul('0.001');
      const outputCost = new Decimal(outputTokens).mul('0.002');
      return Promise.resolve({
        totalCostUsd: inputCost.add(outputCost),
        inputCostUsd: inputCost,
        outputCostUsd: outputCost,
        inputCostPerToken: 0.001,
        outputCostPerToken: 0.002,
        cacheReadCostUsd: new Decimal(0),
        cacheWriteCostUsd: new Decimal(0),
        cacheReadCostPerToken: 0,
        cacheWriteCostPerToken: 0,
      });
    },
  };

  // sdk.service prices through resolveCost. The refuse/allow verdict
  // comes from the REAL canonical guard — stubbing it would make every
  // missing-cache-rate assertion in these specs test the stub instead of the
  // rule. Only the arithmetic stays mocked, via this mock's own calculateCost,
  // so each spec keeps its cost behaviour and its call recording.
  (modelPricing as any).resolveCost = async (
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    quantity: number,
    provider: string,
    preFetchedEntry?: any,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    cacheWriteTtl?: unknown,
  ) => {
    const entry = preFetchedEntry ?? (await (modelPricing as any).lookupModel(modelId, provider));
    const verdict = resolveEventPrice({
      inputTokens,
      outputTokens,
      quantity,
      // These mocks' lookupModel returns only a subset of fields, so
      // inputCost/outputCost are often absent. The refusal verdict depends only
      // on the CACHE rates and the token counts, so defaulting the token rates
      // to 0 keeps the verdict exact while giving the real math valid operands.
      entry: { inputCost: 0, outputCost: 0, ...entry },
      cacheReadTokens,
      cacheWriteTokens,
      provider,
      cacheWriteTtl,
      model: modelId,
    });
    if (!verdict.ok) return { ...verdict, modelKey: modelId };
    const cost = await (modelPricing as any).calculateCost(
      modelId,
      inputTokens,
      outputTokens,
      quantity,
      provider,
      entry,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteTtl,
    );
    return { ok: true, cost };
  };

  return { prisma, modelPricing, signalEventsCreate };
}

const capAlertTriggerMock = { maybeTrigger: jest.fn() };
const creditLedgerMock = { consumeForEvent: jest.fn() };
const poolAlertTriggerMock = { maybeTrigger: jest.fn() };
const customerAlertTriggerMock = { maybeTrigger: jest.fn() };

async function buildService(prisma: any, modelPricing: any): Promise<SdkService> {
  capAlertTriggerMock.maybeTrigger.mockClear();
  poolAlertTriggerMock.maybeTrigger.mockClear();
  creditLedgerMock.consumeForEvent.mockReset();
  creditLedgerMock.consumeForEvent.mockResolvedValue(undefined);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      RevenueMetricsService,
      { provide: ModelPricingService, useValue: modelPricing },
      { provide: PrismaService, useValue: prisma },
      { provide: CapAlertTriggerService, useValue: capAlertTriggerMock },
      { provide: CreditLedgerService, useValue: creditLedgerMock },
      { provide: PoolAlertTriggerService, useValue: poolAlertTriggerMock },
      { provide: CustomerAlertTriggerService, useValue: customerAlertTriggerMock },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

const baseRecord = {
  customerExternalId: 'cust-ext-1',
  agentCode: 'agent-code-1',
  signalName: 'sig-1',
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

describe('recordUsage credit-pool seam — draw after storage', () => {
  it('calls consumeForEvent with the stored event id, billable quantity, usageDate, and the already-resolved subscription', async () => {
    const { prisma, modelPricing, signalEventsCreate } = buildMocks({
      subscription: SUB_ROW,
    });
    const svc = await buildService(prisma, modelPricing);

    const usageDate = '2026-06-20T12:00:00.000Z';
    const result = await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, quantity: 7, usageDate }],
    } as any);

    expect(result.processed).toBe(1);
    expect(creditLedgerMock.consumeForEvent).toHaveBeenCalledTimes(1);
    const arg = creditLedgerMock.consumeForEvent.mock.calls[0][0];
    expect(arg.subscription).toBe(SUB_ROW);
    expect(arg.signalId).toBe(SIGNAL_ID);
    expect(arg.quantity).toBe(7);
    expect(arg.usageDate).toEqual(new Date(usageDate));
    // The draw traces to the event that was ACTUALLY stored.
    const storedEventId = signalEventsCreate.mock.calls[0][0].data.id;
    expect(arg.signalEventId).toBe(storedEventId);
  });

  it('defaults the draw quantity to 1 when the record carries none (the billable default)', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: SUB_ROW });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(creditLedgerMock.consumeForEvent.mock.calls[0][0].quantity).toBe(1);
  });

  it('draws BEFORE the cap-alert trigger fires (decrement precedes maybeTrigger)', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: SUB_ROW });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(creditLedgerMock.consumeForEvent).toHaveBeenCalledTimes(1);
    expect(capAlertTriggerMock.maybeTrigger).toHaveBeenCalledTimes(1);
    const consumeOrder = creditLedgerMock.consumeForEvent.mock.invocationCallOrder[0];
    const triggerOrder = capAlertTriggerMock.maybeTrigger.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeLessThan(triggerOrder);
  });

  it('a consumeForEvent rejection NEVER blocks the event — success response, event stored', async () => {
    const { prisma, modelPricing, signalEventsCreate } = buildMocks({
      subscription: SUB_ROW,
    });
    const svc = await buildService(prisma, modelPricing);
    creditLedgerMock.consumeForEvent.mockRejectedValue(new Error('ledger down'));

    const result = await svc.recordUsage(ORG, {
      records: [{ ...baseRecord }],
    } as any);

    expect(signalEventsCreate).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results.success).toHaveLength(1);
  });

  it('no subscription resolved -> the seam still hands off (the zero-query fast path lives in CreditLedgerService)', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: null });
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(creditLedgerMock.consumeForEvent).toHaveBeenCalledTimes(1);
    expect(creditLedgerMock.consumeForEvent.mock.calls[0][0].subscription).toBeNull();
  });

  it('a credit-pool draw pokes the pool-alert trigger with the resolved membership, AFTER the decrement', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: SUB_ROW });
    const svc = await buildService(prisma, modelPricing);
    creditLedgerMock.consumeForEvent.mockResolvedValue({ creditPool: true });

    await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(poolAlertTriggerMock.maybeTrigger).toHaveBeenCalledTimes(1);
    expect(poolAlertTriggerMock.maybeTrigger).toHaveBeenCalledWith(SUB_ROW.id, true);
    const consumeOrder = creditLedgerMock.consumeForEvent.mock.invocationCallOrder[0];
    const triggerOrder = poolAlertTriggerMock.maybeTrigger.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeLessThan(triggerOrder);
  });

  it('a non-credit-pool draw hands the trigger `false` — the fast path, zero added queries', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: SUB_ROW });
    const svc = await buildService(prisma, modelPricing);
    creditLedgerMock.consumeForEvent.mockResolvedValue({ creditPool: false });

    await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(poolAlertTriggerMock.maybeTrigger).toHaveBeenCalledWith(SUB_ROW.id, false);
  });

  it('a shapeless seam response (mock legacy undefined) still reads as non-pool, never a crash', async () => {
    const { prisma, modelPricing } = buildMocks({ subscription: null });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, { records: [{ ...baseRecord }] } as any);

    expect(result.processed).toBe(1);
    expect(poolAlertTriggerMock.maybeTrigger).toHaveBeenCalledWith(null, false);
  });

  it('PARITY PIN: a stored-but-failed event (NEEDS_COST_BACKFILL) still draws — the invoice selection has no status filter', async () => {
    const { prisma, modelPricing, signalEventsCreate } = buildMocks({
      subscription: SUB_ROW,
      unknownModel: true,
    });
    const svc = await buildService(prisma, modelPricing);

    const result = await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, quantity: 3 }],
    } as any);

    // Stored (stored:true in the failed bucket), not dropped…
    expect(signalEventsCreate).toHaveBeenCalledTimes(1);
    expect(result.results.failed[0].code).toBe('NEEDS_COST_BACKFILL');
    expect(result.results.failed[0].stored).toBe(true);
    // …and the pool drew the same 3 units the invoice will bill.
    expect(creditLedgerMock.consumeForEvent).toHaveBeenCalledTimes(1);
    expect(creditLedgerMock.consumeForEvent.mock.calls[0][0].quantity).toBe(3);
  });
});
