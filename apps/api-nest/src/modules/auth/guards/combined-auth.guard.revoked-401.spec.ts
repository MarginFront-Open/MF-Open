/**
 * The honest revoked-key 401 must SURVIVE the guards.
 *
 * The trap: CombinedAuthGuard catches everything validateApiKey throws
 * (fall-through by design), so without an explicit rethrow at the choke point
 * the specific message minted in auth.service.ts would never reach the
 * client. These tests pin the
 * whole chain with the REAL CombinedAuthGuard + REAL AuthService and Prisma
 * stubbed only at the I/O boundary:
 *   - revoked key → the thrown exception IS RevokedApiKeyException, body
 *     carries code:'key_revoked' (the rethrow at the choke point works),
 *   - unknown key → the byte-identical generic 401 (nothing else changed),
 *   - revoked x-api-key + valid session cookie → 200 (the fall-through that
 *     lets a browser with a stale header still authenticate must survive),
 *   - SecretKeyGuard / PublishableKeyGuard rethrow the exception unchanged
 *     (pinned so a guard refactor can't quietly convert it to a generic 401).
 *
 * MUTATION CONTROL: remove the guard's revokedKeyRejection rethrow and the
 * first test goes red while auth.service.spec stays green.
 */
import { UnauthorizedException } from '@nestjs/common';
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from '../auth.service';
import { CombinedAuthGuard } from './combined-auth.guard';
import { SecretKeyGuard } from '../../../common/guards/secret-key.guard';
import { PublishableKeyGuard } from '../../../common/guards/publishable-key.guard';
import { RevokedApiKeyException } from '../../../common/exceptions/revoked-api-key.exception';

const REVOKED_KEY = 'mf_sk_revoked_but_recognizable';
const REVOKED_AT = new Date('2026-08-20T00:00:00.000Z');

function buildAuthService() {
  const revokedRow = {
    id: 'key-revoked',
    name: 'Old prod key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'revoked',
    apiKeyLookupHash: hashApiKeyForLookup(REVOKED_KEY),
    apiKeyPlaintext: null,
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

function makeContext(request: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
}

// The failed-auth throttle dep, stubbed to "under the limit": the honest key_revoked 401
// is what a revoked key gets until its IP exhausts the failed-key budget. The
// over-limit case (revoked retries DO count and become a 429) is pinned in
// combined-auth.guard.authfail-throttle.spec.ts.
function buildCombinedGuard(configEnv: Record<string, string> = {}) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  const configService = { get: jest.fn((key: string) => configEnv[key]) } as any;
  const authFailureThrottle = {
    recordFailureAndCheckLimit: jest.fn().mockResolvedValue(false),
  } as any;
  return new CombinedAuthGuard(reflector, configService, buildAuthService(), authFailureThrottle);
}

describe('CombinedAuthGuard — the honest revoked-key 401 survives the choke point', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rethrows RevokedApiKeyException with code key_revoked instead of the generic 401', async () => {
    const guard = buildCombinedGuard();
    const ctx = makeContext({ headers: { 'x-api-key': REVOKED_KEY } });

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.getResponse()).toMatchObject({
      statusCode: 401,
      code: 'key_revoked',
      message: expect.stringContaining('was revoked on Aug 20, 2026'),
    });
  });

  it('keeps the byte-identical generic 401 for an unknown key', async () => {
    const guard = buildCombinedGuard();
    const ctx = makeContext({ headers: { 'x-api-key': 'mf_sk_never_existed' } });

    const thrown = await guard.canActivate(ctx).catch((e) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.message).toBe('No valid authentication provided');
  });

  it('keeps the generic 401 when no credentials are presented at all', async () => {
    const guard = buildCombinedGuard();
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).rejects.toThrow('No valid authentication provided');
  });

  it('still authenticates via a valid session cookie when the x-api-key is revoked (fall-through survives)', async () => {
    const guard = buildCombinedGuard({ BETTER_AUTH_URL: 'http://better-auth.test' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: { userId: 'user-1', activeOrganizationId: 'org-1' },
        user: { id: 'user-1', email: 'human@acme.test', name: 'Human', emailVerified: true },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const request: any = {
      headers: { 'x-api-key': REVOKED_KEY, cookie: 'better-auth.session=live' },
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ userId: 'user-1', authMethod: 'session' });
  });
});

describe('SecretKeyGuard / PublishableKeyGuard — rethrow the honest 401 unchanged', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;

  it.each([
    ['SecretKeyGuard', () => new SecretKeyGuard(reflector, buildAuthService())],
    ['PublishableKeyGuard', () => new PublishableKeyGuard(reflector, buildAuthService())],
  ])('%s passes RevokedApiKeyException through intact', async (_name, makeGuard) => {
    const ctx = makeContext({ headers: { 'x-api-key': REVOKED_KEY } });

    const thrown = await makeGuard()
      .canActivate(ctx)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(RevokedApiKeyException);
    expect((thrown as RevokedApiKeyException).getResponse()).toMatchObject({
      code: 'key_revoked',
    });
  });
});
