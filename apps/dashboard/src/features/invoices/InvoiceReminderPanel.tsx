import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReminderStatus as getReminderStatusAction,
  pauseReminders as pauseRemindersAction,
  resumeReminders as resumeRemindersAction,
} from '@/app/actions/invoices'
import { INVOICES_KEYS } from '@/services/invoices-service'
import { BellOff, Clock, AlertTriangle, Pause, Play } from 'lucide-react'
import { ReminderStatusResponse } from '@/lib/api/invoices'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'

interface InvoiceReminderPanelProps {
  invoiceId: string
  invoiceStatus: string
}

const STAGE_LABELS: Record<string, string> = {
  none: 'Not started',
  pre_due_1: 'Courtesy (3 days before)',
  pre_due_2: 'Due today',
  post_due_1: 'Friendly reminder',
  post_due_2: 'Firm reminder',
  post_due_3: 'Final notice',
  escalated: 'Escalated',
}

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return 'N/A'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const formatRelativeDate = (dateStr: string | null) => {
  if (!dateStr) return 'N/A'
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.ceil(
    (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  )

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays > 0) return `In ${diffDays} days`
  return `${Math.abs(diffDays)} days ago`
}

export function InvoiceReminderPanel({
  invoiceId,
  invoiceStatus,
}: InvoiceReminderPanelProps) {
  const queryClient = useQueryClient()
  const [_isLoading, _setIsLoading] = useState(false)

  // Check if panel should be shown (for issued or overdue invoices only)
  const shouldShow = ['issued', 'overdue'].includes(invoiceStatus)

  // Fetch reminder status via Server Action - always call hooks in the same order.
  // Reader uses canonical INVOICES_KEYS.reminders(invoiceId) so the writer
  // mutations (which invalidate the canonical key) actually refresh this
  // panel.
  const { data: reminderStatus, isLoading: isStatusLoading } = useQuery({
    queryKey: INVOICES_KEYS.reminders(invoiceId),
    queryFn: async () => {
      const result = await getReminderStatusAction(invoiceId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch reminder status')
      }
      return result.data as ReminderStatusResponse
    },
    staleTime: 30000,
    enabled: shouldShow, // Only fetch when panel should be shown
  })

  // Pause reminders mutation via Server Action
  const pauseMutation = useMutation({
    mutationFn: async () => {
      const result = await pauseRemindersAction(invoiceId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to pause reminders')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.reminders(invoiceId),
      })
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.detail(invoiceId),
      })
      toast({
        title: 'Reminders paused',
        description: 'Automated reminders have been paused for this invoice.',
      })
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to pause reminders.',
        variant: 'destructive',
      })
    },
  })

  // Resume reminders mutation via Server Action
  const resumeMutation = useMutation({
    mutationFn: async () => {
      const result = await resumeRemindersAction(invoiceId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to resume reminders')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.reminders(invoiceId),
      })
      queryClient.invalidateQueries({
        queryKey: INVOICES_KEYS.detail(invoiceId),
      })
      toast({
        title: 'Reminders resumed',
        description: 'Automated reminders have been resumed.',
      })
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to resume reminders.',
        variant: 'destructive',
      })
    },
  })

  // Early return AFTER all hooks have been called
  if (!shouldShow) {
    return null
  }

  if (isStatusLoading) {
    return (
      <section>
        <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
          Payment Reminders
        </h2>
        <div className='rounded-lg border bg-card p-5'>
          <div className='animate-pulse space-y-3'>
            <div className='h-4 w-2/3 rounded bg-muted' />
            <div className='h-4 w-1/2 rounded bg-muted' />
          </div>
        </div>
      </section>
    )
  }

  if (!reminderStatus) {
    return null
  }

  const isEscalated = reminderStatus.reminderStage === 'escalated'
  const isPaused = reminderStatus.reminderPaused

  return (
    <section>
      <h2 className='mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground'>
        Payment Reminders
      </h2>
      <div
        className={cn(
          'space-y-4 rounded-lg border bg-card p-5',
          isEscalated && 'border-destructive/50 bg-destructive/5',
          isPaused && 'border-muted bg-muted/30'
        )}
      >
        {/* Status indicator */}
        {isEscalated && (
          <div className='flex items-center gap-2 text-sm font-medium text-destructive'>
            <AlertTriangle className='h-4 w-4' />
            Invoice escalated for manual review
          </div>
        )}

        {isPaused && !isEscalated && (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <BellOff className='h-4 w-4' />
            Automated reminders paused
          </div>
        )}

        {/* Current stage */}
        <div className='flex items-center justify-between'>
          <span className='text-sm text-muted-foreground'>Current Stage</span>
          <span
            className={cn(
              'text-sm font-medium',
              isEscalated && 'text-destructive'
            )}
          >
            {STAGE_LABELS[reminderStatus.reminderStage] ||
              reminderStatus.reminderStage}
          </span>
        </div>

        {/* Reminders sent count */}
        <div className='flex justify-between'>
          <span className='text-sm text-muted-foreground'>Reminders Sent</span>
          <span className='text-sm font-medium'>
            {reminderStatus.reminderCount}
          </span>
        </div>

        {/* Last reminder date */}
        {reminderStatus.lastReminderSentAt && (
          <div className='flex justify-between'>
            <span className='text-sm text-muted-foreground'>Last Sent</span>
            <span className='text-sm font-medium'>
              {formatDate(reminderStatus.lastReminderSentAt)}
            </span>
          </div>
        )}

        {/* Next reminder date */}
        {!isPaused && !isEscalated && reminderStatus.nextReminderDate && (
          <div className='flex justify-between'>
            <span className='text-sm text-muted-foreground'>Next Reminder</span>
            <span className='flex items-center gap-1 text-sm font-medium'>
              <Clock className='h-3 w-3' />
              {formatRelativeDate(reminderStatus.nextReminderDate)}
            </span>
          </div>
        )}

        {/* Days overdue/until due */}
        <div className='flex justify-between'>
          <span className='text-sm text-muted-foreground'>
            {reminderStatus.isOverdue ? 'Days Overdue' : 'Days Until Due'}
          </span>
          <span
            className={cn(
              'text-sm font-medium',
              reminderStatus.isOverdue && 'text-destructive'
            )}
          >
            {Math.abs(reminderStatus.daysFromDue)}
          </span>
        </div>

        {/* Action buttons */}
        {!isEscalated && (
          <div className='flex gap-2 border-t pt-3'>
            <Button
              size='sm'
              variant='ghost'
              onClick={() =>
                isPaused ? resumeMutation.mutate() : pauseMutation.mutate()
              }
              disabled={pauseMutation.isPending || resumeMutation.isPending}
            >
              {isPaused ? (
                <>
                  <Play className='mr-1 h-4 w-4' />
                  Resume
                </>
              ) : (
                <>
                  <Pause className='mr-1 h-4 w-4' />
                  Pause
                </>
              )}
            </Button>
          </div>
        )}

        {/* Escalation info */}
        {isEscalated && reminderStatus.escalatedAt && (
          <div className='border-t pt-3 text-sm text-muted-foreground'>
            <p>Escalated on {formatDate(reminderStatus.escalatedAt)}</p>
            {reminderStatus.escalationReason && (
              <p className='mt-1'>Reason: {reminderStatus.escalationReason}</p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
