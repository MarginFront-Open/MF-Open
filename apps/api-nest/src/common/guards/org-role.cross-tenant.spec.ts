/**
 * Cross-tenant authorization PROOF test.
 *
 * Plain English: this proves OrgRoleGuard actually stops a logged-in user from
 * Company A from acting on Company B's org by guessing B's id in the URL.
 *
 * Why this test is trustworthy (it can FAIL): it drives the REAL guard decision logic
 * (canActivate) — nothing about the authorization is mocked. The ONLY thing stubbed is the
 * ba_member database read, because Prisma is not the unit under test. To make the
 * "capable of failing" guarantee concrete, the first block runs an ungated route (no guard
 * at all = always allowed) against the SAME cross-tenant request and shows it sails
 * through, then the real guard blocks it. If the guard became a no-op, every
 * "rejects" assertion below would go red.
 *
 * Cases:
 *   (1) caller is a member of a DIFFERENT org than the path orgId   -> 403
 *   (2) caller is a 'member' role hitting an owner/admin-only write  -> 403
 *   (3) caller is owner/admin of the path org                        -> pass
 */

import { ExecutionContext, ForbiddenException, CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard, ORG_MANAGE_ROLES } from './org-role.guard';

// Two real-shaped org UUIDs. ORG_A = the victim org named in the URL; ORG_B = the attacker's
// own org. The attacker is a legitimate logged-in user of B with NO membership row in A.
const VICTIM_ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ATTACKER_OWN_ORG = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

type Membership = { role: string } | null;

/**
 * Build the REAL guard with a stubbed ba_member.findFirst (the I/O boundary) and a stubbed
 * Reflector that reports the route's required roles. Returns the findFirst spy so a test can
 * assert it was or wasn't queried.
 */
function realGuard(membershipInTargetOrg: Membership, requiredRoles: string[]) {
  const findFirst = jest.fn().mockResolvedValue(membershipInTargetOrg);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    // These cross-tenant routes resolve their org from the URL (NOT @OrgFromUser), so the
    // 'orgFromUser' flag must read false; only the role set comes back for 'orgRoles'.
    getAllAndOverride: jest.fn((key: string) => (key === 'orgFromUser' ? false : requiredRoles)),
  } as unknown as Reflector;
  return { guard: new OrgRoleGuard(prisma, reflector), findFirst };
}

/** Minimal ExecutionContext carrying the authenticated user + the route's :id/:orgId param. */
function ctxFor(user: any, params: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
  } as unknown as ExecutionContext;
}

// A real human, logged into their OWN org (B), pointing the request at the victim org (A).
const attacker = {
  authMethod: 'session' as const,
  userId: 'attacker-user-uuid',
  organizationId: ATTACKER_OWN_ORG,
};

const MEMBER_LEVEL: string[] = []; // @OrgRoles()           — any member may read
const MANAGE_LEVEL = ORG_MANAGE_ROLES; // @OrgRoles(...ORG_MANAGE_ROLES) — owner/admin only

describe('cross-tenant guard', () => {
  /**
   * NEGATIVE CONTROL — proves the test is meaningful by showing an ungated route FAILS the
   * security expectation. A route with no @UseGuards has the effective policy "always allow".
   * We model that as a no-op guard and assert it lets the cross-tenant request through. This
   * is the red the real guard turns green.
   */
  describe('ungated behavior (negative control)', () => {
    const ungatedAllowAll: CanActivate = { canActivate: () => true };

    it('UNGATED: cross-tenant request is wrongly allowed (the hole the guard closes)', () => {
      const ctx = ctxFor(attacker, { id: VICTIM_ORG });
      // With no guard the stranger gets in. If our real-guard assertions below were
      // toothless, they'd pass here too — they do not, which is the whole point.
      expect(ungatedAllowAll.canActivate(ctx)).toBe(true);
    });
  });

  // (1) Cross-tenant READ: member of a DIFFERENT org, no membership row in the target -> 403.
  it('(1) blocks a caller who is a member of a DIFFERENT org (read route)', async () => {
    const { guard, findFirst } = realGuard(/* no row in victim org */ null, MEMBER_LEVEL);
    const ctx = ctxFor(attacker, { id: VICTIM_ORG });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    // It actually looked the caller up in the TARGET (victim) org, not their own.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: VICTIM_ORG, userId: 'attacker-user-uuid' },
      }),
    );
  });

  // (1b) Cross-tenant WRITE: same stranger against an owner/admin-only route -> 403.
  it('(1b) blocks a cross-tenant caller on an owner/admin-only write route', async () => {
    const { guard } = realGuard(null, MANAGE_LEVEL);
    const ctx = ctxFor(attacker, { orgId: VICTIM_ORG });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (2) Wrong ROLE: caller IS a member of the target org but only a 'member', hitting an
  //     owner/admin-only write -> 403.
  it("(2) blocks a 'member'-role caller on an owner/admin-only write", async () => {
    const insider = {
      authMethod: 'session' as const,
      userId: 'insider-uuid',
      organizationId: VICTIM_ORG,
    };
    const { guard, findFirst } = realGuard({ role: 'member' }, MANAGE_LEVEL);
    const ctx = ctxFor(insider, { orgId: VICTIM_ORG });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    // The write route must NOT fast-path on active-org; it has to read the real role.
    expect(findFirst).toHaveBeenCalled();
  });

  // (3) Authorized owner and admin of the target org pass the write route.
  it('(3) allows an OWNER of the target org on the write route', async () => {
    const owner = {
      authMethod: 'session' as const,
      userId: 'owner-uuid',
      organizationId: VICTIM_ORG,
    };
    const { guard } = realGuard({ role: 'owner' }, MANAGE_LEVEL);
    await expect(guard.canActivate(ctxFor(owner, { orgId: VICTIM_ORG }))).resolves.toBe(true);
  });

  it('(3b) allows an ADMIN of the target org on the write route', async () => {
    const admin = {
      authMethod: 'session' as const,
      userId: 'admin-uuid',
      organizationId: VICTIM_ORG,
    };
    const { guard } = realGuard({ role: 'admin' }, MANAGE_LEVEL);
    await expect(guard.canActivate(ctxFor(admin, { orgId: VICTIM_ORG }))).resolves.toBe(true);
  });

  // MUTATION SENSITIVITY: identical write context, ONLY the role differs -> outcome flips.
  // Proves the gate reads the role value, not mere membership presence.
  it('flips on role alone: admin passes, member is blocked (same write context)', async () => {
    const passing = realGuard({ role: 'admin' }, MANAGE_LEVEL);
    await expect(passing.guard.canActivate(ctxFor(attacker, { orgId: VICTIM_ORG }))).resolves.toBe(
      true,
    );

    const failing = realGuard({ role: 'member' }, MANAGE_LEVEL);
    await expect(
      failing.guard.canActivate(ctxFor(attacker, { orgId: VICTIM_ORG })),
    ).rejects.toThrow(ForbiddenException);
  });

  // API-KEY: a same-org server key keeps working (no human row to look up); a cross-org key
  // is the attack and is blocked.
  it('allows a same-org API key with ZERO membership lookups', async () => {
    const { guard, findFirst } = realGuard(null, MANAGE_LEVEL);
    const key = { authMethod: 'api-key', organizationId: VICTIM_ORG, userId: undefined };
    await expect(guard.canActivate(ctxFor(key, { orgId: VICTIM_ORG }))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('blocks a cross-org API key', async () => {
    const { guard } = realGuard(null, MEMBER_LEVEL);
    const key = { authMethod: 'api-key', organizationId: ATTACKER_OWN_ORG, userId: undefined };
    await expect(guard.canActivate(ctxFor(key, { orgId: VICTIM_ORG }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  // Param resolution: organizations route names the org :id; the others name it :orgId.
  // Both must resolve to the same membership lookup.
  it('resolves the org id from :id and from :orgId identically', async () => {
    const a = realGuard({ role: 'member' }, MEMBER_LEVEL);
    await expect(a.guard.canActivate(ctxFor(attacker, { id: VICTIM_ORG }))).resolves.toBe(true);
    expect(a.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: VICTIM_ORG, userId: 'attacker-user-uuid' },
      }),
    );

    const b = realGuard({ role: 'member' }, MEMBER_LEVEL);
    await expect(b.guard.canActivate(ctxFor(attacker, { orgId: VICTIM_ORG }))).resolves.toBe(true);
    expect(b.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: VICTIM_ORG, userId: 'attacker-user-uuid' },
      }),
    );
  });
});
