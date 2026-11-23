/**
 * The cost-control read posture, pinned.
 *
 * The module splits THREE ways, and each side of the split exists for a reason a
 * future editor must not "fix":
 *
 *   - MONEY READS (spend/breakdown, spend/breakdown/drill): OrgRoleGuard +
 *     MANAGE_MONEY_ROLES + @OrgFromUser. They return per-repo/branch spend and teammate
 *     emails; their only human consumer (internal-ai-spend/page.tsx) already gates on
 *     the same set.
 *   - DEVICE READS (caps, spend, coverage): NO role gate, ever. The code-cost-clarity daemon polls
 *     /caps + /spend every 5 minutes (forwarder.ts CONTROL_SYNC_INTERVAL_MS) with a
 *     developer-role secret key (the install kit says "Give them the Developer role"),
 *     and the on-device hook stops enforcing once its state is older than
 *     STALE_SECONDS = 3600 — so an OrgRoleGuard here silently disarms every customer's
 *     spend cap one hour after deploy, with no server-side telemetry. Note an
 *     ingest-role key is rejected by ANY OrgRoleGuard route at enforce, so merely
 *     attaching the guard is the landmine, whatever roles are listed.
 *   - WRITES (createCap/updateCap/deleteCap): CAP_MANAGE_ROLES (owner/finance —
 *     deliberately NARROWER than the money reads; admin can read a cap but not write
 *   one).
 *
 * The publishable-key exclusion on all five reads is a separate axis, proven in
 * cost-control.key-type-gate.spec.ts.
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAP_MANAGE_ROLES, MANAGE_MONEY_ROLES } from '@marginfront/db';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { CostControlController } from './cost-control.controller';

const ORG_ROLES_KEY = 'orgRoles';
const ORG_FROM_USER_KEY = 'orgFromUser';
const GUARDS_KEY = '__guards__';

const MONEY_READS = ['getSpendBreakdown', 'getSpendBreakdownDrill'] as const;
const DEVICE_READS = ['listCaps', 'getSpend', 'getCoverage'] as const;

const handler = (name: string) =>
  (CostControlController.prototype as any)[name] as ((...args: unknown[]) => unknown) | undefined;

describe('cost-control read posture — the three-way split', () => {
  it('the whole controller sits behind CombinedAuthGuard (no anonymous reads)', () => {
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_KEY, CostControlController) ?? [];
    expect(classGuards).toContain(CombinedAuthGuard);
  });

  it.each(MONEY_READS)(
    '%s demands MANAGE_MONEY_ROLES via OrgRoleGuard, scoped by @OrgFromUser',
    (name) => {
      const fn = handler(name)!;
      const guards: unknown[] = Reflect.getMetadata(GUARDS_KEY, fn) ?? [];
      expect(guards).toContain(OrgRoleGuard);
      expect(Reflect.getMetadata(ORG_ROLES_KEY, fn)).toEqual([...MANAGE_MONEY_ROLES]);
      // Without @OrgFromUser the guard resolves orgId from URL params this controller
      // does not have, and 403s EVERY caller — see the landmine test below.
      expect(Reflect.getMetadata(ORG_FROM_USER_KEY, fn)).toBe(true);
    },
  );

  it.each(DEVICE_READS)(
    '%s carries NO OrgRoleGuard and NO role metadata; a role gate here disarms every deployed code-cost-clarity cap in ~60 minutes (5-minute poll, 3600s staleness cutoff, developer-role key)',
    (name) => {
      const fn = handler(name)!;
      const guards: unknown[] = Reflect.getMetadata(GUARDS_KEY, fn) ?? [];
      expect(guards).not.toContain(OrgRoleGuard);
      expect(Reflect.getMetadata(ORG_ROLES_KEY, fn)).toBeUndefined();
    },
  );

  it('the WRITE family still demands owner/finance — the read/write split is intact', () => {
    for (const write of ['createCap', 'updateCap', 'deleteCap']) {
      const roles = Reflect.getMetadata(ORG_ROLES_KEY, handler(write)!);
      expect(roles).toEqual([...CAP_MANAGE_ROLES]);
    }
  });
});

describe('the @OrgFromUser landmine', () => {
  function sessionCtxWithEmptyParams(handlerName: string): ExecutionContext {
    return {
      getHandler: () => handler(handlerName),
      getClass: () => CostControlController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            authMethod: 'session',
            userId: 'user-finance-1',
            organizationId: 'org-mine',
          },
          params: {},
          method: 'GET',
          route: { path: `/v1/control/${handlerName}` },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it("a finance session with NO :orgId/:id URL param resolves the org from the user and passes — without @OrgFromUser this throws 'No organization specified' for every caller, human and key alike", async () => {
    const findFirst = jest.fn().mockResolvedValue({ role: 'finance' });
    const guard = new OrgRoleGuard({ ba_member: { findFirst } } as any, new Reflector());
    await expect(guard.canActivate(sessionCtxWithEmptyParams('getSpendBreakdown'))).resolves.toBe(
      true,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-mine', userId: 'user-finance-1' },
      select: { role: true },
    });
  });

  it('a member session is refused on the same route (the floor is real, not just reachable)', async () => {
    const findFirst = jest.fn().mockResolvedValue({ role: 'member' });
    const guard = new OrgRoleGuard({ ba_member: { findFirst } } as any, new Reflector());
    await expect(
      guard.canActivate(sessionCtxWithEmptyParams('getSpendBreakdownDrill')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('org scoping', () => {
  it('org scope comes from the AUTHENTICATED user, never from the request payload', async () => {
    const service = {
      getSpendBreakdown: jest.fn().mockResolvedValue({ rows: [] }),
    } as any;
    const controller = new CostControlController(service);
    // A hostile caller smuggles someone else's org id into the query — the
    // controller must still scope to the caller's own org.
    await (controller as any).getSpendBreakdown(
      { user: { organizationId: 'org-mine' } },
      { period: 'month', dimension: 'repo', organizationId: 'org-victim' },
    );
    expect(service.getSpendBreakdown).toHaveBeenCalledTimes(1);
    expect(service.getSpendBreakdown.mock.calls[0][0]).toBe('org-mine');
  });
});
