'use client'

/**
 * WHAT THIS FILE DOES: Renders the Cost management tab on /finops (the
 *   /cost-management route redirects here). It is three self-contained
 *   finance panels:
 *     1. AI Cost Classification — splits AI spend into COGS vs R&D, shows the
 *        signals table + GL mapping, and owns the journal CSV export.
 *     2. CFO Charts — earned vs total revenue per product line, plus
 *        cost by classification (donut) and cost by GL code (bars).
 *     3. Product-Line Margin — gross margin by product line (agent).
 *
 * The FinOps page owns the month via its month-locked header selector and
 *   threads the SAME {startDate,endDate} window here that the Close tab uses.
 *   One page, one window (canon W1), so two tabs can't show two totals. Deep
 *   links (?startDate=&endDate=) keep working because the FinOps page reads
 *   the same params.
 *
 * CONNECTS TO:
 *   - src/features/finops/index.tsx (the tabbed page that renders this)
 *   - app/(dashboard)/cost-management/page.tsx (307 redirect to /finops?tab=cost-management)
 *   - ./components/cost-classification-panel (COGS/R&D split + journal CSV)
 *   - ./components/cfo-charts-panel (the CFO charts)
 *   - ./components/product-line-margin-panel (also used by month-end-close)
 */

import { useMemo } from 'react'
import CostClassificationPanel from './components/cost-classification-panel'
import CfoChartsPanel from './components/cfo-charts-panel'
import ProductLineMarginPanel from './components/product-line-margin-panel'

export default function CostManagement({
  startDate,
  endDate,
  monthLabel,
}: {
  /** Month bounds threaded from the FinOps page's month-locked selector. */
  startDate: string
  endDate: string
  /** Human label for the window (e.g. "June 2026"), used in the copy. */
  monthLabel: string
}) {
  const filter = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

  return (
    <div className='flex flex-col gap-4'>
      {/* No month selector here: the page header's month-locked selector
          owns the window for every FinOps tab. */}
      <p className='text-[11.5px] text-mf-tx2'>
        Classify your AI costs as COGS vs R&D and track gross margin by product
        line. Classifying for{' '}
        <span className='font-semibold text-mf-tx'>{monthLabel}</span>. Switch
        months with the selector above.
      </p>

      {/* AI Cost Classification — COGS vs R&D split, signals table, GL
          mapping, and the journal CSV export. Scoped to the
          selected period; renders its own loading + empty states. */}
      <CostClassificationPanel filter={filter} periodLabel={monthLabel} />

      {/* CFO Charts — earned vs total revenue per product line,
          cost-by-classification donut, and cost-by-GL-code bars. Scoped to the
          selected period; each chart owns its own empty state. */}
      <CfoChartsPanel filter={filter} periodLabel={monthLabel} />

      {/* Product-Line Margin — gross margin by product (agent), scoped to the
          selected period. Self-renders an empty/null state when there's no
          revenue, so it stays quiet in cost-only setups. */}
      <ProductLineMarginPanel filter={filter} />
    </div>
  )
}
