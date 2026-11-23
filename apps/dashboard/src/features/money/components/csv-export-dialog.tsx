'use client'

/**
 * The Money "Custom CSV export…" options dialog: export the breakdown
 * table as CSV by group, timeframe and the numbers you pick. It sits beside
 * the one-click XLSX at /api/export/breakdown.
 *
 * Every number in the downloaded CSV comes from the SAME resolver call the
 * on-screen Breakdown table/donut read via DimensionedSection — this
 * component itself never imports or calls that resolver directly (this
 * feature's no-direct-resolver test enforces that across every file in
 * src/features/money/**). It only collects options and asks the server
 * (app/api/export/breakdown's `?format=csv` branch) to run that same call.
 */
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import {
  DIMENSION_LABELS,
  GROUP_BY_DIMENSIONS,
  type Dimension,
} from '@/lib/component-catalog'
import {
  revenueBasisForDimension,
  revenueColumnLabel,
} from '@/lib/revenue-basis'
import { downloadBreakdownCsv } from '@/features/dashboard-shell/command-center-shared'
import {
  BREAKDOWN_CSV_COLUMN_LABELS,
  columnsAvailableForBasis,
  type BreakdownCsvColumn,
} from './csv-columns'

export interface CsvExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The Money page's CURRENT window (Month / Last 30 days / Custom) — the
   * dialog's "Current view" timeframe option, so a user who never touches
   * the timeframe control gets exactly what's on screen right now. */
  defaultPeriod: { startDate?: string; endDate?: string }
}

const MONEY_DIMENSIONS = GROUP_BY_DIMENSIONS.money
const ALL_COLUMNS: BreakdownCsvColumn[] = [
  'tasks',
  'cost',
  'revenue',
  'margin',
  'marginPercent',
]

export function CsvExportDialog({
  open,
  onOpenChange,
  defaultPeriod,
}: CsvExportDialogProps) {
  // Kept in local state (not reset on close — the dialog stays mounted, only
  // its visibility toggles) so a user's picks persist for the rest of the
  // page visit.
  const [dimension, setDimension] = useState<Dimension>('customer')
  const [timeframeMode, setTimeframeMode] = useState<'current' | 'custom'>(
    'current'
  )
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [columns, setColumns] = useState<Set<BreakdownCsvColumn>>(
    () => new Set(ALL_COLUMNS)
  )
  const [isExporting, setIsExporting] = useState(false)

  const basis = revenueBasisForDimension(dimension)
  const availableColumns = columnsAvailableForBasis(basis)

  const toggleColumn = (column: BreakdownCsvColumn) => {
    setColumns((current) => {
      const next = new Set(current)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }

  const customRangeIncomplete =
    timeframeMode === 'custom' && (!customStart || !customEnd)

  const handleExport = async () => {
    if (customRangeIncomplete) return
    setIsExporting(true)
    try {
      const period =
        timeframeMode === 'custom'
          ? { startDate: customStart, endDate: customEnd }
          : defaultPeriod
      const result = await downloadBreakdownCsv({
        dimension,
        startDate: period.startDate,
        endDate: period.endDate,
        columns: availableColumns.filter((column) => columns.has(column)),
      })
      if (result.ok) {
        onOpenChange(false)
      } else {
        toast({
          title: "Couldn't export the CSV",
          description: result.error,
          variant: 'destructive',
        })
      }
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>Custom CSV export</DialogTitle>
          <DialogDescription>
            Pick what you want in the file. The numbers come straight from the
            Breakdown table above, so this always matches what you see on
            screen.
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          <div>
            <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              Group by
            </p>
            <div
              role='group'
              aria-label='Group by'
              className='flex flex-wrap gap-1 rounded-md bg-muted/50 p-1'
            >
              {MONEY_DIMENSIONS.map((option) => (
                <button
                  key={option}
                  type='button'
                  aria-pressed={option === dimension}
                  onClick={() => setDimension(option)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium',
                    option === dimension
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {DIMENSION_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              Timeframe
            </p>
            <div className='space-y-2'>
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='radio'
                  name='csv-export-timeframe'
                  checked={timeframeMode === 'current'}
                  onChange={() => setTimeframeMode('current')}
                />
                Current view
              </label>
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='radio'
                  name='csv-export-timeframe'
                  checked={timeframeMode === 'custom'}
                  onChange={() => setTimeframeMode('custom')}
                />
                Custom range
              </label>
              {timeframeMode === 'custom' && (
                <div className='ml-6 flex items-center gap-2'>
                  <input
                    type='date'
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className='rounded-md border border-input bg-background px-2 py-1 text-sm'
                    aria-label='Start date'
                  />
                  <span className='text-xs text-muted-foreground'>to</span>
                  <input
                    type='date'
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className='rounded-md border border-input bg-background px-2 py-1 text-sm'
                    aria-label='End date'
                  />
                </div>
              )}
            </div>
          </div>

          <div>
            <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              Columns
            </p>
            <div className='space-y-1.5'>
              <p className='text-xs text-muted-foreground'>
                Account (always included)
              </p>
              {availableColumns.map((column) => (
                <label key={column} className='flex items-center gap-2 text-sm'>
                  <Checkbox
                    checked={columns.has(column)}
                    onCheckedChange={() => toggleColumn(column)}
                  />
                  {column === 'revenue' && basis
                    ? revenueColumnLabel(basis)
                    : BREAKDOWN_CSV_COLUMN_LABELS[
                        column as Exclude<BreakdownCsvColumn, 'revenue'>
                      ]}
                </label>
              ))}
              {basis === null && (
                <p className='text-xs text-muted-foreground'>
                  No honest per-{DIMENSION_LABELS[dimension].toLowerCase()}{' '}
                  revenue exists yet, so Revenue and Margin aren&apos;t offered
                  for this group-by.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={isExporting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={isExporting || customRangeIncomplete}
          >
            {isExporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
