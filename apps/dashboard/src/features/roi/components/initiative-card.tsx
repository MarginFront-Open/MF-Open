'use client'

/**
 * One initiative card. Props-pure: renders
 * the RoiInitiativeView verbatim; every number string comes from the progress-derivation copy
 * builders (goalSentence/goalProgressSentence/progressLabel) — it re-derives
 * nothing and never touches canon-format directly. Writes reuse the existing
 * money-gated actions (updateInitiative/deleteInitiative; this card adds ZERO
 * write actions), and nothing renders optimistically — the page re-fetches via onChanged after a confirmed
 * success.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { updateInitiative, deleteInitiative } from '@/app/actions/initiatives'
import type { RoiInitiativeView } from '@/app/actions/roi-overview'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  goalSentence,
  goalProgressSentence,
  displayProgressPct,
  formatGoalWindow,
  matterScopeLabel,
  progressLabel,
} from '../progress-derivation'
import { HEALTH_PILLS, progressFillClass } from './status-maps'
import { GOAL_HEALTH_TOOLTIPS, ROI_TOOLTIPS } from '../report-derivation'
import { TooltipWrap } from '@/components/ui/info-tooltip'

export interface InitiativeCardProps {
  view: RoiInitiativeView
  onEdit: (view: RoiInitiativeView) => void
  /** Bumped-refresh hook — fired after any successful archive/unarchive/delete. */
  onChanged: () => void
}

export function InitiativeCard({
  view,
  onEdit,
  onChanged,
}: InitiativeCardProps) {
  const { toast } = useToast()
  const router = useRouter()
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const archived = view.status === 'archived'
  const pill = HEALTH_PILLS[view.health]
  const pillTooltip = GOAL_HEALTH_TOOLTIPS[view.health]
  const matterScope = matterScopeLabel(view)

  const openDetail = () => router.push(`/roi/${view.id}`)

  const handleArchiveConfirm = async () => {
    setPending(true)
    const result = await updateInitiative(view.id, {
      status: archived ? 'active' : 'archived',
    })
    setPending(false)
    if (result.success) {
      toast({
        title: archived ? 'Goal unarchived' : 'Goal archived',
        description: archived
          ? `${view.name} is active again. Its progress recomputes from your real numbers.`
          : `${view.name} is archived. It stops computing actuals; unarchive it any time.`,
      })
      setArchiveOpen(false)
      onChanged()
    } else {
      toast({
        title: archived ? "Couldn't unarchive goal" : "Couldn't archive goal",
        description: result.error,
        variant: 'destructive',
      })
    }
  }

  const handleDeleteConfirm = async () => {
    setPending(true)
    const result = await deleteInitiative(view.id)
    setPending(false)
    if (result.success) {
      toast({
        title: 'Goal deleted',
        description: `${view.name} and its targets are gone. Your usage data is untouched.`,
      })
      setDeleteOpen(false)
      onChanged()
    } else {
      toast({
        title: "Couldn't delete goal",
        description: result.error,
        variant: 'destructive',
      })
    }
  }

  return (
    // Link-role div, not an <a>: the kebab nests inside, and interactive
    // elements inside an anchor are invalid HTML. The confirm dialogs live
    // OUTSIDE this div — React synthetic events bubble through the component
    // tree even from portaled children, so a dialog nested here would send
    // its clicks to openDetail.
    <>
      <div
        role='link'
        tabIndex={0}
        data-tour='goal-card'
        data-tour-id={view.id}
        aria-label={`View details for ${view.name}`}
        onClick={openDetail}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openDetail()
        }}
        className={cn(
          'flex cursor-pointer flex-col gap-2.5 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[14px] hover:border-mf-bd2',
          archived && 'opacity-60'
        )}
      >
        <div className='flex items-start justify-between gap-2'>
          <h3 className='text-[12.5px] font-semibold tracking-[-.01em] text-mf-tx'>
            {view.name}
          </h3>
          <div onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for ${view.name}`}
                className='rounded-mf-seg-item px-1.5 py-0.5 text-mf-tx3 hover:text-mf-tx'
              >
                <MoreHorizontal className='h-4 w-4' />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuItem onSelect={openDetail}>
                  View details
                </DropdownMenuItem>
                {!archived && (
                  <DropdownMenuItem onSelect={() => onEdit(view)}>
                    Edit goal
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                  {archived ? 'Unarchive goal' : 'Archive goal'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setDeleteOpen(true)}
                  className='text-red-600 focus:text-red-600'
                >
                  Delete goal
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* The page's date range does not reach a goal, so the card names its own. */}
        <p className='text-[11px] text-mf-tx3'>
          {formatGoalWindow(view.startDate, view.endDate)}
        </p>

        {matterScope && (
          <p className='text-[11px] text-mf-tx3'>{matterScope}</p>
        )}

        {view.targets.length === 0 && (
          <div className='flex items-center justify-between gap-2'>
            <p className='text-[11.5px] text-mf-tx3'>
              No target set yet. Edit this goal to add one.
            </p>
            <HealthPill
              label={pill.label}
              className={pill.className}
              tooltip={pillTooltip}
            />
          </div>
        )}

        {view.targets.map((target, index) => {
          const isLast = index === view.targets.length - 1
          const shownPct = displayProgressPct(target)
          return (
            <div key={target.id} className='flex flex-col gap-1.5'>
              <div className='flex items-baseline justify-between gap-2'>
                <p className='text-[11.5px] text-mf-tx2'>
                  Goal: {goalSentence(target)}
                </p>
                <TooltipWrap
                  title={ROI_TOOLTIPS.goalProgress.title}
                  description={ROI_TOOLTIPS.goalProgress.description}
                >
                  <button
                    type='button'
                    onClick={(e) => e.stopPropagation()}
                    className='cursor-help text-[11.5px] font-semibold tabular-nums text-mf-tx focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                  >
                    {progressLabel(shownPct)}
                  </button>
                </TooltipWrap>
              </div>
              <div className='h-1.5 overflow-hidden rounded-full bg-mf-card2'>
                <div
                  className={cn(
                    'h-full rounded-full',
                    progressFillClass(view.health)
                  )}
                  style={{ width: `${shownPct ?? 0}%` }}
                />
              </div>
              <div className='flex items-start justify-between gap-2'>
                <span className='text-[11px] text-mf-tx3'>
                  {goalProgressSentence(target, view.elapsedPct)}
                </span>
                {isLast && (
                  <div className='shrink-0'>
                    <HealthPill
                      label={pill.label}
                      className={pill.className}
                      tooltip={pillTooltip}
                    />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <AlertDialog
        open={archiveOpen}
        onOpenChange={(open) => !open && setArchiveOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archived ? 'Unarchive goal?' : 'Archive goal?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archived
                ? `${view.name} becomes active again and its progress recomputes from your real numbers.`
                : `${view.name} moves out of active tracking and stops computing actuals. Nothing is deleted. You can unarchive it any time.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchiveConfirm}
              disabled={pending}
            >
              {pending ? 'Processing...' : archived ? 'Unarchive' : 'Archive'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => !open && setDeleteOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete goal?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This deletes ${view.name} and its targets. Your usage data is untouched. Only the goal goes away, and this can't be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} disabled={pending}>
              {pending ? 'Processing...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The health word with the rule behind it one hover away. A button, not a
 * span: the word is the only thing on this card explaining itself, and a
 * keyboard reader has to be able to reach it. The click is swallowed so
 * reading the pill does not open the goal. */
function HealthPill({
  label,
  className,
  tooltip,
}: {
  label: string
  className: string
  tooltip: { title: string; description: string }
}) {
  return (
    <TooltipWrap title={tooltip.title} description={tooltip.description}>
      <button
        type='button'
        onClick={(e) => e.stopPropagation()}
        className={`cursor-help rounded-full px-2 py-0.5 text-[10.5px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${className}`}
      >
        {label}
      </button>
    </TooltipWrap>
  )
}
