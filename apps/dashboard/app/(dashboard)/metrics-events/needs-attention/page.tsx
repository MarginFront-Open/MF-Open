'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getNeedsCostBackfillGroups,
  getMissingVolumeGroups,
  getSignalEvent,
  type BackfillGroup,
  type MissingVolumeGroup,
} from '@/app/actions/signal-events'
import {
  signalEventsKeys,
  type SignalEvent,
} from '@/services/signal-events-service'
import { MapModelDialog } from '@/features/signal-events/components/MapModelDialog'
import { FillVolumeDialog } from '@/features/signal-events/components/FillVolumeDialog'
import EventDetailsSidebar from '@/features/signal-events/components/EventDetailsSidebar'
import {
  NEEDS_ATTENTION_TABS,
  resolveNeedsAttentionTab,
  type NeedsAttentionTabCounts,
} from '@/features/signal-events/needs-attention-tabs'
import { getExhaustedCreditPools } from '@/app/actions/credit-pools'
import { CreditPoolResolveDialog } from '@/features/money/components/credit-pool-resolve-dialog'
import {
  type CreditPoolBalanceView,
  type CreditPoolPermission,
} from '@/features/money/credit-pool-types'

// Pinned copy — asserted verbatim by the page test. Don't reword.
const CREDIT_POOL_ACTION_TOOLTIP =
  "Top up adds prepaid units your customer bought (or a credit you're giving them). The countdown and alerts update. The invoice doesn't change. Pause stops the warning emails for this subscription only; tracking and billing keep running."

function EmptyTab({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className='py-12 text-center text-sm text-muted-foreground'>
        {message}
      </CardContent>
    </Card>
  )
}

function NeedsAttentionInner() {
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // Group state — one row per (model, provider) rollup in each section.
  const [groups, setGroups] = useState<BackfillGroup[]>([])
  const [totalEvents, setTotalEvents] = useState(0)
  const [volumeGroups, setVolumeGroups] = useState<MissingVolumeGroup[]>([])
  const [volumeTotalEvents, setVolumeTotalEvents] = useState(0)
  // Credit pools. Sourced from the balance canon, never from
  // raw_ingest_events: a pool never gates ingest, so an empty pool never puts an
  // event into an error state. This section is a heads-up, not a failure.
  const [creditPools, setCreditPools] = useState<CreditPoolBalanceView[]>([])
  const [creditPoolPermission, setCreditPoolPermission] =
    useState<CreditPoolPermission>({ canManage: false, whoCanChange: '' })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Bulk-action dialogs open against one or more groups.
  const [mappingGroups, setMappingGroups] = useState<BackfillGroup[]>([])
  const [fillingGroups, setFillingGroups] = useState<MissingVolumeGroup[]>([])
  // Hold the ID, not the row. `loadGroups()` replaces `creditPools`
  // after every write, so deriving the open pool from the fresh list keeps
  // EVERY number in the dialog current.
  const [resolvingPoolId, setResolvingPoolId] = useState<string | null>(null)
  const resolvingPool =
    creditPools.find((pool) => pool.subscriptionId === resolvingPoolId) ?? null

  // Sidebar state — one EventDetailsSidebar shared across both sections.
  // A row click fetches the group's representative event and opens the sheet.
  const [selectedEvent, setSelectedEvent] = useState<SignalEvent | null>(null)
  const [isSheetOpen, setIsSheetOpen] = useState(false)
  const [loadingEventKey, setLoadingEventKey] = useState<string | null>(null)

  const loadGroups = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [backfillResult, volumeResult, poolResult] = await Promise.all([
        getNeedsCostBackfillGroups(),
        getMissingVolumeGroups(),
        getExhaustedCreditPools(),
      ])

      if (backfillResult.success && backfillResult.data) {
        setGroups(backfillResult.data.groups)
        setTotalEvents(backfillResult.data.totalEvents)
      } else {
        setError(backfillResult.error || 'Failed to load')
      }

      if (volumeResult.success && volumeResult.data) {
        setVolumeGroups(volumeResult.data.groups)
        setVolumeTotalEvents(volumeResult.data.totalEvents)
      }

      if (poolResult.success && poolResult.data) {
        setCreditPools(poolResult.data.pools)
        setCreditPoolPermission(poolResult.data.permission)
      }
    } catch (err) {
      console.error('[NeedsAttentionPage] Error:', err)
      setError('Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  // Click a group row → fetch the representative event (the first eagerly-
  // loaded sample's event ID, already sorted by usageDate DESC in the SQL)
  // and open the sidebar. Mirrors the raw-events row-click UX; the sidebar
  // component is the same one both pages use.
  const handleRowClick = useCallback(
    async (group: BackfillGroup | MissingVolumeGroup) => {
      const eventId = group.samples?.[0]?.eventId
      if (!eventId) return
      const key = `${group.model}-${group.provider}`
      setLoadingEventKey(key)
      try {
        const result = await getSignalEvent(eventId)
        if (result.success && result.data) {
          setSelectedEvent(result.data)
          setIsSheetOpen(true)
        }
      } finally {
        setLoadingEventKey(null)
      }
    },
    []
  )

  // On successful bulk action: drop the completed groups from state so the
  // table updates instantly, then invalidate the event-list cache in case
  // the sidebar or other surfaces are mid-render. No full reload / screen
  // blank — the existing rows transition out smoothly.
  const handleBulkActionSuccess = useCallback(
    (removedKeys: string[]) => {
      const removeSet = new Set(removedKeys)
      setGroups((prev) =>
        prev.filter((g) => !removeSet.has(`${g.model}-${g.provider}`))
      )
      setVolumeGroups((prev) =>
        prev.filter((g) => !removeSet.has(`${g.model}-${g.provider}`))
      )
      queryClient.invalidateQueries({ queryKey: signalEventsKeys.lists() })
      loadGroups()
    },
    [queryClient, loadGroups]
  )

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    } catch {
      return iso
    }
  }

  const hasBackfill = groups.length > 0
  const hasVolume = volumeGroups.length > 0
  const hasCreditPools = creditPools.length > 0
  const hasAnything = hasBackfill || hasVolume || hasCreditPools
  const exhaustedPoolCount = creditPools.filter(
    (p) => p.remainingUnits <= 0
  ).length

  // Tab counts are table rows; each table's header line carries the bigger
  // event total.
  const tabCounts: NeedsAttentionTabCounts = {
    'cost-backfill': groups.length,
    'missing-volume': volumeGroups.length,
    'credit-pools': creditPools.length,
  }
  const tabParam = searchParams.get('tab')
  const activeTab = resolveNeedsAttentionTab(tabParam, tabCounts)

  const handleTabChange = useCallback(
    (tab: string) => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('tab', tab)
      router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
    },
    [searchParams, pathname, router]
  )

  // Pin the auto-picked tab into the URL once counts land: otherwise clearing
  // the open tab's last row re-runs the "first tab with rows" rule and moves
  // the user mid-task.
  useEffect(() => {
    if (isLoading || !hasAnything || tabParam !== null) return
    handleTabChange(activeTab)
  }, [isLoading, hasAnything, tabParam, activeTab, handleTabChange])

  return (
    <Page
      title='Needs Attention'
      description='Things worth a look: unknown models, missing volume data, and credit pools running low'
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Usage Events', href: '/metrics-events' },
          { name: 'Needs Attention' },
        ],
      }}
    >
      <div className='space-y-8'>
        {/* Initial load */}
        {isLoading && (
          <Card>
            <CardContent className='flex items-center justify-center py-12'>
              <Loader2 className='h-6 w-6 animate-spin text-muted-foreground' />
              <span className='ml-2 text-muted-foreground'>
                Loading backfill queue...
              </span>
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && !isLoading && (
          <Card className='border-destructive/50 bg-destructive/5'>
            <CardContent className='py-6 text-center text-destructive'>
              {error}
            </CardContent>
          </Card>
        )}

        {/* Empty — all three tabs clear, so there is nothing to tab between */}
        {!isLoading && !error && !hasAnything && (
          <Card>
            <CardContent className='py-12 text-center'>
              <p className='text-lg font-medium text-green-600'>All clear</p>
              <p className='mt-1 text-sm text-muted-foreground'>
                No events need attention right now.
              </p>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && hasAnything && (
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              {NEEDS_ATTENTION_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label} ({tabCounts[tab.id]})
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value='cost-backfill'>
              {hasBackfill ? (
                <Card>
                  <div className='flex items-center justify-between border-b px-4 py-3'>
                    <div className='flex items-center gap-2'>
                      <AlertTriangle className='h-4 w-4 text-amber-500' />
                      <span className='text-sm font-medium'>
                        {totalEvents} event{totalEvents === 1 ? '' : 's'} across{' '}
                        {groups.length} unknown model
                        {groups.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {groups.length > 1 && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setMappingGroups(groups)}
                      >
                        Map all ({groups.length})
                      </Button>
                    )}
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead className='text-right'>Events</TableHead>
                        <TableHead>Oldest</TableHead>
                        <TableHead className='text-right'>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {groups.map((group) => {
                        const key = `${group.model}-${group.provider}`
                        const isLoadingThisRow = loadingEventKey === key
                        return (
                          <TableRow
                            key={key}
                            onClick={() => handleRowClick(group)}
                            className='cursor-pointer hover:bg-muted/50'
                            data-state={
                              isLoadingThisRow ? 'loading' : undefined
                            }
                          >
                            <TableCell className='font-mono text-sm'>
                              {group.model}
                            </TableCell>
                            <TableCell className='text-muted-foreground'>
                              {group.provider}
                            </TableCell>
                            <TableCell className='text-right font-medium'>
                              {group.count}
                            </TableCell>
                            <TableCell className='text-muted-foreground'>
                              {formatDate(group.oldestEventDate)}
                            </TableCell>
                            <TableCell className='text-right'>
                              <Button
                                size='sm'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMappingGroups([group])
                                }}
                              >
                                Map
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </Card>
              ) : (
                <EmptyTab message='Every model is mapped.' />
              )}
            </TabsContent>

            <TabsContent value='missing-volume'>
              {hasVolume ? (
                <Card>
                  <div className='flex items-center justify-between border-b px-4 py-3'>
                    <div className='flex items-center gap-2'>
                      <AlertTriangle className='h-4 w-4 text-orange-500' />
                      <span className='text-sm font-medium'>
                        {volumeTotalEvents} event
                        {volumeTotalEvents === 1 ? '' : 's'} across{' '}
                        {volumeGroups.length} model
                        {volumeGroups.length === 1 ? '' : 's'} missing volume
                        data
                      </span>
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className='text-right'>Events</TableHead>
                        <TableHead>Oldest</TableHead>
                        <TableHead className='text-right'>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {volumeGroups.map((group) => {
                        const key = `${group.model}-${group.provider}`
                        const isLlm = group.costUnit === '1M tokens'
                        const isLoadingThisRow = loadingEventKey === key
                        return (
                          <TableRow
                            key={key}
                            onClick={() => handleRowClick(group)}
                            className='cursor-pointer hover:bg-muted/50'
                            data-state={
                              isLoadingThisRow ? 'loading' : undefined
                            }
                          >
                            <TableCell className='font-mono text-sm'>
                              {group.model}
                            </TableCell>
                            <TableCell className='text-muted-foreground'>
                              {group.provider}
                            </TableCell>
                            <TableCell>
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                  isLlm
                                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                    : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                                }`}
                              >
                                {isLlm
                                  ? 'LLM'
                                  : group.costUnit?.replace(/^1K /, '') ||
                                    'Non-LLM'}
                              </span>
                            </TableCell>
                            <TableCell className='text-right font-medium'>
                              {group.count}
                            </TableCell>
                            <TableCell className='text-muted-foreground'>
                              {formatDate(group.oldestEventDate)}
                            </TableCell>
                            <TableCell className='text-right'>
                              <Button
                                size='sm'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setFillingGroups([group])
                                }}
                              >
                                Fill volume
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </Card>
              ) : (
                <EmptyTab message='Every event has volume data.' />
              )}
            </TabsContent>

            {/* Credit pools running low. Deliberately NOT framed as
                an error: nothing stops when a pool empties, the overage just
                starts billing. This is the heads-up, and the fix is optional. */}
            <TabsContent value='credit-pools'>
              {hasCreditPools ? (
                <Card>
                  <div className='flex items-center justify-between border-b px-4 py-3'>
                    <div className='flex items-center gap-2'>
                      <AlertTriangle className='h-4 w-4 text-blue-500' />
                      <span className='text-sm font-medium'>
                        {creditPools.length} credit pool
                        {creditPools.length === 1 ? '' : 's'} running low
                        {exhaustedPoolCount > 0 &&
                          ` (${exhaustedPoolCount} at or past zero)`}
                      </span>
                    </div>
                    <span className='text-xs text-muted-foreground'>
                      Working as designed: nothing is blocked, the overage keeps
                      billing.
                    </span>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead className='text-right'>Used</TableHead>
                        <TableHead className='text-right'>Left</TableHead>
                        <TableHead className='text-right'>Overage</TableHead>
                        <TableHead>Alerts</TableHead>
                        <TableHead className='text-right'>
                          <span className='inline-flex items-center gap-1'>
                            Action
                            <InfoTooltip
                              title='Top up or pause'
                              description={CREDIT_POOL_ACTION_TOOLTIP}
                            />
                          </span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {creditPools.map((pool) => (
                        <TableRow key={pool.subscriptionId}>
                          <TableCell className='font-medium'>
                            {pool.customerName ?? 'Unnamed customer'}
                            <p className='text-xs font-normal text-muted-foreground'>
                              {pool.subscriptionName}
                            </p>
                          </TableCell>
                          <TableCell className='text-muted-foreground'>
                            {pool.planName ?? '—'}
                          </TableCell>
                          <TableCell className='text-right'>
                            {Math.round(pool.consumedUnits).toLocaleString()}
                          </TableCell>
                          <TableCell
                            className={`text-right font-medium ${
                              pool.remainingUnits <= 0 ? 'text-destructive' : ''
                            }`}
                          >
                            {Math.round(pool.remainingUnits).toLocaleString()}
                          </TableCell>
                          <TableCell className='text-right text-muted-foreground'>
                            {pool.overageInProgressUnits > 0
                              ? Math.round(
                                  pool.overageInProgressUnits
                                ).toLocaleString()
                              : '—'}
                          </TableCell>
                          <TableCell className='text-muted-foreground'>
                            {pool.alertsPaused ? 'Paused' : 'On'}
                          </TableCell>
                          <TableCell className='text-right'>
                            <Button
                              size='sm'
                              onClick={() =>
                                setResolvingPoolId(pool.subscriptionId)
                              }
                            >
                              Top up or pause
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              ) : (
                <EmptyTab message='No credit pools are running low.' />
              )}
            </TabsContent>
          </Tabs>
        )}

        {/* Credit pool resolve dialog — the SAME component the Money → Plans
            Credit Pools section opens, so both roads resolve identically. */}
        <CreditPoolResolveDialog
          pool={resolvingPool}
          permission={creditPoolPermission}
          onOpenChange={(open) => {
            if (!open) setResolvingPoolId(null)
          }}
          onResolved={loadGroups}
        />

        {/* Map model dialog */}
        {mappingGroups.length > 0 && (
          <MapModelDialog
            open={mappingGroups.length > 0}
            onOpenChange={(open) => {
              if (!open) setMappingGroups([])
            }}
            groups={mappingGroups}
            onSuccess={() => {
              const keys = mappingGroups.map((g) => `${g.model}-${g.provider}`)
              setMappingGroups([])
              handleBulkActionSuccess(keys)
            }}
          />
        )}

        {/* Fill volume dialog */}
        {fillingGroups.length > 0 && (
          <FillVolumeDialog
            open={fillingGroups.length > 0}
            onOpenChange={(open) => {
              if (!open) setFillingGroups([])
            }}
            groups={fillingGroups}
            onSuccess={() => {
              const keys = fillingGroups.map((g) => `${g.model}-${g.provider}`)
              setFillingGroups([])
              handleBulkActionSuccess(keys)
            }}
          />
        )}

        {/* Shared event detail sidebar — same component /raw-events uses. */}
        <EventDetailsSidebar
          event={selectedEvent}
          isOpen={isSheetOpen}
          onOpenChange={setIsSheetOpen}
        />
      </div>
    </Page>
  )
}

export default function NeedsAttentionPage() {
  // useSearchParams needs a Suspense boundary during prerender (same as Money).
  return (
    <Suspense fallback={null}>
      <NeedsAttentionInner />
    </Suspense>
  )
}
