/**
 * Api-key ROLE ENFORCEMENT proof test.
 *
 * What this file proves: the api-key branch of OrgRoleGuard enforces the key's role on every
 * request, and — the load-bearing guarantee — that usage INGEST can never be collateral of a
 * corrupt or role-less permissions blob.
 *
 * Why it is trustworthy (it can FAIL): it drives the REAL OrgRoleGuard.canActivate against
 * REAL @IngestRoute/@HumanOnly/@OrgRoles decorators read through a REAL Nest Reflector, throws
 * the REAL InsufficientKeyRoleException, and floors the corrupt blob through the REAL
 * parseKeyRole. The ONLY stub is the thing that is not the unit under test: ba_member.findFirst
 * (which must NEVER be hit on the api-key path). Nothing about the authorization decision
 * itself is mocked.
 */

import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard, OrgRoles, IngestRoute, HumanOnly } from './org-role.guard';
import { InsufficientKeyRoleException } from '../exceptions/insufficient-key-role.exception';
import { MANAGE_BUILD_ROLES, MANAGE_MONEY_ROLES, ORG_MANAGE_ROLES } from '@marginfront/db';
import { parseKeyRole } from '@marginfront/db';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // the key's OWN org
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // a DIFFERENT org (cross-tenant)

// Every role a key can carry, floor to ceiling.
const ALL_KEY_ROLES = ['ingest', 'member', 'developer', 'finance', 'admin', 'owner'] as const;

/**
 * A controller carrying the REAL decorators on its methods. The guard reads their metadata
 * through a real Reflector — so this exercises the decorators, not a hand-rolled stub of them.
 */
class KeyEnforcementTestRoutes {
  @IngestRoute()
  ingest() {}

  @HumanOnly()
  @OrgRoles(...ORG_MANAGE_ROLES)
  humanOnly() {}

  @OrgRoles(...MANAGE_BUILD_ROLES) // owner/admin/developer
  buildWrite() {}

  @OrgRoles(...MANAGE_MONEY_ROLES) // owner/admin/finance
  moneyWrite() {}

  @OrgRoles() // read-open: any member-and-above
  readOpen() {}
}

type HandlerName = 'ingest' | 'humanOnly' | 'buildWrite' | 'moneyWrite' | 'readOpen';

function makeGuard() {
  const findFirst = jest.fn();
  const prisma = { ba_member: { findFirst } } as any;
  const guard = new OrgRoleGuard(prisma, new Reflector());
  return { guard, findFirst };
}

function keyUser(role: string, org = ORG_A) {
  return {
    authMethod: 'api-key' as const,
    organizationId: org,
    userId: undefined,
    apiKeyId: 'key_test_123',
    role,
  };
}

/** A key whose `role` field counts how many times it is read — proves ordering. */
function keyUserWithRoleSpy(role: string, org = ORG_A) {
  let reads = 0;
  const user: any = {
    authMethod: 'api-key',
    organizationId: org,
    userId: undefined,
    apiKeyId: 'key_spy',
  };
  Object.defineProperty(user, 'role', {
    get() {
      reads++;
      return role;
    },
    enumerable: true,
    configurable: true,
  });
  return { user, reads: () => reads };
}

function ctx(
  handler: HandlerName,
  user: any,
  params: Record<string, string> = { orgId: ORG_A },
  requestOverrides: Record<string, unknown> = {},
) {
  const fn = (KeyEnforcementTestRoutes.prototype as any)[handler];
  return {
    getHandler: () => fn,
    getClass: () => KeyEnforcementTestRoutes,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params,
        method: 'POST',
        route: { path: `/test/${handler}` },
        ...requestOverrides,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('OrgRoleGuard — api-key role enforcement', () => {
  describe('the key role is always enforced', () => {
    it('denies a same-org member key on a build write', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('buildWrite', keyUser('member')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });

    it('allows a developer key on a build write and an ingest key on ingest, with NO membership lookup', async () => {
      const { guard, findFirst } = makeGuard();
      await expect(guard.canActivate(ctx('buildWrite', keyUser('developer')))).resolves.toBe(true);
      await expect(guard.canActivate(ctx('ingest', keyUser('ingest')))).resolves.toBe(true);
      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  describe('cross-tenant is hard-blocked', () => {
    it.each([...ALL_KEY_ROLES])(
      'blocks a cross-org %s key (tenant isolation never loosens)',
      async (role) => {
        const { guard } = makeGuard();
        const attacker = keyUser(role, ORG_B); // key belongs to B, request targets A
        await expect(
          guard.canActivate(ctx('buildWrite', attacker, { orgId: ORG_A })),
        ).rejects.toThrow(ForbiddenException);
      },
    );
  });

  describe('@IngestRoute short-circuits BEFORE the role is read', () => {
    it('allows an ingest-floor key on the ingest route without reading user.role', async () => {
      const { guard } = makeGuard();
      const { user, reads } = keyUserWithRoleSpy('ingest');
      await expect(guard.canActivate(ctx('ingest', user))).resolves.toBe(true);
      expect(reads()).toBe(0);
    });
  });

  describe('corrupt-blob key — the single load-bearing test', () => {
    // Feed a shape-broken permissions blob through the REAL parser: it floors to ingest.
    const corruptRole = parseKeyRole({ totally: 'not a role field' } as unknown);

    it('the corrupt blob floors to the ingest role (parseKeyRole contract)', () => {
      expect(corruptRole).toBe('ingest');
    });

    it('gets 200 (allow) on the ingest route', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('ingest', keyUser(corruptRole)))).resolves.toBe(true);
    });

    it('gets 403 (InsufficientKeyRoleException) on a non-ingest write', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('buildWrite', keyUser(corruptRole)))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });
  });

  describe('@HumanOnly blocks EVERY key role — admin and owner included', () => {
    it.each([...ALL_KEY_ROLES])('blocks a %s key', async (role) => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('humanOnly', keyUser(role)))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('the owner-key block is a plain human-only 403, not a role-insufficiency error', async () => {
      const { guard } = makeGuard();
      await expect(
        guard.canActivate(ctx('humanOnly', keyUser('owner'))),
      ).rejects.not.toBeInstanceOf(InsufficientKeyRoleException);
    });
  });

  describe('the role-sufficiency gate', () => {
    it('allows a developer key on a build write (developer ∈ MANAGE_BUILD_ROLES)', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('buildWrite', keyUser('developer')))).resolves.toBe(true);
    });

    it('denies a developer key on a money write (403)', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('moneyWrite', keyUser('developer')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });

    it('denies a finance key on a build write (403)', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('buildWrite', keyUser('finance')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });

    it('allows a finance key on a money write', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('moneyWrite', keyUser('finance')))).resolves.toBe(true);
    });

    it('allows a member key on a read-open route but denies it on a build write', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('readOpen', keyUser('member')))).resolves.toBe(true);
      await expect(guard.canActivate(ctx('buildWrite', keyUser('member')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });

    it('denies an ingest key even on a read-open route (floor sits below member)', async () => {
      const { guard } = makeGuard();
      await expect(guard.canActivate(ctx('readOpen', keyUser('ingest')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );
    });
  });

  describe('the denial log line', () => {
    // A 403 (InsufficientKeyRoleException) produces no Sentry issue (SentryGlobalFilter
    // forwards only non-HttpException 5xx), so the guard logs every denial BEFORE throwing.
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('a denial logs the key, route and roles, and THEN throws the 403', async () => {
      const { guard } = makeGuard();

      await expect(guard.canActivate(ctx('moneyWrite', keyUser('developer')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );

      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain('[api-key-role] denied keyId=key_test_123');
      expect(line).toContain('carriedRole=developer');
      expect(line).toContain('route="POST /test/moneyWrite"');
      expect(line).toContain(`requiredRoles=[${MANAGE_MONEY_ROLES.join(',')}]`);
    });

    it('the ingest-floor denial (read-open route) is logged too', async () => {
      const { guard } = makeGuard();

      await expect(guard.canActivate(ctx('readOpen', keyUser('ingest')))).rejects.toThrow(
        InsufficientKeyRoleException,
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('carriedRole=ingest');
    });

    it('an allowed request logs nothing', async () => {
      const { guard } = makeGuard();

      await expect(guard.canActivate(ctx('moneyWrite', keyUser('finance')))).resolves.toBe(true);

      expect(warn).not.toHaveBeenCalled();
    });

    it('strips the query string from the raw-url route fallback (query params can carry secrets/PII)', async () => {
      const { guard } = makeGuard();
      const context = ctx(
        'moneyWrite',
        keyUser('developer'),
        { orgId: ORG_A },
        // No parameterized route.path (e.g. a bare Express layer) — the guard falls back to
        // request.url, which arrives WITH its query string.
        { route: undefined, url: '/test/moneyWrite?apiKey=mf_sk_oops&email=a@bco.example' },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(InsufficientKeyRoleException);

      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain('route="POST /test/moneyWrite"');
      expect(line).not.toContain('apiKey=');
    });
  });

  describe('InsufficientKeyRoleException — the client-facing envelope', () => {
    it('carries statusCode, code, required_roles and key_role', async () => {
      const { guard } = makeGuard();
      let caught: InsufficientKeyRoleException | undefined;
      try {
        await guard.canActivate(ctx('buildWrite', keyUser('finance')));
      } catch (e) {
        caught = e as InsufficientKeyRoleException;
      }
      expect(caught).toBeInstanceOf(InsufficientKeyRoleException);
      expect(caught!.getStatus()).toBe(403);
      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        statusCode: 403,
        code: 'insufficient_key_role',
        required_roles: [...MANAGE_BUILD_ROLES],
        key_role: 'finance',
      });
      expect(typeof body.message).toBe('string');
    });
  });
});
