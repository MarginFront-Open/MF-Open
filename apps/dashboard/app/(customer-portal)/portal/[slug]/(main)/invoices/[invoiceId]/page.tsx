import { redirect, notFound } from 'next/navigation'
import { getCustomerSession } from '@/app/lib/portal-auth'
import { db as prisma } from '@/app/lib/db'
import Link from 'next/link'
import { formatCurrency } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  ArrowLeft,
  Download,
  Clock,
  Calendar,
  CreditCard,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// Helper to convert hex to rgba
function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(0, 0, 0, ${alpha})`
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
}

interface InvoiceDetailPageProps {
  params: Promise<{ slug: string; invoiceId: string }>
}

export default async function InvoiceDetailPage({
  params,
}: InvoiceDetailPageProps) {
  const { slug, invoiceId } = await params
  const session = await getCustomerSession()

  if (!session) {
    redirect(`/${slug}/login`)
  }

  // Fetch invoice with line items
  const invoice = await prisma.invoices.findFirst({
    where: {
      id: invoiceId,
      customerId: session.customerId,
      organizationId: session.organizationId,
      deletedAt: null,
    },
    include: {
      invoice_line_items: { where: { deletedAt: null } },
      invoice_payments: {
        where: { status: 'succeeded' },
      },
    },
  })

  if (!invoice) {
    notFound()
  }

  const { brandColors } = session

  return (
    <div className='space-y-6'>
      {/* Back link — return to portal home (invoices list lives there) */}
      <Link
        href={`/${slug}/`}
        className='inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground'
      >
        <ArrowLeft className='h-4 w-4' />
        Back to portal
      </Link>

      {/* Invoice Header Card */}
      <Card className='overflow-hidden'>
        <div className='h-2' style={{ backgroundColor: brandColors.primary }} />
        <CardContent className='p-6'>
          <div className='flex flex-col gap-4 md:flex-row md:items-start md:justify-between'>
            <div className='flex items-start gap-4'>
              <div
                className='flex h-12 w-12 shrink-0 items-center justify-center rounded-xl'
                style={{ backgroundColor: hexToRgba(brandColors.primary, 0.1) }}
              >
                <FileText
                  className='h-6 w-6'
                  style={{ color: brandColors.primary }}
                />
              </div>
              <div>
                <div className='flex flex-wrap items-center gap-3'>
                  <h1 className='text-2xl font-bold text-foreground'>
                    {invoice.invoiceNumber}
                  </h1>
                  <StatusBadge
                    status={invoice.status || 'draft'}
                    brandColors={brandColors}
                  />
                </div>
                <p className='mt-1 text-muted-foreground'>
                  {session.organizationName}
                </p>
              </div>
            </div>
            <div className='flex flex-wrap items-center gap-3'>
              {invoice.pdfUrl && (
                <Button variant='outline' asChild>
                  <a
                    href={invoice.pdfUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                  >
                    <Download className='mr-2 h-4 w-4' />
                    Download PDF
                  </a>
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Overview Card */}
      <Card
        className='border-2'
        style={{ borderColor: hexToRgba(brandColors.primary, 0.3) }}
      >
        <CardContent className='p-0'>
          <div
            className='flex items-center gap-3 border-b p-4'
            style={{ backgroundColor: hexToRgba(brandColors.primary, 0.05) }}
          >
            <div
              className='flex h-9 w-9 items-center justify-center rounded-lg'
              style={{ backgroundColor: brandColors.primary }}
            >
              <Sparkles className='h-4 w-4 text-white' />
            </div>
            <div>
              <span className='text-sm font-semibold text-foreground'>
                Invoice Details
              </span>
              <p className='text-xs text-muted-foreground'>
                Key information at a glance
              </p>
            </div>
          </div>
          <div className='grid grid-cols-2 divide-x divide-y divide-border lg:grid-cols-4 lg:divide-y-0'>
            <InfoStat
              icon={Calendar}
              label='Invoice Date'
              value={formatDisplayDate(invoice.invoiceDate)}
              brandColors={brandColors}
            />
            <InfoStat
              icon={Clock}
              label='Due Date'
              value={formatDisplayDate(invoice.dueDate)}
              brandColors={brandColors}
            />
            <InfoStat
              icon={Calendar}
              label='Billing Period'
              value={`${formatDisplayDate(invoice.billingPeriodStart, 'MMM d')} - ${formatDisplayDate(invoice.billingPeriodEnd, 'MMM d')}`}
              brandColors={brandColors}
            />
            <InfoStat
              icon={CreditCard}
              label='Currency'
              value={invoice.currency}
              brandColors={brandColors}
            />
          </div>
        </CardContent>
      </Card>

      {/* Line Items */}
      <Card>
        <CardHeader className='pb-4'>
          <div className='flex items-center gap-3'>
            <div
              className='flex h-9 w-9 items-center justify-center rounded-lg'
              style={{ backgroundColor: hexToRgba(brandColors.primary, 0.1) }}
            >
              <FileText
                className='h-4 w-4'
                style={{ color: brandColors.primary }}
              />
            </div>
            <div>
              <CardTitle className='text-base'>Line Items</CardTitle>
              <CardDescription>Detailed breakdown of charges</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className='p-0'>
          <Table>
            <TableHeader>
              <TableRow className='hover:bg-transparent'>
                <TableHead className='w-[50%]'>Description</TableHead>
                <TableHead className='text-right'>Quantity</TableHead>
                <TableHead className='text-right'>Unit Price</TableHead>
                <TableHead className='text-right'>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.invoice_line_items.map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell className='font-medium text-foreground'>
                    {item.description}
                  </TableCell>
                  <TableCell className='text-right text-muted-foreground'>
                    {Number(item.quantity).toFixed(2)}
                  </TableCell>
                  <TableCell className='text-right text-muted-foreground'>
                    {formatCurrency(Number(item.unitPrice), undefined, 4)}
                  </TableCell>
                  <TableCell className='text-right font-semibold text-foreground'>
                    {formatCurrency(Number(item.amount))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Totals */}
          <div
            className='border-t border-border px-6 py-5'
            style={{ backgroundColor: hexToRgba(brandColors.primary, 0.02) }}
          >
            <div className='ml-auto flex max-w-xs flex-col gap-2'>
              <div className='flex justify-between text-sm'>
                <span className='text-muted-foreground'>Subtotal</span>
                <span className='font-medium text-foreground'>
                  {formatCurrency(Number(invoice.subtotal))}
                </span>
              </div>
              {invoice.taxAmount && Number(invoice.taxAmount) > 0 && (
                <div className='flex justify-between text-sm'>
                  <span className='text-muted-foreground'>Tax</span>
                  <span className='font-medium text-foreground'>
                    {formatCurrency(Number(invoice.taxAmount))}
                  </span>
                </div>
              )}
              {invoice.discountAmount && Number(invoice.discountAmount) > 0 && (
                <div className='flex justify-between text-sm'>
                  <span className='text-muted-foreground'>Discount</span>
                  <span className='font-medium text-green-600 dark:text-green-500'>
                    -{formatCurrency(Number(invoice.discountAmount))}
                  </span>
                </div>
              )}
              <div className='mt-2 flex justify-between border-t border-border pt-3 text-lg font-bold'>
                <span className='text-foreground'>Total</span>
                <span className='text-foreground'>
                  {formatCurrency(Number(invoice.totalAmount))}
                </span>
              </div>
              {Number(invoice.amountPaid) > 0 && (
                <div className='flex justify-between text-sm'>
                  <span className='text-muted-foreground'>Amount Paid</span>
                  <span className='font-medium text-green-600 dark:text-green-500'>
                    {formatCurrency(Number(invoice.amountPaid))}
                  </span>
                </div>
              )}
              {Number(invoice.amountDue) > 0 && (
                <div className='mt-2 flex justify-between border-t border-border pt-3 text-lg font-bold'>
                  <span className='text-foreground'>Amount Due</span>
                  <span style={{ color: brandColors.primary }}>
                    {formatCurrency(Number(invoice.amountDue))}
                  </span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Payment History */}
      {invoice.invoice_payments.length > 0 && (
        <Card>
          <CardHeader className='pb-4'>
            <div className='flex items-center gap-3'>
              <div
                className='flex h-9 w-9 items-center justify-center rounded-lg'
                style={{ backgroundColor: hexToRgba(brandColors.primary, 0.1) }}
              >
                <CreditCard
                  className='h-4 w-4'
                  style={{ color: brandColors.primary }}
                />
              </div>
              <div>
                <CardTitle className='text-base'>Payment History</CardTitle>
                <CardDescription>Record of payments received</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            <div className='divide-y divide-border'>
              {invoice.invoice_payments.map((payment: any) => (
                <div
                  key={payment.id}
                  className='flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30'
                >
                  <div className='flex items-center gap-4'>
                    <div
                      className='flex h-10 w-10 items-center justify-center rounded-lg'
                      style={{
                        backgroundColor: hexToRgba(brandColors.primary, 0.1),
                      }}
                    >
                      <CheckCircle2
                        className='h-5 w-5'
                        style={{ color: brandColors.primary }}
                      />
                    </div>
                    <div>
                      <p className='font-semibold text-foreground'>
                        {formatCurrency(Number(payment.amount))}
                      </p>
                      <p className='text-sm text-muted-foreground'>
                        {formatDisplayDate(payment.paymentDate)} via{' '}
                        {payment.paymentMethod}
                      </p>
                    </div>
                  </div>
                  <Badge
                    style={{
                      backgroundColor: hexToRgba(brandColors.primary, 0.1),
                      color: brandColors.primary,
                    }}
                  >
                    <CheckCircle2 className='mr-1 h-3 w-3' />
                    Succeeded
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function InfoStat({
  icon: Icon,
  label,
  value,
  brandColors,
}: {
  icon: React.ElementType
  label: string
  value: string
  brandColors: { primary: string; secondary: string; accent: string }
}) {
  return (
    <div className='p-4 text-center transition-colors hover:bg-muted/30'>
      <div
        className='mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg'
        style={{ backgroundColor: hexToRgba(brandColors.primary, 0.1) }}
      >
        <Icon className='h-4 w-4' style={{ color: brandColors.primary }} />
      </div>
      <p className='text-sm font-semibold text-foreground'>{value}</p>
      <p className='text-xs text-muted-foreground'>{label}</p>
    </div>
  )
}

function StatusBadge({
  status,
  brandColors,
}: {
  status: string
  brandColors: { primary: string; secondary: string; accent: string }
}) {
  const config: Record<
    string,
    { bg: string; text: string; icon?: React.ElementType }
  > = {
    paid: {
      bg: hexToRgba(brandColors.primary, 0.1),
      text: brandColors.primary,
      icon: CheckCircle2,
    },
    pending: { bg: 'rgba(245, 158, 11, 0.1)', text: '#f59e0b', icon: Clock },
    issued: { bg: 'rgba(107, 114, 128, 0.1)', text: '#6b7280' },
    overdue: {
      bg: 'rgba(239, 68, 68, 0.1)',
      text: '#ef4444',
      icon: AlertTriangle,
    },
    draft: { bg: 'rgba(107, 114, 128, 0.1)', text: '#6b7280' },
    void: { bg: 'rgba(107, 114, 128, 0.1)', text: '#6b7280' },
  }

  const { bg, text, icon: StatusIcon } = config[status] || config.draft

  return (
    <span
      className='inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium'
      style={{ backgroundColor: bg, color: text }}
    >
      {StatusIcon && <StatusIcon className='h-3 w-3' />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}
