/**
 * Unit proof of the deny-by-default publishable-key boundary.
 *
 * Drives the REAL PublishableKeyReadGuard against a probe controller carrying the REAL
 * decorators. What this file pins:
 *   1. A publishable key on an UNMARKED route is refused, on every HTTP method — the
 *      core of the boundary. Only @PublishableKeyAllowed, @Public, and
 *      @IngestRoute let one through.
 *   2. The thrown error is a SIBLING of PublishableKeyWriteForbiddenException, never a
 *      subclass — CustomerFailureAlertFilter pages the alerts channel on that class with
 *      copy asserting a publishable-key WRITE. On non-ingest routes this guard wins
 *      the race for pk writes too, so those denials deliberately do NOT page; the
 *      denial log line is their only trace.
 *   3. The guard touches ONLY requests with an explicit keyType 'publishable': sessions,
 *      JWTs, portal tokens, secret keys, unauthenticated requests, and api keys with an
 *      unrecognized keyType pass untouched.
 *   4. The denial log line never carries key material or a query string.
 */

import 'reflect-metadata';
import { ExecutionContext, CanActivate, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PublishableKeyReadGuard, PublishableKeyAllowed } from './publishable-key-read.guard';
import { PublishableKeyReadForbiddenException } from '../exceptions/publishable-key-read-forbidden.exception';
import { PublishableKeyWriteForbiddenException } from '../exceptions/publishable-key-write-forbidden.exception';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';

// The real @IngestRoute lives in org-role.guard.ts, which imports @marginfront/db at module
// load — this spec must boot without a built dist, so it applies the SAME shared metadata
// key directly. Equivalent by construction; the route-sweep spec proves the real
// decorator on the real controllers.
const IngestRoute = () => SetMetadata(INGEST_ROUTE_KEY, true);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

class ProbeController {
  @PublishableKeyAllowed()
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

const pkUser = {
  authMethod: 'api-key',
  keyType: 'publishable',
  organizationId: ORG_ID,
  apiKeyId: 'key_pk_probe',
  role: 'member',
};

function makeGuard() {
  return new PublishableKeyReadGuard(new Reflector());
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('deny by default', () => {
  it('an UNMARKED route refuses a publishable key', () => {
    expect(() => makeGuard().canActivate(ctxFor('unmarked', pkUser))).toThrow(
      PublishableKeyReadForbiddenException,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'the deny fires on %s — every method, not just reads',
    (method) => {
      expect(() => makeGuard().canActivate(ctxFor('unmarked', pkUser, method))).toThrow(
        PublishableKeyReadForbiddenException,
      );
    },
  );

  it('is NOT a PublishableKeyWriteForbiddenException — CustomerFailureAlertFilter pages a "publishable key WRITE" root cause on that class, false for a read', () => {
    let thrown: unknown;
    try {
      makeGuard().canActivate(ctxFor('unmarked', pkUser));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PublishableKeyReadForbiddenException);
    expect(thrown).not.toBeInstanceOf(PublishableKeyWriteForbiddenException);
  });

  it('on a WRITE method it is STILL not the write exception: non-ingest pk writes do not page the alerts channel and are recorded by the denial log line instead', () => {
    let thrown: unknown;
    try {
      makeGuard().canActivate(ctxFor('unmarked', pkUser, 'POST'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PublishableKeyReadForbiddenException);
    expect(thrown).not.toBeInstanceOf(PublishableKeyWriteForbiddenException);
  });

  it('body contract: code publishable_key_forbidden, names both key prefixes, no em dash, no exclamation point', () => {
    let thrown: PublishableKeyReadForbiddenException | undefined;
    try {
      makeGuard().canActivate(ctxFor('unmarked', pkUser));
    } catch (err) {
      thrown = err as PublishableKeyReadForbiddenException;
    }
    const body = thrown!.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('publishable_key_forbidden');
    const message = String(body.message);
    expect(message).toContain('mf_pk_');
    expect(message).toContain('mf_sk_');
    expect(message).not.toMatch(/[—!]/);
  });
});

describe('the guard is a key-TYPE boundary only — everything that is not a publishable key passes', () => {
  const passThroughUsers: Array<[string, UserShape]> = [
    ['secret key', { authMethod: 'api-key', keyType: 'secret', organizationId: ORG_ID }],
    ['session', { authMethod: 'session', userId: 'u1', organizationId: ORG_ID }],
    ['jwt', { authMethod: 'jwt', userId: 'u1', organizationId: ORG_ID }],
    ['portal', { authMethod: 'portal', organizationId: ORG_ID }],
    ['unauthenticated (no user)', undefined],
  ];

  it.each(passThroughUsers)('%s passes even an unmarked route', (_label, user) => {
    expect(makeGuard().canActivate(ctxFor('unmarked', user))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("an api key with an unrecognized keyType passes — the deny fires only on an explicit 'publishable'; anything else failing open means a key row with an odd keyType value passes this guard instead of 403-ing a paying customer", () => {
    const oddKey = { authMethod: 'api-key', keyType: undefined, organizationId: ORG_ID };
    expect(makeGuard().canActivate(ctxFor('unmarked', oddKey))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('the three allow paths', () => {
  it('a @PublishableKeyAllowed route passes (the installer contract)', () => {
    expect(makeGuard().canActivate(ctxFor('allowed', pkUser))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a @Public route passes (defensive — auth never sets user there today)', () => {
    expect(makeGuard().canActivate(ctxFor('open', pkUser))).toBe(true);
  });

  it('an @IngestRoute passes — the write interceptor still owns the pk ingest 403, and its distinct exception class is the only thing that pages the alerts channel', () => {
    expect(makeGuard().canActivate(ctxFor('ingest', pkUser, 'POST'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('the denial log line', () => {
  it('names the key and the bare route, and carries no key material', () => {
    try {
      makeGuard().canActivate(ctxFor('unmarked', pkUser));
    } catch {
      // the throw is asserted elsewhere; this test reads the log line
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('[publishable-key-read] denied');
    expect(line).toContain('keyId=key_pk_probe');
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
          user: pkUser,
          method: 'GET',
          url: '/v1/probe/unmarked?secret=SHOULD_NEVER_APPEAR',
        }),
      }),
    } as unknown as ExecutionContext;
    expect(() => makeGuard().canActivate(ctx)).toThrow(PublishableKeyReadForbiddenException);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('route="GET /v1/probe/unmarked"');
    expect(line).not.toContain('SHOULD_NEVER_APPEAR');
  });
});

describe('negative control — proves this suite can go red', () => {
  it('an opt-in stand-in lets the pk key through the unmarked route where the real guard blocks it', () => {
    const preInversionBehavior: CanActivate = { canActivate: () => true };
    expect(preInversionBehavior.canActivate(ctxFor('unmarked', pkUser))).toBe(true);
    expect(() => makeGuard().canActivate(ctxFor('unmarked', pkUser))).toThrow(
      PublishableKeyReadForbiddenException,
    );
  });
});
