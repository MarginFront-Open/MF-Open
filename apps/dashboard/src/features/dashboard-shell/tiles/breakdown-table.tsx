import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatCost, formatPct } from '@/lib/canon-format'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { revenueColumnLabel } from '@/lib/revenue-basis'
import type { ResolvedBreakdown } from '../types'
import { TileFrame, type TileStateProps } from './tile-frame'
import { TileHeader } from './tile-header'

export interface BreakdownTableProps extends TileStateProps {
  title: string
  breakdown: ResolvedBreakdown
  // Window totals — rendered VERBATIM, never re-summed from `breakdown.rows`
  // client-side. The resolver already guarantees
  // totals.cost === Σ rows[].cost + (other?.cost ?? 0) (single-source
  // discipline holds even though the invariant makes re-summing safe).
  totals: { cost: number; eventCount: number }
  resolveLabel?: (key: string | null) => string
  onPageChange: (page: number) => void
}

const defaultResolveLabel = (key: string | null) => key ?? 'Unassigned'

export function BreakdownTable({
  title,
  breakdown,
  totals,
  resolveLabel = defaultResolveLabel,
  onPageChange,
  state,
  errorMessage,
}: BreakdownTableProps) {
  const totalPages = Math.max(
    1,
    Math.ceil(breakdown.totalRowCount / breakdown.pageSize)
  )
  const currentPage = breakdown.page

  // Revenue/Margin columns appear ONLY when the dimension is revenue-definable
  // (agent/signal → Earned, customer/plan → Billed). Model/environment/day and
  // revenue-less scopes carry revenueBasis: null → cost-only table.
  const revenueBasis = breakdown.revenueBasis
  const showRevenue = revenueBasis !== null
  const revenueHeader = showRevenue ? revenueColumnLabel(revenueBasis) : ''

  // Row count + pagination are ready-state facts (a loading tile has no
  // honest row count), but the title itself rides the frame's header so it
  // survives all four states.
  const showTableMeta = (state ?? 'ready') === 'ready'

  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className='h-full min-h-[280px] overflow-hidden'
      loadingLines={5}
      header={
        <div className='flex items-center gap-3 px-[17px] pb-3 pt-[14px]'>
          <TileHeader label={title} />
          {showTableMeta && (
            <span className='text-[11.5px] text-mf-tx3'>
              {breakdown.totalRowCount.toLocaleString()}{' '}
              {breakdown.totalRowCount === 1 ? 'row' : 'rows'}
            </span>
          )}
          {showTableMeta && totalPages > 1 && (
            <div className='ml-auto flex items-center gap-2'>
              <button
                type='button'
                aria-label='Previous page'
                disabled={currentPage <= 1}
                onClick={() => onPageChange(currentPage - 1)}
                className='rounded-mf-inner border border-mf-bd p-1 text-mf-tx2 disabled:opacity-40'
              >
                <ChevronLeft className='h-3.5 w-3.5' />
              </button>
              <span className='text-[11px] text-mf-tx3'>
                Page {currentPage} of {totalPages}
              </span>
              <button
                type='button'
                aria-label='Next page'
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange(currentPage + 1)}
                className='rounded-mf-inner border border-mf-bd p-1 text-mf-tx2 disabled:opacity-40'
              >
                <ChevronRight className='h-3.5 w-3.5' />
              </button>
            </div>
          )}
        </div>
      }
    >
      <table className='w-full border-collapse'>
        <thead>
          <tr className='px-[17px] text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
            <th className='px-[17px] pb-2 text-left font-semibold'>Account</th>
            <th className='px-[10px] pb-2 text-right font-semibold'>
              Usage events
            </th>
            <th className='px-[17px] pb-2 text-right font-semibold'>Cost</th>
            {showRevenue && (
              <th className='px-[10px] pb-2 text-right font-semibold'>
                <span className='inline-flex items-center gap-1'>
                  {revenueHeader}
                  <InfoTooltip
                    title={tooltipDefinitions.breakdownRevenueColumn.title}
                    description={
                      tooltipDefinitions.breakdownRevenueColumn.description
                    }
                    details={tooltipDefinitions.breakdownRevenueColumn.details}
                  />
                </span>
              </th>
            )}
            {showRevenue && (
              <th className='px-[17px] pb-2 text-right font-semibold'>
                Margin
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {breakdown.rows.map((row) => (
            <tr
              key={row.key ?? '__unassigned__'}
              className='border-t border-mf-bd2'
            >
              <td className='px-[17px] py-[11px] text-[12.5px] font-medium text-mf-tx'>
                {resolveLabel(row.key)}
              </td>
              <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                {row.eventCount.toLocaleString()}
              </td>
              <td className='px-[17px] py-[11px] text-right text-[12px] font-medium text-mf-tx'>
                {formatCost(row.cost)}
              </td>
              {showRevenue && (
                <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {row.revenue === undefined ? '—' : formatCost(row.revenue)}
                </td>
              )}
              {showRevenue && (
                <td className='px-[17px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {formatPct(row.marginPercent ?? null)}
                </td>
              )}
            </tr>
          ))}
          {breakdown.other && (
            <tr className='border-t border-mf-bd2'>
              <td className='px-[17px] py-[11px] text-[12.5px] font-medium text-mf-tx2'>
                Other
              </td>
              <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                {breakdown.other.eventCount.toLocaleString()}
              </td>
              <td className='px-[17px] py-[11px] text-right text-[12px] font-medium text-mf-tx'>
                {formatCost(breakdown.other.cost)}
              </td>
              {showRevenue && (
                <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {breakdown.other.revenue === undefined
                    ? '—'
                    : formatCost(breakdown.other.revenue)}
                </td>
              )}
              {showRevenue && (
                <td className='px-[17px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {formatPct(breakdown.other.marginPercent ?? null)}
                </td>
              )}
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className='border-t border-mf-bd bg-mf-card2'>
            <td className='px-[17px] py-[11px] text-[12px] font-semibold text-mf-tx2'>
              Total
            </td>
            <td className='px-[10px] py-[11px] text-right text-[12px] font-medium text-mf-tx2'>
              {totals.eventCount.toLocaleString()}
            </td>
            <td className='px-[17px] py-[11px] text-right text-[12px] font-semibold text-mf-tx'>
              {formatCost(totals.cost)}
            </td>
            {showRevenue && (
              // No single reconciled per-bucket revenue total is shown here —
              // Billed "Other" can include out-of-window-event customers, so a
              // footer sum would misleadingly not match the visible rows. The
              // whole-window revenue lives in the KPI tiles above.
              <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx3'>
                —
              </td>
            )}
            {showRevenue && (
              <td className='px-[17px] py-[11px] text-right text-[12px] text-mf-tx3'>
                —
              </td>
            )}
          </tr>
        </tfoot>
      </table>
    </TileFrame>
  )
}
