'use client'

/**
 * Internal users are cost-only: no
 * subscription, invoice, or revenue, ever. Reads ONLY the cost field off
 * getCanonicalCustomerMetrics (never revenue/margin) so this can't turn
 * into $0-revenue theatre for an internal seat — locked by this file's own
 * source-assertion test.
 */

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCost } from '@/lib/canon-format'
import { getCanonicalCustomerMetrics } from '@/app/actions/analytics'
import type { UsersTabCustomer } from '../users-derivation'

export interface GlAccountLabel {
  glCode: string
  glName: string
}

export interface InternalUserDetailDialogProps {
  customer: UsersTabCustomer
  glAccount: GlAccountLabel | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InternalUserDetailDialog({
  customer,
  glAccount,
  open,
  onOpenChange,
}: InternalUserDetailDialogProps) {
  const [cost, setCost] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // Reset state on open/customer change before the fetch resolves.
  /* eslint-disable react-hooks/set-state-in-effect -- Intentional reset-on-open pattern */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCost(null)
    setLoadFailed(false)
    getCanonicalCustomerMetrics(customer.id).then((result) => {
      if (cancelled) return
      // Revenue is always 0 here (internal users are never invoiced); a
      // meaningless $0 tile, so we omit it rather than render one.
      if (result.success && result.data) {
        setCost(result.data.totals.cost)
      } else {
        setLoadFailed(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, customer.id])
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{customer.name}</DialogTitle>
          <DialogDescription>
            Internal user. Tracked for cost only. Internal users are never
            invoiced, so there&apos;s no revenue or invoice history here.
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4 pt-1'>
          <div>
            <p className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              Cost (last 30 days)
            </p>
            <p className='mt-0.5 text-2xl font-bold text-foreground'>
              {loadFailed ? '—' : cost === null ? 'Loading…' : formatCost(cost)}
            </p>
            {loadFailed && (
              <p className='mt-1 text-xs text-muted-foreground'>
                Couldn&apos;t load cost for this user. Refresh and try again.
              </p>
            )}
          </div>

          <div>
            <p className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              Assigned GL account
            </p>
            <p className='mt-0.5 text-sm font-medium text-foreground'>
              {glAccount
                ? `${glAccount.glCode}: ${glAccount.glName}`
                : 'No GL account assigned'}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
