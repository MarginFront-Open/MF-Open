'use client'

import { useState } from 'react'
import { formatDisplayDate } from '@/lib/canon-date'
import { useFilters } from '@/services/filters-service'
import {
  useInvoices,
  Invoice,
  InvoiceQueryParams,
} from '@/services/invoices-service'
import { PlusIcon, Link2Icon, Eye } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/canon-format'
import { useToast } from '@/hooks/use-toast'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ColumnDef, DataTable, FilterDef } from '@/features/datatable'
import { InvoiceStatusBadge } from './InvoiceStatusBadge'
import { InvoiceForm } from './components/InvoiceForm'
import { GenerateInvoiceDialog } from './components/GenerateInvoiceDialog'

export default function Invoices() {
  const { toast } = useToast()
  const router = useRouter()

  // Invoice form state
  const [isFormOpen, setIsFormOpen] = useState(false)
  // "Generate from Subscription" magic-button dialog
  const [isGenerateOpen, setIsGenerateOpen] = useState(false)

  // Query params
  const [queryParams, setQueryParams] = useState<InvoiceQueryParams>({
    limit: 10,
    page: 1,
    sortBy: 'invoiceDate',
    sortOrder: 'desc',
    search: '',
    includeDetails: true,
  })

  // Use React Query hooks
  const { data: invoicesData, isLoading, refetch } = useInvoices(queryParams)
  const { data: filtersData } = useFilters()

  // Derived state from React Query
  const invoices = invoicesData?.results || []
  const totalResults = invoicesData?.totalResults || 0
  const customers = filtersData?.customers || []
  const subscriptions = filtersData?.subscriptions || []

  // Format helpers
  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A'
    return formatDisplayDate(dateString, 'MMM dd, yyyy')
  }

  // Copy link helper
  const copyInvoiceLink = async (invoiceId: string) => {
    // Links go straight to checkout via `/i/{id}/pay` (route handler that
    // 302s to Stripe).
    const url = `${window.location.origin}/i/${invoiceId}/pay`
    try {
      await navigator.clipboard.writeText(url)
      toast({
        title: 'Link copied!',
        description: 'Public invoice link copied to clipboard.',
      })
    } catch {
      toast({
        title: 'Failed to copy',
        description: 'Please copy the URL manually.',
        variant: 'destructive',
      })
    }
  }

  // Table column definitions
  const columns: ColumnDef<Invoice>[] = [
    {
      id: 'invoiceNumber',
      header: 'Invoice #',
      accessorKey: 'invoiceNumber',
      cell: (invoice) => (
        <Link
          href={`/invoices/${invoice.id}`}
          className='font-medium text-primary hover:text-primary/80 hover:underline'
        >
          {invoice.invoiceNumber || (
            <span className='italic text-muted-foreground'>Draft</span>
          )}
        </Link>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      accessorFn: (invoice) => invoice.customer?.name || 'N/A',
    },
    {
      id: 'totalAmount',
      header: 'Amount',
      accessorKey: 'totalAmount',
      cell: (invoice) => (
        <span
          className={
            invoice.status === 'draft' ? 'italic text-muted-foreground' : ''
          }
        >
          {formatCurrency(invoice.totalAmount)}
        </span>
      ),
    },
    {
      id: 'invoiceDate',
      header: 'Invoice Date',
      accessorKey: 'invoiceDate',
      enableSorting: true,
      cell: (invoice) => (
        <span
          className={invoice.status === 'draft' ? 'text-muted-foreground' : ''}
        >
          {formatDate(invoice.invoiceDate)}
        </span>
      ),
    },
    {
      id: 'dueDate',
      header: 'Due Date',
      accessorKey: 'dueDate',
      cell: (invoice) => (
        <span
          className={
            invoice.status === 'overdue'
              ? 'text-destructive'
              : invoice.status === 'draft'
                ? 'text-muted-foreground'
                : ''
          }
        >
          {formatDate(invoice.dueDate)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableSorting: true,
      cell: (invoice) => (
        <InvoiceStatusBadge status={invoice.status} dueDate={invoice.dueDate} />
      ),
    },
    {
      id: 'subscription',
      header: 'Subscription',
      accessorFn: (invoice) => invoice.subscription?.name || 'N/A',
    },
    {
      id: 'actions',
      header: (
        <div className='flex h-full w-full items-center justify-end'>
          Actions
        </div>
      ),
      enableSorting: false,
      cell: (invoice) => (
        <div
          className='flex w-full items-center justify-end gap-2'
          onClick={(e) => e.stopPropagation()}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    router.push(`/invoices/${invoice.id}`)
                  }}
                >
                  <Eye className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View Invoice</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    copyInvoiceLink(invoice.id)
                  }}
                >
                  <Link2Icon className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy Link</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ),
    },
  ]

  // Filter definitions
  const filters: FilterDef<Invoice>[] = [
    {
      id: 'status',
      label: 'Status',
      type: 'select',
      onSearchBar: true, // Prominent on search bar
      options: [
        // DataTable adds the "All Statuses" option itself.
        // Values match the DB enum_invoices_status (canon I2), except
        // "pending": the enum lists it but no canon rule counts it, so
        // filtering by it would return zero results and mislead the user.
        { label: 'Draft', value: 'draft' },
        { label: 'Issued', value: 'issued' },
        { label: 'Paid', value: 'paid' },
        { label: 'Overdue', value: 'overdue' },
        { label: 'Refunded', value: 'refunded' },
        { label: 'Void', value: 'void' },
      ],
      clearValue: '',
      defaultValue: '',
    },
    {
      // The only way back to a future-dated invoice: the list stops at today.
      id: 'dateScope',
      label: 'Invoice date',
      type: 'select',
      onSearchBar: false,
      placeholder: 'Up to today',
      options: [{ label: 'Include scheduled', value: 'include-scheduled' }],
      clearValue: '',
      defaultValue: '',
    },
    {
      id: 'customerId',
      label: 'Customer',
      type: 'autocomplete',
      onSearchBar: false,
      options: customers.map((customer) => ({
        label: customer.name,
        value: customer.id,
      })),
      clearValue: '',
    },
    {
      id: 'subscriptionId',
      label: 'Subscription',
      type: 'autocomplete',
      onSearchBar: false,
      options: subscriptions.map((subscription) => ({
        label: subscription.name,
        value: subscription.id,
      })),
      clearValue: '',
    },
  ]

  return (
    <>
      <Page
        title='Invoices'
        headerProps={{
          breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Invoices' }],
        }}
      >
        <DataTable
          data={invoices}
          columns={columns}
          filters={filters}
          searchConfig={{
            placeholder: 'Search invoices...',
            paramKey: 'search',
            debounceTime: 300,
          }}
          paginationConfig={{
            pageParamKey: 'page',
            limitParamKey: 'limit',
            defaultPageSize: 10,
          }}
          onRowClick={(invoice) => router.push(`/invoices/${invoice.id}`)}
          isLoading={isLoading}
          onRefresh={refetch}
          totalResults={totalResults}
          queryParams={queryParams}
          setQueryParams={setQueryParams}
          actionButton={
            <div className='flex items-center gap-2'>
              {/* Primary: builds the draft's line items from usage in one click. */}
              <Button size='sm' onClick={() => setIsGenerateOpen(true)}>
                Generate from Subscription
              </Button>
              {/* Secondary: hand-built invoice for one-off custom cases the cron can't handle. */}
              <Button
                size='sm'
                variant='outline'
                onClick={() => setIsFormOpen(true)}
              >
                <PlusIcon className='mr-2 size-4' />
                New Invoice
              </Button>
            </div>
          }
        />
      </Page>

      {/* Invoice Form */}
      <InvoiceForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onOpenChange={setIsFormOpen}
        mode='create'
        onSuccess={() => {
          refetch()
        }}
      />

      {/* Generate from Subscription dialog */}
      <GenerateInvoiceDialog
        open={isGenerateOpen}
        onOpenChange={setIsGenerateOpen}
      />
    </>
  )
}
