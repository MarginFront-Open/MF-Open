/**
 * The wiring proof for GET /v1/org/:orgId/filters, over a real booted Nest app.
 * Same harness family as common/guards/publishable-key-read.guard.http.spec.ts.
 *
 * WHY THIS FILE EXISTS. filters.authz.spec.ts Part B constructs `new OrgRoleGuard(...)`
 * itself and calls canActivate on a hand-built context. That proves the guard's decision LOGIC,
 * and nothing at all about whether the guard is MOUNTED on this route: delete
 * `@UseGuards(OrgRoleGuard)` from the controller and all seven of those tests still pass, because
 * none of them reads GUARDS_METADATA. Deleting `@OrgRoles()` is invisible to them too — the guard
 * reads it through `getAllAndOverride(...) ?? []`, and an absent decorator yields the same empty
 * array an argument-less one does. Part A is a metadata lock, which is real but is a lock on a
 * decorator, not on a response.
 *
 * Here the request goes through Nest's own guard chain against the real controller with its real
 * decorators, so the question asked is the one that matters: what does an org-B caller
 * GET back when they put org A in the URL. Both halves of that are asserted — the 403 status AND
 * the absence of a `customers` key in the body, because a status assertion alone cannot tell a
 * 403 apart from a 200 carrying an empty result, and "empty result" is exactly what a broken org
 * check looks like.
 *
 * The 200 control case is load-bearing for the same reason in the other direction: without it,
 * every 403 above would also pass against a route that was simply broken.
 */

import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/** ORG_A = the victim named in the URL. ORG_B = the attacker's own, legitimate org. */
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** The payload a successful call returns. Its `customers` key is what must never leak. */
const FILTER_PAYLOAD = {
  customers: [{ id: 'cust-a', name: 'Org A Customer', email: 'someone@example.com' }],
  agents: [],
};

/**
 * Stands in for CombinedAuthGuard at the same position in the chain (first provider of an
 * imported module), so the route-scoped guards under test run after it exactly as in production.
 * The actor shapes mirror what CombinedAuthGuard really builds: a portal session carries the
 * VENDOR org's id and no userId (see combined-auth.guard.ts).
 */
const ACTORS: Record<string, Record<string, unknown>> = {
  'human-org-a': { authMethod: 'session', userId: 'human-a', organizationId: ORG_A },
  'human-org-b': { authMethod: 'session', userId: 'human-b', organizationId: ORG_B },
  'portal-org-a': { authMethod: 'portal', userId: undefined, organizationId: ORG_A },
};

@Injectable()
class HeaderAuthStubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const actor = ACTORS[request.headers['x-test-actor']];
    if (actor) {
      request.user = actor;
    }
    return true;
  }
}

@Module({ providers: [{ provide: APP_GUARD, useClass: HeaderAuthStubGuard }] })
class AuthStubModule {}

describe('org-id-from-the-URL authorization over HTTP: GET /v1/org/:orgId/filters', () => {
  let app: INestApplication;
  let getFilters: jest.Mock;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    getFilters = jest.fn().mockResolvedValue(FILTER_PAYLOAD);
    // No ba_member row for anyone: the only caller who should get through is the one whose
    // ACTIVE org is already org A, via the guard's member fast-path.
    findFirst = jest.fn().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      imports: [AuthStubModule],
      controllers: [FiltersController],
      providers: [
        { provide: FiltersService, useValue: { getFilters } },
        { provide: PrismaService, useValue: { ba_member: { findFirst } } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.listen(0);
  });

  afterEach(async () => {
    await app.close();
  });

  async function get(orgIdInUrl: string, actor: string) {
    const response = await fetch(`${await app.getUrl()}/v1/org/${orgIdInUrl}/filters`, {
      headers: { 'x-test-actor': actor },
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  }

  it("a member of org A reading org A gets 200 and the org's filter data", async () => {
    const { status, body } = await get(ORG_A, 'human-org-a');
    expect(status).toBe(200);
    expect(body.customers).toEqual(FILTER_PAYLOAD.customers);
    expect(getFilters).toHaveBeenCalledTimes(1);
  });

  it('a signed-in user of org B reading org A gets 403 with NO customers in the body', async () => {
    const { status, body } = await get(ORG_A, 'human-org-b');
    expect(status).toBe(403);
    // The assertion that separates a real refusal from a fix that returns an empty list.
    expect(body).not.toHaveProperty('customers');
    expect(getFilters).not.toHaveBeenCalled();
    // The membership question was asked about the org in the URL, not the caller's own.
    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, userId: 'human-b' },
      select: { role: true },
    });
  });

  it('a portal session (an end customer) reading its vendor org gets 403 with NO customers', async () => {
    const { status, body } = await get(ORG_A, 'portal-org-a');
    expect(status).toBe(403);
    expect(body).not.toHaveProperty('customers');
    expect(getFilters).not.toHaveBeenCalled();
  });

  it('a malformed org id gets a clean 400 and never reaches the membership query', async () => {
    // Without OrgIdParamUuidGuard this is a 500: ba_member.organizationId is @db.Uuid
    // (packages/db/prisma/schema.prisma), Prisma raises P2023, and it lands in Sentry.
    // findFirst not having been called is what proves the shape guard ran BEFORE OrgRoleGuard.
    const { status, body } = await get('not-a-uuid', 'human-org-b');
    expect(status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(getFilters).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty('customers');
  });

  it('an unauthenticated request never reaches the filter data either', async () => {
    // The stub leaves request.user unset, which is what an anonymous caller looks like to the
    // route-scoped guards. OrgRoleGuard's own no-user branch (org-role.guard.ts)
    // answers 403 rather than falling through to a 200.
    const { status } = await get(ORG_A, 'nobody');
    expect(status).toBe(403);
    expect(getFilters).not.toHaveBeenCalled();
  });
});
