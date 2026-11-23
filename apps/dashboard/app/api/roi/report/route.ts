import { NextRequest, NextResponse } from 'next/server'
import { getRoiReportJson } from '@/app/actions/roi-report'

/**
 * GET /api/roi/report — the ROI report as JSON.
 *
 * What it is for: a finance user opens it in a browser tab, or a slide
 * generator reads it, and gets exactly what the ROI page shows, with a
 * provenance stamp on every number. The stamp is the point: a figure lifted
 * into a board deck carries whether we measured it or the customer typed it,
 * so an estimate cannot be quoted as a finding by dropping a sentence.
 *
 * Query params (all optional — the default window is the last 30 days):
 *   start, end      — yyyy-mm-dd, or the full ISO instants the last response
 *                     published as window.resolvedStart / window.resolvedEnd,
 *                     which is what reproduces that response's numbers
 *   units           — how many finished things, for these dates. Read back
 *                     only when start AND end are both given: a count typed
 *                     for one window is wrong against any other
 *   agents          — which agent rows the comparison counts ('none' for zero)
 *
 * Auth: the action role-gates on MANAGE_MONEY_ROLES and reports 401 vs 403,
 * the /api/export/matters rule. Session-gated, NOT api-key gated: this is not
 * part of the customer's public API surface and this route does not make it
 * one.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const result = await getRoiReportJson({
    startDate: searchParams.get('start') ?? undefined,
    endDate: searchParams.get('end') ?? undefined,
    units: searchParams.get('units'),
    agents: searchParams.get('agents'),
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json(result.data, { status: 200 })
}
