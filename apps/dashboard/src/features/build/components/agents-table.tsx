'use client'

/**
 * The Build page's agents table.
 * Rows arrive verbatim from getBuildAgentsOverview; this component
 * re-derives NOTHING — every dollar renders through canon-format and the
 * catch-all "Deleted agents" row arrives pre-sorted last by the derivation.
 *
 * Writes reuse the existing assertBuildManager-gated actions verbatim
 * (no write actions of its own). Pause/resume confirms through the
 * shared AgentStatusDialog (which owns updateAgent + the honesty copy);
 * delete stays here — a soft delete whose agentCode is auto re-provisioned
 * if the SDK keeps sending it.
 * New agent is a LINK to the live /agents/new wizard — the create
 * flow's real body is the signals wizard, not a modal. Edit agent drills
 * into the detail view, where EditAgentDialog lives.
 */

import { useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal } from 'lucide-react'
import { deleteAgent } from '@/app/actions/agents'
import type { BuildAgentRow } from '@/app/actions/build-agents-overview'
import { formatCost, formatPct } from '@/lib/canon-format'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  TileFrame,
  type TileStateProps,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { AgentStatusDialog } from './agent-status-dialog'
import { agentStatusPill } from './status-maps'

const HEADER_CELL =
  'pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'

export interface AgentsTableProps extends TileStateProps {
  rows: BuildAgentRow[] | null
  agentCount: number | null
  pausedCount: number | null
  onDrillIn: (agentId: string) => void
  /** Bumped-refresh hook — fired after any successful pause/resume/delete. */
  onChanged: () => void
}

export function AgentsTable({
  rows,
  agentCount,
  pausedCount,
  state,
  errorMessage,
  onDrillIn,
  onChanged,
}: AgentsTableProps) {
  const { toast } = useToast()
  const [pauseTarget, setPauseTarget] = useState<BuildAgentRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BuildAgentRow | null>(null)
  const [pending, setPending] = useState(false)

  const effectiveState =
    state === 'ready' && (rows === null || rows.length === 0) ? 'empty' : state

  const headerNote =
    agentCount !== null && pausedCount !== null
      ? `${agentCount} agents, ${agentCount - pausedCount} active, ${pausedCount} paused`
      : null

  const handleDeleteConfirm = async () => {
    if (!deleteTarget?.agentId) {
      setDeleteTarget(null)
      return
    }
    setPending(true)
    const result = await deleteAgent(deleteTarget.agentId)
    setPending(false)
    if (result.success) {
      toast({
        title: 'Agent deleted',
        description: `${deleteTarget.name} is gone from your agent lists. Its history stays in reports under "Deleted agents".`,
      })
      setDeleteTarget(null)
      onChanged()
    } else {
      toast({
        title: "Couldn't delete agent",
        description: result.error,
        variant: 'destructive',
      })
    }
  }

  return (
    <section>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
          Agents
        </h2>
        {headerNote && (
          <span className='text-[11px] font-medium text-mf-tx3'>
            {headerNote}
          </span>
        )}
        <div className='ml-auto'>
          <Link
            href='/agents/new'
            className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
          >
            ＋ New agent
          </Link>
        </div>
      </div>

      <TileFrame
        state={effectiveState}
        errorMessage={errorMessage}
        emptyMessage='No agents yet. Create one to start metering usage.'
        className='min-h-[120px] overflow-hidden'
        loadingLines={4}
      >
        <table className='w-full border-collapse'>
          <thead>
            <tr>
              <th className={`${HEADER_CELL} px-[17px]`}>Agent</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Status</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Usage events</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Cost</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Earned</th>
              <th className={`${HEADER_CELL} px-[10px]`}>
                <span className='flex items-center gap-1'>
                  Margin
                  <InfoTooltip
                    {...tooltipDefinitions.agentEarnedMargin}
                    iconSize='h-3 w-3'
                  />
                </span>
              </th>
              <th className={`${HEADER_CELL} px-[17px]`} aria-label='Actions' />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => {
              const pill = agentStatusPill(row.isActive)
              // agentId === null is the deleted-agents catch-all:
              // no drill-in, no kebab — there is no live agent to act on.
              const catchAll = row.agentId === null
              return (
                <tr
                  key={row.agentId ?? 'deleted-agents'}
                  className='border-t border-mf-bd2'
                >
                  <td className='px-[17px] py-[7px] text-[12px] text-mf-tx'>
                    {catchAll ? (
                      <span className='text-mf-tx2'>{row.name}</span>
                    ) : (
                      <button
                        type='button'
                        onClick={() => row.agentId && onDrillIn(row.agentId)}
                        className='font-medium hover:text-mf-accent'
                      >
                        {row.name}
                      </button>
                    )}
                  </td>
                  <td className='px-[10px] py-[7px]'>
                    {pill ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${pill.className}`}
                      >
                        {pill.label}
                      </span>
                    ) : (
                      <span className='text-[12px] text-mf-tx3'>—</span>
                    )}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {row.tasks.toLocaleString()}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {formatCost(row.cost)}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {formatCost(row.earned)}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {formatPct(row.marginPercent)}
                  </td>
                  <td className='px-[17px] py-[7px] text-right'>
                    {!catchAll && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Actions for ${row.name}`}
                          className='rounded-mf-seg-item px-1.5 py-0.5 text-mf-tx3 hover:text-mf-tx'
                        >
                          <MoreHorizontal className='h-4 w-4' />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem
                            onSelect={() =>
                              row.agentId && onDrillIn(row.agentId)
                            }
                          >
                            Edit agent
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setPauseTarget(row)}
                          >
                            {row.isActive === false
                              ? 'Resume agent'
                              : 'Pause agent'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleteTarget(row)}
                            className='text-red-600 focus:text-red-600'
                          >
                            Delete agent
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TileFrame>

      <AgentStatusDialog
        target={pauseTarget}
        onClose={() => setPauseTarget(null)}
        onChanged={onChanged}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This soft-deletes ${deleteTarget?.name ?? 'this agent'}. It disappears from your agent lists, but its history stays in reports under "Deleted agents". If your SDK still sends this agent code, the agent is re-created automatically on the next event, so remove the code from your SDK calls first.`}
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
    </section>
  )
}
