/**
 * The Close-the-books / Reopen flow. Same handlers, dialog copy and toasts
 * as month-end-close/index.tsx; the button chrome uses mf-tokens. This is
 * checklist step 5's action surface.
 */

import { useState, useTransition } from 'react'
import { Lock, Unlock } from 'lucide-react'
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
import { useToast } from '@/hooks/use-toast'
import { lockPeriod, unlockPeriod } from '@/app/actions/finance-period-lock'
import type { PeriodLockStatus } from '@/app/actions/finance-period-lock'

const BUTTON_CLASS =
  'flex h-7 items-center gap-1.5 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:cursor-not-allowed disabled:opacity-50'

export interface CloseControlsProps {
  lock: PeriodLockStatus
  startDate: string
  endDate: string
  monthLabel: string
  /** Bumped after a successful close/reopen so the page re-fetches the close facts. */
  onChanged: () => void
}

export function CloseControls({
  lock,
  startDate,
  endDate,
  monthLabel,
  onChanged,
}: CloseControlsProps) {
  const { toast } = useToast()
  const [lockBusy, setLockBusy] = useState(false)
  const [, startTransition] = useTransition()

  // Close the books on this period: freeze the current numbers as the posted
  // snapshot. After this, reclassifying a signal won't change this period.
  const handleClose = () => {
    setLockBusy(true)
    startTransition(async () => {
      try {
        const res = await lockPeriod({
          startDate,
          endDate,
          periodLabel: monthLabel,
        })
        if (res.success) {
          toast({
            title: `Closed ${monthLabel}`,
            description:
              'These numbers are now the posted snapshot. Reclassifying signals won’t change them.',
          })
          onChanged()
        } else {
          toast({
            title: 'Could not close the period',
            description: res.error ?? 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        setLockBusy(false)
      }
    })
  }

  // Reopen a closed period: discard the snapshot so the numbers recompute live.
  const handleReopen = () => {
    setLockBusy(true)
    startTransition(async () => {
      try {
        const res = await unlockPeriod({ startDate, endDate })
        if (res.success) {
          toast({
            title: `Reopened ${monthLabel}`,
            description:
              'The posted snapshot was discarded. These numbers will recompute from current data.',
          })
          onChanged()
        } else {
          toast({
            title: 'Could not reopen the period',
            description: res.error ?? 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        setLockBusy(false)
      }
    })
  }

  if (lock.locked) {
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button type='button' disabled={lockBusy} className={BUTTON_CLASS}>
            <Unlock className='h-3.5 w-3.5' />
            Reopen
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen {monthLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              The posted snapshot will be discarded and {monthLabel}’s numbers
              will recompute from current data, so anything you reclassified
              since closing will move them. Only reopen if you genuinely need to
              change a posted period.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReopen}>
              Reopen period
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  if (lock.closable) {
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button type='button' disabled={lockBusy} className={BUTTON_CLASS}>
            <Lock className='h-3.5 w-3.5' />
            Close the books
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {monthLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              This snapshots {monthLabel}’s numbers as the posted close. After
              this, reclassifying a signal or remapping a GL code won’t change
              this period’s journal, CSVs, or margin. You can reopen it later if
              you need to.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleClose}>
              Close the books
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <button
      type='button'
      disabled
      title={`${monthLabel} isn’t over yet. You can close it once it ends.`}
      className={BUTTON_CLASS}
    >
      <Lock className='h-3.5 w-3.5' />
      Close the books
    </button>
  )
}
