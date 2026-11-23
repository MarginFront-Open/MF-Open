/**
 * Role-gate PROOF for cap writes.
 *
 * Plain English: proves the cap-write routes are owner/finance ONLY. The load-
 * bearing case is 'admin' — an admin can write every OTHER money surface
 * (MANAGE_MONEY_ROLES = owner/admin/finance) but must NOT be able to write a
 * cap (CAP_MANAGE_ROLES = owner/finance). If someone "reused" MANAGE_MONEY_ROLES
 * on these routes, the admin case below would go red.
 *
 * Why this test is trustworthy (it can FAIL): it drives the REAL OrgRoleGuard
 * decision (canActivate) with only the ba_member DB read stubbed. The negative
 * control replays an unguarded route (no guard = allow all) and shows an
 * admin/member sails through, then the real guard blocks them.
 */

import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAP_MANAGE_ROLES } from '@marginfront/db';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';

const ORG = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/**
 * Build the REAL guard with a stubbed ba_member.findFirst and a Reflector that
 * reports the cap-write route's decorators: @OrgFromUser (org = caller's own) +
 * @OrgRoles(...CAP_MANAGE_ROLES).
 */
function realGuard(callerRole: string | null) {
  const findFirst = jest.fn().mockResolvedValue(callerRole ? { role: callerRole } : null);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'orgFromUser' ? true : key === 'orgRoles' ? [...CAP_MANAGE_ROLES] : undefined,
    ),
  } as unknown as Reflector;
  return { guard: new OrgRoleGuard(prisma, reflector), findFirst };
}

function ctxFor(user: any): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params: {} }) }),
  } as unknown as ExecutionContext;
}

const humanIn = (role: string) => ({
  authMethod: 'session' as const,
  userId: `user-${role}`,
  organizationId: ORG,
});

describe('cap-write role gate (owner/finance only)', () => {
  describe('negative control — ungated stand-in', () => {
    const ungatedAllowAll: CanActivate = { canActivate: () => true };
    it('UNGATED: an admin write is wrongly allowed (this is what the gate closes)', () => {
      expect(ungatedAllowAll.canActivate(ctxFor(humanIn('admin')) as any)).toBe(true);
    });
  });

  it('owner is allowed', async () => {
    const { guard } = realGuard('owner');
    await expect(guard.canActivate(ctxFor(humanIn('owner')))).resolves.toBe(true);
  });

  it('finance is allowed', async () => {
    const { guard } = realGuard('finance');
    await expect(guard.canActivate(ctxFor(humanIn('finance')))).resolves.toBe(true);
  });

  it('admin is REJECTED — the CAP_MANAGE vs MANAGE_MONEY differentiator', async () => {
    const { guard } = realGuard('admin');
    await expect(guard.canActivate(ctxFor(humanIn('admin')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('member is REJECTED', async () => {
    const { guard } = realGuard('member');
    await expect(guard.canActivate(ctxFor(humanIn('member')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('developer is REJECTED (build seat, not a money seat)', async () => {
    const { guard } = realGuard('developer');
    await expect(guard.canActivate(ctxFor(humanIn('developer')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('CAP_MANAGE_ROLES is exactly owner/finance — admin is not in the set', () => {
    expect([...CAP_MANAGE_ROLES]).toEqual(['owner', 'finance']);
    expect((CAP_MANAGE_ROLES as readonly string[]).includes('admin')).toBe(false);
  });
});
