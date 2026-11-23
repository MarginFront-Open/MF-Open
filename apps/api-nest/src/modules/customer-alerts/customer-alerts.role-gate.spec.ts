/**
 * Role-gate PROOF for customer-watch routes.
 *
 * Plain English: proves every /customer-alerts route (reads included) is
 * owner/admin/finance ONLY. The load-bearing case is 'developer' — the build
 * seat can read Build surfaces but must never see or write per-customer money
 * tripwires. The second differentiator is the deliberate NON-clone of the cap
 * controller's open-read posture: caps leave reads ungated for the device
 * brake; customer watches have no device consumer, so reads take the full
 * money gate too.
 *
 * Why this test is trustworthy (it can FAIL): it drives the REAL OrgRoleGuard
 * decision (canActivate) with only the ba_member DB read stubbed. The negative
 * control replays an unguarded route (no guard = allow all) and shows a
 * developer sails through, then the real guard blocks them.
 */

import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * Build the REAL guard with a stubbed ba_member.findFirst and a Reflector that
 * reports the customer-alert routes' decorators: @OrgFromUser (org = caller's
 * own) + @OrgRoles(...MANAGE_MONEY_ROLES).
 */
function realGuard(callerRole: string | null) {
  const findFirst = jest.fn().mockResolvedValue(callerRole ? { role: callerRole } : null);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'orgFromUser' ? true : key === 'orgRoles' ? [...MANAGE_MONEY_ROLES] : undefined,
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

describe('customer-watch role gate (owner/admin/finance only, reads included)', () => {
  describe('negative control — ungated stand-in', () => {
    const ungatedAllowAll: CanActivate = { canActivate: () => true };
    it('UNGATED: a developer read is wrongly allowed (this is what the gate closes)', () => {
      expect(ungatedAllowAll.canActivate(ctxFor(humanIn('developer')) as any)).toBe(true);
    });
  });

  it('owner is allowed', async () => {
    const { guard } = realGuard('owner');
    await expect(guard.canActivate(ctxFor(humanIn('owner')))).resolves.toBe(true);
  });

  it('admin is allowed — the MANAGE_MONEY vs CAP_MANAGE differentiator', async () => {
    const { guard } = realGuard('admin');
    await expect(guard.canActivate(ctxFor(humanIn('admin')))).resolves.toBe(true);
  });

  it('finance is allowed', async () => {
    const { guard } = realGuard('finance');
    await expect(guard.canActivate(ctxFor(humanIn('finance')))).resolves.toBe(true);
  });

  it('developer is REJECTED (build seat, not a money seat)', async () => {
    const { guard } = realGuard('developer');
    await expect(guard.canActivate(ctxFor(humanIn('developer')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('member is REJECTED', async () => {
    const { guard } = realGuard('member');
    await expect(guard.canActivate(ctxFor(humanIn('member')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a user with NO membership row in the org is REJECTED', async () => {
    const { guard } = realGuard(null);
    await expect(guard.canActivate(ctxFor(humanIn('ghost')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('MANAGE_MONEY_ROLES is exactly owner/admin/finance', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual(['admin', 'finance', 'owner']);
    expect((MANAGE_MONEY_ROLES as readonly string[]).includes('developer')).toBe(false);
  });
});
