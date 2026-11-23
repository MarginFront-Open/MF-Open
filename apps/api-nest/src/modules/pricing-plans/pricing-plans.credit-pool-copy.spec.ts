/**
 * WHAT THIS FILE DOES: proves the plan-copy lane runs the
 * credit-pool rule AFTER its discount rewrite, not before.
 *
 * Why the ordering is the whole test: copying a plan multiplies every tier
 * rate by the discount, and for a credit pool that includes tiers[0].rate —
 * the flat pool fee. Validating the SOURCE would pass while the rewritten
 * COPY could be the thing that's wrong. The bounds are what the rule checks,
 * and the discount leaves bounds alone, so the honest statement is: the check
 * runs on the bytes that get written.
 *
 * Also pinned: a copy is how a stored degenerate row would otherwise get a
 * fresh twin, and copyPricingPlan forces every copy `active: true`, which can
 * turn one live pool plus one dormant pool into two live pools.
 *
 * Prisma is mocked (sibling-spec pattern). Every assertion can fail: move the
 * check before the rewrite and the discount test still passes but the
 * degenerate-source test writes; drop the single-pool check and the
 * dormant-pool test writes two live pools.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PricingPlansService } from './pricing-plans.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ORG = 'org-uuid';
const PLAN = 'plan-uuid';

const POOL_STRATEGY = {
  id: 'strat-pool',
  name: 'API Call Pool',
  agentId: 'agent-uuid',
  orgId: ORG,
  planId: PLAN,
  signalId: 'signal-uuid',
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  billingFrequency: 'monthly',
  tiers: [
    { lower: 0, upper: 5000, rate: 99 },
    { lower: 5000, upper: null, rate: 0.03 },
  ],
  rate: null,
  minimumCommitment: null,
  active: true,
  tags: [],
};

function buildPrismaMock(strategies: unknown[]) {
  const createMany = jest.fn().mockResolvedValue({ count: strategies.length });
  const tx = {
    pricing_plans: { create: jest.fn().mockResolvedValue({}) },
    agent_pricing_plans: { createMany: jest.fn().mockResolvedValue({}) },
    pricing_strategies: { createMany },
  };
  return {
    createMany,
    prisma: {
      pricing_plans: {
        findFirst: jest.fn().mockResolvedValue({
          id: PLAN,
          orgId: ORG,
          description: 'orig',
          isActive: true,
          featuresList: null,
          pricing_strategies: strategies,
          agent_pricing_plans: [],
        }),
      },
      $transaction: jest.fn((fn: any) => fn(tx)),
    },
  };
}

async function buildService(prisma: any): Promise<PricingPlansService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [PricingPlansService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  const svc = module.get(PricingPlansService);
  // findOne is the copy's return value, not what's under test here.
  jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 'new-plan' } as any);
  return svc;
}

describe('copy — credit-pool lane', () => {
  it('a discounted pool copy keeps its shape and is written', async () => {
    const { prisma, createMany } = buildPrismaMock([POOL_STRATEGY]);
    const svc = await buildService(prisma);

    await svc.copy(PLAN, ORG, { newName: 'Copy', discount: 20 } as any);

    expect(createMany).toHaveBeenCalledTimes(1);
    const [copied] = createMany.mock.calls[0][0].data;
    // Bounds survive the discount; only the rates move.
    expect(copied.tiers).toEqual([
      { lower: 0, upper: 5000, rate: 79.2 },
      { lower: 5000, upper: null, rate: 0.02 },
    ]);
  });

  it('refuses to give a degenerate legacy pool a fresh twin', async () => {
    const { prisma, createMany } = buildPrismaMock([
      { ...POOL_STRATEGY, tiers: [{ lower: 0, upper: 0, rate: 99 }] },
    ]);
    const svc = await buildService(prisma);

    await expect(svc.copy(PLAN, ORG, { newName: 'Copy' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('refuses to clone a grandfathered two-live-pool plan onto a fresh plan', async () => {
    const { prisma, createMany } = buildPrismaMock([
      POOL_STRATEGY,
      { ...POOL_STRATEGY, id: 'strat-two', name: 'Second Pool' },
    ]);
    const svc = await buildService(prisma);

    // The SOURCE may be grandfathered; the copy is a brand-new plan, so it gets
    // no grandfathering — nothing is being un-broken by creating a second mess.
    await expect(svc.copy(PLAN, ORG, { newName: 'Copy' } as any)).rejects.toThrow(
      /one active credit pool/i,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('a dormant second pool stays dormant, so the copy is allowed', async () => {
    const { prisma, createMany } = buildPrismaMock([
      POOL_STRATEGY,
      { ...POOL_STRATEGY, id: 'strat-dormant', name: 'Old Pool', active: false },
    ]);
    const svc = await buildService(prisma);

    // This lane copies `active` through. (The dashboard's copy forces every row
    // active and therefore DOES reject this same source — see
    // pricing-plans-credit-pool.test.ts. The lanes differ; both are validated.)
    await svc.copy(PLAN, ORG, { newName: 'Copy' } as any);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('copies non-pool plans untouched', async () => {
    const { prisma, createMany } = buildPrismaMock([
      { ...POOL_STRATEGY, pricingModel: 'graduated', tiers: [{ lower: 0, upper: 0, rate: 5 }] },
    ]);
    const svc = await buildService(prisma);

    await svc.copy(PLAN, ORG, { newName: 'Copy' } as any);
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});
