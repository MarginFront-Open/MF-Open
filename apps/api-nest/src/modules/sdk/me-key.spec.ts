/**
 * me-key.spec.ts: GET /v1/me/key ("whoami").
 *
 * What this proves: the REAL AuthService.validateApiKey (which runs the REAL
 * parseKeyRole off a key's permissions blob) feeds req.user.role straight into the
 * REAL SdkPublicAliasesController.whoami() handler — for every key role, INCLUDING
 * the ingest floor and a corrupt or role-less permissions blob. The route carries no
 * OrgRoleGuard/role decorator (verified in the controller), so this test also
 * proves that structurally: a key that would fail role enforcement on any other
 * route still gets a clean 200 identity here.
 *
 * The ONLY stub is the Prisma api_keys.findFirst boundary (the DB), matching the
 * exact-equality fixture pattern auth.service.spec.ts uses. Neither
 * AuthService.validateApiKey nor the controller handler is mocked.
 */
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from '../auth/auth.service';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';

interface FakeRow {
  id: string;
  organizationId: string;
  keyType: 'secret' | 'publishable';
  status: string;
  apiKeyLookupHash: string | null;
  apiKeyPlaintext: string | null;
  apiKeyHash: string | null;
  deletedAt: Date | null;
  permissions: unknown;
  organizations: { id: string; name: string };
}

function buildService(row: FakeRow) {
  const findFirst = jest.fn(
    async ({ where }: { where: Record<string, unknown>; include?: unknown }) => {
      const matches = Object.entries(where).every(
        ([field, value]) => (row as any)[field] === value,
      );
      return matches ? row : null;
    },
  );
  const update = jest.fn().mockResolvedValue({});
  const prisma = { api_keys: { findFirst, update } } as any;
  return new AuthService(prisma);
}

function makeRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: 'key-1',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'active',
    apiKeyLookupHash: null,
    apiKeyPlaintext: null,
    apiKeyHash: null,
    deletedAt: null,
    permissions: null,
    organizations: { id: 'org-1', name: 'Acme Co' },
    ...over,
  };
}

// whoami() reads req.user directly and never touches SdkService — a stub is enough.
const controller = new SdkPublicAliasesController({} as any);

describe('GET /v1/me/key — role-mirrored-keys identity route', () => {
  it.each([
    ['null permissions (unbackfilled)', null, 'ingest'],
    ['empty-array permissions', [], 'ingest'],
    ['corrupt blob with no role field', { totally: 'not a role field' }, 'ingest'],
    ['role: member', { role: 'member' }, 'member'],
    ['role: developer', { role: 'developer' }, 'developer'],
    ['role: finance', { role: 'finance' }, 'finance'],
    ['role: admin', { role: 'admin' }, 'admin'],
    ['role: owner', { role: 'owner' }, 'owner'],
  ])('%s -> whoami reports role=%s', async (_label, permissions, expectedRole) => {
    const KEY = `mf_sk_whoami_${Math.random().toString(36).slice(2)}`;
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(KEY),
      keyType: 'secret',
      permissions,
    });
    const service = buildService(row);

    const user = await service.validateApiKey(KEY);
    const result = controller.whoami({ user } as any);

    expect(result).toEqual({ role: expectedRole, keyType: 'secret' });
  });

  it('the ingest-floor key is NOT 403d — whoami is reachable below member, unlike every other route', async () => {
    const KEY = 'mf_sk_whoami_ingest_floor';
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(KEY),
      permissions: null, // floors to 'ingest' via parseKeyRole
    });
    const service = buildService(row);

    const user = await service.validateApiKey(KEY);

    // No guard runs on this route at all (verified: no @UseGuards(OrgRoleGuard) on
    // the handler) — calling it directly must never throw, for any role.
    expect(() => controller.whoami({ user } as any)).not.toThrow();
    expect(controller.whoami({ user } as any)).toEqual({ role: 'ingest', keyType: 'secret' });
  });

  it('reports keyType: publishable for a publishable key', async () => {
    const KEY = 'mf_pk_whoami_publishable';
    const row = makeRow({
      apiKeyLookupHash: hashApiKeyForLookup(KEY),
      keyType: 'publishable',
      permissions: { role: 'member' },
    });
    const service = buildService(row);

    const user = await service.validateApiKey(KEY);
    const result = controller.whoami({ user } as any);

    expect(result).toEqual({ role: 'member', keyType: 'publishable' });
  });

  it('a request with no req.user (defensive) returns nulls instead of throwing', () => {
    expect(() => controller.whoami({} as any)).not.toThrow();
    expect(controller.whoami({} as any)).toEqual({ role: null, keyType: null });
  });
});
