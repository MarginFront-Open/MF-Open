'use client'

/**
 * The Build agent drill-in detail. The KPI row renders the SAME table row
 * the user clicked (detail ≡ table by construction); the rest rides the
 * reads useAgent / useAgentSignals / useSubscriptions and the
 * shared agent-earnings module (getAgentEarningsBreakdown). Pricing Plans
 * and the Revenue Simulator stay on their own routes, REACHABLE via the
 * link cards below. /agents/[agentId] redirects here, and the edit
 * affordance mounts EditAgentDialog in place (remount-keyed on open, same
 * contract as AgentTabs).
 */

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { getSignalEvents, type SignalEvent } from '@/app/actions/signal-events'
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import type { BuildAgentRow } from '@/app/actions/build-agents-overview'
import { useAgent } from '@/services/agent-service'
import { useAgentSignals } from '@/services/signal-service'
import { useSubscriptions } from '@/services/subscriptions-service'
import {
  AgentEarningsChartBody,
  useAgentEarningsBreakdown,
} from '@/features/agents/agent-earnings-chart'
import { EditAgentDialog } from '@/features/agents/components/edit-agent-dialog'
import type {
  EarningsChartShape,
  EarningsDisplayType,
} from '@/features/agents/agent-earnings'
import { KpiTile } from '@/features/dashboard-shell/tiles/kpi-tile'
import {
  TileFrame,
  type TileState,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { TileHeader } from '@/features/dashboard-shell/tiles/tile-header'
import { Switch } from '@/components/ui/switch'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { formatCurrency, formatPct } from '@/lib/canon-format'
import { cn } from '@/lib/utils'
import { AgentStatusDialog } from './agent-status-dialog'
import { agentStatusPill } from './status-maps'
import { EventsTable } from './event-stream'

const EVENTS_ERROR =
  "Couldn't load this agent's recent events. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const IDENTITY_ERROR =
  "Couldn't load this agent's details. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const CHART_ERROR =
  "Couldn't load the usage cost & revenue chart. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const METRICS_ERROR =
  "Couldn't load this agent's metrics. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const SUBSCRIPTIONS_ERROR =
  "Couldn't load this agent's subscriptions. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

const RECENT_EVENTS_LIMIT = 8

const SECTION_TITLE = 'text-[13px] font-semibold tracking-[-.01em] text-mf-tx'

const HEADER_CELL =
  'pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'

const SEGMENT_BUTTON = 'h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium'

const QUIET_LINK = 'text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'

function queryTileState(query: {
  isLoading: boolean
  isError: boolean
}): TileState {
  if (query.isLoading) return 'loading'
  if (query.isError) return 'error'
  return 'ready'
}

const formatUsd = (n: number): string => formatCurrency(n, 'USD')

function formatShortDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export interface AgentDetailProps {
  agentId: string
  row: BuildAgentRow
  period: { startDate?: string; endDate?: string }
  onBack: () => void
  /** Bumped-refresh hook — fired after a successful status write. */
  onChanged: () => void
}

export function AgentDetail({
  agentId,
  row,
  period,
  onBack,
  onChanged,
}: AgentDetailProps) {
  const pill = agentStatusPill(row.isActive)
  const { startDate, endDate } = period

  const agentQuery = useAgent(agentId)
  const agent = agentQuery.data
  const signalsQuery = useAgentSignals(agentId)
  const signals = signalsQuery.data?.results ?? []
  const subscriptionsQuery = useSubscriptions({
    agentId,
    status: 'active',
    limit: 5,
    page: 1,
  })
  const recentSubscriptions = subscriptionsQuery.data?.results ?? []

  const [statusTarget, setStatusTarget] = useState<BuildAgentRow | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)

  const [displayType, setDisplayType] = useState<EarningsDisplayType>('revenue')
  const [chartShape, setChartShape] = useState<EarningsChartShape>('area')
  const earningsQuery = useAgentEarningsBreakdown(agentId)
  const earnings = earningsQuery.data
  const earningsTotals = earnings?.totals
  const chartState: TileState =
    queryTileState(earningsQuery) === 'ready' &&
    (earnings?.dailyBreakdown.length ?? 0) === 0
      ? 'empty'
      : queryTileState(earningsQuery)

  const [events, setEvents] = useState<SignalEvent[]>([])
  const [totalResults, setTotalResults] = useState<number | null>(null)
  const [eventsState, setEventsState] = useState<TileState>('loading')
  const [, startEventsFetch] = useTransition()

  useEffect(() => {
    let cancelled = false
    startEventsFetch(async () => {
      setEventsState('loading')
      try {
        // Same as EventStream: rolling mode's period is {}, and
        // getSignalEvents skips its usageDate predicate without a bound, so
        // raw passthrough would make totalResults an all-time per-agent count
        // under a "this window" header.
        const { windowStart, windowEnd } = parseWindowFilter({
          startDate,
          endDate,
        })
        const result = await getSignalEvents({
          agentId,
          limit: RECENT_EVENTS_LIMIT,
          startDate: windowStart.toISOString(),
          endDate: windowEnd.toISOString(),
          sortBy: 'usageDate',
          sortOrder: 'desc',
        })
        if (cancelled) return
        if (result.success && result.data) {
          setEvents(result.data.results)
          setTotalResults(result.data.totalResults)
          setEventsState('ready')
        } else {
          setEventsState('error')
        }
      } catch {
        if (cancelled) return
        setEventsState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [agentId, startDate, endDate])

  return (
    <section className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <button
          type='button'
          onClick={onBack}
          className='h-7 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
        >
          ← Back
        </button>
        <h2 className={SECTION_TITLE}>{row.name}</h2>
        {pill && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${pill.className}`}
          >
            {pill.label}
          </span>
        )}
        <Switch
          checked={row.isActive !== false}
          onCheckedChange={() => setStatusTarget(row)}
          aria-label={
            row.isActive === false ? `Resume ${row.name}` : `Pause ${row.name}`
          }
        />
        <div className='ml-auto'>
          <button
            type='button'
            onClick={() => setShowEditDialog(true)}
            className={QUIET_LINK}
          >
            Edit agent
          </button>
        </div>
      </div>

      <TileFrame
        state={queryTileState(agentQuery)}
        errorMessage={IDENTITY_ERROR}
        className='px-[15px] py-[12px]'
        loadingLines={2}
      >
        {agent && (
          <div className='flex flex-wrap items-center gap-x-6 gap-y-2'>
            <span className='text-[12px] text-mf-tx2'>
              Agent code{' '}
              <code className='rounded bg-mf-card2 px-1.5 py-0.5 font-mono text-[11.5px] text-mf-tx'>
                {agent.agentCode}
              </code>
            </span>
            {agent.description && (
              <span className='max-w-xl text-[12px] text-mf-tx2'>
                {agent.description}
              </span>
            )}
            <span className='ml-auto text-[11px] text-mf-tx3'>
              Created {formatShortDate(agent.createdAt)} · Updated{' '}
              {formatShortDate(agent.updatedAt)}
            </span>
          </div>
        )}
      </TileFrame>

      <div className='grid grid-cols-12 gap-3'>
        <div className='col-span-12 sm:col-span-6 lg:col-span-3'>
          <KpiTile metric='eventCount' value={row.tasks} state='ready' />
        </div>
        <div className='col-span-12 sm:col-span-6 lg:col-span-3'>
          <KpiTile metric='cost' value={row.cost} state='ready' />
        </div>
        <div className='col-span-12 sm:col-span-6 lg:col-span-3'>
          <KpiTile metric='earned' value={row.earned} state='ready' />
        </div>
        <div className='col-span-12 sm:col-span-6 lg:col-span-3'>
          {/* The registry's 'Net margin' (totalMargin) copy includes
              subscription and seat fees, but an agent row's margin is
              earned-basis, so this tile sets its own label and tooltip. */}
          <KpiTile
            metric='marginPercent'
            value={row.marginPercent}
            label='Earned margin'
            tooltipKey='agentEarnedMargin'
            subtext={
              row.marginPercent === null
                ? 'No billed activity yet'
                : '(earned − cost) ÷ earned'
            }
            state='ready'
          />
        </div>
      </div>

      <div className='grid grid-cols-12 gap-3'>
        <div className='col-span-12 sm:col-span-4'>
          <TileFrame
            state={queryTileState(subscriptionsQuery)}
            errorMessage={SUBSCRIPTIONS_ERROR}
            className='px-[15px] py-[12px]'
            loadingLines={2}
          >
            <TileHeader label='Active subscriptions' />
            <div className='mt-[6px] text-[17px] font-semibold tracking-[-.02em] text-mf-tx'>
              {(subscriptionsQuery.data?.totalResults ?? 0).toLocaleString()}
            </div>
          </TileFrame>
        </div>
        <div className='col-span-12 sm:col-span-4'>
          <TileFrame
            state={queryTileState(signalsQuery)}
            errorMessage={METRICS_ERROR}
            className='px-[15px] py-[12px]'
            loadingLines={2}
          >
            <TileHeader label='Configured metrics' />
            <div className='mt-[6px] text-[17px] font-semibold tracking-[-.02em] text-mf-tx'>
              {(signalsQuery.data?.totalResults ?? 0).toLocaleString()}
            </div>
          </TileFrame>
        </div>
        <div className='col-span-12 sm:col-span-4'>
          <TileFrame
            state={queryTileState(agentQuery)}
            errorMessage={IDENTITY_ERROR}
            className='px-[15px] py-[12px]'
            loadingLines={2}
          >
            <TileHeader label='Pricing plans' />
            <div className='mt-[6px] text-[17px] font-semibold tracking-[-.02em] text-mf-tx'>
              {(agent?.activePlansCount ?? 0).toLocaleString()}
            </div>
          </TileFrame>
        </div>
      </div>

      <section>
        <div className='mb-3 flex flex-wrap items-center gap-3'>
          <h3 className={SECTION_TITLE}>
            <span className='flex items-center gap-1.5'>
              Usage cost & revenue
              <InfoTooltip
                {...tooltipDefinitions.usageRevenue}
                iconSize='h-3 w-3'
              />
            </span>
          </h3>
          {earningsTotals && (
            <span className='text-[11px] font-medium text-mf-tx3'>
              Last 30 days · {formatUsd(earningsTotals.earned)} revenue ·{' '}
              {formatUsd(earningsTotals.cost)} cost ·{' '}
              <span
                className={
                  earningsTotals.margin < 0 ? 'text-red-600' : 'text-mf-green'
                }
              >
                {formatUsd(earningsTotals.margin)} margin (
                {formatPct(earningsTotals.marginPct)})
              </span>
            </span>
          )}
          <div className='ml-auto flex flex-wrap items-center gap-2'>
            <div
              role='group'
              aria-label='Chart view'
              className='flex items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
            >
              {(['metrics', 'cost', 'revenue'] as const).map((option) => (
                <button
                  key={option}
                  type='button'
                  aria-pressed={option === displayType}
                  onClick={() => setDisplayType(option)}
                  className={cn(
                    SEGMENT_BUTTON,
                    option === displayType
                      ? 'bg-mf-accent2 text-mf-accent'
                      : 'text-mf-tx2 hover:text-mf-tx'
                  )}
                >
                  {option === 'metrics'
                    ? 'Metrics'
                    : option === 'cost'
                      ? 'Cost'
                      : 'Revenue'}
                </button>
              ))}
            </div>
            <div
              role='group'
              aria-label='Chart shape'
              className='flex items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
            >
              {(['area', 'bar'] as const).map((option) => (
                <button
                  key={option}
                  type='button'
                  aria-pressed={option === chartShape}
                  onClick={() => setChartShape(option)}
                  className={cn(
                    SEGMENT_BUTTON,
                    option === chartShape
                      ? 'bg-mf-accent2 text-mf-accent'
                      : 'text-mf-tx2 hover:text-mf-tx'
                  )}
                >
                  {option === 'area' ? 'Area' : 'Bar'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <TileFrame
          state={chartState}
          errorMessage={CHART_ERROR}
          emptyMessage='No events in the last 30 days. Fire one via the Simulator tab or your code to see this chart come alive.'
          className='min-h-[320px] p-[15px]'
          loadingLines={6}
        >
          <div className='h-[300px] w-full'>
            {earnings && (
              <AgentEarningsChartBody
                breakdown={earnings}
                displayType={displayType}
                chartShape={chartShape}
              />
            )}
          </div>
        </TileFrame>
      </section>

      <div className='grid grid-cols-12 gap-3'>
        <section className='col-span-12 lg:col-span-6'>
          <div className='mb-3 flex flex-wrap items-center gap-3'>
            <h3 className={SECTION_TITLE}>Metrics</h3>
            <Link
              href={`/agents/${agentId}/signals`}
              className={`ml-auto ${QUIET_LINK}`}
            >
              Manage metrics →
            </Link>
          </div>
          <TileFrame
            state={
              queryTileState(signalsQuery) === 'ready' && signals.length === 0
                ? 'empty'
                : queryTileState(signalsQuery)
            }
            errorMessage={METRICS_ERROR}
            emptyMessage='No metrics yet. Metrics define what this agent charges for.'
            className='min-h-[120px] overflow-hidden'
            loadingLines={3}
          >
            <table className='w-full border-collapse'>
              <thead>
                <tr>
                  <th className={`${HEADER_CELL} px-[17px]`}>Metric</th>
                  <th className={`${HEADER_CELL} px-[10px]`}>Type</th>
                  <th className={`${HEADER_CELL} px-[17px]`}>Added</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <tr key={signal.id} className='border-t border-mf-bd2'>
                    <td className='px-[17px] py-[7px] text-[12px] font-medium text-mf-tx'>
                      {signal.name}
                      {signal.shortName && (
                        <span className='ml-2 text-[11px] text-mf-tx3'>
                          {signal.shortName}
                        </span>
                      )}
                    </td>
                    <td className='px-[10px] py-[7px] text-[12px] text-mf-tx2'>
                      {signal.type === 'OUTCOME'
                        ? 'Outcome'
                        : signal.type === 'ACTIVITY'
                          ? 'Activity'
                          : '—'}
                    </td>
                    <td className='px-[17px] py-[7px] text-[12px] text-mf-tx2'>
                      {signal.createdAt
                        ? formatShortDate(signal.createdAt)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TileFrame>
        </section>

        <section className='col-span-12 lg:col-span-6'>
          <div className='mb-3 flex flex-wrap items-center gap-3'>
            <h3 className={SECTION_TITLE}>Recent subscriptions</h3>
            <Link href='/subscriptions' className={`ml-auto ${QUIET_LINK}`}>
              View all →
            </Link>
          </div>
          <TileFrame
            state={
              queryTileState(subscriptionsQuery) === 'ready' &&
              recentSubscriptions.length === 0
                ? 'empty'
                : queryTileState(subscriptionsQuery)
            }
            errorMessage={SUBSCRIPTIONS_ERROR}
            emptyMessage='No active subscriptions yet. Customers subscribe to this agent through a pricing plan.'
            className='min-h-[120px] overflow-hidden'
            loadingLines={3}
          >
            <table className='w-full border-collapse'>
              <thead>
                <tr>
                  <th className={`${HEADER_CELL} px-[17px]`}>Subscription</th>
                  <th className={`${HEADER_CELL} px-[10px]`}>Billing cycle</th>
                  <th className={`${HEADER_CELL} px-[17px]`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentSubscriptions.map((subscription) => (
                  <tr key={subscription.id} className='border-t border-mf-bd2'>
                    <td className='px-[17px] py-[7px] text-[12px]'>
                      <Link
                        href={`/subscriptions/${subscription.id}`}
                        className='font-medium text-mf-tx hover:text-mf-accent'
                      >
                        {subscription.name}
                      </Link>
                    </td>
                    <td className='px-[10px] py-[7px] text-[12px] capitalize text-mf-tx2'>
                      {subscription.billingCycle}
                    </td>
                    <td className='px-[17px] py-[7px]'>
                      <span
                        className={cn(
                          'rounded-full bg-mf-card2 px-2 py-0.5 text-[10.5px] font-medium capitalize',
                          subscription.status === 'active'
                            ? 'text-mf-green'
                            : 'text-mf-tx2'
                        )}
                      >
                        {subscription.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TileFrame>
        </section>
      </div>

      <div className='grid grid-cols-12 gap-3'>
        <Link
          href={`/agents/${agentId}/pricing-plans`}
          className='group col-span-12 flex items-center justify-between rounded-mf-card border border-mf-bd bg-mf-card px-[15px] py-[12px] hover:border-mf-accent sm:col-span-6'
        >
          <span>
            <span className='block text-[12.5px] font-semibold text-mf-tx'>
              Pricing plans
            </span>
            <span className='block text-[11.5px] text-mf-tx2'>
              Set what customers pay for this agent.
            </span>
          </span>
          <span className='text-mf-tx3 group-hover:text-mf-accent'>→</span>
        </Link>
        <Link
          href={`/agents/${agentId}/revenue-simulator`}
          className='group col-span-12 flex items-center justify-between rounded-mf-card border border-mf-bd bg-mf-card px-[15px] py-[12px] hover:border-mf-accent sm:col-span-6'
        >
          <span>
            <span className='block text-[12.5px] font-semibold text-mf-tx'>
              Revenue simulator
            </span>
            <span className='block text-[11.5px] text-mf-tx2'>
              Model what this agent could earn with different pricing.
            </span>
          </span>
          <span className='text-mf-tx3 group-hover:text-mf-accent'>→</span>
        </Link>
      </div>

      <div>
        <div className='mb-3 flex flex-wrap items-center gap-3'>
          <h3 className={SECTION_TITLE}>Recent events</h3>
          {eventsState === 'ready' && totalResults !== null && (
            <span className='text-[11px] font-medium text-mf-tx3'>
              Last {events.length} of {totalResults.toLocaleString()} this
              window
            </span>
          )}
        </div>
        <EventsTable
          events={events}
          state={eventsState}
          errorMessage={EVENTS_ERROR}
        />
      </div>

      {agent && (
        <EditAgentDialog
          key={String(showEditDialog)}
          agentId={agentId}
          initialName={agent.name}
          initialDescription={agent.description || ''}
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
        />
      )}

      <AgentStatusDialog
        target={statusTarget}
        onClose={() => setStatusTarget(null)}
        onChanged={onChanged}
      />
    </section>
  )
}
