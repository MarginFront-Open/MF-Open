/**
 * AuthService reads a key's role from its api_keys row on EVERY request. Nothing is
 * cached or stamped elsewhere, so a row edit takes effect on the next request and no
 * migration or re-mint is needed for a role to bind. A row that states no recognized role
 * is floored to 'ingest'.
 */

import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from './auth.service';

/**
 * An in-memory api_keys table whose findFirst does exact-equality matching on the
 * `where`, mirroring auth.service.spec.ts.
 */
const INGEST_KEY = 'mf_sk_per_request_role_probe';

function buildService(row: Record<string, unknown>) {
  const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const matches = Object.entries(where).every(
      ([field, value]) => (row as Record<string, unknown>)[field] === value,
    );
    return matches ? row : null;
  });
  const update = jest.fn().mockResolvedValue({});
  const prisma = { api_keys: { findFirst, update } } as never;
  return { service: new AuthService(prisma), findFirst };
}

function fieldKeyRow(permissions: unknown) {
  return {
    id: 'key-in-the-field',
    name: 'Prod ingest key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'active',
    apiKeyLookupHash: hashApiKeyForLookup(INGEST_KEY),
    apiKeyPlaintext: null,
    apiKeyHash: null,
    deletedAt: null,
    revokedAt: null,
    permissions,
    organizations: { id: 'org-1', name: 'Acme Co' },
  };
}

describe('the key role is read from the row on every request', () => {
  it('an api_keys row that states {"role":"ingest"} yields that role on the first request', async () => {
    const { service } = buildService(fieldKeyRow({ role: 'ingest' }));

    const user = await service.validateApiKey(INGEST_KEY);

    expect(user.role).toBe('ingest');
  });

  it('the role is derived per request, never cached: two calls issue two lookups against the same row', async () => {
    const { service, findFirst } = buildService(fieldKeyRow({ role: 'ingest' }));

    await service.validateApiKey(INGEST_KEY);
    await service.validateApiKey(INGEST_KEY);

    // One lookup per successful validate. If a role cache, a JWT claim, or a Redis
    // entry existed, the second call would not have to hit the table — and existing
    // keys would need a migration to pick the role up.
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('editing the row changes the answer on the NEXT request, with nothing to invalidate — the same property that makes an emergency role change take effect immediately', async () => {
    const row = fieldKeyRow({ role: 'ingest' });
    const { service } = buildService(row);

    expect((await service.validateApiKey(INGEST_KEY)).role).toBe('ingest');

    row.permissions = { role: 'developer' };
    const after = await service.validateApiKey(INGEST_KEY);

    expect(after.role).toBe('developer');
  });

  it('a row with null permissions authenticates with its role floored to ingest', async () => {
    const { service } = buildService(fieldKeyRow(null));

    const user = await service.validateApiKey(INGEST_KEY);

    expect(user.role).toBe('ingest');
  });

  it('an array-shaped permissions blob is floored to ingest too', async () => {
    const { service } = buildService(fieldKeyRow(['read:pricing', 'read:public']));

    const user = await service.validateApiKey(INGEST_KEY);

    expect(user.role).toBe('ingest');
  });
});
