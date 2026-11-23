/**
 * CostControlService.getSpendBreakdownDrill proofs.
 *
 * getSpendBreakdownDrill is the server half of
 * GET /v1/control/spend/breakdown/drill: it takes ONE branchKey from
 * /spend/breakdown and, over the SAME window and the SAME internal-coding
 * filter, splits that branch's spend into one row per (commitSha, teammate).
 *
 * What this pins, each failure-capable:
 *   1. RECONCILIATION (core accuracy) — the drill's totals EQUAL that branch's
 *      row total in getSpendBreakdown over the same window. Same events, same
 *      filter, same math: if they ever diverge, the drill is lying about which
 *      branch it decomposed. The expected total is read from getSpendBreakdown
 *      itself, never hand-typed, so a drift in either path turns this red.
 *   2. HONEST-NULL — a (commit, teammate) bucket with only unpriced events
 *      reports spentUsd null (never a coerced 0) with a real eventCount.
 *   3. NULL COMMIT — an event with no commitSha recorded groups under
 *      commitSha:null ("No commit recorded"), never vanishes.
 *   4. ORG ISOLATION — another org's events on the same branchKey never appear.
 *
 * Only the Prisma signal_events surface is stubbed; the real service and the
 * shared @marginfront/db key helpers run.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { CostControlService } from './cost-control.service';

const ORG = 'org-uuid';
const OTHER_ORG = 'other-org-uuid';
const IN_WINDOW = new Date('2026-07-10T12:00:00.000Z');
const BRANCH = 'acme/platform#main';

interface Ev {
  organizationId: string;
  usageDate: Date;
  usageCost: number | null;
  agentCode: string;
  customerExternalId: string | null;
  metadata: unknown;
}

function mockPrisma(events: Ev[]) {
  const matches = (e: Ev, where: any): boolean => {
    if (where.organizationId && e.organizationId !== where.organizationId) return false;
    if (where.usageDate?.gte && e.usageDate < where.usageDate.gte) return false;
    if (where.usageDate?.lte && e.usageDate > where.usageDate.lte) return false;
    if (where.agents?.agentCode?.in && !where.agents.agentCode.in.includes(e.agentCode))
      return false;
    return true;
  };
  return {
    signal_events: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          events
            .filter((e) => matches(e, where))
            .map((e) => ({
              usageCost: e.usageCost === null ? null : new Decimal(e.usageCost),
              metadata: e.metadata,
              customerExternalId: e.customerExternalId,
            })),
        ),
    },
  } as any;
}

const emailStub = { sendCapAlertEmail: jest.fn() } as any;
const svc = (mock: any) => new CostControlService(mock, emailStub);

const ev = (
  usageCost: number | null,
  metadata: unknown,
  customerExternalId: string | null,
  organizationId = ORG,
): Ev => ({
  organizationId,
  usageDate: IN_WINDOW,
  usageCost,
  agentCode: 'claude-code',
  customerExternalId,
  metadata,
});

beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-07-15T12:00:00.000Z') });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('CostControlService.getSpendBreakdownDrill', () => {
  const events: Ev[] = [
    // acme/platform#main — the branch under drill.
    ev(1.5, { repo: 'acme/platform', branch: 'main', commitSha: 'a1' }, 'alice@acme.example'),
    ev(2.5, { repo: 'acme/platform', branch: 'main', commitSha: 'a1' }, 'bob@acme.example'),
    ev(4.0, { repo: 'acme/platform', branch: 'main', commitSha: 'c3' }, 'alice@acme.example'),
    // Same branch, no commit recorded → commitSha:null bucket.
    ev(0.75, { repo: 'acme/platform', branch: 'main' }, 'alice@acme.example'),
    // A DIFFERENT branch in the same repo — must never bleed into the drill.
    ev(9.0, { repo: 'acme/platform', branch: 'feat/x', commitSha: 'z9' }, 'alice@acme.example'),
    // Customer-billing usage on the same branch — the internal filter drops it.
    {
      organizationId: ORG,
      usageDate: IN_WINDOW,
      usageCost: 100,
      agentCode: 'support-bot',
      customerExternalId: 'alice@acme.example',
      metadata: { repo: 'acme/platform', branch: 'main', commitSha: 'a1' },
    },
  ];

  it('CORE: drill totals reconcile exactly with the branch row in getSpendBreakdown', async () => {
    const service = svc(mockPrisma(events));
    const breakdown = await service.getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'branch',
    } as any);
    const branchRow = breakdown.rows.find((r: any) => r.key === BRANCH);
    expect(branchRow).toBeDefined();

    const drill = await service.getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: BRANCH,
    } as any);

    // The reconciliation guarantee: same events, same window, same math.
    expect(drill.totals.spentUsd).toBeCloseTo(branchRow!.spentUsd as number, 9);
    expect(drill.totals.eventCount).toBe(branchRow!.eventCount);
    expect(drill.totals.unpricedEventCount).toBe(branchRow!.unpricedEventCount);
    // Sanity on the absolute numbers: 1.5 + 2.5 + 4.0 + 0.75 = 8.75 over 4 events.
    expect(drill.totals.spentUsd).toBeCloseTo(8.75, 9);
    expect(drill.totals.eventCount).toBe(4);
  });

  it('groups by (commitSha, teammate) — same commit, two teammates = two rows', async () => {
    const drill = await svc(mockPrisma(events)).getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: BRANCH,
    } as any);

    // Commit a1 split across alice + bob, commit c3 alice, null-commit alice = 4 rows.
    expect(drill.rows).toHaveLength(4);
    const a1Alice = drill.rows.find(
      (r) => r.commitSha === 'a1' && r.member === 'alice@acme.example',
    );
    const a1Bob = drill.rows.find((r) => r.commitSha === 'a1' && r.member === 'bob@acme.example');
    expect(a1Alice).toMatchObject({ spentUsd: 1.5, eventCount: 1, unpricedEventCount: 0 });
    expect(a1Bob).toMatchObject({ spentUsd: 2.5, eventCount: 1, unpricedEventCount: 0 });
    expect(drill.branchKey).toBe(BRANCH);
  });

  it('NULL COMMIT: an event with no commitSha groups under commitSha:null', async () => {
    const drill = await svc(mockPrisma(events)).getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: BRANCH,
    } as any);
    const nullCommit = drill.rows.filter((r) => r.commitSha === null);
    expect(nullCommit).toHaveLength(1);
    expect(nullCommit[0]).toMatchObject({
      commitSha: null,
      member: 'alice@acme.example',
      spentUsd: 0.75,
      eventCount: 1,
    });
  });

  it('HONEST-NULL: a bucket with only unpriced events reports spentUsd null, not 0', async () => {
    const unpricedOnly: Ev[] = [
      ev(null, { repo: 'acme/platform', branch: 'main', commitSha: 'd4' }, 'dana@acme.example'),
    ];
    const drill = await svc(mockPrisma(unpricedOnly)).getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: BRANCH,
    } as any);
    expect(drill.rows).toHaveLength(1);
    expect(drill.rows[0]).toMatchObject({
      commitSha: 'd4',
      member: 'dana@acme.example',
      spentUsd: null,
      eventCount: 1,
      unpricedEventCount: 1,
    });
    expect(drill.totals.spentUsd).toBeNull();
    expect(drill.totals.unpricedEventCount).toBe(1);
  });

  it('ORG ISOLATION: another org’s events on the same branch never appear', async () => {
    const mixed: Ev[] = [
      ev(3.0, { repo: 'acme/platform', branch: 'main', commitSha: 'a1' }, 'alice@acme.example'),
      // Same branchKey, DIFFERENT org — must be invisible to ORG's drill.
      ev(
        50.0,
        { repo: 'acme/platform', branch: 'main', commitSha: 'a1' },
        'mallory@evil.example',
        OTHER_ORG,
      ),
    ];
    const drill = await svc(mockPrisma(mixed)).getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: BRANCH,
    } as any);
    expect(drill.rows).toHaveLength(1);
    expect(drill.rows[0].member).toBe('alice@acme.example');
    expect(drill.totals.spentUsd).toBeCloseTo(3.0, 9);
    expect(drill.rows.some((r) => r.member === 'mallory@evil.example')).toBe(false);
  });

  it('empty branch (no matching events): empty rows, honest-null totals', async () => {
    const drill = await svc(mockPrisma(events)).getSpendBreakdownDrill(ORG, {
      period: 'month',
      branchKey: 'acme/platform#does-not-exist',
    } as any);
    expect(drill.rows).toEqual([]);
    expect(drill.totals.spentUsd).toBeNull();
    expect(drill.totals.eventCount).toBe(0);
    expect(drill.asOf).toBe('2026-07-15T12:00:00.000Z');
    expect(drill.window.start).toBeDefined();
    expect(drill.window.end).toBeDefined();
  });
});
