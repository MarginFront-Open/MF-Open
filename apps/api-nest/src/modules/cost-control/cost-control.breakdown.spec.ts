/**
 * CostControlService.getSpendBreakdown proofs.
 *
 * getSpendBreakdown is the server half of GET /v1/control/spend/breakdown: the
 * org's INTERNAL coding-agent spend for the current period, rolled up per repo
 * or per branch from the git coordinates the code-cost-clarity connector stamps
 * into signal_events.metadata. No pull-request number is recorded anywhere in the
 * pipeline, so branch is the honest grain and the copy never says "PR".
 *
 * What this pins, each failure-capable:
 *   1. ROLLUP MATH — per-bucket spentUsd sums and eventCounts, rows sorted by
 *      spend descending, branch buckets keyed "<repo>#<branch>" so 'main' in
 *      two repos stays two rows.
 *   2. NO-METADATA BUCKET — events with no repo/branch recorded (absent keys,
 *      explicit JSON nulls, non-strings) land in the EXPLICIT noMetadata
 *      bucket and count in totals; they never vanish. coveragePercent reports
 *      the tagged share honestly.
 *   3. EMPTY STATE — honest null, never fake zero: no events → spentUsd null
 *      and coveragePercent null (0 would claim "measured, nothing tagged";
 *      null says "nothing to measure").
 *   4. INTERNAL SCOPE — a customer-billing event (different agentCode) never
 *      counts. The NEGATIVE CONTROL replays the unfiltered sum and shows it
 *      differs — the exact leak cccInternalEventFilter closes.
 *
 * Only the Prisma signal_events surface is stubbed; the real service and the
 * shared @marginfront/db key helpers run.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { CostControlService } from './cost-control.service';

const ORG = 'org-uuid';
const IN_WINDOW = new Date('2026-07-10T12:00:00.000Z');

interface Ev {
  organizationId: string;
  usageDate: Date;
  usageCost: number | null;
  agentCode: string;
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
            })),
        ),
    },
  } as any;
}

const emailStub = { sendCapAlertEmail: jest.fn() } as any;
const svc = (mock: any) => new CostControlService(mock, emailStub);

const internal = (usageCost: number | null, metadata: unknown): Ev => ({
  organizationId: ORG,
  usageDate: IN_WINDOW,
  usageCost,
  agentCode: 'claude-code',
  metadata,
});

// Jest fake timers pin "now" inside the window the fixture events sit in.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-07-15T12:00:00.000Z') });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('CostControlService.getSpendBreakdown', () => {
  const events: Ev[] = [
    internal(1.5, { repo: 'acme/platform', branch: 'main', commitSha: 'a1' }),
    internal(2.5, { repo: 'acme/platform', branch: 'feat/x', commitSha: 'b2' }),
    internal(5.0, { repo: 'acme/agents', branch: 'main', commitSha: 'c3' }),
    // No git metadata recorded → the explicit noMetadata bucket.
    internal(0.25, {}),
    // Explicit JSON nulls (a partial git tuple from the meter) + unpriced → noMetadata, unpriced.
    internal(null, { repo: null, branch: null, commitSha: null }),
    // Non-string garbage never stringifies into a fake bucket key.
    internal(0.75, { repo: 123, branch: ['main'] }),
    // Customer-billing usage in the same table — must NEVER count.
    {
      organizationId: ORG,
      usageDate: IN_WINDOW,
      usageCost: 100,
      agentCode: 'support-bot',
      metadata: { repo: 'acme/platform', branch: 'main' },
    },
  ];

  it('rolls up per-repo spend with honest math and desc ordering', async () => {
    const result = await svc(mockPrisma(events)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);

    expect(result.dimension).toBe('repo');
    expect(result.rows).toHaveLength(2);
    // Sorted by spend descending.
    expect(result.rows[0]).toMatchObject({
      key: 'acme/agents',
      spentUsd: 5.0,
      eventCount: 1,
      unpricedEventCount: 0,
    });
    expect(result.rows[1]).toMatchObject({ key: 'acme/platform', eventCount: 2 });
    expect(result.rows[1].spentUsd).toBeCloseTo(4.0, 9);
    // Totals span keyed + noMetadata buckets (internal events only).
    expect(result.totals.eventCount).toBe(6);
    expect(result.totals.unpricedEventCount).toBe(1);
    expect(result.totals.spentUsd).toBeCloseTo(10.0, 9);
  });

  it('NEGATIVE CONTROL: the unfiltered sum would include customer billing — the internal filter is load-bearing', async () => {
    const unfilteredTotal = events
      .filter((e) => e.usageCost !== null)
      .reduce((sum, e) => sum + (e.usageCost as number), 0);
    expect(unfilteredTotal).toBeCloseTo(110.0, 9); // includes the $100 billing event
    const result = await svc(mockPrisma(events)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);
    expect(result.totals.spentUsd).toBeCloseTo(10.0, 9); // the filter kept it out
  });

  it('branch rows use composite keys so same-named branches in two repos stay apart', async () => {
    const result = await svc(mockPrisma(events)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'branch',
    } as any);
    const keys = result.rows.map((r: any) => r.key);
    expect(keys).toContain('acme/platform#main');
    expect(keys).toContain('acme/agents#main');
    expect(keys).toContain('acme/platform#feat/x');
    expect(result.rows).toHaveLength(3);
  });

  it('events with no git metadata land in the EXPLICIT noMetadata bucket, never vanish', async () => {
    const result = await svc(mockPrisma(events)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);
    // {} + explicit-null tuple + non-string garbage = 3 events, one unpriced.
    expect(result.noMetadata.eventCount).toBe(3);
    expect(result.noMetadata.unpricedEventCount).toBe(1);
    expect(result.noMetadata.spentUsd).toBeCloseTo(1.0, 9);
    // Coverage: 3 of 6 internal events carry a repo → 50%, stated honestly.
    expect(result.coveragePercent).toBeCloseTo(50, 9);
  });

  it('empty window: honest nulls, never fake zeros', async () => {
    const result = await svc(mockPrisma([])).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);
    expect(result.rows).toEqual([]);
    expect(result.totals.eventCount).toBe(0);
    expect(result.totals.spentUsd).toBeNull(); // no priced usage → null, not 0
    expect(result.noMetadata.eventCount).toBe(0);
    expect(result.noMetadata.spentUsd).toBeNull();
    expect(result.coveragePercent).toBeNull(); // nothing to measure → null, not 0
    expect(result.asOf).toBe('2026-07-15T12:00:00.000Z');
    expect(result.window.start).toBeDefined();
    expect(result.window.end).toBeDefined();
  });

  it('a bucket with only unpriced events reports spentUsd null with a real eventCount', async () => {
    const onlyUnpriced = [internal(null, { repo: 'acme/dark', branch: 'main' })];
    const result = await svc(mockPrisma(onlyUnpriced)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      key: 'acme/dark',
      spentUsd: null,
      eventCount: 1,
      unpricedEventCount: 1,
    });
    expect(result.totals.spentUsd).toBeNull();
  });

  it('unpriced-only rows sort after priced rows', async () => {
    const mixed = [
      internal(null, { repo: 'acme/unpriced', branch: 'main' }),
      internal(0.01, { repo: 'acme/tiny', branch: 'main' }),
    ];
    const result = await svc(mockPrisma(mixed)).getSpendBreakdown(ORG, {
      period: 'month',
      dimension: 'repo',
    } as any);
    expect(result.rows.map((r: any) => r.key)).toEqual(['acme/tiny', 'acme/unpriced']);
  });
});
