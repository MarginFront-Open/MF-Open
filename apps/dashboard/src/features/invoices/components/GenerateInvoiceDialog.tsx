/**
 * Generate Invoice Dialog
 *
 * Pick a customer and subscription, and the system builds a draft invoice with
 * line items computed from the period's usage events. After generation it
 * redirects to the invoice's detail page so the user can review, edit, send, or
 * delete it before the cron finalizes it. Typing line items by hand does not
 * scale for usage-based billing with hundreds of events.
 */
'use client'

import { useState, useEffect, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFilters } from '@/services/filters-service'
import { useGenerateInvoice } from '../useInvoiceMutations'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface GenerateInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GenerateInvoiceDialog({
  open,
  onOpenChange,
}: GenerateInvoiceDialogProps) {
  const router = useRouter()
  const { data: filtersData } = useFilters()
  const { mutate: generateInvoice, isPending } = useGenerateInvoice()

  const customers = filtersData?.customers || []
  const subscriptions = filtersData?.subscriptions || []

  const [customerId, setCustomerId] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Subscriptions the customer can actually be billed for — must be active and on a
  // usage- or hybrid-billing model (recurring-only subs use a different code path).
  const eligibleSubscriptions = useMemo(() => {
    if (!customerId) return []
    return subscriptions.filter(
      (sub: any) =>
        sub.customerId === customerId &&
        sub.status === 'active' &&
        (sub.billingModel === 'usage' || sub.billingModel === 'hybrid')
    )
  }, [customerId, subscriptions])

  // Reset form when dialog reopens
  /* eslint-disable react-hooks/set-state-in-effect -- Intentional reset-on-open pattern */
  useEffect(() => {
    if (open) {
      setCustomerId('')
      setSubscriptionId('')
      setError(null)
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  // When customer changes, clear the subscription selection so we don't end up with a
  // sub belonging to the wrong customer.
  /* eslint-disable react-hooks/set-state-in-effect -- resets the dependent selection when its parent changes */
  useEffect(() => {
    setSubscriptionId('')
  }, [customerId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleGenerate = () => {
    if (!customerId || !subscriptionId) {
      setError('Pick a customer and a subscription first.')
      return
    }
    setError(null)
    generateInvoice(
      { customerId, subscriptionId },
      {
        onSuccess: (invoice) => {
          onOpenChange(false)
          // Land on the new draft so the user can review/send/edit immediately.
          router.push(`/invoices/${invoice.id}`)
        },
        onError: (err) => {
          setError(err.message || 'Could not generate invoice.')
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Generate from Subscription</DialogTitle>
          <DialogDescription>
            We&apos;ll create a draft invoice with line items computed from this
            subscription&apos;s usage events in the current billing period.
            Review, edit, and send it from the next screen.
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4 py-2'>
          <div className='space-y-2'>
            <Label htmlFor='gen-customer'>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger id='gen-customer'>
                <SelectValue placeholder='Pick a customer' />
              </SelectTrigger>
              <SelectContent>
                {customers.map((customer: any) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='gen-subscription'>Subscription</Label>
            <Select
              value={subscriptionId}
              onValueChange={setSubscriptionId}
              disabled={!customerId || eligibleSubscriptions.length === 0}
            >
              <SelectTrigger id='gen-subscription'>
                <SelectValue
                  placeholder={
                    !customerId
                      ? 'Pick a customer first'
                      : eligibleSubscriptions.length === 0
                        ? 'No usage-billable subscriptions for this customer'
                        : 'Pick a subscription'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleSubscriptions.map((sub: any) => (
                  <SelectItem key={sub.id} value={sub.id}>
                    {sub.name || `Subscription ${sub.id.slice(0, 8)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {customerId && eligibleSubscriptions.length === 0 && (
              <p className='text-xs text-muted-foreground'>
                Only active usage / hybrid subscriptions can be generated from.
                For recurring-only subs use New Invoice instead.
              </p>
            )}
          </div>

          {error && (
            <div className='rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive'>
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isPending || !subscriptionId}
          >
            {isPending && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            Generate Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
