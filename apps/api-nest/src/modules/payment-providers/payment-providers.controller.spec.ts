/**
 * PaymentProvidersController authorization wiring.
 *
 * Connecting or disconnecting a payout provider redirects where revenue lands, so the writes
 * are gated to owner/admin (ORG_MANAGE), matching stripe-connect. The 'developer' role holds
 * MANAGE_BUILD and is excluded from changing payout destinations.
 *
 * Reads (findAll/findOne) carry PRIV_READ_PAYOUT (owner/admin/finance), the same
 * money-sensitive class as stripe-connect status. A plain member and a developer do not get
 * this read. Metadata-only assertions; the guard's deny behavior is covered by
 * org-role.guard.spec.ts and org-role.privileged-read.spec.ts.
 */

import 'reflect-metadata';
import { PaymentProvidersController } from './payment-providers.controller';
import { OrgRoleGuard, ORG_MANAGE_ROLES } from '../../common/guards/org-role.guard';
import { PRIV_READ_PAYOUT } from '@marginfront/db';

const ORG_ROLES_KEY = 'orgRoles';
const GUARDS_KEY = '__guards__';

function rolesOf(method: keyof PaymentProvidersController) {
  return Reflect.getMetadata(ORG_ROLES_KEY, PaymentProvidersController.prototype[method] as any);
}
function guardsOf(method: keyof PaymentProvidersController): any[] {
  return Reflect.getMetadata(GUARDS_KEY, PaymentProvidersController.prototype[method] as any) ?? [];
}

describe('PaymentProvidersController authorization wiring', () => {
  it.each(['create', 'update', 'remove'] as const)(
    'gates payout-provider write (%s) to ORG_MANAGE (owner/admin only)',
    (method) => {
      expect(rolesOf(method)).toEqual([...ORG_MANAGE_ROLES]);
      expect(guardsOf(method)).toContain(OrgRoleGuard);
    },
  );

  it.each(['findAll', 'findOne'] as const)(
    'gates reads (%s) to PRIV_READ_PAYOUT (owner/admin/finance)',
    (method) => {
      expect(rolesOf(method)).toEqual([...PRIV_READ_PAYOUT]);
      expect(guardsOf(method)).toContain(OrgRoleGuard);
    },
  );

  it('ORG_MANAGE excludes BOTH finance AND developer — redirecting payouts is owner/admin only', () => {
    // finance owns the books, developer owns the build — neither may change where revenue lands.
    ['finance', 'developer'].forEach((r) => {
      expect((ORG_MANAGE_ROLES as readonly string[]).includes(r)).toBe(false);
    });
  });
});
