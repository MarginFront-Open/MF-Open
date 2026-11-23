/**
 * PoolAlertEvaluator proofs, sibling of
 * cost-control.alerts.spec.ts with the same Prisma-surface mock discipline
 * (real service logic runs; only the DB + Resend boundaries are stubbed).
 * What this pins, each red against a broken impl:
 *   1. Once per period per stage: a re-run at the same balance re-sends nothing.
 *   2. Highest-stage-only: a 0% -> 96% jump emails pool_95 once and records
 *      50/80/95 (suppressed, not emailed).
 *   3. Top-up un-crossing never re-alerts: the pinned formula counts top-ups
 *      in remainingUnits, and recorded stages stay recorded.
 *   4. creditAlertsPaused: evaluated + logged, nothing sent, nothing recorded.
 *   5. Recipient chain (the rule shared with cap alerts): billing contact first,
 *      owner/finance fallback, EMPTY chain skips without recording.
 *   6. Null send (Resend unconfigured) is NOT a send: nothing recorded, no
 *      throw, and a later configured run delivers.
 *   7. Period rollover re-arms every stage under the new periodStart; the
 *      boundary pass records a just-ended period's final crossing under the
 *      OLD periodStart.
 *   8. pool_exhausted fires on remainingUnits <= 0 (negative allowed).
 *   9. The join-truncate recipient guard and the P2002 swallow.
 *  10. The full sweep runs sweepExpiredGrants isolated; scoped runs never.
 */

import { Prisma } from '@marginfront/db';
import { PoolAlertEvaluator } from './pool-alert-evaluator.service';

const ORG = 'org-uuid';
const SUB = 'sub-uuid';
const PLAN = 'plan-uuid';

const P1_START = new Date('2026-07-01T00:00:00.000Z');
const P1_END = new Date('2026-08-01T00:00:00.000Z');
const P2_START = new Date('2026-08-01T00:00:00.000Z');
const P2_END = new Date('2026-09-01T00:00:00.000Z');
const IN_P1 = new Date('2026-07-20T09:00:00.000Z');
const IN_P2 = new Date('2026-08-02T09:00:00.000Z');

const POOL_TIERS = [
  { lower: 0, upper: 1000, rate: 99 },
  { lower: 1000, upper: null, rate: 0.03 },
];

interface GrantSeed {
  subscriptionId?: string;
  amountUnits: number;
  consumedUnits: number;
  periodStart: Date | null;
  effectiveAt: Date;
  expiresAt: Date | null;
}

interface SubSeed {
  id?: string;
  name?: string;
  planId?: string;
  organizationId?: string;
  currentBillingPeriodStart?: Date;
  currentBillingPeriodEnd?: Date;
  creditAlertsPaused?: boolean;
  customers?: { name: string | null } | null;
}

interface OrgSeed {
  id: string;
  name: string;
  billingIdentity: unknown;
  billing_email?: string | null;
}

interface MemberSeed {
  orgId: string;
  role: string;
  email: string | null;
}

function buildMock(opts: {
  subs?: SubSeed[];
  grants?: GrantSeed[];
  orgs?: OrgSeed[];
  members?: MemberSeed[];
  strategies?: Array<{ planId: string; tiers: unknown }>;
  alertCreate?: (data: any) => void | Promise<void>;
}) {
  const orgs = opts.orgs ?? [
    { id: ORG, name: 'Acme', billingIdentity: { email: 'owner@acme.test' } },
  ];
  const members = opts.members ?? [];
  const strategies = opts.strategies ?? [{ planId: PLAN, tiers: POOL_TIERS }];
  const grants = (opts.grants ?? []).map((g) => ({ subscriptionId: SUB, ...g }));
  // Defaults applied at QUERY time so a test can mutate its seed rows between
  // runs (un-pause, roll the period) and the next evaluation sees it.
  const subSeeds = opts.subs ?? [{}];
  const subRows = () =>
    subSeeds.map((s) => ({
      id: SUB,
      name: 'Starter',
      planId: PLAN,
      organizationId: ORG,
      currentBillingPeriodStart: P1_START,
      currentBillingPeriodEnd: P1_END,
      creditAlertsPaused: false,
      customers: { name: 'Tamarack Commerce' },
      ...s,
    }));

  const alertRows: Array<{
    subscriptionId: string;
    stage: string;
    periodStart: Date;
    sentAt: Date;
    recipient: string;
  }> = [];

  const prisma: any = {
    pricing_strategies: {
      findMany: () => Promise.resolve(strategies.map((s) => ({ ...s }))),
    },
    subscriptions: {
      findMany: ({ where }: any = {}) =>
        Promise.resolve(
          subRows()
            .filter((s) => !where?.id || s.id === where.id)
            .filter((s) => !where?.planId?.in || where.planId.in.includes(s.planId))
            .map((s) => ({
              ...s,
              organizations: orgs.find((o) => o.id === s.organizationId) ?? null,
            })),
        ),
    },
    credit_grants: {
      findMany: ({ where }: any = {}) =>
        Promise.resolve(
          grants
            .filter((g) => g.subscriptionId === where.subscriptionId)
            .filter((g) => {
              if (where.periodStart?.not === null && g.periodStart === null) return false;
              if (where.effectiveAt?.lte && g.effectiveAt > where.effectiveAt.lte) return false;
              if (where.OR) {
                const at = where.OR[1].expiresAt.gt as Date;
                if (!(g.expiresAt === null || g.expiresAt > at)) return false;
              }
              if (where.expiresAt?.lte) {
                if (g.expiresAt === null) return false;
                if (g.expiresAt > where.expiresAt.lte) return false;
                if (where.expiresAt.gt && g.expiresAt <= where.expiresAt.gt) return false;
              }
              return true;
            })
            .map((g) => ({ ...g })),
        ),
    },
    pool_alert_events: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          alertRows
            .filter(
              (r) =>
                r.subscriptionId === where.subscriptionId &&
                r.periodStart.getTime() === new Date(where.periodStart).getTime() &&
                (!where.stage?.in || where.stage.in.includes(r.stage)),
            )
            .map((r) => ({ ...r })),
        ),
      create: async ({ data }: any) => {
        if (opts.alertCreate) await opts.alertCreate(data);
        alertRows.push({
          subscriptionId: data.subscriptionId,
          stage: data.stage,
          periodStart: new Date(data.periodStart),
          sentAt: data.sentAt ? new Date(data.sentAt) : new Date(),
          recipient: data.recipient,
        });
        return data;
      },
    },
    ba_member: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          members
            .filter(
              (m) =>
                m.orgId === where.organizationId &&
                (!where.role?.in || where.role.in.includes(m.role)),
            )
            .map((m) => ({ users: { email: m.email } })),
        ),
    },
  };

  const email = { sendPoolAlertEmail: jest.fn().mockResolvedValue({ id: 'sent' }) };
  const service = new PoolAlertEvaluator(prisma as any, email as any);
  return { service, email, alertRows, prisma, grants };
}

// The standard fixture: a 1,000-unit period grant for P1.
const p1Grant = (consumed: number, over: Partial<GrantSeed> = {}): GrantSeed => ({
  amountUnits: 1000,
  consumedUnits: consumed,
  periodStart: P1_START,
  effectiveAt: P1_START,
  expiresAt: P1_END,
  ...over,
});

describe('PoolAlertEvaluator — a crossed stage sends one alert to the org billing email', () => {
  it('fires pool_50 at 55% used, to billingIdentity.email, with the pinned numbers', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(550)] });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendPoolAlertEmail.mock.calls[0][0];
    expect(arg.to).toBe('owner@acme.test');
    expect(arg.stage).toBe('pool_50');
    expect(arg.poolSizeUnits).toBe(1000);
    expect(arg.remainingUnits).toBe(450);
    expect(arg.percentUsed).toBeCloseTo(55, 6);
    expect(arg.overageRate).toBeCloseTo(0.03, 6);
    expect(arg.periodClosed).toBe(false);
    expect(res.alertsSent).toBe(1);
    expect(alertRows.map((r) => r.stage)).toEqual(['pool_50']);
  });

  it('a re-run at the same balance re-sends nothing (once per period per stage)', async () => {
    const { service, email } = buildMock({ grants: [p1Grant(550)] });

    await service.evaluatePoolAlerts(IN_P1, SUB);
    await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('RATED DRAWS: stage math runs off grant credits unchanged — 100 reports × 4 + 80 notes × 2 = 560 credits fires pool_50', async () => {
    // The evaluator never sees signals or rates: the ledger already drew
    // rated credits into the grant's consumedUnits, and every stage
    // percentage is pure grant arithmetic on top. This pins that a rated
    // pool alerts at the same thresholds with ZERO evaluator changes.
    const ratedConsumed = 100 * 4 + 80 * 2; // 560 credits of a 1,000-credit pool
    const { service, email } = buildMock({ grants: [p1Grant(ratedConsumed)] });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendPoolAlertEmail.mock.calls[0][0];
    expect(arg.stage).toBe('pool_50');
    expect(arg.remainingUnits).toBe(440);
    expect(arg.percentUsed).toBeCloseTo(56, 6);
    expect(res.alertsSent).toBe(1);
  });

  it('stages fire independently as the pool drains: 50 first, then 80 on the next run', async () => {
    const { service, email, grants } = buildMock({ grants: [p1Grant(550)] });

    await service.evaluatePoolAlerts(IN_P1, SUB);
    grants[0].consumedUnits = 850; // now 85%
    await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(2);
    expect(email.sendPoolAlertEmail.mock.calls[0][0].stage).toBe('pool_50');
    expect(email.sendPoolAlertEmail.mock.calls[1][0].stage).toBe('pool_80');
  });
});

describe('PoolAlertEvaluator — highest newly-crossed stage only', () => {
  it('a 0 -> 96% jump emails ONLY pool_95 and records 50/80/95 as suppressed', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(960)] });

    await service.evaluatePoolAlerts(IN_P1, SUB);
    await service.evaluatePoolAlerts(IN_P1, SUB); // re-run must stay quiet

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPoolAlertEmail.mock.calls[0][0].stage).toBe('pool_95');
    expect(alertRows.map((r) => r.stage).sort()).toEqual(['pool_50', 'pool_80', 'pool_95']);
  });

  it('pool_exhausted fires on remainingUnits <= 0, negative allowed, and mentions the stage', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(1200)] }); // -200 left

    await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendPoolAlertEmail.mock.calls[0][0];
    expect(arg.stage).toBe('pool_exhausted');
    expect(arg.remainingUnits).toBe(-200);
    expect(alertRows.map((r) => r.stage).sort()).toEqual([
      'pool_50',
      'pool_80',
      'pool_95',
      'pool_exhausted',
    ]);
  });
});

describe('PoolAlertEvaluator — the pinned formula counts top-ups, and un-crossing never re-alerts', () => {
  it('a top-up pulls the percent back down: recorded stages stay recorded, nothing new fires', async () => {
    // 850/1000 fires pool_80. A 500-unit never-expiring top-up drops the
    // formula to (1000 - 650) / 1000 = 35%: no new stage, no repeat email.
    const grants = [p1Grant(850)];
    const { service, email, alertRows, grants: live } = buildMock({ grants });

    await service.evaluatePoolAlerts(IN_P1, SUB);
    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPoolAlertEmail.mock.calls[0][0].stage).toBe('pool_80');

    live.push({
      subscriptionId: SUB,
      amountUnits: 500,
      consumedUnits: 0,
      periodStart: null,
      effectiveAt: IN_P1,
      expiresAt: null,
    });
    await service.evaluatePoolAlerts(new Date(IN_P1.getTime() + 1000), SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(alertRows.map((r) => r.stage).sort()).toEqual(['pool_50', 'pool_80']);
  });

  it('re-crossing a stage the top-up un-crossed stays silent (the record is the memory)', async () => {
    const grants = [p1Grant(850)];
    const { service, email, grants: live } = buildMock({ grants });

    await service.evaluatePoolAlerts(IN_P1, SUB); // pool_80 fired
    live.push({
      subscriptionId: SUB,
      amountUnits: 500,
      consumedUnits: 0,
      periodStart: null,
      effectiveAt: IN_P1,
      expiresAt: null,
    });
    // Burn back up past 80% of the period grant: 1400 consumed of 1500 total
    // -> remaining 100 -> (1000 - 100) / 1000 = 90%.
    live[0].consumedUnits = 1000;
    live[1].consumedUnits = 400;
    await service.evaluatePoolAlerts(new Date(IN_P1.getTime() + 2000), SUB);

    // pool_80 is already recorded and 90% < 95, so nothing new fires.
    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
  });
});

describe('PoolAlertEvaluator — creditAlertsPaused suppresses sends AND records', () => {
  it('a paused subscription is evaluated but nothing is sent or recorded', async () => {
    const { service, email, alertRows } = buildMock({
      subs: [{ creditAlertsPaused: true }],
      grants: [p1Grant(960)],
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).not.toHaveBeenCalled();
    expect(alertRows).toHaveLength(0);
    expect(res.evaluated).toBe(1);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
  });

  it('un-pausing lets the pending stages fire on the next sweep (nothing was burned)', async () => {
    const subs: SubSeed[] = [{ creditAlertsPaused: true }];
    const { service, email } = buildMock({ subs, grants: [p1Grant(960)] });

    await service.evaluatePoolAlerts(IN_P1, SUB);
    expect(email.sendPoolAlertEmail).not.toHaveBeenCalled();

    subs[0].creditAlertsPaused = false;
    await service.evaluatePoolAlerts(new Date(IN_P1.getTime() + 1000), SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendPoolAlertEmail.mock.calls[0][0].stage).toBe('pool_95');
  });
});

describe('PoolAlertEvaluator — recipient chain (shared with cap alerts)', () => {
  const orgWithoutBillingEmail: OrgSeed = {
    id: ORG,
    name: 'Acme',
    billingIdentity: { legalName: 'Acme' },
  };

  it('falls back to owner/finance members, deduped, and records ONE row per stage', async () => {
    const { service, email, alertRows } = buildMock({
      grants: [p1Grant(550)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: 'owner@acme.test' },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
        { orgId: ORG, role: 'finance', email: 'OWNER@acme.test' }, // same person, different case
        { orgId: ORG, role: 'member', email: 'dev@acme.test' }, // wrong role, never mailed
      ],
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    const sentTo = email.sendPoolAlertEmail.mock.calls.map((c: any[]) => c[0].to);
    expect(sentTo).toEqual(['owner@acme.test', 'cfo@acme.test']);
    expect(res.alertsSent).toBe(1);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient).toBe('owner@acme.test, cfo@acme.test');
  });

  it('an EMPTY chain skips WITHOUT recording, so the stage fires once someone exists', async () => {
    const { service, email, alertRows } = buildMock({
      grants: [p1Grant(550)],
      orgs: [orgWithoutBillingEmail],
      members: [{ orgId: ORG, role: 'member', email: 'dev@acme.test' }],
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).not.toHaveBeenCalled();
    expect(alertRows).toHaveLength(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
  });

  it('one dead address never aborts after others landed; the stage records off the sends that landed', async () => {
    const { service, email, alertRows } = buildMock({
      grants: [p1Grant(550)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: 'bounce@acme.test' },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });
    email.sendPoolAlertEmail.mockImplementation(({ to }: any) =>
      to === 'bounce@acme.test'
        ? Promise.reject(new Error('mailbox unavailable'))
        : Promise.resolve({ id: 'sent' }),
    );

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(res.alertsSent).toBe(1);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient).toBe('cfo@acme.test');
  });

  it('every send failing records nothing, so the next sweep retries (at-least-once)', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(550)] });
    email.sendPoolAlertEmail.mockRejectedValue(new Error('mailbox unavailable'));

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(res.alertsSent).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(alertRows).toHaveLength(0);
  });

  it('the recorded recipient never exceeds the 255-char column even when the first email is huge', async () => {
    const hugeEmail = `${'a'.repeat(243)}@x.test`; // 250 chars
    const { service, email, alertRows } = buildMock({
      grants: [p1Grant(550)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: hugeEmail },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(2);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient.length).toBeLessThanOrEqual(255);
  });
});

describe('PoolAlertEvaluator — a null send (Resend unconfigured) is NOT a send', () => {
  it('all-null skips with no record, no error, no throw', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(550)] });
    email.sendPoolAlertEmail.mockResolvedValue(null);

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(alertRows).toHaveLength(0);
    expect(res.alertsSent).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
  });

  it('once email is configured, the SAME stage delivers (nothing was burned by the null run)', async () => {
    const { service, email, alertRows } = buildMock({ grants: [p1Grant(550)] });
    email.sendPoolAlertEmail.mockResolvedValueOnce(null);

    await service.evaluatePoolAlerts(IN_P1, SUB);
    expect(alertRows).toHaveLength(0);

    await service.evaluatePoolAlerts(new Date(IN_P1.getTime() + 1000), SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(2);
    expect(alertRows.map((r) => r.stage)).toEqual(['pool_50']);
  });
});

describe('PoolAlertEvaluator — period rollover re-arms; the boundary pass records under the OLD period', () => {
  const rolledSub: SubSeed = {
    currentBillingPeriodStart: P2_START,
    currentBillingPeriodEnd: P2_END,
  };

  it('a stage records again under the new periodStart after rollover', async () => {
    // P1 fired pool_50 at 55%; after rollover P2 crosses 55% too.
    const { service, email, alertRows } = buildMock({
      subs: [rolledSub],
      grants: [
        p1Grant(999), // ended period, fully alerted below by boundary — pre-record instead:
        {
          amountUnits: 1000,
          consumedUnits: 550,
          periodStart: P2_START,
          effectiveAt: P2_START,
          expiresAt: P2_END,
        },
      ],
    });
    // Pre-record P1's stages so only the re-arm is under test.
    for (const stage of ['pool_50', 'pool_80', 'pool_95']) {
      alertRows.push({
        subscriptionId: SUB,
        stage,
        periodStart: P1_START,
        sentAt: IN_P1,
        recipient: 'owner@acme.test',
      });
    }

    await service.evaluatePoolAlerts(IN_P2, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendPoolAlertEmail.mock.calls[0][0];
    expect(arg.stage).toBe('pool_50');
    expect(arg.periodClosed).toBe(false);
    const newRows = alertRows.filter((r) => r.periodStart.getTime() === P2_START.getTime());
    expect(newRows.map((r) => r.stage)).toEqual(['pool_50']);
  });

  it('BOUNDARY: a period that ended at 96% after its last sweep still alerts, recorded under the OLD periodStart', async () => {
    // P1 closed at 96% used; the sub has already rolled to P2 (dispatch job #1
    // runs first — exactly the window that could swallow the alert).
    const { service, email, alertRows } = buildMock({
      subs: [rolledSub],
      grants: [
        p1Grant(960),
        {
          amountUnits: 1000,
          consumedUnits: 0,
          periodStart: P2_START,
          effectiveAt: P2_START,
          expiresAt: P2_END,
        },
      ],
    });

    const res = await service.evaluatePoolAlerts(IN_P2, SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendPoolAlertEmail.mock.calls[0][0];
    expect(arg.stage).toBe('pool_95');
    expect(arg.periodClosed).toBe(true);
    // Recorded under P1, never P2 — the fresh period keeps every stage armed.
    expect(alertRows.every((r) => r.periodStart.getTime() === P1_START.getTime())).toBe(true);
    expect(alertRows.map((r) => r.stage).sort()).toEqual(['pool_50', 'pool_80', 'pool_95']);
    expect(res.alertsSent).toBe(1);
  });

  it('BOUNDARY idempotency: stages already recorded under the old period stay quiet', async () => {
    const { service, email } = buildMock({
      subs: [rolledSub],
      grants: [
        p1Grant(960),
        {
          amountUnits: 1000,
          consumedUnits: 0,
          periodStart: P2_START,
          effectiveAt: P2_START,
          expiresAt: P2_END,
        },
      ],
    });

    await service.evaluatePoolAlerts(IN_P2, SUB);
    await service.evaluatePoolAlerts(new Date(IN_P2.getTime() + 1000), SUB);

    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('a period that ended before the lookback window is left alone', async () => {
    const farPast = new Date('2026-10-01T00:00:00.000Z');
    const { service, email } = buildMock({
      subs: [
        {
          currentBillingPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          currentBillingPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
      grants: [p1Grant(960)], // expired 2026-08-01, way outside 7 days
    });

    await service.evaluatePoolAlerts(farPast, SUB);

    // The only send a stale period could produce is the boundary one; none fires.
    const closedCalls = email.sendPoolAlertEmail.mock.calls.filter(
      (c: any[]) => c[0].periodClosed === true,
    );
    expect(closedCalls).toHaveLength(0);
  });
});

describe('PoolAlertEvaluator — no minted grant, degenerate shapes, and error isolation', () => {
  it('an active period with no minted grant reads as a FULL pool, never exhausted', async () => {
    const { service, email } = buildMock({ grants: [] });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).not.toHaveBeenCalled();
    expect(res.errors).toHaveLength(0);
  });

  it('a strategy with no bounded pool tier skips with a logged reason, never a throw', async () => {
    const { service, email } = buildMock({
      grants: [],
      strategies: [{ planId: PLAN, tiers: [{ lower: 0, upper: null, rate: 1 }] }],
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(email.sendPoolAlertEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
  });

  it('a concurrent re-run losing the unique race is swallowed (P2002), not surfaced', async () => {
    const { service } = buildMock({
      grants: [p1Grant(550)],
      alertCreate: () => {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        } as any);
      },
    });

    const res = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(res.errors).toHaveLength(0);
    expect(res.alertsSent).toBe(1);
  });

  it('one broken subscription never kills the run for its siblings', async () => {
    const { service, email, prisma } = buildMock({
      subs: [{ id: 'sub-broken' }, { id: 'sub-ok' }],
      grants: [p1Grant(550, { subscriptionId: 'sub-ok' } as any)],
    });
    const realFindMany = prisma.credit_grants.findMany;
    prisma.credit_grants.findMany = ({ where }: any) =>
      where.subscriptionId === 'sub-broken'
        ? Promise.reject(new Error('db hiccup'))
        : realFindMany({ where });

    const res = await service.evaluatePoolAlerts(IN_P1);

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].subscriptionId).toBe('sub-broken');
    expect(email.sendPoolAlertEmail).toHaveBeenCalledTimes(1);
    expect(res.alertsSent).toBe(1);
  });
});

describe('PoolAlertEvaluator — the expired-grant sweep rides the full sweep only, isolated', () => {
  it('a full sweep reports the sweep result; a subscription-scoped run never sweeps', async () => {
    const { service } = buildMock({ grants: [p1Grant(550)] });

    const full = await service.evaluatePoolAlerts(IN_P1);
    const scoped = await service.evaluatePoolAlerts(IN_P1, SUB);

    expect(full.sweep).toEqual({ swept: 0 });
    expect(scoped.sweep).toBeUndefined();
  });

  it('a sweep failure is isolated: the alert pass still lands and reports', async () => {
    const { service, prisma } = buildMock({ grants: [p1Grant(550)] });
    const realFindMany = prisma.credit_grants.findMany;
    prisma.credit_grants.findMany = (args: any) => {
      // sweepExpiredGrants is the only caller filtering on ledger-entry absence.
      if (args?.where?.credit_ledger_entries) return Promise.reject(new Error('sweep query died'));
      return realFindMany(args);
    };

    const res = await service.evaluatePoolAlerts(IN_P1);

    expect(res.alertsSent).toBe(1);
    expect(res.sweep).toEqual({ error: 'sweep query died' });
    expect(res.errors).toHaveLength(0);
  });
});
