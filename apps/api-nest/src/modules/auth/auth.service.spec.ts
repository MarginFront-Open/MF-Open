/**
 * auth.service.spec.ts: API-key auth by lookup hash.
 *
 * WHAT THIS PROVES: API-key auth matches ONLY on the deterministic SHA-256 lookup
 * hash. validateApiKey is a SINGLE hash lookup with no plaintext or apiKeyHash
 * fallback. The tests below pin that:
 *
 *   1. A key whose lookup-hash IS populated authenticates via the HASH path
 *      (single lookup — no fallback needed).
 *   2. NO FALLBACK: a key with NO lookup-hash but plaintext still set is
 *      REJECTED, proving neither a plaintext nor an apiKeyHash fallback exists.
 *   3. The hash written on create == the hash the verify path computes (round-trip
 *      through ONE shared helper), and that value == Postgres's SHA-256 hex.
 *   4. A bogus key is rejected (the single hash lookup misses → 401).
 *   5. Empty / null / non-string keys fail CLOSED before any DB call.
 *   6. Publishable keys still validate (and still can't do secret-only ops).
 *   + infrastructure faults PROPAGATE: a primary lookup that rejects
 *     (DB down, missing column) throws OUTWARD — no verdict ran, so the guard
 *     answers 503, not a lying 401. A rejecting REVOKED probe still degrades to
 *     the generic 401 (the verdict already ran). Still fail-closed either way.
 *
 * The hashes used here are computed with the SAME hashApiKeyForLookup() the
 * production code imports from @marginfront/db — if write-time and verify-time ever
 * disagreed, these tests would go red. (jest resolves @marginfront/db to the built
 * dist; the helper is pure node:crypto, so dist and source are byte-identical, as
 * the known-answer assertion in test 3 nails down.)
 */
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from './auth.service';
import { RevokedApiKeyException } from '../../common/exceptions/revoked-api-key.exception';

// Test keys. Test 3 checks the stored hash against a known answer computed with
// `printf '%s' <key> | shasum -a 256`, which equals Postgres's
// encode(digest(<key>,'sha256'),'hex').
const SECRET_KEY = 'mf_sk_known_answer_test';
const PUBLISHABLE_KEY = 'mf_pk_known_answer_test';
const KNOWN_SECRET_SQL_HEX = 'b729d50f743da58c0476057d4ab65f05a3923965f1a90f3ad851893732297e58';

interface FakeRow {
  id: string;
  // The key label + revocation stamp the revoked-row probe selects.
  name: string;
  organizationId: string;
  keyType: 'secret' | 'publishable';
  status: string;
  apiKeyLookupHash: string | null;
  apiKeyPlaintext: string | null;
  apiKeyHash: string | null;
  // validateApiKey filters deletedAt:null on
  // every lookup, so the fixture must carry it for the exact-equality mock to match.
  deletedAt: Date | null;
  revokedAt: Date | null;
  // The raw permissions blob parseKeyRole reads to stamp
  // user.role. Not part of any `where` filter — only ever read off the row.
  permissions: unknown;
  organizations: { id: string; name: string };
}

/**
 * Build an AuthService wired to an in-memory api_keys table whose findFirst does
 * EXACT-equality matching on every field in the `where` — faithfully reproducing
 * how Prisma evaluates validateApiKey's single hash lookup (there is no
 * plaintext or apiKeyHash fallback). Returns the service plus the
 * findFirst spy so tests can assert WHICH path matched and how many lookups it took.
 */
function buildService(rows: FakeRow[], opts: { rejectHashQuery?: boolean } = {}) {
  const findFirst = jest.fn(
    async ({ where }: { where: Record<string, unknown>; include?: unknown }) => {
      // Infrastructure-fault case: the apiKeyLookupHash column is missing, so a
      // query referencing it REJECTS (Prisma rejects on unknown column — it does
      // NOT resolve to null). validateApiKey must let that rejection propagate.
      if (opts.rejectHashQuery && Object.prototype.hasOwnProperty.call(where, 'apiKeyLookupHash')) {
        throw new Error('column "apiKeyLookupHash" does not exist');
      }
      const match = rows.find((row) =>
        Object.entries(where).every(([field, value]) => (row as any)[field] === value),
      );
      return match ?? null;
    },
  );

  const update = jest.fn().mockResolvedValue({});

  const prisma = { api_keys: { findFirst, update } } as any;
  const service = new AuthService(prisma);
  return { service, findFirst, update };
}

function makeRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: 'key-1',
    name: 'Prod server key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'active',
    apiKeyLookupHash: null,
    apiKeyPlaintext: null,
    apiKeyHash: 'bcrypt$2a$10$notarawkey',
    deletedAt: null, // live by default; the deleted-key test overrides this
    revokedAt: null,
    permissions: null, // no stored role by default → parseKeyRole floors to 'ingest'
    organizations: { id: 'org-1', name: 'Acme Co' },
    ...over,
  };
}

describe('AuthService.validateApiKey — lookup-hash auth', () => {
  // ---- 1. Key with a lookup hash authenticates via the HASH path ----------
  it('authenticates a key that has a lookup hash via the deterministic hash path (single lookup, no fallback)', async () => {
    // plaintext is null on purpose: the ONLY way this row can be found is the hash
    // path, so a green here is unambiguous proof the hash lookup works.
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      apiKeyPlaintext: null,
      keyType: 'secret',
    });
    const { service, findFirst } = buildService([row]);

    const user = await service.validateApiKey(SECRET_KEY);

    expect(user.organizationId).toBe('org-1');
    expect(user.organizationName).toBe('Acme Co');
    expect(user.keyType).toBe('secret');
    expect(user.authMethod).toBe('api-key');
    expect(user.apiKeyId).toBe('key-1');
    // Exactly one lookup → it matched on the FIRST (hash) query, with no fallback.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      status: 'active',
    });
  });

  // ---- 2. No plaintext fallback: a hash-less key is rejected ----
  it('rejects a key that has only plaintext and no lookup hash (no plaintext fallback)', async () => {
    // A row with a null hash and plaintext set is rejected: there is no plaintext
    // fallback, and this test fails if a plaintext matching path is added.
    const row = makeRow({
      apiKeyLookupHash: null,
      apiKeyPlaintext: SECRET_KEY,
      keyType: 'secret',
    });
    const { service, findFirst } = buildService([row]);

    await expect(service.validateApiKey(SECRET_KEY)).rejects.toBeInstanceOf(UnauthorizedException);
    // TWO lookups on a recognized-prefix miss: the active hash query
    // (misses — null hash) plus the revoked-row probe (misses too). No lookup is
    // ever issued against the plaintext column OR the apiKeyHash column
    // (there is no fallback to either).
    expect(findFirst).toHaveBeenCalledTimes(2);
    findFirst.mock.calls.forEach((call) => {
      expect(call[0].where).not.toHaveProperty('apiKeyPlaintext');
      expect(call[0].where).not.toHaveProperty('apiKeyHash');
    });
  });

  // ---- 3. Round-trip: write hash == verify hash == SQL hash ----------------
  it('uses ONE helper so the hash written on create equals the hash verify computes (and matches the known SHA-256 hex)', async () => {
    // WRITE side: this is exactly what every key creator stores
    // (api-keys.service / dashboard actions / organizations.service all call
    // hashApiKeyForLookup(rawKey)).
    const hashStoredOnCreate = hashApiKeyForLookup(SECRET_KEY);

    const row = makeRow({
      apiKeyLookupHash: hashStoredOnCreate,
      apiKeyPlaintext: null,
    });
    const { service, findFirst } = buildService([row]);

    // VERIFY side: validateApiKey must match using the identical value.
    await expect(service.validateApiKey(SECRET_KEY)).resolves.toMatchObject({
      organizationId: 'org-1',
    });
    expect(findFirst.mock.calls[0][0].where.apiKeyLookupHash).toBe(hashStoredOnCreate);

    // And that one value is byte-identical to Postgres's
    // `encode(digest(plaintext,'sha256'),'hex')`, pinned to a known hex.
    expect(hashStoredOnCreate).toBe(KNOWN_SECRET_SQL_HEX);
    expect(hashStoredOnCreate).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---- 4. Bogus key rejected -----------------------------------------------
  it('rejects a bogus key after the single hash lookup misses', async () => {
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      apiKeyPlaintext: SECRET_KEY,
    });
    const { service, findFirst } = buildService([row]);

    await expect(service.validateApiKey('mf_sk_totally_wrong_key')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Active lookup missed, then the revoked-row probe missed (recognized
    // prefix → the probe runs). No plaintext or apiKeyHash fallback.
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  // ---- 5. Empty / null / non-string fail CLOSED ----------------------------
  it('fails closed on empty, null, undefined, or non-string keys without touching the DB', async () => {
    const { service, findFirst } = buildService([
      makeRow({ apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY) }),
    ]);

    await expect(service.validateApiKey('')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.validateApiKey(null as any)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.validateApiKey(undefined as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.validateApiKey(12345 as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Critical: a falsy/invalid key must never reach the database (no empty-string
    // hash lookup, no fishing).
    expect(findFirst).not.toHaveBeenCalled();
  });

  // ---- 6. Publishable keys still work --------------------------------------
  it('validates publishable keys via the hash path and keeps the secret-only gate intact', async () => {
    const secretRow = makeRow({
      id: 'sk-1',
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      keyType: 'secret',
    });
    const pubRow = makeRow({
      id: 'pk-1',
      apiKeyLookupHash: hashApiKeyForLookup(PUBLISHABLE_KEY),
      keyType: 'publishable',
    });
    const { service } = buildService([secretRow, pubRow]);

    // Publishable key authenticates and is tagged as publishable.
    const pubUser = await service.validateApiKey(PUBLISHABLE_KEY);
    expect(pubUser.keyType).toBe('publishable');

    // validatePublishableKey accepts a publishable key...
    await expect(service.validatePublishableKey(PUBLISHABLE_KEY)).resolves.toMatchObject({
      keyType: 'publishable',
    });
    // ...but validateSecretKey must REJECT a publishable key (secret-only ops).
    await expect(service.validateSecretKey(PUBLISHABLE_KEY)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // ...and accept a real secret key.
    await expect(service.validateSecretKey(SECRET_KEY)).resolves.toMatchObject({
      keyType: 'secret',
    });
  });

  // ---- 7. Soft-deleted key must NOT authenticate ----------------------------
  it('refuses a soft-deleted key even though its lookup hash is still populated and status is active', async () => {
    // deleteApiKey soft-deletes by setting deletedAt but does NOT flip status off
    // 'active'. A lookup that filtered only apiKeyLookupHash + status would match,
    // so a deleted key — e.g. a leaked credential the owner explicitly removed —
    // would come back to life. Every lookup filters deletedAt:null, so this
    // worst-case row (hash populated, status STILL active, only deletedAt
    // distinguishing it) must be rejected by BOTH lookups.
    const deletedRow = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      status: 'active', // deleteApiKey leaves status active on purpose
      deletedAt: new Date('2026-06-28T00:00:00Z'),
    });
    const { service, findFirst, update } = buildService([deletedRow]);

    await expect(service.validateApiKey(SECRET_KEY)).rejects.toBeInstanceOf(UnauthorizedException);
    // The active hash lookup ran and missed on deletedAt, proving the verify layer
    // refuses it regardless of which credential columns a writer forgets to clear.
    // The revoked-row probe then ran too and missed on status:'revoked' —
    // a soft-deleted-but-active row must not earn the honest revoked message either.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
    expect(findFirst.mock.calls[1][0].where).toMatchObject({ status: 'revoked' });
    // And we never touched lastUsedAt for a key that failed to authenticate.
    expect(update).not.toHaveBeenCalled();
  });

  // ---- 8. role stamped from permissions ------------------
  it('stamps user.role from parseKeyRole(record.permissions)', async () => {
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      permissions: { role: 'finance' },
    });
    const { service } = buildService([row]);

    const user = await service.validateApiKey(SECRET_KEY);

    expect(user.role).toBe('finance');
  });

  // ---- + Infrastructure faults propagate -----------------------
  it('propagates an infrastructure fault so the guard can answer 503 (still fails closed)', async () => {
    // The primary lookup must not swallow this rejection: a .catch(() => null)
    // would dress a server outage as "Invalid API key". The raw error propagates:
    // no verdict ran, so CombinedAuthGuard mints the 503 at its choke point.
    // Still fail-closed — a throw authenticates nobody.
    const row = makeRow({ apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY) });
    const { service, findFirst } = buildService([row], { rejectHashQuery: true });

    const thrown = await service.validateApiKey(SECRET_KEY).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('column "apiKeyLookupHash" does not exist');
    // NOT an UnauthorizedException — that is the discriminator the guard keys on.
    expect(thrown).not.toBeInstanceOf(UnauthorizedException);
    // The primary rejected outward, so the revoked probe was never reached.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('a rejecting REVOKED probe still degrades to the generic 401, never a 503', async () => {
    // The probe's .catch(() => null) is KEPT on purpose: once the primary lookup
    // answered null, the credential verdict already ran — the probe only picks
    // WHICH 401 message we give. A verdict that ran must never be upgraded to
    // an outage answer.
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('pool timeout during the revoked probe'));
    const prisma = { api_keys: { findFirst, update: jest.fn() } } as any;
    const service = new AuthService(prisma);

    const thrown = await service.validateApiKey(SECRET_KEY).catch((e) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.message).toBe('Invalid API key');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});

// ---- the honest revoked-key 401 --------------------------------
describe('AuthService.validateApiKey — revoked-key probe', () => {
  const REVOKED_AT = new Date('2026-08-20T14:30:00.000Z');

  function revokedRow(over: Partial<FakeRow> = {}): FakeRow {
    return makeRow({
      status: 'revoked',
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      apiKeyPlaintext: null,
      revokedAt: REVOKED_AT,
      ...over,
    });
  }

  it('answers a revoked key with the distinct key_revoked 401 naming the revocation date', async () => {
    const { service, findFirst, update } = buildService([revokedRow()]);

    const rejection = service.validateApiKey(SECRET_KEY);
    await expect(rejection).rejects.toBeInstanceOf(RevokedApiKeyException);
    // Still an UnauthorizedException — the retained hash resurrects NOTHING;
    // the status:'active' clause keeps the revoked row out of the auth lookup.
    await expect(rejection).rejects.toBeInstanceOf(UnauthorizedException);

    const thrown = await rejection.catch((e) => e);
    expect(thrown.getResponse()).toEqual({
      statusCode: 401,
      code: 'key_revoked',
      message:
        'This API key was revoked on Aug 20, 2026. ' +
        'Create a new key in Build > API keys, then update the app that still sends this one.',
    });
    // The facts ride on the exception for the filter, never in the response.
    expect(thrown.facts).toEqual({
      organizationId: 'org-1',
      organizationName: 'Acme Co',
      keyLabel: 'Prod server key',
      revokedAt: REVOKED_AT,
    });
    // Active lookup + probe: exactly two queries, and no lastUsedAt touch.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the generic 401 for a revoked row whose hash is NULL', async () => {
    const row = revokedRow({ apiKeyLookupHash: null });
    const { service } = buildService([row]);

    const thrown = await service.validateApiKey(SECRET_KEY).catch((e) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(thrown).not.toBeInstanceOf(RevokedApiKeyException);
    expect(thrown.message).toBe('Invalid API key');
    expect(thrown.getResponse()).not.toHaveProperty('code');
  });

  it('never runs the probe for a key without a MarginFront api-key prefix (scanner gate)', async () => {
    const { service, findFirst } = buildService([revokedRow()]);

    await expect(service.validateApiKey('some-random-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Exactly ONE query: the active lookup. Scanner floods pay nothing extra.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('never runs the probe for a portal session token (prtl_ is not an api key)', async () => {
    const { service, findFirst } = buildService([revokedRow()]);

    await expect(service.validateApiKey('prtl_misrouted_token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('probes with FULL 64-char hash equality on status revoked only — no plaintext, no prefix match', async () => {
    const { service, findFirst } = buildService([]);

    await expect(service.validateApiKey(SECRET_KEY)).rejects.toBeInstanceOf(UnauthorizedException);

    const probeWhere = findFirst.mock.calls[1][0].where;
    expect(probeWhere).toEqual({
      apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY),
      status: 'revoked',
    });
    expect(probeWhere.apiKeyLookupHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the hit path at exactly ONE query (the probe never runs on a successful auth)', async () => {
    const row = makeRow({ apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY) });
    const { service, findFirst } = buildService([row]);

    await expect(service.validateApiKey(SECRET_KEY)).resolves.toMatchObject({
      organizationId: 'org-1',
    });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.validateApiKey — key expiry', () => {
  const liveRow = (expiresAt: Date | null) =>
    ({
      ...makeRow({ apiKeyLookupHash: hashApiKeyForLookup(SECRET_KEY) }),
      expiresAt,
    }) as FakeRow;

  it('rejects a key whose expiry date has passed, and says how to fix it', async () => {
    const { service } = buildService([liveRow(new Date('2020-01-01T00:00:00Z'))]);

    const rejection = service.validateApiKey(SECRET_KEY);

    await expect(rejection).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(rejection).rejects.toThrow(
      /expired on 2020-01-01T00:00:00.000Z.*Create a new key in the dashboard/,
    );
  });

  it('accepts a key whose expiry date is still in the future', async () => {
    const { service } = buildService([liveRow(new Date(Date.now() + 60 * 60 * 1000))]);

    await expect(service.validateApiKey(SECRET_KEY)).resolves.toMatchObject({
      organizationId: 'org-1',
    });
  });

  it('accepts a key with no expiry date (keys never expire unless one is set)', async () => {
    const { service } = buildService([liveRow(null)]);

    await expect(service.validateApiKey(SECRET_KEY)).resolves.toMatchObject({
      organizationId: 'org-1',
    });
  });

  it('does not update lastUsedAt for an expired key', async () => {
    const { service, update } = buildService([liveRow(new Date('2020-01-01T00:00:00Z'))]);

    await expect(service.validateApiKey(SECRET_KEY)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('AuthService.validatePortalSessionToken — only the hash is looked up', () => {
  const RAW_TOKEN = 'prtl_raw_portal_token_for_test';

  function buildPortalService(storedToken: string) {
    const session = {
      id: 'session-1',
      customerId: 'cust-1',
      organizationId: 'org-1',
      token: storedToken,
      customers: { id: 'cust-1', name: 'Pat', email: 'pat@example.com', organizationId: 'org-1' },
    };
    const findFirst = jest.fn(async ({ where }: any) =>
      where.token === session.token ? session : null,
    );
    const service = new AuthService({ portal_sessions: { findFirst } } as any);
    return { service, findFirst };
  }

  it('authenticates the raw token against its stored hash', async () => {
    const { service } = buildPortalService(hashApiKeyForLookup(RAW_TOKEN));

    await expect(service.validatePortalSessionToken(RAW_TOKEN)).resolves.toMatchObject({
      sessionId: 'session-1',
    });
  });

  it('never matches a token against the raw stored value, so a leaked hash is not a login', async () => {
    const { service, findFirst } = buildPortalService(RAW_TOKEN);

    await expect(service.validatePortalSessionToken(RAW_TOKEN)).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where.token).toBe(hashApiKeyForLookup(RAW_TOKEN));
  });
});
