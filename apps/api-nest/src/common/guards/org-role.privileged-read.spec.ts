/**
 * PRIVILEGED-READ catalog test. `org-role.route-coverage.spec.ts` deliberately
 * excludes GET routes; this file is the catalog for the privileged reads.
 *
 * What this file proves, against the REAL classes (no mocking of the thing under test —
 * same harness as `mint-ceiling.spec.ts` / `org-role.key-enforcement.spec.ts`):
 *
 * 1. METADATA CATALOG: each of the privileged-read GETs (key-list x2, payout-status
 *    x3: Stripe connect status and payment-provider status/routing, spend-breakdown
 *    x2) carries
 *    `@UseGuards(OrgRoleGuard)` and the
 *    EXACT expected role set — so the gate can never silently loosen to
 *    `@OrgRoles()` (member-open) or lose its guard entirely.
 * 2. SESSION PATH: driving the REAL guard with a SESSION user proves owner/admin get
 *    every route, developer/finance split along the build-vs-money line drawn by
 *    MANAGE_BUILD_ROLES / MANAGE_MONEY_ROLES, and a plain MEMBER gets a clean 403 on all of them.
 * 3. KEY PATH: the same role gate as the session path applies to keys, via
 *    `InsufficientKeyRoleException`.
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRoleGuard } from './org-role.guard';
import { InsufficientKeyRoleException } from '../exceptions/insufficient-key-role.exception';
import { ApiKeysController } from '../../modules/api-keys/api-keys.controller';
import { StripeConnectController } from '../../modules/stripe-connect/stripe-connect.controller';
import { PaymentProvidersController } from '../../modules/payment-providers/payment-providers.controller';
import { CostControlController } from '../../modules/cost-control/cost-control.controller';
import { MANAGE_MONEY_ROLES, PRIV_READ_KEYS, PRIV_READ_PAYOUT } from '@marginfront/db';

const ORG_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ORG_ROLES_KEY = 'orgRoles';
const GUARDS_KEY = '__guards__';

interface CatalogEntry {
  key: string;
  ctor: (new (...args: unknown[]) => unknown) & { name: string };
  handlerName: string;
  expected: readonly string[];
}

const PRIVILEGED_READ_CATALOG: CatalogEntry[] = [
  {
    key: 'ApiKeysController#getApiKeys',
    ctor: ApiKeysController as any,
    handlerName: 'getApiKeys',
    expected: PRIV_READ_KEYS,
  },
  {
    key: 'ApiKeysController#getPublishableKeys',
    ctor: ApiKeysController as any,
    handlerName: 'getPublishableKeys',
    expected: PRIV_READ_KEYS,
  },
  {
    key: 'StripeConnectController#getAccountStatus',
    ctor: StripeConnectController as any,
    handlerName: 'getAccountStatus',
    expected: PRIV_READ_PAYOUT,
  },
  {
    key: 'PaymentProvidersController#findAll',
    ctor: PaymentProvidersController as any,
    handlerName: 'findAll',
    expected: PRIV_READ_PAYOUT,
  },
  {
    key: 'PaymentProvidersController#findOne',
    ctor: PaymentProvidersController as any,
    handlerName: 'findOne',
    expected: PRIV_READ_PAYOUT,
  },
  // The two spend-breakdown reads return per-repo/branch spend and teammate
  // emails, so they join the catalog at MANAGE_MONEY_ROLES — the same set the
  // internal-ai-spend page (their only human consumer) already gates on. The OTHER
  // cost-control reads (caps/spend/coverage) must never appear here: the code-cost-clarity
  // brake polls them with a developer-role key, and a role gate there silently disarms
  // every deployed cap (see cost-control.breakdown.role-gate.spec.ts).
  {
    key: 'CostControlController#getSpendBreakdown',
    ctor: CostControlController as any,
    handlerName: 'getSpendBreakdown',
    expected: MANAGE_MONEY_ROLES,
  },
  {
    key: 'CostControlController#getSpendBreakdownDrill',
    ctor: CostControlController as any,
    handlerName: 'getSpendBreakdownDrill',
    expected: MANAGE_MONEY_ROLES,
  },
];

function handlerOf(entry: CatalogEntry): (...args: unknown[]) => unknown {
  return (entry.ctor.prototype as Record<string, (...args: unknown[]) => unknown>)[
    entry.handlerName
  ];
}

describe('Privileged-read catalog — metadata can never silently revert to member-open', () => {
  it.each(PRIVILEGED_READ_CATALOG.map((e) => [e.key, e] as const))(
    '%s carries @UseGuards(OrgRoleGuard) + its exact expected role set',
    (_key, entry) => {
      const handler = handlerOf(entry);
      const guards: unknown[] = Reflect.getMetadata(GUARDS_KEY, handler) ?? [];
      expect(guards).toContain(OrgRoleGuard);
      expect(Reflect.getMetadata(ORG_ROLES_KEY, handler)).toEqual([...entry.expected]);
    },
  );
});

// ---------------------------------------------------------------------------
// Session path.
// ---------------------------------------------------------------------------

const SESSION_ROLES = ['owner', 'admin', 'developer', 'finance', 'member'] as const;
const HUMAN_UUID = 'human-priv-read-1111-2222-3333';

function sessionCtx(entry: CatalogEntry): ExecutionContext {
  return {
    getHandler: () => handlerOf(entry),
    getClass: () => entry.ctor,
    switchToHttp: () => ({
      getRequest: () => ({
        user: { authMethod: 'session', userId: HUMAN_UUID, organizationId: ORG_ID },
        params: { orgId: ORG_ID },
        method: 'GET',
        route: { path: `/${entry.key}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeSessionGuard(membershipRole: string) {
  const findFirst = jest.fn().mockResolvedValue({ role: membershipRole });
  const prisma = { ba_member: { findFirst } } as any;
  return { guard: new OrgRoleGuard(prisma, new Reflector()), findFirst };
}

describe('session callers', () => {
  for (const entry of PRIVILEGED_READ_CATALOG) {
    describe(entry.key, () => {
      it.each(SESSION_ROLES)('a %s session', async (role) => {
        const { guard, findFirst } = makeSessionGuard(role);
        const shouldAllow = (entry.expected as readonly string[]).includes(role);
        if (shouldAllow) {
          await expect(guard.canActivate(sessionCtx(entry))).resolves.toBe(true);
        } else {
          await expect(guard.canActivate(sessionCtx(entry))).rejects.toBeInstanceOf(
            ForbiddenException,
          );
        }
        // Every PRIV_READ_* set is non-empty, so the guard's no-DB-hit member fast-path
        // never applies here — the real ba_member row is always consulted.
        expect(findFirst).toHaveBeenCalledWith({
          where: { organizationId: ORG_ID, userId: HUMAN_UUID },
          select: { role: true },
        });
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Key path.
// ---------------------------------------------------------------------------

const ALL_KEY_ROLES = ['ingest', 'member', 'developer', 'finance', 'admin', 'owner'] as const;

function keyCtx(entry: CatalogEntry, role: string): ExecutionContext {
  return {
    getHandler: () => handlerOf(entry),
    getClass: () => entry.ctor,
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          authMethod: 'api-key',
          organizationId: ORG_ID,
          userId: undefined,
          apiKeyId: 'key_priv_read',
          role,
        },
        params: { orgId: ORG_ID },
        method: 'GET',
        route: { path: `/${entry.key}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeKeyGuard() {
  const findFirst = jest.fn();
  const prisma = { ba_member: { findFirst } } as any;
  return { guard: new OrgRoleGuard(prisma, new Reflector()), findFirst };
}

describe('key path — the same role gate as the session path', () => {
  for (const entry of PRIVILEGED_READ_CATALOG) {
    describe(entry.key, () => {
      it.each(ALL_KEY_ROLES)('a same-org %s-role key', async (role) => {
        const { guard, findFirst } = makeKeyGuard();
        const shouldAllow = (entry.expected as readonly string[]).includes(role);
        if (shouldAllow) {
          await expect(guard.canActivate(keyCtx(entry, role))).resolves.toBe(true);
        } else {
          await expect(guard.canActivate(keyCtx(entry, role))).rejects.toBeInstanceOf(
            InsufficientKeyRoleException,
          );
        }
        expect(findFirst).not.toHaveBeenCalled();
      });
    });
  }
});
