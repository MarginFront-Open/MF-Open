/**
 * Ship-blocking `@HumanOnly` COMPLETENESS test.
 *
 * Two things this file proves, both against the REAL classes (no mocking of the thing under
 * test — see the `key-enforcement` spec for the same harness this scales up):
 *
 * 1. COMPLETENESS: every mutating route on the control-plane catalog below — team management,
 *    payout routing (Stripe/payment-providers) — carries BOTH `@HumanOnly()` and
 *    `@UseGuards(OrgRoleGuard)`. Read the class-level comment on `@HumanOnly()`
 *    (`org-role.guard.ts`): the decorator does NOTHING without the guard also being wired, so
 *    asserting one without the other would pass a route that's silently unprotected.
 * 2. THE GUARD DECISION: for every one of those routes, driving the REAL
 *    `OrgRoleGuard.canActivate` with a same-org API key of EVERY carried role — including
 *    admin and owner, the two roles that would otherwise satisfy `@OrgRoles` — throws. An
 *    admin-role key is blocked ONLY by `@HumanOnly`; if that decorator were ever missing, this
 *    is the assertion that would catch it by actually exercising the guard, not just reading
 *    metadata.
 *
 * `CONTROL_PLANE_CONTROLLERS` is the one hand-curated allowlist this test suite has: the set of controllers whose mutating routes are, by design,
 * never reachable by any API key. A new payout/team/org-lifecycle controller needs to be added
 * here by hand — the route-coverage sweep (`org-role.route-coverage.spec.ts`) still catches it
 * if it forgets a role decorator entirely, but only THIS list catches "has @OrgRoles but
 * forgot @HumanOnly".
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { OrgRoleGuard } from './org-role.guard';
import { InsufficientKeyRoleException } from '../exceptions/insufficient-key-role.exception';
import { TeamController } from '../../modules/team/team.controller';
import { PaymentProvidersController } from '../../modules/payment-providers/payment-providers.controller';
import { StripeConnectController } from '../../modules/stripe-connect/stripe-connect.controller';

export const CONTROL_PLANE_CONTROLLERS = [
  TeamController,
  PaymentProvidersController,
  StripeConnectController,
] as const;

const MUTATING_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

interface ControlPlaneRoute {
  key: string;
  ctor: (new (...args: unknown[]) => unknown) & { name: string };
  handler: (...args: unknown[]) => unknown;
  handlerName: string;
  guardNames: string[];
  hasHumanOnly: boolean;
}

function discoverMutatingHandlers(
  ctor: (new (...args: unknown[]) => unknown) & { name: string },
): ControlPlaneRoute[] {
  const out: ControlPlaneRoute[] = [];
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctor) ?? [];
  const proto = (ctor as unknown as { prototype: Record<string, (...a: unknown[]) => unknown> })
    .prototype;
  for (const handlerName of Object.getOwnPropertyNames(proto)) {
    if (handlerName === 'constructor') continue;
    const handler = proto[handlerName];
    const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler);
    if (httpMethod === undefined || !MUTATING_METHODS.has(httpMethod)) continue;
    const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    out.push({
      key: `${ctor.name}#${handlerName}`,
      ctor,
      handler,
      handlerName,
      guardNames: [...classGuards, ...methodGuards].map(
        (g) => (g as { name?: string }).name ?? String(g),
      ),
      hasHumanOnly:
        (Reflect.getMetadata('humanOnly', handler) ?? Reflect.getMetadata('humanOnly', ctor)) ===
        true,
    });
  }
  return out;
}

const CONTROL_PLANE_ROUTES = CONTROL_PLANE_CONTROLLERS.flatMap((ctor) =>
  discoverMutatingHandlers(
    ctor as unknown as (new (...args: unknown[]) => unknown) & { name: string },
  ),
);

describe('@HumanOnly completeness — the control-plane catalog is fully decorated', () => {
  it('discovery found at least one mutating route on every catalog controller (sanity check)', () => {
    for (const ctor of CONTROL_PLANE_CONTROLLERS) {
      expect(CONTROL_PLANE_ROUTES.some((r) => r.ctor === ctor)).toBe(true);
    }
    expect(CONTROL_PLANE_ROUTES.length).toBeGreaterThan(10);
  });

  it.each(CONTROL_PLANE_ROUTES.map((r) => [r.key, r] as const))(
    '%s carries @HumanOnly',
    (_key, route) => {
      expect(route.hasHumanOnly).toBe(true);
    },
  );

  it.each(CONTROL_PLANE_ROUTES.map((r) => [r.key, r] as const))(
    '%s also carries @UseGuards(OrgRoleGuard) (else @HumanOnly is inert — see the decorator comment)',
    (_key, route) => {
      expect(route.guardNames).toContain('OrgRoleGuard');
    },
  );
});

const ALL_KEY_ROLES = ['ingest', 'member', 'developer', 'finance', 'admin', 'owner'] as const;
const ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeGuard() {
  const findFirst = jest.fn();
  const prisma = { ba_member: { findFirst } } as any;
  return { guard: new OrgRoleGuard(prisma, new Reflector()), findFirst };
}

function ctx(route: ControlPlaneRoute, user: unknown): ExecutionContext {
  return {
    getHandler: () => route.handler,
    getClass: () => route.ctor,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: { orgId: ORG_ID },
        method: 'POST',
        route: { path: `/${route.key}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

function keyUser(role: string) {
  return {
    authMethod: 'api-key' as const,
    organizationId: ORG_ID,
    userId: undefined,
    apiKeyId: 'key_ho',
    role,
  };
}

describe('@HumanOnly blocks every key role — driving the REAL guard', () => {
  for (const route of CONTROL_PLANE_ROUTES) {
    describe(route.key, () => {
      it.each(ALL_KEY_ROLES)('a same-org %s-role key gets 403', async (role) => {
        const { guard, findFirst } = makeGuard();
        await expect(guard.canActivate(ctx(route, keyUser(role)))).rejects.toThrow(
          ForbiddenException,
        );
        expect(findFirst).not.toHaveBeenCalled();
      });

      it('the admin-key block is a plain human-only 403, not a role-insufficiency error', async () => {
        const { guard } = makeGuard();
        await expect(guard.canActivate(ctx(route, keyUser('admin')))).rejects.not.toBeInstanceOf(
          InsufficientKeyRoleException,
        );
      });

      it('the owner-key block is a plain human-only 403, not a role-insufficiency error', async () => {
        const { guard } = makeGuard();
        await expect(guard.canActivate(ctx(route, keyUser('owner')))).rejects.not.toBeInstanceOf(
          InsufficientKeyRoleException,
        );
      });
    });
  }
});
