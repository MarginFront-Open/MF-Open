'use client'

/**
 * The deactivate/reactivate
 * confirmation for a pricing plan. This WARNS rather than hard-blocking the
 * way deletePricingPlan/unlinkPlanFromAgent do: deactivating only flips
 * `isActive` (hides the plan from new subscriptions and new agent links) —
 * it never cancels an existing subscription or severs an existing agent
 * link, so it isn't the same blast radius as a delete or an unlink.
 *
 * `row.activeOrPendingSubscriptionCount` mirrors deletePricingPlan's exact
 * block predicate (see plans-derivation.ts) computed from the Plans tab's
 * already-loaded getFilters() snapshot, not a fresh server re-check at
 * confirm time.
 */

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
  linkedRecordsSummary,
  planHasLinkedRecords,
  type PlansTabRow,
} from '../plans-derivation'

export interface PlanActivationDialogProps {
  row: PlansTabRow | null
  nextActive: boolean
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function PlanActivationDialog({
  row,
  nextActive,
  pending,
  onCancel,
  onConfirm,
}: PlanActivationDialogProps) {
  const hasLinkedRecords = row !== null && planHasLinkedRecords(row)

  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(next) => !next && onCancel()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {nextActive ? 'Reactivate' : 'Deactivate'} {row?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {row === null
              ? null
              : nextActive
                ? 'This plan becomes available for new subscriptions and agent links again.'
                : hasLinkedRecords
                  ? `This plan is linked to ${linkedRecordsSummary(row)}. Deactivating won't cancel those (they keep billing and stay linked as-is), but no new subscription or agent link can use this plan while it's inactive.`
                  : "This plan isn't linked to any agent or subscription. Deactivating is safe."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className={
              !nextActive && hasLinkedRecords
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {pending ? 'Saving…' : nextActive ? 'Reactivate' : 'Deactivate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
