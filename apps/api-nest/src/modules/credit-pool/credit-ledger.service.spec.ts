/**
 * WHAT THIS FILE DOES: pins CreditLedgerService's hot-path cost discipline
 * and non-fatality. The ingest path calls consumeForEvent for
 * EVERY stored event, so what it costs non-credit-pool traffic is a product
 * number, not an implementation detail:
 *   - no subscription (every code-cost-clarity event): ZERO queries;
 *   - subscription without a billing period: ZERO queries;
 *   - subscription with a period: exactly ONE strategy lookup decides
 *     membership — non-pool subs stop there;
 *   - only real credit-pool events reach the ledger transaction.
 * And: consumeForEvent NEVER throws — the event is already stored. Its
 * return value is the membership signal the pool-alert trigger reuses
 *CreditPool true only on the real credit-pool path.
 *
 * The @marginfront/db lib functions are jest-mocked here; their real behavior is
 * proven in packages/db/src/lib/credit-ledger.test.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { consumeUnits, findCreditPoolStrategy } from '@marginfront/db';
import { CreditLedgerService } from './credit-ledger.service';
import { PrismaService } from '../../common/prisma/prisma.service';

jest.mock('@marginfront/db', () => ({
  ...jest.requireActual('@marginfront/db'),
  consumeUnits: jest.fn(),
  findCreditPoolStrategy: jest.fn(),
}));

const consumeUnitsMock = consumeUnits as jest.Mock;
const findStrategyMock = findCreditPoolStrategy as jest.Mock;

const SUB_ROW = {
  id: 'sub-uuid',
  organizationId: 'org-uuid',
  planId: 'plan-uuid',
  currentBillingPeriodStart: new Date('2026-06-15T00:00:00.000Z'),
  currentBillingPeriodEnd: new Date('2026-07-15T00:00:00.000Z'),
};

const STRATEGY_ROW = {
  id: 'strat-uuid',
  signalId: 'signal-uuid',
  tiers: [
    { lower: 0, upper: 1000, rate: 99 },
    { lower: 1000, upper: null, rate: 0.03 },
  ],
};

const baseInput = {
  signalId: 'signal-uuid',
  signalEventId: 'evt-uuid',
  quantity: 5,
  usageDate: new Date('2026-06-20T00:00:00.000Z'),
};

async function buildService(): Promise<{ svc: CreditLedgerService; prisma: any }> {
  const prisma = { marker: 'prisma-service' };
  const module: TestingModule = await Test.createTestingModule({
    providers: [CreditLedgerService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { svc: module.get(CreditLedgerService), prisma };
}

beforeEach(() => {
  consumeUnitsMock.mockReset();
  findStrategyMock.mockReset();
});

describe('CreditLedgerService.consumeForEvent — fast-path cost discipline', () => {
  it('no subscription -> returns creditPool:false with ZERO queries', async () => {
    const { svc } = await buildService();
    const result = await svc.consumeForEvent({ ...baseInput, subscription: null });
    expect(result).toEqual({ creditPool: false });
    expect(findStrategyMock).not.toHaveBeenCalled();
    expect(consumeUnitsMock).not.toHaveBeenCalled();
  });

  it('subscription without a billing period -> ZERO queries (noActivePeriod state)', async () => {
    const { svc } = await buildService();
    await svc.consumeForEvent({
      ...baseInput,
      subscription: {
        ...SUB_ROW,
        currentBillingPeriodStart: null,
        currentBillingPeriodEnd: null,
      },
    });
    expect(findStrategyMock).not.toHaveBeenCalled();
    expect(consumeUnitsMock).not.toHaveBeenCalled();
  });

  it('non-credit-pool subscription -> exactly ONE strategy lookup, no ledger transaction, creditPool:false', async () => {
    const { svc, prisma } = await buildService();
    findStrategyMock.mockResolvedValue(null);

    const result = await svc.consumeForEvent({ ...baseInput, subscription: SUB_ROW });

    expect(result).toEqual({ creditPool: false });
    expect(findStrategyMock).toHaveBeenCalledTimes(1);
    expect(findStrategyMock).toHaveBeenCalledWith(prisma, SUB_ROW.planId, baseInput.signalId);
    expect(consumeUnitsMock).not.toHaveBeenCalled();
  });

  it('credit-pool subscription -> consumeUnits gets the PRELOADED sub + strategy (no re-reads inside the lib)', async () => {
    const { svc, prisma } = await buildService();
    findStrategyMock.mockResolvedValue(STRATEGY_ROW);
    consumeUnitsMock.mockResolvedValue({
      consumed: true,
      balanceAfterUnits: 995,
      entryCount: 1,
      lazyMinted: false,
    });

    const result = await svc.consumeForEvent({ ...baseInput, subscription: SUB_ROW });

    // The membership signal the pool-alert trigger keys off.
    expect(result).toEqual({ creditPool: true });
    expect(consumeUnitsMock).toHaveBeenCalledTimes(1);
    expect(consumeUnitsMock).toHaveBeenCalledWith(prisma, {
      subscriptionId: SUB_ROW.id,
      signalEventId: baseInput.signalEventId,
      signalId: baseInput.signalId,
      quantity: 5,
      // A strategy with no creditRates draws its own signal at exactly
      // rate 1, quantity untouched.
      rate: 1,
      usageDate: baseInput.usageDate,
      subscription: SUB_ROW,
      strategy: STRATEGY_ROW,
    });
  });

  it('member signal (a creditRates key) -> consumeUnits gets that rate', async () => {
    const { svc } = await buildService();
    const ratedStrategy = {
      ...STRATEGY_ROW,
      creditRates: { 'member-signal-uuid': 4 },
    };
    findStrategyMock.mockResolvedValue(ratedStrategy);
    consumeUnitsMock.mockResolvedValue({
      consumed: true,
      balanceAfterUnits: 980,
      entryCount: 1,
      lazyMinted: false,
    });

    const result = await svc.consumeForEvent({
      ...baseInput,
      signalId: 'member-signal-uuid',
      subscription: SUB_ROW,
    });

    expect(result).toEqual({ creditPool: true });
    expect(consumeUnitsMock.mock.calls[0][1]).toMatchObject({
      signalId: 'member-signal-uuid',
      quantity: 5,
      rate: 4,
    });
  });

  it('belt: strategy resolved but signal not a member -> creditPool:false, no ledger call', async () => {
    const { svc } = await buildService();
    // Only reachable if the row changed between lookup and rate resolution —
    // the seam must treat it as the ordinary miss, not draw at rate 1.
    findStrategyMock.mockResolvedValue(STRATEGY_ROW);

    const result = await svc.consumeForEvent({
      ...baseInput,
      signalId: 'not-a-member-uuid',
      subscription: SUB_ROW,
    });

    expect(result).toEqual({ creditPool: false });
    expect(consumeUnitsMock).not.toHaveBeenCalled();
  });

  it('coerces Decimal-ish quantities via toNumber (units, never a stringified Decimal)', async () => {
    const { svc } = await buildService();
    findStrategyMock.mockResolvedValue(STRATEGY_ROW);
    consumeUnitsMock.mockResolvedValue({
      consumed: true,
      balanceAfterUnits: 0,
      entryCount: 1,
      lazyMinted: false,
    });

    await svc.consumeForEvent({
      ...baseInput,
      quantity: { toNumber: () => 2.5 },
      subscription: SUB_ROW,
    });

    expect(consumeUnitsMock.mock.calls[0][1].quantity).toBe(2.5);
  });

  it('NEVER throws: a lib failure is logged and swallowed — the event is already stored', async () => {
    const { svc } = await buildService();
    findStrategyMock.mockResolvedValue(STRATEGY_ROW);
    consumeUnitsMock.mockRejectedValue(new Error('deadlock detected'));

    // creditPool:false on the failure path — a failed draw changed no
    // balance, so there is nothing new for the trigger to evaluate.
    await expect(svc.consumeForEvent({ ...baseInput, subscription: SUB_ROW })).resolves.toEqual({
      creditPool: false,
    });
  });

  it('NEVER throws: even a strategy-lookup failure is swallowed', async () => {
    const { svc } = await buildService();
    findStrategyMock.mockRejectedValue(new Error('db unreachable'));

    await expect(svc.consumeForEvent({ ...baseInput, subscription: SUB_ROW })).resolves.toEqual({
      creditPool: false,
    });
    expect(consumeUnitsMock).not.toHaveBeenCalled();
  });
});
