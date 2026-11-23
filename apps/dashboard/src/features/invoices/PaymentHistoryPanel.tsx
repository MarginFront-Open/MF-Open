/**
 * Payment History Panel
 *
 * Displays detailed payment history for an invoice with:
 * - Payment method and card details
 * - Stripe fees and net amounts
 * - Refund status and history (display only — refunds are initiated in
 *   Stripe directly; MarginFront listens to webhooks and reflects state)
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getInvoicePayments as getInvoicePaymentsAction } from '@/app/actions/invoices'
import { INVOICES_KEYS } from '@/services/invoices-service'
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import {
  InvoicePayment,
  EnhancedPaymentHistoryResponse,
} from '@/lib/api/invoices'
import { formatCurrency } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { Badge } from '@/components/ui/badge'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

interface PaymentHistoryPanelProps {
  invoiceId: string
}

// Card brand icons/names
const cardBrandDisplay: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
}

// Payment status icons
const statusConfig = {
  succeeded: {
    icon: CheckCircle2,
    color: 'text-green-500',
    badge:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  },
  failed: {
    icon: XCircle,
    color: 'text-red-500',
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
  pending: {
    icon: Clock,
    color: 'text-yellow-500',
    badge:
      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  },
}

export function PaymentHistoryPanel({ invoiceId }: PaymentHistoryPanelProps) {
  const [expandedPayments, setExpandedPayments] = useState<Set<string>>(
    new Set()
  )

  // Fetch enhanced payment history via Server Action.
  // Uses canonical INVOICES_KEYS.payments(invoiceId) so useMarkInvoicePaid's
  // invalidation (same key) actually refreshes this panel.
  const { data, isLoading, error } = useQuery<EnhancedPaymentHistoryResponse>({
    queryKey: INVOICES_KEYS.payments(invoiceId),
    queryFn: async () => {
      const result = await getInvoicePaymentsAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch payment history')
      }
      // The Server Action returns { payments: [...], summary: {...} }.
      // Pull the array out so we can re-calculate the summary client-side.
      const raw = result.data as any
      const payments: InvoicePayment[] = Array.isArray(raw)
        ? raw
        : (raw.payments ?? [])
      const totalPaid = payments.reduce(
        (sum, p) => sum + parseFloat(p.amount || '0'),
        0
      )
      const totalRefunded = payments.reduce(
        (sum, p) => sum + parseFloat(p.refundedAmount || '0'),
        0
      )
      return {
        payments,
        summary: {
          totalPaid,
          totalRefunded,
          netAmount: totalPaid - totalRefunded,
          paymentCount: payments.length,
          refundCount: payments.filter(
            (p) => p.refundStatus && p.refundStatus !== 'none'
          ).length,
        },
      }
    },
    enabled: !!invoiceId,
  })

  const togglePaymentExpanded = (paymentId: string) => {
    setExpandedPayments((prev) => {
      const next = new Set(prev)
      if (next.has(paymentId)) {
        next.delete(paymentId)
      } else {
        next.add(paymentId)
      }
      return next
    })
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  if (isLoading) {
    return (
      <section>
        <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
          Payments
        </h2>
        <div className='flex items-center justify-center rounded-lg border bg-card p-8'>
          <Loader2 className='h-6 w-6 animate-spin text-muted-foreground' />
        </div>
      </section>
    )
  }

  // Show error state if fetch failed
  if (error) {
    return (
      <section>
        <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
          Payments
        </h2>
        <div className='rounded-lg border bg-card p-6'>
          <div className='flex items-center gap-3 text-muted-foreground'>
            <AlertTriangle className='h-5 w-5 text-amber-500' />
            <div>
              <p className='font-medium text-foreground'>
                Unable to load payment history
              </p>
              <p className='mt-1 text-sm'>
                Please refresh the page or try again later.
              </p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  // Don't show section if no payments
  if (!data?.payments?.length) {
    return null
  }

  const { payments, summary } = data

  return (
    <section>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-sm font-medium uppercase tracking-wider text-muted-foreground'>
          Payments
        </h2>
        {summary.refundCount > 0 && (
          <Badge variant='outline' className='text-xs'>
            {summary.refundCount} refund{summary.refundCount !== 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      <div className='divide-y rounded-lg border bg-card'>
        {payments.map((payment) => {
          const isExpanded = expandedPayments.has(payment.id)
          const status = statusConfig[payment.status] || statusConfig.pending
          const StatusIcon = status.icon
          const hasRefunds = payment.refunds && payment.refunds.length > 0

          return (
            <div key={payment.id}>
              {/* Payment Row */}
              <div
                className='flex cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30'
                onClick={() => togglePaymentExpanded(payment.id)}
              >
                <div className='flex items-center gap-3'>
                  <StatusIcon className={`h-5 w-5 ${status.color}`} />
                  <div>
                    <div className='flex items-center gap-2'>
                      {/* UTC calendar day, matching Collected's windowing (canon I3/W1) */}
                      <p className='font-medium'>
                        {formatDisplayDate(payment.paymentDate)}
                      </p>
                      {payment.cardLast4 && (
                        <span className='flex items-center gap-1 text-sm text-muted-foreground'>
                          <CreditCard className='h-3 w-3' />
                          {cardBrandDisplay[payment.cardBrand || ''] ||
                            payment.cardBrand}{' '}
                          •••• {payment.cardLast4}
                        </span>
                      )}
                    </div>
                    <div className='mt-0.5 flex items-center gap-2'>
                      <p className='text-sm capitalize text-muted-foreground'>
                        {payment.paymentMethod}
                      </p>
                      {payment.refundStatus &&
                        payment.refundStatus !== 'none' && (
                          <Badge
                            variant='outline'
                            className={
                              payment.refundStatus === 'full'
                                ? 'border-red-200 text-red-600'
                                : 'border-orange-200 text-orange-600'
                            }
                          >
                            {payment.refundStatus === 'full'
                              ? 'Fully Refunded'
                              : 'Partial Refund'}
                          </Badge>
                        )}
                    </div>
                  </div>
                </div>
                <div className='flex items-center gap-3'>
                  <div className='text-right'>
                    <p
                      className={`font-semibold tabular-nums ${
                        payment.refundStatus === 'full'
                          ? 'text-muted-foreground line-through'
                          : 'text-green-600'
                      }`}
                    >
                      +{formatCurrency(payment.amount)}
                    </p>
                    {parseFloat(payment.refundedAmount || '0') > 0 && (
                      <p className='text-xs tabular-nums text-red-500'>
                        -{formatCurrency(payment.refundedAmount!)} refunded
                      </p>
                    )}
                  </div>
                  {isExpanded ? (
                    <ChevronUp className='h-4 w-4 text-muted-foreground' />
                  ) : (
                    <ChevronDown className='h-4 w-4 text-muted-foreground' />
                  )}
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div className='border-t bg-muted/20 px-4 pb-4'>
                  <div className='grid grid-cols-2 gap-4 pt-4 text-sm'>
                    {/* Fee & Net Amount */}
                    {payment.providerFee && (
                      <>
                        <div>
                          <span className='text-muted-foreground'>
                            Processing Fee
                          </span>
                          <p className='font-medium tabular-nums text-red-500'>
                            -{formatCurrency(payment.providerFee)}
                          </p>
                        </div>
                        <div>
                          <span className='text-muted-foreground'>
                            Net Amount
                          </span>
                          <p className='font-medium tabular-nums'>
                            {formatCurrency(payment.netAmount || '0')}
                          </p>
                        </div>
                      </>
                    )}

                    {/* Transaction ID */}
                    {payment.providerTransactionId && (
                      <div className='col-span-2'>
                        <span className='text-muted-foreground'>
                          Transaction ID
                        </span>
                        <p className='mt-0.5 font-mono text-xs'>
                          {payment.providerTransactionId}
                        </p>
                      </div>
                    )}

                    {/* Receipt Link */}
                    {payment.receiptUrl && (
                      <div className='col-span-2'>
                        <a
                          href={payment.receiptUrl}
                          target='_blank'
                          rel='noopener noreferrer'
                          className='inline-flex items-center gap-1 text-primary hover:underline'
                        >
                          View Stripe Receipt
                          <ExternalLink className='h-3 w-3' />
                        </a>
                      </div>
                    )}
                  </div>

                  {/* Refund History */}
                  {hasRefunds && (
                    <div className='mt-4 border-t pt-4'>
                      <p className='mb-2 text-sm font-medium'>Refund History</p>
                      <div className='space-y-2'>
                        {payment.refunds!.map((refund) => (
                          <div
                            key={refund.id}
                            className='flex items-center justify-between rounded bg-muted/50 p-2 text-sm'
                          >
                            <div className='flex items-center gap-2'>
                              {refund.status === 'succeeded' ? (
                                <CheckCircle2 className='h-4 w-4 text-green-500' />
                              ) : refund.status === 'failed' ? (
                                <XCircle className='h-4 w-4 text-red-500' />
                              ) : (
                                <Clock className='h-4 w-4 text-yellow-500' />
                              )}
                              <span>
                                {formatDate(refund.createdAt)} at{' '}
                                {formatTime(refund.createdAt)}
                              </span>
                              {refund.reason && (
                                <Badge
                                  variant='outline'
                                  className='text-xs capitalize'
                                >
                                  {refund.reason.replace(/_/g, ' ')}
                                </Badge>
                              )}
                            </div>
                            <span className='font-medium tabular-nums text-red-500'>
                              -{formatCurrency(refund.amount)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Summary Footer */}
        {payments.length > 0 && (
          <div className='bg-muted/30 p-4'>
            <div className='flex justify-between text-sm'>
              <span className='text-muted-foreground'>Total Collected</span>
              <span className='font-semibold tabular-nums text-green-600'>
                {formatCurrency(summary.totalPaid.toString())}
              </span>
            </div>
            {summary.totalRefunded > 0 && (
              <div className='mt-1 flex justify-between text-sm'>
                <span className='text-muted-foreground'>Total Refunded</span>
                <span className='font-semibold tabular-nums text-red-500'>
                  -{formatCurrency(summary.totalRefunded.toString())}
                </span>
              </div>
            )}
            {summary.totalRefunded > 0 && (
              <div className='mt-2 flex justify-between border-t pt-2 text-sm'>
                <span className='flex items-center gap-1.5 font-medium'>
                  Net Collected
                  <InfoTooltip {...tooltipDefinitions.netCollected} />
                </span>
                <span className='font-bold tabular-nums'>
                  {formatCurrency(summary.netAmount.toString())}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
