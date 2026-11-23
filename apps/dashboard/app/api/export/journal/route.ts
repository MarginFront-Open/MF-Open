import { NextRequest, NextResponse } from 'next/server'
import {
  getJournalExport,
  getJournalAuditDetail,
} from '@/app/actions/journal-export'
import { toSummaryCsv, toJournalCsv, toDetailCsv } from './csv'

/**
 * GET /api/export/journal
 *
 * Streams a CSV of AI cost for the period. Three formats:
 *   - `summary` (default): one row per GL code with the period cost. A
 *     quick cost-by-account view.
 *   - `journal`: balanced double-entry lines (debit the cost accounts,
 *     credit the offset/AP account). A real journal entry an accountant
 *     can post. Both are generic CSV.
 *   - `detail`: the drillable audit trail: one row per
 *     (GL code, signal, usage event), so any journal line traces back to
 *     the exact internal source events and how each signal was classified.
 *     Source is the internal usage chain, not a provider invoice.
 *
 * Query params (all optional — default window is last 30 days):
 *   start  — yyyy-mm-dd
 *   end    — yyyy-mm-dd
 *   format — 'summary' | 'journal' | 'detail'  (default 'summary')
 *
 * The role check (owner, admin or finance) and org scoping happen inside the
 * server actions, so this handler stays thin.
 */
function refused() {
  return NextResponse.json(
    {
      error:
        'The cost journal export needs a signed-in owner, admin or finance role. Sign in with one, or ask an owner or admin to change your role under Settings, then Team.',
    },
    { status: 403 }
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get('start') ?? undefined
  const endDate = searchParams.get('end') ?? undefined
  const rawFormat = searchParams.get('format')
  const format =
    rawFormat === 'journal' || rawFormat === 'detail' ? rawFormat : 'summary'

  // The audit-detail format needs the richer per-event action; the summary and
  // journal formats share the rollup action.
  if (format === 'detail') {
    const detail = await getJournalAuditDetail({ startDate, endDate })
    if (!detail) {
      return refused()
    }
    const csv = toDetailCsv(detail)
    const filename = `ai-cost-detail-${detail.periodStart.slice(0, 10)}_to_${detail.periodEnd.slice(0, 10)}.csv`
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  const data = await getJournalExport({ startDate, endDate })
  if (!data) {
    return refused()
  }

  const csv = format === 'journal' ? toJournalCsv(data) : toSummaryCsv(data)
  const filename = `ai-cost-${format}-${data.periodStart.slice(0, 10)}_to_${data.periodEnd.slice(0, 10)}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
