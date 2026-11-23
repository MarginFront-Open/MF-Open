/**
 * The code-cost-clarity armed-status stamp rides the existing metadata
 * pass-through, with no dedicated ingest field.
 *
 * The device reports "this dev is armed with a cap" by putting a stamp on the
 * usage event's `metadata`, which sdk.service already whitelists into the
 * raw_ingest_events payload (sdk.service.ts STEP 1, the `metadata: record.metadata
 * || {}` line). This test drives recordUsage and asserts the stamp lands verbatim
 * — proving the stamp is accepted without touching the never-block ingest path.
 * If someone dropped `metadata` from that whitelist, this goes red.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SdkService } from './sdk.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import { ModelPricingService } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';

async function buildService(mockPrisma: any): Promise<SdkService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SdkService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: CapAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CreditLedgerService, useValue: { consumeForEvent: jest.fn() } },
      { provide: PoolAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: CustomerAlertTriggerService, useValue: { maybeTrigger: jest.fn() } },
      { provide: ModelPricingService, useValue: {} },
      { provide: RevenueMetricsService, useValue: {} },
    ],
  }).compile();
  return module.get<SdkService>(SdkService);
}

describe('armed-status metadata pass-through', () => {
  it('carries the CCC armed stamp verbatim into the raw ingest payload', async () => {
    const created: any[] = [];
    const mockPrisma = {
      // RecordUsage loads matter attribution context per batch,
      // BEFORE the per-record loop this spec short-circuits.
      matters: { findMany: () => Promise.resolve([]) },
      matter_routing_rules: { findMany: () => Promise.resolve([]) },
      raw_ingest_events: {
        create: ({ data }: any) => {
          created.push(data);
          return Promise.resolve({ id: 'raw-1' });
        },
        // The catch handler flips the row to ERROR after we short-circuit below.
        update: () => Promise.resolve({}),
      },
      // Throw right after the raw event is captured so we don't have to mock the
      // whole downstream pricing/signal pipeline — the stamp is already recorded.
      customers: {
        findFirst: () => {
          throw new Error('short-circuit after raw capture');
        },
      },
    };

    const svc = await buildService(mockPrisma);

    const armedStamp = { control: { capArmed: true, mode: 'enforce', policyVersion: 3 } };
    await svc.recordUsage(ORG, {
      records: [
        {
          customerExternalId: 'dev@co.example',
          agentCode: 'claude-code',
          signalName: 'tokens',
          model: 'claude-opus-4-8',
          modelProvider: 'anthropic',
          inputTokens: 100,
          outputTokens: 50,
          metadata: armedStamp,
        },
      ],
    } as any);

    expect(created).toHaveLength(1);
    expect(created[0].payload.metadata).toEqual(armedStamp);
  });
});
