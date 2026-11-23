/**
 * WHAT THIS FILE DOES:
 *   Unit tests for CombinedAuthGuard's reject path. The guard records nothing on
 *   a 401; the global CustomerFailureAlertFilter is the one recorder. These tests pin:
 *     - the guard throws the expected UnauthorizedException at its choke point, and
 *     - the guard records NOTHING: it never receives a CustomerFailureAlertService,
 *       so there is exactly ONE recorder for 401 (the filter) and no double alert.
 *
 *   The proof is STRUCTURAL: no alert service is ever handed to the guard, and a
 *   customer-shaped rejection throws with zero side-effects. We exercise the REAL
 *   reject path (no valid auth + a bad API key that falls through) rather than
 *   mocking guard internals.
 *
 * The 4th constructor dep, AuthFailureThrottleService, GATES (it decides whether an
 *   already-rejected credential answers 429 instead of 401); it records nothing.
 *   Handing this guard a CustomerFailureAlertService would break the
 *   one-recorder rule; the number of constructor deps is not the point.
 */
import { UnauthorizedException } from '@nestjs/common';
import { CombinedAuthGuard } from './combined-auth.guard';

function makeContext(request: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

function buildGuard(overrides: { validateApiKey?: jest.Mock } = {}) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  const configService = { get: jest.fn() } as any;
  const authService = {
    // Default: any presented API key is invalid, so the guard falls through to
    // the reject choke point we want to test.
    validateApiKey: overrides.validateApiKey ?? jest.fn().mockResolvedValue(null),
  } as any;

  // The 4th dep is a GATE, not a recorder: stubbed to "under the
  // limit" so every test here exercises the plain 401 path. The
  // invariant this call site protects is that no CustomerFailureAlertService is
  // ever passed — re-add one and the guard is recording again.
  const authFailureThrottle = {
    recordFailureAndCheckLimit: jest.fn().mockResolvedValue(false),
  } as any;

  const guard = new CombinedAuthGuard(reflector, configService, authService, authFailureThrottle);
  return { guard, reflector };
}

describe('CombinedAuthGuard — reject path (no in-guard 401 hook)', () => {
  beforeEach(() => {
    // The guard's API-key catch path uses console.error on an invalid key; keep
    // test output clean.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws UnauthorizedException when no valid auth is provided', async () => {
    const { guard } = buildGuard();
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws the EXACT 401 even on a customer-shaped rejection (no attribution side-effects, no service to call)', async () => {
    // A customer-shaped request (real-looking key + SDK UA + a claimed customer id
    // in the body). The guard throws; the filter owns attribution. The guard was
    // constructed with NO alert service, so reaching the throw cleanly proves it
    // does not try to record.
    const { guard } = buildGuard();
    const ctx = makeContext({
      headers: { 'x-api-key': 'mf_sk_thisisrawandsecret', 'user-agent': '@marginfront/sdk/1.0' },
      ips: ['203.0.113.7'],
      url: '/v1/sdk/usage',
      body: { records: [{ customerExternalId: 'cust-42' }] },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('No valid authentication provided');
  });

  it('returns true on a successful auth and sets request.user ', async () => {
    const validateApiKey = jest.fn().mockResolvedValue({
      id: 'u-1',
      email: 'ok@example.com',
      organizationId: 'org-1',
      authMethod: 'api-key',
      keyType: 'secret',
    });
    const { guard } = buildGuard({ validateApiKey });
    const request: any = { headers: { 'x-api-key': 'mf_sk_validkey' } };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBeDefined();
  });
});
