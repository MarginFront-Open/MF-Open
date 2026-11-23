/**
 * CustomerAlertsService CRUD proofs.
 *
 * Same Prisma-surface mock discipline as cost-control.service.spec.ts: the
 * real service logic runs; only the DB boundary is stubbed. What this pins,
 * each red against a broken impl:
 *   1. IDOR: a cross-org customerId 404s exactly like an unknown id.
 *   2. Internal code-cost-clarity accounts are refused with the exact routing message;
 *      soft-deleted customers are refused.
 *   3. Custom dates are required-and-ordered iff mode 'custom', forbidden
 *      otherwise — on create AND against the resulting state on update.
 *   4. Recipient identity: session creates deliver to the CREATOR (notifyEmail
 *      must be self or absent); API-key creates REQUIRE notifyEmail of a
 *      money-role org member, stored once on the row.
 *   5. Duplicate watches 409; the 100-per-org ceiling 400s.
 *   6. Update: mode flip clears custom dates + the rolling latch; a session
 *      PATCH re-resolves the stored recipientEmail from the current login
 *      email, so a changed login email does not leave a stale recipient.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { CUSTOMER_ALERT_MAX_PER_ORG, Prisma } from '@marginfront/db';
import { CustomerAlertsService } from './customer-alerts.service';
import { CreateCustomerAlertDto } from './dto/create-customer-alert.dto';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const CUSTOMER = 'cust-1';
const CREATOR = 'user-creator';

interface CustomerSeed {
  id: string;
  organizationId: string;
  name: string;
  externalId?: string | null;
  isInternal?: boolean;
  deletedAt?: Date | null;
}

interface UserSeed {
  id: string;
  email: string | null;
}

interface MemberSeed {
  orgId: string;
  role: string;
  userId: string;
}

function buildService(
  opts: {
    customers?: CustomerSeed[];
    users?: UserSeed[];
    members?: MemberSeed[];
    existingAlerts?: any[];
  } = {},
) {
  const customers = opts.customers ?? [
    { id: CUSTOMER, organizationId: ORG, name: 'Acme', externalId: 'acme-1' },
  ];
  const users = opts.users ?? [{ id: CREATOR, email: 'creator@org.test' }];
  const members = opts.members ?? [{ orgId: ORG, role: 'finance', userId: CREATOR }];
  const alerts: any[] = [...(opts.existingAlerts ?? [])];
  let nextId = 1;

  const withCustomer = (row: any) => ({
    ...row,
    customers: (() => {
      const c = customers.find((x) => x.id === row.customerId);
      return c ? { id: c.id, name: c.name, externalId: c.externalId ?? null } : null;
    })(),
  });

  const matches = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (v instanceof Decimal || typeof v === 'number') {
        if (new Decimal(row[k] ?? NaN).toString() !== new Decimal(v as any).toString())
          return false;
      } else if (v instanceof Date) {
        if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
      } else if (v !== null && typeof v === 'object' && 'not' in (v as object)) {
        if (row[k] === (v as { not: unknown }).not) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };

  const prisma: any = {
    customers: {
      findFirst: ({ where }: any) => {
        const found = customers.find(
          (c) => c.id === where.id && c.organizationId === where.organizationId,
        );
        return Promise.resolve(
          found
            ? {
                id: found.id,
                name: found.name,
                isInternal: found.isInternal ?? false,
                deletedAt: found.deletedAt ?? null,
              }
            : null,
        );
      },
    },
    users: {
      findUnique: ({ where }: any) => Promise.resolve(users.find((u) => u.id === where.id) ?? null),
    },
    ba_member: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          members
            .filter((m) => m.orgId === where.organizationId)
            .map((m) => ({
              role: m.role,
              users: (() => {
                const u = users.find((x) => x.id === m.userId);
                return u ? { id: u.id, email: u.email } : null;
              })(),
            })),
        ),
    },
    customer_alerts: {
      count: ({ where }: any) =>
        Promise.resolve(alerts.filter((a) => a.orgId === where.orgId).length),
      findFirst: ({ where }: any) => Promise.resolve(alerts.find((a) => matches(a, where)) ?? null),
      findMany: ({ where }: any) =>
        Promise.resolve(alerts.filter((a) => a.orgId === where.orgId).map((a) => withCustomer(a))),
      create: ({ data }: any) => {
        const row = {
          id: `alert-${nextId++}`,
          triggeredAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
          thresholdUsd: new Decimal(data.thresholdUsd),
        };
        alerts.push(row);
        return Promise.resolve(withCustomer(row));
      },
      update: ({ where, data }: any) => {
        const row = alerts.find((a) => a.id === where.id);
        if (!row) return Promise.reject(new Error('not found'));
        Object.assign(row, data, {
          thresholdUsd: new Decimal(data.thresholdUsd ?? row.thresholdUsd),
          updatedAt: new Date(),
        });
        return Promise.resolve(withCustomer(row));
      },
      delete: ({ where }: any) => {
        const i = alerts.findIndex((a) => a.id === where.id);
        if (i === -1) return Promise.reject(new Error('not found'));
        const [row] = alerts.splice(i, 1);
        return Promise.resolve(row);
      },
    },
  };

  const email = {
    sendCustomerAlertConfirmationEmail: jest.fn().mockResolvedValue({ id: 'sent' }),
    sendCustomerAlertEmail: jest.fn().mockResolvedValue({ id: 'sent' }),
  };
  const revenueMetrics = {
    getCostMetrics: jest.fn(),
    getRevenueMetrics: jest.fn(),
  };
  const service = new CustomerAlertsService(prisma, email as any, revenueMetrics as any);
  return { service, alerts, prisma, email };
}

const baseDto = (over: Partial<CreateCustomerAlertDto> = {}): CreateCustomerAlertDto =>
  ({
    customerId: CUSTOMER,
    metric: 'cost',
    thresholdUsd: 500,
    windowMode: 'month',
    ...over,
  }) as CreateCustomerAlertDto;

describe('createAlert — customer scoping (IDOR)', () => {
  it('creates a watch for an own-org customer and stores the tripwire', async () => {
    const { service, alerts } = buildService();
    const alert = await service.createAlert(ORG, CREATOR, baseDto());
    expect(alert.customerId).toBe(CUSTOMER);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].orgId).toBe(ORG);
    expect(alerts[0].metric).toBe('cost');
    expect(alerts[0].thresholdUsd.toString()).toBe('500');
  });

  it('404s a customerId that belongs to ANOTHER org, exactly like an unknown id', async () => {
    const { service } = buildService({
      customers: [{ id: CUSTOMER, organizationId: OTHER_ORG, name: 'Not yours' }],
    });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s an unknown customerId', async () => {
    const { service } = buildService({ customers: [] });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('createAlert — internal and deleted customers are refused', () => {
  it('rejects an internal code-cost-clarity account with the exact routing message', async () => {
    const { service } = buildService({
      customers: [{ id: CUSTOMER, organizationId: ORG, name: 'dev@co.example', isInternal: true }],
    });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toThrow(
      'This is an internal code-cost-clarity account. Customer watches cover real customers; ' +
        'use Internal AI Spend caps for coding-agent spend.',
    );
  });

  it('rejects a soft-deleted customer', async () => {
    const { service } = buildService({
      customers: [
        { id: CUSTOMER, organizationId: ORG, name: 'Gone', deletedAt: new Date('2026-01-01') },
      ],
    });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('createAlert — custom dates iff custom mode', () => {
  it('custom mode without dates is refused', async () => {
    const { service } = buildService();
    await expect(
      service.createAlert(ORG, CREATOR, baseDto({ windowMode: 'custom' })),
    ).rejects.toThrow(/custom window needs both/i);
  });

  it('custom mode with reversed dates is refused', async () => {
    const { service } = buildService();
    await expect(
      service.createAlert(
        ORG,
        CREATOR,
        baseDto({
          windowMode: 'custom',
          customStartDate: '2026-09-01T00:00:00.000Z',
          customEndDate: '2026-08-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/before customEndDate/i);
  });

  it('month mode WITH custom dates is refused (a contradiction, not ignored)', async () => {
    const { service } = buildService();
    await expect(
      service.createAlert(ORG, CREATOR, baseDto({ customStartDate: '2026-08-01T00:00:00.000Z' })),
    ).rejects.toThrow(/only apply to the 'custom' window/i);
  });

  it('custom mode with an ordered pair stores both dates', async () => {
    const { service, alerts } = buildService();
    await service.createAlert(
      ORG,
      CREATOR,
      baseDto({
        windowMode: 'custom',
        customStartDate: '2026-08-01T00:00:00.000Z',
        customEndDate: '2026-08-31T00:00:00.000Z',
      }),
    );
    expect(alerts[0].customStartDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(alerts[0].customEndDate.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});

describe('createAlert — recipient identity (alerts go to the creator)', () => {
  it('a session create stores the CREATOR as recipient, email resolved from users', async () => {
    const { service, alerts } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto());
    expect(alerts[0].recipientUserId).toBe(CREATOR);
    expect(alerts[0].recipientEmail).toBe('creator@org.test');
    expect(alerts[0].createdByUserId).toBe(CREATOR);
  });

  it('a session create may pass its OWN email as notifyEmail (case-insensitive)', async () => {
    const { service, alerts } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto({ notifyEmail: 'CREATOR@org.test' }));
    expect(alerts[0].recipientEmail).toBe('creator@org.test');
  });

  it('a session create pointing notifyEmail at a TEAMMATE is refused', async () => {
    const { service } = buildService({
      users: [
        { id: CREATOR, email: 'creator@org.test' },
        { id: 'user-cfo', email: 'cfo@org.test' },
      ],
      members: [
        { orgId: ORG, role: 'finance', userId: CREATOR },
        { orgId: ORG, role: 'finance', userId: 'user-cfo' },
      ],
    });
    await expect(
      service.createAlert(ORG, CREATOR, baseDto({ notifyEmail: 'cfo@org.test' })),
    ).rejects.toThrow(/send alerts to you/i);
  });

  it('an API-key create (no session user) without notifyEmail is refused, naming the fix', async () => {
    const { service } = buildService();
    await expect(service.createAlert(ORG, undefined, baseDto())).rejects.toThrow(
      /pass notifyEmail/i,
    );
  });

  it('an API-key create with a NON-member email is refused', async () => {
    const { service } = buildService();
    await expect(
      service.createAlert(ORG, undefined, baseDto({ notifyEmail: 'stranger@spam.test' })),
    ).rejects.toThrow(/No member of your organization/i);
  });

  it('an API-key create naming a developer-role member is refused, naming the allowed roles', async () => {
    const { service } = buildService({
      users: [{ id: 'user-dev', email: 'dev@org.test' }],
      members: [{ orgId: ORG, role: 'developer', userId: 'user-dev' }],
    });
    await expect(
      service.createAlert(ORG, undefined, baseDto({ notifyEmail: 'dev@org.test' })),
    ).rejects.toThrow(/owner, admin, finance/);
  });

  it('an API-key create naming a money-role member stores that member (case-insensitive match, stored casing)', async () => {
    const { service, alerts } = buildService({
      users: [{ id: 'user-cfo', email: 'CFO@org.test' }],
      members: [{ orgId: ORG, role: 'finance', userId: 'user-cfo' }],
    });
    await service.createAlert(ORG, undefined, baseDto({ notifyEmail: 'cfo@org.test' }));
    expect(alerts[0].recipientUserId).toBe('user-cfo');
    expect(alerts[0].recipientEmail).toBe('CFO@org.test');
    expect(alerts[0].createdByUserId).toBeNull();
  });
});

describe('createAlert — duplicates and the per-org ceiling', () => {
  it('an exact functional duplicate 409s', async () => {
    const { service } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto());
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('a different threshold is NOT a duplicate', async () => {
    const { service, alerts } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto());
    await service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 900 }));
    expect(alerts).toHaveLength(2);
  });

  it(`the ${CUSTOMER_ALERT_MAX_PER_ORG}-watch org ceiling 400s with a plain-English message`, async () => {
    const existing = Array.from({ length: CUSTOMER_ALERT_MAX_PER_ORG }, (_, i) => ({
      id: `pre-${i}`,
      orgId: ORG,
      customerId: CUSTOMER,
      metric: 'revenue',
      thresholdUsd: new Decimal(i + 1),
      windowMode: 'month',
      customStartDate: null,
      customEndDate: null,
      recipientUserId: CREATOR,
      recipientEmail: 'creator@org.test',
      createdByUserId: CREATOR,
      triggeredAt: null,
    }));
    const { service } = buildService({ existingAlerts: existing });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toThrow(/limit/i);
  });
});

describe('updateAlert', () => {
  async function seeded() {
    const built = buildService({
      users: [{ id: CREATOR, email: 'creator@org.test' }],
    });
    const alert = await built.service.createAlert(ORG, CREATOR, baseDto());
    return { ...built, alertId: alert.id };
  }

  it('404s an alert id from another org', async () => {
    const { service, alertId } = await seeded();
    await expect(
      service.updateAlert(OTHER_ORG, alertId, CREATOR, { thresholdUsd: 900 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates threshold in place', async () => {
    const { service, alerts, alertId } = await seeded();
    await service.updateAlert(ORG, alertId, CREATOR, { thresholdUsd: 900 });
    expect(alerts[0].thresholdUsd.toString()).toBe('900');
  });

  it('a flip to custom requires the date pair against the RESULTING state', async () => {
    const { service, alertId } = await seeded();
    await expect(
      service.updateAlert(ORG, alertId, CREATOR, { windowMode: 'custom' }),
    ).rejects.toThrow(/custom window needs both/i);
  });

  it('a flip away from custom clears the stored dates and the rolling latch', async () => {
    const { service, alerts } = buildService();
    const created = await service.createAlert(
      ORG,
      CREATOR,
      baseDto({
        windowMode: 'custom',
        customStartDate: '2026-08-01T00:00:00.000Z',
        customEndDate: '2026-08-31T00:00:00.000Z',
      }),
    );
    alerts[0].triggeredAt = new Date('2026-08-10T00:00:00.000Z'); // simulate a stale latch
    await service.updateAlert(ORG, created.id, CREATOR, { windowMode: 'rolling' });
    expect(alerts[0].customStartDate).toBeNull();
    expect(alerts[0].customEndDate).toBeNull();
    expect(alerts[0].triggeredAt).toBeNull();
    expect(alerts[0].windowMode).toBe('rolling');
  });

  it('a session PATCH re-resolves the stored recipientEmail from the current login email', async () => {
    const users = [{ id: CREATOR, email: 'creator@org.test' }];
    const { service, alerts } = buildService({ users });
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    users[0].email = 'renamed@org.test'; // the user changed their login email
    await service.updateAlert(ORG, created.id, CREATOR, { thresholdUsd: 600 });
    expect(alerts[0].recipientEmail).toBe('renamed@org.test');
  });

  it('an API-key PATCH leaves the stored recipientEmail alone', async () => {
    const users = [{ id: CREATOR, email: 'creator@org.test' }];
    const { service, alerts } = buildService({ users });
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    users[0].email = 'renamed@org.test';
    await service.updateAlert(ORG, created.id, undefined, { thresholdUsd: 600 });
    expect(alerts[0].recipientEmail).toBe('creator@org.test');
  });

  it('a deleted recipient user keeps the stored address (the survival property)', async () => {
    const users: any[] = [{ id: CREATOR, email: 'creator@org.test' }];
    const { service, alerts } = buildService({ users });
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    users.length = 0; // the creator's user row is gone
    await service.updateAlert(ORG, created.id, 'user-someone-else', { thresholdUsd: 700 });
    expect(alerts[0].recipientEmail).toBe('creator@org.test');
  });

  it('a PATCH that shapes an exact copy of another watch 409s (the create rule, on edit)', async () => {
    const { service } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 500 }));
    const b = await service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 900 }));
    await expect(
      service.updateAlert(ORG, b.id, CREATOR, { thresholdUsd: 500 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a PATCH to a DIFFERENT tuple sails past the duplicate check', async () => {
    const { service, alerts } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 500 }));
    const b = await service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 900 }));
    await service.updateAlert(ORG, b.id, CREATOR, { thresholdUsd: 950 });
    expect(alerts[1].thresholdUsd.toString()).toBe('950');
  });

  it('a PATCH that leaves the tuple unchanged skips the check even if a twin already exists', async () => {
    // Two identical rows seeded straight into the table, bypassing the service check.
    // Re-saving one untouched must not 409 — the check runs only when the
    // resulting tuple CHANGES.
    const twin = (id: string) => ({
      id,
      orgId: ORG,
      customerId: CUSTOMER,
      metric: 'cost',
      thresholdUsd: new Decimal(500),
      windowMode: 'month',
      customStartDate: null,
      customEndDate: null,
      recipientUserId: CREATOR,
      recipientEmail: 'creator@org.test',
      createdByUserId: CREATOR,
      triggeredAt: null,
    });
    const { service, alerts } = buildService({ existingAlerts: [twin('a-1'), twin('a-2')] });
    await service.updateAlert(ORG, 'a-2', CREATOR, {});
    expect(alerts).toHaveLength(2);
  });
});

describe('deleteAlert', () => {
  it('deletes an own-org watch', async () => {
    const { service, alerts } = buildService();
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    const res = await service.deleteAlert(ORG, created.id);
    expect(res.deleted).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  it("404s another org's watch id without deleting it", async () => {
    const { service, alerts } = buildService();
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    await expect(service.deleteAlert(OTHER_ORG, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(alerts).toHaveLength(1);
  });
});

describe('listAlerts', () => {
  it("returns only the caller org's watches, customer label joined", async () => {
    const { service } = buildService({
      customers: [{ id: CUSTOMER, organizationId: ORG, name: 'Acme', externalId: 'acme-1' }],
      existingAlerts: [
        {
          id: 'foreign-1',
          orgId: OTHER_ORG,
          customerId: 'cust-foreign',
          metric: 'cost',
          thresholdUsd: new Decimal(100),
          windowMode: 'month',
          recipientUserId: 'u',
          recipientEmail: 'x@y.test',
        },
      ],
    });
    await service.createAlert(ORG, CREATOR, baseDto());
    const rows = await service.listAlerts(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].customers?.name).toBe('Acme');
  });
});

describe('createAlert — the confirmation email (best-effort)', () => {
  it('a successful create sends the confirmation to the stored recipient', async () => {
    const { service, email } = buildService();
    await service.createAlert(ORG, CREATOR, baseDto());
    expect(email.sendCustomerAlertConfirmationEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendCustomerAlertConfirmationEmail.mock.calls[0][0];
    expect(arg.to).toBe('creator@org.test');
    expect(arg.customerName).toBe('Acme');
    expect(arg.thresholdUsd).toBe(500);
  });

  it('a confirmation failure never fails the create — the watch exists either way', async () => {
    const { service, email, alerts } = buildService();
    email.sendCustomerAlertConfirmationEmail.mockRejectedValue(new Error('resend down'));
    const alert = await service.createAlert(ORG, CREATOR, baseDto());
    expect(alert.id).toBeDefined();
    expect(alerts).toHaveLength(1);
  });

  it('a REJECTED create sends no confirmation', async () => {
    const { service, email } = buildService({
      customers: [{ id: CUSTOMER, organizationId: ORG, name: 'dev@co.example', isInternal: true }],
    });
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeDefined();
    expect(email.sendCustomerAlertConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('the DB unique backstop — P2002 from the race maps to the SAME 409', () => {
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'uq_customer_alerts_functional_tuple' },
    });

  it('create: P2002 becomes a ConflictException with the app-level wording, verbatim', async () => {
    // Capture the app-level 409 wording first, then the P2002-path wording,
    // and assert they are the SAME string — the race loser must be
    // indistinguishable from the ordinary duplicate case.
    const first = buildService();
    await first.service.createAlert(ORG, CREATOR, baseDto());
    const appLevel = await first.service
      .createAlert(ORG, CREATOR, baseDto())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appLevel).toBeInstanceOf(ConflictException);

    const second = buildService();
    second.prisma.customer_alerts.create = () => Promise.reject(p2002());
    const raced = await second.service
      .createAlert(ORG, CREATOR, baseDto())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(raced).toBeInstanceOf(ConflictException);
    expect((raced as ConflictException).message).toBe((appLevel as ConflictException).message);
    expect((raced as ConflictException).message).toMatch(/identical watch already exists/i);
  });

  it('create: a P2002 loss sends no confirmation email', async () => {
    const { service, email, prisma } = buildService();
    prisma.customer_alerts.create = () => Promise.reject(p2002());
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(email.sendCustomerAlertConfirmationEmail).not.toHaveBeenCalled();
  });

  it('create: a non-P2002 database error is rethrown untouched', async () => {
    const { service, prisma } = buildService();
    const dbDown = new Error('connection refused');
    prisma.customer_alerts.create = () => Promise.reject(dbDown);
    await expect(service.createAlert(ORG, CREATOR, baseDto())).rejects.toBe(dbDown);
  });

  it('update: P2002 becomes a ConflictException with the update-path wording, verbatim', async () => {
    // Same capture-and-compare as the create test, against the update path's
    // own message (it differs from the create wording by design).
    const first = buildService();
    await first.service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 500 }));
    const b1 = await first.service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 900 }));
    const appLevel = await first.service
      .updateAlert(ORG, b1.id, CREATOR, { thresholdUsd: 500 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appLevel).toBeInstanceOf(ConflictException);

    const second = buildService();
    const b2 = await second.service.createAlert(ORG, CREATOR, baseDto({ thresholdUsd: 900 }));
    second.prisma.customer_alerts.update = () => Promise.reject(p2002());
    const raced = await second.service
      .updateAlert(ORG, b2.id, CREATOR, { thresholdUsd: 500 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(raced).toBeInstanceOf(ConflictException);
    expect((raced as ConflictException).message).toBe((appLevel as ConflictException).message);
    expect((raced as ConflictException).message).toMatch(/identical to another watch/i);
  });

  it('update: a non-P2002 database error is rethrown untouched', async () => {
    const { service, prisma } = buildService();
    const created = await service.createAlert(ORG, CREATOR, baseDto());
    const dbDown = new Error('connection refused');
    prisma.customer_alerts.update = () => Promise.reject(dbDown);
    await expect(service.updateAlert(ORG, created.id, CREATOR, { thresholdUsd: 900 })).rejects.toBe(
      dbDown,
    );
  });
});
