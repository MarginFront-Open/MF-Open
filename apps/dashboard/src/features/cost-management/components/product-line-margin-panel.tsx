'use client'

/**
 * Product-Line Margin Panel: gross margin by product line.
 *
 * Shows gross margin BY product line (agent): revenue, AI cost, margin, and
 * margin % per product, so a multi-product company can see which product
 * lines carry healthy economics and which are quietly margin-dilutive.
 *
 * Presentation only — math comes from getProductLineMargins (which delegates
 * to the canonical revenue lib).
 */

import { useEffect, useState, useTransition } from 'react'
import {
  getProductLineMargins,
  type ProductLineMarginSummary,
} from '@/app/actions/finance-metrics'
import type { WindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { formatCurrency } from '@/lib/canon-format'
import { useToast } from '@/hooks/use-toast'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'

/** Color a margin % by health: green ≥60%, amber 35-60%, red <35%.
 *  Thresholds echo a common AI-cost framework (AI-mature 50-65%,
 *  dilutive below). */
function marginColor(pct: number | null): string {
  if (pct === null) return 'hsl(var(--muted-foreground))'
  if (pct >= 0.6) return 'hsl(142 71% 45%)' // green
  if (pct >= 0.35) return 'hsl(38 92% 50%)' // amber
  return 'hsl(0 84% 60%)' // red
}

export default function ProductLineMarginPanel({
  filter,
  periodLocked,
}: {
  /** Optional billing-period window. Omitted = last 30 days (default). */
  filter?: WindowFilter
  /**
   * Is the selected period locked (closed)? Drives the live-vs-frozen badge.
   * The SAME component renders on two pages; the badge tells a finance
   * reader which one they're
   * looking at. When true, the numbers are a frozen close-of-record snapshot;
   * when false/omitted, a live recompute of the selected window. Month-End
   * Close passes its lock state; Cost Management omits it (always live).
   */
  periodLocked?: boolean
} = {}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ProductLineMarginSummary | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    startTransition(async () => {
      setLoading(true)
      try {
        const result = await getProductLineMargins(filter)
        setData(result)
      } catch (err) {
        toast({
          title: 'Failed to load product-line margins',
          description: (err as Error)?.message ?? 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the period bounds change
  }, [filter?.startDate, filter?.endDate])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-6 w-64' />
          <Skeleton className='mt-2 h-4 w-96' />
        </CardHeader>
        <CardContent>
          <Skeleton className='h-40 w-full' />
        </CardContent>
      </Card>
    )
  }

  // No revenue → nothing to show. Keep the page clean rather than render an
  // empty table.
  if (!data || data.rows.length === 0 || data.totalRevenue <= 0) {
    return null
  }

  const maxRevenue = Math.max(...data.rows.map((r) => r.revenue), 1)

  return (
    <Card>
      <CardHeader>
        <div className='flex items-start justify-between gap-2'>
          <CardTitle>Gross margin by product line</CardTitle>
          {/* Live-vs-frozen badge: the same panel renders on Cost
              Management (always live) and Month-End Close (frozen once the month
              is locked). The badge stops the two identical-looking tables from
              being mistaken for one another. periodLabel is already on `data`. */}
          <Badge
            variant={periodLocked ? 'secondary' : 'outline'}
            className='shrink-0'
          >
            {periodLocked
              ? `Frozen · ${data.periodLabel} close`
              : `Live · ${data.periodLabel}`}
          </Badge>
        </div>
        <CardDescription>
          AI gross margin per product (agent) for {data.periodLabel}. Blended
          across all products:{' '}
          <span className='font-medium'>
            {data.blendedMarginPercent !== null
              ? `${(data.blendedMarginPercent * 100).toFixed(1)}%`
              : '—'}
          </span>
          . Watch for product lines below the blended line. They{"'"}re diluting
          the others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product line</TableHead>
                <TableHead className='w-[90px] text-right'>Customers</TableHead>
                <TableHead className='w-[120px] text-right'>Revenue</TableHead>
                <TableHead className='w-[120px] text-right'>AI cost</TableHead>
                <TableHead className='w-[120px] text-right'>Margin</TableHead>
                <TableHead className='w-[160px]'>Margin %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => {
                const pct = row.marginPercent
                const barWidth =
                  pct === null ? 0 : Math.max(0, Math.min(1, pct)) * 100
                const revShare = (row.revenue / maxRevenue) * 100
                return (
                  <TableRow key={row.agentId}>
                    <TableCell>
                      <div className='font-medium'>{row.agentName}</div>
                      {/* Revenue-share micro-bar so the eye sees relative size */}
                      <div className='mt-1 h-1 w-full overflow-hidden rounded-full bg-muted'>
                        <div
                          className='h-full'
                          style={{
                            width: `${revShare}%`,
                            backgroundColor: 'hsl(var(--chart-1))',
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className='text-right text-muted-foreground'>
                      {row.customerCount}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatCurrency(row.revenue)}
                    </TableCell>
                    <TableCell className='text-right text-muted-foreground'>
                      {formatCurrency(row.cost)}
                    </TableCell>
                    <TableCell className='text-right font-medium'>
                      {formatCurrency(row.margin)}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-2'>
                        <div className='h-2 flex-1 overflow-hidden rounded-full bg-muted'>
                          <div
                            className='h-full'
                            style={{
                              width: `${barWidth}%`,
                              backgroundColor: marginColor(pct),
                            }}
                          />
                        </div>
                        <span
                          className='w-12 text-right text-sm font-medium tabular-nums'
                          style={{ color: marginColor(pct) }}
                        >
                          {pct !== null ? `${(pct * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <div className='mt-2 text-xs text-muted-foreground'>
          Product line = agent. Revenue and AI cost come from billable events
          tied to each product{"'"}s subscriptions. Internal R&amp;D usage is
          excluded here (it shows in the R&amp;D bucket above).
        </div>
      </CardContent>
    </Card>
  )
}
