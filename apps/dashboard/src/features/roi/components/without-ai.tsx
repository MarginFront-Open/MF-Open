'use client'

/**
 * The "Without AI" section of the ROI report: what AI cost and
 * earned in these dates, next to the customer's own estimate of the same work
 * without it.
 *
 * This file renders and nothing else. Every sentence and every dollar arrives
 * already built from report-derivation.ts, which the print and the JSON route
 * also call, so the page and the slide cannot disagree.
 *
 * The story paragraph is deliberately absent from the screen and present on
 * the paper and in the JSON: the table says the same thing here in less
 * reading, and the byte-identical paragraph is what the data contract owes.
 *
 * Two homes for the inputs, on purpose. The method and its figures are the
 * same every month, so they save to the org. The count of finished work is
 * true for these dates only, so it commits to the page link the way a date
 * change does, and a shared link carries it.
 */

import { useCallback, useId, useState, useTransition } from 'react'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import {
  saveOrgRoiAssumptions,
  type OrgRoiAssumptions,
} from '@/app/actions/org-roi-assumptions'
import {
  ROI_TOOLTIPS,
  WITHOUT_AI_COPY,
  WITHOUT_AI_METHODS,
  comparisonDifferenceCell,
  missingMethodFields,
  parseWindowInputDraft,
  resolveUnitNouns,
  type RoiAssumptions,
  type WithoutAiBlock,
  type WithoutAiMethod,
  type WithoutAiRow,
  type WithoutAiStampedRow,
  type WithoutAiWindowInputs,
  type FinishedWorkRecordedThing,
  type RoiTooltip,
} from '../report-derivation'
import { BoardReadyExportButton } from './board-ready-export'
import { notifyRoiTour } from '../tour/tour-events'
import { InfoTooltip } from '@/components/ui/info-tooltip'

const SECTION_HEADING = 'text-[13px] font-semibold tracking-[-.01em] text-mf-tx'
const NOTE = 'text-[11.5px] text-mf-tx3'
/** Not NOTE: the sentence that keeps the comparison honest reads at the same
 * contrast as the numbers it qualifies. */
const STAMP = 'text-[11.5px] text-mf-tx2'
const TABLE_HEADER_CELL = 'px-[10px] pb-2 pt-[10px] text-left align-bottom'
const TABLE_HEADER_LABEL =
  'text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'
const TABLE_SUB_CELL = 'mt-0.5 block text-[10px] font-normal text-mf-tx3'
const TABLE_ROW_LABEL = 'px-[10px] py-[9px] text-[12px] font-medium text-mf-tx'
const TABLE_CELL =
  'px-[10px] py-[9px] text-[13px] font-semibold tabular-nums text-mf-tx'
const LABEL_CLASS = 'text-[11px] font-medium text-mf-tx2'
const INPUT_CLASS =
  'h-8 w-full rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2 text-[12px] text-mf-tx disabled:opacity-60'
const FIELD_CLASS = 'flex flex-col gap-1'
const BUTTON_CLASS =
  'h-7 self-start rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:opacity-50'

/** Every field opens blank and stays a string until it is saved: no suggested
 * rate, no industry default, nothing inferred from the usage-event count. A
 * guessed default is a number the customer never said. */
interface DraftFields {
  method: WithoutAiMethod
  unitSingular: string
  unitPlural: string
  costPerItem: string
  hoursPerMonth: string
  hourlyRate: string
  costPerMonth: string
  revenuePerMonth: string
  unitsCompleted: string
}

const BLANK_DRAFT: DraftFields = {
  method: 'peopleTime',
  unitSingular: '',
  unitPlural: '',
  costPerItem: '',
  hoursPerMonth: '',
  hourlyRate: '',
  costPerMonth: '',
  revenuePerMonth: '',
  unitsCompleted: '',
}

function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

function methodLabel(method: WithoutAiMethod, unitSingular: string): string {
  if (method === 'perItem') {
    return WITHOUT_AI_COPY.methodChoice.perItem(unitSingular)
  }
  if (method === 'peopleTime') return WITHOUT_AI_COPY.methodChoice.peopleTime
  return WITHOUT_AI_COPY.methodChoice.periodTotal
}

export interface WithoutAiProps {
  block: WithoutAiBlock
  window: { startDate: string; endDate: string }
  inputs: WithoutAiWindowInputs
  onInputsChange: (next: Partial<WithoutAiWindowInputs>) => void
  /** The names and counts behind inputs.measuredCount, so the
   *  helper under the count field can say WHAT the meter counted, not only
   *  that it did. Per name: a sum under one noun over a mix of names is not a
   *  count. */
  measuredThings: readonly FinishedWorkRecordedThing[]
  assumptions: RoiAssumptions | null
  /** The page owns the read, so it owns the sentence that says it failed. */
  readError: string | null
  /** No null: only the page starts in the unread state, and only once. */
  onAssumptionsChange: (next: RoiAssumptions) => void
  /** The print states the goals, so this door waits on the flag the header's
   * Print report waits on. */
  goalsRead: boolean
}

export function WithoutAi({
  block,
  window: reportWindow,
  inputs,
  onInputsChange,
  measuredThings,
  assumptions,
  readError,
  onAssumptionsChange,
  goalsRead,
}: WithoutAiProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DraftFields>(BLANK_DRAFT)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, startSave] = useTransition()

  const openInputs = useCallback(() => {
    setSaved(false)
    setSaveError(null)
    const text = (value: number | undefined) =>
      value === undefined ? '' : String(value)
    setDraft({
      method: assumptions?.method ?? BLANK_DRAFT.method,
      unitSingular: assumptions?.unitSingular ?? '',
      unitPlural: assumptions?.unitPlural ?? '',
      costPerItem: text(assumptions?.costPerItem),
      hoursPerMonth: text(assumptions?.hoursPerMonth),
      hourlyRate: text(assumptions?.hourlyRate),
      costPerMonth: text(assumptions?.costPerMonth),
      revenuePerMonth: text(assumptions?.revenuePerMonth),
      // Pre-filled with the meter's count when nothing was typed over it, so
      // the default the customer sees is the measured number.
      unitsCompleted: String(
        inputs.unitsCompleted ?? inputs.measuredCount ?? ''
      ),
    })
    setOpen(true)
  }, [assumptions, inputs.unitsCompleted, inputs.measuredCount])

  const setField = (field: keyof DraftFields) => (value: string) => {
    setSaved(false)
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const commit = () => {
    setSaveError(null)
    // Checked against the reader's rules BEFORE anything is written: a value
    // it refuses would otherwise save, say "Saved", and blank the paragraph.
    const windowFields = parseWindowInputDraft({
      unitsCompleted: draft.unitsCompleted,
    })
    if (!windowFields.ok) {
      setSaveError(windowFields.error)
      return
    }
    const orgFields: OrgRoiAssumptions = {
      method: draft.method,
      unitSingular: draft.unitSingular,
      unitPlural: draft.unitPlural,
      costPerItem: numberOrUndefined(draft.costPerItem),
      hoursPerMonth: numberOrUndefined(draft.hoursPerMonth),
      hourlyRate: numberOrUndefined(draft.hourlyRate),
      costPerMonth: numberOrUndefined(draft.costPerMonth),
      revenuePerMonth: numberOrUndefined(draft.revenuePerMonth),
    }
    // Without this the write succeeds, says "Saved", and leaves the comparison
    // blank with no word about which field was missing.
    const missing = missingMethodFields(draft.method, orgFields)
    if (missing.length > 0) {
      setSaveError(WITHOUT_AI_COPY.methodIncomplete(missing))
      return
    }
    // Saving the count the meter already reported would restamp a measured
    // number as the customer's own. Only a count they changed goes in the link.
    const countToCommit =
      windowFields.values.unitsCompleted === inputs.measuredCount
        ? null
        : windowFields.values.unitsCompleted
    startSave(async () => {
      try {
        const result = await saveOrgRoiAssumptions(orgFields)
        if (!result.success) {
          setSaveError(result.error)
          return
        }
        onAssumptionsChange(result.data.assumptions ?? {})
        notifyRoiTour({ kind: 'numbers-saved' })
        // The count never touches the org row: it goes where the dates go, so
        // a reload against different dates cannot show a stale count.
        onInputsChange({ unitsCompleted: countToCommit })
        setSaved(true)
        setOpen(false)
      } catch {
        setSaveError(WITHOUT_AI_COPY.saveFailed)
      }
    })
  }

  if (block.kind === 'loading') {
    return (
      <section className='flex flex-col gap-2'>
        <h2 className={SECTION_HEADING}>{WITHOUT_AI_COPY.heading}</h2>
        <TileFrame
          state='loading'
          className='px-[17px] py-[14px]'
          loadingLines={3}
        >
          <div />
        </TileFrame>
      </section>
    )
  }

  const nouns = resolveUnitNouns(assumptions ?? {})
  const meterCounted = inputs.measuredCount !== null

  return (
    <section className='flex flex-col gap-2'>
      <div className='flex items-center gap-1.5'>
        <h2 className={SECTION_HEADING}>{WITHOUT_AI_COPY.heading}</h2>
        <Hover tooltip={ROI_TOOLTIPS.withoutAiHeading} />
      </div>

      <div className='flex flex-col gap-2 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[14px]'>
        {readError && <p className='text-[11.5px] text-mf-red'>{readError}</p>}
        {block.kind === 'empty' ? (
          <>
            <p className='text-[12px] text-mf-tx2'>{block.body}</p>
            {!open && (
              <div className='flex items-center gap-1.5'>
                <button
                  type='button'
                  onClick={openInputs}
                  data-tour='estimate-without-ai'
                  className={BUTTON_CLASS}
                >
                  {block.buttonLabel}
                </button>
                <Hover tooltip={ROI_TOOLTIPS.estimateWithoutAi} />
              </div>
            )}
          </>
        ) : (
          <>
            <div className='flex items-center gap-1.5'>
              <p
                data-tour='net-line'
                className='text-[15px] font-semibold tracking-[-.01em] text-mf-tx'
              >
                {block.netLine}
              </p>
              <Hover tooltip={ROI_TOOLTIPS.netLine} />
            </div>
            <p className={STAMP}>{block.estimateLabel}</p>
            <ComparisonTable block={block} />
            <p className='text-[12px] font-medium text-mf-tx'>
              {block.cost.sentence}
            </p>
            <p className='text-[12px] font-medium text-mf-tx'>
              {block.revenue.sentence}
            </p>
            {block.revenueNote && <p className={NOTE}>{block.revenueNote}</p>}
            {!open && (
              <div className='flex items-center gap-1.5'>
                <button
                  type='button'
                  onClick={openInputs}
                  data-tour='estimate-without-ai'
                  className={BUTTON_CLASS}
                >
                  {WITHOUT_AI_COPY.editButton}
                </button>
                <Hover tooltip={ROI_TOOLTIPS.changeYourNumbers} />
              </div>
            )}
          </>
        )}

        {open && (
          <div
            data-tour='estimate-without-ai'
            className='flex flex-col gap-3 border-t border-mf-bd2 pt-3'
          >
            <fieldset className='flex flex-col gap-3'>
              <legend className={LABEL_CLASS}>
                <span className='inline-flex items-center gap-1.5'>
                  {WITHOUT_AI_COPY.methodQuestion}
                  <Hover tooltip={ROI_TOOLTIPS.methodChoice} />
                </span>
              </legend>
              {WITHOUT_AI_METHODS.map((method) => (
                <div key={method} className='flex flex-col gap-2'>
                  <label className='flex items-center gap-1.5 text-[12px] text-mf-tx2'>
                    <input
                      type='radio'
                      name='without-ai-method'
                      value={method}
                      checked={draft.method === method}
                      onChange={() => setField('method')(method)}
                    />
                    {methodLabel(method, nouns.singular)}
                  </label>
                  {draft.method === method && (
                    <div className='grid grid-cols-12 gap-3 pl-5'>
                      {method === 'perItem' && (
                        <>
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.costPerItemLabel(
                              nouns.singular
                            )}
                            value={draft.costPerItem}
                            onChange={setField('costPerItem')}
                            numeric
                          />
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.countLabel(
                              nouns.plural,
                              reportWindow.startDate,
                              reportWindow.endDate
                            )}
                            helper={
                              meterCounted
                                ? WITHOUT_AI_COPY.countMeasuredNote(
                                    nouns.plural,
                                    measuredThings,
                                    inputs.measuredCount ?? 0
                                  )
                                : inputs.windowIsAnchored
                                  ? undefined
                                  : WITHOUT_AI_COPY.countNeedsDatesHelper
                            }
                            value={draft.unitsCompleted}
                            onChange={setField('unitsCompleted')}
                            numeric
                            wholeNumber
                          />
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.unitSingularLabel}
                            helper={WITHOUT_AI_COPY.unitSingularHelper}
                            value={draft.unitSingular}
                            onChange={setField('unitSingular')}
                          />
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.unitPluralLabel}
                            helper={WITHOUT_AI_COPY.unitPluralHelper}
                            value={draft.unitPlural}
                            onChange={setField('unitPlural')}
                          />
                        </>
                      )}
                      {method === 'peopleTime' && (
                        <>
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.hoursPerMonthLabel}
                            value={draft.hoursPerMonth}
                            onChange={setField('hoursPerMonth')}
                            numeric
                          />
                          <Field
                            className='col-span-12 sm:col-span-6'
                            label={WITHOUT_AI_COPY.hourlyRateLabel}
                            helper={WITHOUT_AI_COPY.hourlyRateHelper}
                            value={draft.hourlyRate}
                            onChange={setField('hourlyRate')}
                            numeric
                          />
                        </>
                      )}
                      {method === 'periodTotal' && (
                        <Field
                          className='col-span-12 sm:col-span-6'
                          label={WITHOUT_AI_COPY.costPerMonthLabel}
                          value={draft.costPerMonth}
                          onChange={setField('costPerMonth')}
                          numeric
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </fieldset>

            <div className='grid grid-cols-12 gap-3'>
              <Field
                className='col-span-12 sm:col-span-6'
                label={WITHOUT_AI_COPY.revenuePerMonthLabel}
                helper={WITHOUT_AI_COPY.revenuePerMonthHelper}
                tooltip={ROI_TOOLTIPS.revenuePerMonthField}
                value={draft.revenuePerMonth}
                onChange={setField('revenuePerMonth')}
                numeric
              />
            </div>

            {saveError && (
              <p className='text-[11.5px] text-mf-red'>{saveError}</p>
            )}

            <div className='flex items-center gap-2'>
              <button
                type='button'
                onClick={commit}
                disabled={saving}
                className={BUTTON_CLASS}
              >
                {WITHOUT_AI_COPY.saveLabel}
              </button>
              <Hover tooltip={ROI_TOOLTIPS.saveYourNumbers} />
              <button
                type='button'
                onClick={() => setOpen(false)}
                className={BUTTON_CLASS}
              >
                {WITHOUT_AI_COPY.closeLabel}
              </button>
              <Hover tooltip={ROI_TOOLTIPS.closeFields} />
            </div>
          </div>
        )}

        <div className='flex flex-wrap items-center gap-2 border-t border-mf-bd2 pt-3'>
          <BoardReadyExportButton disabled={saving || !goalsRead} />
          <Hover tooltip={ROI_TOOLTIPS.printReportAgain} />
          {saved && <span className={NOTE}>{WITHOUT_AI_COPY.savedLabel}</span>}
        </div>
      </div>
    </section>
  )
}

/** The method sits in the estimate column's header because it is how that
 * whole column was arrived at; the Revenue row keeps its own note, because
 * pro-rating a monthly figure is not the cost method. */
function ComparisonTable({
  block,
}: {
  block: Extract<WithoutAiBlock, { kind: 'comparison' }>
}) {
  return (
    <div className='overflow-x-auto'>
      <table className='w-full border-collapse'>
        <thead>
          <tr>
            <th className={TABLE_HEADER_CELL} />
            <th className={TABLE_HEADER_CELL}>
              <span
                className={`${TABLE_HEADER_LABEL} inline-flex items-center gap-1`}
              >
                {WITHOUT_AI_COPY.withAiLabel}
                <Hover tooltip={ROI_TOOLTIPS.withAiMeasured} />
              </span>
            </th>
            <th className={TABLE_HEADER_CELL}>
              <span
                className={`${TABLE_HEADER_LABEL} inline-flex items-center gap-1`}
              >
                {WITHOUT_AI_COPY.withoutAiLabel}
                <Hover tooltip={ROI_TOOLTIPS.withoutAiEstimate} />
              </span>
              {block.cost.note && (
                <span className={TABLE_SUB_CELL}>{block.cost.note}</span>
              )}
            </th>
            <th className={TABLE_HEADER_CELL}>
              <span
                className={`${TABLE_HEADER_LABEL} inline-flex items-center gap-1`}
              >
                {WITHOUT_AI_COPY.differenceLabel}
                <Hover tooltip={ROI_TOOLTIPS.comparisonDifference} />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <ComparisonTableRow
            row={block.cost}
            numbers={block.numbers.cost}
            tooltip={ROI_TOOLTIPS.comparisonCostRow}
          />
          <ComparisonTableRow
            row={block.revenue}
            numbers={block.numbers.revenue}
            tooltip={ROI_TOOLTIPS.comparisonRevenueRow}
            withAiTooltip={ROI_TOOLTIPS.comparisonRevenueWithAi}
            withoutAiTooltip={ROI_TOOLTIPS.comparisonRevenueWithoutAi}
            differenceTooltip={ROI_TOOLTIPS.comparisonRevenueDifference}
            showNote
          />
        </tbody>
      </table>
    </div>
  )
}

/** The cell hovers are optional: the Cost row takes the column headers'. The
 * Revenue row overrides them, because its without-AI side is often an
 * assumption we made and the header says nothing about that. */
function ComparisonTableRow({
  row,
  numbers,
  tooltip,
  withAiTooltip,
  withoutAiTooltip,
  differenceTooltip,
  showNote,
}: {
  row: WithoutAiRow
  numbers: WithoutAiStampedRow
  tooltip: RoiTooltip
  withAiTooltip?: RoiTooltip
  withoutAiTooltip?: RoiTooltip
  differenceTooltip?: RoiTooltip
  showNote?: boolean
}) {
  return (
    <tr className='border-t border-mf-bd2'>
      <th scope='row' className={TABLE_ROW_LABEL}>
        <span className='inline-flex items-center gap-1'>
          {row.heading}
          <Hover tooltip={tooltip} />
        </span>
      </th>
      <td className={TABLE_CELL}>
        <span className='inline-flex items-center gap-1'>
          {row.withAi}
          {withAiTooltip && <Hover tooltip={withAiTooltip} />}
        </span>
      </td>
      <td className={TABLE_CELL}>
        <span className='inline-flex items-center gap-1'>
          {row.withoutAi}
          {withoutAiTooltip && <Hover tooltip={withoutAiTooltip} />}
        </span>
        {showNote && row.note && (
          <span className={TABLE_SUB_CELL}>{row.note}</span>
        )}
      </td>
      <td className={TABLE_CELL}>
        <span className='inline-flex items-center gap-1'>
          {comparisonDifferenceCell(numbers)}
          {differenceTooltip && <Hover tooltip={differenceTooltip} />}
        </span>
      </td>
    </tr>
  )
}

/** One info icon, from one record. Every ROI hover goes through this so the
 * icon size, the focus ring and the accessible name cannot differ by call
 * site. */
function Hover({ tooltip }: { tooltip: RoiTooltip }) {
  return (
    <InfoTooltip
      title={tooltip.title}
      description={tooltip.description}
      details={tooltip.details}
      iconSize='h-3 w-3'
    />
  )
}

function Field({
  className,
  label,
  helper,
  tooltip,
  value,
  onChange,
  numeric,
  wholeNumber,
  disabled,
}: {
  className: string
  label: string
  helper?: string
  tooltip?: RoiTooltip
  value: string
  onChange: (value: string) => void
  numeric?: boolean
  wholeNumber?: boolean
  disabled?: boolean
}) {
  // A label's control is the first labelable element inside it and the tooltip
  // is a real button, so wrapping would leave the one field that has a tooltip
  // with no accessible name. htmlFor names the control instead.
  const inputId = useId()
  return (
    <div className={`${className} ${FIELD_CLASS}`}>
      <span className={`${LABEL_CLASS} flex items-center gap-1`}>
        <label htmlFor={inputId}>{label}</label>
        {tooltip && <Hover tooltip={tooltip} />}
      </span>
      <input
        id={inputId}
        type={numeric ? 'number' : 'text'}
        step={numeric ? (wholeNumber ? '1' : 'any') : undefined}
        min={numeric ? 0 : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
      {helper && <span className={NOTE}>{helper}</span>}
    </div>
  )
}
