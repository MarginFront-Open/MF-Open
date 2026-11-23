/**
 * Audit-math parity pin for the REST matter audit endpoint.
 *
 * buildMatterAudit and parseAuditWindow are deliberate ports of the dashboard's
 * buildMatterExport (src/features/law/matter-export-utils.ts) and
 * parseWindowFilter (app/actions/_shared/parse-window-filter.ts). The two apps
 * cannot share code (the dashboard actions embed session concerns), so this
 * spec pins the PORT to the SAME truth table the dashboard's own export test
 * uses (app/api/export/matters/__tests__/matter-export.test.ts): identical
 * fixture values, identical KNOWN totals — never self-consistency. If either
 * side's math drifts, its twin test disagrees with this one and the diff names
 * the drift.
 *
 * Null cost contributes 0 to every sum AND surfaces in a
 * needs-attention count; it is never silently zeroed.
 */

import {
  buildMatterAudit,
  parseAuditWindow,
  type MatterAuditEventInput,
} from '../matters-audit.util';

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-08-31T23:59:59.999Z');

const MATTER_A = {
  matterNumber: 'MAT-2214',
  name: 'Hartley v. Grange',
  clientName: 'Hartley Trust',
};
const MATTER_B = {
  matterNumber: 'ZZ-0001',
  name: 'Second Matter',
  clientName: 'B Client',
};

function ev(overrides: Partial<MatterAuditEventInput>): MatterAuditEventInput {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 8),
    usageDate: new Date('2026-08-10T12:00:00.000Z'),
    quantity: 1,
    usageCost: 1,
    matterSource: null,
    agentName: 'intake-agent',
    signalName: 'Contract Review',
    models: ['claude-sonnet-5'],
    matter: null,
    ...overrides,
  };
}

// The dashboard export test's fixture, value for value (matter names differ
// where irrelevant): two matters, one multi-model event, one plain unassigned
// event, one null-cost manually-unassigned event.
const FIXTURE: MatterAuditEventInput[] = [
  ev({ id: 'e1', matter: MATTER_A, matterSource: 'tag', usageCost: 0.000123 }),
  ev({
    id: 'e2',
    matter: MATTER_A,
    matterSource: 'rule',
    usageCost: 1.25,
    models: ['claude-sonnet-5', 'gpt-6', 'claude-sonnet-5'],
  }),
  ev({ id: 'e3', matter: MATTER_B, matterSource: 'manual', usageCost: 2.5 }),
  ev({ id: 'e4', usageCost: 0.5 }),
  // Cost never resolved AND manually unassigned by an operator.
  ev({ id: 'e5', usageCost: null, matterSource: 'manual', quantity: null }),
];

// The KNOWN oracle, shared with the dashboard test: totals are constants, not
// recomputed from the fixture at assert time.
const KNOWN_TOTAL_COST = 0.000123 + 1.25 + 2.5 + 0.5;

describe('buildMatterAudit — the reconciliation partition (dashboard truth table)', () => {
  const data = buildMatterAudit(FIXTURE, WINDOW_START, WINDOW_END);

  it('every event lands in exactly one summary row; counts partition the total', () => {
    expect(data.totalEvents).toBe(5);
    expect(data.summary.reduce((s, r) => s + r.eventCount, 0)).toBe(5);
  });

  it('summary costs + Unassigned sum to the KNOWN org total (nulls contribute 0)', () => {
    const summarySum = data.summary.reduce((s, r) => s + r.cost, 0);
    expect(summarySum).toBeCloseTo(data.totalCost, 10);
    expect(data.totalCost).toBeCloseTo(KNOWN_TOTAL_COST, 10);
  });

  it('the Unassigned row exists, sits LAST, and includes the manually-unassigned event', () => {
    const last = data.summary[data.summary.length - 1];
    expect(last.matterNumber).toBeNull();
    expect(last.eventCount).toBe(2);
    expect(last.cost).toBeCloseTo(0.5, 10);
  });

  it('flags unresolved costs instead of inventing zeros (canon C1)', () => {
    expect(data.eventsMissingCost).toBe(1);
    const unassigned = data.summary[data.summary.length - 1];
    expect(unassigned.eventsMissingCost).toBe(1);
    const nullCostRow = data.rows.find((r) => r.eventId === 'e5');
    expect(nullCostRow?.usageCost).toBeNull();
  });

  it('joins DISTINCT child models; the event stays one row', () => {
    const multi = data.rows.find((r) => r.eventId === 'e2');
    expect(multi?.models).toBe('claude-sonnet-5; gpt-6');
    expect(data.rows).toHaveLength(5);
  });

  it('summary sorts matters by number with per-matter KNOWN subtotals', () => {
    expect(data.summary.map((r) => r.matterNumber)).toEqual(['MAT-2214', 'ZZ-0001', null]);
    expect(data.summary[0].cost).toBeCloseTo(0.000123 + 1.25, 10);
    expect(data.summary[1].cost).toBeCloseTo(2.5, 10);
  });

  it('stamps the window on the result (the reconciliation is per-window)', () => {
    expect(data.periodStart).toBe(WINDOW_START.toISOString());
    expect(data.periodEnd).toBe(WINDOW_END.toISOString());
  });
});

describe('parseAuditWindow — same semantics as the dashboard parseWindowFilter', () => {
  it('bare dates anchor to start/end of day UTC', () => {
    const { windowStart, windowEnd } = parseAuditWindow({
      start: '2026-08-01',
      end: '2026-08-15',
    });
    expect(windowStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });

  it('full ISO timestamps pass verbatim', () => {
    const { windowStart } = parseAuditWindow({ start: '2026-08-01T18:23:41.000Z' });
    expect(windowStart.toISOString()).toBe('2026-08-01T18:23:41.000Z');
  });

  it('the end is capped at now, so a "today" window includes just-fired events', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { windowEnd } = parseAuditWindow({ end: tomorrow.toISOString().slice(0, 10) });
    expect(windowEnd.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('the default window is the last 30 days ending now', () => {
    const before = Date.now();
    const { windowStart, windowEnd } = parseAuditWindow(undefined);
    const after = Date.now();
    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before);
    expect(windowEnd.getTime()).toBeLessThanOrEqual(after);
    const lookbackMs = windowEnd.getTime() - windowStart.getTime();
    expect(lookbackMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 5000);
    expect(lookbackMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 5000);
  });
});
