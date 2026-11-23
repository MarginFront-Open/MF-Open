/**
 * Mint ceiling + finance-can-mint proof test.
 *
 * What this file proves, end to end:
 *   1. The mint/revoke ROUTE gate admits finance and developer — driven through the
 *      REAL OrgRoleGuard reading the REAL @OrgRoles metadata off the REAL ApiKeysController.
 *   2. The mint SERVICE ceiling caps WHICH role a mint may stamp — a finance minter mints only
 *      {finance, member, ingest}, a developer only {developer, member, ingest}, a member none —
 *      enforced on BOTH session (human) and key minters, and returning a real 403.
 *   3. Every minted key stores its role + provenance ({role, minterUserId, minterRole}), and a
 *      pair stamps the publishable half 'member' regardless of the secret's role.
 *
 * Why it is trustworthy (it can FAIL): it drives the REAL ApiKeysController -> REAL ApiKeysService
 * ceiling and the REAL OrgRoleGuard.canActivate. The ceiling assertion, the mintableKeyRoles map,
 * and the guard decision are NEVER mocked. The ONLY stubs are the two I/O boundaries that are not
 * the unit under test: Prisma's ba_member.findFirst (the minter's membership) and api_keys.create /
 * $transaction (the row write — captured so we can assert what got persisted).
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MINT_KEY_ROLES } from '@marginfront/db';

import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HUMAN_UUID = 'human-1111-2222-3333-444455556666';

// ---------------------------------------------------------------------------
// Service + controller harness. Prisma stubbed ONLY at ba_member / api_keys.
// ---------------------------------------------------------------------------

interface CreatedRow {
  name: string;
  permissions: unknown;
  keyType: string;
}

function makeStack(membershipRole: string | null) {
  const created: CreatedRow[] = [];
  const create = jest.fn((args: { data: any }) => {
    created.push({
      name: args.data.name,
      permissions: args.data.permissions,
      keyType: args.data.keyType,
    });
    return { id: `id-${created.length}`, name: args.data.name, createdAt: new Date() };
  });
  const baMemberFindFirst = jest
    .fn()
    .mockResolvedValue(membershipRole === null ? null : { role: membershipRole });
  const prisma = {
    api_keys: { create },
    // $transaction receives the ALREADY-built row objects (create runs synchronously to
    // build the array); resolve them straight through so the pair path destructures cleanly.
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    ba_member: { findFirst: baMemberFindFirst },
  } as any;
  const service = new ApiKeysService(prisma);
  const controller = new ApiKeysController(service);
  return { controller, created, create, baMemberFindFirst };
}

function sessionReq() {
  return {
    user: {
      id: HUMAN_UUID,
      email: 'human@example.com',
      authMethod: 'session' as const,
      userId: HUMAN_UUID,
      organizationId: ORG_A,
    },
  };
}

function keyReq(role: string) {
  return {
    user: {
      id: ORG_A,
      email: '',
      authMethod: 'api-key' as const,
      organizationId: ORG_A,
      apiKeyId: 'key_minter_1',
      role,
      userId: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. ROUTE GATE — the real guard against the real controller metadata.
// ---------------------------------------------------------------------------

const MINT_METHODS = ['createApiKeyPair', 'revokeApiKey'] as const;

function gateCtx(method: string): ExecutionContext {
  return {
    getHandler: () => (ApiKeysController.prototype as any)[method],
    getClass: () => ApiKeysController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          authMethod: 'session',
          userId: HUMAN_UUID,
          organizationId: ORG_A,
        },
        params: { orgId: ORG_A },
      }),
    }),
  } as unknown as ExecutionContext;
}

async function gateAllows(method: string, membershipRole: string): Promise<boolean> {
  const findFirst = jest.fn().mockResolvedValue({ role: membershipRole });
  const prisma = { ba_member: { findFirst } } as any;
  const guard = new OrgRoleGuard(prisma, new Reflector());
  try {
    return await guard.canActivate(gateCtx(method));
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('mint/revoke ROUTE gate (real guard + real metadata)', () => {
  it.each(MINT_METHODS)('%s carries @OrgRoles(...MINT_KEY_ROLES)', (method) => {
    const set = Reflect.getMetadata('orgRoles', (ApiKeysController.prototype as any)[method]);
    expect(set).toEqual([...MINT_KEY_ROLES]);
  });

  it.each(MINT_METHODS)('a FINANCE session reaches %s', async (method) => {
    await expect(gateAllows(method, 'finance')).resolves.toBe(true);
  });

  it.each(MINT_METHODS)('a DEVELOPER session reaches %s', async (method) => {
    await expect(gateAllows(method, 'developer')).resolves.toBe(true);
  });

  it.each(MINT_METHODS)('a MEMBER session is 403ed at %s', async (method) => {
    await expect(gateAllows(method, 'member')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. SERVICE CEILING — the real controller -> real service, both minter kinds.
// ---------------------------------------------------------------------------

// [minterRole, chosenRole, allowed], minter-kind-agnostic.
const CEILING: Array<[string, string, boolean]> = [
  // finance: money lane only
  ['finance', 'finance', true],
  ['finance', 'member', true],
  ['finance', 'ingest', true],
  ['finance', 'developer', false],
  ['finance', 'admin', false],
  ['finance', 'owner', false],
  // developer: build lane only
  ['developer', 'developer', true],
  ['developer', 'member', true],
  ['developer', 'ingest', true],
  ['developer', 'finance', false],
  ['developer', 'admin', false],
  ['developer', 'owner', false],
  // admin / owner: broad
  ['admin', 'finance', true],
  ['admin', 'developer', true],
  ['admin', 'owner', false],
  ['owner', 'owner', true],
  // member: mints nothing
  ['member', 'member', false],
  ['member', 'ingest', false],
];

describe('mint CEILING via a SESSION minter (real service)', () => {
  it.each(CEILING)(
    'a %s session minting a "%s" key -> allowed=%s',
    async (minterRole, chosenRole, allowed) => {
      const { controller, create } = makeStack(minterRole);
      const call = controller.createApiKeyPair(ORG_A, sessionReq(), {
        name: 'k',
        role: chosenRole,
      } as any);
      if (allowed) {
        await expect(call).resolves.toBeDefined();
        expect(create).toHaveBeenCalledTimes(2);
      } else {
        await expect(call).rejects.toBeInstanceOf(ForbiddenException);
        // 403 must be thrown BEFORE any row write.
        expect(create).not.toHaveBeenCalled();
      }
    },
  );

  it('a session minter with NO membership fails closed (mints nothing)', async () => {
    const { controller, create } = makeStack(null);
    await expect(
      controller.createApiKeyPair(ORG_A, sessionReq(), { name: 'k', role: 'ingest' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});

// A key mints nothing at all, so the ceiling matrix asserts refusal in every
// cell. The SESSION block above is the live ceiling test.
describe('a KEY minter is refused outright (real service, no ba_member hit)', () => {
  it.each(CEILING)('a %s KEY minting a "%s" key -> refused', async (minterRole, chosenRole) => {
    const { controller, create, baMemberFindFirst } = makeStack('should-not-be-read');
    await expect(
      controller.createApiKeyPair(ORG_A, keyReq(minterRole), {
        name: 'k',
        role: chosenRole,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
    expect(baMemberFindFirst).not.toHaveBeenCalled();
  });

  it('an ingest-floor KEY mints nothing', async () => {
    const { controller, create } = makeStack('n/a');
    await expect(
      controller.createApiKeyPair(ORG_A, keyReq('ingest'), { name: 'k', role: 'ingest' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. PROVENANCE — what actually gets written into api_keys.permissions.
// ---------------------------------------------------------------------------

describe('minted keys store role + provenance', () => {
  it('the secret key stamps {role, minterUserId, minterRole} from a session minter', async () => {
    const { controller, created } = makeStack('finance');
    await controller.createApiKeyPair(ORG_A, sessionReq(), {
      name: 'acct',
      role: 'finance',
    } as any);
    expect(created).toHaveLength(2);
    expect(created.find((k) => k.keyType === 'secret')!.permissions).toEqual({
      role: 'finance',
      minterUserId: HUMAN_UUID,
      minterRole: 'finance',
    });
  });

  it('omitting role defaults the key to the ingest floor', async () => {
    const { controller, created } = makeStack('developer');
    await controller.createApiKeyPair(ORG_A, sessionReq(), { name: 'sdk' } as any);
    expect(created.find((k) => k.keyType === 'secret')!.permissions).toMatchObject({
      role: 'ingest',
      minterRole: 'developer',
    });
  });

  it('a pair stamps the secret with the chosen role and the publishable as member', async () => {
    const { controller, created } = makeStack('developer');
    await controller.createApiKeyPair(ORG_A, sessionReq(), {
      name: 'pair',
      role: 'developer',
    } as any);
    const secret = created.find((k) => k.keyType === 'secret')!;
    const publishable = created.find((k) => k.keyType === 'publishable')!;
    expect(secret.permissions).toEqual({
      role: 'developer',
      minterUserId: HUMAN_UUID,
      minterRole: 'developer',
    });
    expect(publishable.permissions).toEqual({
      role: 'member',
      minterUserId: HUMAN_UUID,
      minterRole: 'developer',
    });
  });
});
