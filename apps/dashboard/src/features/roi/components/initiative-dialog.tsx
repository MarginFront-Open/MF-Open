'use client'

/**
 * The create/edit initiative
 * dialog. One component, two modes.
 *
 * THE REPLACE-ALL CONTRACT: setInitiativeTargets
 * replaces the initiative's ENTIRE target set, so edit mode pre-fills every
 * existing target's fields — including the baseline — and submits the full
 * desired state. Every submitted row always carries baselineValue AND
 * baselineSource (resolveBaselineSubmission returns both, always); an edit
 * that silently erases a stored baseline is impossible through this UI
 * (pinned by the page-composition source-asserts).
 *
 * STARTING VALUES: measured server-side on
 * save; the field is an optional override inside the "Adjust
 * starting value" disclosure. resolveBaselineSubmission (pure, node-tested)
 * decides what each row submits.
 *
 * Dates are <input type='date'> bare YYYY-MM-DD — the exact shape the
 * actions' Zod accepts and the roi-crud-roundtrip integration test proves end to end;
 * prefill slices the full-ISO strings getInitiatives returns back to
 * date-only. Display round-trip alone does not make the WINDOW right: the
 * stored midnight endDate must be re-sliced to a bare date before
 * parseWindowFilter or the final day's money is excluded — the shared
 * initiative-actuals composition owns that.
 */

import { useEffect, useRef, useState } from 'react'
import {
  createInitiative,
  previewAutoBaselines,
  setInitiativeTargets,
  updateInitiative,
  type InitiativeBaselineSource,
  type InitiativeMetric,
  type InitiativeTargetDirection,
} from '@/app/actions/initiatives'
import { getMatters, type MatterRow } from '@/app/actions/matters'
import type { RoiInitiativeView } from '@/app/actions/roi-overview'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  INITIATIVE_METRIC_META,
  SCOPE_HELPER_COPY,
  SCOPE_SUMMARY_COPY,
  baselineLabel,
} from '../progress-derivation'
import { METRIC_DESCRIPTIONS, METRIC_EXAMPLE_COPY } from '../report-derivation'
import { notifyRoiTour } from '../tour/tour-events'
import {
  METRIC_EXAMPLES_READ_FAILED,
  metricExampleLine,
  metricExamplesState,
  type MetricExamplesState,
} from '../metric-examples-state'
import { getRoiMetricExamples } from '@/app/actions/roi-report'
import {
  AUTO_BASELINE_SUPPORTED,
  resolveBaselineSubmission,
} from '../baseline-derivation'

const LABEL_CLASS = 'text-[11px] font-medium text-mf-tx2'
const INPUT_CLASS =
  'h-8 w-full rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2 text-[12px] text-mf-tx'
// py-1 leading-none override @tailwindcss/forms' padding and the global
// `select { line-height: 1.5 }` rule (src/index.css) that clip this
// control's text otherwise. date-range-selector.tsx does the same.
const SELECT_CLASS = cn(INPUT_CLASS, 'py-1 leading-none')
const SEGMENT_CLASS =
  'h-8 flex-1 px-2 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
const SEGMENT_ACTIVE_CLASS = 'bg-mf-card2 font-semibold text-mf-tx'
const HELPER_CLASS = 'text-[11.5px] text-mf-tx3'
// ONE spacing rhythm for the whole dialog: gap-3 between blocks, gap-1 inside a field
// (label → control → helper). No other vertical gaps.
const FIELD_CLASS = 'flex flex-col gap-1'

/** Target/Starting-value affix, derived from INITIATIVE_METRIC_META's format
 * bucket — no separate user choice. */
function metricAffix(metric: InitiativeMetric): {
  prefix: string
  suffix: string
} {
  const { format } = INITIATIVE_METRIC_META[metric]
  if (format === 'cost') return { prefix: '$', suffix: '' }
  if (format === 'pct') return { prefix: '', suffix: '%' }
  return { prefix: '', suffix: '' }
}

function AffixedNumberInput({
  metric,
  value,
  onChange,
}: {
  metric: InitiativeMetric
  value: string
  onChange: (value: string) => void
}) {
  const { prefix, suffix } = metricAffix(metric)
  return (
    <div className='relative'>
      {prefix && (
        <span className='pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-mf-tx3'>
          {prefix}
        </span>
      )}
      <input
        type='number'
        step='any'
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(INPUT_CLASS, prefix && 'pl-5', suffix && 'pr-6')}
      />
      {suffix && (
        <span className='pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-mf-tx3'>
          {suffix}
        </span>
      )}
    </div>
  )
}

type BaselinePreviewState =
  | 'idle'
  | 'loading'
  | 'nodata'
  | 'unavailable'
  | 'needs-date'
  | 'error'

interface TargetRow {
  /** Existing target id in edit mode; null for a fresh create-mode row. */
  id: string | null
  metric: InitiativeMetric
  direction: InitiativeTargetDirection
  targetValue: string
  baselineValue: string
  /** The stored baseline/source on the target being edited — what an
   * untouched row carries forward (resolveBaselineSubmission's inputs). */
  storedBaseline: number | null
  storedSource: InitiativeBaselineSource | null
  /** True once the user typed in the starting-value field this session. */
  baselineTouched: boolean
  baselineOpen: boolean
  baselinePreview: BaselinePreviewState
}

const EMPTY_ROW: TargetRow = {
  id: null,
  metric: 'cost',
  direction: 'lte',
  targetValue: '',
  baselineValue: '',
  storedBaseline: null,
  storedSource: null,
  baselineTouched: false,
  baselineOpen: false,
  baselinePreview: 'idle',
}

/**
 * The direction that pre-selects when a metric is picked (user can still flip
 * it). TOTAL over InitiativeMetric on purpose — growing the union without
 * choosing a default is a compile error (the INITIATIVE_METRIC_META pattern).
 */
const DEFAULT_DIRECTION: Record<InitiativeMetric, InitiativeTargetDirection> = {
  cost: 'lte',
  revenue: 'gte',
  margin: 'gte',
  marginPercent: 'gte',
  costPerTask: 'lte',
  eventCount: 'gte',
  unmappedCount: 'lte',
  mrr: 'gte',
  arr: 'gte',
  newCustomers: 'gte',
  internalCost: 'lte',
  externalCost: 'lte',
}

/** The field's one name, shared with the goal page, or a customer types into
 * "Starting value" and finds the number under "Last window" once they save. */
function baselineFieldLabel(row: TargetRow, endDate: string): string {
  return baselineLabel(row.metric, endDate === '' ? null : endDate)
}

function baselineHelperCopy(row: TargetRow): string {
  switch (row.baselinePreview) {
    case 'loading':
      return 'Measuring from your data...'
    case 'nodata':
      return 'We looked at your data from before the start date and found nothing to measure. Type this number in if you know it, or leave it blank.'
    case 'unavailable':
      return "We can't measure this metric as of a past date yet. Type this number in if you know it."
    case 'needs-date':
      return "Pick a start date first and we'll measure this from your data."
    case 'error':
      return "We couldn't measure this right now. Leave it blank and we'll measure it when you save, or type your own."
    default:
      if (row.baselineTouched && row.baselineValue.trim() !== '') {
        return "Your override. We'll use this instead of the measured value."
      }
      if (row.baselineTouched) {
        return "Cleared. We'll measure a fresh one from your data when you save."
      }
      if (
        row.storedSource === 'manual' ||
        (row.storedSource === null && row.storedBaseline !== null)
      ) {
        return "You set this by hand. Clear it and we'll measure one from your data when you save."
      }
      return 'Measured from your data over the matching period right before your start date. Override it only if you know better.'
  }
}

export interface InitiativeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode; a view = edit mode, pre-filled from it. */
  initiative: RoiInitiativeView | null
  /** Fired after any successful write so the page re-fetches. */
  onSaved: () => void
}

export function InitiativeDialog({
  open,
  onOpenChange,
  initiative,
  onSaved,
}: InitiativeDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rows, setRows] = useState<TargetRow[]>([EMPTY_ROW])
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // '' is the whole-organization option (a select can't hold null).
  const [matterId, setMatterId] = useState('')
  const [matterOpen, setMatterOpen] = useState(false)
  const [matters, setMatters] = useState<MatterRow[]>([])

  // A ref rather than a state flag: two openings in the same
  // tick would both see an unset state and fire the read twice.
  const examplesRequested = useRef(false)
  const [examples, setExamples] = useState<MetricExamplesState>({
    status: 'loading',
  })
  const [exampleRows, setExampleRows] = useState<number[]>([])

  useEffect(() => {
    if (!open) return
    if (initiative) {
      setName(initiative.name)
      setDescription(initiative.description ?? '')
      setMatterId(initiative.matterId ?? '')
      setMatterOpen(initiative.matterId !== null)
      setStartDate(initiative.startDate.slice(0, 10))
      setEndDate(initiative.endDate ? initiative.endDate.slice(0, 10) : '')
      // Replace-all prefill: EVERY existing target becomes a row, baseline
      // included — a zero-target initiative seeds one blank row so a target
      // can be added.
      setRows(
        initiative.targets.length > 0
          ? initiative.targets.map((t) => ({
              id: t.id,
              metric: t.metric,
              direction: t.direction,
              targetValue: String(t.targetValue),
              baselineValue: t.baseline === null ? '' : String(t.baseline),
              storedBaseline: t.baseline,
              storedSource: t.baselineSource,
              baselineTouched: false,
              baselineOpen: false,
              baselinePreview: 'idle' as const,
            }))
          : [EMPTY_ROW]
      )
    } else {
      setName('')
      setDescription('')
      setMatterId('')
      setMatterOpen(false)
      setStartDate('')
      setEndDate('')
      setRows([EMPTY_ROW])
    }
    setFormError(null)
    // These indexes belong to the goal that was open, not the next one.
    setExampleRows([])
  }, [open, initiative])

  // No cleanup on purpose: the read fires once per session, so discarding a
  // late answer would hide the button for the life of the page.
  useEffect(() => {
    if (!open || examplesRequested.current) return
    examplesRequested.current = true
    void (async () => {
      try {
        // No dates: the default window is the last 30 days.
        const result = await getRoiMetricExamples({})
        setExamples(metricExamplesState(result))
      } catch {
        setExamples(METRIC_EXAMPLES_READ_FAILED)
      }
    })()
  }, [open])

  // The Law tab's own read, not a second source. MANAGE_MONEY_ROLES is a
  // subset of LAW_MANAGE_ROLES, so every dialog user may read it; a refusal
  // returns [] and the field stays hidden.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getMatters().then((rows) => {
      if (!cancelled) setMatters(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const updateRow = (index: number, patch: Partial<TargetRow>) => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  }

  const toggleExample = (index: number) => {
    setExampleRows((prev) =>
      prev.includes(index)
        ? prev.filter((row) => row !== index)
        : [...prev, index]
    )
  }

  const exampleLine = (metric: InitiativeMetric): string =>
    metricExampleLine(examples, metric)

  const startDateChanged = initiative
    ? startDate !== initiative.startDate.slice(0, 10)
    : false

  // A value measured under the old scope is not a starting value
  // for the new one, so moving the scope invalidates it like a moved date.
  const scopeChanged = initiative
    ? (initiative.matterId ?? '') !== matterId
    : false

  // Every argument is passed in rather than read off state: these fire from
  // onChange handlers whose setState has not applied yet, so a closure over
  // `matterId` or the dates would measure against the PREVIOUS scope.
  const fetchBaselinePreview = async (
    index: number,
    metric: InitiativeMetric,
    startDateArg: string,
    endDateArg: string,
    matterIdArg: string
  ) => {
    if (!AUTO_BASELINE_SUPPORTED[metric]) {
      updateRow(index, { baselinePreview: 'unavailable' })
      return
    }
    if (!startDateArg) {
      updateRow(index, { baselinePreview: 'needs-date' })
      return
    }
    updateRow(index, { baselinePreview: 'loading' })
    const result = await previewAutoBaselines({
      startDate: startDateArg,
      endDate: endDateArg === '' ? null : endDateArg,
      metrics: [metric],
      matterId: matterIdArg === '' ? null : matterIdArg,
    })
    setRows((prev) =>
      prev.map((row, i) => {
        // The row may have changed while the measurement ran — apply only
        // when it's still the same metric and the user hasn't typed.
        if (i !== index || row.metric !== metric || row.baselineTouched) {
          return row
        }
        if (!result.success || !result.data) {
          return { ...row, baselinePreview: 'error' as const }
        }
        const measured = result.data[0]?.baseline ?? null
        return {
          ...row,
          baselineValue: measured === null ? '' : String(measured),
          baselinePreview:
            measured === null ? ('nodata' as const) : ('idle' as const),
        }
      })
    )
  }

  const handleToggleBaseline = (index: number) => {
    const row = rows[index]
    if (!row) return
    const opening = !row.baselineOpen
    updateRow(index, { baselineOpen: opening })
    if (!opening) return
    const shouldMeasure =
      !row.baselineTouched &&
      (row.baselineValue.trim() === '' ||
        (row.storedSource === 'auto' && (startDateChanged || scopeChanged)))
    if (shouldMeasure) {
      void fetchBaselinePreview(index, row.metric, startDate, endDate, matterId)
    }
  }

  const refreshOpenPreviews = (
    nextStartDate: string,
    nextEndDate: string,
    nextMatterId: string
  ) => {
    rows.forEach((row, index) => {
      if (row.baselineOpen && !row.baselineTouched) {
        void fetchBaselinePreview(
          index,
          row.metric,
          nextStartDate,
          nextEndDate,
          nextMatterId
        )
      }
    })
  }

  const handleStartDateChange = (value: string) => {
    setStartDate(value)
    refreshOpenPreviews(value, endDate, matterId)
  }

  const handleEndDateChange = (value: string) => {
    setEndDate(value)
    refreshOpenPreviews(startDate, value, matterId)
  }

  const handleMatterChange = (value: string) => {
    setMatterId(value)
    refreshOpenPreviews(startDate, endDate, value)
  }

  const handleMetricChange = (index: number, metric: InitiativeMetric) => {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row
        // A new metric makes the old starting value meaningless — reset the
        // baseline state so save measures fresh.
        const base = {
          ...row,
          metric,
          baselineValue: '',
          storedBaseline: null,
          storedSource: null,
          baselineTouched: false,
          baselinePreview: 'idle' as const,
        }
        // UI default: an unmapped-GL goal is "get to zero" — lte/target 0.
        if (metric === 'unmappedCount') {
          return {
            ...base,
            direction: 'lte',
            targetValue: row.targetValue === '' ? '0' : row.targetValue,
          }
        }
        return { ...base, direction: DEFAULT_DIRECTION[metric] }
      })
    )
    const row = rows[index]
    if (row?.baselineOpen) {
      void fetchBaselinePreview(index, metric, startDate, endDate, matterId)
    }
  }

  const fail = (title: string, error: string | undefined) => {
    const message =
      error ?? 'The request failed before it reached the server. Try again.'
    setFormError(message)
    toast({ title, description: message, variant: 'destructive' })
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      setFormError('Name is required')
      return
    }
    if (!startDate) {
      setFormError('Start date is required')
      return
    }
    for (const row of rows) {
      if (
        row.targetValue.trim() === '' ||
        !Number.isFinite(Number(row.targetValue))
      ) {
        setFormError('Each target needs a numeric target value')
        return
      }
      if (
        row.baselineValue.trim() !== '' &&
        !Number.isFinite(Number(row.baselineValue))
      ) {
        setFormError(
          `${baselineFieldLabel(row, endDate)} must be a number, or leave it blank`
        )
        return
      }
    }

    // The FULL desired target set — every row always carries baselineValue
    // AND baselineSource (replace-all contract: a payload missing either
    // field would silently erase stored baselines on every edit).
    // resolveBaselineSubmission is the pure, node-tested rule: typed =
    // manual override, cleared/fresh = the server measures on save,
    // untouched auto = carried forward unless the start date moved.
    const targetsPayload = rows.map((row) => {
      const baseline = resolveBaselineSubmission({
        fieldValue: row.baselineValue.trim(),
        touched: row.baselineTouched,
        storedValue: row.storedBaseline,
        storedSource: row.storedSource,
        startDateChanged,
        scopeChanged,
        isEdit: initiative !== null,
      })
      return {
        metric: row.metric,
        targetValue: Number(row.targetValue),
        baselineValue: baseline.baselineValue,
        baselineSource: baseline.baselineSource,
        direction: row.direction,
      }
    })

    setPending(true)
    let createdId: string | null = null
    try {
      if (initiative) {
        const updated = await updateInitiative(initiative.id, {
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          startDate,
          endDate: endDate === '' ? null : endDate,
          matterId: matterId === '' ? null : matterId,
        })
        if (!updated.success) {
          fail("Couldn't save the goal", updated.error)
          return
        }
        const savedTargets = await setInitiativeTargets(
          initiative.id,
          targetsPayload
        )
        if (!savedTargets.success) {
          // The initiative fields saved but the targets didn't — refresh so
          // the page shows the real state, and keep the dialog open.
          fail("Couldn't save the goal's targets", savedTargets.error)
          onSaved()
          return
        }
        toast({
          title: 'Goal saved',
          description: `${name.trim()} was updated. Progress updates as new events land. Check the card on this page, or export the board-ready view.`,
        })
      } else {
        const created = await createInitiative({
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          startDate,
          endDate: endDate === '' ? null : endDate,
          matterId: matterId === '' ? null : matterId,
        })
        if (!created.success || !created.data) {
          fail("Couldn't create the goal", created.error)
          return
        }
        createdId = created.data.id
        const savedTargets = await setInitiativeTargets(
          created.data.id,
          targetsPayload
        )
        if (!savedTargets.success) {
          // The initiative exists but its target didn't save — refresh so
          // the new (no-data) card appears, and keep the dialog open.
          fail(
            'The goal was created, but its target failed to save',
            savedTargets.error
          )
          onSaved()
          return
        }
        toast({
          title: 'Goal created',
          description: `${name.trim()} is now tracked against your real numbers. Progress updates as new events land. Check the card on this page, or export the board-ready view.`,
        })
      }
      onOpenChange(false)
      onSaved()
      if (createdId)
        notifyRoiTour({ kind: 'goal-created', initiativeId: createdId })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className='flex max-h-[85vh] flex-col gap-4 overflow-hidden border-mf-bd bg-mf-card sm:max-w-[440px]'>
        <DialogHeader>
          <DialogTitle className='text-[14px] font-semibold text-mf-tx'>
            {initiative ? 'Edit goal' : 'New goal'}
          </DialogTitle>
          <DialogDescription className={HELPER_CLASS}>
            Pick a goal and set a target, and progress is tracked automatically
            from your real usage, cost, and revenue data, so you never update it
            by hand.
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-1 flex-col gap-3 overflow-y-auto pr-1'>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>Name</span>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLASS}
              placeholder='Cut agent spend this quarter'
            />
            <p className={HELPER_CLASS}>
              Appears as the headline on this card and in the board-ready
              export.
            </p>
          </label>

          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className='w-full rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2 py-1.5 text-[12px] text-mf-tx'
            />
          </label>

          <div className={FIELD_CLASS}>
            <div className='grid grid-cols-2 gap-3'>
              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>Start date</span>
                <input
                  type='date'
                  value={startDate}
                  onChange={(e) => handleStartDateChange(e.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>End date (optional)</span>
                <input
                  type='date'
                  value={endDate}
                  onChange={(e) => handleEndDateChange(e.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
            </div>
            <p className={HELPER_CLASS}>
              This is the window we measure. Leave the end date blank for an
              ongoing goal.
            </p>
          </div>

          {rows.map((row, index) => (
            <div
              key={row.id ?? `new-${index}`}
              className='bg-mf-card2/40 flex flex-col gap-3 rounded-mf-card border border-mf-bd p-3'
            >
              <div className={FIELD_CLASS}>
                <label className={FIELD_CLASS}>
                  <span className={LABEL_CLASS}>Metric</span>
                  <select
                    value={row.metric}
                    onChange={(e) =>
                      handleMetricChange(
                        index,
                        e.target.value as InitiativeMetric
                      )
                    }
                    className={SELECT_CLASS}
                  >
                    {(
                      Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[]
                    ).map((metric) => (
                      <option key={metric} value={metric}>
                        {INITIATIVE_METRIC_META[metric].label}
                      </option>
                    ))}
                  </select>
                  <p className={HELPER_CLASS}>
                    {METRIC_DESCRIPTIONS[row.metric]}
                  </p>
                </label>
                {/* Absent, not disabled, while the read is in flight. */}
                {examples.status !== 'loading' && (
                  <button
                    type='button'
                    onClick={() => toggleExample(index)}
                    className='self-start text-[11px] font-medium text-mf-tx3 hover:text-mf-tx'
                  >
                    {exampleRows.includes(index)
                      ? METRIC_EXAMPLE_COPY.hideLabel
                      : METRIC_EXAMPLE_COPY.buttonLabel}
                  </button>
                )}
                {exampleRows.includes(index) && (
                  <p className={HELPER_CLASS}>{exampleLine(row.metric)}</p>
                )}
              </div>

              <div className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>Direction</span>
                <div className='flex overflow-hidden rounded-mf-seg-item border border-mf-bd'>
                  <button
                    type='button'
                    onClick={() => updateRow(index, { direction: 'lte' })}
                    className={cn(
                      SEGMENT_CLASS,
                      row.direction === 'lte' && SEGMENT_ACTIVE_CLASS
                    )}
                  >
                    Keep under
                  </button>
                  <button
                    type='button'
                    onClick={() => updateRow(index, { direction: 'gte' })}
                    className={cn(
                      SEGMENT_CLASS,
                      row.direction === 'gte' && SEGMENT_ACTIVE_CLASS
                    )}
                  >
                    Reach at least
                  </button>
                </div>
              </div>

              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>Target value</span>
                <AffixedNumberInput
                  metric={row.metric}
                  value={row.targetValue}
                  onChange={(value) => updateRow(index, { targetValue: value })}
                />
                <p className={HELPER_CLASS}>
                  The goal you are aiming for. Your card compares it to the
                  real, current number automatically.
                </p>
              </label>

              <div className={FIELD_CLASS}>
                <button
                  type='button'
                  onClick={() => handleToggleBaseline(index)}
                  className='self-start text-[11px] font-medium text-mf-tx3 hover:text-mf-tx'
                >
                  {`${row.baselineOpen ? 'Hide' : 'Adjust'} ${baselineFieldLabel(
                    row,
                    endDate
                  ).toLowerCase()}`}
                </button>
                {row.baselineOpen && (
                  <label className={FIELD_CLASS}>
                    <span className={LABEL_CLASS}>
                      {baselineFieldLabel(row, endDate)}
                    </span>
                    <AffixedNumberInput
                      metric={row.metric}
                      value={row.baselineValue}
                      onChange={(value) =>
                        updateRow(index, {
                          baselineValue: value,
                          baselineTouched: true,
                          baselinePreview: 'idle',
                        })
                      }
                    />
                    <p className={HELPER_CLASS}>{baselineHelperCopy(row)}</p>
                  </label>
                )}
              </div>
            </div>
          ))}

          {matters.length > 0 && (
            <details
              open={matterOpen}
              className={FIELD_CLASS}
              onToggle={(e) => {
                const open = e.currentTarget.open
                setMatterOpen(open)
                if (open) e.currentTarget.scrollIntoView({ block: 'nearest' })
              }}
            >
              <summary className='cursor-pointer self-start text-[11px] font-medium text-mf-tx3 hover:text-mf-tx'>
                {SCOPE_SUMMARY_COPY}
              </summary>
              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>Scope</span>
                <select
                  value={matterId}
                  onChange={(e) => handleMatterChange(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value=''>Whole organization</option>
                  {matters.map((matter) => (
                    <option key={matter.id} value={matter.id}>
                      {matter.matterNumber} ({matter.name})
                    </option>
                  ))}
                </select>
                <p className={HELPER_CLASS}>{SCOPE_HELPER_COPY}</p>
              </label>
            </details>
          )}

          {formError && (
            <p className='text-[11.5px] text-mf-red'>{formError}</p>
          )}
        </div>

        <DialogFooter>
          <button
            type='button'
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className='h-7 rounded-mf-seg-item px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:opacity-50'
          >
            Cancel
          </button>
          <button
            type='button'
            onClick={handleSubmit}
            disabled={pending}
            className={cn(
              'h-7 rounded-mf-seg-item bg-mf-accent px-2.5 text-[11.5px] font-semibold text-white',
              pending && 'opacity-50'
            )}
          >
            {pending ? 'Saving...' : initiative ? 'Save goal' : 'Create goal'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
