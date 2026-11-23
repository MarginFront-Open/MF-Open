/**
 * Role-gate PROOF for the two credit-pool writes.
 *
 * Plain English: adding units to a pool and silencing a pool's emails are money
 * writes, so they carry the house money gate (MANAGE_MONEY_ROLES =
 * owner/admin/finance) — the same lock every subscription and invoice write
 * uses. The load-bearing case is 'developer': a developer can write every BUILD
 * surface but must not be able to hand a customer credits. The reads carry no
 * PER-ROUTE role decorator, which is what this spec measures.
 *
 * "ungated" here means no @OrgRoles decorator, NOT reachable by every
 * key. The global IngestKeyScopeGuard 403s an explicit ingest-role key on
 * these reads — credit-pool is not on its eight-handler allowlist. GET
 * /control/coverage IS allowlisted (the on-device brake reads it with the ingest
 * key it sends usage with) and these balances are not, so the two are not a
 * pair. The assertions below are unaffected, because a global APP_GUARD leaves
 * no per-route metadata.
 *
 * Why this is trustworthy (it can FAIL two independent ways):
 *   1. It reads the REAL decorator metadata off the REAL CreditPoolController
 *      class — the same Reflect keys NestJS reads at request time. Delete
 *      @OrgRoles from either write and this goes red; add a role decorator to
 *      a read and the no-per-route-decorator assertion goes red.
 *   2. It drives the REAL OrgRoleGuard.canActivate with only the ba_member
 *      lookup stubbed, for a human caller AND for an API key. The negative
 *      control replays the ungated behavior and shows a developer sails
 *      through, which is exactly the red the gate turns green.
 */

import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { InsufficientKeyRoleException } from '../../common/exceptions/insufficient-key-role.exception';
import { CreditPoolController } from './credit-pool.controller';

const ORG = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const WRITE_HANDLERS = ['createTopup', 'setAlertsPaused'] as const;
const READ_HANDLERS = ['listBalances', 'getBalance'] as const;

function metadataFor(handler: string) {
  const fn = (CreditPoolController.prototype as any)[handler];
  return {
    guards: (Reflect.getMetadata(GUARDS_METADATA, fn) ?? []) as Array<{ name?: string }>,
    orgRoles: Reflect.getMetadata('orgRoles', fn) as string[] | undefined,
    orgFromUser: Reflect.getMetadata('orgFromUser', fn) as boolean | undefined,
  };
}

/** The REAL guard, with only the ba_member role lookup stubbed. */
function realGuard(callerRole: string | null) {
  const findFirst = jest.fn().mockResolvedValue(callerRole ? { role: callerRole } : null);
  const prisma = { ba_member: { findFirst } } as any;
  return new OrgRoleGuard(prisma, new Reflector());
}

function ctxFor(handler: string, user: any): ExecutionContext {
  return {
    getHandler: () => (CreditPoolController.prototype as any)[handler],
    getClass: () => CreditPoolController,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: {},
        method: 'POST',
        route: { path: `/v1/subscriptions/:id/${handler}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

const human = (role: string) => ({
  authMethod: 'session' as const,
  userId: `user-${role}`,
  organizationId: ORG,
});

const apiKey = (role: string) => ({
  authMethod: 'api-key' as const,
  organizationId: ORG,
  apiKeyId: 'key_test_123',
  role,
});

describe('credit-pool write routes carry the real money gate', () => {
  it.each(WRITE_HANDLERS)(
    '%s declares OrgRoleGuard + MANAGE_MONEY_ROLES + OrgFromUser',
    (handler) => {
      const meta = metadataFor(handler);
      expect(meta.guards.map((g) => g?.name)).toContain('OrgRoleGuard');
      expect(meta.orgRoles).toEqual([...MANAGE_MONEY_ROLES]);
      expect(meta.orgFromUser).toBe(true);
    },
  );

  it('MANAGE_MONEY_ROLES is owner/admin/finance — the declared books-write set', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual(['admin', 'finance', 'owner']);
  });

  it.each(READ_HANDLERS)(
    '%s carries no per-route role decorator (the global ingest-scope deny still applies)',
    (handler) => {
      const meta = metadataFor(handler);
      expect(meta.orgRoles).toBeUndefined();
      expect(meta.guards.map((g) => g?.name)).not.toContain('OrgRoleGuard');
    },
  );
});

describe('credit-pool writes — human callers through the REAL guard', () => {
  describe('negative control — ungated stand-in', () => {
    const ungatedAllowAll: CanActivate = { canActivate: () => true };
    it('UNGATED: a developer top-up is wrongly allowed (this is what the gate closes)', () => {
      expect(ungatedAllowAll.canActivate(ctxFor('createTopup', human('developer')) as any)).toBe(
        true,
      );
    });
  });

  for (const handler of WRITE_HANDLERS) {
    describe(handler, () => {
      it.each(['owner', 'admin', 'finance'])('%s is allowed', async (role) => {
        await expect(realGuard(role).canActivate(ctxFor(handler, human(role)))).resolves.toBe(true);
      });

      it('developer is REJECTED — the build seat is not a money seat', async () => {
        await expect(
          realGuard('developer').canActivate(ctxFor(handler, human('developer'))),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('member is REJECTED', async () => {
        await expect(
          realGuard('member').canActivate(ctxFor(handler, human('member'))),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('a non-member of the org is REJECTED', async () => {
        await expect(
          realGuard(null).canActivate(ctxFor(handler, human('owner'))),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  }
});

describe('credit-pool writes — API keys get role guidance, not a bare 403', () => {
  it.each(WRITE_HANDLERS)(
    '%s: a developer key is refused with the roles that would work',
    async (handler) => {
      let thrown: unknown;
      try {
        await realGuard('developer').canActivate(ctxFor(handler, apiKey('developer')));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InsufficientKeyRoleException);
      const body = (thrown as InsufficientKeyRoleException).getResponse() as {
        key_role: string;
        required_roles: string[];
        message: string;
      };
      expect(body.key_role).toBe('developer');
      expect(body.required_roles).toEqual([...MANAGE_MONEY_ROLES]);
      expect(body.message).toContain('developer');
      expect(body.message).toContain('owner, admin, finance');
    },
  );

  it.each(WRITE_HANDLERS)('%s: a finance key is allowed', async (handler) => {
    await expect(
      realGuard('finance').canActivate(ctxFor(handler, apiKey('finance'))),
    ).resolves.toBe(true);
  });
});
