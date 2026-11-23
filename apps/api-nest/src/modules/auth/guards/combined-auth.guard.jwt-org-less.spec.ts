/**
 * The guard-side half of the login-token-at-ingest rule, pinned against the REAL
 * validateJwt rather than a spy.
 *
 * Two facts live here, and nothing else in the repo holds either one:
 *   1. THE PREMISE. A Better Auth JWT authenticates and comes back with NO
 *      organizationId. AuthenticatedUser.organizationId is optional
 *      (auth.service.ts), so the compiler does not hold this line — only this
 *      test does. If validateJwt ever starts resolving an org, the handler-side
 *      401 becomes dead code and this goes red first.
 *   2. THE THROTTLE ANSWER. A successful JWT returns true before the guard
 *      reaches its reject choke point, so the failed-auth counter is
 *      unreachable on this path. The 401 the handler then throws cannot touch
 *      it. Pinned with the throttle stub already over its limit, so a passing
 *      result cannot be threshold luck.
 *
 * Only jose is mocked (the JWKS fetch is the one thing that would leave the
 * process); the guard, its config read, and its payload mapping all run for real.
 */
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as jose from 'jose';
import { AuthService } from '../auth.service';
import { CombinedAuthGuard } from './combined-auth.guard';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'jwks-key-set'),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class JWTExpired extends Error {},
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {},
  },
}));

const jwtVerifyMock = jose.jwtVerify as unknown as jest.Mock;

const JWT = 'header.payload.signature';
const CALLER_IP = '203.0.113.9';

function buildGuard(overLimit: boolean) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const configService = {
    get: jest.fn((key: string) =>
      key === 'BETTER_AUTH_URL' ? 'https://auth.example.test' : undefined,
    ),
  } as unknown as ConfigService;
  // Never consulted on this path: the request carries no x-api-key.
  const authService = {} as AuthService;
  const recordFailureAndCheckLimit = jest.fn().mockResolvedValue(overLimit);
  const guard = new CombinedAuthGuard(reflector, configService, authService, {
    recordFailureAndCheckLimit,
  } as any);
  return { guard, recordFailureAndCheckLimit };
}

function ingestRequest(): any {
  return {
    headers: { authorization: `Bearer ${JWT}`, 'user-agent': 'curl/8.4.0' },
    ips: [CALLER_IP],
    ip: CALLER_IP,
    url: '/v1/usage/record',
    method: 'POST',
  };
}

function makeContext(request: any): any {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader: jest.fn() }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

describe('CombinedAuthGuard — a Better Auth JWT authenticates with no organization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwtVerifyMock.mockResolvedValue({
      payload: {
        id: 'user-1',
        email: 'a@acme.example',
        name: 'A Human',
        emailVerified: true,
      },
    });
  });

  it('the REAL validateJwt returns a principal carrying no organizationId', async () => {
    const { guard } = buildGuard(false);

    const user = await (guard as any).validateJwt(JWT);

    expect(user).toMatchObject({ id: 'user-1', email: 'a@acme.example', authMethod: 'jwt' });
    expect(user.organizationId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(user, 'organizationId')).toBe(false);
  });

  it('canActivate accepts the JWT and stamps the org-less principal onto the request', async () => {
    const { guard } = buildGuard(false);
    const request = ingestRequest();

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.user.authMethod).toBe('jwt');
    expect(request.user.organizationId).toBeUndefined();
  });

  it('never touches the failed-auth counter, even from an over-limit IP', async () => {
    const { guard, recordFailureAndCheckLimit } = buildGuard(true);

    await expect(guard.canActivate(makeContext(ingestRequest()))).resolves.toBe(true);

    // The counter lives past the reject choke point, which a successful JWT
    // never reaches. The handler's 401 is thrown later still, from outside the
    // guard entirely, so this stays zero for the whole request.
    expect(recordFailureAndCheckLimit).not.toHaveBeenCalled();
  });
});
