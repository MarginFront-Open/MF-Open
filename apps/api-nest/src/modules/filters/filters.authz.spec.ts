/**
 * Cross-tenant authorization proof for GET /v1/org/:orgId/filters.
 *
 * The route reads the org id from the URL. Without a guard on the controller, a membership
 * check, or org scoping, the URL org id would be the only authorization boundary: any
 * authenticated caller could substitute another organization's UUID and read that org's agents,
 * pricing plans, signals, subscriptions, and its end customers' names and email addresses.
 * Unguessable org ids are obscurity, not authorization.
 *
 * TWO holes. The guard closes the first; it does NOT close the second.
 *
 *   Part A — the metadata lock: `@UseGuards(OrgRoleGuard) @OrgRoles()` read back off the
 *   handler's own metadata. Within THIS file, Part A is the only thing binding the guard to this
 *   route. See the note below.
 *
 *   Part B — the guard's decision logic, driven for real: OrgRoleGuard.canActivate with a real
 *   Reflector and only the ba_member read stubbed.
 *
 *   Part C — the `customerId` query param. If the service used a supplied customerId verbatim
 *   and queried subscriptions by customer id with no org filter, a caller passing their OWN org
 *   id in the URL (so the guard is satisfied) plus another org's customer id would get that
 *   org's subscription rows back. Part C is the half the guard alone does not close.
 *
 * WHAT PART B DOES NOT PROVE: Part B is coverage OF THE GUARD, not of this route's wiring. It
 * constructs `new OrgRoleGuard(...)` itself and hands it a context it built, so it never reads
 * GUARDS_METADATA: revert `@UseGuards(OrgRoleGuard)` from the controller and all seven Part B
 * tests still pass. Removing `@OrgRoles()` is invisible to it as well, because the guard reads
 * that through `getAllAndOverride(...) ?? []` and an absent decorator yields the same empty array
 * an argument-less one does. The response-level proof lives in `filters.authz.http.spec.ts`,
 * which boots a real Nest app and asserts that an org-B caller gets a 403 carrying no
 * `customers` key.
 *
 * Why Part C's assertions can actually fail: it drives the real FiltersService against an
 * in-memory Prisma fake that models Prisma's real "a where-field of undefined is dropped"
 * semantics, the exact trap that makes a careless org filter a no-op. Parts A and C go red if
 * the guard or the org-scoped customer lookup is removed.
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { OrgIdParamUuidGuard } from '../../common/guards/org-id-param-uuid.guard';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { GetFiltersDto } from './filters.dto';

/** ORG_A = the victim named in the URL. ORG_B = the attacker's own, legitimate org. */
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ATTACKER_USER_ID = 'attacker-user';

const handler = (FiltersController.prototype as any).getFilters;

// ---------------------------------------------------------------------------
// Part A — metadata lock.
// ---------------------------------------------------------------------------

describe('the filters GET carries OrgRoleGuard + a member-floor role decorator', () => {
  // This lock matters more than it looks: org-role.route-coverage.spec.ts deliberately skips
  // GET routes, and org-role.privileged-read.spec.ts is a hand-listed catalog. Without
  // org-id-param.route-sweep.spec.ts and filters.authz.http.spec.ts, nothing in CI would
  // notice this decorator disappearing.
  it('the handler carries @UseGuards(OrgRoleGuard)', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(guards).toContain(OrgRoleGuard);
  });

  it('OrgIdParamUuidGuard is listed BEFORE OrgRoleGuard, because that order is the fix', () => {
    // Route-scoped guards execute in listed order. Behind OrgRoleGuard this guard is decorative:
    // the P2023-to-500 it prevents is raised by OrgRoleGuard's own ba_member query, which would
    // already have run. filters.authz.http.spec.ts proves the resulting 400 over HTTP; this pins
    // the ordering so a reshuffle is caught even if that file is skipped.
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(guards).toContain(OrgIdParamUuidGuard);
    expect(guards.indexOf(OrgIdParamUuidGuard)).toBeLessThan(guards.indexOf(OrgRoleGuard));
  });

  it('the handler is member-floor: @OrgRoles() with no arguments', () => {
    // Matches what the dashboard's own Server Action equivalent gates on (an authenticated
    // session with an active org). Raising this above member floor is a separate decision.
    expect(Reflect.getMetadata('orgRoles', handler)).toEqual([]);
  });

  it('the handler does NOT carry @OrgFromUser — the guard must judge the URL org, not the caller reflected back', () => {
    // With @OrgFromUser the guard judges the CALLER'S own org and ignores the URL, but the
    // handler still binds @Param('orgId') and passes it to the service. The pairing therefore
    // clears org B while serving org A: a 200 carrying the VICTIM org's data, which is this
    // cross-org leak rather than a harmless self-read.
    expect(Reflect.getMetadata('orgFromUser', handler)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part B — behavior, through the real guard.
// ---------------------------------------------------------------------------

type AnyUser = Record<string, unknown>;

function ctxFor(user: AnyUser, orgIdInUrl: string): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => FiltersController,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: { orgId: orgIdInUrl },
        method: 'GET',
        route: { path: '/v1/org/:orgId/filters' },
      }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * The REAL guard with a REAL Reflector, so the decorators applied in filters.controller.ts are
 * what drives the decision. Only the ba_member read is stubbed.
 */
function realGuard(membershipInUrlOrg: { role: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(membershipInUrlOrg);
  const prisma = { ba_member: { findFirst } } as any;
  return { guard: new OrgRoleGuard(prisma, new Reflector()), findFirst };
}

const attackerSession: AnyUser = {
  authMethod: 'session',
  userId: ATTACKER_USER_ID,
  organizationId: ORG_B,
};

const attackerKey: AnyUser = {
  authMethod: 'api-key',
  organizationId: ORG_B,
  userId: undefined,
  apiKeyId: 'key_attacker',
  role: 'owner',
};

// READ THIS BEFORE TRUSTING PART B AS A ROUTE TEST. Everything below instantiates the guard
// directly and calls canActivate on a context built here, so it describes what OrgRoleGuard
// DECIDES, not what this route DOES. Reverting `@UseGuards(OrgRoleGuard)` from
// filters.controller.ts leaves all seven of these green. Part A catches that edit through
// GUARDS_METADATA, filters.authz.http.spec.ts catches it through a real 403 over HTTP, and
// org-id-param.route-sweep.spec.ts catches it as an unguarded org-id route. Part B's value is
// that it pins the guard's per-caller decisions so a future change to the guard cannot quietly
// re-open this route; that is coverage of the guard, not a wiring proof.
describe('a caller who does not belong to :orgId is refused', () => {
  it('a signed-in user of org B, with org A in the URL, gets a 403 and org A rows are never fetched', async () => {
    const { guard, findFirst } = realGuard(null);
    await expect(guard.canActivate(ctxFor(attackerSession, ORG_A))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The membership question is asked about the TARGET org from the URL, not the caller's own.
    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, userId: ATTACKER_USER_ID },
      select: { role: true },
    });
  });

  it('an owner-role API key belonging to org B, with org A in the URL, gets a 403 with no DB lookup at all', async () => {
    const { guard, findFirst } = realGuard(null);
    await expect(guard.canActivate(ctxFor(attackerKey, ORG_A))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Tenant isolation on the key path is decided before any role or flag is read.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('a portal session (an end customer, never an org member) gets a 403', async () => {
    const { guard } = realGuard(null);
    const portal: AnyUser = { authMethod: 'portal', organizationId: ORG_A };
    await expect(guard.canActivate(ctxFor(portal, ORG_A))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a human whose token carries no user id fails closed rather than matching the first member of the target org', async () => {
    const { guard } = realGuard({ role: 'owner' });
    const nameless: AnyUser = { authMethod: 'session', userId: undefined, organizationId: ORG_B };
    await expect(guard.canActivate(ctxFor(nameless, ORG_A))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('legitimate callers are untouched', () => {
  it('a signed-in member reading their OWN active org is allowed without a DB round trip', async () => {
    const { guard, findFirst } = realGuard(null);
    const insider: AnyUser = {
      authMethod: 'session',
      userId: 'insider',
      organizationId: ORG_A,
    };
    await expect(guard.canActivate(ctxFor(insider, ORG_A))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('a multi-org human whose active org is B but who IS a member of A is allowed on A', async () => {
    // Access must not reduce to "your active org only": a real member of two orgs keeps access.
    const { guard } = realGuard({ role: 'member' });
    await expect(guard.canActivate(ctxFor(attackerSession, ORG_A))).resolves.toBe(true);
  });

  it('an API key reading its OWN org is allowed', async () => {
    const { guard } = realGuard(null);
    const ownKey: AnyUser = { ...attackerKey, organizationId: ORG_A };
    await expect(guard.canActivate(ctxFor(ownKey, ORG_A))).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part C — the hole the guard does not close: a foreign customerId.
// ---------------------------------------------------------------------------

const CUSTOMER_A = 'cccccccc-aaaa-aaaa-aaaa-cccccccccccc';
const CUSTOMER_B = 'cccccccc-bbbb-bbbb-bbbb-cccccccccccc';

const CUSTOMER_ROWS = [
  { id: CUSTOMER_A, organizationId: ORG_A },
  { id: CUSTOMER_B, organizationId: ORG_B },
];

const SUBSCRIPTION_ROWS = [
  { id: 'sub-a', name: "Org A's subscription", customerId: CUSTOMER_A },
  { id: 'sub-b', name: "Org B's subscription", customerId: CUSTOMER_B },
];

/**
 * An in-memory stand-in for the two tables this branch touches. It reproduces the Prisma
 * behavior that makes this bug class subtle: a `where` field whose value is `undefined` is
 * DROPPED, not matched against null. An org filter that leaves `id: undefined` in the `where`
 * therefore scopes nothing, and this fake is what would catch that.
 */
function fakePrisma() {
  const customersFindMany = jest.fn(
    async ({ where }: { where: { organizationId?: string; id?: string } }) =>
      CUSTOMER_ROWS.filter(
        (row) =>
          (where.organizationId === undefined || row.organizationId === where.organizationId) &&
          (where.id === undefined || row.id === where.id),
      ).map((row) => ({ id: row.id })),
  );
  const subscriptionsFindMany = jest.fn(
    async ({ where }: { where: { customerId: { in: string[] } } }) =>
      SUBSCRIPTION_ROWS.filter((row) => where.customerId.in.includes(row.customerId)),
  );
  const prisma = {
    customers: { findMany: customersFindMany },
    subscriptions: { findMany: subscriptionsFindMany },
  } as any;
  return { service: new FiltersService(prisma), customersFindMany, subscriptionsFindMany };
}

const subscriptionsOnly = (customerId?: string) =>
  ({ dataTypes: ['subscriptions'], ...(customerId && { customerId }) }) as GetFiltersDto;

describe("a foreign customerId cannot reach another org's subscriptions", () => {
  it("org A's own caller, passing org B's customer id, gets ZERO rows instead of org B's subscriptions", async () => {
    const { service, customersFindMany, subscriptionsFindMany } = fakePrisma();

    const result = await service.getFilters(ORG_A, subscriptionsOnly(CUSTOMER_B));

    // Org B's row must not come back.
    expect(result.subscriptions).toEqual([]);
    // A thrown stub would ALSO produce an empty list (the branch swallows errors into
    // result.errors), so an empty array alone would be a worthless assertion. Pin both.
    expect(result.errors).toBeUndefined();
    // The customer id is resolved through the ORG-SCOPED customers table, never trusted.
    expect(customersFindMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, id: CUSTOMER_B },
      select: { id: true },
    });
    expect(subscriptionsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ customerId: { in: [] } }) }),
    );
  });

  it("org A's own caller, passing org A's customer id, still gets that customer's subscription", async () => {
    const { service } = fakePrisma();
    const result = await service.getFilters(ORG_A, subscriptionsOnly(CUSTOMER_A));
    expect(result.subscriptions).toEqual([SUBSCRIPTION_ROWS[0]]);
    expect(result.errors).toBeUndefined();
  });

  it('with no customerId, org A sees only its own subscriptions', async () => {
    // Also the plainest statement of why the Part A/B guard is load-bearing: the service takes
    // an org id and a query, never a caller, so it CANNOT know whether that org id belongs to
    // whoever is asking. It hands over whatever org it is named. Nothing downstream of the
    // controller would notice @UseGuards(OrgRoleGuard) being deleted.
    const { service } = fakePrisma();
    const result = await service.getFilters(ORG_A, subscriptionsOnly());
    expect(result.subscriptions).toEqual([SUBSCRIPTION_ROWS[0]]);
    expect(result.errors).toBeUndefined();
  });

  it("org B's own caller sees org B's subscription and nothing of org A's", async () => {
    const { service } = fakePrisma();
    const result = await service.getFilters(ORG_B, subscriptionsOnly());
    expect(result.subscriptions).toEqual([SUBSCRIPTION_ROWS[1]]);
    expect(result.errors).toBeUndefined();
  });
});
