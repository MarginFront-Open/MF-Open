/**
 * A mint that did not persist must never answer 201.
 */

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';

import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { API_KEY_ACTOR_SENTINEL } from '../../common/helpers/get-user-id';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
// A REAL uuid: the shared harness in mint-ceiling.spec.ts uses
// 'human-1111-...' which is not one, and this file's stub rejects non-uuids.
const HUMAN_UUID = '11111111-2222-3333-4444-555566667777';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PrismaUuidViolation extends Error {
  code = 'P2023';
}

function makeStack(membershipRole: string | null) {
  const created: Array<Record<string, unknown>> = [];
  const create = jest.fn((args: { data: Record<string, unknown> }) => {
    // api_keys.createdById is `String @db.Uuid` with an FK to users: Postgres rejects a
    // non-uuid at the insert. prisma-client surfaces that as a REJECTED promise, never a
    // synchronous throw — a throwing stub would pass code that real prisma would not.
    if (!UUID_RE.test(String(args.data.createdById))) {
      return Promise.reject(
        new PrismaUuidViolation(
          `invalid input syntax for type uuid: "${String(args.data.createdById)}"`,
        ),
      );
    }
    created.push(args.data);
    return { id: `id-${created.length}`, name: args.data.name, createdAt: new Date() };
  });
  const prisma = {
    api_keys: { create },
    // Array-form $transaction settles like Promise.all: one rejected member rejects
    // the whole batch. Resolve-straight-through would mask exactly that.
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    ba_member: {
      findFirst: jest
        .fn()
        .mockResolvedValue(membershipRole === null ? null : { role: membershipRole }),
    },
  } as any;
  const service = new ApiKeysService(prisma);
  return { controller: new ApiKeysController(service), created, create };
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
      apiKeyId: 'ffffffff-0000-1111-2222-333344445555',
      role,
      userId: undefined,
    },
  };
}

/** A human-authed request carrying an actor id that Postgres will not store. */
function humanReqWithActorId(actorId: string) {
  return { user: { ...sessionReq().user, id: actorId, userId: actorId } };
}

describe('an API key cannot mint an API key', () => {
  it.each(['owner', 'admin', 'developer', 'finance'])(
    'a %s-role KEY is refused at POST /pair before any row write',
    async (role) => {
      const { controller, create } = makeStack('n/a');
      await expect(
        controller.createApiKeyPair(ORG_A, keyReq(role), { name: 'k', role: 'ingest' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(create).not.toHaveBeenCalled();
    },
  );

  // The 403 body IS the deliverable: a caller cannot act on a refusal that does not say where
  // to go instead. Pinned so the copy cannot rot, and so a string a customer reads carries no
  // em dash.
  it('tells the caller what to do instead, and names a real place to do it', async () => {
    const { controller } = makeStack('n/a');
    await expect(
      controller.createApiKeyPair(ORG_A, keyReq('owner'), { name: 'k', role: 'ingest' } as any),
    ).rejects.toThrow(/Create it while signed in.*dashboard under Build, then API keys/s);
  });

  it('carries no em dash in the customer-facing message', async () => {
    const { controller } = makeStack('n/a');
    const err: unknown = await controller
      .createApiKeyPair(ORG_A, keyReq('owner'), { name: 'k', role: 'ingest' } as any)
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/[—–]/);
  });
});

describe('a failed write never returns a success body', () => {
  function failingStack(boom: Error) {
    const service = new ApiKeysService({
      api_keys: { create: jest.fn(() => Promise.reject(boom)) },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      ba_member: { findFirst: jest.fn().mockResolvedValue({ role: 'owner' }) },
    } as any);
    return new ApiKeysController(service);
  }

  it('propagates a pair-write failure instead of fabricating keys', async () => {
    const boom = new Error('connection reset');
    await expect(
      failingStack(boom).createApiKeyPair(ORG_A, sessionReq(), {
        name: 'k',
        role: 'ingest',
      } as any),
    ).rejects.toBe(boom);
  });
});

describe('the human path still writes a real users.id', () => {
  it('a session mint stores the signed-in user id in createdById', async () => {
    const { controller, created } = makeStack('owner');
    await controller.createApiKeyPair(ORG_A, sessionReq(), { name: 'k', role: 'ingest' } as any);
    expect(created).toHaveLength(2);
    for (const row of created) {
      expect(row.createdById).toBe(HUMAN_UUID);
    }
  });
});

/**
 * assertHumanMinter already blocks the sentinel, so these read as redundant. They are not:
 * they check on their own that a failed row write is never caught and answered 201, against
 * any change that routes some other non-uuid actor id into createdById (a renamed
 * sentinel, an 'api-key:<id>' string like credit-pool's, an email).
 */
describe('a createdById Postgres will not store must never answer 201', () => {
  it.each([
    ['the api-key sentinel', API_KEY_ACTOR_SENTINEL],
    ['a descriptive actor string', 'api-key:ffffffff-0000-1111-2222-333344445555'],
  ])('a pair mint carrying %s rejects and stores nothing', async (_label, actorId) => {
    const { controller, created } = makeStack('owner');
    await expect(
      controller.createApiKeyPair(ORG_A, humanReqWithActorId(actorId), {
        name: 'k',
        role: 'ingest',
      } as any),
    ).rejects.toBeInstanceOf(PrismaUuidViolation);
    expect(created).toHaveLength(0);
  });
});
