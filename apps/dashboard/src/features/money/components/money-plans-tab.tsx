'use client'

/**
 * Money → Plans tab: a flat, org-wide list of
 * pricing plans (link out to the agent-scoped create/detail/configure
 * flows rather than rebuilding them here).
 *
 * Reuses getFilters() exactly like the Users tab — the list,
 * the linked-agent chips, the subscription counts, and the deactivate
 * dialog's "what's linked" numbers all come from that ONE response; no
 * second query. Writes (link/unlink/deactivate/reactivate) go through the
 * shared pricing-plans.ts actions; this tab has no server code of its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, X } from 'lucide-react'
import {
  getFilters,
  type AgentFilter,
  type FiltersResponse,
} from '@/app/actions/get-filters'
import {
  linkPlanToAgent,
  unlinkPlanFromAgent,
  updatePricingPlan,
} from '@/app/actions/pricing-plans'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/hooks/use-toast'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import {
  agentsAvailableToLink,
  buildPlansTabRows,
  firstLinkedAgentId,
  type PlansTabRow,
} from '../plans-derivation'
import { PlanActivationDialog } from './plan-activation-dialog'
import { CreditPoolsSection } from './credit-pools-section'

/** "New plan" — plans are created agent-scoped (`/agents/[agentId]/pricing-
 * plans/new`), so this link-out needs to know which agent. Zero
 * agents: nothing to attach a plan to yet, so the affordance points at
 * agent creation instead. One agent: skip the picker. Multiple: a small
 * menu, same idiom as the Export dropdown on the Breakdown tab. */
function NewPlanMenu({ agents }: { agents: AgentFilter[] }) {
  if (agents.length === 0) {
    return (
      <Link href='/agents/new'>
        <Button variant='outline' size='sm' className='h-7 text-[11.5px]'>
          Create an agent to add a plan
        </Button>
      </Link>
    )
  }

  if (agents.length === 1) {
    return (
      <Link href={`/agents/${agents[0].id}/pricing-plans/new`}>
        <Button size='sm' className='h-7 text-[11.5px]'>
          New plan
        </Button>
      </Link>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size='sm' className='h-7 gap-1 text-[11.5px]'>
          New plan
          <ChevronDown className='h-3 w-3' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <div className='px-2 py-1.5 text-[11px] font-medium text-mf-tx3'>
          For which agent?
        </div>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} asChild>
            <Link href={`/agents/${agent.id}/pricing-plans/new`}>
              {agent.name}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MoneyPlansTab() {
  const [filters, setFilters] = useState<FiltersResponse | null>(null)
  const [loadState, setLoadState] = useState<TileState>('loading')
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const [activationTarget, setActivationTarget] = useState<{
    row: PlansTabRow
    nextActive: boolean
  } | null>(null)

  // Refetches after a write, always the freshest snapshot. Not called from
  // the mount effect below (react-hooks/set-state-in-effect flags a direct
  // setState-carrying call inside an effect) — that effect inlines its own
  // fetch instead, same idiom as money-users-tab.tsx.
  const loadFilters = useCallback(async () => {
    const result = await getFilters()
    if (result.success && result.data) {
      setFilters(result.data)
      setLoadState('ready')
    } else {
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getFilters().then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setFilters(result.data)
        setLoadState('ready')
      } else {
        setLoadState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo(
    () =>
      filters
        ? buildPlansTabRows(
            filters.pricingPlans,
            filters.agents,
            filters.subscriptions
          )
        : [],
    [filters]
  )

  const handleLink = useCallback(
    async (planId: string, agentId: string) => {
      setPendingRowId(planId)
      const result = await linkPlanToAgent(planId, agentId)
      if (result.success) {
        await loadFilters()
      } else {
        toast({
          variant: 'destructive',
          title: "Couldn't link plan",
          description:
            result.error ?? 'Something went wrong. Please try again.',
        })
      }
      setPendingRowId(null)
    },
    [loadFilters]
  )

  const handleUnlink = useCallback(
    async (planId: string, agentId: string) => {
      setPendingRowId(planId)
      const result = await unlinkPlanFromAgent(planId, agentId)
      if (result.success) {
        await loadFilters()
      } else {
        toast({
          variant: 'destructive',
          title: "Couldn't unlink plan",
          description:
            result.error ?? 'Something went wrong. Please try again.',
        })
      }
      setPendingRowId(null)
    },
    [loadFilters]
  )

  const handleSetActive = useCallback(
    async (planId: string, isActive: boolean) => {
      setPendingRowId(planId)
      const result = await updatePricingPlan(planId, { isActive })
      if (result.success) {
        await loadFilters()
        toast({
          title: isActive ? 'Plan reactivated' : 'Plan deactivated',
          description: isActive
            ? 'This plan is available for new subscriptions and agent links again.'
            : 'This plan is hidden from new subscriptions and agent links. Existing subscriptions on it keep billing as-is.',
        })
      } else {
        toast({
          variant: 'destructive',
          title: isActive
            ? "Couldn't reactivate plan"
            : "Couldn't deactivate plan",
          description:
            result.error ?? 'Something went wrong. Please try again.',
        })
      }
      setPendingRowId(null)
      setActivationTarget(null)
    },
    [loadFilters]
  )

  if (loadState === 'loading' || filters === null) {
    return (
      <TileFrame state='loading' className='min-h-[280px]' loadingLines={6}>
        {null}
      </TileFrame>
    )
  }

  if (loadState === 'error') {
    return (
      <TileFrame
        state='error'
        className='min-h-[280px]'
        errorMessage="Couldn't load plans. Refresh the page to try again."
      >
        {null}
      </TileFrame>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-end'>
        <NewPlanMenu agents={filters.agents} />
      </div>

      <TileFrame state='ready' className='overflow-hidden'>
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Plan
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Status
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Agents
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Subscriptions
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-right font-semibold'>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detailAgentId = firstLinkedAgentId(row)
              const availableAgents = agentsAvailableToLink(row, filters.agents)
              const isRowPending = pendingRowId === row.id
              return (
                <tr key={row.id} className='border-t border-mf-bd2'>
                  <td className='px-[17px] py-[11px] text-[12.5px] font-medium'>
                    {detailAgentId ? (
                      <Link
                        href={`/agents/${detailAgentId}/pricing-plans/${row.id}`}
                        className='text-mf-tx hover:text-mf-accent'
                      >
                        {row.name}
                      </Link>
                    ) : (
                      <span className='text-mf-tx3'>{row.name}</span>
                    )}
                    {row.description && (
                      <p className='mt-0.5 text-[11px] font-normal text-mf-tx3'>
                        {row.description}
                      </p>
                    )}
                  </td>
                  <td className='px-[10px] py-[11px]'>
                    <Badge variant={row.isActive ? 'success' : 'outline'}>
                      {row.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className='px-[10px] py-[11px]'>
                    <div className='flex flex-wrap items-center gap-1'>
                      {row.linkedAgents.map((agent) => (
                        <span
                          key={agent.id}
                          className='inline-flex items-center gap-1 rounded-full bg-mf-card2 px-2 py-0.5 text-[11px] text-mf-tx2'
                        >
                          {agent.name}
                          <button
                            type='button'
                            aria-label={`Unlink ${agent.name} from ${row.name}`}
                            onClick={() => handleUnlink(row.id, agent.id)}
                            disabled={isRowPending}
                            className='text-mf-tx3 hover:text-destructive'
                          >
                            <X className='h-3 w-3' />
                          </button>
                        </span>
                      ))}
                      {row.linkedAgents.length === 0 && (
                        <span className='text-[11px] text-mf-tx3'>
                          Not linked
                        </span>
                      )}
                      {availableAgents.length > 0 && (
                        <Select
                          value=''
                          onValueChange={(agentId) =>
                            handleLink(row.id, agentId)
                          }
                          disabled={isRowPending}
                        >
                          <SelectTrigger
                            aria-label={`Link ${row.name} to an agent`}
                            className='h-6 w-[120px] text-[11px]'
                          >
                            <SelectValue placeholder='+ Link agent' />
                          </SelectTrigger>
                          <SelectContent>
                            {availableAgents.map((agent) => (
                              <SelectItem key={agent.id} value={agent.id}>
                                {agent.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </td>
                  <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                    {row.totalSubscriptionCount}
                  </td>
                  <td className='px-[17px] py-[11px] text-right'>
                    {row.isActive ? (
                      <Button
                        variant='outline'
                        size='sm'
                        className='h-7 text-[11.5px]'
                        disabled={isRowPending}
                        onClick={() =>
                          setActivationTarget({ row, nextActive: false })
                        }
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        variant='outline'
                        size='sm'
                        className='h-7 text-[11.5px]'
                        disabled={isRowPending}
                        onClick={() =>
                          setActivationTarget({ row, nextActive: true })
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className='px-[17px] py-6 text-center text-[12px] text-mf-tx3'
                >
                  No pricing plans yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TileFrame>

      {/* Credit pools live here because a pool IS a plan's shape: the plan
          sells the block, this is what each customer has left of it. */}
      <CreditPoolsSection />

      <PlanActivationDialog
        row={activationTarget?.row ?? null}
        nextActive={activationTarget?.nextActive ?? false}
        pending={
          activationTarget !== null && pendingRowId === activationTarget.row.id
        }
        onCancel={() => setActivationTarget(null)}
        onConfirm={() =>
          activationTarget &&
          handleSetActive(activationTarget.row.id, activationTarget.nextActive)
        }
      />
    </div>
  )
}
