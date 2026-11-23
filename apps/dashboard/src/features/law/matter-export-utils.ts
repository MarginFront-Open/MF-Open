/**
 * WHAT THIS FILE DOES: Pure builder for the per-matter audit export
 * — takes raw usage-event rows and groups them into the detail
 * grain (one row per event) plus the per-matter summary with an explicit
 * Unassigned row.
 *
 * WHY IT EXISTS: kept out of the server action for the same reason
 * journal-utils.ts exists. The reconciliation partition (matters + Unassigned
 * = org total, so nothing leaks and nothing is double-counted) must be
 * unit-testable in plain Node without a database.
 *
 * CONNECTS TO: app/actions/matter-export.ts (fetches rows, delegates here),
 * app/api/export/matters/csv.ts (formats this module's output),
 * app/api/export/matters/__tests__/ (the partition + CSV tests).
 */

// The client-safe port, NOT @marginfront/db: a src/** value import of that
// package is a page-killer (see the port's comment in canon-format.ts). The
// parity test keeps the port identical to the canonical fold.
import { rollupEventCosts } from '@/lib/canon-format'

export type MatterSource = 'tag' | 'rule' | 'manual'

/** One raw event, already serialized (Decimal -> number) by the action. */
export interface MatterExportEventInput {
  id: string
  usageDate: Date
  quantity: number | null
  usageCost: number | null
  matterSource: MatterSource | null
  agentName: string
  signalName: string
  /** Child signal_event_services model names, duplicates allowed. */
  models: string[]
  matter: { matterNumber: string; name: string; clientName: string } | null
}

export interface MatterExportDetailRow {
  /** Null = Unassigned. */
  matterNumber: string | null
  clientName: string | null
  usageDate: string
  agentName: string
  signalName: string
  /** Distinct child models joined with "; " — the event stays one row and the
   * cost cell stays the parent rollup, so the partition is sum-of-parents. */
  models: string
  quantity: number | null
  /** Null = cost unresolved (needs backfill) — exported blank, counted 0 in
   * sums, flagged in the summary. Never invented (canon C1). */
  usageCost: number | null
  source: MatterSource | null
  eventId: string
}

export interface MatterExportSummaryRow {
  /** Null = the Unassigned row (always present when unassigned events exist). */
  matterNumber: string | null
  matterName: string | null
  clientName: string | null
  cost: number
  eventCount: number
  eventsMissingCost: number
}

export interface MatterExport {
  periodStart: string
  periodEnd: string
  rows: MatterExportDetailRow[]
  summary: MatterExportSummaryRow[]
  /** Null-cost events contribute 0 — the same semantics getCostMetrics uses,
   * so this total reconciles against the org's cost headline for the window. */
  totalCost: number
  totalEvents: number
  eventsMissingCost: number
}

/**
 * Group events into the export shape. The partition property holds by
 * construction: every input event lands in exactly one summary row (its
 * matter, or Unassigned), and totals are summed from the same rows.
 */
export function buildMatterExport(
  events: MatterExportEventInput[],
  windowStart: Date,
  windowEnd: Date
): MatterExport {
  // U+FFFF sorts after any real matter number, pinning Unassigned rows last.
  const sorted = [...events].sort((a, b) => {
    const aKey = a.matter?.matterNumber ?? '￿'
    const bKey = b.matter?.matterNumber ?? '￿'
    if (aKey !== bKey) return aKey < bKey ? -1 : 1
    return a.usageDate.getTime() - b.usageDate.getTime()
  })

  const rows: MatterExportDetailRow[] = sorted.map((ev) => ({
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
  }))

  // Partition only — all cost math is the canonical fold, per bucket and
  // once over everything, so the partition property is checkable by eye:
  // Σ summary[].cost === totalCost because both fold the same rows.
  const eventsByKey = new Map<
    string | null,
    {
      matterName: string | null
      clientName: string | null
      events: MatterExportEventInput[]
    }
  >()
  for (const ev of sorted) {
    const key = ev.matter?.matterNumber ?? null
    let bucket = eventsByKey.get(key)
    if (!bucket) {
      bucket = {
        matterName: ev.matter?.name ?? null,
        clientName: ev.matter?.clientName ?? null,
        events: [],
      }
      eventsByKey.set(key, bucket)
    }
    bucket.events.push(ev)
  }

  // Matters sorted by number; Unassigned pinned last so the reader always
  // finds the "needs attention" bucket at the bottom, never mixed in.
  const summary: MatterExportSummaryRow[] = [...eventsByKey.entries()]
    .map(([matterNumber, bucket]) => ({
      matterNumber,
      matterName: bucket.matterName,
      clientName: bucket.clientName,
      ...rollupEventCosts(bucket.events),
    }))
    .sort((a, b) => {
      if (a.matterNumber === null) return 1
      if (b.matterNumber === null) return -1
      return a.matterNumber < b.matterNumber ? -1 : 1
    })

  const totals = rollupEventCosts(sorted)

  return {
    periodStart: windowStart.toISOString(),
    periodEnd: windowEnd.toISOString(),
    rows,
    summary,
    totalCost: totals.cost,
    totalEvents: totals.eventCount,
    eventsMissingCost: totals.eventsMissingCost,
  }
}
