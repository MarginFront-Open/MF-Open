/**
 * Send Invoice Dialog Component
 *
 * Clean, minimal dialog for sending invoice emails
 */
import { useState, useEffect } from 'react'
import { sendInvoiceEmail as sendInvoiceEmailAction } from '@/app/actions/invoices'
import { Send, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/canon-format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type SendStatus = 'idle' | 'sending' | 'success' | 'error'

interface SendInvoiceDialogProps {
  invoice: {
    id: string
    invoiceNumber: string
    totalAmount: number | string
    customer?: {
      id: string
      name: string
      email: string
    }
  }
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SendInvoiceDialog({
  invoice,
  open,
  onOpenChange,
}: SendInvoiceDialogProps) {
  const [recipientEmail, setRecipientEmail] = useState('')
  const [customMessage, setCustomMessage] = useState('')
  const [status, setStatus] = useState<SendStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  // Reset state when dialog opens
  /* eslint-disable react-hooks/set-state-in-effect -- Intentional reset-on-open pattern */
  useEffect(() => {
    if (open) {
      setRecipientEmail(invoice.customer?.email || '')
      setCustomMessage('')
      setStatus('idle')
      setErrorMessage('')
    }
  }, [open, invoice.customer?.email])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleSend = async () => {
    if (!recipientEmail) {
      setErrorMessage('Please enter a recipient email')
      setStatus('error')
      return
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(recipientEmail)) {
      setErrorMessage('Please enter a valid email address')
      setStatus('error')
      return
    }

    setStatus('sending')
    setErrorMessage('')

    try {
      const result = await sendInvoiceEmailAction(invoice.id, {
        recipientEmail,
        message: customMessage || undefined,
      })

      if (!result.success) {
        setStatus('error')
        setErrorMessage(result.error || 'Failed to send invoice email')
        return
      }

      setStatus('success')
    } catch (error) {
      console.error('Failed to send invoice email:', error)
      setStatus('error')
      setErrorMessage('An unexpected error occurred. Please try again.')
    }
  }

  const handleClose = () => {
    if (status === 'sending') return
    onOpenChange(false)
  }

  const isValidEmail =
    recipientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)

  // Success state
  if (status === 'success') {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className='sm:max-w-[400px]'>
          <div className='flex flex-col items-center py-6 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30'>
              <CheckCircle2 className='h-6 w-6 text-green-600' />
            </div>
            <h3 className='mt-4 text-lg font-semibold'>Invoice sent</h3>
            <p className='mt-1 text-sm text-muted-foreground'>
              {invoice.invoiceNumber} has been sent to {recipientEmail}
            </p>
            <Button className='mt-6' onClick={handleClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='sm:max-w-[440px]'>
        <DialogHeader>
          <DialogTitle>Send invoice</DialogTitle>
          <DialogDescription>
            Send {invoice.invoiceNumber} (
            {formatCurrency(Number(invoice.totalAmount))}) to your customer
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4 pt-2'>
          {/* Recipient Email */}
          <div className='space-y-2'>
            <Label htmlFor='email'>Recipient email</Label>
            <Input
              id='email'
              type='email'
              value={recipientEmail}
              onChange={(e) => {
                setRecipientEmail(e.target.value)
                if (status === 'error') setStatus('idle')
              }}
              placeholder='customer@example.com'
              className={cn(
                status === 'error' && !isValidEmail && 'border-destructive'
              )}
            />
          </div>

          {/* Custom Message */}
          <div className='space-y-2'>
            <Label htmlFor='message'>
              Message{' '}
              <span className='font-normal text-muted-foreground'>
                (optional)
              </span>
            </Label>
            <Textarea
              id='message'
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              placeholder='Add a personal note...'
              rows={3}
              className='resize-none'
            />
          </div>

          {/* Error Message */}
          {status === 'error' && errorMessage && (
            <div className='flex items-center gap-2 text-sm text-destructive'>
              <AlertCircle className='h-4 w-4 flex-shrink-0' />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className='flex justify-end gap-2 pt-4'>
          <Button
            variant='outline'
            onClick={handleClose}
            disabled={status === 'sending'}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!isValidEmail || status === 'sending'}
          >
            {status === 'sending' ? (
              <>
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                Sending...
              </>
            ) : (
              <>
                <Send className='mr-2 h-4 w-4' />
                Send
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
