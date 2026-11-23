/**
 * Unit proof of the ingest-role boundary.
 *
 * Drives the REAL IngestKeyScopeGuard against a probe controller carrying the REAL
 * decorators. What this file pins:
 *   1. An EXPLICIT ingest-role key on an UNMARKED route is refused, on every HTTP
 *      method. Only @IngestKeyAllowed, @IngestRoute, and @Public let one through.
 *   2. parseKeyRole floors null / [] / {} / an unrecognized role to 'ingest', and a key
 *      in that state is refused exactly like one minted ingest-only.
 *   3. The 403 body: the reused insufficient_key_role code the MCP branches on, the role
 *      the key carries, what an ingest key CAN do, and where to get a better key.
 *   4. The guard is a key-ROLE boundary only: sessions, JWTs, portal tokens, every role
 *      above ingest, and unauthenticated requests pass untouched.
 *   5. The log line never carries key material or a query string.
 */

import 'reflect-metadata';
import { ExecutionContext, CanActivate, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IngestKeyScopeGuard, IngestKeyAllowed } from './ingest-key-scope.guard';
import { IngestKeyScopeForbiddenException } from '../exceptions/ingest-key-scope-forbidden.exception';
import { InsufficientKeyRoleException } from '../exceptions/insufficient-key-role.exception';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';
import { parseKeyRole } from '@marginfront/db';

// The real @IngestRoute lives in org-role.guard.ts, which imports @marginfront/db at module
// load — this spec must stay bootable without a built dist, so it applies the SAME
// shared metadata key directly. Equivalent by construction; the route-sweep spec proves
// the real decorator on the real controllers.
const IngestRoute = () => SetMetadata(INGEST_ROUTE_KEY, true);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

class ProbeController {
  @IngestKeyAllowed()
  allowed() {}

  @Public()
  open() {}

  @IngestRoute()
  ingest() {}

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

/** A secret key whose api_keys row LITERALLY states {"role":"ingest"}. */
const explicitIngestUser = {
  authMethod: 'api-key',
  keyType: 'secret',
  organizationId: ORG_ID,
  apiKeyId: 'key_ingest_probe',
  role: 'ingest',
};

function makeGuard() {
  return new IngestKeyScopeGuard(new Reflector());
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('deny by default for an EXPLICIT ingest role', () => {
  it('an UNMARKED route refuses an explicit ingest key', () => {
    expect(() => makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser))).toThrow(
      IngestKeyScopeForbiddenException,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'the deny fires on %s — most exposed routes are GETs, and POST /v1/portal-sessions would mint a portal token',
    (method) => {
      expect(() => makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser, method))).toThrow(
        IngestKeyScopeForbiddenException,
      );
    },
  );

  it('is NOT an InsufficientKeyRoleException — OrgRoleGuard owns that class; this is a separate, always-on boundary', () => {
    let thrown: unknown;
    try {
      makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IngestKeyScopeForbiddenException);
    expect(thrown).not.toBeInstanceOf(InsufficientKeyRoleException);
  });
});

describe('a key whose permissions state no recognized role is confined like an ingest key', () => {
  /**
   * Every permissions shape parseKeyRole floors to 'ingest'. parseKeyRole is what
   * auth.service.ts runs on the same blob, so the guard's input here is the one
   * production computes.
   */
  const flooredBlobs: Array<[string, unknown]> = [
    ['null', null],
    ['[] (the Prisma column default)', []],
    ['{}', {}],
    ['a string-array permissions blob', ['read:pricing', 'read:public']],
    ['an object with no role field', { minterUserId: 'u1' }],
    ['an empty role string', { role: '' }],
    ['an UNRECOGNIZED role name', { role: 'bogus' }],
    ['a non-string role', { role: 7 }],
  ];

  it.each(flooredBlobs)(
    'permissions %s floor to ingest and are REFUSED on an unmarked route',
    (_label, permissions) => {
      const role = parseKeyRole(permissions);
      expect(role).toBe('ingest');
      const user = { ...explicitIngestUser, role };
      expect(() => makeGuard().canActivate(ctxFor('unmarked', user))).toThrow(
        IngestKeyScopeForbiddenException,
      );
    },
  );

  it.each(flooredBlobs)(
    'permissions %s still reach the usage-record route',
    (_label, permissions) => {
      const user = { ...explicitIngestUser, role: parseKeyRole(permissions) };
      expect(makeGuard().canActivate(ctxFor('ingest', user))).toBe(true);
    },
  );
});

describe('the guard is a key-ROLE boundary only — everything that is not an explicit ingest key passes', () => {
  const passThroughUsers: Array<[string, UserShape]> = [
    ['a member-role key', { ...explicitIngestUser, role: 'member' }],
    ['a developer-role key', { ...explicitIngestUser, role: 'developer' }],
    ['an owner-role key', { ...explicitIngestUser, role: 'owner' }],
    ['a key with no role at all', { authMethod: 'api-key', organizationId: ORG_ID }],
    ['session', { authMethod: 'session', userId: 'u1', organizationId: ORG_ID }],
    ['jwt', { authMethod: 'jwt', userId: 'u1', organizationId: ORG_ID }],
    ['portal', { authMethod: 'portal', organizationId: ORG_ID }],
    ['unauthenticated (no user)', undefined],
  ];

  it.each(passThroughUsers)('%s passes even an unmarked route', (_label, user) => {
    expect(makeGuard().canActivate(ctxFor('unmarked', user))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a HUMAN session that somehow carries role 'ingest' still passes — role belongs to api keys, and flooring a human would 403 the whole dashboard", () => {
    const humanUser = {
      authMethod: 'session',
      userId: 'u1',
      organizationId: ORG_ID,
      role: 'ingest',
    };
    expect(makeGuard().canActivate(ctxFor('unmarked', humanUser))).toBe(true);
  });
});

describe('the three allow paths', () => {
  it('an @IngestKeyAllowed route passes (the six-handler allowlist)', () => {
    expect(makeGuard().canActivate(ctxFor('allowed', explicitIngestUser))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an @IngestRoute passes — the usage-record POSTs need no new decorator, the guard honors the marker they already carry', () => {
    expect(makeGuard().canActivate(ctxFor('ingest', explicitIngestUser, 'POST'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a @Public route passes (defensive — auth never sets user there today)', () => {
    expect(makeGuard().canActivate(ctxFor('open', explicitIngestUser))).toBe(true);
  });
});

describe('the 403 body — what a blocked customer actually reads', () => {
  function denialBody(): Record<string, unknown> {
    try {
      makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser));
    } catch (err) {
      return (err as IngestKeyScopeForbiddenException).getResponse() as Record<string, unknown>;
    }
    throw new Error('the guard did not deny');
  }

  it("reuses the insufficient_key_role code: the MCP's generic 403 branch would otherwise blame a publishable key (mf_pk_*), sending the customer to rotate the wrong key", () => {
    const body = denialBody();
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('names the role the key carries, in the body fields the SDK and MCP lift', () => {
    const body = denialBody();
    expect(body.key_role).toBe('ingest');
    expect(String(body.message)).toContain("role is 'ingest'");
  });

  it('required_roles is EMPTY: a five-role list would be rendered as the remedy and send the customer to mint a key that 403s again', () => {
    // Every role above the ingest floor clears THIS guard, but the route's own
    // OrgRoleGuard is usually narrower (a money read wants owner/admin/finance only).
    // Both clients read an empty list as "use the server's sentence": the MCP falls
    // through to `message` verbatim (packages/mcp/src/index.ts errorResponse, pinned by
    // packages/mcp/src/__tests__/role-guidance.test.ts). Repopulating this array sends the
    // customer to mint a key that 403s again.
    expect(denialBody().required_roles).toEqual([]);
  });

  it('says plainly what an ingest key CAN do, so the reader learns the boundary instead of guessing at it', () => {
    const message = String(denialBody().message);
    expect(message).toContain('send usage records');
    expect(message).toContain('check which organization it belongs to');
    expect(message).toContain('read your spend controls');
  });

  it('names the MONEY on the allowlist, not only the cap settings', () => {
    // GET /v1/control/spend is allowlisted and returns the org's actual AI spend for the
    // period plus, for a named customerExternalId, that one teammate's spend
    // (cost-control.controller.ts getSpend). "Spend caps" reads as cap CONFIGURATION, so
    // a customer sizing the blast radius of a leaked ingest key would under-read it. Pin
    // the money words, not one friendly phrasing.
    const message = String(denialBody().message);
    expect(message).toMatch(/organization's AI spend/);
    expect(message).toMatch(/teammate's spend/);
    expect(message).not.toMatch(/read its own spend caps/);
  });

  it('names exactly where to get a key that can do more', () => {
    const message = String(denialBody().message);
    expect(message).toContain('Build');
    expect(message).toContain('API keys');
  });

  it('customer-visible copy: no em dash, no exclamation point, and none of the filler words', () => {
    const message = String(denialBody().message);
    expect(message).not.toMatch(/[—!]/);
    expect(message).not.toMatch(/\b(simply|just)\b/i);
    expect(message).not.toMatch(/please note/i);
  });
});

describe('the denial log line', () => {
  it('names the key and the bare route, and carries no key material', () => {
    try {
      makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser));
    } catch {
      // the throw is asserted elsewhere; this test reads the log line
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('[ingest-key-scope] denied');
    expect(line).toContain('keyId=key_ingest_probe');
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
          user: explicitIngestUser,
          method: 'GET',
          url: '/v1/probe/unmarked?secret=SHOULD_NEVER_APPEAR',
        }),
      }),
    } as unknown as ExecutionContext;
    expect(() => makeGuard().canActivate(ctx)).toThrow(IngestKeyScopeForbiddenException);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('route="GET /v1/probe/unmarked"');
    expect(line).not.toContain('SHOULD_NEVER_APPEAR');
  });
});

describe('negative control — proves this suite can go red', () => {
  it('a pass-everything stand-in lets the ingest key read the unmarked route where the real guard blocks it', () => {
    const preFixBehavior: CanActivate = { canActivate: () => true };
    expect(preFixBehavior.canActivate(ctxFor('unmarked', explicitIngestUser))).toBe(true);
    expect(() => makeGuard().canActivate(ctxFor('unmarked', explicitIngestUser))).toThrow(
      IngestKeyScopeForbiddenException,
    );
  });
});
