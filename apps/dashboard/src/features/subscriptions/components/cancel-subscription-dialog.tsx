'use client'

/**
 * The cancel confirmation for a
 * subscription. Cancel is the SAFE stop (status:'canceled'): every past
 * invoice and usage event on the subscription stays untouched, unlike a
 * delete (status:'ended') or a pricing-strategy deactivation, either of
 * which would quietly zero the subscription's revenue history. A reason is
 * required and logged to subscription_change_logs, same as an edit.
 *
 * Plain buttons in the footer (not AlertDialogAction/Cancel) on purpose —
 * matches the list page's delete-confirm dialog, so the async pending/error
 * state stays fully controlled by the parent instead of fighting Radix's
 * built-in auto-close-on-click behavior.
 */

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export interface CancelSubscriptionDialogProps {
  open: boolean
  subscriptionName: string
  customerName: string
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (reason: string) => void
}

export function CancelSubscriptionDialog({
  open,
  subscriptionName,
  customerName,
  pending,
  error,
  onCancel,
  onConfirm,
}: CancelSubscriptionDialogProps) {
  const [reason, setReason] = useState('')

  const handleDismiss = () => {
    if (pending) return
    setReason('')
    onCancel()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleDismiss()
      }}
    >
      <AlertDialogContent className='max-w-md'>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel {subscriptionName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {customerName} stops being billed on this subscription going
            forward. Every past invoice and usage event stays exactly as billed.
            Canceling never erases billing history. That&apos;s a separate,
            permanent delete this page doesn&apos;t offer.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className='space-y-1.5'>
          <Label htmlFor='cancel-subscription-reason'>
            Reason for canceling *
          </Label>
          <Textarea
            id='cancel-subscription-reason'
            placeholder='Why is this subscription being canceled? (required)'
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={pending}
          />
          {error && <p className='text-xs text-destructive'>{error}</p>}
        </div>

        <AlertDialogFooter className='gap-2 sm:space-x-0'>
          <Button variant='outline' onClick={handleDismiss} disabled={pending}>
            Keep subscription
          </Button>
          <Button
            variant='destructive'
            onClick={() => onConfirm(reason)}
            disabled={pending || !reason.trim()}
          >
            {pending ? 'Canceling…' : 'Cancel subscription'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
