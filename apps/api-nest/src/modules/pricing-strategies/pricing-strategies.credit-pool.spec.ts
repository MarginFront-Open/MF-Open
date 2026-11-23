/**
 * WHAT THIS FILE DOES: proves the credit-pool rule actually FIRES
 * on all three api-nest pricing-strategy write lanes, and that the two DTO
 * traps the `creditPool` sugar creates are handled.
 *
 * The rule ITSELF is proven in packages/db/src/lib/credit-pool-tiers.test.ts.
 * What can only be proven here is the wiring: that each lane calls it, calls
 * it against the MERGED state, compiles sugar into tiers before writing, and
 * never hands Prisma the `creditPool` key (which is not a column — Prisma
 * throws "Unknown argument" on it, which is why the destructure is load-
 * bearing rather than cosmetic).
 *
 * WHY PRISMA IS MOCKED (the sibling-spec pattern, e.g. credit-ledger.service
 * .spec.ts): the code under test is the service's branch decisions and the
 * exact `data` payload it builds. Asserting on that payload is strictly
 * stronger than asserting a row landed in a database — it catches the
 * Unknown-argument trap, which a live DB would only catch by throwing.
 *
 * Every assertion can fail: drop the validator call and the rejection tests
 * see a write; drop the destructure and the payload assertions see creditPool;
 * merge patch-only instead of merged-state and the PATCH tests pass a bad row.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PricingStrategiesService } from './pricing-strategies.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const PLAN = 'plan-uuid';
const AGENT = 'agent-uuid';
const SIGNAL = 'signal-uuid';
const STRATEGY = 'strategy-uuid';

const GOOD_TIERS = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
];

/** An existing, coherent credit-pool row. */
const POOL_ROW = {
  id: STRATEGY,
  name: 'API Call Pool',
  orgId: ORG,
  planId: PLAN,
  agentId: AGENT,
  signalId: SIGNAL,
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  billingFrequency: 'monthly',
  tiers: GOOD_TIERS,
  rate: null,
  minimumCommitment: null,
  active: true,
  deletedAt: null,
  tags: [],
  signals: null,
};

function buildPrismaMock() {
  return {
    pricing_plans: { findFirst: jest.fn().mockResolvedValue({ id: PLAN, orgId: ORG }) },
    agents: { findFirst: jest.fn().mockResolvedValue({ id: AGENT, orgId: ORG }) },
    signals: {
      findFirst: jest.fn().mockResolvedValue({ id: SIGNAL, orgId: ORG }),
      // The live-signal check; individual tests override the roster.
      findMany: jest.fn().mockResolvedValue([]),
    },
    pricing_strategies: {
      findFirst: jest.fn().mockResolvedValue(POOL_ROW),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((args: any) => Promise.resolve(args.data)),
      update: jest.fn().mockImplementation((args: any) => Promise.resolve({ id: args.where.id })),
    },
  };
}

async function buildService(prisma: any): Promise<PricingStrategiesService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [PricingStrategiesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(PricingStrategiesService);
}

function baseCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'API Call Pool',
    agentId: AGENT,
    signalId: SIGNAL,
    chargeType: 'usage',
    pricingModel: 'credit_pool',
    ...overrides,
  } as any;
}

describe('createBulk — lane 1', () => {
  it('compiles creditPool sugar into the canonical tiers', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await svc.createBulk(ORG, PLAN, [
      baseCreate({ creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 } }),
    ]);

    expect(prisma.pricing_strategies.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.pricing_strategies.create.mock.calls[0][0];
    expect(data.tiers).toEqual(GOOD_TIERS);
    // `creditPool` is not a column. If it reached Prisma this would be a 500.
    expect(data).not.toHaveProperty('creditPool');
  });

  it('the RESPONSE carries the derived creditPool — what you POST is what you GET', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    const created = await svc.createBulk(ORG, PLAN, [
      baseCreate({ creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 } }),
    ]);

    expect(created[0].creditPool).toEqual({
      poolSize: 5000,
      poolPrice: 99,
      overageRate: 0.03,
    });
  });

  it('rejects a payload sending BOTH creditPool and tiers', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({
          creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 },
          tiers: GOOD_TIERS,
        }),
      ]),
    ).rejects.toThrow(/not both/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('rejects an incoherent pool and writes NOTHING', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({
          tiers: [
            { lower: 0, upper: 5000, rate: 99 },
            { lower: 4000, upper: null, rate: 0.03 },
          ],
        }),
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('rejects partial sugar by name — compileCreditPool needs all three fields', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [baseCreate({ creditPool: { poolSize: 5000, poolPrice: 99 } })]),
    ).rejects.toThrow(/overageRate/);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('rejects a minimum commitment on a pool', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({
          creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 },
          minimumCommitment: 500,
        }),
      ]),
    ).rejects.toThrow(/minimum commitment/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('rejects a SECOND live pool on a plan that already has one', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findMany.mockResolvedValue([
      {
        id: 'other',
        name: 'Existing Pool',
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
      },
    ]);
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({ creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 } }),
      ]),
    ).rejects.toThrow(/one active credit pool/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('leaves non-credit-pool strategies alone (grandfathering)', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    // A degenerate tier array on a graduated strategy: none of the credit-pool
    // business, so it must still write.
    await svc.createBulk(ORG, PLAN, [
      baseCreate({
        pricingModel: 'graduated',
        tiers: [{ lower: 0, upper: 0, rate: 0 }],
        minimumCommitment: 500,
      }),
    ]);
    expect(prisma.pricing_strategies.create).toHaveBeenCalledTimes(1);
    // A live USAGE strategy can collide with a rated pool's member signals,
    // so this write pays exactly one plan-strategies query (the double-billing
    // sweep) and no signals query.
    expect(prisma.pricing_strategies.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.signals.findMany).not.toHaveBeenCalled();
  });

  it('non-usage strategies still skip every plan-level query (cost discipline)', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await svc.createBulk(ORG, PLAN, [
      baseCreate({
        name: 'Platform fee',
        chargeType: 'recurring',
        pricingModel: 'flat',
        rate: 99,
        signalId: undefined,
      }),
    ]);
    expect(prisma.pricing_strategies.create).toHaveBeenCalledTimes(1);
    // No pool, no usage row, no rates -> nothing to collide with, no cost.
    expect(prisma.pricing_strategies.findMany).not.toHaveBeenCalled();
    expect(prisma.signals.findMany).not.toHaveBeenCalled();
  });
});

describe('update — lane 2 (PATCH)', () => {
  it('PATCH with sugar succeeds and never sends creditPool to Prisma', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await svc.update(STRATEGY, ORG, PLAN, {
      creditPool: { poolSize: 10000, poolPrice: 149, overageRate: 0.02 },
    } as any);

    const { data } = prisma.pricing_strategies.update.mock.calls[0][0];
    expect(data.tiers).toEqual([
      { lower: 0, upper: 10000, rate: 149 },
      { lower: 10000, upper: null, rate: 0.02 },
    ]);
    expect(data).not.toHaveProperty('creditPool');
  });

  it('the PATCH RESPONSE carries the derived creditPool', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.update.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, tiers: args.data.tiers }),
    );
    const svc = await buildService(prisma);

    const updated = await svc.update(STRATEGY, ORG, PLAN, {
      creditPool: { poolSize: 10000, poolPrice: 149, overageRate: 0.02 },
    } as any);

    expect((updated as any).creditPool).toEqual({
      poolSize: 10000,
      poolPrice: 149,
      overageRate: 0.02,
    });
  });

  it('rejects a PATCH sending BOTH creditPool and tiers', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.update(STRATEGY, ORG, PLAN, {
        creditPool: { poolSize: 10000, poolPrice: 149, overageRate: 0.02 },
        tiers: GOOD_TIERS,
      } as any),
    ).rejects.toThrow(/not both/i);
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });

  it('PATCH {minimumCommitment} alone is rejected — merged state, not patch-only', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.update(STRATEGY, ORG, PLAN, { minimumCommitment: 500 } as any),
    ).rejects.toThrow(/minimum commitment/i);
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });

  it('PATCH {pricingModel:credit_pool} onto a graduated row is rejected on its tiers', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findFirst.mockResolvedValue({
      ...POOL_ROW,
      pricingModel: 'graduated',
      tiers: [
        { lower: 0, upper: 100, rate: 1 },
        { lower: 100, upper: 1000, rate: 0.5 },
        { lower: 1000, upper: null, rate: 0.1 },
      ],
    });
    const svc = await buildService(prisma);

    await expect(
      svc.update(STRATEGY, ORG, PLAN, { pricingModel: 'credit_pool' } as any),
    ).rejects.toThrow(/exactly 2 tiers/i);
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });

  it('a rename never runs the rule — an untouched degenerate row stays editable', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findFirst.mockResolvedValue({
      ...POOL_ROW,
      tiers: [{ lower: 0, upper: 0, rate: 99 }],
    });
    const svc = await buildService(prisma);

    await svc.update(STRATEGY, ORG, PLAN, { name: 'Renamed Pool' } as any);
    expect(prisma.pricing_strategies.update).toHaveBeenCalledTimes(1);
  });
});

describe('bulkUpdate — lane 3', () => {
  const bulk = (update: unknown[], create: unknown[] = []) =>
    ({ strategies: { update, new: create } }) as any;

  it('compiles sugar and strips the key on the update branch', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findMany.mockResolvedValue([POOL_ROW]);
    const svc = await buildService(prisma);

    await svc.bulkUpdate(
      ORG,
      PLAN,
      bulk([{ id: STRATEGY, creditPool: { poolSize: 200, poolPrice: 10, overageRate: 1 } }]),
    );

    const { data } = prisma.pricing_strategies.update.mock.calls[0][0];
    expect(data.tiers).toEqual([
      { lower: 0, upper: 200, rate: 10 },
      { lower: 200, upper: null, rate: 1 },
    ]);
    expect(data).not.toHaveProperty('creditPool');
  });

  it('the bulk RESPONSE carries the derived creditPool on updated rows', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findMany.mockResolvedValue([POOL_ROW]);
    prisma.pricing_strategies.update.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, tiers: args.data.tiers }),
    );
    const svc = await buildService(prisma);

    const res = await svc.bulkUpdate(
      ORG,
      PLAN,
      bulk([{ id: STRATEGY, creditPool: { poolSize: 200, poolPrice: 10, overageRate: 1 } }]),
    );

    expect(res.updated.strategies[0].creditPool).toEqual({
      poolSize: 200,
      poolPrice: 10,
      overageRate: 1,
    });
  });

  it('rejects the whole batch before writing ANY of it', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findMany.mockResolvedValue([
      { ...POOL_ROW, id: 'ok-one' },
      { ...POOL_ROW, id: 'bad-one' },
    ]);
    const svc = await buildService(prisma);

    await expect(
      svc.bulkUpdate(
        ORG,
        PLAN,
        bulk([
          { id: 'ok-one', creditPool: { poolSize: 100, poolPrice: 5, overageRate: 1 } },
          { id: 'bad-one', creditPool: { poolSize: 0, poolPrice: 5, overageRate: 1 } },
        ]),
      ),
    ).rejects.toThrow(/greater than zero/i);
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });

  it('PATCH {pricingModel} in a bulk update is validated against the stored tiers', async () => {
    const prisma = buildPrismaMock();
    prisma.pricing_strategies.findMany.mockResolvedValue([
      { ...POOL_ROW, pricingModel: 'flat', tiers: null },
    ]);
    const svc = await buildService(prisma);

    await expect(
      svc.bulkUpdate(ORG, PLAN, bulk([{ id: STRATEGY, pricingModel: 'credit_pool' }])),
    ).rejects.toThrow(/creditPool block|two-tier/i);
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });
});

describe('creditRates — the funnel wiring', () => {
  const MEMBER = 'member-signal-uuid';
  const SUGAR = { poolSize: 5000, poolPrice: 99, overageRate: 0.03 };

  it('createBulk stores valid creditRates and checks the keys against LIVE org signals', async () => {
    const prisma = buildPrismaMock();
    prisma.signals.findMany.mockResolvedValue([{ id: MEMBER }]);
    const svc = await buildService(prisma);

    await svc.createBulk(ORG, PLAN, [
      baseCreate({ creditPool: SUGAR, creditRates: { [MEMBER]: 4 } }),
    ]);

    const { data } = prisma.pricing_strategies.create.mock.calls[0][0];
    expect(data.creditRates).toEqual({ [MEMBER]: 4 });
    expect(prisma.signals.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [MEMBER] }, orgId: ORG, deletedAt: null }),
      }),
    );
  });

  it('createBulk rejects a creditRates key that is not a live org signal', async () => {
    const prisma = buildPrismaMock();
    prisma.signals.findMany.mockResolvedValue([]);
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({ creditPool: SUGAR, creditRates: { 'ghost-signal': 4 } }),
      ]),
    ).rejects.toThrow(/doesn't exist/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('createBulk rejects non-positive rate values by name', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [baseCreate({ creditPool: SUGAR, creditRates: { [MEMBER]: 0 } })]),
    ).rejects.toThrow(/greater than zero/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('createBulk rejects creditRates on a non-pool model', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({ pricingModel: 'flat', rate: 0.01, creditRates: { [MEMBER]: 4 } }),
      ]),
    ).rejects.toThrow(/only applies/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('createBulk rejects a batch whose pool rates a signal the SAME batch prices per-unit', async () => {
    const prisma = buildPrismaMock();
    prisma.signals.findMany.mockResolvedValue([{ id: MEMBER }]);
    const svc = await buildService(prisma);

    await expect(
      svc.createBulk(ORG, PLAN, [
        baseCreate({ creditPool: SUGAR, creditRates: { [MEMBER]: 4 } }),
        baseCreate({
          name: 'Per-call',
          signalId: MEMBER,
          pricingModel: 'flat',
          rate: 0.01,
        }),
      ]),
    ).rejects.toThrow(/never both/i);
    expect(prisma.pricing_strategies.create).not.toHaveBeenCalled();
  });

  it('update: creditRates null leaves the rates alone; {} clears them', async () => {
    const prisma = buildPrismaMock();
    const svc = await buildService(prisma);

    await svc.update(STRATEGY, ORG, PLAN, { creditRates: null } as any);
    expect(prisma.pricing_strategies.update.mock.calls[0][0].data.creditRates).toBeUndefined();

    await svc.update(STRATEGY, ORG, PLAN, { creditRates: {} } as any);
    expect(prisma.pricing_strategies.update.mock.calls[1][0].data.creditRates).toEqual({});
  });

  it('update: activating a usage strategy on a pool-member signal is rejected (the back door)', async () => {
    const prisma = buildPrismaMock();
    const dormantRival = {
      ...POOL_ROW,
      id: 'rival',
      name: 'Per-call',
      pricingModel: 'flat',
      tiers: null,
      signalId: MEMBER,
      active: false,
    };
    prisma.pricing_strategies.findFirst.mockResolvedValue(dormantRival);
    prisma.pricing_strategies.findMany.mockResolvedValue([
      {
        id: STRATEGY,
        name: 'API Call Pool',
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
        signalId: SIGNAL,
        creditRates: { [MEMBER]: 4 },
      },
      {
        id: 'rival',
        name: 'Per-call',
        pricingModel: 'flat',
        chargeType: 'usage',
        active: false,
        deletedAt: null,
        signalId: MEMBER,
        creditRates: null,
      },
    ]);
    const svc = await buildService(prisma);

    await expect(svc.update('rival', ORG, PLAN, { active: true } as any)).rejects.toThrow(
      /never both/i,
    );
    expect(prisma.pricing_strategies.update).not.toHaveBeenCalled();
  });

  it('bulkUpdate: a creditRates patch is validated and written as a real column', async () => {
    const prisma = buildPrismaMock();
    prisma.signals.findMany.mockResolvedValue([{ id: MEMBER }]);
    const membershipRow = {
      id: STRATEGY,
      name: POOL_ROW.name,
      pricingModel: 'credit_pool',
      chargeType: 'usage',
      active: true,
      deletedAt: null,
      signalId: SIGNAL,
      creditRates: null,
    };
    prisma.pricing_strategies.findMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id ? [POOL_ROW] : [membershipRow]),
    );
    const svc = await buildService(prisma);

    await svc.bulkUpdate(ORG, PLAN, {
      strategies: { update: [{ id: STRATEGY, creditRates: { [MEMBER]: 2 } }], new: [] },
    } as any);

    const { data } = prisma.pricing_strategies.update.mock.calls[0][0];
    expect(data.creditRates).toEqual({ [MEMBER]: 2 });
    expect(data).not.toHaveProperty('creditPool');
  });
});
