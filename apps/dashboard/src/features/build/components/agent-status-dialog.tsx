'use client'

/**
 * The ONE pause/resume confirm for Build's agent surfaces: the agents-table
 * kebab and the drill-in detail's Live/Offline switch both confirm through
 * this dialog, so the honesty
 * line ("Pause" is a label, not a behavior — nothing in ingest or billing
 * reads agents.isActive) exists in exactly one place. Owns the gated
 * updateAgent call and both toasts; callers only manage which row is
 * targeted.
 */

import { useState } from 'react'
import { updateAgent } from '@/app/actions/agents'
import { useToast } from '@/hooks/use-toast'
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

export interface AgentStatusTarget {
  /** null = the deleted-agents catch-all row — never a valid target. */
  agentId: string | null
  name: string
  isActive: boolean | null
}

export interface AgentStatusDialogProps {
  target: AgentStatusTarget | null
  onClose: () => void
  /** Fired after a successful status write so the host refreshes its rows. */
  onChanged: () => void
}

export function AgentStatusDialog({
  target,
  onClose,
  onChanged,
}: AgentStatusDialogProps) {
  const { toast } = useToast()
  const [pending, setPending] = useState(false)
  const resuming = target?.isActive === false

  // Callers only target live rows; a null agentId here means a stale
  // target — close silently.
  const handleConfirm = async () => {
    if (!target?.agentId) {
      onClose()
      return
    }
    setPending(true)
    const result = await updateAgent(target.agentId, { isActive: resuming })
    setPending(false)
    if (result.success) {
      toast({
        title: resuming ? 'Agent resumed' : 'Agent paused',
        description: resuming
          ? `${target.name} is marked active again.`
          : `${target.name} is marked paused. Usage recording and billing continue.`,
      })
      onClose()
      onChanged()
    } else {
      toast({
        title: resuming ? "Couldn't resume agent" : "Couldn't pause agent",
        description: result.error,
        variant: 'destructive',
      })
    }
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {resuming ? 'Resume agent?' : 'Pause agent?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resuming
              ? `This marks ${target?.name ?? 'this agent'} as active again in MarginFront.`
              : `This marks ${target?.name ?? 'this agent'} as paused in MarginFront. Pausing does not stop usage recording or billing. If your SDK keeps sending events for this agent, they are still metered and billed.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={pending}>
            {pending ? 'Processing...' : resuming ? 'Resume' : 'Pause'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
