'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Mail,
  MoreHorizontal,
  Edit,
  Printer,
  Copy,
  Calendar,
  Building2,
  CreditCard,
  ChevronRight,
  Clock,
  ArrowUpRight,
  AlertTriangle,
} from 'lucide-react'
import { Invoice, Customer, InvoiceSubscription } from '@/lib/api/invoices'
import { getInvoice as getInvoiceAction } from '@/app/actions/invoices'
import { formatCurrency } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { Button } from '@/components/ui/button'
import { Page } from '@/components/layouts/page'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DetailPageSkeleton } from '@/components/ui/detail-page-skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { InvoiceStatusBadge } from '@/features/invoices/InvoiceStatusBadge'
import {
  MarkPaidButton,
  VoidButton,
  FinalizeButton,
} from '@/features/invoices/InvoiceActions'
import { CopyLinkButton } from '@/features/invoices/CopyLinkButton'
import { InvoicePrintView } from '@/features/invoices/InvoicePrintView'
import { useSellerIdentity } from '@/features/invoices/useSellerIdentity'
import { InvoiceForm } from '@/features/invoices/components/InvoiceForm'
import { INVOICES_KEYS } from '@/services/invoices-service'
import { useCreateInvoice } from '@/features/invoices/useInvoiceMutations'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { InvoiceReminderPanel } from '@/features/invoices/InvoiceReminderPanel'
import { PaymentHistoryPanel } from '@/features/invoices/PaymentHistoryPanel'
import { SendInvoiceDialog } from '@/features/invoices/SendInvoiceDialog'

// --- Type Definitions ---
interface CustomerWithAddress extends Customer {
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  zipCode?: string
  country?: string
}

interface InvoiceItem {
  id: string
  invoiceId: string
  description: string
  quantity: string
  unitPrice: string
  amount: string
  type: string
  metadata?: Record<string, any>
}

interface InvoiceWithDetails extends Omit<
  Invoice,
  'customer' | 'subscription'
> {
  items: InvoiceItem[]
  customer: CustomerWithAddress
  subscription: InvoiceSubscription
  payments: Array<{
    date: string
    method: string
    amount: string
  }>
}

// --- API Fetching ---
const fetchInvoice = async (invoiceId: string): Promise<InvoiceWithDetails> => {
  if (!invoiceId) {
    throw new Error('Invoice ID is required')
  }
  const result = await getInvoiceAction(invoiceId, true)
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to fetch invoice')
  }
  const invoice = result.data as any
  return {
    ...invoice,
    customer: invoice.customer as CustomerWithAddress,
    subscription: invoice.subscription as InvoiceSubscription,
    items: invoice.items || invoice.lineItems || [],
    payments: invoice.payments || [],
  } as unknown as InvoiceWithDetails
}

// --- Component ---
export default function SingleInvoicePage() {
  const params = useParams()
  const invoiceId = params.invoiceId as string
  const router = useRouter()
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [isEditFormOpen, setIsEditFormOpen] = useState(false)
  const [isSendDialogOpen, setIsSendDialogOpen] = useState(false)
  const _queryClient = useQueryClient()
  const { mutate: createInvoice, isPending: isDuplicating } = useCreateInvoice()
  const seller = useSellerIdentity()

  const {
    data: invoice,
    isLoading,
    error,
    refetch,
  } = useQuery<InvoiceWithDetails, Error>({
    queryKey: INVOICES_KEYS.detail(invoiceId, true),
    queryFn: () => fetchInvoice(invoiceId),
    enabled: !!invoiceId,
  })

  const handleMutationSuccess = () => {
    refetch()
  }

  const handleDuplicate = () => {
    if (!invoice) return

    const today = new Date()
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)

    const loadingToast = toast.loading('Duplicating invoice...')

    createInvoice(
      {
        customerId: invoice.customerId,
        subscriptionId: invoice.subscriptionId || undefined,
        invoiceDate: today.toISOString().split('T')[0],
        dueDate: dueDate.toISOString().split('T')[0],
        taxAmount: parseFloat(invoice.taxAmount || '0'),
        discountAmount: parseFloat(invoice.discountAmount || '0'),
        memo: (invoice as any).memo || undefined,
        status: 'draft',
        items: invoice.items.map((item) => ({
          description: item.description,
          quantity: parseFloat(item.quantity),
          unitPrice: parseFloat(item.unitPrice),
          type: item.type as any,
        })),
      },
      {
        onSuccess: (newInvoice) => {
          loadingToast.dismiss()
          toast.success({
            title: 'Invoice duplicated',
            description: `New draft invoice ${newInvoice.invoiceNumber} created.`,
          })
          router.push(`/invoices/${newInvoice.id}`)
        },
        onError: () => {
          loadingToast.dismiss()
        },
      }
    )
  }

  const handleSendEmail = async () => {
    if (!invoice) return
    setIsSendDialogOpen(true)
  }

  const formatDate = (dateString: string | undefined) =>
    formatDisplayDate(dateString, 'MMM d, yyyy')

  if (isLoading) {
    return (
      <Page
        title='Loading...'
        headerProps={{
          breadcrumb: [
            { name: 'Invoices', href: '/invoices' },
            { name: 'Loading...' },
          ],
        }}
      >
        <DetailPageSkeleton statCards={3} showChart={false} />
      </Page>
    )
  }

  if (error) {
    return (
      <div className='container mx-auto p-4 text-red-600'>
        Error loading invoice: {error.message}
      </div>
    )
  }

  if (!invoice) {
    return <div className='container mx-auto p-4'>Invoice not found.</div>
  }

  const isDraft = invoice.status === 'draft'
  const isPaid = invoice.status === 'paid'
  const isVoid = invoice.status === 'void'
  const isIssued = invoice.status === 'issued'

  // Check if overdue
  const isOverdue =
    !isPaid &&
    !isVoid &&
    !isDraft &&
    invoice.dueDate &&
    new Date(invoice.dueDate) < new Date()
  const daysOverdue = isOverdue
    ? Math.floor(
        (new Date().getTime() - new Date(invoice.dueDate).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 0

  // Calculate balance
  const totalAmount = parseFloat(invoice.totalAmount || '0')
  const amountPaid = parseFloat(invoice.amountPaid || '0')
  const balance = totalAmount - amountPaid
  const hasPartialPayment = amountPaid > 0 && !isPaid

  // Get payment date for paid invoices
  const paidDate =
    isPaid && invoice.payments?.length > 0
      ? invoice.payments[invoice.payments.length - 1].date
      : null

  // Amount display logic
  const getAmountLabel = () => {
    if (isPaid) return 'Total Paid'
    if (hasPartialPayment) return 'Balance Due'
    if (isOverdue) return 'Past Due'
    return 'Amount Due'
  }

  const getDisplayAmount = () => {
    if (isPaid) return invoice.totalAmount
    if (hasPartialPayment) return balance.toString()
    return invoice.totalAmount
  }

  return (
    <Page
      title=''
      headerProps={{
        breadcrumb: [
          { name: 'Invoices', href: '/invoices' },
          { name: invoice.invoiceNumber || 'Draft' },
        ],
      }}
    >
      <div className='mx-auto max-w-5xl'>
        {/* Header Section */}
        <div className='mb-6'>
          <div className='flex items-start justify-between'>
            {/* Left: Title & Meta */}
            <div className='space-y-1'>
              <div className='flex items-center gap-3'>
                <h1 className='text-2xl font-semibold tracking-tight'>
                  {invoice.invoiceNumber || 'Draft Invoice'}
                </h1>
                <InvoiceStatusBadge
                  status={invoice.status}
                  dueDate={invoice.dueDate}
                  size='md'
                />
              </div>
              <div className='flex items-center gap-3 text-sm text-muted-foreground'>
                <Link
                  href={`/customers/${invoice.customer.id}`}
                  className='flex items-center gap-1.5 transition-colors hover:text-foreground'
                >
                  <Building2 className='h-3.5 w-3.5' />
                  {invoice.customer.name}
                </Link>
                <span className='text-border'>•</span>
                <span
                  className={cn(
                    'flex items-center gap-1.5',
                    isOverdue && 'font-medium text-destructive'
                  )}
                >
                  {isOverdue ? (
                    <AlertTriangle className='h-3.5 w-3.5' />
                  ) : (
                    <Calendar className='h-3.5 w-3.5' />
                  )}
                  {isOverdue
                    ? `${daysOverdue} days overdue`
                    : `Due ${formatDate(invoice.dueDate)}`}
                </span>
                {invoice.billingPeriodStart && (
                  <>
                    <span className='text-border'>•</span>
                    <span className='flex items-center gap-1.5'>
                      <Clock className='h-3.5 w-3.5' />
                      {formatDate(invoice.billingPeriodStart)} →{' '}
                      {formatDate(invoice.billingPeriodEnd)}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Right: Amount */}
            <div className='text-right'>
              <p
                className={cn(
                  'mb-1 text-sm',
                  isPaid
                    ? 'text-green-600 dark:text-green-400'
                    : isOverdue
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                )}
              >
                {getAmountLabel()}
                {isPaid && paidDate && (
                  <span className='ml-1'>• {formatDate(paidDate)}</span>
                )}
              </p>
              <p
                className={cn(
                  'text-3xl font-bold tabular-nums tracking-tight',
                  isPaid && 'text-green-600 dark:text-green-400',
                  isOverdue && 'text-destructive'
                )}
              >
                {formatCurrency(getDisplayAmount())}
              </p>
              {hasPartialPayment && (
                <p className='mt-1 text-xs text-muted-foreground'>
                  of {formatCurrency(invoice.totalAmount)} total
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Actions Bar */}
        <div className='mb-8 flex items-center gap-3 border-y py-3'>
          {/* Primary Send Action - Brand styled email button.
                Drafts show the Send button too, so a draft can be emailed for
                review before it is finalized and locked. */}
          {!isVoid && (
              <Button
                size='sm'
                onClick={handleSendEmail}
                className={cn(
                  'gap-2 bg-primary font-medium text-primary-foreground shadow-sm hover:bg-primary/90',
                  isOverdue && 'ring-2 ring-destructive/50 ring-offset-1'
                )}
              >
                <Mail className='h-4 w-4' />
                {isPaid ? 'Receipt' : isOverdue ? 'Reminder' : 'Invoice'}
              </Button>
            )}

          {/* Draft Edit */}
          {isDraft && (
              <Button
                variant='outline'
                size='sm'
                onClick={() => setIsEditFormOpen(true)}
              >
                <Edit className='mr-2 h-4 w-4' />
                Edit
              </Button>
            )}

          {isVoid && (
            <span className='text-sm text-muted-foreground'>
              Invoice voided
            </span>
          )}

          <div className='h-6 w-px bg-border' />

          {/* One print action on purpose: the browser print dialog IS the PDF
              download; a server-rendered PDF would be a separate route. */}
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setIsPreviewOpen(true)}
            title="To download a PDF, choose 'Save as PDF' in the print dialog"
          >
            <Printer className='mr-2 h-4 w-4' />
            Print / save PDF
          </Button>
          <Button
              variant='ghost'
              size='sm'
              onClick={handleDuplicate}
              disabled={isDuplicating}
            >
              <Copy className='mr-2 h-4 w-4' />
              Duplicate
            </Button>

          <div className='flex-1' />

          {/* Finalize Button - Prominent placement on right for drafts */}
          {isDraft && (
            <FinalizeButton
              invoiceId={invoice.id}
              invoiceNumber={invoice.invoiceNumber}
              status={invoice.status}
              onSuccess={handleMutationSuccess}
              variant='default'
              className='bg-emerald-600 text-white shadow-sm hover:bg-emerald-700'
            />
          )}

          {/* Mark Paid Button - Prominent placement on right for issued invoices */}
          {(isIssued || isOverdue) && !isPaid && !isVoid && (
            <MarkPaidButton
              invoiceId={invoice.id}
              invoiceNumber={invoice.invoiceNumber}
              status={invoice.status}
              onSuccess={handleMutationSuccess}
              variant='default'
              className='bg-emerald-600 text-white shadow-sm hover:bg-emerald-700'
            />
          )}

          {/* More Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='outline' size='sm'>
                <MoreHorizontal className='h-4 w-4' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align='end'
              className='w-48'
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <CopyLinkButton
                invoiceId={invoice.id}
                variant='ghost'
                size='sm'
                className='h-8 w-full cursor-pointer justify-start px-2 font-normal'
              />
              {!isVoid && !isPaid && (
                <>
                  <DropdownMenuSeparator />
                  <VoidButton
                    invoiceId={invoice.id}
                    invoiceNumber={invoice.invoiceNumber}
                    status={invoice.status}
                    onSuccess={handleMutationSuccess}
                    variant='ghost'
                    size='sm'
                    className='h-8 w-full justify-start px-2 font-normal text-destructive hover:text-destructive'
                  />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Two Column Layout */}
        <div className='grid grid-cols-3 gap-6'>
          {/* Main Content */}
          <div className='col-span-2 space-y-6'>
            {/* Line Items */}
            <section>
              <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
                Line Items
              </h2>
              <div className='overflow-hidden rounded-lg border bg-card'>
                <Table>
                  <TableHeader>
                    <TableRow className='bg-muted/30 hover:bg-muted/30'>
                      <TableHead className='font-medium'>Description</TableHead>
                      <TableHead className='w-24 text-right font-medium'>
                        Qty
                      </TableHead>
                      <TableHead className='w-32 text-right font-medium'>
                        Unit Price
                      </TableHead>
                      <TableHead className='w-32 text-right font-medium'>
                        Amount
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.items.map((item, index) => (
                      <TableRow
                        key={item.id}
                        className={index % 2 === 0 ? '' : 'bg-muted/20'}
                      >
                        <TableCell className='py-4'>
                          <div>
                            <span className='font-medium'>
                              {item.description}
                            </span>
                            {item.type && item.type !== 'onetime' && (
                              <Badge
                                variant='outline'
                                className='ml-2 text-xs font-normal'
                              >
                                {item.type}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {parseFloat(item.quantity).toFixed(2)}
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {formatCurrency(item.unitPrice)}
                        </TableCell>
                        <TableCell className='text-right font-medium tabular-nums'>
                          {formatCurrency(item.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Totals */}
                <div className='border-t bg-muted/20 p-5'>
                  <div className='flex justify-end'>
                    <div className='w-72 space-y-2'>
                      <div className='flex justify-between text-sm'>
                        <span className='text-muted-foreground'>Subtotal</span>
                        <span className='tabular-nums'>
                          {formatCurrency(invoice.subtotal)}
                        </span>
                      </div>
                      {parseFloat(invoice.taxAmount) > 0 && (
                        <div className='flex justify-between text-sm'>
                          <span className='text-muted-foreground'>Tax</span>
                          <span className='tabular-nums'>
                            {formatCurrency(invoice.taxAmount)}
                          </span>
                        </div>
                      )}
                      {parseFloat(invoice.discountAmount) > 0 && (
                        <div className='flex justify-between text-sm'>
                          <span className='text-muted-foreground'>
                            Discount
                          </span>
                          <span className='tabular-nums text-green-600'>
                            -{formatCurrency(invoice.discountAmount)}
                          </span>
                        </div>
                      )}
                      <div className='flex justify-between border-t pt-2 text-sm'>
                        <span className='font-medium'>Total</span>
                        <span className='font-semibold tabular-nums'>
                          {formatCurrency(invoice.totalAmount)}
                        </span>
                      </div>
                      {parseFloat(invoice.amountPaid) > 0 && (
                        <div className='flex justify-between text-sm'>
                          <span className='text-muted-foreground'>
                            Amount Paid
                          </span>
                          <span className='tabular-nums text-green-600'>
                            {formatCurrency(invoice.amountPaid)}
                          </span>
                        </div>
                      )}
                      {!isPaid && balance > 0 && (
                        <div className='flex justify-between border-t pt-2'>
                          <span className='font-semibold'>Balance Due</span>
                          <span className='text-lg font-bold tabular-nums'>
                            {formatCurrency(balance.toString())}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Payment History with Enhanced Details */}
            <PaymentHistoryPanel invoiceId={invoice.id} />
          </div>

          {/* Sidebar */}
          <div className='space-y-6'>
            {/* Customer Card */}
            <section>
              <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
                Bill To
              </h2>
              <div className='rounded-lg border bg-card p-5'>
                <p className='font-semibold'>{invoice.customer.name}</p>
                <p className='text-sm text-muted-foreground'>
                  {invoice.customer.email}
                </p>
                {invoice.customer.addressLine1 && (
                  <div className='mt-3 border-t pt-3 text-sm text-muted-foreground'>
                    <p>{invoice.customer.addressLine1}</p>
                    {invoice.customer.city && (
                      <p>
                        {invoice.customer.city}, {invoice.customer.state}{' '}
                        {invoice.customer.zipCode}
                      </p>
                    )}
                  </div>
                )}
                <Button
                  variant='outline'
                  size='sm'
                  className='mt-4 w-full'
                  asChild
                >
                  <Link href={`/customers/${invoice.customer.id}`}>
                    View Customer
                    <ArrowUpRight className='ml-2 h-3 w-3' />
                  </Link>
                </Button>
              </div>
            </section>

            {/* Invoice Details */}
            <section>
              <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
                Details
              </h2>
              <div className='space-y-4 rounded-lg border bg-card p-5'>
                <div className='flex justify-between'>
                  <span className='text-sm text-muted-foreground'>
                    Invoice Date
                  </span>
                  <span className='text-sm font-medium'>
                    {formatDate(invoice.invoiceDate)}
                  </span>
                </div>
                <div className='flex justify-between'>
                  <span className='text-sm text-muted-foreground'>
                    Due Date
                  </span>
                  <span className='text-sm font-medium'>
                    {formatDate(invoice.dueDate)}
                  </span>
                </div>
                <div className='flex justify-between'>
                  <span className='text-sm text-muted-foreground'>Terms</span>
                  <span className='text-sm font-medium'>Net 30</span>
                </div>
                {invoice.subscription && (
                  <div className='border-t pt-4'>
                    <Link
                      href={`/subscriptions/${invoice.subscription.id}`}
                      className='flex items-center justify-between text-sm hover:text-primary'
                    >
                      <span className='flex items-center gap-2'>
                        <CreditCard className='h-4 w-4' />
                        Subscription
                      </span>
                      <ChevronRight className='h-4 w-4' />
                    </Link>
                  </div>
                )}
              </div>
            </section>

            {/* Payment Reminders Panel - Only for issued/overdue invoices */}
            <InvoiceReminderPanel
              invoiceId={invoice.id}
              invoiceStatus={invoice.status}
            />
          </div>
        </div>
      </div>

      {/* Print Preview Dialog */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className='h-[90vh] max-w-5xl overflow-hidden p-0'>
          <div className='flex h-full flex-col'>
            <div className='flex items-center justify-between border-b p-4 pr-14'>
              <h2 className='text-lg font-semibold'>
                {invoice.invoiceNumber || 'Draft'}: Preview
              </h2>
              <Button
                size='sm'
                variant='outline'
                onClick={() => window.print()}
              >
                <Printer className='mr-2 h-4 w-4' />
                Print / Save as PDF
              </Button>
            </div>
            <div className='flex-1 overflow-auto bg-muted/30 p-4'>
              <div className='mx-auto max-w-3xl rounded-lg border bg-white shadow-sm'>
                <InvoicePrintView invoice={invoice} seller={seller} />
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Invoice Form */}
      <InvoiceForm
        isOpen={isEditFormOpen}
        onClose={() => setIsEditFormOpen(false)}
        onOpenChange={setIsEditFormOpen}
        mode='edit'
        invoice={invoice}
        onSuccess={() => {
          refetch()
        }}
      />

      {/* Send Invoice Dialog */}
      <SendInvoiceDialog
        invoice={{
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber || 'Draft',
          totalAmount: invoice.totalAmount,
          customer: invoice.customer
            ? {
                id: invoice.customer.id,
                name: invoice.customer.name,
                email: invoice.customer.email,
              }
            : undefined,
        }}
        open={isSendDialogOpen}
        onOpenChange={setIsSendDialogOpen}
      />
    </Page>
  )
}
