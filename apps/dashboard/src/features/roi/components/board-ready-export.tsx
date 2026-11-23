'use client'

/**
 * Deliberately simple browser-print export,
 * not a slide-deck engine (window.print + @media print, the invoice-print
 * pattern in the @media print block of src/index.css). Renders the SAME activeViews as the cards,
 * through the SAME progress-derivation builders — no new fetch, no new
 * money formatting, so the print can never disagree with the page.
 *
 * Page one LEADS with the Without AI comparison, then the
 * agent table and the metrics, then the goal tables. The block arrives already
 * built from report-derivation.ts, the composer the screen also calls, so the
 * paper and the screen cannot say different things.
 */

import { useCurrentOrganization } from '@/hooks/use-auth'
import { notifyRoiTour } from '../tour/tour-events'
import type { RoiInitiativeView } from '@/app/actions/roi-overview'
import { HEALTH_PILLS } from './status-maps'
import {
  goalSentence,
  goalProgressSentence,
  displayProgressPct,
  formatGoalWindow,
  matterScopeLabel,
  progressLabel,
} from '../progress-derivation'
import {
  FINISHED_WORK_COPY,
  REPORT_COPY,
  finishedWorkSourceWord,
  finishedWorkTotalsWord,
  type PrintReport,
  type WithoutAiRow,
} from '../report-derivation'

/** The ONE print. Every button labelled Print report opens this, so two
 * exports of the same page can never drift apart. */
export function openBoardReadyPrint() {
  // Told first, not after: window.print blocks on the browser's own dialog,
  // so a tour step waiting on this would not advance until the customer had
  // already finished with the print window.
  notifyRoiTour({ kind: 'print-opened' })
  window.print()
}

export function BoardReadyExportButton({
  disabled,
  dataTour,
}: {
  disabled: boolean
  /** Anchor for the ROI guided tour; only the header button carries it, so
   * the step points at one of the two identical doors. */
  dataTour?: string
}) {
  return (
    <button
      type='button'
      onClick={openBoardReadyPrint}
      disabled={disabled}
      data-tour={dataTour}
      title={REPORT_COPY.printReportHover}
      className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:opacity-50'
    >
      {REPORT_COPY.printReportLabel}
    </button>
  )
}

function PrintComparisonRow({ row }: { row: WithoutAiRow }) {
  return (
    <div className='mb-2'>
      <p className='mb-0.5 text-xs font-semibold'>{row.heading}</p>
      <table className='mb-0.5 w-full text-xs'>
        <tbody>
          <tr>
            <td className='py-0.5 text-gray-700'>{row.withAiLabel}</td>
            <td className='py-0.5 text-right font-semibold'>{row.withAi}</td>
          </tr>
          <tr>
            <td className='py-0.5 text-gray-700'>{row.withoutAiLabel}</td>
            <td className='py-0.5 text-right font-semibold'>{row.withoutAi}</td>
          </tr>
        </tbody>
      </table>
      {row.note && <p className='text-xs text-gray-600'>{row.note}</p>}
      <p className='text-xs font-semibold'>{row.sentence}</p>
    </div>
  )
}

/**
 * Print-only (`hidden print:block`, InvoicePrintView's shape). Pairs with
 * the `no-print` wrapper on the live grid in index.tsx so exactly one of
 * the two renders on paper.
 */
export function BoardReadyExportView({
  initiatives,
  goalsRead,
  report,
}: {
  initiatives: RoiInitiativeView[]
  /** An empty `initiatives` before the read lands is an unread list, and
   * the paper may not state it as a count of zero. */
  goalsRead: boolean
  report: PrintReport | null
}) {
  const { organization } = useCurrentOrganization()
  const generatedOn = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className='print-content hidden print:block'>
      <header className='print-header mb-6 flex items-baseline justify-between border-b-2 border-black pb-3'>
        <div>
          <h1 className='text-xl font-bold'>ROI report</h1>
          <p className='text-sm text-gray-600'>
            {organization?.name ?? 'Your organization'}
          </p>
        </div>
        <p className='text-sm text-gray-600'>{generatedOn}</p>
      </header>

      {report && (
        <section className='mb-6'>
          <p className='mb-3 text-xs text-gray-600'>{report.datesLine}</p>

          {report.withoutAi && (
            <div className='print-no-break mb-4'>
              <h2 className='mb-1 text-base font-semibold'>
                {report.withoutAi.heading}
              </h2>
              <p className='mb-2 text-sm font-semibold'>
                {report.withoutAi.netLine}
              </p>
              <PrintComparisonRow row={report.withoutAi.cost} />
              <PrintComparisonRow row={report.withoutAi.revenue} />
              {report.withoutAi.revenueNote && (
                <p className='mb-2 text-xs text-gray-600'>
                  {report.withoutAi.revenueNote}
                </p>
              )}
              <p className='mb-1 text-xs text-gray-700'>
                {report.withoutAi.paragraph}
              </p>
              <p className='text-xs text-gray-600'>
                {report.withoutAi.estimateLabel}
              </p>
            </div>
          )}

          <p className='mb-2 text-xs text-gray-600'>{report.proxyGap}</p>
          <p className='mb-5 text-xs text-gray-600'>{report.hoursNote}</p>

          <h2 className='mb-1 text-base font-semibold'>
            {report.agentsHeading}
          </h2>
          <p className='mb-2 text-xs text-gray-700'>{report.leadSentence}</p>
          {report.totals && (
            <table className='mb-2 w-full text-xs'>
              <thead>
                <tr className='border-b border-gray-300 text-left'>
                  {report.tableHeaders.map((header) => (
                    <th key={header} className='py-1'>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.key} className='border-b border-gray-100'>
                    <td className='py-1'>{row.name}</td>
                    <td className='py-1'>{row.usageEvents}</td>
                    <td className='py-1'>{row.cost}</td>
                    <td className='py-1'>{row.earned}</td>
                    <td className='py-1'>{row.revenue}</td>
                    <td className='py-1'>{row.margin}</td>
                    <td className='py-1'>{row.counted}</td>
                  </tr>
                ))}
                <tr className='border-t border-gray-300 font-semibold'>
                  <td className='py-1'>{report.totals.label}</td>
                  <td className='py-1'>{report.totals.usageEvents}</td>
                  <td className='py-1'>{report.totals.cost}</td>
                  <td className='py-1'>{report.totals.earned}</td>
                  <td className='py-1'>{report.totals.revenue}</td>
                  <td className='py-1' />
                  <td className='py-1' />
                </tr>
              </tbody>
            </table>
          )}
          <p className='mb-4 text-xs text-gray-600'>
            {report.usageEventDefinition}
          </p>

          {report.finishedWork && (
            <div className='print-no-break mb-4'>
              <h2 className='mb-1 text-base font-semibold'>
                {report.finishedWork.heading}
              </h2>
              {report.finishedWork.kind === 'empty' ? (
                <p className='text-xs text-gray-700'>
                  {report.finishedWork.body}
                </p>
              ) : (
                <>
                  <p className='mb-2 text-xs text-gray-700'>
                    {report.finishedWork.lead}
                  </p>
                  <table className='mb-2 w-full text-xs'>
                    <thead>
                      <tr className='border-b border-gray-300 text-left'>
                        {report.finishedWork.tableHeaders.map((header) => (
                          <th key={header} className='py-1'>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.finishedWork.rows.map((row) => (
                        <tr key={row.key} className='border-b border-gray-100'>
                          <td className='py-1'>{row.name}</td>
                          <td className='py-1'>{row.howMany}</td>
                          <td className='py-1'>
                            {row.aiCost}
                            {finishedWorkSourceWord(row) && (
                              <span className='ml-1.5 text-[10px] uppercase tracking-wide text-gray-600'>
                                {
                                  FINISHED_WORK_COPY.sourceWords[
                                    finishedWorkSourceWord(row)!
                                  ]
                                }
                              </span>
                            )}
                          </td>
                          <td className='py-1'>{row.costForOne}</td>
                        </tr>
                      ))}
                      <tr className='border-t border-gray-300 font-semibold'>
                        <td className='py-1'>
                          {report.finishedWork.totals.label}
                        </td>
                        <td className='py-1'>
                          {report.finishedWork.totals.howMany}
                        </td>
                        <td className='py-1'>
                          {report.finishedWork.totals.aiCost}
                          {finishedWorkTotalsWord(
                            report.finishedWork.totals
                          ) && (
                            <span className='ml-1.5 text-[10px] uppercase tracking-wide text-gray-600'>
                              {
                                FINISHED_WORK_COPY.sourceWords[
                                  finishedWorkTotalsWord(
                                    report.finishedWork.totals
                                  )!
                                ]
                              }
                            </span>
                          )}
                        </td>
                        <td className='py-1' />
                      </tr>
                    </tbody>
                  </table>
                  {report.finishedWork.honesty.moreNames && (
                    <p className='mb-1 text-xs text-gray-600'>
                      {report.finishedWork.honesty.moreNames}
                    </p>
                  )}
                  {/* One vocabulary on screen and on paper: the words the
                      cells carry, explained where nobody can hover. */}
                  <p className='mb-1 text-xs text-gray-600'>
                    {FINISHED_WORK_COPY.sourceWordLegend}
                  </p>
                  <p className='mb-1 text-xs text-gray-600'>
                    {FINISHED_WORK_COPY.totalsWordLegend}
                  </p>
                  {report.finishedWork.honesty.unattributed && (
                    <p className='mb-1 text-xs text-gray-600'>
                      {report.finishedWork.honesty.unattributed}
                    </p>
                  )}
                  {report.finishedWork.honesty.unpriced && (
                    <p className='mb-1 text-xs text-gray-600'>
                      {report.finishedWork.honesty.unpriced}
                    </p>
                  )}
                  {report.finishedWork.honesty.attribution && (
                    <p className='text-xs text-gray-600'>
                      {report.finishedWork.honesty.attribution}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <h2 className='mb-1 text-base font-semibold'>
            {report.metricsHeading}
          </h2>
          <table className='mb-4 w-full text-xs'>
            <tbody>
              {report.metrics.map((tile) => (
                <tr key={tile.key} className='border-b border-gray-100'>
                  <td className='py-1 align-top'>{tile.label}</td>
                  <td className='py-1 align-top font-semibold'>{tile.value}</td>
                  <td className='py-1 align-top text-gray-600'>
                    {tile.definition}
                    {tile.notes.map((note) => (
                      <span key={note} className='mt-1 block'>
                        {note}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.everyAgentTilesNote && (
            <p className='mb-4 text-xs text-gray-600'>
              {report.everyAgentTilesNote}
            </p>
          )}

          <h2 className='mb-1 mt-6 text-base font-semibold'>
            {REPORT_COPY.goalsHeading}
          </h2>
          <p className='mb-3 text-xs text-gray-600'>
            {REPORT_COPY.goalsOwnWindowNote}
          </p>
        </section>
      )}

      {!goalsRead && (
        <p className='text-sm text-gray-600'>{REPORT_COPY.goalsUnread}</p>
      )}

      {goalsRead && initiatives.length === 0 && (
        <p className='text-sm text-gray-600'>No goals tracked yet.</p>
      )}

      {goalsRead &&
        initiatives.map((view) => {
          const matterScope = matterScopeLabel(view)
          return (
            <section key={view.id} className='print-no-break mb-6'>
              <div className='mb-1 flex items-baseline justify-between gap-2'>
                <h2 className='text-base font-semibold'>{view.name}</h2>
                <span className='text-xs font-medium'>
                  {HEALTH_PILLS[view.health].label}
                </span>
              </div>
              <p className='mb-2 text-xs text-gray-600'>
                {formatGoalWindow(view.startDate, view.endDate)}
              </p>
              {matterScope && (
                <p className='mb-2 text-xs text-gray-600'>{matterScope}</p>
              )}
              {view.description && (
                <p className='mb-2 text-xs text-gray-700'>{view.description}</p>
              )}
              {view.targets.length === 0 ? (
                <p className='text-xs text-gray-600'>No target set.</p>
              ) : (
                <table className='w-full text-xs'>
                  <thead>
                    <tr className='border-b border-gray-300 text-left'>
                      <th className='py-1'>Goal</th>
                      <th className='py-1'>Where it stands</th>
                      <th className='py-1 text-right'>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.targets.map((target) => (
                      <tr key={target.id} className='border-b border-gray-100'>
                        <td className='py-1'>{goalSentence(target)}</td>
                        <td className='py-1'>
                          {goalProgressSentence(target, view.elapsedPct)}
                        </td>
                        <td className='py-1 text-right'>
                          {progressLabel(displayProgressPct(target))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )
        })}
    </div>
  )
}
