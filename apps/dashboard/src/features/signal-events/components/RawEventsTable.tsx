'use client'

import React, { useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  useSignalEvents,
  SignalEvent,
  GetSignalEventsParams,
} from '@/services/signal-events-service'
import { getSignalEvent } from '@/app/actions/signal-events'
import Link from 'next/link'
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import EventDetailsSidebar from './EventDetailsSidebar'
import RawEventsFilterBar, { EventFilters } from './RawEventsFilterBar'
import { formatCost } from '@/lib/canon-format'

type SortField = 'usageDate' | 'quantity' | 'usageCost'

const PAGE_SIZE_OPTIONS = [25, 50, 100]

interface RawEventsTableProps {
  limit?: number
  // Gates the full-log controls (filter bar, sortable columns, server-side
  // pagination). Off by default so embedded widgets (e.g. the analytics
  // "recent 10") keep the plain newest-first list capped by `limit`.
  enableControls?: boolean
  showViewAllButton?: boolean
  className?: string
  // When set, the sidebar auto-opens for this event on mount. Used by the
  // needs-attention success flow to deep-link from "View in Ingestion Log"
  // straight to the just-backfilled event's detail sidebar — no manual row
  // hunt required. Fires exactly once per mount; subsequent prop changes
  // are ignored (guarded by a ref) so the sidebar doesn't flash-reopen on
  // React Query refetches or other re-renders.
  autoOpenEventId?: string
}

const RawEventsTable: React.FC<RawEventsTableProps> = ({
  limit = 100,
  enableControls = false,
  showViewAllButton = false,
  className = '',
  autoOpenEventId,
}) => {
  const [selectedEvent, setSelectedEvent] = useState<SignalEvent | null>(null)
  const [isSheetOpen, setIsSheetOpen] = useState(false)

  // Full-log controls state. Inert when enableControls is false.
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0])
  const [filters, setFilters] = useState<EventFilters>({})
  const [sortBy, setSortBy] = useState<SortField>('usageDate')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const queryParams: GetSignalEventsParams = enableControls
    ? { page, limit: pageSize, sortBy, sortOrder, ...filters }
    : { limit }

  const { data, isLoading } = useSignalEvents(queryParams)
  const events = data?.results || []
  const totalResults = data?.totalResults ?? 0
  const totalPages = data?.totalPages ?? 1

  const handleFiltersChange = (next: EventFilters) => {
    setFilters(next)
    setPage(1)
  }

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortOrder((order) => (order === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(field)
      setSortOrder('desc')
    }
    setPage(1)
  }

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  // Row click opens the sidebar immediately with the list-shaped event
  // (snappy), then fetches the full event via getSignalEvent in parallel
  // and swaps it in when ready. We need the fetched version because only
  // getSignalEvent computes the backfill `resolution` field — the list
  // query returns the base shape. Swap-in is invisible unless the event
  // was actually backfilled; regular events look identical either way.
  const handleRowClick = (event: SignalEvent) => {
    setSelectedEvent(event)
    setIsSheetOpen(true)
    void getSignalEvent(event.id).then((result) => {
      if (result.success && result.data) {
        // Guard against the user having clicked a different row by the
        // time the fetch resolves — only swap when the fetched event
        // matches the one currently displayed.
        setSelectedEvent((current) =>
          current?.id === result.data!.id ? result.data! : current
        )
      }
    })
  }

  // Auto-open on mount when a deep-link passed ?eventId=<id>.
  //
  // Deliberate anti-pattern: no cleanup-based cancellation guard. React 19
  // StrictMode dev runs effects twice (mount → unmount → mount) and useRef
  // values survive across that simulated cycle. If we set a closure-scoped
  // `cancelled = true` in the cleanup, the re-invoke sees the ref already
  // tripped and bails — which means the FIRST (and only) fetch's resolver
  // sees cancelled === true and drops the state update on the floor. Net
  // effect: the sidebar never opens in dev, even though the fetch succeeded.
  //
  // The ref alone is enough to prevent duplicate fetches. A trailing
  // setState after a genuine unmount is a harmless no-op in React 19 (dev
  // warning at worst; no real bug in prod).
  const autoOpenFiredRef = useRef(false)
  useEffect(() => {
    if (!autoOpenEventId || autoOpenFiredRef.current) return
    autoOpenFiredRef.current = true
    void getSignalEvent(autoOpenEventId).then((result) => {
      if (result.success && result.data) {
        setSelectedEvent(result.data)
        setIsSheetOpen(true)
      }
    })
  }, [autoOpenEventId])

  const formatUsageDate = (usageDate: string) => {
    try {
      return format(new Date(usageDate), 'MMM dd, yyyy HH:mm:ss')
    } catch (_error) {
      return usageDate
    }
  }

  const renderHead = (
    field: SortField,
    label: string,
    align: 'left' | 'right' = 'left'
  ) => {
    const alignClass = align === 'right' ? 'text-right' : ''
    if (!enableControls) {
      return <TableHead className={alignClass}>{label}</TableHead>
    }
    const active = sortBy === field
    const Icon = !active
      ? ChevronsUpDown
      : sortOrder === 'asc'
        ? ChevronUp
        : ChevronDown
    return (
      <TableHead className={alignClass}>
        <button
          type='button'
          onClick={() => handleSort(field)}
          className={`inline-flex items-center gap-1 hover:text-foreground ${
            align === 'right' ? 'ml-auto' : ''
          } ${active ? 'text-foreground' : ''}`}
        >
          {label}
          <Icon className='h-3.5 w-3.5' />
        </button>
      </TableHead>
    )
  }

  const endRow = Math.min(page * pageSize, totalResults)
  // Clamp the start too: if the data shrinks while we're parked past the last
  // page (rare — only via an external refetch), this keeps the range from
  // rendering inverted (e.g. "51–40") until the next nav click self-corrects.
  const startRow =
    totalResults === 0 ? 0 : Math.min((page - 1) * pageSize + 1, endRow)

  return (
    <div className={className}>
      {enableControls && (
        <div className='mb-4'>
          <RawEventsFilterBar
            filters={filters}
            onChange={handleFiltersChange}
          />
        </div>
      )}

      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              {renderHead('usageDate', 'Usage Date')}
              <TableHead>Agent ID</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead>Customer ID</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className='text-right'>In Tokens</TableHead>
              <TableHead className='text-right'>Out Tokens</TableHead>
              {renderHead('quantity', 'Qty', 'right')}
              {renderHead('usageCost', 'Cost', 'right')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array(Math.min(5, enableControls ? pageSize : limit))
                .fill(0)
                .map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className='h-4 w-32' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-32' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-32' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-32' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-32' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-16' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-16' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-8' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-16' />
                    </TableCell>
                  </TableRow>
                ))
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className='h-24 text-center'>
                  No events found
                </TableCell>
              </TableRow>
            ) : (
              events.map((event) => {
                // Multi-service rendering: services[] is the canonical source
                // for model + token data. Single-service events
                // still have a single child whose values mirror the
                // payload's top-level fields. Multi-service events show a
                // "multi-service (N)" badge in the model column and roll up
                // tokens across children.
                const services = event.services ?? []
                const isMulti = services.length > 1
                const modelLabel = isMulti
                  ? `multi-service (${services.length})`
                  : (services[0]?.model ??
                    (event.rawPayload?.model as string | undefined) ??
                    '—')
                const inTokens = isMulti
                  ? services.reduce((s, c) => s + (c.inputTokens ?? 0), 0)
                  : (services[0]?.inputTokens ??
                    (event.rawPayload?.inputTokens as number | undefined))
                const outTokens = isMulti
                  ? services.reduce((s, c) => s + (c.outputTokens ?? 0), 0)
                  : (services[0]?.outputTokens ??
                    (event.rawPayload?.outputTokens as number | undefined))
                return (
                  <TableRow
                    key={event.id}
                    onClick={() => handleRowClick(event)}
                    className='cursor-pointer hover:bg-muted/50'
                  >
                    <TableCell>{formatUsageDate(event.usageDate)}</TableCell>
                    <TableCell className='max-w-[150px] truncate'>
                      {event.agentId}
                    </TableCell>
                    <TableCell>{event.signal?.name || '-'}</TableCell>
                    <TableCell className='max-w-[150px] truncate'>
                      {event.customerId}
                    </TableCell>
                    <TableCell className='max-w-[220px] truncate font-mono text-xs'>
                      {modelLabel}
                    </TableCell>
                    <TableCell className='text-right font-mono text-xs'>
                      {typeof inTokens === 'number' && inTokens > 0
                        ? inTokens.toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell className='text-right font-mono text-xs'>
                      {typeof outTokens === 'number' && outTokens > 0
                        ? outTokens.toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell className='text-right font-mono text-xs'>
                      {event.quantity != null
                        ? event.quantity.toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell className='text-right font-mono text-xs'>
                      {event.usageCost != null
                        ? formatCost(event.usageCost)
                        : '—'}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {enableControls && (
        <div className='mt-4 flex flex-col items-center justify-between gap-3 px-1 sm:flex-row'>
          <div className='text-sm text-muted-foreground'>
            {totalResults === 0
              ? 'No events'
              : `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${totalResults.toLocaleString()}`}
          </div>
          <div className='flex items-center gap-4 sm:gap-6'>
            <div className='flex items-center gap-2'>
              <span className='hidden text-sm text-muted-foreground sm:block'>
                Rows per page
              </span>
              <Select
                value={`${pageSize}`}
                onValueChange={(value) => handlePageSizeChange(Number(value))}
              >
                <SelectTrigger className='h-8 w-[72px]'>
                  <SelectValue placeholder={`${pageSize}`} />
                </SelectTrigger>
                <SelectContent side='top'>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={`${size}`}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='text-sm font-medium'>
              Page {page} of {totalPages || 1}
            </div>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                className='hidden h-8 w-8 p-0 lg:flex'
                onClick={() => setPage(1)}
                disabled={page <= 1}
              >
                <span className='sr-only'>First page</span>
                <ChevronsLeft className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='h-8 w-8 p-0'
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <span className='sr-only'>Previous page</span>
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='h-8 w-8 p-0'
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <span className='sr-only'>Next page</span>
                <ChevronRight className='h-4 w-4' />
              </Button>
              <Button
                variant='outline'
                className='hidden h-8 w-8 p-0 lg:flex'
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
              >
                <span className='sr-only'>Last page</span>
                <ChevronsRight className='h-4 w-4' />
              </Button>
            </div>
          </div>
        </div>
      )}

      {showViewAllButton && (
        <div className='mt-4 flex justify-end'>
          <Button variant='outline' asChild>
            <Link href='/metrics-events/raw-events'>
              View Full Ingestion Log
            </Link>
          </Button>
        </div>
      )}

      <EventDetailsSidebar
        event={selectedEvent}
        isOpen={isSheetOpen}
        onOpenChange={setIsSheetOpen}
      />
    </div>
  )
}

export default RawEventsTable
