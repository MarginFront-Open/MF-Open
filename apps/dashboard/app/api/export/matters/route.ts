import { NextRequest, NextResponse } from 'next/server'
import { getMatterExport } from '@/app/actions/matter-export'
import { toMatterSummaryCsv, toMatterDetailCsv } from './csv'

/**
 * GET /api/export/matters — the per-matter AI-cost audit export.
 *
 * Two formats:
 *   - `summary` (default): one row per matter + Unassigned + TOTAL. The
 *     reconciliation view — matters plus Unassigned equals the org's AI cost
 *     for the window.
 *   - `detail`: one row per usage event with its attribution source — the
 *     record a firm hands a client or carrier to bill AI work at actual cost
 *     (ABA Op. 512 / FL 24-1 / OR 2025-205).
 *
 * Query params (all optional — default window is last 30 days):
 *   start  — yyyy-mm-dd
 *   end    — yyyy-mm-dd
 *   format — 'summary' | 'detail'  (default 'summary')
 *
 * Auth: the action role-gates on LAW_MANAGE_ROLES and reports 401 vs 403.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get('start') ?? undefined
  const endDate = searchParams.get('end') ?? undefined
  const format = searchParams.get('format') === 'detail' ? 'detail' : 'summary'

  const result = await getMatterExport({ startDate, endDate })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  const csv =
    format === 'detail'
      ? toMatterDetailCsv(result.data)
      : toMatterSummaryCsv(result.data)
  const filename = `matter-cost-${format}-${result.data.periodStart.slice(0, 10)}_to_${result.data.periodEnd.slice(0, 10)}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
