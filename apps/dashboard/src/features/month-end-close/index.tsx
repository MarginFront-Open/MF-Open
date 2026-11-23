'use client'

/**
 * Month-End Close — the accountant's billing-period view. Pick a month and see, for that period: the coverage
 * score, AI cost split across the full P&L taxonomy, the journal entries by
 * GL code, and margin by product line — then export the summary, journal, or
 * detail/audit CSV.
 *
 * Pure recomposition: every number comes from existing period-aware server
 * actions (getCostClassificationBreakdown, getDefensibilityScore,
 * getJournalExport, getJournalAuditDetail, getProductLineMargins). No cost math
 * lives here — the headline "AI gross margin (classified)" card just renders
 * the value the action computes (revenue minus classified COGS; uncategorized
 * spend is its own line, called out, never folded in). Clicking any journal
 * row opens a drill-through with the signals + events behind that GL line.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { format } from 'date-fns'
import Link from 'next/link'
import { Download, ChevronRight, Lock, Unlock } from 'lucide-react'
import { Page } from '@/components/layouts/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/canon-format'
import { useToast } from '@/hooks/use-toast'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import {
  getCostClassificationBreakdown,
  type CostClassificationBreakdown,
} from '@/app/actions/cost-command-center'
import {
  getDefensibilityScore,
  type DefensibilityScore,
} from '@/app/actions/finance-metrics'
import {
  getJournalExport,
  getJournalAuditDetail,
  type JournalExport,
  type JournalAuditDetail,
  type AuditGlLine,
} from '@/app/actions/journal-export'
// AUDIT_SOURCE_LABEL lives in a plain leaf module, not journal-export, because a
// 'use server' file may only export async functions.
import { AUDIT_SOURCE_LABEL } from '@/app/actions/_shared/audit-source-label'
import {
  getPeriodLockStatus,
  lockPeriod,
  unlockPeriod,
  type PeriodLockStatus,
} from '@/app/actions/finance-period-lock'
import ProductLineMarginPanel from '@/features/cost-management/components/product-line-margin-panel'
// Calendar-month period math comes from one shared helper so
// Cost Management and Month-End Close can't drift to different windows.
import { MONTH_OPTIONS, monthPeriod } from '@/features/_shared/billing-period'

const CATEGORY_COLOR: Record<string, string> = {
  PRODUCTION_COGS: 'hsl(var(--chart-1))',
  DEVELOPMENT_RD: 'hsl(var(--chart-2))',
  SALES_SM: 'hsl(var(--chart-4))',
  GENERAL_GA: 'hsl(var(--chart-5))',
  INTERNAL_TOOL: 'hsl(var(--chart-3))',
  UNCLASSIFIED: 'hsl(var(--muted-foreground))',
}

// Which P&L line each category books to. COGS sits above the gross-margin
// line; everything else is OpEx below it.
const PL_LINE: Record<string, string> = {
  PRODUCTION_COGS: 'COGS',
  DEVELOPMENT_RD: 'OpEx · R&D',
  SALES_SM: 'OpEx · S&M',
  GENERAL_GA: 'OpEx · G&A',
  INTERNAL_TOOL: 'OpEx · G&A',
  UNCLASSIFIED: 'Unclassified',
}

const pctLabel = (n: number | null): string =>
  n === null ? '—' : `${(n * 100).toFixed(0)}%`

/**
 * Color the coverage score: green ≥90%, amber 70-90%, red <70%.
 *
 * `hasGaps` is the honesty cap. If ANY cost is still
 * unclassified or unmapped, we never paint the number green — an unposted GL
 * line is a categorical gap, not something a 98% can round away. So a 98% with
 * a single dollar uncategorized reads amber, not green. Red is <70%.
 * Why it matters: a green score sitting above amber "still unclassified"
 * warnings overclaims rigor to a finance buyer; the cap keeps the two honest.
 */
function scoreColor(pct: number | null, hasGaps = false): string {
  if (pct === null) return 'hsl(var(--muted-foreground))'
  if (pct >= 90) return hasGaps ? 'hsl(38 92% 50%)' : 'hsl(142 71% 45%)'
  if (pct >= 70) return 'hsl(38 92% 50%)'
  return 'hsl(0 84% 60%)'
}

export default function MonthEndClose() {
  const { toast } = useToast()
  const [monthsAgo, setMonthsAgo] = useState(0)
  const [loading, setLoading] = useState(true)
  const [, startTransition] = useTransition()
  const [breakdown, setBreakdown] =
    useState<CostClassificationBreakdown | null>(null)
  const [score, setScore] = useState<DefensibilityScore | null>(null)
  const [journal, setJournal] = useState<JournalExport | null>(null)

  // Period lock ("the close must close"). When a period is
  // closed, the numbers above are a frozen snapshot, not a live recompute.
  // `refreshKey` is bumped after a close/reopen so the period data + lock status
  // re-fetch. `lockBusy` disables the buttons while a close/reopen is in flight.
  const [lock, setLock] = useState<PeriodLockStatus | null>(null)
  const [lockBusy, setLockBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Drill-through: the full per-line audit trail is fetched lazily
  // the first time the accountant opens a GL row — we don't pull every event on
  // page load. `selectedGlKey` is which GL row's Sheet is open (null = closed).
  const [auditDetail, setAuditDetail] = useState<JournalAuditDetail | null>(
    null
  )
  const [auditLoading, setAuditLoading] = useState(false)
  const [selectedGlKey, setSelectedGlKey] = useState<string | null>(null)
  // Generation token: bumped on every period change so an in-flight drill-through fetch from a previous period can't repopulate stale audit data.
  const auditGenRef = useRef(0)

  // Period bounds + label come from the shared helper — the exact
  // same source Cost Management reads, so the two pages always agree.
  const { startDate, endDate, monthLabel } = useMemo(
    () => monthPeriod(monthsAgo),
    [monthsAgo]
  )

  const filter = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

  useEffect(() => {
    let cancelled = false
    // Period changed: invalidate any in-flight or loaded drill-through trail.
    // Bump the generation so a fetch started for the previous period is
    // discarded when it resolves instead of overwriting this period's
    // trail; clear the audit UI.
    auditGenRef.current += 1
    setAuditDetail(null)
    setSelectedGlKey(null)
    setAuditLoading(false)
    startTransition(async () => {
      setLoading(true)
      try {
        const [b, s, j, lk] = await Promise.all([
          getCostClassificationBreakdown(filter),
          getDefensibilityScore(filter),
          getJournalExport(filter),
          getPeriodLockStatus(filter),
        ])
        if (cancelled) return
        setBreakdown(b)
        setScore(s)
        setJournal(j)
        setLock(lk)
      } catch (err) {
        if (!cancelled) {
          toast({
            title: 'Failed to load month-end close',
            description: (err as Error)?.message ?? 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the filter or refresh key changes
  }, [filter, refreshKey])

  const exportUrl = (fmt: 'summary' | 'journal' | 'detail') =>
    `/api/export/journal?start=${startDate}&end=${endDate}&format=${fmt}`

  // The stable key we use to identify a GL row (the unmapped bucket has a null
  // glCode, so fall back to a sentinel — same idea the table uses for React keys).
  const glRowKey = (glCode: string | null) => glCode ?? '__unmapped'

  /**
   * Open the drill-through for one GL row. Fetches the full audit trail lazily
   * the first time any row is opened (one query for the whole period, reused
   * for every subsequent row this period). We never fire a query per row.
   */
  const openGlDrillThrough = (glCode: string | null) => {
    setSelectedGlKey(glRowKey(glCode))
    if (auditDetail || auditLoading) return // already have it / in flight
    const gen = auditGenRef.current
    setAuditLoading(true)
    startTransition(async () => {
      try {
        const detail = await getJournalAuditDetail(filter)
        // Period switched while this was in flight -> discard the stale result.
        if (gen !== auditGenRef.current) return
        if (detail === null) {
          // Active org / session was lost between page load and this click.
          // Surface it as an error and close the Sheet rather than rendering an
          // empty state that reads like the line genuinely has no source events.
          toast({
            title: 'Could not load the audit trail',
            description:
              'Your session or active organization may have changed. Reload and try again.',
            variant: 'destructive',
          })
          setSelectedGlKey(null)
          return
        }
        setAuditDetail(detail)
      } catch (err) {
        if (gen !== auditGenRef.current) return
        toast({
          title: 'Failed to load audit trail',
          description: (err as Error)?.message ?? 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        if (gen === auditGenRef.current) setAuditLoading(false)
      }
    })
  }

  // The audit line for the currently-open GL row (once the detail has loaded).
  const selectedGlLine: AuditGlLine | null =
    selectedGlKey && auditDetail
      ? (auditDetail.glLines.find(
          (l) => glRowKey(l.glCode) === selectedGlKey
        ) ?? null)
      : null

  // Close the books on this period: freeze the current numbers as the posted
  // snapshot. After this, reclassifying a signal won't change this period.
  const handleClose = () => {
    setLockBusy(true)
    startTransition(async () => {
      try {
        const res = await lockPeriod({
          startDate,
          endDate,
          periodLabel: monthLabel,
        })
        if (res.success) {
          toast({
            title: `Closed ${monthLabel}`,
            description:
              'These numbers are now the posted snapshot. Reclassifying signals won’t change them.',
          })
          setRefreshKey((k) => k + 1)
        } else {
          toast({
            title: 'Could not close the period',
            description: res.error ?? 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        setLockBusy(false)
      }
    })
  }

  // Reopen a closed period: discard the snapshot so the numbers recompute live.
  const handleReopen = () => {
    setLockBusy(true)
    startTransition(async () => {
      try {
        const res = await unlockPeriod({ startDate, endDate })
        if (res.success) {
          toast({
            title: `Reopened ${monthLabel}`,
            description:
              'The posted snapshot was discarded. These numbers will recompute from current data.',
          })
          setRefreshKey((k) => k + 1)
        } else {
          toast({
            title: 'Could not reopen the period',
            description: res.error ?? 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        setLockBusy(false)
      }
    })
  }

  const isLocked = lock?.locked === true

  const totalCost = breakdown?.totalCost ?? 0
  const hasCost = totalCost > 0

  return (
    <Page
      title='Month-End Close'
      description='Close the books on a billing period: AI cost by P&L category, journal entries by GL code, and how complete the cost coverage is.'
      headerProps={{
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Month-End Close' }],
      }}
    >
      {/* Period selector + export actions */}
      <div className='flex flex-col items-stretch justify-between gap-3 pb-4 sm:flex-row sm:items-center'>
        <div className='flex items-center gap-2'>
          <span className='text-sm text-muted-foreground'>Billing period</span>
          <Select
            value={String(monthsAgo)}
            onValueChange={(v) => setMonthsAgo(Number(v))}
          >
            <SelectTrigger className='h-9 w-[180px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_OPTIONS.map((m) => (
                <SelectItem key={m.monthsAgo} value={String(m.monthsAgo)}>
                  {m.label}
                  {m.monthsAgo === 0 ? ' (current)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isLocked && (
            <Badge
              variant='secondary'
              className='gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400'
            >
              <Lock className='h-3 w-3' />
              Closed
            </Badge>
          )}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {/* Close / Reopen the period. Only a past month is
              closable; the current month's button is disabled until it ends. */}
          {lock &&
            (isLocked ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant='outline' size='sm' disabled={lockBusy}>
                    <Unlock className='mr-2 h-4 w-4' />
                    Reopen
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reopen {monthLabel}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The posted snapshot will be discarded and {monthLabel}’s
                      numbers will recompute from current data, so anything you
                      reclassified since closing will move them. Only reopen if
                      you genuinely need to change a posted period.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleReopen}>
                      Reopen period
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : lock.closable ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant='secondary' size='sm' disabled={lockBusy}>
                    <Lock className='mr-2 h-4 w-4' />
                    Close the books
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Close {monthLabel}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This snapshots {monthLabel}’s numbers as the posted close.
                      After this, reclassifying a signal or remapping a GL code
                      won’t change this period’s journal, CSVs, or margin. You
                      can reopen it later if you need to.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClose}>
                      Close the books
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button
                variant='secondary'
                size='sm'
                disabled
                title='You can close this period after the month ends.'
              >
                <Lock className='mr-2 h-4 w-4' />
                Close the books
              </Button>
            ))}
          {/* No `download` attribute: the /api/export/journal route sets
              Content-Disposition: attachment, so the click downloads instead
              of navigating. */}
          <Button variant='outline' size='sm' asChild>
            <a href={exportUrl('summary')}>
              <Download className='mr-2 h-4 w-4' />
              Cost summary CSV
            </a>
          </Button>
          <Button size='sm' asChild>
            <a href={exportUrl('journal')}>
              <Download className='mr-2 h-4 w-4' />
              Journal entries CSV
            </a>
          </Button>
          {/* The drillable audit trail — one row per usage event,
              so every journal line can be traced to its internal source. */}
          <Button variant='outline' size='sm' asChild>
            <a href={exportUrl('detail')}>
              <Download className='mr-2 h-4 w-4' />
              Detail / audit CSV
            </a>
          </Button>
        </div>
      </div>

      {/* Closed-period banner: makes it unmistakable that the numbers below are
          a frozen posted snapshot, not live. */}
      {isLocked && (
        <Card className='mb-4 border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20'>
          <CardHeader className='py-3'>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <Lock className='h-4 w-4' />
              {lock?.periodLabel ?? monthLabel} is closed
            </CardTitle>
            <CardDescription>
              Closed
              {lock?.lockedAt
                ? ` ${format(new Date(lock.lockedAt), 'MMM d, yyyy')}`
                : ''}
              {lock?.lockedByName ? ` by ${lock.lockedByName}` : ''}. The
              numbers below are the posted snapshot. Reclassifying signals or
              remapping GL codes won’t change them. Reopen the period to
              recompute from current data.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {loading ? (
        <div className='space-y-4'>
          <div className='grid gap-4 sm:grid-cols-3'>
            <Skeleton className='h-28 w-full' />
            <Skeleton className='h-28 w-full' />
            <Skeleton className='h-28 w-full' />
          </div>
          <Skeleton className='h-64 w-full' />
          <Skeleton className='h-64 w-full' />
        </div>
      ) : !hasCost ? (
        <Card>
          <CardHeader>
            <CardTitle>No AI cost recorded for {monthLabel}</CardTitle>
            <CardDescription>
              Pick another billing period, or fire some usage from the SDK
              Simulator to see this period populate.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className='space-y-6'>
          {/* Headline cards */}
          <div className='grid gap-4 sm:grid-cols-3'>
            <Card>
              <CardHeader className='pb-2'>
                <CardDescription className='flex items-center gap-1'>
                  Total AI cost · {monthLabel}
                  <InfoTooltip {...tooltipDefinitions.totalCost} />
                </CardDescription>
                <CardTitle className='text-3xl tabular-nums'>
                  {formatCurrency(totalCost)}
                </CardTitle>
              </CardHeader>
              <CardContent className='text-xs text-muted-foreground'>
                Across{' '}
                {journal?.rows.reduce((s, r) => s + r.eventCount, 0) ?? 0}{' '}
                events in the period.
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='pb-2'>
                <CardDescription className='flex items-center gap-1'>
                  AI gross margin (classified)
                  <InfoTooltip
                    {...tooltipDefinitions.aiGrossMarginClassified}
                  />
                </CardDescription>
                <CardTitle className='text-3xl tabular-nums'>
                  {pctLabel(breakdown?.aiGrossMarginPercent ?? null)}
                </CardTitle>
              </CardHeader>
              {/* The {' '} after the amount keeps the space: prettier would rewrite
              it to a bare space, which the build can collapse. Hence the ignore. */}
              {/* prettier-ignore */}
              <CardContent className='text-xs text-muted-foreground'>
                {breakdown?.hasUnclassifiedCost ? (
                  <>
                    Margin on classified COGS only.{' '}
                    {formatCurrency(breakdown.unclassifiedCost)}{' '}still
                    uncategorized. This margin will move as you classify it.
                  </>
                ) : (
                  'Margin on classified COGS only. All cost in this period is classified.'
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='pb-2'>
                <CardDescription className='flex items-center gap-1'>
                  Coverage score
                  <InfoTooltip {...tooltipDefinitions.defensibilityScore} />
                </CardDescription>
                <CardTitle
                  className='text-3xl tabular-nums'
                  style={{
                    color: scoreColor(
                      score?.scorePercent ?? null,
                      // Honesty cap: any uncategorized or un-GL-mapped cost means
                      // the score can't show green, however high.
                      (score?.unclassifiedCost ?? 0) > 0 ||
                        (score?.unmappedCost ?? 0) > 0
                    ),
                  }}
                >
                  {score?.scorePercent !== null &&
                  score?.scorePercent !== undefined
                    ? `${score.scorePercent}%`
                    : '—'}
                </CardTitle>
              </CardHeader>
              <CardContent className='text-xs text-muted-foreground'>
                {pctLabel(score?.classifiedShare ?? null)} classified ·{' '}
                {pctLabel(score?.glMappedShare ?? null)} GL-mapped ·{' '}
                {pctLabel(score?.instrumentedShare ?? null)} instrumented
              </CardContent>
            </Card>
          </div>

          {/* AI cost by P&L category */}
          <Card>
            <CardHeader>
              <CardTitle>AI cost by P&amp;L category</CardTitle>
              <CardDescription>
                Production COGS sits above the gross-margin line; R&amp;D, Sales
                &amp; Marketing, G&amp;A, and internal tooling are OpEx below
                it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Stacked distribution bar */}
              <div className='mb-4 flex h-3 w-full overflow-hidden rounded-full bg-muted'>
                {breakdown?.categories
                  .filter((c) => c.cost > 0)
                  .map((c) => (
                    <div
                      key={c.key}
                      style={{
                        width: `${(c.cost / totalCost) * 100}%`,
                        backgroundColor: CATEGORY_COLOR[c.key],
                      }}
                      title={`${c.label}: ${formatCurrency(c.cost)}`}
                    />
                  ))}
              </div>
              <div className='rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className='w-[120px]'>P&amp;L line</TableHead>
                      <TableHead className='w-[120px] text-right'>
                        Cost
                      </TableHead>
                      <TableHead className='w-[90px] text-right'>
                        Events
                      </TableHead>
                      <TableHead className='w-[90px] text-right'>
                        Share
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {breakdown?.categories.map((c) => (
                      <TableRow key={c.key}>
                        <TableCell>
                          <div className='flex items-center gap-2'>
                            <span
                              className='inline-block h-2.5 w-2.5 rounded-sm'
                              style={{ backgroundColor: CATEGORY_COLOR[c.key] }}
                            />
                            <span className='font-medium'>{c.label}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className='text-xs text-muted-foreground'>
                            {PL_LINE[c.key]}
                          </span>
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {formatCurrency(c.cost)}
                        </TableCell>
                        <TableCell className='text-right tabular-nums text-muted-foreground'>
                          {c.eventCount}
                        </TableCell>
                        <TableCell className='text-right tabular-nums text-muted-foreground'>
                          {totalCost > 0
                            ? `${((c.cost / totalCost) * 100).toFixed(1)}%`
                            : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {breakdown && breakdown.unclassifiedCost > 0 && (
                <div className='mt-2 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500'>
                  {/* Same explicit-space guard as the margin card above. */}
                  {/* prettier-ignore */}
                  <span>
                    {formatCurrency(breakdown.unclassifiedCost)}{' '}is still
                    uncategorized. Classify it on the{' '}
                    {/* Carry THIS period's bounds so Cost Management
                        opens scoped to the same month, not a different
                        (30-day) window. */}
                    <Link
                      href={`/finops?tab=cost-management&startDate=${startDate}&endDate=${endDate}`}
                      className='font-medium underline underline-offset-2'
                    >
                      Cost management tab
                    </Link>{' '}
                    to sharpen this period&apos;s margin and coverage score.
                  </span>
                  <InfoTooltip {...tooltipDefinitions.unclassifiedCostBucket} />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Journal entries by GL code */}
          <Card>
            <CardHeader>
              <CardTitle>Journal entries by GL code</CardTitle>
              <CardDescription>
                AI cost rolled up to each chart-of-accounts line for{' '}
                {monthLabel}. Click any line to see its full audit trail: the
                signals and usage events behind it. Export above to post these
                to your ledger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className='rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-[100px]'>GL code</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className='w-[110px]'>Type</TableHead>
                      <TableHead className='w-[120px] text-right'>
                        Amount
                      </TableHead>
                      <TableHead className='w-[90px] text-right'>
                        Events
                      </TableHead>
                      <TableHead className='w-[40px]'>
                        <span className='sr-only'>Audit trail</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journal?.rows.map((row, i) => (
                      <TableRow
                        key={row.glCode ?? `unmapped-${i}`}
                        className='cursor-pointer hover:bg-muted/50'
                        // Click any GL line to drill into its audit trail.
                        // Keyboard-accessible: row is focusable + Enter opens it.
                        role='button'
                        tabIndex={0}
                        onClick={() => openGlDrillThrough(row.glCode)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openGlDrillThrough(row.glCode)
                          }
                        }}
                      >
                        <TableCell className='tabular-nums'>
                          {row.glCode ?? (
                            <span className='text-amber-600 dark:text-amber-500'>
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell
                          className={
                            row.glCode === null
                              ? 'text-amber-600 dark:text-amber-500'
                              : ''
                          }
                        >
                          {row.glName}
                        </TableCell>
                        <TableCell>
                          {row.accountingType ? (
                            <Badge variant='outline'>
                              {row.accountingType}
                            </Badge>
                          ) : (
                            <span className='text-muted-foreground'>—</span>
                          )}
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {formatCurrency(row.amount)}
                        </TableCell>
                        <TableCell className='text-right tabular-nums text-muted-foreground'>
                          {row.eventCount}
                        </TableCell>
                        <TableCell className='text-right'>
                          <ChevronRight className='inline h-4 w-4 text-muted-foreground' />
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className='border-t-2 font-medium'>
                      <TableCell colSpan={3}>Total</TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {formatCurrency(journal?.totalAmount ?? 0)}
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {journal?.rows.reduce((s, r) => s + r.eventCount, 0) ??
                          0}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              {journal?.hasUnmapped && (
                <div className='mt-2 text-xs text-amber-600 dark:text-amber-500'>
                  {formatCurrency(journal.unmappedAmount)} is not yet mapped to
                  a GL code. Map it on the{' '}
                  {/* Same period-carrying deep-link as the
                      unclassified nudge above, for the same reconciliation. */}
                  <Link
                    href={`/finops?tab=cost-management&startDate=${startDate}&endDate=${endDate}`}
                    className='font-medium underline underline-offset-2'
                  >
                    Cost management tab
                  </Link>{' '}
                  so it lands on the right P&amp;L line.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Margin by product line (reused, period-scoped). periodLocked drives
              the live-vs-frozen badge: a closed month reads "Frozen ·
              <month> close", an open one "Live · <month>". */}
          <ProductLineMarginPanel filter={filter} periodLocked={isLocked} />
        </div>
      )}

      {/* Drill-through audit trail. Opens from any GL row above.
          Controlled Sheet: open when a GL row is selected, closes back to the
          table. Lives at Page level so it overlays the whole view. */}
      <Sheet
        open={selectedGlKey !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedGlKey(null)
        }}
      >
        <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
          <SheetHeader>
            <SheetTitle>
              {selectedGlLine
                ? `${selectedGlLine.glCode ?? 'Unmapped'}: ${selectedGlLine.glName}`
                : 'Audit trail'}
            </SheetTitle>
            <SheetDescription>
              {/* Honest source label: internal usage events only, with no
                  link to provider invoices. Fall back to the canonical
                  AUDIT_SOURCE_LABEL so the pre-load text can never drift from
                  the value the action actually returns. */}
              {auditDetail?.sourceLabel ?? AUDIT_SOURCE_LABEL}
            </SheetDescription>
          </SheetHeader>

          <div className='mt-4 space-y-4'>
            {auditLoading ? (
              <div className='space-y-3'>
                <Skeleton className='h-20 w-full' />
                <Skeleton className='h-40 w-full' />
              </div>
            ) : !selectedGlLine ? (
              <p className='text-sm text-muted-foreground'>
                No audit detail for this line in {monthLabel}.
              </p>
            ) : (
              <>
                {/* GL line summary */}
                <div className='grid grid-cols-2 gap-3 rounded-md border p-3 text-sm'>
                  <div>
                    <div className='text-xs text-muted-foreground'>Account</div>
                    <div className='font-medium'>{selectedGlLine.glName}</div>
                  </div>
                  <div>
                    <div className='text-xs text-muted-foreground'>
                      P&amp;L line
                    </div>
                    <div className='font-medium'>
                      {selectedGlLine.accountingType ?? 'Unmapped'}
                    </div>
                  </div>
                  <div>
                    <div className='text-xs text-muted-foreground'>Total</div>
                    <div className='font-medium tabular-nums'>
                      {formatCurrency(selectedGlLine.amount)}
                    </div>
                  </div>
                  <div>
                    <div className='text-xs text-muted-foreground'>Events</div>
                    <div className='font-medium tabular-nums'>
                      {selectedGlLine.eventCount}
                    </div>
                  </div>
                </div>

                {/* Per-signal breakdown: classification provenance + events */}
                {selectedGlLine.signals.map((signal) => (
                  <div
                    key={signal.signalId}
                    className='rounded-md border p-3 text-sm'
                  >
                    <div className='flex items-start justify-between gap-2'>
                      <div>
                        <div className='font-medium'>{signal.signalName}</div>
                        <div className='mt-0.5 text-xs text-muted-foreground'>
                          Category: {signal.costCategory}
                        </div>
                      </div>
                      <Badge variant='outline' className='shrink-0'>
                        {signal.events.length} event
                        {signal.events.length === 1 ? '' : 's'}
                      </Badge>
                    </div>

                    {/* Classification provenance — honest about "default". */}
                    <div className='mt-2 text-xs text-muted-foreground'>
                      {signal.classification ? (
                        <>
                          Classified via {signal.classification.source} on{' '}
                          {signal.classification.classifiedAt.slice(0, 10)}
                        </>
                      ) : (
                        'Classification: default / not manually overridden'
                      )}
                    </div>

                    {/* Usage events under this signal — the audit leaves. */}
                    <div className='mt-2 rounded-md border'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className='h-8 text-xs'>Date</TableHead>
                            <TableHead className='h-8 text-xs'>Env</TableHead>
                            <TableHead className='h-8 text-right text-xs'>
                              Qty
                            </TableHead>
                            <TableHead className='h-8 text-right text-xs'>
                              Cost
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {signal.events.map((ev) => (
                            <TableRow key={ev.eventId}>
                              <TableCell className='py-1.5 text-xs tabular-nums'>
                                {ev.usageDate.slice(0, 10)}
                              </TableCell>
                              <TableCell className='py-1.5 text-xs'>
                                {ev.environment ?? '—'}
                              </TableCell>
                              <TableCell className='py-1.5 text-right text-xs tabular-nums'>
                                {ev.quantity}
                              </TableCell>
                              <TableCell className='py-1.5 text-right text-xs tabular-nums'>
                                {formatCurrency(ev.usageCost)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Page>
  )
}
