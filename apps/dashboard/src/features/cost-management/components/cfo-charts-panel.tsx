'use client'

/**
 * WHAT THIS FILE DOES: the CFO Charts panel on the FinOps Cost management
 *   tab. Three purpose-built charts a CFO actually reads — each picked for
 *   the kind of number it shows:
 *     1. Revenue — Earned vs Total, per product line (grouped bars):
 *        "what activity earned" (Agent-Earned, the
 *        usage slice) beside "what the customer owes" (Total Revenue, which adds
 *        recurring + seat + one-time fees). A comparison → side-by-side bars.
 *     2. Cost by classification (donut). A part-of-whole split (COGS / R&D /
 *        Internal / Unclassified) → a donut.
 *     3. Cost by GL code (horizontal bars). A ranked list of accounts → bars,
 *        longest first, with the "Unmapped" bucket flagged.
 *
 * WHY IT EXISTS: these are the CFO-grade views of revenue and cost. Every
 *   dollar series carries its canon label + tooltip: Earned uses the
 *   `usageRevenue` definition (events × rate, the canon Agent-Earned meaning),
 *   Total uses `totalRevenueHero`. We deliberately do NOT use the `earnedRevenue`
 *   tooltip — its copy says "+ recurring + seat fees", which is NOT canon
 *   Agent-Earned and would mislabel the earned bars.
 *
 * The charts split into TWO honestly-titled cards: the revenue comparison
 *   under a revenue-true name, the two cost charts under a cost-true name. A
 *   cost-named card showing revenue bars would mislead the reader.
 *
 * The math is canonical and done server-side — this component is presentation
 * only. It reads three org-scoped actions and shapes them via cfo-charts-utils
 * (pure, unit-tested). It does not sum or recompute any money here.
 *
 * CONNECTS TO:
 *   - ../index.tsx (the page that renders this panel)
 *   - ../cfo-charts-utils (pure data shaping)
 *   - app/actions/finance-metrics.ts (getProductLineMargins — earned + total)
 *   - app/actions/cost-command-center.ts (getCostClassificationBreakdown — categories)
 *   - app/actions/journal-export.ts (getJournalExport — cost by GL code)
 */

import { useEffect, useState, useTransition } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
} from 'recharts'
import {
  getProductLineMargins,
  type ProductLineMarginSummary,
} from '@/app/actions/finance-metrics'
import {
  getCostClassificationBreakdown,
  type CostClassificationBreakdown,
  type CostCategoryKey,
} from '@/app/actions/cost-command-center'
import {
  getJournalExport,
  type JournalExport,
} from '@/app/actions/journal-export'
import type { WindowFilter } from '@/app/actions/_shared/parse-window-filter'
import {
  buildRevenueComparison,
  buildCategorySlices,
  buildGlCostBars,
} from '@/features/cost-management/cfo-charts-utils'
import { ChartTooltip } from '@/features/dashboard-shell/command-center-shared'
import { formatCurrency } from '@/lib/canon-format'
import { useToast } from '@/hooks/use-toast'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

// Category → color, kept in step with cost-classification-panel.tsx so the
// donut here reads in the same colors as the per-category cards there (COGS =
// chart-1, R&D = chart-2, …). A 6-entry map; small to mirror, cheap to keep
// consistent.
const CATEGORY_COLOR: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'hsl(var(--chart-1))',
  DEVELOPMENT_RD: 'hsl(var(--chart-2))',
  SALES_SM: 'hsl(var(--chart-4))',
  GENERAL_GA: 'hsl(var(--chart-5))',
  INTERNAL_TOOL: 'hsl(var(--chart-3))',
  UNCLASSIFIED: 'hsl(var(--muted-foreground))',
}

const EARNED_COLOR = 'hsl(var(--chart-3))'
const TOTAL_COLOR = 'hsl(var(--chart-1))'
const GL_COLOR = 'hsl(var(--chart-1))'
const GL_UNMAPPED_COLOR = 'hsl(38 92% 50%)' // amber — "needs a GL code"

const AGENT_LIMIT = 8
const GL_LIMIT = 10

/** Shorten a long axis label so the chart doesn't reserve half its width for text. */
const truncate = (v: string, max = 22) =>
  v.length > max ? `${v.slice(0, max - 1)}…` : v

export default function CfoChartsPanel({
  filter,
  periodLabel,
}: {
  /** Billing-period window threaded from the page. Omitted = last 30 days. */
  filter?: WindowFilter
  /** Human label for the window (e.g. "June 2026"), used in the copy. */
  periodLabel?: string
} = {}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [margins, setMargins] = useState<ProductLineMarginSummary | null>(null)
  const [breakdown, setBreakdown] =
    useState<CostClassificationBreakdown | null>(null)
  const [journal, setJournal] = useState<JournalExport | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    startTransition(async () => {
      setLoading(true)
      try {
        // All three series are window-scoped to the selected period (one window for every series).
        const [marginRows, breakdownRows, journalRows] = await Promise.all([
          getProductLineMargins(filter),
          getCostClassificationBreakdown(filter),
          getJournalExport(filter),
        ])
        setMargins(marginRows)
        setBreakdown(breakdownRows)
        setJournal(journalRows)
      } catch (err) {
        toast({
          // Named for what the user sees on screen: the two chart cards this
          // one fetch feeds.
          title: 'Failed to load the revenue and cost charts',
          description: (err as Error)?.message ?? 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    })
    // Re-fetch when the selected period changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the period bounds change
  }, [filter?.startDate, filter?.endDate])

  if (loading) {
    return (
      <div className='flex flex-col gap-6'>
        <Card>
          <CardHeader>
            <Skeleton className='h-6 w-72' />
            <Skeleton className='mt-2 h-4 w-96' />
          </CardHeader>
          <CardContent>
            <Skeleton className='h-64 w-full' />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className='h-6 w-72' />
            <Skeleton className='mt-2 h-4 w-96' />
          </CardHeader>
          <CardContent>
            <div className='grid gap-4 lg:grid-cols-2'>
              <Skeleton className='h-56 w-full' />
              <Skeleton className='h-56 w-full' />
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Shape the three datasets (pure helpers) ──
  const revenueBars = buildRevenueComparison(margins?.rows ?? [], AGENT_LIMIT)
  const totalAgents = (margins?.rows ?? []).filter(
    (r) => r.revenue > 0 || (r.earned ?? 0) > 0
  ).length

  const categorySlices = buildCategorySlices(breakdown?.categories ?? [])
  const categoryTotal = categorySlices.reduce((s, c) => s + c.value, 0)

  const glBars = buildGlCostBars(journal?.rows ?? [], GL_LIMIT)
  const totalGlLines = (journal?.rows ?? []).filter((r) => r.amount > 0).length

  return (
    <div className='flex flex-col gap-6'>
      {/* ── Card 1. Revenue — Earned vs Total, per product line ── */}
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            Earned vs total revenue by product line
            <InfoTooltip {...tooltipDefinitions.earnedVsTotalRevenueChart} />
          </CardTitle>
          <CardDescription>
            What each product line earned from usage, next to everything
            earnable for it including fees ({periodLabel ?? 'last 30 days'}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <section>
            {/* Legend: each series labeled with its canon term +
                tooltip. Earned = usageRevenue (events × rate); Total =
                totalRevenueHero (adds recurring + seat + one-time). NEVER the
                earnedRevenue tooltip — its copy folds in fees and would lie. */}
            <div className='mb-3 flex items-center justify-end gap-4 text-xs text-muted-foreground'>
              <span className='flex items-center gap-1.5'>
                <span
                  className='h-2.5 w-2.5 rounded-sm'
                  style={{ backgroundColor: EARNED_COLOR }}
                />
                Agent-Earned
                <InfoTooltip {...tooltipDefinitions.usageRevenue} />
              </span>
              <span className='flex items-center gap-1.5'>
                <span
                  className='h-2.5 w-2.5 rounded-sm'
                  style={{ backgroundColor: TOTAL_COLOR }}
                />
                Total Revenue
                <InfoTooltip {...tooltipDefinitions.totalRevenueHero} />
              </span>
            </div>

            {revenueBars.length === 0 ? (
              <div className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
                <span className='font-medium'>No revenue yet.</span> Connect a
                billing integration or record subscription revenue and this
                chart fills in earned vs total per product line.
              </div>
            ) : (
              <>
                {margins && (
                  <div className='mb-2 text-xs text-muted-foreground'>
                    Across {totalAgents} product line
                    {totalAgents === 1 ? '' : 's'}:{' '}
                    <span className='font-medium text-foreground'>
                      {/* `?? 0`: a locked-period snapshot stored without
                        totalEarned deserializes without it.
                        PERIOD_SNAPSHOT_VERSION forces such snapshots to
                        recompute live; this guard backs that up so the
                        org-total read never renders "$NaN earned". */}
                      {formatCurrency(margins.totalEarned ?? 0)}
                    </span>{' '}
                    earned ·{' '}
                    <span className='font-medium text-foreground'>
                      {formatCurrency(margins.totalRevenue)}
                    </span>{' '}
                    total revenue
                  </div>
                )}
                <div style={{ height: Math.max(200, revenueBars.length * 64) }}>
                  <ResponsiveContainer width='100%' height='100%'>
                    <BarChart
                      data={revenueBars}
                      layout='vertical'
                      margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
                      barGap={2}
                    >
                      <CartesianGrid
                        strokeDasharray='3 3'
                        stroke='hsl(var(--border))'
                        horizontal={false}
                      />
                      <XAxis
                        type='number'
                        axisLine={false}
                        tickLine={false}
                        tick={{
                          fontSize: 11,
                          fill: 'hsl(var(--muted-foreground))',
                        }}
                        tickFormatter={(v) => `$${v}`}
                      />
                      <YAxis
                        type='category'
                        dataKey='name'
                        axisLine={false}
                        tickLine={false}
                        tick={{
                          fontSize: 11,
                          fill: 'hsl(var(--muted-foreground))',
                        }}
                        width={150}
                        tickFormatter={(v: string) => truncate(v)}
                      />
                      <Tooltip content={<ChartTooltip />} cursor={false} />
                      <Bar
                        dataKey='earned'
                        name='Agent-Earned'
                        fill={EARNED_COLOR}
                        radius={[0, 3, 3, 0]}
                      />
                      <Bar
                        dataKey='total'
                        name='Total Revenue'
                        fill={TOTAL_COLOR}
                        radius={[0, 3, 3, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {totalAgents > revenueBars.length && (
                  <div className='mt-1 text-xs text-muted-foreground'>
                    Showing the top {revenueBars.length} of {totalAgents}{' '}
                    product lines by revenue.
                  </div>
                )}
              </>
            )}
          </section>
        </CardContent>
      </Card>

      {/* ── Card 2. Cost composition + cost by GL code, side by side ── */}
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            Cost by category and GL account
            <InfoTooltip {...tooltipDefinitions.costByCategoryAndGl} />
          </CardTitle>
          <CardDescription>
            Where the period&apos;s AI spend sits on your P&amp;L and chart of
            accounts ({periodLabel ?? 'last 30 days'}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='grid gap-8 lg:grid-cols-2'>
            {/* 2. Cost by classification donut */}
            <section>
              <div className='mb-3 text-sm font-medium'>
                Cost by classification
              </div>
              {categorySlices.length === 0 ? (
                <div className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
                  <span className='font-medium'>No cost yet.</span> Send usage
                  with the MarginFront SDK and your spend splits into COGS,
                  R&amp;D, and the rest here.
                </div>
              ) : (
                <div className='flex flex-col items-center gap-4 sm:flex-row'>
                  <div className='h-[180px] w-[180px] shrink-0'>
                    <ResponsiveContainer width='100%' height='100%'>
                      <PieChart>
                        <Pie
                          data={categorySlices}
                          dataKey='value'
                          nameKey='name'
                          cx='50%'
                          cy='50%'
                          innerRadius={52}
                          outerRadius={82}
                          strokeWidth={0}
                        >
                          {categorySlices.map((slice) => (
                            <Cell
                              key={slice.key}
                              fill={CATEGORY_COLOR[slice.key]}
                            />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className='flex w-full flex-col gap-2'>
                    {categorySlices.map((slice) => (
                      <div
                        key={slice.key}
                        className='flex items-center justify-between gap-3 text-xs'
                      >
                        <span className='flex items-center gap-2'>
                          <span
                            className='h-2.5 w-2.5 rounded-full'
                            style={{
                              backgroundColor: CATEGORY_COLOR[slice.key],
                            }}
                          />
                          <span className='text-foreground'>{slice.name}</span>
                        </span>
                        <span className='text-muted-foreground'>
                          <span className='font-medium text-foreground'>
                            {formatCurrency(slice.value)}
                          </span>
                          {categoryTotal > 0 && (
                            <>
                              {' · '}
                              {((slice.value / categoryTotal) * 100).toFixed(1)}
                              %
                            </>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* 3. Cost by GL code horizontal bars */}
            <section>
              <div className='mb-3 flex items-center justify-between'>
                <div className='text-sm font-medium'>Cost by GL code</div>
                {journal?.hasUnmapped && (
                  <span className='text-xs text-amber-600 dark:text-amber-500'>
                    {formatCurrency(journal.unmappedAmount)} unmapped
                  </span>
                )}
              </div>
              {glBars.length === 0 ? (
                <div className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
                  <span className='font-medium'>No GL-coded cost yet.</span> Map
                  your signals to GL codes in the signals table above and the
                  spend lands on the chart of accounts here.
                </div>
              ) : (
                <>
                  <div style={{ height: Math.max(160, glBars.length * 36) }}>
                    <ResponsiveContainer width='100%' height='100%'>
                      <BarChart
                        data={glBars}
                        layout='vertical'
                        margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray='3 3'
                          stroke='hsl(var(--border))'
                          horizontal={false}
                        />
                        <XAxis
                          type='number'
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fontSize: 11,
                            fill: 'hsl(var(--muted-foreground))',
                          }}
                          tickFormatter={(v) => `$${v}`}
                        />
                        <YAxis
                          type='category'
                          dataKey='name'
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fontSize: 11,
                            fill: 'hsl(var(--muted-foreground))',
                          }}
                          width={150}
                          tickFormatter={(v: string) => truncate(v)}
                        />
                        <Tooltip content={<ChartTooltip />} cursor={false} />
                        <Bar dataKey='value' name='Cost' radius={[0, 3, 3, 0]}>
                          {glBars.map((bar, i) => (
                            <Cell
                              key={i}
                              fill={
                                bar.isUnmapped ? GL_UNMAPPED_COLOR : GL_COLOR
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {totalGlLines > glBars.length && (
                    <div className='mt-1 text-xs text-muted-foreground'>
                      Showing the top {glBars.length} of {totalGlLines} GL lines
                      by spend.
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
