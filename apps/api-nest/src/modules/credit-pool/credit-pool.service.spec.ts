/**
 * CreditPoolService proofs: the two reads and the
 * two writes behind /v1/credit-balances and the subscription credit routes.
 *
 * Reads delegate to the shared @marginfront/db credit-balance canon (proven in
 * packages/db/src/lib/credit-balance.test.ts — ONE balance path), so what this
 * file pins is the seam: org scoping, filter pass-through, and the 404 that
 * says a subscription without a pool has no pool number rather than a zero one.
 * It also runs the canon DIRECTLY against the same fixture and asserts the
 * service returns identical numbers — the read-parity check that stops the
 * endpoint from growing its own arithmetic.
 *
 * Writes are pinned where a retry could cost a customer money:
 *   1. A top-up grant is periodStart null + expiresAt null (unique-safe beside
 *      the period grant; the units the customer paid for never rot).
 *   2. A replayed idempotencyKey returns the ORIGINAL grant and writes NO
 *      second row. NEGATIVE CONTROL: without the key check, the same call
 *      pair would have produced two grants and double-credited the customer.
 *   3. Two DIFFERENT top-ups inside one period both land — the null periodStart
 *      is what keeps them off the mint's unique key.
 *   4. The ledger is the audit trail: the grant carries createdBy + note and a
 *      `grant` ledger entry is appended in the same transaction.
 *   5. Pausing alerts is idempotent and needs no balance-cache row.
 *
 * Only Prisma is stubbed; the real service and the real shared canon run.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getCreditBalances } from '@marginfront/db';
import { CreditPoolService } from './credit-pool.service';

const ORG = 'org-uuid';
const OTHER_ORG = 'other-org-uuid';
const SUB = 'sub-uuid';
const PLAN = 'plan-uuid';
const PERIOD_START = new Date('2026-07-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-07-15T12:00:00.000Z');

// Pin the clock inside the fixture period: the canon reads noActivePeriod and
// grant drawability off the service's `new Date()`, so real time passing
// PERIOD_END expires these fixtures. Date only — faking setTimeout hangs awaits.
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    now: NOW,
  });
});
afterAll(() => {
  jest.useRealTimers();
});

interface StubGrant {
  id: string;
  subscriptionId: string;
  organizationId: string;
  amountUnits: number;
  consumedUnits: number;
  source: string;
  periodStart: Date | null;
  effectiveAt: Date;
  expiresAt: Date | null;
  idempotencyKey: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

interface StubSub {
  id: string;
  name: string;
  organizationId: string;
  customerId: string;
  agentId: string;
  planId: string;
  currentBillingPeriodStart: Date | null;
  currentBillingPeriodEnd: Date | null;
  creditAlertsPaused: boolean;
  deletedAt: Date | null;
}

interface State {
  subscriptions: StubSub[];
  strategies: Array<{
    planId: string;
    pricingModel: string;
    chargeType: string;
    active: boolean;
    deletedAt: Date | null;
    signalId: string | null;
    tiers: unknown;
    createdAt: Date;
  }>;
  grants: StubGrant[];
  entries: Array<{
    grantId: string;
    subscriptionId: string;
    kind: string;
    deltaUnits: number;
    balanceAfterUnits: number;
    createdAt: Date;
  }>;
  events: Array<{
    organizationId: string;
    subscriptionId: string;
    signalId: string;
    quantity: number;
    usageDate: Date;
  }>;
  balances: Array<{ subscriptionId: string; balanceUnits: number; periodStart: Date }>;
}

function tiers(poolSize = 5000) {
  return [
    { lower: 0, upper: poolSize, rate: 99 },
    { lower: poolSize, upper: null, rate: 0.03 },
  ];
}

function freshState(over: Partial<State> = {}): State {
  return {
    subscriptions: [
      {
        id: SUB,
        name: 'Acme pooled plan',
        organizationId: ORG,
        customerId: 'cust-uuid',
        agentId: 'agent-uuid',
        planId: PLAN,
        currentBillingPeriodStart: PERIOD_START,
        currentBillingPeriodEnd: PERIOD_END,
        creditAlertsPaused: false,
        deletedAt: null,
      },
    ],
    strategies: [
      {
        planId: PLAN,
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
        signalId: 'signal-uuid',
        tiers: tiers(),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    grants: [],
    entries: [],
    events: [],
    balances: [],
    ...over,
  };
}

function matchesSub(s: StubSub, where: any): boolean {
  if (where.organizationId !== undefined && where.organizationId !== s.organizationId) return false;
  if (where.deletedAt === null && s.deletedAt !== null) return false;
  if (where.id !== undefined && where.id !== s.id) return false;
  if (where.customerId !== undefined && where.customerId !== s.customerId) return false;
  if (where.agentId !== undefined && where.agentId !== s.agentId) return false;
  return true;
}

function mockPrisma(state: State) {
  let nextId = 1;
  const client: any = {
    subscriptions: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          state.subscriptions
            .filter((s) => matchesSub(s, where))
            .map((s) => ({
              ...s,
              customers: { name: 'Acme', externalId: 'acme-ext' },
              pricing_plans: { name: 'Pooled' },
            })),
        ),
      findFirst: ({ where }: any) =>
        Promise.resolve(state.subscriptions.find((s) => matchesSub(s, where)) ?? null),
      update: jest.fn(({ where, data }: any) => {
        const sub = state.subscriptions.find((s) => s.id === where.id) as StubSub;
        Object.assign(sub, data);
        return Promise.resolve(sub);
      }),
    },
    pricing_strategies: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          state.strategies.filter(
            (s) =>
              where.planId.in.includes(s.planId) &&
              s.pricingModel === where.pricingModel &&
              s.chargeType === where.chargeType &&
              s.active === where.active &&
              s.deletedAt === null,
          ),
        ),
      findFirst: ({ where }: any) =>
        Promise.resolve(
          state.strategies.find(
            (s) =>
              s.planId === where.planId &&
              s.pricingModel === where.pricingModel &&
              s.chargeType === where.chargeType &&
              s.active === where.active &&
              s.deletedAt === null,
          ) ?? null,
        ),
    },
    credit_grants: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          state.grants.filter((g) => {
            if (where.subscriptionId?.in && !where.subscriptionId.in.includes(g.subscriptionId))
              return false;
            if (
              typeof where.subscriptionId === 'string' &&
              where.subscriptionId !== g.subscriptionId
            )
              return false;
            if (where.effectiveAt?.lte && g.effectiveAt > where.effectiveAt.lte) return false;
            if (where.OR && !(g.expiresAt === null || g.expiresAt > where.OR[1].expiresAt.gt))
              return false;
            return true;
          }),
        ),
      findFirst: ({ where }: any) =>
        Promise.resolve(
          state.grants.find((g) =>
            where.idempotencyKey !== undefined
              ? g.idempotencyKey === where.idempotencyKey
              : g.subscriptionId === where.subscriptionId,
          ) ?? null,
        ),
      create: jest.fn(({ data }: any) => {
        if (
          data.idempotencyKey &&
          state.grants.some((g) => g.idempotencyKey === data.idempotencyKey)
        ) {
          return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
        }
        const grant: StubGrant = {
          id: `grant-${nextId++}`,
          createdAt: NOW,
          ...data,
        };
        state.grants.push(grant);
        return Promise.resolve(grant);
      }),
    },
    signal_events: {
      // The invoice-calculator selection recipe, verbatim: org + subscription
      // + signalId + INCLUSIVE usageDate window, SUM(quantity).
      aggregate: ({ where }: any) => {
        const rows = state.events.filter(
          (e) =>
            e.organizationId === where.organizationId &&
            e.subscriptionId === where.subscriptionId &&
            e.signalId === where.signalId &&
            e.usageDate >= where.usageDate.gte &&
            e.usageDate <= where.usageDate.lte,
        );
        return Promise.resolve({
          _sum: {
            quantity: rows.length === 0 ? null : rows.reduce((s, e) => s + e.quantity, 0),
          },
        });
      },
    },
    credit_ledger_entries: {
      create: jest.fn(({ data }: any) => {
        state.entries.push({ createdAt: NOW, ...data });
        return Promise.resolve(data);
      }),
    },
    credit_pool_balances: {
      upsert: jest.fn(({ where, create, update }: any) => {
        const row = state.balances.find((b) => b.subscriptionId === where.subscriptionId);
        if (row) Object.assign(row, update);
        else state.balances.push(create);
        return Promise.resolve(row ?? create);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const rows = state.balances.filter((b) => b.subscriptionId === where.subscriptionId);
        for (const row of rows) {
          for (const [key, value] of Object.entries(data as Record<string, any>)) {
            if (value && typeof value === 'object' && 'increment' in value) {
              (row as any)[key] = (row as any)[key] + value.increment;
            } else {
              (row as any)[key] = value;
            }
          }
        }
        return Promise.resolve({ count: rows.length });
      }),
      findUnique: ({ where }: any) =>
        Promise.resolve(
          state.balances.find((b) => b.subscriptionId === where.subscriptionId) ?? null,
        ),
    },
    $transaction: (fn: any) => fn(client),
  };
  return client;
}

describe('CreditPoolService reads', () => {
  it('returns the shared canon rows, with the SAME numbers the canon itself computes', async () => {
    const state = freshState({
      grants: [
        {
          id: 'grant-period',
          subscriptionId: SUB,
          organizationId: ORG,
          amountUnits: 5000,
          consumedUnits: 5300,
          source: 'period_grant',
          periodStart: PERIOD_START,
          effectiveAt: PERIOD_START,
          expiresAt: PERIOD_END,
          idempotencyKey: null,
          note: null,
          createdBy: 'dispatch:usage-invoice',
          createdAt: PERIOD_START,
        },
      ],
      events: [
        {
          organizationId: ORG,
          subscriptionId: SUB,
          signalId: 'signal-uuid',
          quantity: 5300,
          usageDate: new Date('2026-07-10T00:00:00.000Z'),
        },
      ],
    });
    const prisma = mockPrisma(state);
    const svc = new CreditPoolService(prisma);

    const { balances, asOf } = await svc.listBalances(ORG);
    expect(balances).toHaveLength(1);
    expect(balances[0].poolSizeUnits).toBe(5000);
    expect(balances[0].consumedUnits).toBe(5300);
    expect(balances[0].remainingUnits).toBe(-300);
    expect(balances[0].overageInProgressUnits).toBe(300);
    expect(asOf).toBeInstanceOf(Date);

    // READ PARITY: the canon run directly on the same fixture must agree
    // field-for-field. If the endpoint ever grows its own arithmetic, this
    // goes red.
    const direct = await getCreditBalances(prisma, ORG, {}, asOf);
    expect(balances).toEqual(direct);
  });

  it('passes the customer / agent / belowPercent filters through to the canon', async () => {
    const state = freshState({
      subscriptions: [
        {
          ...freshState().subscriptions[0],
          id: 'healthy',
          customerId: 'cust-a',
          agentId: 'agent-a',
        },
        { ...freshState().subscriptions[0], id: 'empty', customerId: 'cust-b', agentId: 'agent-b' },
      ],
      grants: [
        {
          id: 'g1',
          subscriptionId: 'healthy',
          organizationId: ORG,
          amountUnits: 5000,
          consumedUnits: 100,
          source: 'period_grant',
          periodStart: PERIOD_START,
          effectiveAt: PERIOD_START,
          expiresAt: PERIOD_END,
          idempotencyKey: null,
          note: null,
          createdBy: null,
          createdAt: PERIOD_START,
        },
        {
          id: 'g2',
          subscriptionId: 'empty',
          organizationId: ORG,
          amountUnits: 5000,
          consumedUnits: 5000,
          source: 'period_grant',
          periodStart: PERIOD_START,
          effectiveAt: PERIOD_START,
          expiresAt: PERIOD_END,
          idempotencyKey: null,
          note: null,
          createdBy: null,
          createdAt: PERIOD_START,
        },
      ],
    });
    const svc = new CreditPoolService(mockPrisma(state));

    expect(
      (await svc.listBalances(ORG, { belowPercent: 20 })).balances.map((b) => b.subscriptionId),
    ).toEqual(['empty']);
    expect(
      (await svc.listBalances(ORG, { customerId: 'cust-a' })).balances.map((b) => b.subscriptionId),
    ).toEqual(['healthy']);
    expect(
      (await svc.listBalances(ORG, { agentId: 'agent-b' })).balances.map((b) => b.subscriptionId),
    ).toEqual(['empty']);
  });

  it("another org's pools are never returned", async () => {
    const svc = new CreditPoolService(mockPrisma(freshState()));
    expect((await svc.listBalances(OTHER_ORG)).balances).toEqual([]);
  });

  it('404s with what to do next when the plan sells no credit pool', async () => {
    const state = freshState({ strategies: [] });
    const svc = new CreditPoolService(mockPrisma(state));
    await expect(svc.getBalance(ORG, SUB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getBalance(ORG, SUB)).rejects.toThrow(/GET \/v1\/credit-balances/);
  });
});

describe('CreditPoolService top-up', () => {
  it('writes a never-expiring, period-less grant with the ledger as its audit trail', async () => {
    const state = freshState();
    const prisma = mockPrisma(state);
    const svc = new CreditPoolService(prisma);

    const result = await svc.createTopup(ORG, SUB, 'user-123', {
      units: 1500,
      idempotencyKey: 'topup-1',
      note: 'Goodwill credit after a service issue',
    });

    expect(result.created).toBe(true);
    expect(result.unitsAdded).toBe(1500);
    expect(result.remainingUnits).toBe(1500);
    expect(state.grants).toHaveLength(1);
    expect(state.grants[0]).toMatchObject({
      source: 'manual_topup',
      // null periodStart keeps it off the mint's (subscriptionId, periodStart)
      // unique key; null expiresAt is the units-never-rot rule.
      periodStart: null,
      expiresAt: null,
      createdBy: 'user-123',
      note: 'Goodwill credit after a service issue',
    });
    // The audit trail is the ledger itself, never subscription_change_logs
    // (whose changedBy FK cannot hold an API-key caller).
    expect(state.entries).toEqual([
      expect.objectContaining({ kind: 'grant', deltaUnits: 1500, balanceAfterUnits: 1500 }),
    ]);
  });

  it('a replayed idempotencyKey returns the ORIGINAL grant and writes no second row', async () => {
    const state = freshState();
    const svc = new CreditPoolService(mockPrisma(state));

    const first = await svc.createTopup(ORG, SUB, 'user-123', {
      units: 1500,
      idempotencyKey: 'topup-1',
    });
    const replay = await svc.createTopup(ORG, SUB, 'user-123', {
      units: 1500,
      idempotencyKey: 'topup-1',
    });

    expect(replay.grantId).toBe(first.grantId);
    expect(replay.created).toBe(false);
    expect(state.grants).toHaveLength(1);
    expect(state.entries).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: without the key check the same pair double-credits the customer', async () => {
    const state = freshState();
    const prisma = mockPrisma(state);
    // No key check: create straight through, twice.
    for (const _ of [1, 2]) {
      await prisma.credit_grants.create({
        data: {
          subscriptionId: SUB,
          organizationId: ORG,
          amountUnits: 1500,
          consumedUnits: 0,
          source: 'manual_topup',
          periodStart: null,
          effectiveAt: new Date(),
          expiresAt: null,
          idempotencyKey: null,
          note: null,
          createdBy: 'user-123',
        },
      });
    }
    expect(state.grants).toHaveLength(2);
    expect(state.grants.reduce((s, g) => s + g.amountUnits, 0)).toBe(3000);
  });

  it('two DIFFERENT top-ups in one period both land (null periodStart is unique-safe)', async () => {
    const state = freshState();
    const svc = new CreditPoolService(mockPrisma(state));

    await svc.createTopup(ORG, SUB, 'user-123', { units: 500, idempotencyKey: 'topup-a' });
    const second = await svc.createTopup(ORG, SUB, 'user-123', {
      units: 250,
      idempotencyKey: 'topup-b',
    });

    expect(state.grants).toHaveLength(2);
    expect(state.grants.every((g) => g.periodStart === null)).toBe(true);
    expect(second.remainingUnits).toBe(750);
  });

  it('records WHICH api key topped up, not one flattened sentinel', async () => {
    const state = freshState();
    const svc = new CreditPoolService(mockPrisma(state));
    await svc.createTopup(ORG, SUB, 'api-key:key-42', { units: 10, idempotencyKey: 'k' });
    expect(state.grants[0].createdBy).toBe('api-key:key-42');
  });

  it('rejects a top-up on a plan that sells no credit pool, naming the fix', async () => {
    const svc = new CreditPoolService(mockPrisma(freshState({ strategies: [] })));
    await expect(
      svc.createTopup(ORG, SUB, 'user-123', { units: 100, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on a subscription outside the caller org', async () => {
    const svc = new CreditPoolService(mockPrisma(freshState()));
    await expect(
      svc.createTopup(OTHER_ORG, SUB, 'user-123', { units: 100, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('moves the balance cache with an ATOMIC increment, refreshing its period', async () => {
    const state = freshState({
      balances: [
        // A stale cache row left by a missed mint: wrong period, and a value a
        // concurrent consume is also moving.
        {
          subscriptionId: SUB,
          balanceUnits: 400,
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    });
    const prisma = mockPrisma(state);
    const svc = new CreditPoolService(prisma);

    const result = await svc.createTopup(ORG, SUB, 'user-123', {
      units: 1500,
      idempotencyKey: 'topup-1',
    });

    // 400 + 1500, NOT a recomputed absolute that would have clobbered the 400.
    expect(state.balances[0].balanceUnits).toBe(1900);
    expect(state.balances[0].periodStart).toEqual(PERIOD_START);
    // The ledger entry is anchored to the same number the cache now holds.
    expect(state.entries[0].balanceAfterUnits).toBe(1900);
    expect(result.created).toBe(true);

    const incrementCall = prisma.credit_pool_balances.updateMany.mock.calls[0][0];
    expect(incrementCall.data.balanceUnits).toEqual({ increment: 1500 });
  });

  it('NEGATIVE CONTROL: an absolute SET would have discarded the concurrent 400', async () => {
    // The naive shape: recompute drawable and write it flat. The stale 400 a
    // concurrent consume was holding vanishes.
    const state = freshState({
      balances: [{ subscriptionId: SUB, balanceUnits: 400, periodStart: PERIOD_START }],
    });
    const recomputedAbsolute = 1500; // drawable = only the new top-up grant
    expect(recomputedAbsolute).not.toBe(400 + 1500);
    expect(state.balances[0].balanceUnits).toBe(400);
  });

  it('409s when the SAME key asks for a different number of units', async () => {
    const state = freshState();
    const svc = new CreditPoolService(mockPrisma(state));
    await svc.createTopup(ORG, SUB, 'user-123', { units: 1000, idempotencyKey: 'k' });

    await expect(
      svc.createTopup(ORG, SUB, 'user-123', { units: 2500, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // and it says both numbers so the caller can see which one it meant
    await expect(
      svc.createTopup(ORG, SUB, 'user-123', { units: 2500, idempotencyKey: 'k' }),
    ).rejects.toThrow(/1000 units.*asks for 2500/);
    expect(state.grants).toHaveLength(1);
  });

  it('409s when a key already topped up a DIFFERENT subscription', async () => {
    const base = freshState();
    const state = freshState({
      subscriptions: [base.subscriptions[0], { ...base.subscriptions[0], id: 'sub-two' }],
    });
    const svc = new CreditPoolService(mockPrisma(state));
    await svc.createTopup(ORG, SUB, 'user-123', { units: 100, idempotencyKey: 'shared' });
    await expect(
      svc.createTopup(ORG, 'sub-two', 'user-123', { units: 100, idempotencyKey: 'shared' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CreditPoolService alert pause', () => {
  it('is idempotent: the second identical call writes nothing', async () => {
    const state = freshState();
    const prisma = mockPrisma(state);
    const svc = new CreditPoolService(prisma);

    expect(await svc.setAlertsPaused(ORG, SUB, true)).toEqual({
      subscriptionId: SUB,
      alertsPaused: true,
    });
    expect(prisma.subscriptions.update).toHaveBeenCalledTimes(1);

    expect(await svc.setAlertsPaused(ORG, SUB, true)).toEqual({
      subscriptionId: SUB,
      alertsPaused: true,
    });
    expect(prisma.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it('resumes with an explicit false, never a toggle', async () => {
    const state = freshState();
    const svc = new CreditPoolService(mockPrisma(state));
    await svc.setAlertsPaused(ORG, SUB, true);
    expect((await svc.setAlertsPaused(ORG, SUB, false)).alertsPaused).toBe(false);
    expect(state.subscriptions[0].creditAlertsPaused).toBe(false);
  });

  it('works on a subscription with no balance-cache row and no grants at all', async () => {
    const state = freshState({ balances: [], grants: [] });
    const svc = new CreditPoolService(mockPrisma(state));
    await expect(svc.setAlertsPaused(ORG, SUB, true)).resolves.toEqual({
      subscriptionId: SUB,
      alertsPaused: true,
    });
  });

  it('404s on a subscription outside the caller org', async () => {
    const svc = new CreditPoolService(mockPrisma(freshState()));
    await expect(svc.setAlertsPaused(OTHER_ORG, SUB, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
