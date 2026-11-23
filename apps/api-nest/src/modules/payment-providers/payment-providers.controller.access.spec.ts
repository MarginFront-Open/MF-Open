/**
 * Tests for PaymentProvidersController's org-access gate.
 *
 * validateOrganizationAccess() checks the canonical ba_member table. These tests drive that private gate directly (every route funnels through it)
 * and prove: a ba_member is allowed, a non-member is denied, the same-org fast-path skips the DB,
 * an api-key on a different org fails closed without an undefined-userId query, and the
 * team_members table is never read.
 */

import { ForbiddenException } from '@nestjs/common';
import { PaymentProvidersController } from './payment-providers.controller';

const TARGET_ORG = 'org-target';

function makePrisma(membership: { role: string } | null) {
  return {
    ba_member: { findFirst: jest.fn().mockResolvedValue(membership) },
    team_members: { findFirst: jest.fn().mockResolvedValue({ id: 'nope' }) },
  } as any;
}

function gate(controller: PaymentProvidersController, user: any, orgId: string) {
  return (controller as any).validateOrganizationAccess(user, orgId) as Promise<void>;
}

describe('PaymentProvidersController.validateOrganizationAccess (ba_member-backed)', () => {
  it('ALLOWS a ba_member of the target org', async () => {
    const prisma = makePrisma({ role: 'member' });
    const c = new PaymentProvidersController({} as any, prisma);
    const user = { userId: 'human-1', organizationId: 'other', authMethod: 'session' };
    await expect(gate(c, user, TARGET_ORG)).resolves.toBeUndefined();
    expect(prisma.ba_member.findFirst).toHaveBeenCalledWith({
      where: { organizationId: TARGET_ORG, userId: 'human-1' },
      select: { role: true },
    });
  });

  it('DENIES a non-member', async () => {
    const prisma = makePrisma(null);
    const c = new PaymentProvidersController({} as any, prisma);
    const user = { userId: 'human-2', organizationId: 'other', authMethod: 'session' };
    await expect(gate(c, user, TARGET_ORG)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FAST-PATH: same active org allowed without a DB hit', async () => {
    const prisma = makePrisma(null);
    const c = new PaymentProvidersController({} as any, prisma);
    const user = { userId: 'human-3', organizationId: TARGET_ORG, authMethod: 'session' };
    await expect(gate(c, user, TARGET_ORG)).resolves.toBeUndefined();
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
  });

  it('CROSS-TENANT FAIL-CLOSED: api-key on a different org denied, no undefined-userId query', async () => {
    const prisma = makePrisma({ role: 'member' });
    const c = new PaymentProvidersController({} as any, prisma);
    const user = { userId: undefined, organizationId: 'key-own-org', authMethod: 'api-key' };
    await expect(gate(c, user, TARGET_ORG)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: never reads team_members', async () => {
    const prisma = makePrisma({ role: 'admin' });
    const c = new PaymentProvidersController({} as any, prisma);
    const user = { userId: 'human-4', organizationId: 'other', authMethod: 'session' };
    await gate(c, user, TARGET_ORG);
    expect(prisma.team_members.findFirst).not.toHaveBeenCalled();
  });
});
