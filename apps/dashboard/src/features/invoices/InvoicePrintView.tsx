/**
 * Invoice Print View Component
 *
 * A clean, printable invoice layout that uses browser print + CSS.
 * No backend PDF generation required - browser handles "Save as PDF".
 */
import { forwardRef } from 'react'
import type { Invoice, Customer, InvoiceSubscription } from '@/lib/api/invoices'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { InvoiceStatusBadge } from './InvoiceStatusBadge'
import type { InvoiceSeller } from './billing-identity-display'

// Extended types for print view
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
  metadata?: Record<string, unknown>
}

interface InvoiceWithDetails extends Omit<
  Invoice,
  'customer' | 'subscription'
> {
  items: InvoiceItem[]
  customer: CustomerWithAddress
  subscription?: InvoiceSubscription
}

interface InvoicePrintViewProps {
  invoice: InvoiceWithDetails
  className?: string
  /**
   * The org's STORED billing identity (see sellerFromIdentity). Deliberately
   * no hardcoded default: undefined (still loading) renders no FROM block at
   * all rather than an invented one.
   */
  seller?: InvoiceSeller
}

/**
 * Format date for display
 */
function _formatDate(dateString: string | undefined): string {
  if (!dateString) return 'N/A'
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Format short date for display
 */
function formatShortDate(dateString: string | undefined): string {
  if (!dateString) return 'N/A'
  return formatDisplayDate(dateString, 'MMM d, yyyy')
}

export const InvoicePrintView = forwardRef<
  HTMLDivElement,
  InvoicePrintViewProps
>(({ invoice, className, seller }, ref) => {
  const hasAddress =
    invoice.customer.addressLine1 ||
    invoice.customer.city ||
    invoice.customer.state

  return (
    <div
      ref={ref}
      className={cn(
        'print-content mx-auto max-w-4xl bg-white p-8',
        'print:mx-0 print:max-w-none print:p-0',
        className
      )}
    >
      {/* Header - Company & Invoice Info */}
      <header className='print-header mb-8 flex items-start justify-between border-b-2 border-primary pb-6'>
        <div>
          <h1 className='text-3xl font-bold tracking-tight text-primary'>
            INVOICE
          </h1>
          <p className='mt-1 text-lg text-muted-foreground'>
            {invoice.invoiceNumber || 'DRAFT'}
          </p>
          <div className='mt-2'>
            <InvoiceStatusBadge
              status={invoice.status}
              dueDate={invoice.dueDate}
              size='md'
            />
          </div>
        </div>

        <div className='text-right text-sm'>
          {seller && (
            <>
              <p className='text-lg font-semibold text-primary'>
                {seller.name}
              </p>
              {seller.addressLine1 && (
                <p className='text-muted-foreground'>{seller.addressLine1}</p>
              )}
              {seller.addressLine2 && (
                <p className='text-muted-foreground'>{seller.addressLine2}</p>
              )}
              {(seller.city || seller.state || seller.postalCode) && (
                <p className='text-muted-foreground'>
                  {seller.city}
                  {seller.city && seller.state ? ', ' : ''}
                  {seller.state} {seller.postalCode}
                </p>
              )}
              {seller.country && (
                <p className='text-muted-foreground'>{seller.country}</p>
              )}
              {seller.email && (
                <p className='mt-2 text-muted-foreground'>{seller.email}</p>
              )}
            </>
          )}
        </div>
      </header>

      {/* Customer & Invoice Details */}
      <div className='mb-8 grid grid-cols-2 gap-8'>
        {/* Bill To */}
        <div>
          <p className='mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
            Bill To
          </p>
          <p className='text-lg font-semibold'>{invoice.customer.name}</p>
          <p className='text-muted-foreground'>{invoice.customer.email}</p>
          {hasAddress && (
            <div className='mt-1 text-muted-foreground'>
              {invoice.customer.addressLine1 && (
                <p>{invoice.customer.addressLine1}</p>
              )}
              {invoice.customer.addressLine2 && (
                <p>{invoice.customer.addressLine2}</p>
              )}
              {(invoice.customer.city ||
                invoice.customer.state ||
                invoice.customer.zipCode) && (
                <p>
                  {invoice.customer.city}
                  {invoice.customer.city && invoice.customer.state ? ', ' : ''}
                  {invoice.customer.state} {invoice.customer.zipCode}
                </p>
              )}
              {invoice.customer.country && <p>{invoice.customer.country}</p>}
            </div>
          )}
        </div>

        {/* Invoice Details */}
        <div className='text-right'>
          <div className='inline-block text-left'>
            <dl className='grid grid-cols-2 gap-x-4 gap-y-1 text-sm'>
              <dt className='text-muted-foreground'>Invoice Date:</dt>
              <dd className='font-medium'>
                {formatShortDate(invoice.invoiceDate)}
              </dd>

              <dt className='text-muted-foreground'>Due Date:</dt>
              <dd className='font-medium'>
                {formatShortDate(invoice.dueDate)}
              </dd>

              <dt className='text-muted-foreground'>Billing Period:</dt>
              <dd className='font-medium'>
                {formatShortDate(invoice.billingPeriodStart)} -{' '}
                {formatShortDate(invoice.billingPeriodEnd)}
              </dd>

              {invoice.subscription && (
                <>
                  <dt className='text-muted-foreground'>Subscription:</dt>
                  <dd className='font-medium'>{invoice.subscription.name}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </div>

      {/* Line Items Table */}
      <div className='mb-8'>
        <table className='w-full'>
          <thead>
            <tr className='border-b-2 border-gray-200'>
              <th className='py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Description
              </th>
              <th className='w-20 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Qty
              </th>
              <th className='w-28 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Unit Price
              </th>
              <th className='w-28 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id} className='border-b border-gray-100'>
                <td className='py-4'>
                  <p className='font-medium'>{item.description}</p>
                  {item.type && item.type !== 'subscription' && (
                    <p className='mt-0.5 text-xs capitalize text-muted-foreground'>
                      {item.type}
                    </p>
                  )}
                </td>
                <td className='font-tabular py-4 text-right'>
                  {parseFloat(item.quantity).toFixed(2)}
                </td>
                <td className='font-tabular py-4 text-right'>
                  {formatCurrency(item.unitPrice)}
                </td>
                <td className='font-tabular py-4 text-right font-medium'>
                  {formatCurrency(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals Section */}
      <div className='mb-8 flex justify-end'>
        <div className='w-72'>
          <div className='space-y-2 text-sm'>
            <div className='flex justify-between py-1'>
              <span className='text-muted-foreground'>Subtotal</span>
              <span className='font-tabular'>
                {formatCurrency(invoice.subtotal)}
              </span>
            </div>

            {parseFloat(invoice.taxAmount) > 0 && (
              <div className='flex justify-between py-1'>
                <span className='text-muted-foreground'>Tax</span>
                <span className='font-tabular'>
                  {formatCurrency(invoice.taxAmount)}
                </span>
              </div>
            )}

            {parseFloat(invoice.discountAmount) > 0 && (
              <div className='flex justify-between py-1'>
                <span className='text-muted-foreground'>Discount</span>
                <span className='font-tabular text-secondary-dark'>
                  -{formatCurrency(invoice.discountAmount)}
                </span>
              </div>
            )}

            {parseFloat(invoice.amountPaid) > 0 && (
              <div className='flex justify-between py-1'>
                <span className='text-muted-foreground'>Amount Paid</span>
                <span className='font-tabular text-secondary-dark'>
                  -{formatCurrency(invoice.amountPaid)}
                </span>
              </div>
            )}

            {parseFloat(invoice.amountCredited) > 0 && (
              <div className='flex justify-between py-1'>
                <span className='text-muted-foreground'>Credits Applied</span>
                <span className='font-tabular text-secondary-dark'>
                  -{formatCurrency(invoice.amountCredited)}
                </span>
              </div>
            )}

            <div className='mt-2 flex justify-between border-t-2 border-gray-200 py-2'>
              <span className='text-base font-semibold'>Amount Due</span>
              <span className='font-tabular text-lg font-bold'>
                {formatCurrency(invoice.totalAmount)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className='print-footer mt-12 hidden border-t pt-6 text-center print:block'>
        <p className='text-muted-foreground'>Thank you for your business</p>
      </footer>
    </div>
  )
})

InvoicePrintView.displayName = 'InvoicePrintView'
