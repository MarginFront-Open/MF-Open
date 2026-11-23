'use client'

import { useState } from 'react'
import { formatDisplayDate } from '@/lib/canon-date'
import { type Invoice } from '@/app/actions/invoices'
import { useInvoices } from '@/services/invoices-service'
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/canon-format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const PAGE_SIZE_OPTIONS = [10, 25, 50]

export interface InvoicesTableProps {
  subscriptionId?: string
  customerId?: string
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  includeDetails?: boolean
  title?: string
  showCard?: boolean
  className?: string
  onRowClick?: (invoiceId: string) => void
  // Opt-in server-side pagination. Off by default so embedded usages (the
  // customer-detail "Recent Invoices") stay a plain list capped at `limit`;
  // on, the component owns page state and renders a pager.
  paginated?: boolean
  pageSize?: number
}

export const InvoicesTable = ({
  subscriptionId,
  customerId,
  limit = 10,
  sortBy = 'invoiceDate',
  sortOrder = 'desc',
  includeDetails = true,
  title = 'Invoices',
  showCard = true,
  className = '',
  onRowClick,
  paginated = false,
  pageSize: pageSizeProp = 25,
}: InvoicesTableProps) => {
  const router = useRouter()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pageSizeProp)

  const { data, isLoading, isError } = useInvoices({
    subscriptionId,
    customerId,
    limit: paginated ? pageSize : limit,
    page: paginated ? page : 1,
    sortBy,
    sortOrder,
    includeDetails,
  })

  const invoices: Invoice[] = data?.results ?? []
  const totalResults = data?.totalResults ?? 0
  const totalPages = data?.totalPages ?? 1

  const handleRowClick = (invoiceId: string) => {
    if (onRowClick) {
      onRowClick(invoiceId)
    } else {
      router.push(`/invoices/${invoiceId}`)
    }
  }

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const endRow = Math.min(page * pageSize, totalResults)
  const startRow =
    totalResults === 0 ? 0 : Math.min((page - 1) * pageSize + 1, endRow)

  const tableContent = (
    <>
      {isLoading ? (
        <div className='flex h-40 items-center justify-center'>
          <Loader2 className='h-6 w-6 animate-spin' />
        </div>
      ) : isError ? (
        <div className='p-4 text-destructive'>
          Failed to load invoices. Please try again.
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue Date</TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead className='text-right'>Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length > 0 ? (
                invoices.map((invoice) => (
                  <TableRow
                    key={invoice.id}
                    className='cursor-pointer hover:bg-muted/50'
                    onClick={() => handleRowClick(invoice.id)}
                  >
                    <TableCell>
                      {formatDisplayDate(invoice.invoiceDate, 'dd MMM yyyy')}
                    </TableCell>
                    <TableCell>{invoice.invoiceNumber}</TableCell>
                    <TableCell className='text-right'>
                      <div className='tabular-nums'>
                        {formatCurrency(invoice.totalAmount)}
                      </div>
                      {invoice.refundedAmount > 0 && (
                        <div className='text-xs tabular-nums text-muted-foreground'>
                          {`-${formatCurrency(invoice.refundedAmount)} refunded`}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={invoice.status} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className='py-6 text-center text-muted-foreground'
                  >
                    No invoices found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {paginated && !isLoading && !isError && (
        <div className='mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row'>
          <div className='text-sm text-muted-foreground'>
            {totalResults === 0
              ? 'No invoices'
              : `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${totalResults.toLocaleString()}`}
          </div>
          <div className='flex items-center gap-4 sm:gap-6'>
            <div className='flex items-center gap-2'>
              <span className='hidden text-sm text-muted-foreground sm:block'>
                Rows per page
              </span>
              <Select
                value={`${pageSize}`}
                onValueChange={(value) => handlePageSizeChange(Number(value))}
              >
                <SelectTrigger className='h-8 w-[72px]'>
                  <SelectValue placeholder={`${pageSize}`} />
                </SelectTrigger>
                <SelectContent side='top'>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={`${size}`}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='text-sm font-medium'>
              Page {page} of {totalPages || 1}
            </div>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                className='hidden h-8 w-8 p-0 lg:flex'
                onClick={() => setPage(1)}
                disabled={page <= 1}
              >
                <span className='sr-only'>First page</span>
                <ChevronsLeft className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='h-8 w-8 p-0'
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <span className='sr-only'>Previous page</span>
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='h-8 w-8 p-0'
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <span className='sr-only'>Next page</span>
                <ChevronRight className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='hidden h-8 w-8 p-0 lg:flex'
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
              >
                <span className='sr-only'>Last page</span>
                <ChevronsRight className='h-4 w-4' />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (!showCard) {
    return <div className={className}>{tableContent}</div>
  }

  return (
    <Card className={className}>
      {title && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent>{tableContent}</CardContent>
    </Card>
  )
}
