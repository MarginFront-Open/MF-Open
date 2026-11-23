/**
 * SignalsController authorization wiring.
 *
 * Metadata-only assertions (no HTTP). This controller carries TWO distinct gates on purpose —
 * the line between money and build:
 *
 *  - signal cost-CLASSIFICATION is a MONEY write: it assigns the accounting cost
 *    category (COGS / R&D) that feeds margins and the books, so it carries Manage-MONEY
 *    (owner/admin/finance) in the caller's OWN org — the same lock the dashboard classifySignal
 *    action has, so this REST twin can't be used to bypass it.
 *
 *  - signal CRUD (create / update / bulk / delete) is metering-DEFINITION = BUILD area:
 *    defining a meter is operations plumbing, not a number, so it carries Manage-BUILD
 *    (owner/admin/developer), NOT finance. This test pins that boundary so
 *    a refactor can't silently collapse the two sets or drop a gate.
 *
 * The guard's actual deny behavior (cross-tenant, wrong-role, api-key, OrgFromUser) is already
 * covered by org-role.guard.spec.ts — we don't duplicate it; we just prove the right tag is on
 * the right route.
 */

import 'reflect-metadata';
import { SignalsController } from './signals.controller';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES, MANAGE_BUILD_ROLES } from '@marginfront/db';

const ORG_ROLES_KEY = 'orgRoles'; // written by @OrgRoles(...)
const ORG_FROM_USER_KEY = 'orgFromUser'; // written by @OrgFromUser()
const GUARDS_KEY = '__guards__'; // written by Nest's @UseGuards()

function metaOf<T>(key: string, method: keyof SignalsController): T | undefined {
  return Reflect.getMetadata(key, SignalsController.prototype[method] as any);
}

describe('SignalsController authorization wiring', () => {
  it('gates the cost-classification write to Manage-MONEY in the caller own org', () => {
    expect(metaOf<string[]>(ORG_ROLES_KEY, 'classify')).toEqual(['owner', 'admin', 'finance']);
    expect(metaOf<boolean>(ORG_FROM_USER_KEY, 'classify')).toBe(true);
    const guards = metaOf<any[]>(GUARDS_KEY, 'classify') ?? [];
    expect(guards).toContain(OrgRoleGuard);
    // sanity: finance IS in the money set — that is the whole point of the finance seat.
    expect([...MANAGE_MONEY_ROLES]).toEqual(['owner', 'admin', 'finance']);
  });

  it.each(['create', 'update', 'remove', 'bulkCreateOrUpdate'] as const)(
    'gates signal CRUD (%s) to Manage-BUILD in the caller own org',
    (method) => {
      expect(metaOf<string[]>(ORG_ROLES_KEY, method)).toEqual([...MANAGE_BUILD_ROLES]);
      expect(metaOf<boolean>(ORG_FROM_USER_KEY, method)).toBe(true);
      const guards = metaOf<any[]>(GUARDS_KEY, method) ?? [];
      expect(guards).toContain(OrgRoleGuard);
    },
  );

  it('keeps Manage-BUILD DISTINCT from Manage-MONEY: build excludes finance', () => {
    // owner/admin/developer — finance owns the books, not the
    // build plumbing, so finance is still excluded from the build set.
    expect([...MANAGE_BUILD_ROLES]).toEqual(['owner', 'admin', 'developer']);
    expect((MANAGE_BUILD_ROLES as readonly string[]).includes('finance')).toBe(false);
  });
});
