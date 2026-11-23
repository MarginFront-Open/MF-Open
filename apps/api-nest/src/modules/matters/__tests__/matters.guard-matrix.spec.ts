/**
 * The key-role matrix over the matter routes, all seven key roles
 * including 'legal', driven through the REAL guards against the
 * REAL MattersController metadata.
 *
 * Three layers, each proved separately because each fails separately:
 *   1. The trio wiring: every one of the 13 handlers carries
 *      @UseGuards(OrgRoleGuard) + @OrgRoles(owner/admin/finance/legal) +
 *      @OrgFromUser. @OrgRoles without @UseGuards is INERT metadata — the
 *      exact failure class a naive design hits — so the
 *      wiring itself is pinned, not assumed.
 *   2. OrgRoleGuard's matrix on those routes: legal/finance/admin/owner pass,
 *      member/developer/ingest deny.
 *   3. The two GLOBAL scope guards on the same routes: an ingest key denies
 *      and a legal key passes.
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { MattersController } from '../matters.controller';
import { OrgRoleGuard } from '../../../common/guards/org-role.guard';
import { IngestKeyScopeGuard } from '../../../common/guards/ingest-key-scope.guard';
import { LegalKeyScopeGuard } from '../../../common/guards/legal-key-scope.guard';
import { InsufficientKeyRoleException } from '../../../common/exceptions/insufficient-key-role.exception';
import { IngestKeyScopeForbiddenException } from '../../../common/exceptions/ingest-key-scope-forbidden.exception';

const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const LAW_ROLE_SET = ['owner', 'admin', 'finance', 'legal'];

const ALL_HANDLERS = [
  'getAudit',
  'getUnassigned',
  'assignEvent',
  'listMatters',
  'createMatter',
  'getMatter',
  'updateMatter',
  'deleteMatter',
  'listRules',
  'createRule',
  'applyRules',
  'updateRule',
  'deleteRule',
] as const;

type HandlerName = (typeof ALL_HANDLERS)[number];

// These three metadata keys are internal plumbing of org-role.guard.ts; the
// sweeps declare the same literals for the same reason (the consts are not all
// exported, and the STRING is the wire contract Nest reads).
const ORG_ROLES_KEY = 'orgRoles';
const ORG_FROM_USER_KEY = 'orgFromUser';

function handlerOf(name: HandlerName) {
  return (MattersController.prototype as unknown as Record<string, object>)[name];
}

function ctx(handler: HandlerName, user: Record<string, unknown> | undefined): ExecutionContext {
  return {
    getHandler: () => handlerOf(handler),
    getClass: () => MattersController,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: {},
        method: 'POST',
        route: { path: `/v1/matters-matrix/${handler}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

function keyUser(role: string) {
  return {
    authMethod: 'api-key' as const,
    organizationId: ORG_ID,
    userId: undefined,
    apiKeyId: 'key_matrix',
    keyType: 'secret',
    role,
  };
}

function makeOrgRoleGuard() {
  const findFirst = jest.fn();
  const prisma = { ba_member: { findFirst } } as any;
  return { guard: new OrgRoleGuard(prisma, new Reflector()), findFirst };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('layer 1 — the guard trio is WIRED on all 13 handlers, not just decorated', () => {
  it.each([...ALL_HANDLERS])('%s carries @UseGuards(OrgRoleGuard)', (name) => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handlerOf(name)) ?? [];
    expect(guards).toContain(OrgRoleGuard);
  });

  it.each([...ALL_HANDLERS])('%s carries @OrgRoles(owner/admin/finance/legal) exactly', (name) => {
    expect(Reflect.getMetadata(ORG_ROLES_KEY, handlerOf(name))).toEqual(LAW_ROLE_SET);
  });

  it.each([...ALL_HANDLERS])(
    '%s carries @OrgFromUser (authz in the org actually written)',
    (name) => {
      expect(Reflect.getMetadata(ORG_FROM_USER_KEY, handlerOf(name))).toBe(true);
    },
  );
});

describe('layer 2 — OrgRoleGuard matrix (representative write + read + audit)', () => {
  const representatives: HandlerName[] = ['createMatter', 'listMatters', 'getAudit'];

  describe.each(representatives)('%s', (handler) => {
    it.each(['legal', 'finance', 'admin', 'owner'])('a same-org %s key passes', async (role) => {
      const { guard, findFirst } = makeOrgRoleGuard();
      await expect(guard.canActivate(ctx(handler, keyUser(role)))).resolves.toBe(true);
      // The api-key path never consults ba_member.
      expect(findFirst).not.toHaveBeenCalled();
    });

    it.each(['member', 'developer'])(
      'a same-org %s key denies with the role list',
      async (role) => {
        const { guard } = makeOrgRoleGuard();
        await expect(guard.canActivate(ctx(handler, keyUser(role)))).rejects.toThrow(
          InsufficientKeyRoleException,
        );
      },
    );

    it('an explicit ingest key denies here too (defense in depth below the global guard)', async () => {
      const { guard } = makeOrgRoleGuard();
      await expect(guard.canActivate(ctx(handler, keyUser('ingest')))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});

describe('layer 3 — the two GLOBAL scope guards on matter routes', () => {
  it('an EXPLICIT ingest key is denied by IngestKeyScopeGuard on every matter handler', () => {
    const guard = new IngestKeyScopeGuard(new Reflector());
    for (const handler of ALL_HANDLERS) {
      expect(() => guard.canActivate(ctx(handler, keyUser('ingest')))).toThrow(
        IngestKeyScopeForbiddenException,
      );
    }
  });

  it('a legal key passes LegalKeyScopeGuard on every matter handler (its own surface)', () => {
    const guard = new LegalKeyScopeGuard(new Reflector());
    for (const handler of ALL_HANDLERS) {
      expect(guard.canActivate(ctx(handler, keyUser('legal')))).toBe(true);
    }
  });
});

describe('sessions still answer to the human role check', () => {
  function sessionUser() {
    return { authMethod: 'session' as const, userId: 'user_1', organizationId: ORG_ID };
  }

  it("a ba_member with role 'legal' passes a matter write", async () => {
    const { guard, findFirst } = makeOrgRoleGuard();
    findFirst.mockResolvedValue({ role: 'legal' });
    await expect(guard.canActivate(ctx('createMatter', sessionUser()))).resolves.toBe(true);
  });

  it("a ba_member with role 'member' is denied", async () => {
    const { guard, findFirst } = makeOrgRoleGuard();
    findFirst.mockResolvedValue({ role: 'member' });
    await expect(guard.canActivate(ctx('createMatter', sessionUser()))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
