/**
 * Auto-internal customers. A customer that recordUsage auto-provisions on a
 * coding-agent event (agentCode in CCC_AGENT_CODES) is one of the org's own
 * teammates, not a billable customer, so it must be born isInternal=true. A
 * customer auto-provisioned on any OTHER agent's event stays external, and the
 * explicit createCustomer endpoint (a seller declaring a real customer) is
 * never touched by this rule.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { resolveEventPrice } from '@marginfront/db';
import { Decimal } from '@prisma/client/runtime/library';

// @vercel/functions (a dep of cap-alert-trigger, a transitive import of
// sdk.service) may be missing from a partial install. The real service is
// DI-stubbed here, so this virtual mock only unblocks module load.
jest.mock('@vercel/functions', () => ({ waitUntil: (p: unknown) => p }), { virtual: true });

import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const AGENT_ID = 'agent-uuid';
const SIGNAL_ID = 'signal-uuid';

function buildMocks() {
  const customerCreate = jest.fn();

  const prisma: any = {
    raw_ingest_events: {
      create: () => Promise.resolve({ id: 'raw-1' }),
      update: () => Promise.resolve({}),
    },
    customers: {
      // null forces the auto-provision branch every time.
      findFirst: () => Promise.resolve(null),
      // No soft-deleted row to resurrect — straight to create.
      updateMany: () => Promise.resolve({ count: 0 }),
      create: (args: any) => {
        customerCreate(args);
        return Promise.resolve({ id: 'cust-created', ...args.data });
      },
    },
    agents: {
      findFirst: () => Promise.resolve({ id: AGENT_ID, agentCode: 'agent-code-1', orgId: ORG }),
      create: () => Promise.resolve({ id: AGENT_ID }),
    },
    signals: {
      upsert: () => Promise.resolve({ id: SIGNAL_ID, name: 'sig-1', orgId: ORG }),
    },
    subscriptions: {
      findFirst: () => Promise.resolve(null),
      create: (args: any) => Promise.resolve(args.data),
    },
    pricing_plans: { findFirst: () => Promise.resolve(null) },
    signal_events: { create: (args: any) => Promise.resolve(args.data) },
    signal_event_services: { create: (args: any) => Promise.resolve(args.data) },
    signal_services: { upsert: () => Promise.resolve({}) },
    // RecordUsage loads matter attribution context per batch.
    matters: { findMany: () => Promise.resolve([]) },
    matter_routing_rules: { findMany: () => Promise.resolve([]) },
    $transaction: (cb: any) => cb(prisma),
  };

  const modelPricing: any = {
    lookupModel: () =>
      Promise.resolve({
        servicePricingId: 'pricing-claude-uuid',
        costUnit: '1M tokens',
        cacheReadCost: 0.3,
        cacheWriteCost: 3.75,
      }),
    calculateCost: () =>
      Promise.resolve({
        totalCostUsd: new Decimal('2'),
        inputCostUsd: new Decimal('1'),
        outputCostUsd: new Decimal('1'),
        inputCostPerToken: 0.001,
        outputCostPerToken: 0.002,
        cacheReadCostUsd: new Decimal(0),
        cacheWriteCostUsd: new Decimal(0),
        cacheReadCostPerToken: 0,
        cacheWriteCostPerToken: 0,
      }),
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

  return { prisma, modelPricing, customerCreate };
}

async function buildService(prisma: any, modelPricing: any): Promise<SdkService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      RevenueMetricsService,
      { provide: ModelPricingService, useValue: modelPricing },
      { provide: PrismaService, useValue: prisma },
      { provide: CapAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CreditLedgerService, useValue: { consumeForEvent: jest.fn() } },
      { provide: PoolAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CustomerAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

const baseRecord = {
  customerExternalId: 'teammate@acmedev.example',
  signalName: 'sig-1',
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

describe('SdkService.recordUsage — auto-internal customer classification', () => {
  it('a claude-code event auto-provisions the customer as isInternal=true', async () => {
    const { prisma, modelPricing, customerCreate } = buildMocks();
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, agentCode: 'claude-code' }],
    } as any);

    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(customerCreate.mock.calls[0][0].data.isInternal).toBe(true);
  });

  it('a codex event auto-provisions the customer as isInternal=true', async () => {
    const { prisma, modelPricing, customerCreate } = buildMocks();
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, agentCode: 'codex' }],
    } as any);

    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(customerCreate.mock.calls[0][0].data.isInternal).toBe(true);
  });

  it('a non-coding-agent event auto-provisions the customer as isInternal=false', async () => {
    const { prisma, modelPricing, customerCreate } = buildMocks();
    const svc = await buildService(prisma, modelPricing);

    await svc.recordUsage(ORG, {
      records: [{ ...baseRecord, agentCode: 'my-support-bot' }],
    } as any);

    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(customerCreate.mock.calls[0][0].data.isInternal).toBe(false);
  });

  it('the explicit createCustomer endpoint never sets isInternal', async () => {
    const { prisma, modelPricing, customerCreate } = buildMocks();
    const svc = await buildService(prisma, modelPricing);

    await svc.createCustomer(ORG, { name: 'Acme Corp', externalId: 'acme' } as any);

    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(customerCreate.mock.calls[0][0].data.isInternal).toBeUndefined();
  });
});
