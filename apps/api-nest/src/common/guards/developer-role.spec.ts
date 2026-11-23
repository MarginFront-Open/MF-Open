/**
 * The DEVELOPER role, end-to-end.
 *
 * This is the integration-level safety net for the role. Unlike the metadata-only
 * controller specs, this drives the REAL OrgRoleGuard.canActivate against the REAL @OrgRoles
 * metadata read off the REAL controllers, with a `developer` membership. It proves the
 * locked model where it actually lives — constant -> decorator -> guard — not in isolation:
 *
 *   developer = build writes + API keys, and NOT money, NOT org-settings, NOT payout, NOT team.
 *
 * Plain-English: it stands up the actual lock, hands it a developer's badge, and checks every
 * door — the build doors open, the money/org/payout doors stay shut.
 *
 * Includes a MUTATION / NEGATIVE CONTROL (bottom): it checks that a MANAGE_BUILD payout gate
 * WOULD admit a developer — so if an edit gates payouts on MANAGE_BUILD, this file goes red
 * instead of silently waving a developer into payouts.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';

import { OrgRoleGuard, ORG_MANAGE_ROLES } from './org-role.guard';
import {
  MANAGE_BUILD_ROLES,
  MANAGE_MONEY_ROLES,
  MINT_KEY_ROLES,
  canGrantRole,
  GRANTABLE_ROLES,
} from '@marginfront/db';

// The real controllers — we read their actual decorator metadata, not a hand-copied list.
import { StripeConnectController } from '../../modules/stripe-connect/stripe-connect.controller';
import { PaymentProvidersController } from '../../modules/payment-providers/payment-providers.controller';
import { ApiKeysController } from '../../modules/api-keys/api-keys.controller';
import { CustomersController } from '../../modules/customers/customers.controller';
import { AgentsController } from '../../modules/agents/agents.controller';

const ORG_ROLES_KEY = 'orgRoles';

/** Read the @OrgRoles role-set off a real controller method (undefined = decorator absent). */
function rolesOf(controllerProto: any, method: string): string[] | undefined {
  return Reflect.getMetadata(ORG_ROLES_KEY, controllerProto[method]);
}

/**
 * Stand up the REAL guard. ba_member.findFirst returns the supplied membership; the Reflector
 * reports the supplied required-role set. This is the same harness shape as org-role.guard.spec.
 */
function buildGuard(membership: { role: string } | null, requiredRoles: string[]) {
  const findFirst = jest.fn().mockResolvedValue(membership);
  const prisma = { ba_member: { findFirst } } as any;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => (key === 'orgFromUser' ? false : requiredRoles)),
  } as unknown as Reflector;
  return { guard: new OrgRoleGuard(prisma, reflector), findFirst };
}

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

// A developer of org A whose ACTIVE org is org B, so the guard takes the real ba_member
// lookup path (no member fast-path), checking the developer role against the URL org.
function ctxFor(): { ctx: ExecutionContext } {
  const user = { authMethod: 'session' as const, userId: 'dev-uuid', organizationId: ORG_B };
  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user, params: { orgId: ORG_A } }) }),
  } as unknown as ExecutionContext;
  return { ctx };
}

/** Run the real guard with a given membership role against a required-role set. */
async function allows(role: string, requiredRoles: string[]): Promise<boolean> {
  const { guard } = buildGuard({ role }, requiredRoles);
  const { ctx } = ctxFor();
  try {
    return await guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('DEVELOPER role end-to-end', () => {
  // ---- 1. The constant ripple: developer is in BUILD, and ONLY build ----
  describe('role-set membership (the constant ripple)', () => {
    it('developer is in MANAGE_BUILD_ROLES', () => {
      expect([...MANAGE_BUILD_ROLES]).toContain('developer');
    });
    it('developer is NOT in MANAGE_MONEY_ROLES', () => {
      expect([...MANAGE_MONEY_ROLES]).not.toContain('developer');
    });
    it('developer is NOT in ORG_MANAGE_ROLES', () => {
      expect([...ORG_MANAGE_ROLES]).not.toContain('developer');
    });
  });

  // ---- 2. Developer ACCESS through the REAL guard ----
  describe('developer access (real guard.canActivate)', () => {
    it('ALLOWED a build write (MANAGE_BUILD)', async () => {
      await expect(allows('developer', [...MANAGE_BUILD_ROLES])).resolves.toBe(true);
    });
    it('DENIED a money write (MANAGE_MONEY)', async () => {
      await expect(allows('developer', [...MANAGE_MONEY_ROLES])).resolves.toBe(false);
    });
    it('DENIED an org-settings write (ORG_MANAGE)', async () => {
      await expect(allows('developer', [...ORG_MANAGE_ROLES])).resolves.toBe(false);
    });

    // Mutation sensitivity: SAME guard wiring, only the badge role changes -> outcome flips.
    // Proves these tests read the role, not mere membership presence.
    it('flips on money: finance ALLOWED, developer DENIED (same set)', async () => {
      await expect(allows('finance', [...MANAGE_MONEY_ROLES])).resolves.toBe(true);
      await expect(allows('developer', [...MANAGE_MONEY_ROLES])).resolves.toBe(false);
    });
    it('flips on build: developer ALLOWED, member DENIED (same set)', async () => {
      await expect(allows('developer', [...MANAGE_BUILD_ROLES])).resolves.toBe(true);
      await expect(allows('member', [...MANAGE_BUILD_ROLES])).resolves.toBe(false);
    });
  });

  // ---- 3. Payout flip, asserted against the REAL controller metadata + driven through the guard ----
  describe('payout connectors are owner/admin-only (developer excluded)', () => {
    const payoutWrites: Array<[string, any, string]> = [
      ['stripe.generateOAuthUrl', StripeConnectController.prototype, 'generateOAuthUrl'],
      [
        'stripe.connectExistingAccount',
        StripeConnectController.prototype,
        'connectExistingAccount',
      ],
      ['stripe.disconnectAccount', StripeConnectController.prototype, 'disconnectAccount'],
      ['payment-providers.create', PaymentProvidersController.prototype, 'create'],
      ['payment-providers.update', PaymentProvidersController.prototype, 'update'],
      ['payment-providers.remove', PaymentProvidersController.prototype, 'remove'],
    ];

    it.each(payoutWrites)('%s is gated to ORG_MANAGE (not MANAGE_BUILD)', (_n, proto, method) => {
      const set = rolesOf(proto, method);
      expect(set).toEqual([...ORG_MANAGE_ROLES]);
      // The whole point: the build set is NOT what guards a payout write.
      expect(set).not.toEqual([...MANAGE_BUILD_ROLES]);
    });

    it.each(payoutWrites)(
      'a DEVELOPER is DENIED %s, owner/admin ALLOWED',
      async (_n, proto, method) => {
        const set = rolesOf(proto, method)!;
        expect(await allows('developer', set)).toBe(false);
        expect(await allows('owner', set)).toBe(true);
        expect(await allows('admin', set)).toBe(true);
      },
    );
  });

  // ---- 4. API keys — developer KEEPS them; gate is MINT_KEY_ROLES ----
  // The mint/revoke routes are gated on MINT_KEY_ROLES, not MANAGE_BUILD_ROLES
  // (= build roles PLUS finance) so a finance user may reach the mint door. Developer is
  // still in the set, so "developer keeps API keys" holds; the per-minter ceiling
  // (mintableKeyRoles) is what stops a developer from minting a money key.
  describe('API keys are gated to MINT_KEY_ROLES (developer keeps them, finance admitted)', () => {
    const apiKeyWrites = ['createApiKeyPair', 'revokeApiKey'];
    it.each(apiKeyWrites)('%s is gated to MINT_KEY_ROLES', (method) => {
      expect(rolesOf(ApiKeysController.prototype, method)).toEqual([...MINT_KEY_ROLES]);
    });
    it.each(apiKeyWrites)('a DEVELOPER is ALLOWED %s', async (method) => {
      const set = rolesOf(ApiKeysController.prototype, method)!;
      expect(await allows('developer', set)).toBe(true);
    });
    it.each(apiKeyWrites)('a FINANCE user is ALLOWED to reach %s', async (method) => {
      const set = rolesOf(ApiKeysController.prototype, method)!;
      expect(await allows('finance', set)).toBe(true);
    });
  });

  // ---- 5. Other build writes (customers/agents) admit developer ----
  describe('build writes admit developer (customers/agents)', () => {
    const buildWrites: Array<[any, string]> = [
      [CustomersController.prototype, 'createCustomer'],
      [CustomersController.prototype, 'updateCustomer'],
      [CustomersController.prototype, 'deleteCustomer'],
      [AgentsController.prototype, 'create'],
      [AgentsController.prototype, 'update'],
      [AgentsController.prototype, 'remove'],
    ];
    it.each(buildWrites)('%s.%s gated MANAGE_BUILD -> developer ALLOWED', async (proto, method) => {
      const set = rolesOf(proto, method);
      expect(set).toEqual([...MANAGE_BUILD_ROLES]);
      expect(await allows('developer', set!)).toBe(true);
    });
  });

  // ---- 6. Grant matrix: developer is grantable but grants nothing ----
  describe('developer grant rules', () => {
    it('owner and admin CAN grant developer', () => {
      expect(canGrantRole('owner', 'developer')).toBe(true);
      expect(canGrantRole('admin', 'developer')).toBe(true);
    });
    it('finance and member CANNOT grant developer', () => {
      expect(canGrantRole('finance', 'developer')).toBe(false);
      expect(canGrantRole('member', 'developer')).toBe(false);
    });
    it('a developer grants NOTHING (cannot invite/manage the team)', () => {
      for (const target of ['owner', 'admin', 'finance', 'developer', 'member']) {
        expect(canGrantRole('developer', target)).toBe(false);
      }
      expect(GRANTABLE_ROLES.developer).toEqual([]);
    });
  });

  // ---- 7. MUTATION / NEGATIVE CONTROL ----
  // A payout gate of MANAGE_BUILD WOULD let a developer connect/disconnect a payout
  // provider. If this assertion fails, MANAGE_BUILD no longer contains developer; if the
  // live payout controllers are gated on MANAGE_BUILD, the section-3 deny tests above go
  // red. Either way the payout gate is pinned from both sides.
  describe('negative control: a MANAGE_BUILD payout gate would leak', () => {
    it('developer WOULD pass a payout write gated on MANAGE_BUILD (proves the test can detect a regression)', async () => {
      expect(await allows('developer', [...MANAGE_BUILD_ROLES])).toBe(true);
      // ...and the live stripe connect gate is NOT that set:
      expect(rolesOf(StripeConnectController.prototype, 'connectExistingAccount')).not.toEqual([
        ...MANAGE_BUILD_ROLES,
      ]);
    });
  });
});
