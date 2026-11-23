/**
 * Proofs for the shared alert-recipient resolver, which cap alerts and pool
 * alerts both use so they hear the SAME chain. The
 * full chain behavior stays pinned end-to-end in cost-control.alerts.spec.ts
 * and pool-alert-evaluator.service.spec.ts; this pins the util's own contract.
 */

import { CAP_MANAGE_ROLES } from '@marginfront/db';
import { ALERT_RECIPIENT_ROLES, resolveAlertRecipients } from './alert-recipients';

function prismaWith(members: Array<{ role: string; email: string | null }>) {
  return {
    ba_member: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          members
            .filter((m) => !where.role?.in || where.role.in.includes(m.role))
            .map((m) => ({ users: { email: m.email } })),
        ),
      ),
    },
  };
}

describe('ALERT_RECIPIENT_ROLES', () => {
  it('IS CAP_MANAGE_ROLES — one source of truth, aliased, never re-declared', () => {
    expect(ALERT_RECIPIENT_ROLES).toBe(CAP_MANAGE_ROLES);
  });
});

describe('resolveAlertRecipients', () => {
  it('a set billing contact wins and the member table is never read', async () => {
    const prisma = prismaWith([{ role: 'owner', email: 'owner@acme.test' }]);
    const recipients = await resolveAlertRecipients(prisma as any, 'org-1', {
      billingIdentity: { email: 'billing@acme.test' },
    });
    expect(recipients).toEqual(['billing@acme.test']);
    expect(prisma.ba_member.findMany).not.toHaveBeenCalled();
  });

  it('falls back to owner/finance members, deduped case-insensitively, null emails skipped', async () => {
    const prisma = prismaWith([
      { role: 'owner', email: 'owner@acme.test' },
      { role: 'finance', email: 'OWNER@acme.test' },
      { role: 'finance', email: null },
      { role: 'finance', email: 'cfo@acme.test' },
    ]);
    const recipients = await resolveAlertRecipients(prisma as any, 'org-1', {
      billingIdentity: { legalName: 'Acme' },
    });
    expect(recipients).toEqual(['owner@acme.test', 'cfo@acme.test']);
    const where = prisma.ba_member.findMany.mock.calls[0][0].where;
    expect(where.role.in).toEqual([...ALERT_RECIPIENT_ROLES]);
  });

  it('no billing contact and no qualifying member: empty chain (the caller skips)', async () => {
    const prisma = prismaWith([{ role: 'member', email: 'dev@acme.test' }]);
    const recipients = await resolveAlertRecipients(prisma as any, 'org-1', null);
    expect(recipients).toEqual([]);
  });
});
