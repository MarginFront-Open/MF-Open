/**
 * Unit proof of the legal-role key-scope boundary, a structural twin of
 * ingest-key-scope.guard.spec.ts one role up.
 *
 * Drives the REAL LegalKeyScopeGuard against a probe controller carrying the REAL
 * decorators. What this file pins:
 *   1. The guard acts ONLY on an api-key request whose parsed role is 'legal'. No user,
 *      a session/JWT/portal token, and every other key role (ingest, member, developer,
 *      finance, admin, owner) pass untouched — even on an undecorated route.
 *   2. parseKeyRole can only floor a malformed permissions blob to 'ingest', never to
 *      'legal', so a role-'legal' user is always a well-formed mint.
 *   3. The allow surface for a legal key: an @OrgRoles(...) list that names 'legal', the
 *      @IngestRoute usage POSTs, the @IngestKeyAllowed identity/ops doors, and @Public.
 *      An EMPTY @OrgRoles() — the any-member read floor every other key inherits — does
 *      NOT clear this guard; that is the load-bearing behavior the guard exists
 *      to add.
 *   4. The 403 body: the reused insufficient_key_role code, empty required_roles, and
 *      the key's actual role, rendered from the LEGAL exception's own copy.
 *   5. The denial log line fires on deny only (ids only, no key material), never on any
 *      allow path.
 */

import 'reflect-metadata';
import { CanActivate, ExecutionContext, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LegalKeyScopeGuard } from './legal-key-scope.guard';
import { LegalKeyScopeForbiddenException } from '../exceptions/legal-key-scope-forbidden.exception';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { INGEST_ROUTE_KEY, ORG_ROLES_KEY } from './route-metadata-keys';
import { IngestKeyAllowed } from './ingest-key-scope.guard';

// The real @OrgRoles and @IngestRoute live in org-role.guard.ts, which imports
// @marginfront/db at module load — this spec must stay bootable without a built dist, so it
// applies the SAME shared metadata keys directly, exactly like the ingest twin's spec.
// Equivalent by construction; the route-sweep spec proves the real decorators on the
// real controllers.
const OrgRoles = (...roles: string[]) => SetMetadata(ORG_ROLES_KEY, roles);
const IngestRoute = () => SetMetadata(INGEST_ROUTE_KEY, true);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

class ProbeController {
  @OrgRoles('owner', 'admin', 'finance', 'legal')
  lawRoute() {}

  @OrgRoles()
  emptyOrgRoles() {}

  @OrgRoles('owner', 'admin', 'finance')
  orgRolesWithoutLegal() {}

  @IngestRoute()
  ingestUsagePost() {}

  @IngestKeyAllowed()
  allowed() {}

  @Public()
  open() {}

  unmarked() {}
}

type UserShape = Record<string, unknown> | undefined;

function ctxFor(
  handlerName: keyof ProbeController,
  user: UserShape,
  method = 'GET',
): ExecutionContext {
  return {
    getHandler: () => ProbeController.prototype[handlerName],
    getClass: () => ProbeController,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        method,
        route: { path: `/v1/probe/${String(handlerName)}` },
        url: `/v1/probe/${String(handlerName)}?period=month&secret=SHOULD_NEVER_APPEAR`,
      }),
    }),
  } as unknown as ExecutionContext;
}

/** A secret key whose api_keys row parsed role is 'legal'. */
const explicitLegalUser = {
  authMethod: 'api-key',
  keyType: 'secret',
  organizationId: ORG_ID,
  apiKeyId: 'key_legal_probe',
  role: 'legal',
};

function makeGuard() {
  return new LegalKeyScopeGuard(new Reflector());
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('no principal or non-api-key auth passes untouched', () => {
  const passThroughUsers: Array<[string, UserShape]> = [
    ['unauthenticated (no user)', undefined],
    ['session', { authMethod: 'session', userId: 'u1', organizationId: ORG_ID }],
    ['jwt', { authMethod: 'jwt', userId: 'u1', organizationId: ORG_ID }],
    ['portal', { authMethod: 'portal', organizationId: ORG_ID }],
  ];

  it.each(passThroughUsers)('%s passes even an undecorated route', (_label, user) => {
    expect(makeGuard().canActivate(ctxFor('unmarked', user))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a HUMAN session that carries role 'legal' still passes — role belongs to api keys, and confining a session would lock a human out of their own dashboard", () => {
    const humanUser = {
      authMethod: 'session',
      userId: 'u1',
      organizationId: ORG_ID,
      role: 'legal',
    };
    expect(makeGuard().canActivate(ctxFor('unmarked', humanUser))).toBe(true);
  });
});

describe('every OTHER key role passes untouched, no metadata read needed', () => {
  const otherKeyRoles = ['ingest', 'member', 'developer', 'finance', 'admin', 'owner'];

  it.each(otherKeyRoles)("a '%s'-role key passes even an undecorated route", (role) => {
    const user = { ...explicitLegalUser, role };
    expect(makeGuard().canActivate(ctxFor('unmarked', user))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an api-key user with no role at all passes untouched', () => {
    const user = { authMethod: 'api-key', organizationId: ORG_ID, apiKeyId: 'key_x' };
    expect(makeGuard().canActivate(ctxFor('unmarked', user))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('the Law surface — an @OrgRoles list naming legal', () => {
  it("an @OrgRoles list that includes 'legal' allows", () => {
    expect(makeGuard().canActivate(ctxFor('lawRoute', explicitLegalUser))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an EMPTY @OrgRoles() — the any-member read floor — does NOT allow: that is the load-bearing behavior of the whole guard', () => {
    expect(() => makeGuard().canActivate(ctxFor('emptyOrgRoles', explicitLegalUser))).toThrow(
      LegalKeyScopeForbiddenException,
    );
  });

  it("an @OrgRoles list that does not name 'legal' denies", () => {
    expect(() =>
      makeGuard().canActivate(ctxFor('orgRolesWithoutLegal', explicitLegalUser)),
    ).toThrow(LegalKeyScopeForbiddenException);
  });
});

describe('the two shared allow doors plus @Public', () => {
  it('an @IngestRoute usage POST allows — the firm recording its own billable usage is the intended use of a legal key', () => {
    expect(makeGuard().canActivate(ctxFor('ingestUsagePost', explicitLegalUser, 'POST'))).toBe(
      true,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an @IngestKeyAllowed identity/ops door allows — the surface the weakest key already reaches', () => {
    expect(makeGuard().canActivate(ctxFor('allowed', explicitLegalUser))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a @Public route allows (defensive — auth never sets user there today)', () => {
    expect(makeGuard().canActivate(ctxFor('open', explicitLegalUser))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('the 403 on an undecorated route', () => {
  function denialBody(): Record<string, unknown> {
    try {
      makeGuard().canActivate(ctxFor('unmarked', explicitLegalUser));
    } catch (err) {
      return (err as LegalKeyScopeForbiddenException).getResponse() as Record<string, unknown>;
    }
    throw new Error('the guard did not deny');
  }

  it('throws LegalKeyScopeForbiddenException, not some other error', () => {
    expect(() => makeGuard().canActivate(ctxFor('unmarked', explicitLegalUser))).toThrow(
      LegalKeyScopeForbiddenException,
    );
  });

  it('the body reuses insufficient_key_role at statusCode 403', () => {
    const body = denialBody();
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('required_roles is EMPTY — same contract as the ingest twin: a populated list would send the customer to mint a key that 403s again', () => {
    expect(denialBody().required_roles).toEqual([]);
  });

  it("key_role names the role the key actually carries, rendered from the LEGAL exception's own copy (not a copy-paste of the ingest message)", () => {
    const body = denialBody();
    expect(body.key_role).toBe('legal');
    expect(String(body.message)).toContain("role is 'legal'");
    expect(String(body.message)).toContain('manage matters');
  });
});

describe('the denial log line', () => {
  it('names the key and the bare route, and carries no key material', () => {
    try {
      makeGuard().canActivate(ctxFor('unmarked', explicitLegalUser));
    } catch {
      // the throw is asserted elsewhere; this test reads the log line
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('[legal-key-scope] denied');
    expect(line).toContain('keyId=key_legal_probe');
    expect(line).toContain('route="GET /v1/probe/unmarked"');
    expect(line).not.toMatch(/mf_(sk|pk)_/);
    // Query strings can carry PII/secrets — the logged route must be the bare path.
    expect(line).not.toContain('SHOULD_NEVER_APPEAR');
  });

  it('falls back to the query-stripped url when route.path is absent', () => {
    const ctx = {
      getHandler: () => ProbeController.prototype.unmarked,
      getClass: () => ProbeController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: explicitLegalUser,
          method: 'GET',
          url: '/v1/probe/unmarked?secret=SHOULD_NEVER_APPEAR',
        }),
      }),
    } as unknown as ExecutionContext;
    expect(() => makeGuard().canActivate(ctx)).toThrow(LegalKeyScopeForbiddenException);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('route="GET /v1/probe/unmarked"');
    expect(line).not.toContain('SHOULD_NEVER_APPEAR');
  });
});

describe('negative control — proves this suite can go red', () => {
  it('a pass-everything stand-in would let a legal key read the undecorated route where the real guard blocks it', () => {
    const preFixBehavior: CanActivate = { canActivate: () => true };
    expect(preFixBehavior.canActivate(ctxFor('unmarked', explicitLegalUser))).toBe(true);
    expect(() => makeGuard().canActivate(ctxFor('unmarked', explicitLegalUser))).toThrow(
      LegalKeyScopeForbiddenException,
    );
  });
});
