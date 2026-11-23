/**
 * OrgRoleGuard on the BUILD routes — the load-bearing question this file
 * answers: "does gating the build-MANAGEMENT writes (agents/customers/signals/api-keys) to
 * Manage-BUILD roles break a customer's same-org SDK API key?" Answer must be NO.
 *
 * These drive the REAL guard with MANAGE_BUILD_ROLES (imported from @marginfront/db — the actual
 * shared constant the controllers use) and the only I/O boundary (ba_member.findFirst) stubbed.
 *
 *   - SAME-ORG API KEY  -> ALLOWED on a Manage-BUILD @OrgFromUser write, with ZERO membership
 *                          lookups. This is the ingestion/SDK-write path; it must stay open.
 *   - CROSS-ORG API KEY -> BLOCKED (the cross-tenant attack).
 *   - HUMAN member      -> BLOCKED;  HUMAN owner/admin/developer -> ALLOWED.
 *   - HUMAN finance     -> BLOCKED (build excludes finance).
 *   - MUTATION control: same context, only the role flips -> outcome flips.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard } from './org-role.guard';
import { MANAGE_BUILD_ROLES } from '@marginfront/db';

type Membership = { role: string } | null;

// Build a guard whose ba_member.findFirst returns a controlled value and whose Reflector
// reports MANAGE_BUILD_ROLES + the @OrgFromUser flag (agents/customers/signals/sdk writes
// are param-less and resolve the org from the caller). findFirst is returned so a test can
// assert it was NOT called on the api-key short-circuit path.
function buildGuard(membership: Membership, orgFromUser = true) {
  const findFirst = jest.fn().mockResolvedValue(membership);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'orgFromUser' ? orgFromUser : [...MANAGE_BUILD_ROLES],
    ),
  } as unknown as Reflector;
  return { guard: new OrgRoleGuard(prisma, reflector), findFirst };
}

function buildContext(user: any, params: Record<string, string> = {}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
  } as unknown as ExecutionContext;
}

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('OrgRoleGuard — BUILD routes (Manage-BUILD = owner/admin/developer)', () => {
  it('the shared constant is owner/admin/developer, with no finance', () => {
    expect([...MANAGE_BUILD_ROLES].sort()).toEqual(['admin', 'developer', 'owner']);
    expect((MANAGE_BUILD_ROLES as readonly string[]).includes('finance')).toBe(false);
  });

  // THE INGESTION-SAFETY CASE: a customer's own SDK key, acting on its OWN org, sails through
  // the gated build-management write with NO membership lookup. Gating management leaves
  // legitimate same-org api-key traffic open.
  it('ALLOWS a same-org API key on a gated BUILD write, with no membership lookup', async () => {
    const { guard, findFirst } = buildGuard(null);
    const apiKey = { authMethod: 'api-key', organizationId: ORG_A, userId: undefined };
    await expect(guard.canActivate(buildContext(apiKey, {}))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('BLOCKS a cross-org API key on a gated BUILD write', async () => {
    const { guard } = buildGuard(null);
    const apiKey = { authMethod: 'api-key', organizationId: ORG_B, userId: undefined };
    // The route is @OrgFromUser, so org resolves to the KEY's org (ORG_B). To prove the
    // cross-tenant block we drive a URL-org route (orgFromUser=false) where the key (ORG_B)
    // attacks ORG_A — the api-keys/stripe shape.
    const { guard: urlGuard } = buildGuard(null, false);
    await expect(urlGuard.canActivate(buildContext(apiKey, { orgId: ORG_A }))).rejects.toThrow(
      ForbiddenException,
    );
    expect(guard).toBeDefined();
  });

  it('BLOCKS a plain human member on a gated BUILD write', async () => {
    const { guard, findFirst } = buildGuard({ role: 'member' });
    const human = { authMethod: 'session', userId: 'u1', organizationId: ORG_A };
    await expect(guard.canActivate(buildContext(human, {}))).rejects.toThrow(ForbiddenException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A, userId: 'u1' } }),
    );
  });

  it('BLOCKS a finance human on a gated BUILD write (finance owns the books, not the build)', async () => {
    const { guard } = buildGuard({ role: 'finance' });
    const human = { authMethod: 'session', userId: 'u-fin', organizationId: ORG_A };
    await expect(guard.canActivate(buildContext(human, {}))).rejects.toThrow(ForbiddenException);
  });

  it.each(['owner', 'admin', 'developer'])(
    'ALLOWS a human %s on a gated BUILD write',
    async (role) => {
      const { guard, findFirst } = buildGuard({ role });
      const human = { authMethod: 'session', userId: 'u2', organizationId: ORG_A };
      await expect(guard.canActivate(buildContext(human, {}))).resolves.toBe(true);
      expect(findFirst.mock.calls[0][0].where.organizationId).toBe(ORG_A);
    },
  );

  // MUTATION SENSITIVITY: identical context, only the role flips -> outcome flips.
  it('flips outcome when only the role changes (owner passes, member fails)', async () => {
    const human = { authMethod: 'session', userId: 'u3', organizationId: ORG_A };
    const pass = buildGuard({ role: 'owner' });
    await expect(pass.guard.canActivate(buildContext(human, {}))).resolves.toBe(true);
    const fail = buildGuard({ role: 'member' });
    await expect(fail.guard.canActivate(buildContext(human, {}))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
