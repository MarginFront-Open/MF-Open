/**
 * CostControlService.evaluateCapAlerts proofs.
 *
 * The cron-side ladder evaluator. Same Prisma-surface mock discipline as
 * cost-control.service.spec.ts (real service logic runs; only the DB + Resend
 * boundaries are stubbed). What this pins, each red against a broken impl:
 *   1. Crossing a rung sends ONE alert to the org's billingIdentity.email.
 *   2. Deduped per period: a re-run at the same spend re-sends nothing; a fresh
 *      period window re-arms every rung.
 *   3. Each rung is independent — climbing 55% -> 85% fires the 80 rung after
 *      the 50 rung already fired.
 *   4. Both track and enforce caps get the ladder (only the copy differs).
 *   5. Honest-null: a cap whose window has no priced internal spend never alerts
 *      (no fabricated 0%).
 *   6. Recipient chain: billing contact email first; with none set, every
 *      current owner/finance member (deduped, fixture order). Only an EMPTY
 *      chain skips — with no crash, no burned rung, and no ledger row.
 *   7. The alert math IS the /control/spend read-back aggregate (same private path).
 */

import { Decimal } from '@prisma/client/runtime/library';
import { currentPeriodWindow } from '@marginfront/db';
import { CostControlService } from './cost-control.service';

const ORG = 'org-uuid';
const CCC = 'claude-code';

interface CapSeed {
  id: string;
  orgId: string;
  scope: 'org' | 'team' | 'dev';
  scopeValue: string | null;
  providerScope: string;
  amountUsd: number;
  period: 'day' | 'week' | 'month';
  mode: 'track' | 'enforce';
  alertThresholds: number[];
}

interface EventSeed {
  organizationId: string;
  customerExternalId: string;
  usageDate: Date;
  usageCost: Decimal | null;
  agentCode: string;
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

function buildAlertMock(opts: {
  caps: CapSeed[];
  events?: EventSeed[];
  orgs?: OrgSeed[];
  members?: MemberSeed[];
}) {
  const events = opts.events ?? [];
  const members = opts.members ?? [];
  const orgs = opts.orgs ?? [
    { id: ORG, name: 'Acme', billingIdentity: { email: 'owner@acme.test' } },
  ];
  const alertRows: Array<{
    capPolicyId: string;
    rung: number;
    windowStart: Date;
    sentAt: Date;
    recipient: string;
  }> = [];

  const mock: any = {
    cap_policies: {
      findMany: ({ where }: any = {}) =>
        Promise.resolve(
          opts.caps
            .filter((c) => !where?.orgId || c.orgId === where.orgId)
            .map((c) => ({
              ...c,
              amountUsd: new Decimal(c.amountUsd),
              organizations: orgs.find((o) => o.id === c.orgId) ?? null,
            })),
        ),
    },
    signal_events: {
      aggregate: ({ where }: any) => {
        const matched = events.filter((e) => {
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
    cap_alert_events: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          alertRows
            .filter((r) => {
              if (where.capPolicyId && r.capPolicyId !== where.capPolicyId) return false;
              if (
                where.windowStart &&
                r.windowStart.getTime() !== new Date(where.windowStart).getTime()
              )
                return false;
              if (where.rung?.in && !where.rung.in.includes(r.rung)) return false;
              return true;
            })
            .map((r) => ({ ...r })),
        ),
      create: ({ data }: any) => {
        alertRows.push({
          capPolicyId: data.capPolicyId,
          rung: data.rung,
          windowStart: new Date(data.windowStart),
          sentAt: data.sentAt ? new Date(data.sentAt) : new Date(),
          recipient: data.recipient,
        });
        return Promise.resolve(data);
      },
    },
  };

  const email = { sendCapAlertEmail: jest.fn().mockResolvedValue({ id: 'sent' }) };
  const service = new CostControlService(mock as any, email as any);
  return { service, email, alertRows };
}

// Default event time sits just before the fixed 09:00 evaluation instant used by
// most tests, so it lands inside that run's period window.
const IN_WINDOW = new Date('2026-07-22T08:00:00.000Z');

const pricedEvent = (usd: number, over: Partial<EventSeed> = {}): EventSeed => ({
  organizationId: ORG,
  customerExternalId: 'dev@co.example',
  usageDate: IN_WINDOW,
  usageCost: new Decimal(usd),
  agentCode: CCC,
  ...over,
});

const orgCap = (over: Partial<CapSeed> = {}): CapSeed => ({
  id: 'cap-1',
  orgId: ORG,
  scope: 'org',
  scopeValue: null,
  providerScope: 'all',
  amountUsd: 200,
  period: 'week',
  mode: 'track',
  alertThresholds: [50, 80, 100],
  ...over,
});

describe('evaluateCapAlerts — a crossed rung sends one alert to the org billing email', () => {
  it('fires the 50 rung at 55% spend, to billingIdentity.email', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)], // $110 of $200 = 55%
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendCapAlertEmail.mock.calls[0][0];
    expect(arg.to).toBe('owner@acme.test');
    expect(arg.rung).toBe(50);
    expect(arg.spentUsd).toBeCloseTo(110, 6);
    expect(res.alertsSent).toBe(1);
  });
});

describe('evaluateCapAlerts — deduped per period window, idempotent across re-runs', () => {
  it('a second run at the same spend re-sends nothing', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({ caps: [orgCap()], events: [pricedEvent(110)] });

    await service.evaluateCapAlerts(now);
    await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('a fresh period window re-arms the rung', async () => {
    const w1 = new Date('2026-07-08T09:00:00.000Z'); // week of Jul 6
    const w2 = new Date('2026-07-15T09:00:00.000Z'); // next week (Jul 13)
    // events dated inside each run's window so the aggregate sees them
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110, { usageDate: w1 }), pricedEvent(110, { usageDate: w2 })],
    });

    await service.evaluateCapAlerts(w1);
    await service.evaluateCapAlerts(w2);

    expect(currentPeriodWindow('week', w1).start.getTime()).not.toBe(
      currentPeriodWindow('week', w2).start.getTime(),
    );
    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(2);
  });
});

describe('evaluateCapAlerts — rungs are independent as spend climbs', () => {
  it('50 fires first, then 80 on the next run when spend rises', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const events: EventSeed[] = [pricedEvent(110)]; // 55%
    const { service, email } = buildAlertMock({ caps: [orgCap()], events });

    await service.evaluateCapAlerts(now); // fires 50
    events.push(pricedEvent(60)); // now $170 = 85%
    await service.evaluateCapAlerts(now); // fires 80

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(2);
    expect(email.sendCapAlertEmail.mock.calls[0][0].rung).toBe(50);
    expect(email.sendCapAlertEmail.mock.calls[1][0].rung).toBe(80);
  });

  it('a jump straight past 50 into 80 sends ONLY the 80 rung and never back-fills a 50 email', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(180)], // 90% in one shot
    });

    await service.evaluateCapAlerts(now);
    await service.evaluateCapAlerts(now); // re-run must stay quiet

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCapAlertEmail.mock.calls[0][0].rung).toBe(80);
  });
});

describe('evaluateCapAlerts — both modes ladder; only the copy differs', () => {
  it('a track cap and an enforce cap both alert', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [
        orgCap({ id: 'cap-track', mode: 'track' }),
        orgCap({ id: 'cap-enforce', mode: 'enforce' }),
      ],
      events: [pricedEvent(150)], // 75% -> rung 50 for both
    });

    await service.evaluateCapAlerts(now);

    const modes = email.sendCapAlertEmail.mock.calls.map((c: any[]) => c[0].mode).sort();
    expect(modes).toEqual(['enforce', 'track']);
  });
});

describe('evaluateCapAlerts — honest-null and missing recipient never alert or crash', () => {
  it('a cap whose window has no priced internal spend never alerts', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(0 as any, { usageCost: null })], // unpriced only
    });

    const res = await service.evaluateCapAlerts(now);
    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
  });

  it('a customer-billing-only window never alerts (caps are internal spend only)', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(10000, { agentCode: 'customer-support-bot' })],
    });

    await service.evaluateCapAlerts(now);
    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
  });

  it('no billing email and no members at all skips without crashing and without burning the rung', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [{ id: ORG, name: 'Acme', billingIdentity: { legalName: 'Acme' } }], // no email
    });

    const first = await service.evaluateCapAlerts(now);
    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
    expect(first.skipped).toBeGreaterThanOrEqual(1);
    expect(first.errors).toHaveLength(0);
  });
});

describe('evaluateCapAlerts — recipient chain falls back to owner/finance members', () => {
  const now = new Date('2026-07-22T09:00:00.000Z');
  const orgWithoutBillingEmail: OrgSeed = {
    id: ORG,
    name: 'Acme',
    billingIdentity: { legalName: 'Acme' },
  };

  it('no billing email + an owner member: the owner gets the email and the rung is recorded', async () => {
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [{ orgId: ORG, role: 'owner', email: 'owner@acme.test' }],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCapAlertEmail.mock.calls[0][0].to).toBe('owner@acme.test');
    expect(res.alertsSent).toBe(1);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].rung).toBe(50);
  });

  it('a set billing email wins: owner/finance members are never mailed alongside it', async () => {
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [{ id: ORG, name: 'Acme', billingIdentity: { email: 'billing@acme.test' } }],
      members: [
        { orgId: ORG, role: 'owner', email: 'owner@acme.test' },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });

    await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCapAlertEmail.mock.calls[0][0].to).toBe('billing@acme.test');
  });

  it('several fallback recipients: each gets the email (deduped, member-order), ONE ledger row per rung', async () => {
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: 'owner@acme.test' },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
        { orgId: ORG, role: 'finance', email: 'OWNER@acme.test' }, // same person, different case
        { orgId: ORG, role: 'member', email: 'dev@acme.test' }, // wrong role, never mailed
      ],
    });

    const res = await service.evaluateCapAlerts(now);

    const sentTo = email.sendCapAlertEmail.mock.calls.map((c: any[]) => c[0].to);
    expect(sentTo).toEqual(['owner@acme.test', 'cfo@acme.test']);
    expect(res.alertsSent).toBe(1);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient).toBe('owner@acme.test, cfo@acme.test');
  });

  it('the ledger row never exceeds the recipient column even when the first email is huge', async () => {
    // users.email is VarChar(255); "<first> +N more" can pass 255 and P2000
    // the create — which would re-send the same alert every sweep forever.
    const hugeEmail = `${'a'.repeat(243)}@x.test`; // 250 chars
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: hugeEmail },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(2);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient.length).toBeLessThanOrEqual(255);
  });

  it('no billing email and no owner/finance member: skip without recording, no crash', async () => {
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [{ orgId: ORG, role: 'member', email: 'dev@acme.test' }],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(0);
  });

  it('one dead address in the chain never re-burns the others: the rung records off the sends that landed', async () => {
    // Without this, one failing recipient aborts the cap before the ledger
    // write, and the ingest trigger re-mails the healthy recipients every ~5
    // minutes for the rest of the window.
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: 'bounce@acme.test' },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });
    email.sendCapAlertEmail.mockImplementation(({ to }: any) =>
      to === 'bounce@acme.test'
        ? Promise.reject(new Error('mailbox unavailable'))
        : Promise.resolve({ id: 'sent' }),
    );

    const res = await service.evaluateCapAlerts(now);

    expect(res.alertsSent).toBe(1);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].recipient).toBe('cfo@acme.test');
  });

  it('every send failing records nothing, so the next sweep retries (at-least-once)', async () => {
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [{ orgId: ORG, role: 'owner', email: 'bounce@acme.test' }],
    });
    email.sendCapAlertEmail.mockRejectedValue(new Error('mailbox unavailable'));

    const res = await service.evaluateCapAlerts(now);

    expect(res.alertsSent).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(alertRows).toHaveLength(0);
  });

  it('a null send (Resend unconfigured) is NOT a send: skip with no ledger row, no error', async () => {
    // sendEmail returns null when RESEND_API_KEY is unset. Recording that as sent
    // would burn the rung silently on any env without email config, and the
    // customer would never get the warning once config landed.
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
    });
    email.sendCapAlertEmail.mockResolvedValue(null);

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(res.alertsSent).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.errors).toHaveLength(0);
    expect(alertRows).toHaveLength(0);
  });

  it('after email config lands, the SAME rung delivers (nothing was burned by the null run)', async () => {
    const { service, email, alertRows } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
    });
    email.sendCapAlertEmail.mockResolvedValueOnce(null);

    await service.evaluateCapAlerts(now);
    expect(alertRows).toHaveLength(0);

    const res = await service.evaluateCapAlerts(now);

    expect(res.alertsSent).toBe(1);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].rung).toBe(50);
  });

  it('a member without a login email is skipped inside the chain, not mailed a blank address', async () => {
    const { service, email } = buildAlertMock({
      caps: [orgCap()],
      events: [pricedEvent(110)],
      orgs: [orgWithoutBillingEmail],
      members: [
        { orgId: ORG, role: 'owner', email: null },
        { orgId: ORG, role: 'finance', email: 'cfo@acme.test' },
      ],
    });

    await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCapAlertEmail.mock.calls[0][0].to).toBe('cfo@acme.test');
  });
});

describe('evaluateCapAlerts — the alert number is the dev-scoped read-back aggregate', () => {
  it('a dev cap measures that dev only, not the org total', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap({ id: 'cap-dev', scope: 'dev', scopeValue: 'dev@co.example', amountUsd: 100 })],
      events: [
        pricedEvent(60, { customerExternalId: 'dev@co.example' }), // this dev: $60 of $100 = 60%
        pricedEvent(500, { customerExternalId: 'someone-else@co.example' }), // must NOT count
      ],
    });

    await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendCapAlertEmail.mock.calls[0][0];
    expect(arg.rung).toBe(50);
    expect(arg.spentUsd).toBeCloseTo(60, 6);
    expect(arg.scopeValue).toBe('dev@co.example');
  });
});

describe('evaluateCapAlerts — never alerts on a number it cannot honestly compute', () => {
  it('skips a provider-scoped cap: no per-provider decomposition exists, and the total would be a WRONG number', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      // A $100 Claude-only cap while the org's TOTAL internal spend is $110:
      // alerting "110% of your Claude cap" from the all-provider total would be
      // false (some of that $110 is Codex), and provider caps don't device-block
      // either — the dashboard shows these caps with NO spend number for
      // exactly this reason. The email must stay consistent with it.
      caps: [orgCap({ id: 'cap-claude', providerScope: 'anthropic', amountUsd: 100 })],
      events: [pricedEvent(110)],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
    expect(res.alertsSent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.errors).toHaveLength(0);
  });

  it('skips a dev cap with no named dev instead of falling back to the org total', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      // The API rejects dev caps without a scopeValue, but the evaluator reads
      // raw DB rows — a hand-inserted row must not alert org-spend vs a
      // single-dev cap amount.
      caps: [orgCap({ id: 'cap-anon-dev', scope: 'dev', scopeValue: null, amountUsd: 50 })],
      events: [pricedEvent(500)],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(email.sendCapAlertEmail).not.toHaveBeenCalled();
    expect(res.alertsSent).toBe(0);
    expect(res.skipped).toBe(1);
  });
});

describe('evaluateCapAlerts — org scoping + measured duration', () => {
  it('with an orgId, evaluates ONLY that org (the ingest trigger is never a full sweep)', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap({ id: 'cap-a', orgId: ORG }), orgCap({ id: 'cap-b', orgId: 'org-other' })],
      orgs: [
        { id: ORG, name: 'Acme', billingIdentity: { email: 'owner@acme.test' } },
        { id: 'org-other', name: 'Other', billingIdentity: { email: 'owner@other.test' } },
      ],
      events: [pricedEvent(110), pricedEvent(110, { organizationId: 'org-other' })],
    });

    const res = await service.evaluateCapAlerts(now, ORG);

    expect(res.evaluated).toBe(1);
    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCapAlertEmail.mock.calls[0][0].to).toBe('owner@acme.test');
  });

  it('without an orgId, still sweeps every org (the daily backstop path)', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service, email } = buildAlertMock({
      caps: [orgCap({ id: 'cap-a', orgId: ORG }), orgCap({ id: 'cap-b', orgId: 'org-other' })],
      orgs: [
        { id: ORG, name: 'Acme', billingIdentity: { email: 'owner@acme.test' } },
        { id: 'org-other', name: 'Other', billingIdentity: { email: 'owner@other.test' } },
      ],
      events: [pricedEvent(110), pricedEvent(110, { organizationId: 'org-other' })],
    });

    const res = await service.evaluateCapAlerts(now);

    expect(res.evaluated).toBe(2);
    expect(email.sendCapAlertEmail).toHaveBeenCalledTimes(2);
  });

  it('reports how long the evaluation took', async () => {
    const now = new Date('2026-07-22T09:00:00.000Z');
    const { service } = buildAlertMock({ caps: [orgCap()], events: [pricedEvent(110)] });
    const res = await service.evaluateCapAlerts(now);
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
