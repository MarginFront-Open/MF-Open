/**
 * CostControlService.getCoverage.
 *
 * getCoverage is the server half of GET /v1/control/coverage. It delegates the
 * counting to the shared @marginfront/db getSpendCoverage (proven in
 * packages/db/src/lib/spend-coverage.test.ts — ONE coverage-math path)
 * and only shapes the response: { armed, total, asOf: ISO | null, claudeCode, codex }.
 *
 * What this pins, each failure-capable:
 *   1. The blended armed / total keep their EXACT values. The split is additive:
 *      a client that reads only the blended fields gets the blended number, not a
 *      new number under a familiar name.
 *   2. The per-tool objects come through, and Codex reads unknown rather than armed
 *      for a machine running a meter too old to answer for Codex.
 *   3. asOf is the newest in-window event, serialized to ISO — and honest-null
 *      when the window is empty (never a fabricated time).
 *   4. INTERNAL scope only — a customer-billing event (different agentCode) does
 *      not inflate the counts. The negative control shows the un-filtered count
 *      would differ.
 *
 * Only the Prisma signal_events surface is stubbed; the real service + shared
 * helper run.
 */

import { CostControlService } from './cost-control.service';

const ORG = 'org-uuid';
const NOW_ISO = '2026-07-22T12:00:00.000Z';
const IN_WINDOW = new Date('2026-07-20T09:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');

interface Ev {
  organizationId: string;
  customerExternalId: string;
  usageDate: Date;
  agentCode: string;
  signalName?: string;
  controlArmed?: boolean;
  metadata?: Record<string, unknown>;
}

const turnSignal = (agentCode: string) =>
  agentCode === 'codex' ? 'codex-turn' : 'claude-code-turn';

const metadataOf = (e: Ev) => ({
  ...(e.controlArmed === true ? { controlArmed: true } : {}),
  ...(e.metadata ?? {}),
});

function mockPrisma(events: Ev[]) {
  const matches = (e: Ev, where: any): boolean => {
    if (where.organizationId && e.organizationId !== where.organizationId) return false;
    if (where.usageDate?.gte && e.usageDate < where.usageDate.gte) return false;
    if (where.agents?.agentCode?.in && !where.agents.agentCode.in.includes(e.agentCode))
      return false;
    if (typeof where.agents?.agentCode === 'string' && e.agentCode !== where.agents.agentCode)
      return false;
    if (where.metadata?.path?.[0] === 'controlArmed' && where.metadata.equals === true) {
      if (e.controlArmed !== true) return false;
    }
    return true;
  };
  return {
    signal_events: {
      findMany: ({ where, distinct, select }: any) => {
        const hit = events.filter((x) => matches(x, where));
        if (!distinct) {
          return Promise.resolve(
            // Nested under `signals`, mirroring the real relation, and gated on
            // `select` so the stub answers only what it was asked. Volunteering
            // the field would let a missing select slip past this suite.
            hit.map((e) => ({
              customerExternalId: e.customerExternalId,
              ...(select?.signals
                ? { signals: { name: e.signalName ?? turnSignal(e.agentCode) } }
                : {}),
              ...(select?.metadata ? { metadata: metadataOf(e) } : {}),
            })),
          );
        }
        const seen = new Set<string>();
        const rows: Array<{ customerExternalId: string }> = [];
        for (const e of hit) {
          if (!seen.has(e.customerExternalId)) {
            seen.add(e.customerExternalId);
            rows.push({ customerExternalId: e.customerExternalId });
          }
        }
        return Promise.resolve(rows);
      },
      aggregate: ({ where }: any) => {
        const hit = events.filter((x) => matches(x, where));
        const max = hit.reduce<Date | null>(
          (acc, e) => (acc === null || e.usageDate > acc ? e.usageDate : acc),
          null,
        );
        return Promise.resolve({ _max: { usageDate: max } });
      },
    },
  } as any;
}

const emailStub = { sendCapAlertEmail: jest.fn() } as any;
const svc = (mock: any) => new CostControlService(mock, emailStub);

describe('CostControlService.getCoverage', () => {
  // The fixtures are pinned to 2026-07-22 but getCoverage windows off the real
  // clock — without freezing time, every fixture ages out of the 7-day window
  // and this suite goes red.
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date(NOW_ISO) });
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  const events: Ev[] = [
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: IN_WINDOW,
      agentCode: 'claude-code',
      controlArmed: true,
    },
    {
      organizationId: ORG,
      customerExternalId: 'a@co.example',
      usageDate: new Date(NOW_ISO),
      agentCode: 'claude-code',
      controlArmed: true,
    },
    {
      organizationId: ORG,
      customerExternalId: 'b@co.example',
      usageDate: IN_WINDOW,
      agentCode: 'codex',
      controlArmed: true,
    },
    {
      organizationId: ORG,
      customerExternalId: 'c@co.example',
      usageDate: IN_WINDOW,
      agentCode: 'claude-code',
    },
    // out of window — excluded
    {
      organizationId: ORG,
      customerExternalId: 'd@co.example',
      usageDate: OLD,
      agentCode: 'claude-code',
      controlArmed: true,
    },
    // customer-billing usage — must NOT count
    {
      organizationId: ORG,
      customerExternalId: 'big-cust',
      usageDate: new Date(NOW_ISO),
      agentCode: 'support-bot',
      controlArmed: true,
    },
  ];

  it('the blended armed and total fields keep their exact blended values', async () => {
    // The per-tool split is additive: the blended fields still count every
    // internal meter, whatever the tool.
    const res = await svc(mockPrisma(events)).getCoverage(ORG);
    expect(res.total).toBe(3); // a,b,c — d old, big-cust is a customer event
    expect(res.armed).toBe(2); // a,b armed; c unarmed
    expect(res.asOf).toBe(NOW_ISO); // newest internal in-window event, ISO
  });

  it('reports Claude Code and Codex separately, and never blends them', async () => {
    const res = await svc(mockPrisma(events)).getCoverage(ORG);
    // a armed, c unarmed. Claude arming is knowable on every meter version, so
    // Claude never lands in unknown.
    expect(res.claudeCode).toEqual({ armed: 1, notArmed: 1, unknown: 0, total: 2 });
    // b's meter reports one blended stamp. It carries controlArmed:true, which is why
    // the blended number above says 2 — but that stamp says nothing about Codex,
    // so Codex reads b as "we can't tell", never as covered.
    expect(res.codex).toEqual({ armed: 0, notArmed: 0, unknown: 1, total: 1 });
  });

  it('an old meter never inflates the Codex number', async () => {
    const res = await svc(
      mockPrisma([
        {
          organizationId: ORG,
          customerExternalId: 'trusted@co.example',
          usageDate: IN_WINDOW,
          agentCode: 'codex',
          metadata: {
            controlStampVersion: 2,
            codexControlState: 'armed',
            codexControlArmed: true,
          },
        },
        {
          organizationId: ORG,
          customerExternalId: 'oldmeter@co.example',
          usageDate: IN_WINDOW,
          agentCode: 'codex',
          controlArmed: true,
        },
      ]),
    ).getCoverage(ORG);
    expect(res.codex.armed).toBe(1);
    expect(res.codex.unknown).toBe(1);
    // NEGATIVE CONTROL: reading the blended stamp as a Codex answer would say 2.
    expect(res.codex.armed).not.toBe(2);
  });

  it('NEGATIVE CONTROL: without the internal filter the count would be 4, not 3', () => {
    const leaky = new Set(
      events
        .filter(
          (e) =>
            e.organizationId === ORG &&
            e.usageDate >= new Date(new Date(NOW_ISO).getTime() - 7 * 24 * 60 * 60 * 1000),
        )
        .map((e) => e.customerExternalId),
    ).size;
    expect(leaky).toBe(4);
  });

  it('honest-null asOf on an empty window', async () => {
    const res = await svc(mockPrisma([])).getCoverage(ORG);
    expect(res.total).toBe(0);
    expect(res.armed).toBe(0);
    expect(res.asOf).toBeNull();
    expect(res.claudeCode).toEqual({ armed: 0, notArmed: 0, unknown: 0, total: 0 });
    expect(res.codex).toEqual({ armed: 0, notArmed: 0, unknown: 0, total: 0 });
  });
});
