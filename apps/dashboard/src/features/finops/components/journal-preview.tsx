/**
 * The double-entry journal preview. Lines come
 * from buildJournalLines (the canonical builder the export route and Cost
 * Management panel already share) — NEVER re-derived, and the totals footer
 * renders journal.totalAmount verbatim on both sides (sum of debits equals
 * the single credit by construction). The three export links are byte-
 * identical to month-end-close's /api/export/journal URLs; the full audit drill-through stays one click away
 * on /month-end-close.
 */

import Link from 'next/link'
import { format } from 'date-fns'
import { Download } from 'lucide-react'
import { formatCost } from '@/lib/canon-format'
import { buildJournalLines } from '@/features/cost-management/journal-utils'
import {
  TileFrame,
  type TileStateProps,
} from '@/features/dashboard-shell/tiles/tile-frame'
import type { JournalExport } from '@/app/actions/journal-export'
import type { PeriodLockStatus } from '@/app/actions/finance-period-lock'

const EXPORT_LINK_CLASS =
  'flex h-6 items-center gap-1 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2 text-[11px] font-medium text-mf-tx2 hover:text-mf-tx'

const EXPORT_FORMATS = [
  { format: 'summary', label: 'Summary CSV' },
  { format: 'journal', label: 'Journal CSV' },
  { format: 'detail', label: 'Detail / audit CSV' },
] as const

export interface JournalPreviewProps extends TileStateProps {
  journal: JournalExport | null
  lock: PeriodLockStatus | null
  startDate: string
  endDate: string
}

export function JournalPreview({
  journal,
  lock,
  startDate,
  endDate,
  state,
  errorMessage,
}: JournalPreviewProps) {
  const lines = journal ? buildJournalLines(journal) : []
  // The entry posts on the period's last day (it's an accrual for the month).
  const postingDate = journal ? journal.periodEnd.slice(0, 10) : ''
  const effectiveState =
    state === 'ready' && (!journal || journal.rows.length === 0)
      ? 'empty'
      : state

  const exportUrl = (fmt: 'summary' | 'journal' | 'detail') =>
    `/api/export/journal?start=${startDate}&end=${endDate}&format=${fmt}`

  return (
    <section>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
          Journal preview
        </h2>
        {lock?.locked ? (
          <span className='text-[11px] font-medium text-mf-amber'>
            Posted snapshot
            {lock.lockedAt
              ? ` · locked ${format(new Date(lock.lockedAt), 'MMM d, yyyy')}`
              : ''}
          </span>
        ) : (
          <span className='text-[11px] text-mf-tx3'>
            Preview only. Final journal locks when the month closes.
          </span>
        )}
        <div className='ml-auto flex flex-wrap items-center gap-1.5'>
          {/* No `download` attr on purpose: the route sets Content-Disposition:
              attachment, so the click downloads. */}
          {EXPORT_FORMATS.map(({ format: fmt, label }) => (
            <a key={fmt} href={exportUrl(fmt)} className={EXPORT_LINK_CLASS}>
              <Download className='h-3 w-3' />
              {label}
            </a>
          ))}
          <Link
            href='/month-end-close'
            className='text-[11px] font-medium text-mf-tx3 hover:text-mf-accent'
          >
            Full close view →
          </Link>
        </div>
      </div>

      <TileFrame
        state={effectiveState}
        errorMessage={errorMessage}
        emptyMessage='No journal activity for this month'
        className='min-h-[120px] overflow-hidden'
        loadingLines={4}
      >
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Date
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Account
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                Debit
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-right font-semibold'>
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr
                key={`${line.glCode ?? 'unmapped'}-${i}`}
                className='border-t border-mf-bd2'
              >
                <td className='px-[17px] py-[7px] text-[12px] tabular-nums text-mf-tx3'>
                  {postingDate}
                </td>
                <td
                  className={`px-[10px] py-[7px] text-[12px] ${
                    line.glCode === null ? 'text-mf-amber' : 'text-mf-tx2'
                  }`}
                >
                  {line.glCode !== null && (
                    <span className='tabular-nums text-mf-tx3'>
                      {line.glCode} ·{' '}
                    </span>
                  )}
                  {line.account}
                </td>
                <td className='px-[10px] py-[7px] text-right text-[12px] tabular-nums text-mf-tx'>
                  {line.debit === 0 ? '—' : formatCost(line.debit)}
                </td>
                <td className='px-[17px] py-[7px] text-right text-[12px] tabular-nums text-mf-tx'>
                  {line.credit === 0 ? '—' : formatCost(line.credit)}
                </td>
              </tr>
            ))}
          </tbody>
          {journal && (
            <tfoot>
              <tr className='border-t border-mf-bd'>
                <td className='px-[17px] py-[8px] text-[11px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
                  Totals
                </td>
                <td />
                {/* journal.totalAmount verbatim on BOTH sides — never
                    re-summed from the lines (single-source discipline). */}
                <td className='px-[10px] py-[8px] text-right text-[12px] font-semibold tabular-nums text-mf-tx'>
                  {formatCost(journal.totalAmount)}
                </td>
                <td className='px-[17px] py-[8px] text-right text-[12px] font-semibold tabular-nums text-mf-tx'>
                  {formatCost(journal.totalAmount)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </TileFrame>
    </section>
  )
}
