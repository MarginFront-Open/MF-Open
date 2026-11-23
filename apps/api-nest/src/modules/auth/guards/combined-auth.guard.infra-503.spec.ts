/**
 * An auth-path infrastructure failure answers 503, never a lying 401.
 *
 * If validateApiKey swallowed a rejecting Prisma lookup (.catch(() => null)),
 * a server outage would read as "Invalid API key". The behaviour has two halves
 * and these tests pin the whole chain with the REAL CombinedAuthGuard + REAL
 * AuthService, Prisma stubbed only at the I/O boundary (a mocked AuthService
 * would hide a swallowed rejection):
 *   - auth.service.ts lets an infrastructure rejection PROPAGATE (no verdict ran),
 *   - the guard's catch classifies it (non-HttpException) and the choke point
 *     answers AuthUnavailableException: 503 + Retry-After + honest body,
 *   - a credential VERDICT (unknown key, revoked key) keeps its exact 401,
 *   - the original error is captured to Sentry (SentryGlobalFilter skips
 *     HttpExceptions, so this explicit capture is the only record of the fault),
 *     gated on a recognized key prefix so scanner junk costs zero events,
 *   - a valid session cookie still wins over an api-key infra fault (the
 *     fall-through survives — do NOT "throw 503 immediately").
 *
 * MUTATION CONTROL: delete the guard's `else if (!(error instanceof
 * HttpException))` branch and the 503/Sentry tests here go red while
 * auth.service.spec.ts and combined-auth.guard.revoked-401.spec.ts stay green.
 */
import { UnauthorizedException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from '../auth.service';
import { CombinedAuthGuard } from './combined-auth.guard';
import { RevokedApiKeyException } from '../../../common/exceptions/revoked-api-key.exception';
import {
  AuthUnavailableException,
  AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../../../common/exceptions/auth-unavailable.exception';

// @sentry/nestjs re-exports captureException as a NON-configurable binding, so
// jest.spyOn can't wrap it — the whole-module mock is the only pattern that
// works (same as per-tenant-throttler.guard.spec.ts).
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));
const captureExceptionMock = Sentry.captureException as unknown as jest.Mock;

const RAW_KEY = 'mf_sk_key_caught_in_the_outage';
const REVOKED_KEY = 'mf_sk_revoked_but_recognizable';
const REVOKED_AT = new Date('2026-08-20T00:00:00.000Z');

// The identity of this exact object is asserted against the Sentry capture —
// the ORIGINAL fault must reach Sentry, not a wrapper.
const poolError = new Error('Timed out fetching a new connection from the connection pool');

function failingAuthService() {
  const findFirst = jest.fn().mockRejectedValue(poolError);
  const prisma = { api_keys: { findFirst, update: jest.fn() } } as any;
  return new AuthService(prisma);
}

function healthyAuthService() {
  const revokedRow = {
    id: 'key-revoked',
    name: 'Old prod key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'revoked',
    apiKeyLookupHash: hashApiKeyForLookup(REVOKED_KEY),
    deletedAt: null,
    revokedAt: REVOKED_AT,
    permissions: null,
    organizations: { id: 'org-1', name: 'Acme Co' },
  };
  const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const match = Object.entries(where).every(
      ([field, value]) => (revokedRow as Record<string, unknown>)[field] === value,
    );
    return match ? revokedRow : null;
  });
  const prisma = { api_keys: { findFirst, update: jest.fn().mockResolvedValue({}) } } as any;
  return new AuthService(prisma);
}

function makeResponse() {
  return { setHeader: jest.fn() };
}

function makeContext(request: any, response?: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

// A context without getResponse at all. The guard's
// Retry-After helper must feature-detect it, not crash on the outage path.
function makeBareContext(request: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

// The guard's failed-auth throttle dep. Stubbed to "under the limit" everywhere here:
// an infrastructure fault must answer 503 whether or not the caller's IP is near
// its failed-key budget, and combined-auth.guard.authfail-throttle.spec.ts is
// where the 503-never-counts invariant is pinned.
function buildGuard(authService: AuthService, configEnv: Record<string, string> = {}) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  const configService = { get: jest.fn((key: string) => configEnv[key]) } as any;
  const authFailureThrottle = {
    recordFailureAndCheckLimit: jest.fn().mockResolvedValue(false),
  } as any;
  return new CombinedAuthGuard(reflector, configService, authService, authFailureThrottle);
}

function ingestRequest(headers: Record<string, string>): any {
  return { headers, url: '/v1/usage/record', method: 'POST' };
}

describe('CombinedAuthGuard — infrastructure faults answer 503, not 401', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a Prisma-shaped infrastructure fault becomes a 503, not a 401', async () => {
    const guard = buildGuard(failingAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': RAW_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(AuthUnavailableException);
    expect(thrown.getStatus()).toBe(503);
    // The full body is pinned: this copy is printed verbatim on customer
    // terminals by the code-cost-clarity CLI and rendered by the MCP server.
    expect(thrown.getResponse()).toEqual({
      statusCode: 503,
      code: 'auth_unavailable',
      message:
        "MarginFront couldn't check this API key because of a problem on our side. " +
        'Your key is probably fine. Try again in a moment.',
    });
  });

  it('sets Retry-After on the response before throwing', async () => {
    const guard = buildGuard(failingAuthService());
    const response = makeResponse();
    const ctx = makeContext(ingestRequest({ 'x-api-key': RAW_KEY }), response);

    await guard.canActivate(ctx).catch(() => undefined);

    // '5' is hardcoded on purpose: a silent change to the constant must go red
    // here, because the SDK sleeps this value between each of its 3 retries.
    expect(String(AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS)).toBe('5');
    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('captures the ORIGINAL error to Sentry with route context and never the key', async () => {
    const guard = buildGuard(failingAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': RAW_KEY }), makeResponse());

    await guard.canActivate(ctx).catch(() => undefined);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, scope] = captureExceptionMock.mock.calls[0];
    expect(captured).toBe(poolError);
    expect(scope.tags).toEqual({ component: 'CombinedAuthGuard', failMode: 'auth-unavailable' });
    expect(scope.extra).toEqual({ path: '/v1/usage/record', method: 'POST', keyPrefix: 'mf_sk_' });
    // The raw key must not appear anywhere in the capture payload.
    expect(JSON.stringify(captureExceptionMock.mock.calls[0])).not.toContain(RAW_KEY);
  });

  it('does NOT burn a Sentry event for an unrecognized junk token, but still answers 503', async () => {
    // During an outage every scanner request with any x-api-key string reaches
    // the rejecting lookup. The 503 is still the honest answer for all of them;
    // only recognized MarginFront prefixes earn a Sentry event.
    const guard = buildGuard(failingAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': 'some-random-junk' }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(AuthUnavailableException);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('an unknown key still gets the byte-identical generic 401', async () => {
    const guard = buildGuard(healthyAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': 'mf_sk_never_existed' }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(AuthUnavailableException);
    expect(thrown.message).toBe('No valid authentication provided');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a revoked key still gets the key_revoked 401', async () => {
    const guard = buildGuard(healthyAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': REVOKED_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.getResponse()).toMatchObject({ statusCode: 401, code: 'key_revoked' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a request with no x-api-key header gets the plain 401, never a 503', async () => {
    const guard = buildGuard(failingAuthService());
    const response = makeResponse();
    const ctx = makeContext({ headers: {} }, response);

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(AuthUnavailableException);
    expect(thrown.message).toBe('No valid authentication provided');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('a valid session cookie still wins over an api-key infrastructure fault', async () => {
    // This is the test that goes red if someone implements "throw 503
    // immediately": api-nest's Prisma pool can be exhausted while Better Auth
    // (its own service, its own pool) is healthy, and a browser carrying a
    // stale x-api-key plus a live cookie must still authenticate.
    const guard = buildGuard(failingAuthService(), { BETTER_AUTH_URL: 'http://better-auth.test' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: { userId: 'user-1', activeOrganizationId: 'org-1' },
        user: { id: 'user-1', email: 'human@acme.test', name: 'Human', emailVerified: true },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const request: any = {
      headers: { 'x-api-key': RAW_KEY, cookie: 'better-auth.session=live' },
      url: '/v1/usage/record',
      method: 'POST',
    };

    await expect(guard.canActivate(makeContext(request, makeResponse()))).resolves.toBe(true);
    expect(request.user).toMatchObject({ userId: 'user-1', authMethod: 'session' });
  });

  it('a context without getResponse does not turn the outage into a crash', async () => {
    const guard = buildGuard(failingAuthService());
    const ctx = makeBareContext(ingestRequest({ 'x-api-key': RAW_KEY }));

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(AuthUnavailableException);
    expect(thrown.getStatus()).toBe(503);
  });
});
