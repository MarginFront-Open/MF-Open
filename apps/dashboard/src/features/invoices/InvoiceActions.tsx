/**
 * Invoice Action Components
 *
 * Reusable action buttons for invoice operations:
 * - MarkPaidButton: Mark a finalized invoice as paid
 * - VoidButton: Void an invoice (draft or finalized)
 * - FinalizeButton: Finalize a draft invoice
 * - PrintButton: Trigger browser print dialog
 */
import { useState, useRef } from 'react'
import { CheckCircle, Ban, FileCheck, Printer, Loader2 } from 'lucide-react'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { canManageMoney } from '@/lib/permissions'
import type { Invoice } from '@/lib/api/invoices'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button, ButtonProps } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InvoicePrintView } from './InvoicePrintView'
import { useSellerIdentity } from './useSellerIdentity'
import {
  getAvailableActions,
  mapLegacyStatus,
  type LegacyInvoiceStatus,
  type InvoiceStatusType,
} from './invoiceStateMachine'
import {
  useMarkInvoicePaid,
  useVoidInvoice,
  useFinalizeInvoice,
} from './useInvoiceMutations'

// Extended invoice type for actions
interface InvoiceWithDetails extends Omit<
  Invoice,
  'customer' | 'subscription'
> {
  items: Array<{
    id: string
    invoiceId: string
    description: string
    quantity: string
    unitPrice: string
    amount: string
    type: string
    metadata?: Record<string, unknown>
  }>
  customer: NonNullable<Invoice['customer']> & {
    addressLine1?: string
    addressLine2?: string
    city?: string
    state?: string
    zipCode?: string
    country?: string
  }
  subscription?: Invoice['subscription']
}

interface ActionButtonProps extends Omit<ButtonProps, 'onClick'> {
  invoiceId: string
  invoiceNumber?: string
  onSuccess?: () => void
}

// ============================================
// MARK AS PAID BUTTON
// ============================================

interface MarkPaidButtonProps extends ActionButtonProps {
  status: InvoiceStatusType | LegacyInvoiceStatus
}

export function MarkPaidButton({
  invoiceId,
  invoiceNumber,
  status,
  onSuccess,
  ...buttonProps
}: MarkPaidButtonProps) {
  const { mutate, isPending } = useMarkInvoicePaid({ onSuccess })
  const { organization } = useCurrentOrganization()
  const normalizedStatus = mapLegacyStatus(status as LegacyInvoiceStatus)
  const availableActions = getAvailableActions(normalizedStatus)

  // Only show if markPaid is available AND the viewer's role can manage
  // money (cosmetic — the server's assertMoneyManager is the real gate).
  if (
    !availableActions.includes('markPaid') ||
    !canManageMoney(organization?.role)
  ) {
    return null
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          disabled={isPending}
          {...buttonProps}
        >
          {isPending ? (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          ) : (
            <CheckCircle className='mr-2 h-4 w-4' />
          )}
          Mark as Paid
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark Invoice as Paid?</AlertDialogTitle>
          <AlertDialogDescription>
            This will mark invoice{' '}
            <span className='font-medium'>{invoiceNumber || invoiceId}</span> as
            paid. A payment record will be created with today&apos;s date.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutate(invoiceId)}
            className='bg-secondary hover:bg-secondary/90'
          >
            {isPending ? (
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            ) : (
              <CheckCircle className='mr-2 h-4 w-4' />
            )}
            Confirm Payment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================
// VOID BUTTON
// ============================================

interface VoidButtonProps extends ActionButtonProps {
  status: InvoiceStatusType | LegacyInvoiceStatus
}

export function VoidButton({
  invoiceId,
  invoiceNumber,
  status,
  onSuccess,
  ...buttonProps
}: VoidButtonProps) {
  const { mutate, isPending } = useVoidInvoice({ onSuccess })
  const { organization } = useCurrentOrganization()
  const normalizedStatus = mapLegacyStatus(status as LegacyInvoiceStatus)
  const availableActions = getAvailableActions(normalizedStatus)

  // Only show if void is available AND the viewer's role can manage money
  // (cosmetic — the server's assertMoneyManager is the real gate).
  if (
    !availableActions.includes('void') ||
    !canManageMoney(organization?.role)
  ) {
    return null
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          disabled={isPending}
          className='text-destructive hover:text-destructive'
          {...buttonProps}
        >
          {isPending ? (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          ) : (
            <Ban className='mr-2 h-4 w-4' />
          )}
          Void Invoice
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void Invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            This will void invoice{' '}
            <span className='font-medium'>{invoiceNumber || invoiceId}</span>.
            This action cannot be undone. The invoice will be marked as voided
            and will not be counted in revenue reports.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutate(invoiceId)}
            className='bg-destructive hover:bg-destructive/90'
          >
            {isPending ? (
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            ) : (
              <Ban className='mr-2 h-4 w-4' />
            )}
            Void Invoice
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================
// FINALIZE BUTTON
// ============================================

interface FinalizeButtonProps extends ActionButtonProps {
  status: InvoiceStatusType | LegacyInvoiceStatus
}

export function FinalizeButton({
  invoiceId,
  invoiceNumber,
  status,
  onSuccess,
  ...buttonProps
}: FinalizeButtonProps) {
  const { mutate, isPending } = useFinalizeInvoice({ onSuccess })
  const { organization } = useCurrentOrganization()
  const normalizedStatus = mapLegacyStatus(status as LegacyInvoiceStatus)
  const availableActions = getAvailableActions(normalizedStatus)

  // Only show if finalize is available AND the viewer's role can manage
  // money (cosmetic — the server's assertMoneyManager is the real gate).
  if (
    !availableActions.includes('finalize') ||
    !canManageMoney(organization?.role)
  ) {
    return null
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant='default'
          size='sm'
          disabled={isPending}
          {...buttonProps}
        >
          {isPending ? (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          ) : (
            <FileCheck className='mr-2 h-4 w-4' />
          )}
          Finalize Invoice
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Finalize Invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            This will finalize the draft invoice and assign an invoice number.
            Once finalized, the invoice cannot be edited and will be ready for
            payment collection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => mutate(invoiceId)}>
            {isPending ? (
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            ) : (
              <FileCheck className='mr-2 h-4 w-4' />
            )}
            Finalize
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================
// PRINT BUTTON
// ============================================

interface PrintButtonProps extends Omit<ButtonProps, 'onClick'> {
  invoice: InvoiceWithDetails
}

export function PrintButton({ invoice, ...buttonProps }: PrintButtonProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const seller = useSellerIdentity()

  const handlePrint = () => {
    // Open preview dialog first, then trigger print
    setIsPreviewOpen(true)
  }

  const triggerPrint = () => {
    window.print()
  }

  return (
    <>
      <Button
        variant='outline'
        size='sm'
        onClick={handlePrint}
        {...buttonProps}
      >
        <Printer className='mr-2 h-4 w-4' />
        Print Invoice
      </Button>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className='max-h-[90vh] max-w-4xl overflow-y-auto'>
          <DialogHeader className='no-print'>
            <DialogTitle className='flex items-center justify-between'>
              <span>Invoice Preview</span>
              <Button onClick={triggerPrint} className='mr-8'>
                <Printer className='mr-2 h-4 w-4' />
                Print / Save as PDF
              </Button>
            </DialogTitle>
          </DialogHeader>

          <div className='overflow-hidden rounded-lg border'>
            <InvoicePrintView
              ref={printRef}
              invoice={invoice}
              seller={seller}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ============================================
// COMBINED INVOICE ACTIONS
// ============================================

interface InvoiceActionsProps {
  invoice: InvoiceWithDetails
  onSuccess?: () => void
  className?: string
}

/**
 * Combined invoice actions component that shows available actions
 * based on the current invoice status
 */
export function InvoiceActions({
  invoice,
  onSuccess,
  className,
}: InvoiceActionsProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className || ''}`}>
      <PrintButton invoice={invoice} />

      <FinalizeButton
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoiceNumber}
        status={invoice.status}
        onSuccess={onSuccess}
      />

      <MarkPaidButton
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoiceNumber}
        status={invoice.status}
        onSuccess={onSuccess}
      />

      <VoidButton
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoiceNumber}
        status={invoice.status}
        onSuccess={onSuccess}
      />
    </div>
  )
}
