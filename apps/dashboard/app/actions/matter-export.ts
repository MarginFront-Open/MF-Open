'use server'

/**
 * WHAT THIS FILE DOES: Fetches the per-matter audit export data —
 * every usage event in the window with its matter, attribution source, agent,
 * signal, and child models — and hands it to the pure builder.
 *
 * WHY IT EXISTS: the export is the deliverable of the Law tab: the record a
 * firm hands a client or carrier to bill AI work at actual cost.
 *
 * CONNECTS TO: src/features/law/matter-export-utils.ts (the grouping),
 * app/api/export/matters/route.ts (the download handler),
 * _shared/assert-law-manager.ts (the gate).
 *
 * RECONCILIATION CONTRACT (canon C1/C2): the where-clause is
 * organizationId + usageDate {gte, lte} INCLUSIVE both ends and NOTHING else —
 * exactly the clause getCostMetrics (revenue-metrics.ts) uses with no optional
 * filters — so matters + Unassigned sums to the org's cost headline for the
 * same window. Adding any filter here breaks that equality silently.
 *
 * Role-gated on LAW_MANAGE_ROLES.
 */

import { db } from '@/app/lib/db'
import { parseWindowFilter } from './_shared/parse-window-filter'
import { assertLawManager } from './_shared/assert-law-manager'
// NO `export type { MatterExport }` re-export here: in a 'use server' file the
// use-server transform emits a RUNTIME reference for a type re-export and the
// build dies with a ReferenceError. Consumers import the type from
// '@/features/law/matter-export-utils' directly.
import {
  buildMatterExport,
  type MatterExport,
} from '@/features/law/matter-export-utils'

export type MatterExportResult =
  | { ok: true; data: MatterExport }
  | { ok: false; status: 401 | 403; error: string }

export async function getMatterExport(params?: {
  startDate?: string
  endDate?: string
}): Promise<MatterExportResult> {
  const gate = await assertLawManager()
  if (!gate.ok) {
    // The gate reports "Not authenticated" only for the no-session case;
    // everything else is a real member with the wrong role.
    const status = gate.error === 'Not authenticated' ? 401 : 403
    return { ok: false, status, error: gate.error }
  }
  const orgId = gate.orgId

  const { windowStart, windowEnd } = parseWindowFilter(params)

  const events = await db.signal_events.findMany({
    where: {
      organizationId: orgId,
      usageDate: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      usageDate: true,
      quantity: true,
      usageCost: true,
      matterSource: true,
      agents: { select: { name: true } },
      signals: { select: { name: true } },
      signal_event_services: { select: { model: true } },
      matters: {
        select: { matterNumber: true, name: true, clientName: true },
      },
    },
  })

  const data = buildMatterExport(
    events.map((ev) => ({
      id: ev.id,
      usageDate: ev.usageDate,
      quantity: ev.quantity === null ? null : Number(ev.quantity),
      usageCost: ev.usageCost === null ? null : Number(ev.usageCost),
      matterSource: ev.matterSource,
      agentName: ev.agents.name,
      signalName: ev.signals?.name ?? '(no signal)',
      models: ev.signal_event_services.map((svc) => svc.model),
      matter: ev.matters,
    })),
    windowStart,
    windowEnd
  )

  return { ok: true, data }
}
