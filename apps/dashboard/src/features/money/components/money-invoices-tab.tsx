'use client'

/**
 * Money → Invoices tab: a
 * preview list of the org's invoices, linking out to the
 * `/invoices/[invoiceId]` detail (link, don't rebuild). The
 * full `/invoices` page owns creation (Generate from
 * Subscription / New Invoice), search, filters, and pagination; this tab is
 * a fast read that reuses the SAME getInvoices() server action the
 * /invoices page's useInvoices() hook wraps, so there is no second invoice-listing
 * code path, no hand-rolled totals.
 *
 * Refunds are display-only here (webhook-driven): no
 * refund button. Status renders via invoiceStatusChip (invoices-derivation.ts),
 * not InvoiceStatusBadge; see that module's doc comment for why.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDisplayDate } from '@/lib/canon-date'
import { getInvoices } from '@/app/actions/invoices'
import { formatCurrency } from '@/lib/canon-format'
import { Badge } from '@/components/ui/badge'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { buildInvoicesTabRows, invoiceStatusChip } from '../invoices-derivation'

// A preview, not the full paginated list, matching the flat, unpaginated
// Users/Plans tabs. Deep pagination/search lives on the /invoices page
// (linked below).
const PREVIEW_LIMIT = 100

function formatDate(value: string): string {
  return formatDisplayDate(value, 'MMM dd, yyyy')
}

export function MoneyInvoicesTab() {
  const [rows, setRows] = useState<ReturnType<typeof buildInvoicesTabRows>>([])
  const [totalResults, setTotalResults] = useState(0)
  const [loadState, setLoadState] = useState<TileState>('loading')

  useEffect(() => {
    let cancelled = false
    getInvoices({
      limit: PREVIEW_LIMIT,
      page: 1,
      sortBy: 'invoiceDate',
      sortOrder: 'desc',
      includeDetails: true,
    }).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setRows(buildInvoicesTabRows(result.data.results))
        setTotalResults(result.data.totalResults)
        setLoadState('ready')
      } else {
        setLoadState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (loadState === 'loading') {
    return (
      <TileFrame state='loading' className='min-h-[280px]' loadingLines={6}>
        {null}
      </TileFrame>
    )
  }

  if (loadState === 'error') {
    return (
      <TileFrame
        state='error'
        className='min-h-[280px]'
        errorMessage="Couldn't load invoices. Refresh the page to try again."
      >
        {null}
      </TileFrame>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-end'>
        <Link
          href='/invoices'
          className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'
        >
          Manage all invoices →
        </Link>
      </div>

      <TileFrame state='ready' className='overflow-hidden'>
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Invoice #
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Customer
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                Amount
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Invoice date
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Due date
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Status
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Subscription
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const chip = invoiceStatusChip(row.status)
              return (
                <tr key={row.id} className='border-t border-mf-bd2'>
                  <td className='px-[17px] py-[11px] text-[12.5px] font-medium'>
                    <Link
                      href={`/invoices/${row.id}`}
                      className='text-mf-tx hover:text-mf-accent'
                    >
                      {row.invoiceNumber}
                    </Link>
                  </td>
                  <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                    {row.customerName ?? '—'}
                  </td>
                  <td className='px-[10px] py-[11px] text-right text-[12.5px] tabular-nums'>
                    {formatCurrency(row.amount)}
                    {row.refundedAmount > 0 && (
                      <p className='text-[11px] tabular-nums text-mf-tx3'>
                        {`−${formatCurrency(row.refundedAmount)} refunded`}
                      </p>
                    )}
                  </td>
                  <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                    {formatDate(row.invoiceDate)}
                  </td>
                  <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                    {formatDate(row.dueDate)}
                  </td>
                  <td className='px-[10px] py-[11px]'>
                    <Badge variant={chip.variant}>{chip.label}</Badge>
                  </td>
                  <td className='px-[17px] py-[11px] text-[12px] text-mf-tx2'>
                    {row.subscriptionName ?? '—'}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className='px-[17px] py-6 text-center text-[12px] text-mf-tx3'
                >
                  No invoices yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TileFrame>

      {totalResults > rows.length && (
        <p className='text-right text-[11px] text-mf-tx3'>
          Showing the {rows.length} most recent of {totalResults} invoices.{' '}
          <Link href='/invoices' className='hover:text-mf-accent'>
            View all →
          </Link>
        </p>
      )}
    </div>
  )
}
