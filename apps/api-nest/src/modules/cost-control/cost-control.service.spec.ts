/**
 * CostControlService proofs.
 *
 * Three things this pins, each capable of failing against a broken implementation:
 *   1. The ceiling rule at the SERVICE boundary (both directions): a child cap
 *      above the org ceiling is rejected, and an org ceiling can't drop below a
 *      child already under it. (A no-op ceiling check turns the `rejects` red.)
 *   2. The spend read-back aggregation: correct SUM, correct event/unpriced
 *      counts, honest null when nothing is priced (no ?? 0), and correct scoping
 *      to the window + the named dev.
 *   3. Every cap write leaves an audit row (created/updated/deleted) with the
 *      actor and before/after snapshots.
 *
 * Only the Prisma I/O boundary is stubbed; the service's real logic runs.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { CostControlService } from './cost-control.service';
import { CapModeDto, CapPeriodDto, CapScopeDto } from './dto/create-cap-policy.dto';

const ORG = 'org-uuid';
const ACTOR = 'actor-user-uuid';
const NOW = new Date();

interface CapRow {
  id: string;
  orgId: string;
  scope: string;
  scopeValue: string | null;
  providerScope: string;
  amountUsd: Decimal;
  period: string;
  mode: string;
  coolOffHours: number | null;
  createdByUserId: string | null;
}

interface EventRow {
  organizationId: string;
  customerExternalId: string;
  usageDate: Date;
  usageCost: Decimal | null;
  /** agents.agentCode of the event's agent — the internal-vs-customer line. */
  agentCode: string;
}

let idSeq = 0;

/** A stateful mock of just the Prisma surface CostControlService touches. */
function buildMockPrisma(seedEvents: EventRow[] = []) {
  const caps: CapRow[] = [];
  const events: Array<Record<string, unknown>> = [];

  const capMatches = (row: CapRow, where: any): boolean => {
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.id) {
      if (typeof where.id === 'object' && where.id.not && row.id === where.id.not) return false;
      if (typeof where.id === 'string' && row.id !== where.id) return false;
    }
    if (where.scope) {
      if (typeof where.scope === 'object' && where.scope.in && !where.scope.in.includes(row.scope))
        return false;
      if (typeof where.scope === 'string' && row.scope !== where.scope) return false;
    }
    if (where.providerScope && row.providerScope !== where.providerScope) return false;
    if (where.scopeValue !== undefined && row.scopeValue !== where.scopeValue) return false;
    return true;
  };

  // Prisma returns a FRESH object from every query, so a row fetched via findFirst
  // is not the same reference a later update mutates. The mock clones on the way
  // out to preserve that — otherwise a caller's pre-update snapshot would appear to
  // change under it (which is exactly the previousValues audit case).
  const clone = (r: CapRow): CapRow => ({ ...r });

  const mock: any = {
    cap_policies: {
      findMany: ({ where }: any) =>
        Promise.resolve(caps.filter((c) => capMatches(c, where ?? {})).map(clone)),
      findFirst: ({ where }: any) => {
        const hit = caps.find((c) => capMatches(c, where ?? {}));
        return Promise.resolve(hit ? clone(hit) : null);
      },
      create: ({ data }: any) => {
        const row: CapRow = {
          id: `cap-${++idSeq}`,
          orgId: data.orgId,
          scope: data.scope,
          scopeValue: data.scopeValue ?? null,
          providerScope: data.providerScope,
          amountUsd: new Decimal(data.amountUsd),
          period: data.period,
          mode: data.mode,
          coolOffHours: data.coolOffHours ?? null,
          createdByUserId: data.createdByUserId ?? null,
        };
        caps.push(row);
        return Promise.resolve(clone(row));
      },
      update: ({ where, data }: any) => {
        const row = caps.find((c) => c.id === where.id)!;
        if (data.amountUsd !== undefined) row.amountUsd = new Decimal(data.amountUsd);
        if (data.period !== undefined) row.period = data.period;
        if (data.mode !== undefined) row.mode = data.mode;
        if (data.coolOffHours !== undefined) row.coolOffHours = data.coolOffHours;
        return Promise.resolve(clone(row));
      },
      delete: ({ where }: any) => {
        const i = caps.findIndex((c) => c.id === where.id);
        const [row] = caps.splice(i, 1);
        return Promise.resolve(clone(row));
      },
    },
    cap_policy_events: {
      create: ({ data }: any) => {
        events.push(data);
        return Promise.resolve(data);
      },
    },
    signal_events: {
      aggregate: ({ where }: any) => {
        const matched = seedEvents.filter((e) => {
          if (e.organizationId !== where.organizationId) return false;
          if (where.customerExternalId && e.customerExternalId !== where.customerExternalId)
            return false;
          if (where.usageDate?.gte && e.usageDate < where.usageDate.gte) return false;
          if (where.usageDate?.lte && e.usageDate > where.usageDate.lte) return false;
          if (where.agents?.agentCode?.in && !where.agents.agentCode.in.includes(e.agentCode))
            return false;
          return true;
        });
        const priced = matched.filter((e) => e.usageCost !== null);
        const sum = priced.reduce((acc, e) => acc.add(e.usageCost as Decimal), new Decimal(0));
        return Promise.resolve({
          _sum: { usageCost: priced.length === 0 ? null : sum },
          _count: { _all: matched.length, usageCost: priced.length },
        });
      },
    },
    $transaction: async (cb: any) => cb(mock),
  };

  return { mock, caps, events };
}

// These proofs don't exercise the alert path, so a no-op EmailService satisfies
// the constructor without touching Resend.
const emailStub = { sendCapAlertEmail: jest.fn() } as any;
const svc = (mock: any) => new CostControlService(mock as any, emailStub);

// ─── Ceiling rule (child side) ───────────────────────────────────────────────

describe('CostControlService — ceiling rule', () => {
  it('rejects a dev cap above the org ceiling; allows one at/under it', async () => {
    const { mock } = buildMockPrisma();
    const s = svc(mock);
    await s.createCap(ORG, ACTOR, {
      scope: CapScopeDto.ORG,
      providerScope: 'all',
      amountUsd: 200,
      period: CapPeriodDto.WEEK,
      mode: CapModeDto.ENFORCE,
    });

    await expect(
      s.createCap(ORG, ACTOR, {
        scope: CapScopeDto.DEV,
        scopeValue: 'dev@co.example',
        providerScope: 'all',
        amountUsd: 700,
        period: CapPeriodDto.WEEK,
        mode: CapModeDto.ENFORCE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      s.createCap(ORG, ACTOR, {
        scope: CapScopeDto.DEV,
        scopeValue: 'dev@co.example',
        providerScope: 'all',
        amountUsd: 150,
        period: CapPeriodDto.WEEK,
        mode: CapModeDto.ENFORCE,
      }),
    ).resolves.toMatchObject({ scope: 'dev', amountUsd: expect.anything() });
  });

  it('rejects an org ceiling set BELOW an existing same-provider child (reverse direction)', async () => {
    const { mock } = buildMockPrisma();
    const s = svc(mock);
    // No org ceiling yet, so a $150 dev cap is unconstrained and allowed.
    await s.createCap(ORG, ACTOR, {
      scope: CapScopeDto.DEV,
      scopeValue: 'dev@co.example',
      providerScope: 'anthropic',
      amountUsd: 150,
      period: CapPeriodDto.WEEK,
      mode: CapModeDto.TRACK,
    });
    // An org ceiling under that child would strand it above the wall — rejected.
    await expect(
      s.createCap(ORG, ACTOR, {
        scope: CapScopeDto.ORG,
        providerScope: 'anthropic',
        amountUsd: 100,
        period: CapPeriodDto.WEEK,
        mode: CapModeDto.ENFORCE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // A ceiling at/above the child is fine.
    await expect(
      s.createCap(ORG, ACTOR, {
        scope: CapScopeDto.ORG,
        providerScope: 'anthropic',
        amountUsd: 200,
        period: CapPeriodDto.WEEK,
        mode: CapModeDto.ENFORCE,
      }),
    ).resolves.toMatchObject({ scope: 'org' });
  });
});

// ─── Audit log ───────────────────────────────────────────────────────────────

describe('CostControlService — audit trail', () => {
  it('writes created / updated / deleted events with actor + snapshots', async () => {
    const { mock, events } = buildMockPrisma();
    const s = svc(mock);

    const cap = await s.createCap(ORG, ACTOR, {
      scope: CapScopeDto.ORG,
      providerScope: 'all',
      amountUsd: 200,
      period: CapPeriodDto.WEEK,
      mode: CapModeDto.TRACK,
    });
    expect(events.at(-1)).toMatchObject({
      action: 'created',
      actorUserId: ACTOR,
      capPolicyId: cap.id,
      newValues: expect.objectContaining({ amountUsd: 200, mode: 'track' }),
    });

    await s.updateCap(ORG, cap.id, ACTOR, { amountUsd: 250, mode: CapModeDto.ENFORCE });
    expect(events.at(-1)).toMatchObject({
      action: 'updated',
      previousValues: expect.objectContaining({ amountUsd: 200, mode: 'track' }),
      newValues: expect.objectContaining({ amountUsd: 250, mode: 'enforce' }),
    });

    await s.deleteCap(ORG, cap.id, ACTOR);
    expect(events.at(-1)).toMatchObject({
      action: 'deleted',
      capPolicyId: cap.id,
      previousValues: expect.objectContaining({ amountUsd: 250 }),
    });
  });

  it('updateCap on a missing cap throws NotFound', async () => {
    const { mock } = buildMockPrisma();
    await expect(svc(mock).updateCap(ORG, 'nope', ACTOR, { amountUsd: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ─── Spend read-back aggregation ─────────────────────────────────────────────

describe('CostControlService — spend read-back', () => {
  const OLD = new Date('2020-01-01T00:00:00.000Z'); // always before any current-period window
  const CCC = 'claude-code';
  const events: EventRow[] = [
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: NOW,
      usageCost: new Decimal('0.05'),
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: NOW,
      usageCost: new Decimal('0.10'),
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: NOW,
      usageCost: new Decimal('0.20'),
      agentCode: 'codex',
    },
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: NOW,
      usageCost: null,
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: OLD,
      usageCost: new Decimal('99'),
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'b@co.example',
      usageDate: NOW,
      usageCost: new Decimal('0.50'),
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'c@co.example',
      usageDate: NOW,
      usageCost: null,
      agentCode: CCC,
    },
    {
      organizationId: ORG,
      customerExternalId: 'c@co.example',
      usageDate: NOW,
      usageCost: null,
      agentCode: CCC,
    },
    // The org's own BILLING CUSTOMER's production usage, riding the same
    // signal_events table. Internal cost controls must never see it: if this
    // $10,000 leaked into a cap's spend, an enforce cap would hard-stop the
    // whole dev team because the org's customers were busy.
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: NOW,
      usageCost: new Decimal('10000'),
      agentCode: 'customer-support-bot',
    },
    {
      organizationId: ORG,
      customerExternalId: 'end-user-9931',
      usageDate: NOW,
      usageCost: new Decimal('55'),
      agentCode: 'customer-support-bot',
    },
  ];

  it('dev spend sums priced usage, counts unpriced, excludes out-of-window', async () => {
    const { mock } = buildMockPrisma(events);
    const res = await svc(mock).getSpendReadback(ORG, {
      period: CapPeriodDto.MONTH,
      customerExternalId: 'a@co.example',
    });
    expect(res.dev).toMatchObject({
      customerExternalId: 'a@co.example',
      eventCount: 4, // 3 priced + 1 null, in-window; the 2020 event excluded
      unpricedEventCount: 1,
    });
    expect(res.dev!.spentUsd).toBeCloseTo(0.35, 6);
  });

  it('org total sums across all devs in the window', async () => {
    const { mock } = buildMockPrisma(events);
    const res = await svc(mock).getSpendReadback(ORG, { period: CapPeriodDto.MONTH });
    // a@ = 0.35 + b@ = 0.50; c@ contributes 0 (both null). 2020 event excluded.
    expect(res.org.spentUsd).toBeCloseTo(0.85, 6);
    // In-window events: a@ (4) + b@ (1) + c@ (2) = 7; the 2020 a@ event is excluded.
    expect(res.org.eventCount).toBe(7);
    expect(res.org.unpricedEventCount).toBe(3);
    expect(res.dev).toBeNull();
  });

  it('a dev with only unpriced events reports spentUsd = null (no ?? 0 shim)', async () => {
    const { mock } = buildMockPrisma(events);
    const res = await svc(mock).getSpendReadback(ORG, {
      period: CapPeriodDto.MONTH,
      customerExternalId: 'c@co.example',
    });
    expect(res.dev!.spentUsd).toBeNull();
    expect(res.dev!.eventCount).toBe(2);
    expect(res.dev!.unpricedEventCount).toBe(2);
  });

  it('never counts customer-billing usage — caps are INTERNAL coding-agent spend only', async () => {
    const { mock } = buildMockPrisma(events);
    const s = svc(mock);
    // Org total ignores the $10,055 of customer-agent usage seeded above…
    const org = await s.getSpendReadback(ORG, { period: CapPeriodDto.MONTH });
    expect(org.org.spentUsd).toBeCloseTo(0.85, 6);
    // …and a dev's own number ignores THEIR customer-side usage too: a@co.example
    // has a $10,000 customer-support-bot event that must not touch their cap.
    const dev = await s.getSpendReadback(ORG, {
      period: CapPeriodDto.MONTH,
      customerExternalId: 'a@co.example',
    });
    expect(dev.dev!.spentUsd).toBeCloseTo(0.35, 6);
    expect(dev.dev!.eventCount).toBe(4);
  });

  it('exposes the UTC window and an asOf freshness stamp', async () => {
    const { mock } = buildMockPrisma(events);
    const res = await svc(mock).getSpendReadback(ORG, { period: CapPeriodDto.WEEK });
    expect(typeof res.asOf).toBe('string');
    expect(res.window.start).toMatch(/T00:00:00\.000Z$/); // week/day/month starts snap to UTC midnight
    expect(new Date(res.window.end).getTime()).toBeGreaterThanOrEqual(
      new Date(res.window.start).getTime(),
    );
  });
});
