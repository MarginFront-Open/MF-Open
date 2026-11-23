/**
 * Tests for OrgAccessGuard.
 *
 * The guard authorizes against the ba_member table. These tests prove:
 *   - a ba_member of the TARGET org is allowed
 *   - a non-member is denied
 *   - the primary-org / same-org fast-path short-circuits WITHOUT a DB hit
 *   - an api-key (userId undefined) on a DIFFERENT org fails CLOSED and never runs a lookup
 *     with userId: undefined (the Prisma-undefined-drop cross-tenant hole stays shut)
 *   - it never reads team_members
 *
 * OrgAccessGuard is exported but no route mounts it. The tests lock its behavior so a
 * route that adds it can trust it.
 */

import { ForbiddenException } from '@nestjs/common';
import { OrgAccessGuard } from './org-access.guard';

const TARGET_ORG = 'org-target';

function makePrisma(membership: { role: string } | null) {
  const ba_member = {
    findFirst: jest.fn().mockResolvedValue(membership),
  };
  const team_members = {
    findFirst: jest.fn().mockResolvedValue({ id: 'should-not-be-used' }),
  };
  return { ba_member, team_members } as any;
}

function ctxFor(user: any, orgId: string | undefined) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params: { orgId } }),
    }),
  } as any;
}

describe('OrgAccessGuard (ba_member-backed)', () => {
  it('ALLOWS a ba_member of the target org', async () => {
    const prisma = makePrisma({ role: 'member' });
    const guard = new OrgAccessGuard(prisma);
    const user = { userId: 'human-1', organizationId: 'some-other-org', authMethod: 'session' };
    await expect(guard.canActivate(ctxFor(user, TARGET_ORG))).resolves.toBe(true);
    expect(prisma.ba_member.findFirst).toHaveBeenCalledWith({
      where: { organizationId: TARGET_ORG, userId: 'human-1' },
      select: { role: true },
    });
  });

  it('DENIES a non-member (no ba_member row)', async () => {
    const prisma = makePrisma(null);
    const guard = new OrgAccessGuard(prisma);
    const user = { userId: 'human-2', organizationId: 'other', authMethod: 'session' };
    await expect(guard.canActivate(ctxFor(user, TARGET_ORG))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('FAST-PATH: same active org is allowed WITHOUT any membership lookup', async () => {
    const prisma = makePrisma(null);
    const guard = new OrgAccessGuard(prisma);
    const user = { userId: 'human-3', organizationId: TARGET_ORG, authMethod: 'session' };
    await expect(guard.canActivate(ctxFor(user, TARGET_ORG))).resolves.toBe(true);
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
  });

  it('CROSS-TENANT FAIL-CLOSED: api-key on a DIFFERENT org is denied and never queries with userId: undefined', async () => {
    const prisma = makePrisma({ role: 'member' }); // even if a row would match, we must not query
    const guard = new OrgAccessGuard(prisma);
    // api-key auth: organizationId is the key's OWN org; userId is undefined.
    const user = { userId: undefined, organizationId: 'key-own-org', authMethod: 'api-key' };
    await expect(guard.canActivate(ctxFor(user, TARGET_ORG))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: the membership check never reads team_members', async () => {
    const prisma = makePrisma({ role: 'admin' });
    const guard = new OrgAccessGuard(prisma);
    const user = { userId: 'human-4', organizationId: 'other', authMethod: 'session' };
    await guard.canActivate(ctxFor(user, TARGET_ORG));
    expect(prisma.team_members.findFirst).not.toHaveBeenCalled();
  });
});
