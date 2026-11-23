/**
 * Cross-tenant READ isolation tests for SubscriptionService.
 *
 * Looking a subscription up by id ALONE, or reading its changelog without joining back
 * to the org, would let any authenticated key read another org's subscription (or its
 * change history) by knowing the id. Both reads are scoped to the CALLER's organizationId — which comes from the authenticated
 * principal (AuthenticatedUser.organizationId via @CurrentUser()), never the URL/body.
 *
 * getSubscriptionById is controller-only, so it takes a required org param (no
 * internal/cron caller needs it unscoped — unlike the invoices side, where
 * getInvoiceByIdInternal stays unscoped for the cron/PDF path).
 *
 * These tests prove:
 *   1. org A is DENIED (NotFoundException, no data) reading org B's subscription by id
 *   2. the same principal IS allowed its own org's subscription
 *   3. the changelog read is org-scoped too: org A gets an empty, leak-free set for an
 *      org B subscription, and the query joins through subscriptions.organizationId
 *
 * Convention matches the rest of the module: in-memory mock Prisma + NestJS Testing
 * module — fast, no DB dependency. The mock models the exact query shapes so a test only
 * passes if the SERVICE actually threads organizationId into the query:
 *   - subscriptions.findFirst({ where: { id, organizationId } })  -> org-scoped read
 *   - subscription_change_logs.findMany({ where: { subscriptionId, subscriptions: { organizationId } } })
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionBillingService } from './subscription-billing.service';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // caller's own org
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // victim org
const SUB_A = '11111111-1111-1111-1111-111111111111'; // belongs to ORG_A
const SUB_B = '22222222-2222-2222-2222-222222222222'; // belongs to ORG_B
const CHANGELOG_B = '33333333-3333-3333-3333-333333333333'; // changelog row on SUB_B

describe('SubscriptionService — cross-tenant read isolation', () => {
  let service: SubscriptionService;
  let prisma: any;

  beforeEach(async () => {
    const subscriptionRows = [
      {
        id: SUB_A,
        organizationId: ORG_A,
        name: 'Sub A',
        // 'active' is required by updateInvoiceDates (it rejects non-active subs);
        // harmless for the read tests, which never look at status.
        status: 'active',
        customers: null,
        pricing_plans: null,
        agents: null,
      },
      {
        id: SUB_B,
        organizationId: ORG_B,
        name: 'Sub B',
        status: 'active',
        customers: null,
        pricing_plans: null,
        agents: null,
      },
    ];
    const changelogRows = [{ id: CHANGELOG_B, subscriptionId: SUB_B, changeType: 'created' }];

    // Resolves the change-log set, honoring the parent-subscription org join when present.
    const matchChangelogs = (where: any) =>
      changelogRows.filter((cl) => {
        if (cl.subscriptionId !== where.subscriptionId) return false;
        const requiredOrg = where.subscriptions?.organizationId;
        if (requiredOrg) {
          const parent = subscriptionRows.find((s) => s.id === cl.subscriptionId);
          if (!parent || parent.organizationId !== requiredOrg) return false;
        }
        return true;
      });

    prisma = {
      subscriptions: {
        // org-scoped tenant read: matches only when BOTH id AND organizationId agree
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            subscriptionRows.find(
              (s) => s.id === where.id && s.organizationId === where.organizationId,
            ) ?? null
          );
        }),
        // unscoped lookup (id only) — present so the mock is realistic; the tenant read
        // must NOT use this path
        findUnique: jest.fn(async ({ where }: any) => {
          return subscriptionRows.find((s) => s.id === where.id) ?? null;
        }),
        // mutation primitive — also exactly what the billing cron calls directly (by id, no org)
        update: jest.fn(async ({ where, data }: any) => {
          const row = subscriptionRows.find((s) => s.id === where.id);
          if (!row) throw new Error('record not found');
          Object.assign(row, data);
          return row;
        }),
      },
      subscription_change_logs: {
        findMany: jest.fn(async ({ where }: any) => matchChangelogs(where)),
        count: jest.fn(async ({ where }: any) => matchChangelogs(where).length),
        create: jest.fn(async ({ data }: any) => data),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubscriptionBillingService, useValue: {} },
      ],
    }).compile();

    service = module.get(SubscriptionService);
  });

  it('DENIES org A reading org B subscription by id (404, no data leaked)', async () => {
    await expect(service.getSubscriptionById(SUB_B, ORG_A)).rejects.toThrow(NotFoundException);
    // proves the org filter is actually applied to the query, not coincidental
    expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SUB_B, organizationId: ORG_A },
      }),
    );
    // and the unscoped path was never used for the tenant read
    expect(prisma.subscriptions.findUnique).not.toHaveBeenCalled();
  });

  it('ALLOWS org A reading its OWN subscription', async () => {
    const sub = await service.getSubscriptionById(SUB_A, ORG_A);
    expect(sub.id).toBe(SUB_A);
    expect(sub.organizationId).toBe(ORG_A);
  });

  it('changelog DENIES cross-tenant: org A gets an empty, leak-free set for an org B subscription', async () => {
    const res = await service.getSubscriptionChangeLogs(SUB_B, {} as any, ORG_A);
    expect(res.results).toHaveLength(0);
    expect(res.totalResults).toBe(0);
    // proves the read joins through the subscription's org, not the bare subscriptionId
    expect(prisma.subscription_change_logs.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subscriptionId: SUB_B,
          subscriptions: { organizationId: ORG_A },
        }),
      }),
    );
  });

  it('changelog ALLOWS org B reading its OWN subscription change history', async () => {
    const res = await service.getSubscriptionChangeLogs(SUB_B, {} as any, ORG_B);
    expect(res.totalResults).toBe(1);
    expect(res.results[0].subscriptionId).toBe(SUB_B);
  });

  // ── fail-closed on a MISSING org ───────────────────────────────
  // A JWT (or org-less session) principal can carry organizationId undefined. Prisma
  // drops an undefined `where` key, so without a guard the filter would collapse and
  // re-open the leak. Prove the service throws BEFORE the query runs.

  it('FAILS CLOSED: getSubscriptionById with an undefined org throws and never queries', async () => {
    await expect(service.getSubscriptionById(SUB_B, undefined as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptions.findUnique).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: getSubscriptionChangeLogs with an undefined org throws and never queries', async () => {
    await expect(
      service.getSubscriptionChangeLogs(SUB_B, {} as any, undefined as any),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.subscription_change_logs.findMany).not.toHaveBeenCalled();
  });

  // ── cross-tenant WRITE isolation ─────────────────────────────────────────────────────────
  // If updateSubscription / updateInvoiceDates looked the target up by id ALONE, a money-role
  // caller in org A could edit — or cancel/pause/resume, since every status transition flows
  // through updateSubscription — org B's subscription by guessing its id. OrgRoleGuard only
  // proves the caller's ROLE in their own org, never that the target is theirs. So the
  // lookup is scoped to the caller's org (findFirst { id, organizationId })
  // and asserts org context first so a missing org can't silently disable the filter.
  const ACTING_USER = '99999999-9999-9999-9999-999999999999';

  describe('cross-tenant WRITE isolation (updateSubscription / updateInvoiceDates)', () => {
    it('DENIES org A updating (or cancelling) org B subscription — 404, nothing written', async () => {
      await expect(
        service.updateSubscription(SUB_B, ORG_A, ACTING_USER, { status: 'canceled' } as any),
      ).rejects.toThrow(NotFoundException);
      // proves the org filter is actually on the gate query
      expect(prisma.subscriptions.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUB_B, organizationId: ORG_A } }),
      );
      // and nothing was mutated or logged
      expect(prisma.subscriptions.update).not.toHaveBeenCalled();
      expect(prisma.subscription_change_logs.create).not.toHaveBeenCalled();
    });

    it('DENIES org A moving org B billing/invoice dates — 404, no write', async () => {
      await expect(
        service.updateInvoiceDates(SUB_B, ORG_A, ACTING_USER, { billingDay: 5 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.subscriptions.update).not.toHaveBeenCalled();
    });

    it('ALLOWS org A cancelling its OWN subscription (status transition writes + logs)', async () => {
      const res = await service.updateSubscription(SUB_A, ORG_A, ACTING_USER, {
        status: 'canceled',
      } as any);
      expect(res.id).toBe(SUB_A);
      expect(res.status).toBe('canceled');
      expect(prisma.subscriptions.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUB_A } }),
      );
      expect(prisma.subscription_change_logs.create).toHaveBeenCalled();
    });

    it('ALLOWS org A updating its OWN billing dates', async () => {
      await service.updateInvoiceDates(SUB_A, ORG_A, ACTING_USER, { billingDay: 9 } as any);
      expect(prisma.subscriptions.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SUB_A } }),
      );
    });

    it('FAILS CLOSED: updateSubscription with an undefined org throws before any query/write', async () => {
      await expect(
        service.updateSubscription(SUB_B, undefined as any, ACTING_USER, {
          status: 'canceled',
        } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscriptions.update).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: updateInvoiceDates with an undefined org throws before any query/write', async () => {
      await expect(
        service.updateInvoiceDates(SUB_B, undefined as any, ACTING_USER, { billingDay: 5 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.subscriptions.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscriptions.update).not.toHaveBeenCalled();
    });
  });
});
