/**
 * WHAT THIS FILE DOES: Pure builders for the REST matter audit endpoint
 * — the window parser and the event-grouping that turns raw usage
 * rows into the per-matter summary (one row per matter + Unassigned + TOTAL)
 * and the detail rows.
 *
 * WHY IT EXISTS: GET /v1/matters/audit must reconcile EXACTLY to the Law
 * tab's CSV export for the same window. The dashboard actions embed session
 * concerns and can't be imported here, so this file is a deliberate
 * line-for-line port of the dashboard's two pure pieces, kept unit-testable in
 * plain Node without a database for the same reason the originals are.
 *
 * CONNECTS TO: apps/dashboard/src/features/law/matter-export-utils.ts and
 * apps/dashboard/app/actions/_shared/parse-window-filter.ts (the twins — keep
 * each in lockstep with its original or REST totals drift from the CSV a
 * user hands an auditor), matters.service.ts (fetches rows, delegates here),
 * __tests__/matters-audit-parity.spec.ts (pins both ports to the same truth
 * table the dashboard's own export test uses).
 */

import { rollupEventCosts } from '@marginfront/db';

export type MatterSource = 'tag' | 'rule' | 'manual';

/** One raw event, already serialized (Decimal -> number) by the service. */
export interface MatterAuditEventInput {
  id: string;
  usageDate: Date;
  quantity: number | null;
  usageCost: number | null;
  matterSource: MatterSource | null;
  agentName: string;
  signalName: string;
  /** Child signal_event_services model names, duplicates allowed. */
  models: string[];
  matter: { matterNumber: string; name: string; clientName: string } | null;
}

export interface MatterAuditDetailRow {
  /** Null = Unassigned. */
  matterNumber: string | null;
  clientName: string | null;
  usageDate: string;
  agentName: string;
  signalName: string;
  /** Distinct child models joined with "; " — the event stays one row and the
   * cost cell stays the parent rollup, so the partition is sum-of-parents. */
  models: string;
  /** Null = cost unresolved (needs backfill) — counted 0 in sums, flagged in
   * the summary. Never invented. */
  usageCost: number | null;
  quantity: number | null;
  source: MatterSource | null;
  eventId: string;
}

export interface MatterAuditSummaryRow {
  /** Null = the Unassigned row (always present when unassigned events exist). */
  matterNumber: string | null;
  matterName: string | null;
  clientName: string | null;
  cost: number;
  eventCount: number;
  eventsMissingCost: number;
}

export interface MatterAudit {
  periodStart: string;
  periodEnd: string;
  rows: MatterAuditDetailRow[];
  summary: MatterAuditSummaryRow[];
  /** Null-cost events contribute 0 — the same semantics getCostMetrics uses,
   * so this total reconciles against the org's cost headline for the window. */
  totalCost: number;
  totalEvents: number;
  eventsMissingCost: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Port of the dashboard's parseWindowFilter, same semantics exactly:
 * bare "YYYY-MM-DD" dates anchor to start/end of day UTC, full ISO strings
 * pass verbatim, the end is capped at `now` so just-fired events land inside
 * a "today" window, and the default window is the last 30 days. Reconciliation
 * with the dashboard CSV depends on the two parsers never disagreeing.
 */
export function parseAuditWindow(filter?: { start?: string; end?: string }): {
  windowStart: Date;
  windowEnd: Date;
} {
  const now = new Date();

  const windowStart = filter?.start
    ? new Date(filter.start.includes('T') ? filter.start : filter.start + 'T00:00:00.000Z')
    : new Date(now.getTime() - 30 * MS_PER_DAY);

  const parsedEnd = filter?.end
    ? new Date(filter.end.includes('T') ? filter.end : filter.end + 'T23:59:59.999Z')
    : now;

  const windowEnd = parsedEnd.getTime() > now.getTime() ? now : parsedEnd;

  return { windowStart, windowEnd };
}

/**
 * Group events into the audit shape. The partition property holds by
 * construction: every input event lands in exactly one summary row (its
 * matter, or Unassigned), and totals are summed from the same rows.
 */
export function buildMatterAudit(
  events: MatterAuditEventInput[],
  windowStart: Date,
  windowEnd: Date,
): MatterAudit {
  // U+FFFF sorts after any real matter number, pinning Unassigned rows last.
  const sorted = [...events].sort((a, b) => {
    const aKey = a.matter?.matterNumber ?? '￿';
    const bKey = b.matter?.matterNumber ?? '￿';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return a.usageDate.getTime() - b.usageDate.getTime();
  });

  const rows: MatterAuditDetailRow[] = sorted.map((ev) => ({
    matterNumber: ev.matter?.matterNumber ?? null,
    clientName: ev.matter?.clientName ?? null,
    usageDate: ev.usageDate.toISOString(),
    agentName: ev.agentName,
    signalName: ev.signalName,
    models: [...new Set(ev.models)].join('; '),
    quantity: ev.quantity,
    usageCost: ev.usageCost,
    source: ev.matterSource,
    eventId: ev.id,
  }));

  // Partition only: all cost math is rollupEventCosts, per bucket and
  // once over everything, so the partition property is checkable by eye:
  // Σ summary[].cost === totalCost because both fold the same rows.
  const eventsByKey = new Map<
    string | null,
    { matterName: string | null; clientName: string | null; events: MatterAuditEventInput[] }
  >();
  for (const ev of sorted) {
    const key = ev.matter?.matterNumber ?? null;
    let bucket = eventsByKey.get(key);
    if (!bucket) {
      bucket = {
        matterName: ev.matter?.name ?? null,
        clientName: ev.matter?.clientName ?? null,
        events: [],
      };
      eventsByKey.set(key, bucket);
    }
    bucket.events.push(ev);
  }

  // Matters sorted by number; Unassigned pinned last so the reader always
  // finds the "needs attention" bucket at the bottom, never mixed in.
  const summary: MatterAuditSummaryRow[] = [...eventsByKey.entries()]
    .map(([matterNumber, bucket]) => ({
      matterNumber,
      matterName: bucket.matterName,
      clientName: bucket.clientName,
      ...rollupEventCosts(bucket.events),
    }))
    .sort((a, b) => {
      if (a.matterNumber === null) return 1;
      if (b.matterNumber === null) return -1;
      return a.matterNumber < b.matterNumber ? -1 : 1;
    });

  const totals = rollupEventCosts(sorted);

  return {
    periodStart: windowStart.toISOString(),
    periodEnd: windowEnd.toISOString(),
    rows,
    summary,
    totalCost: totals.cost,
    totalEvents: totals.eventCount,
    eventsMissingCost: totals.eventsMissingCost,
  };
}
