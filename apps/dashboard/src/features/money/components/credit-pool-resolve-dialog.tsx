'use client'

/**
 * The ONE credit-pool resolution dialog. Both roads open it: the
 * Credit Pools section on Money → Plans, and the third section on the
 * needs-attention page. Same actions, same copy, one home.
 *
 * The three resolutions a human reaches for, in the order they usually want
 * them: add units, quiet the emails, or go look at the plan. All of them are
 * optional — an empty pool is not an outage, and this dialog says so.
 */

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  setCreditAlertsPaused,
  topUpCreditPool,
} from '@/app/actions/credit-pools'
import type {
  CreditPoolBalanceView,
  CreditPoolPermission,
} from '../credit-pool-types'

interface CreditPoolResolveDialogProps {
  pool: CreditPoolBalanceView | null
  permission: CreditPoolPermission
  onOpenChange: (open: boolean) => void
  /** Fired after a successful write so the caller can refresh its rows. */
  onResolved: () => void
}

function units(value: number): string {
  return Math.round(value).toLocaleString()
}

/**
 * A fresh pool means a fresh form: leaving one customer's amount, note, or
 * in-flight top-up key sitting in the box for the next customer is how a wrong
 * top-up happens. The reset is a REMOUNT keyed on the subscription rather than
 * an effect that clears six pieces of state — same guarantee, no cascading
 * render, and impossible to forget a field when one is added.
 */
export function CreditPoolResolveDialog({
  pool,
  permission,
  onOpenChange,
  onResolved,
}: CreditPoolResolveDialogProps) {
  if (!pool) return null
  return (
    <CreditPoolResolveForm
      key={pool.subscriptionId}
      pool={pool}
      permission={permission}
      onOpenChange={onOpenChange}
      onResolved={onResolved}
    />
  )
}

function CreditPoolResolveForm({
  pool,
  permission,
  onOpenChange,
  onResolved,
}: CreditPoolResolveDialogProps & { pool: CreditPoolBalanceView }) {
  const [unitsToAdd, setUnitsToAdd] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<'topup' | 'alerts' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // ONE key per top-up intent, held across retries. If the request times out
  // after the server already wrote the grant, pressing the button again sends
  // the SAME key and gets that grant back instead of adding units twice. A
  // different pool remounts this component and mints a new one; a completed
  // top-up mints one below.
  const [topUpKey, setTopUpKey] = useState(() => crypto.randomUUID())
  // The dialog tracks its own paused flag so the label/explainer
  // flip the moment a write succeeds, even under parents that freeze
  // `selected` and never refresh it. When a parent DOES refresh the prop
  // while mounted (the subscription page refetches after every write), the
  // render-time adopt below lets the refetched truth win — a pause by
  // another admin still surfaces in an open dialog.
  const [alertsPaused, setAlertsPaused] = useState(pool.alertsPaused)
  const [lastPropPaused, setLastPropPaused] = useState(pool.alertsPaused)
  if (pool.alertsPaused !== lastPropPaused) {
    setLastPropPaused(pool.alertsPaused)
    setAlertsPaused(pool.alertsPaused)
  }

  const parsedUnits = Number(unitsToAdd)
  const canSubmitTopUp =
    permission.canManage &&
    unitsToAdd.trim() !== '' &&
    Number.isFinite(parsedUnits) &&
    parsedUnits > 0 &&
    pending === null

  const handleTopUp = async () => {
    setPending('topup')
    setError(null)
    const result = await topUpCreditPool({
      subscriptionId: pool.subscriptionId,
      units: parsedUnits,
      note: note.trim() || undefined,
      idempotencyKey: topUpKey,
    })
    setPending(null)
    if (result.success) {
      setDone(`Added ${units(parsedUnits)} units to ${pool.subscriptionName}.`)
      setUnitsToAdd('')
      setNote('')
      // That intent is spent. The next top-up on this pool is a new one.
      setTopUpKey(crypto.randomUUID())
      onResolved()
    } else {
      setError(result.error)
    }
  }

  const handleAlerts = async () => {
    setPending('alerts')
    setError(null)
    const nextPaused = !alertsPaused
    const result = await setCreditAlertsPaused({
      subscriptionId: pool.subscriptionId,
      paused: nextPaused,
    })
    setPending(null)
    if (result.success) {
      setAlertsPaused(nextPaused)
      setDone(
        nextPaused
          ? 'Alerts paused. Nobody gets a heads-up as this pool drains.'
          : 'Alerts back on. The next threshold this pool crosses sends an email.'
      )
      onResolved()
    } else {
      setError(result.error)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{pool.subscriptionName}</DialogTitle>
          <DialogDescription>
            {pool.noActivePeriod
              ? `${pool.customerName ?? 'This customer'} has a ${units(pool.poolSizeUnits)} unit pool that has not started counting down yet, because this subscription has no billing period.`
              : `${pool.customerName ?? 'This customer'} has ${units(pool.remainingUnits)} of ${units(pool.poolSizeUnits)} units left. Nothing is blocked: the pool is a meter, not a switch, so their calls keep working and anything past the pool bills as overage.`}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          <div className='grid grid-cols-3 gap-3 rounded-md border border-mf-bd2 p-3 text-sm'>
            <div>
              <p className='text-xs text-muted-foreground'>Used this period</p>
              <p className='font-medium'>
                {pool.noActivePeriod
                  ? 'Not started'
                  : units(pool.consumedUnits)}
              </p>
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Units left</p>
              <p className='font-medium'>{units(pool.remainingUnits)}</p>
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>
                Billing as overage
              </p>
              <p className='font-medium'>
                {units(pool.overageInProgressUnits)}
              </p>
            </div>
          </div>

          {pool.overageInProgressUnits > 0 && (
            <p className='text-xs text-muted-foreground'>
              Adding units raises what is left to draw. It does not reduce the{' '}
              {units(pool.overageInProgressUnits)} units already billing as
              overage this period, because the invoice charges for usage past
              the pool size.
            </p>
          )}

          {!permission.canManage && (
            <p className='text-xs text-muted-foreground'>
              {permission.whoCanChange}
            </p>
          )}

          {permission.canManage && (
            <div className='space-y-3'>
              <div className='space-y-1.5'>
                <Label htmlFor='credit-pool-units'>Units to add</Label>
                <Input
                  id='credit-pool-units'
                  type='number'
                  min='1'
                  inputMode='numeric'
                  placeholder='e.g. 1000'
                  value={unitsToAdd}
                  onChange={(e) => setUnitsToAdd(e.target.value)}
                  disabled={pending !== null}
                />
                <p className='text-xs text-muted-foreground'>
                  Adds units to this pool&apos;s balance. Nothing is billed from
                  here. If you charged your customer for the refill, record it
                  in the note so you have the paper trail. Usage past the
                  plan&apos;s included pool still bills at the overage rate.
                </p>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='credit-pool-note'>Note (optional)</Label>
                <Input
                  id='credit-pool-note'
                  placeholder='Why you are adding these units'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={pending !== null}
                />
                <p className='text-xs text-muted-foreground'>
                  Saved with the credit, so anyone can see later why this
                  customer has extra units.
                </p>
              </div>
            </div>
          )}

          {permission.canManage && (
            <p className='text-xs text-muted-foreground'>
              <span className='font-medium'>
                {alertsPaused ? 'Resume alerts:' : 'Pause alerts:'}
              </span>{' '}
              {alertsPaused
                ? 'Turns the warning emails back on for this subscription.'
                : 'Stops the warning emails for this subscription only. Usage tracking and invoicing continue unchanged. Your customer never receives these emails either way.'}
            </p>
          )}

          {error && (
            <p className='text-sm text-destructive' role='alert'>
              {error}
            </p>
          )}
          {done && (
            <p className='flex items-center gap-1.5 text-sm text-green-600'>
              <CheckCircle2 className='h-4 w-4' />
              {done}
            </p>
          )}
        </div>

        <DialogFooter className='flex-col gap-2 sm:flex-row sm:justify-between'>
          <Link
            href={`/subscriptions/${pool.subscriptionId}`}
            className='text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground'
          >
            Open the subscription
          </Link>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              onClick={handleAlerts}
              disabled={!permission.canManage || pending !== null}
            >
              {pending === 'alerts' && (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              {alertsPaused ? 'Resume alerts' : 'Pause alerts'}
            </Button>
            <Button onClick={handleTopUp} disabled={!canSubmitTopUp}>
              {pending === 'topup' && (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              Add units
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
