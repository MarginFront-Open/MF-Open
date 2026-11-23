/**
 * Read-only GL-mapping table. Rows come from
 * getSignalsForClassification (current signal→GL state); edits happen on
 * /finops-settings, and the classification
 * fix-loop deep-link carries this page's month bounds.
 *
 * HEADER-COUNT SEMANTICS: the
 * header count is the SAME journal-derived value the "Unmapped items" KPI
 * tile shows — distinct signals behind this month's __unmapped journal
 * bucket, plus one synthetic member when signal-less events landed there.
 * The table's amber "Unmapped" pills are a DIFFERENT truth: signals whose
 * current mapping is empty, whether or not they had cost this month. The two
 * can legitimately differ (an unmapped signal with no events this month has
 * a pill but no journal cost; signal-less events have journal cost but no
 * row), so the header says "unmapped this month" — a month-scoped journal
 * fact. It does not claim to count the pills below, which would be off by
 * one (or more). One source, two
 * honestly-labeled truths; the tile and header can never disagree because
 * they render the same variable.
 */

import Link from 'next/link'
import { Settings2, Tags } from 'lucide-react'
import { formatCost } from '@/lib/canon-format'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { COST_CATEGORY_LABELS } from '@/features/cost-management/classification-utils'
import {
  TileFrame,
  type TileStateProps,
} from '@/features/dashboard-shell/tiles/tile-frame'
import type { SignalClassificationRow } from '@/app/actions/signal-classification'

type MappingStatus = 'mapped' | 'default' | 'unmapped'

const STATUS_LABEL: Record<MappingStatus, string> = {
  mapped: 'Mapped',
  default: 'Default',
  unmapped: 'Unmapped',
}

const STATUS_PILL_CLASS: Record<MappingStatus, string> = {
  mapped: 'bg-mf-card2 text-mf-green',
  default: 'bg-mf-card2 text-mf-tx2',
  unmapped: 'bg-mf-card2 text-mf-amber',
}

// Bordered+icon chips match close-controls' button weight so this reads as
// a CTA.
const ACTION_LINK_CLASS =
  'flex h-7 items-center gap-1.5 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:border-mf-accent hover:text-mf-accent'

function rowStatus(row: SignalClassificationRow): MappingStatus {
  if (row.glCodeId !== null) return 'mapped'
  // A categorized signal with no direct GL still books to its
  // category's default GL account. That is NOT "unmapped", and it is not
  // "mapped" either, so it gets its own 'default' status.
  if (row.costCategory !== 'UNCLASSIFIED') return 'default'
  return 'unmapped'
}

export interface GlMappingTableProps extends TileStateProps {
  rows: SignalClassificationRow[] | null
  /** The journal-derived count the KPI tile shows — the ONE source. */
  unmappedCount: number | null
  /** Journal unmapped dollars: the fallback figure for frozen snapshots that carry no count. */
  unmappedAmount: number | null
  startDate: string
  endDate: string
}

function unmappedNote(
  unmappedCount: number | null,
  unmappedAmount: number | null
): { text: string; amber: boolean } | null {
  if (unmappedAmount === null) return null
  if (unmappedAmount === 0) {
    return { text: 'All of this month’s cost is mapped', amber: false }
  }
  if (unmappedCount !== null) {
    return { text: `${unmappedCount} unmapped this month`, amber: true }
  }
  // A frozen snapshot with no unmappedSignalCount: fall back to dollars.
  return {
    text: `${formatCost(unmappedAmount)} unmapped this month`,
    amber: true,
  }
}

export function GlMappingTable({
  rows,
  unmappedCount,
  unmappedAmount,
  startDate,
  endDate,
  state,
  errorMessage,
}: GlMappingTableProps) {
  const note = unmappedNote(unmappedCount, unmappedAmount)
  const effectiveState =
    state === 'ready' && (rows === null || rows.length === 0) ? 'empty' : state

  return (
    <section>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
          GL mapping
        </h2>
        {note && (
          <span
            className={`text-[11px] font-medium ${
              note.amber ? 'text-mf-amber' : 'text-mf-tx3'
            }`}
          >
            {note.text}
          </span>
        )}
        <div className='ml-auto flex flex-wrap items-center gap-2'>
          <Link
            href={`/finops?tab=cost-management&startDate=${startDate}&endDate=${endDate}`}
            className={ACTION_LINK_CLASS}
          >
            <Tags className='h-3.5 w-3.5' />
            Categorize & map signals
          </Link>
          <Link href='/finops?tab=settings' className={ACTION_LINK_CLASS}>
            <Settings2 className='h-3.5 w-3.5' />
            Create rules & GL codes
          </Link>
        </div>
      </div>

      <TileFrame
        state={effectiveState}
        errorMessage={errorMessage}
        emptyMessage='No signals yet. Record some usage to see them here.'
        className='min-h-[120px] overflow-hidden'
        loadingLines={4}
      >
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Signal
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                GL code
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Account
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => {
              const status = rowStatus(row)
              // glCodeDisplay is "5100: AI Inference" (signal-classification.ts).
              const [glCode, ...glNameParts] = (row.glCodeDisplay ?? '').split(
                ': '
              )
              return (
                <tr key={row.id} className='border-t border-mf-bd2'>
                  <td className='px-[17px] py-[7px] text-[12px] text-mf-tx'>
                    {row.name}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {status === 'mapped' ? glCode : '—'}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] text-mf-tx2'>
                    {status === 'mapped'
                      ? glNameParts.join(': ')
                      : status === 'default'
                        ? `${COST_CATEGORY_LABELS[row.costCategory]} default`
                        : '—'}
                  </td>
                  <td className='px-[17px] py-[7px]'>
                    <span className='flex items-center gap-1'>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${STATUS_PILL_CLASS[status]}`}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                      {status === 'default' && (
                        <InfoTooltip
                          {...tooltipDefinitions.categoryDefaultGl}
                          iconSize='h-3 w-3'
                        />
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TileFrame>
    </section>
  )
}
