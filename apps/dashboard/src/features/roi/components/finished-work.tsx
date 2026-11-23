'use client'

/**
 * "What you finished", its own tab.
 *
 * This file renders and nothing else. Every string, every dollar and every
 * dash arrives already built from report-derivation.ts, which the print and
 * the JSON route call too, so a number here cannot read differently there.
 */

import { useRouter } from 'next/navigation'
import {
  FINISHED_WORK_COPY,
  FINISHED_WORK_SOURCE_TOOLTIPS,
  FINISHED_WORK_TOTALS_TOOLTIPS,
  ROI_TOOLTIPS,
  finishedWorkSourceWord,
  finishedWorkTotalsWord,
} from '../report-derivation'
import type {
  FinishedWorkBlock,
  FinishedWorkRow,
  FinishedWorkTotals,
  RoiTooltip,
} from '../report-derivation'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { InfoTooltip, TooltipWrap } from '@/components/ui/info-tooltip'

const HEADER_CELL =
  'px-[10px] pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'
const BODY_CELL = 'px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'
const SECTION_HEADING = 'text-[13px] font-semibold tracking-[-.01em] text-mf-tx'
const NOTE = 'text-[11.5px] text-mf-tx3'
/** Not NOTE: what the whole cost column is, and is not, reads at the same
 * contrast as the numbers it describes. The print says it too. */
const HONESTY = 'text-[11.5px] text-mf-tx2'

const GETTING_STARTED_HREF = '/developer-zone/getting-started'

/** Keyed by the header string the builder emits, so a renamed column with no
 * hover is a build error rather than a silent gap. */
const COLUMN_TOOLTIPS: Record<
  (typeof FINISHED_WORK_COPY.tableHeaders)[number],
  RoiTooltip
> = {
  'What you finished': ROI_TOOLTIPS.finishedName,
  'How many': ROI_TOOLTIPS.finishedHowMany,
  'AI cost': ROI_TOOLTIPS.finishedAiCost,
  'Cost for one': ROI_TOOLTIPS.finishedCostForOne,
}

export interface FinishedWorkProps {
  block: FinishedWorkBlock | null
  state: TileState
  errorMessage?: string
}

export function FinishedWork({
  block,
  state,
  errorMessage,
}: FinishedWorkProps) {
  const router = useRouter()

  return (
    <section data-tour='finished-work-table' className='flex flex-col gap-2'>
      <div className='flex items-center gap-1.5'>
        <h2 className={SECTION_HEADING}>{FINISHED_WORK_COPY.heading}</h2>
        <InfoTooltip
          title={ROI_TOOLTIPS.finishedHeading.title}
          description={ROI_TOOLTIPS.finishedHeading.description}
          iconSize='h-3 w-3'
        />
      </div>

      {block?.kind === 'empty' ? (
        <EmptyState
          title={block.title}
          description={block.body}
          // No door to Getting Started when the check marks emptied the
          // table: the meter this button sets up is already recording.
          action={
            block.reason === 'no-agents'
              ? undefined
              : {
                  label: FINISHED_WORK_COPY.emptyButton,
                  onClick: () => router.push(GETTING_STARTED_HREF),
                }
          }
          variant='dashed'
          size='md'
        />
      ) : (
        <TileFrame
          state={state}
          errorMessage={errorMessage}
          className='min-h-[120px] overflow-hidden'
          loadingLines={3}
        >
          {block && block.kind === 'rows' && (
            <div className='flex flex-col gap-2 px-[17px] py-[14px]'>
              <p className='text-[12px] text-mf-tx2'>{block.lead}</p>

              <table className='w-full border-collapse'>
                <thead>
                  <tr>
                    {block.tableHeaders.map((header) => (
                      <th key={header} className={HEADER_CELL}>
                        <span className='inline-flex items-center gap-1'>
                          {header}
                          <InfoTooltip
                            title={COLUMN_TOOLTIPS[header].title}
                            description={COLUMN_TOOLTIPS[header].description}
                            iconSize='h-3 w-3'
                          />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row.key} className='border-t border-mf-bd2'>
                      <td className='px-[10px] py-[7px] text-[12px] text-mf-tx'>
                        {row.name}
                      </td>
                      <td className={BODY_CELL}>{row.howMany}</td>
                      <td className={BODY_CELL}>
                        <span className='inline-flex items-center gap-1.5'>
                          {row.aiCost}
                          <SourceWord row={row} />
                        </span>
                      </td>
                      <td className={BODY_CELL}>{row.costForOne}</td>
                    </tr>
                  ))}
                  <tr className='border-t border-mf-bd'>
                    <td className='px-[10px] py-[7px] text-[12px] font-semibold text-mf-tx'>
                      {block.totals.label}
                    </td>
                    <td className={`${BODY_CELL} font-semibold`}>
                      {block.totals.howMany}
                    </td>
                    <td className={`${BODY_CELL} font-semibold`}>
                      <span className='inline-flex items-center gap-1.5'>
                        {block.totals.aiCost}
                        <TotalsWord totals={block.totals} />
                      </span>
                    </td>
                    <td className={BODY_CELL} />
                  </tr>
                </tbody>
              </table>

              {block.honesty.attribution && (
                <p className={HONESTY}>{block.honesty.attribution}</p>
              )}
              {block.honesty.moreNames && (
                <p className={NOTE}>{block.honesty.moreNames}</p>
              )}
              {block.honesty.unattributed && (
                <p className={NOTE}>{block.honesty.unattributed}</p>
              )}
              {block.honesty.unpriced && (
                <p className={NOTE}>{block.honesty.unpriced}</p>
              )}
            </div>
          )}
        </TileFrame>
      )}
    </section>
  )
}

/** The word instead of the * and + marks. A row with no cost has no number
 * for a word to describe, so it keeps its dash alone. */
function SourceWord({ row }: { row: FinishedWorkRow }) {
  const word = finishedWorkSourceWord(row)
  if (word === null) return null
  return (
    <WordBadge
      word={FINISHED_WORK_COPY.sourceWords[word]}
      tooltip={FINISHED_WORK_SOURCE_TOOLTIPS[word]}
    />
  )
}

/** The totals row is the number most likely to be lifted into a board deck,
 * and it blends measured money with attributed shares, so it says where it
 * came from like every other costed row on this tab. */
function TotalsWord({ totals }: { totals: FinishedWorkTotals }) {
  const word = finishedWorkTotalsWord(totals)
  if (word === null) return null
  return (
    <WordBadge
      word={FINISHED_WORK_COPY.sourceWords[word]}
      tooltip={FINISHED_WORK_TOTALS_TOOLTIPS[word]}
    />
  )
}

function WordBadge({ word, tooltip }: { word: string; tooltip: RoiTooltip }) {
  return (
    <TooltipWrap title={tooltip.title} description={tooltip.description}>
      <button
        type='button'
        className='cursor-help rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
      >
        <Badge
          variant='outline'
          className='border-mf-bd px-1.5 py-0 text-[10px] font-medium text-mf-tx3'
        >
          {word}
        </Badge>
      </button>
    </TooltipWrap>
  )
}
