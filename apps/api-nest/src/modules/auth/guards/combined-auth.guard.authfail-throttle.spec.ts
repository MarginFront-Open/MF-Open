/**
 * Repeated FAILED api-key attempts from one network answer 429, and
 * nothing else changes.
 *
 * The REAL CombinedAuthGuard + REAL AuthService with Prisma stubbed only at the
 * I/O boundary, the same harness combined-auth.guard.infra-503.spec.ts uses (a
 * mocked-service shortcut can hide a wiring bug). Only the
 * throttle service is a stub, so its verdict can be driven per test.
 *
 * Pinned here one test each:
 *   - over the limit answers 429 with the exact body and Retry-After,
 *   - a VALID key from the same IP is never even checked (zero Redis on the hot
 *     path, and immunity by construction rather than by threshold luck),
 *   - a infrastructure 503 never counts,
 *   - a revoked-key retry DOES count and becomes a 429 over the limit, while
 *     staying the honest key_revoked 401 under it,
 *   - a throttle failure can never turn an honest 401 into a 500.
 *
 * MUTATION CONTROL: move the throttle block above the
 * apiKeyValidationCouldNotRun branch and the 503-immunity test goes red while
 * the whole infra-503 suite stays green.
 */
import { UnauthorizedException } from '@nestjs/common';
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from '../auth.service';
import { CombinedAuthGuard } from './combined-auth.guard';
import { RevokedApiKeyException } from '../../../common/exceptions/revoked-api-key.exception';
import {
  AuthUnavailableException,
  AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../../../common/exceptions/auth-unavailable.exception';
import {
  TooManyAuthFailuresException,
  AUTH_FAILURE_THROTTLE_RETRY_AFTER_SECONDS,
} from '../../../common/exceptions/too-many-auth-failures.exception';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

const VALID_KEY = 'mf_sk_a_working_key';
const REVOKED_KEY = 'mf_sk_revoked_but_recognizable';
const UNKNOWN_KEY = 'mf_sk_never_existed';
const CALLER_IP = '203.0.113.7';

function healthyAuthService() {
  const validRow = {
    id: 'key-valid',
    name: 'Prod key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'active',
    role: 'developer',
    apiKeyLookupHash: hashApiKeyForLookup(VALID_KEY),
    apiKeyPlaintext: null,
    deletedAt: null,
    revokedAt: null,
    permissions: null,
    organizations: { id: 'org-1', name: 'Acme Co' },
  };
  const revokedRow = {
    ...validRow,
    id: 'key-revoked',
    name: 'Old prod key',
    status: 'revoked',
    apiKeyLookupHash: hashApiKeyForLookup(REVOKED_KEY),
    revokedAt: new Date('2026-08-20T00:00:00.000Z'),
  };
  const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const matches = (row: Record<string, unknown>) =>
      Object.entries(where).every(([field, value]) => row[field] === value);
    if (matches(validRow)) return validRow;
    if (matches(revokedRow)) return revokedRow;
    return null;
  });
  const prisma = { api_keys: { findFirst, update: jest.fn().mockResolvedValue({}) } } as any;
  return new AuthService(prisma);
}

function failingAuthService() {
  const findFirst = jest
    .fn()
    .mockRejectedValue(new Error('Timed out fetching a new connection from the connection pool'));
  const prisma = { api_keys: { findFirst, update: jest.fn() } } as any;
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

// A context without getResponse at all.
function makeBareContext(request: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

function buildGuard(
  authService: AuthService,
  throttle: { overLimit?: boolean; throws?: boolean } = {},
) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  const configService = { get: jest.fn() } as any;
  const recordFailureAndCheckLimit = throttle.throws
    ? jest.fn().mockRejectedValue(new Error('redis exploded'))
    : jest.fn().mockResolvedValue(throttle.overLimit === true);
  const guard = new CombinedAuthGuard(reflector, configService, authService, {
    recordFailureAndCheckLimit,
  } as any);
  return { guard, recordFailureAndCheckLimit };
}

function ingestRequest(headers: Record<string, string>, overrides: Record<string, any> = {}): any {
  return {
    headers: { 'user-agent': 'curl/8.4.0', ...headers },
    ips: [CALLER_IP],
    ip: CALLER_IP,
    url: '/v1/usage/record',
    method: 'POST',
    ...overrides,
  };
}

describe('CombinedAuthGuard — failed api-key attempts are throttled per IP', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('under the limit, an unknown key still gets the byte-identical generic 401', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(TooManyAuthFailuresException);
    expect(thrown.message).toBe('No valid authentication provided');
    expect(recordFailureAndCheckLimit).toHaveBeenCalledTimes(1);
  });

  it('over the limit, the 429 body is exactly the contracted copy', async () => {
    const { guard } = buildGuard(healthyAuthService(), { overLimit: true });
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(TooManyAuthFailuresException);
    expect(thrown.getStatus()).toBe(429);
    // Pinned verbatim: this string reaches raw HTTP and curl callers.
    expect(thrown.getResponse()).toEqual({
      statusCode: 429,
      code: 'too_many_auth_failures',
      message:
        'Too many failed API key attempts from this network. Wait a few minutes, ' +
        "then check the key you're sending in Build > API keys.",
    });
  });

  it('sets Retry-After from the THROTTLE constant, not the auth-unavailable one', async () => {
    // Asserting the value alone cannot fail while both constants are 5, so pin
    // the call-site WIRING. Passing the wrong constant here would silently fuse
    // two knobs that exist for different reasons.
    const { guard } = buildGuard(healthyAuthService(), { overLimit: true });
    const response = makeResponse();
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), response);
    const setRetryAfter = jest.spyOn(guard as any, 'setRetryAfterHeader');

    await guard.canActivate(ctx).catch(() => undefined);

    expect(setRetryAfter).toHaveBeenCalledTimes(1);
    expect(setRetryAfter.mock.calls[0][1]).toBe(AUTH_FAILURE_THROTTLE_RETRY_AFTER_SECONDS);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('pins the 503 path to the auth-unavailable constant (the twin of the assertion above)', async () => {
    const { guard } = buildGuard(failingAuthService(), { overLimit: true });
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());
    const setRetryAfter = jest.spyOn(guard as any, 'setRetryAfterHeader');

    await guard.canActivate(ctx).catch(() => undefined);

    expect(setRetryAfter.mock.calls[0][1]).toBe(AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
  });

  it('a VALID key is never checked against the throttle, even from a blocked IP', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService(), {
      overLimit: true,
    });
    const request = ingestRequest({ 'x-api-key': VALID_KEY });

    await expect(guard.canActivate(makeContext(request, makeResponse()))).resolves.toBe(true);

    expect(request.user).toMatchObject({ organizationId: 'org-1' });
    expect(recordFailureAndCheckLimit).not.toHaveBeenCalled();
  });

  it('an infrastructure 503 never counts toward the throttle', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(failingAuthService(), {
      overLimit: true,
    });
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(AuthUnavailableException);
    expect(thrown.getStatus()).toBe(503);
    expect(recordFailureAndCheckLimit).not.toHaveBeenCalled();
  });

  it('a revoked key keeps its honest key_revoked 401 under the limit', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': REVOKED_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.getResponse()).toMatchObject({ statusCode: 401, code: 'key_revoked' });
    expect(recordFailureAndCheckLimit).toHaveBeenCalledTimes(1);
  });

  it('a revoked key over the limit becomes the 429 (revoked retries DO count)', async () => {
    const { guard } = buildGuard(healthyAuthService(), { overLimit: true });
    const ctx = makeContext(ingestRequest({ 'x-api-key': REVOKED_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(TooManyAuthFailuresException);
  });

  it('a request with no x-api-key is never counted (not a key-enumeration vector)', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService(), {
      overLimit: true,
    });
    const ctx = makeContext(ingestRequest({}, { headers: { cookie: 'session=dead' } }));

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(TooManyAuthFailuresException);
    expect(recordFailureAndCheckLimit).not.toHaveBeenCalled();
  });

  it('an unresolvable caller IP is never counted, so one broken lookup cannot block everyone', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService(), {
      overLimit: true,
    });
    const ctx = makeContext(
      ingestRequest({ 'x-api-key': UNKNOWN_KEY }, { ips: undefined, ip: undefined }),
    );

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(recordFailureAndCheckLimit).not.toHaveBeenCalled();
  });

  it('buckets on the same caller IP the alert counter uses', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(healthyAuthService());
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());

    await guard.canActivate(ctx).catch(() => undefined);

    expect(recordFailureAndCheckLimit).toHaveBeenCalledWith(CALLER_IP, {
      path: '/v1/usage/record',
      method: 'POST',
      userAgent: 'curl/8.4.0',
    });
  });

  it('a throttle service that THROWS still yields the honest 401, never a 500', async () => {
    const { guard } = buildGuard(healthyAuthService(), { throws: true });
    const ctx = makeContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }), makeResponse());

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown.message).toBe('No valid authentication provided');
  });

  it('a context without getResponse still yields a clean 429', async () => {
    const { guard } = buildGuard(healthyAuthService(), { overLimit: true });
    const ctx = makeBareContext(ingestRequest({ 'x-api-key': UNKNOWN_KEY }));

    const thrown = await guard.canActivate(ctx).catch((e) => e);

    expect(thrown).toBeInstanceOf(TooManyAuthFailuresException);
    expect(thrown.getStatus()).toBe(429);
  });
});
