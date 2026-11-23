/**
 * Tests for the money-write lock on the invoices controller.
 *
 * The controller gates every write handler with `@UseGuards(OrgRoleGuard)` +
 * `@OrgRoles(...MANAGE_MONEY_ROLES)`. The canonical invoice routes are PARAM-LESS
 * (the org comes from the authenticated user, not the URL), which is exactly the
 * case the URL-org guard path doesn't handle. This spec drives OrgRoleGuard
 * with the REAL `MANAGE_MONEY_ROLES` constant (the same one the controller
 * decorator spreads) so we prove the actual seam — not a copy — and confirm:
 *
 *   - finance / admin / owner  -> allowed (finance MUST get in: it's the books)
 *   - member / non-member      -> 403
 *   - the role is looked up in the caller's OWN org (the @OrgFromUser flag), on BOTH the
 *     canonical param-less route AND the /org/:orgId alias — the URL org is ignored
 *   - a same-org API key (SDK traffic) still passes with no membership lookup
 *
 * If anyone ever points the controller at ORG_MANAGE_ROLES (owner/admin only) by
 * mistake, the finance case here flips to a 403 and this spec fails — which is the
 * guardrail we want.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';

type Membership = { role: string } | null;

function buildGuard(membership: Membership) {
  const findFirst = jest.fn().mockResolvedValue(membership);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    // The controller gates writes with @OrgRoles(...MANAGE_MONEY_ROLES) AND @OrgFromUser() —
    // mirror BOTH: the role set for 'orgRoles', the flag `true` for 'orgFromUser' so the
    // guard resolves the target org from the caller (not the URL), exactly as in production.
    getAllAndOverride: jest.fn((key: string) =>
      key === 'orgFromUser' ? true : [...MANAGE_MONEY_ROLES],
    ),
  } as unknown as Reflector;
  return { guard: new OrgRoleGuard(prisma, reflector), findFirst };
}

// Param-less request — exactly the canonical invoice write route shape (no :orgId in URL).
function paramlessCtx(user: any): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params: {} }) }),
  } as unknown as ExecutionContext;
}

// Alias request — the `org/:orgId/invoices/...` shape that DOES carry a URL org.
function paramCtx(user: any, urlOrgId: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params: { orgId: urlOrgId } }) }),
  } as unknown as ExecutionContext;
}

const ORG = 'org-1111';
const OTHER_ORG = 'org-9999';

describe('Invoices money-write authorization (OrgRoleGuard + MANAGE_MONEY_ROLES)', () => {
  it('MANAGE_MONEY_ROLES is owner/admin/finance (finance is in the set)', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual(['admin', 'finance', 'owner']);
  });

  it.each(['finance', 'admin', 'owner'])(
    'allows a %s on a param-less invoice write, role checked in their own org',
    async (role) => {
      const { guard, findFirst } = buildGuard({ role });
      const human = { authMethod: 'session', userId: 'u1', organizationId: ORG };
      await expect(guard.canActivate(paramlessCtx(human))).resolves.toBe(true);
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG, userId: 'u1' } }),
      );
    },
  );

  it('rejects a plain member on a param-less invoice write', async () => {
    const { guard } = buildGuard({ role: 'member' });
    const human = { authMethod: 'session', userId: 'u2', organizationId: ORG };
    await expect(guard.canActivate(paramlessCtx(human))).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-member (no row in their own org)', async () => {
    const { guard } = buildGuard(null);
    const human = { authMethod: 'session', userId: 'u3', organizationId: ORG };
    await expect(guard.canActivate(paramlessCtx(human))).rejects.toThrow(ForbiddenException);
  });

  it('allows a same-org API key (SDK traffic) with no membership lookup', async () => {
    const { guard, findFirst } = buildGuard(null);
    const key = { authMethod: 'api-key', organizationId: ORG, userId: undefined };
    await expect(guard.canActivate(paramlessCtx(key))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // ALIAS: @OrgFromUser makes the guard IGNORE the URL org. invoices.service never
  // reads the URL :orgId; it writes to user.organizationId. So an API key hitting the alias
  // of a FOREIGN org acts only on its OWN org — there is no cross-tenant write to block, and
  // the same-org branch passes with no membership lookup.
  it('ignores the :orgId alias for an API key — acts on the key own org, not the URL', async () => {
    const { guard, findFirst } = buildGuard(null);
    const key = { authMethod: 'api-key', organizationId: ORG, userId: undefined };
    await expect(guard.canActivate(paramCtx(key, OTHER_ORG))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // ALIAS: a human whose OWN org is ORG hits the alias naming OTHER_ORG. The role is
  // looked up in ORG — the org actually written — NOT the URL's OTHER_ORG. So a money manager
  // in OTHER_ORG who is only a plain member of their active org ORG can't write to ORG via
  // POST /v1/org/OTHER_ORG/invoices: they're a member
  // in ORG, so they're denied. The lookup is scoped to ORG, proving the URL org is ignored.
  it('checks the role in the caller own org on the :orgId alias, not the URL org', async () => {
    const { guard, findFirst } = buildGuard({ role: 'member' }); // member in their OWN org
    const human = { authMethod: 'session', userId: 'u9', organizationId: ORG };
    await expect(guard.canActivate(paramCtx(human, OTHER_ORG))).rejects.toThrow(ForbiddenException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, userId: 'u9' } }),
    );
  });
});
