/**
 * Tests for OrgRoleGuard (cross-tenant authorization).
 *
 * This guard is the lock that stops a logged-in user from one company acting on ANOTHER
 * company's org by guessing its id in the URL. These tests drive the REAL decision logic
 * (canActivate) with the only I/O boundary — the ba_member lookup — stubbed, so they prove
 * the actual gate without needing a live database.
 *
 * What each case proves, in plain terms:
 *  - a stranger (no membership row) is turned away from both read and write routes
 *  - a member with the wrong role can't do owner/admin-only writes
 *  - the right people (member for reads, owner/admin for writes) get through
 *  - flipping ONLY the role flips the outcome (the gate reads role, not mere presence)
 *  - a same-org API key still works; a cross-org API key is blocked
 *  - portal customers are denied
 *  - the guard finds the org id whether the route names it :id or :orgId
 *  - the member fast-path lets an active-org read through without touching the database
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard, ORG_MANAGE_ROLES } from './org-role.guard';

type Membership = { role: string } | null;

/**
 * Build a guard whose ba_member.findFirst returns a controlled value, and whose Reflector
 * reports the given required roles. The findFirst jest.fn is returned too so a test can
 * assert it was (or was NOT) called.
 */
function buildGuard(membership: Membership, requiredRoles: string[], orgFromUser = false) {
  const findFirst = jest.fn().mockResolvedValue(membership);
  const prisma = { ba_member: { findFirst } } as any;

  // The guard reads TWO metadata keys: 'orgRoles' (the required-role set) and 'orgFromUser'
  // (the flag that says "resolve the target org from the caller, not the URL").
  // Mock by key so a test can independently control the roles and the flag.
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'orgFromUser' ? orgFromUser : requiredRoles,
    ),
  } as unknown as Reflector;

  const guard = new OrgRoleGuard(prisma, reflector);
  return { guard, findFirst };
}

/** Fake ExecutionContext carrying a user + route params. */
function buildContext(user: any, params: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user, params }),
    }),
  } as unknown as ExecutionContext;
}

const MEMBER_ROLES: string[] = []; // @OrgRoles() — any member
const MANAGE_ROLES = ORG_MANAGE_ROLES; // @OrgRoles(...ORG_MANAGE_ROLES) — owner/admin

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const humanInOtherOrg = {
  authMethod: 'session' as const,
  userId: 'user-uuid-1',
  organizationId: ORG_B, // active org is a DIFFERENT org than the one in the URL
};

describe('OrgRoleGuard', () => {
  // (a) STRANGER on a read route — no membership row -> 403
  it('rejects a stranger on a MEMBER endpoint (no membership row)', async () => {
    const { guard } = buildGuard(null, MEMBER_ROLES);
    const ctx = buildContext(humanInOtherOrg, { id: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (b) STRANGER on a write route -> 403
  it('rejects a stranger on a MANAGE endpoint (no membership row)', async () => {
    const { guard } = buildGuard(null, MANAGE_ROLES);
    const ctx = buildContext(humanInOtherOrg, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (c) WRONG ROLE — a plain member can't do an owner/admin-only write -> 403
  it('rejects a member on a MANAGE endpoint (wrong role)', async () => {
    const { guard } = buildGuard({ role: 'member' }, MANAGE_ROLES);
    const ctx = buildContext(humanInOtherOrg, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (d) AUTHORIZED member on a read route -> allowed
  it('allows a member on a MEMBER endpoint', async () => {
    const { guard } = buildGuard({ role: 'member' }, MEMBER_ROLES);
    const ctx = buildContext(humanInOtherOrg, { id: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  // (e) AUTHORIZED owner and admin on a write route -> allowed
  it('allows an owner on a MANAGE endpoint', async () => {
    const { guard } = buildGuard({ role: 'owner' }, MANAGE_ROLES);
    const ctx = buildContext(humanInOtherOrg, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows an admin on a MANAGE endpoint', async () => {
    const { guard } = buildGuard({ role: 'admin' }, MANAGE_ROLES);
    const ctx = buildContext(humanInOtherOrg, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  // (f) MUTATION SENSITIVITY — same write context, only the role changes -> outcome flips.
  // Proves the gate reads role, not mere membership presence.
  it('flips outcome when only the role changes (admin passes, member fails)', async () => {
    const pass = buildGuard({ role: 'admin' }, MANAGE_ROLES);
    await expect(
      pass.guard.canActivate(buildContext(humanInOtherOrg, { orgId: ORG_A })),
    ).resolves.toBe(true);

    const fail = buildGuard({ role: 'member' }, MANAGE_ROLES);
    await expect(
      fail.guard.canActivate(buildContext(humanInOtherOrg, { orgId: ORG_A })),
    ).rejects.toThrow(ForbiddenException);
  });

  // (g) API-KEY same org -> allowed, with ZERO ba_member lookups (no human row exists).
  it('allows a same-org API key without any membership lookup', async () => {
    const { guard, findFirst } = buildGuard(null, MANAGE_ROLES);
    const apiKeyUser = { authMethod: 'api-key', organizationId: ORG_A, userId: undefined };
    const ctx = buildContext(apiKeyUser, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects a cross-org API key', async () => {
    const { guard } = buildGuard(null, MEMBER_ROLES);
    const apiKeyUser = { authMethod: 'api-key', organizationId: ORG_B, userId: undefined };
    const ctx = buildContext(apiKeyUser, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (h) PORTAL customer -> denied outright.
  it('rejects a portal session', async () => {
    const { guard } = buildGuard({ role: 'owner' }, MEMBER_ROLES);
    const portalUser = { authMethod: 'portal', organizationId: ORG_A, userId: undefined };
    const ctx = buildContext(portalUser, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (i) PARAM RESOLUTION — works whether the route names the org :id or :orgId.
  it('resolves the org id from params.id (organizations route)', async () => {
    const { guard, findFirst } = buildGuard({ role: 'member' }, MEMBER_ROLES);
    const ctx = buildContext(humanInOtherOrg, { id: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A, userId: 'user-uuid-1' } }),
    );
  });

  it('resolves the org id from params.orgId (api-keys/stripe route)', async () => {
    const { guard, findFirst } = buildGuard({ role: 'owner' }, MANAGE_ROLES);
    const ctx = buildContext(humanInOtherOrg, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A, userId: 'user-uuid-1' } }),
    );
  });

  // (j) MEMBER fast-path — a human whose ACTIVE org is the org in the URL passes a read
  // route without any database hit.
  it('allows an active-org member via fast-path without a membership lookup', async () => {
    const { guard, findFirst } = buildGuard(null, MEMBER_ROLES);
    const activeOrgUser = { authMethod: 'session', userId: 'user-uuid-2', organizationId: ORG_A };
    const ctx = buildContext(activeOrgUser, { id: ORG_A });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // The fast-path must NOT skip the role check on a write route: an active-org user still
  // gets their real role checked against ba_member.
  it('does NOT fast-path a write route — active-org member still gets role-checked', async () => {
    const { guard, findFirst } = buildGuard({ role: 'member' }, MANAGE_ROLES);
    const activeOrgUser = { authMethod: 'session', userId: 'user-uuid-3', organizationId: ORG_A };
    const ctx = buildContext(activeOrgUser, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(findFirst).toHaveBeenCalled();
  });

  // (k) UNDEFINED userId on a human request -> fail CLOSED, with NO membership lookup.
  // Why this matters: Prisma drops `where` fields whose value is `undefined`, so a lookup
  // with `userId: undefined` would silently match the FIRST member of the TARGET org and
  // wave a stranger through. The guard must refuse BEFORE it ever queries.
  it('rejects a human with undefined userId on a MEMBER endpoint without a lookup', async () => {
    const { guard, findFirst } = buildGuard({ role: 'owner' }, MEMBER_ROLES);
    // No fast-path: active org differs from the URL org, forcing the would-be lookup path.
    const brokenTokenUser = { authMethod: 'session', userId: undefined, organizationId: ORG_B };
    const ctx = buildContext(brokenTokenUser, { id: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects a human with undefined userId on a MANAGE endpoint without a lookup', async () => {
    const { guard, findFirst } = buildGuard({ role: 'owner' }, MANAGE_ROLES);
    const brokenTokenUser = { authMethod: 'jwt', userId: undefined, organizationId: ORG_B };
    const ctx = buildContext(brokenTokenUser, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // No user on the request -> denied.
  it('rejects when there is no authenticated user', async () => {
    const { guard } = buildGuard(null, MEMBER_ROLES);
    const ctx = buildContext(undefined, { id: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // No org id ANYWHERE on a NON-@OrgFromUser route -> denied. Without the flag the guard
  // resolves the org strictly from the URL (params.orgId ?? params.id) and fails closed when
  // it's missing — exactly the URL-org behavior. (Routes that legitimately have no URL org
  // carry @OrgFromUser; those are covered by the @OrgFromUser tests below.)
  it('rejects when no org id is present in params on a non-OrgFromUser route', async () => {
    const { guard } = buildGuard(null, MEMBER_ROLES);
    const userWithOrg = {
      authMethod: 'session' as const,
      userId: 'user-uuid-noorg',
      organizationId: ORG_B,
    };
    const ctx = buildContext(userWithOrg, {}); // no URL param, no flag -> no org to act on
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // (l) @OrgFromUser ROUTES — the money write routes (invoices,
  // subscriptions, pricing plans/strategies, signal events) are mounted param-less and their
  // service ALWAYS writes to user.organizationId, ignoring the :orgId alias. The
  // @OrgFromUser flag makes the guard resolve the target org from the caller and check the
  // role THERE — on BOTH the canonical (no param) and the alias (mismatched param)
  // path. These cases prove the lock checks the role in exactly the org being written.

  // A finance user (a Manage-MONEY role) passes an @OrgFromUser write route; the role is
  // looked up in the caller's OWN org.
  it('@OrgFromUser route: allows a finance user, role checked in their own org', async () => {
    const { guard, findFirst } = buildGuard(
      { role: 'finance' },
      ['owner', 'admin', 'finance'],
      true,
    );
    const human = { authMethod: 'session', userId: 'finance-uuid', organizationId: ORG_A };
    const ctx = buildContext(human, {}); // no URL org param — the canonical invoices shape
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A, userId: 'finance-uuid' } }),
    );
  });

  // A plain member is still blocked on an @OrgFromUser money write (the whole point of @OrgFromUser).
  it('@OrgFromUser route: rejects a plain member on a money write', async () => {
    const { guard, findFirst } = buildGuard(
      { role: 'member' },
      ['owner', 'admin', 'finance'],
      true,
    );
    const human = { authMethod: 'session', userId: 'member-uuid', organizationId: ORG_A };
    const ctx = buildContext(human, {});
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A, userId: 'member-uuid' } }),
    );
  });

  // A non-member (no row in their own org — shouldn't happen for a real session, but fail
  // closed) is blocked.
  it('@OrgFromUser route: rejects when the caller has no membership row in their own org', async () => {
    const { guard } = buildGuard(null, ['owner', 'admin', 'finance'], true);
    const human = { authMethod: 'session', userId: 'ghost-uuid', organizationId: ORG_A };
    const ctx = buildContext(human, {});
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // A same-org API key (SDK traffic) still works on an @OrgFromUser route: orgId becomes
  // user.organizationId, so the existing api-key same-org branch passes with NO membership lookup.
  it('@OrgFromUser route: allows a same-org API key with no membership lookup', async () => {
    const { guard, findFirst } = buildGuard(null, ['owner', 'admin', 'finance'], true);
    const key = { authMethod: 'api-key', organizationId: ORG_A, userId: undefined };
    const ctx = buildContext(key, {});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // (m) THE ALIAS MISMATCH. The alias route
  // /v1/org/:orgId/... names an org in the URL, but the write still lands in
  // user.organizationId. @OrgFromUser must therefore IGNORE the URL org and check the role
  // in the caller's own org — otherwise a money manager in org A who is only a plain member
  // of their active org B could POST /v1/org/A/... and have the row written to B.

  // The URL alias names ORG_A, but the caller's active (and write-target) org is ORG_B.
  // The role is looked up in ORG_B — the org actually written — not the URL's ORG_A.
  it('@OrgFromUser route: ignores a mismatched URL :orgId alias and checks the role in the caller own org', async () => {
    const { guard, findFirst } = buildGuard(
      { role: 'finance' },
      ['owner', 'admin', 'finance'],
      true,
    );
    const human = { authMethod: 'session', userId: 'finance-uuid', organizationId: ORG_B };
    const ctx = buildContext(human, { orgId: ORG_A }); // alias URL names a DIFFERENT org
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_B, userId: 'finance-uuid' } }),
    );
  });

  // A plain member of their OWN org (ORG_B) is denied even though the URL
  // alias names ORG_A. The membership lookup is keyed to ORG_B — the write target — so the
  // member is correctly blocked regardless of what the URL claims.
  it('@OrgFromUser route: a member is denied on the alias path even when the URL names another org', async () => {
    const { guard, findFirst } = buildGuard(
      { role: 'member' },
      ['owner', 'admin', 'finance'],
      true,
    );
    const human = { authMethod: 'session', userId: 'member-uuid', organizationId: ORG_B };
    const ctx = buildContext(human, { orgId: ORG_A });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_B, userId: 'member-uuid' } }),
    );
  });
});
