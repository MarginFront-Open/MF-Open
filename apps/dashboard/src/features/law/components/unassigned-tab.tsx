'use client'

/**
 * WHAT THIS FILE DOES: The Unassigned sub-tab — the visible
 * bucket of usage events with no matter, with per-event manual assignment
 * (the correction that outranks tag and rule).
 *
 * WHY IT EXISTS: unattributed cost is unbillable cost; keeping it a visible
 * list (never a silent bucket) is the precedence pattern's whole point.
 *
 * CONNECTS TO: app/actions/matters.ts (data + assignEventToMatter),
 * ../index.tsx (badge refresh via onChanged).
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  assignEventToMatter,
  getMatters,
  getUnassignedEvents,
  type MatterRow,
  type UnassignedSummary,
} from '@/app/actions/matters'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatUsd } from '../format-usd'

export default function UnassignedTab({
  onChanged,
}: {
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<UnassignedSummary | null>(null)
  const [matters, setMatters] = useState<MatterRow[]>([])
  const [isPending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true)
      try {
        const [unassigned, matterRows] = await Promise.all([
          getUnassignedEvents(),
          getMatters(),
        ])
        setSummary(unassigned)
        setMatters(matterRows)
      } catch (err) {
        toast({
          title: 'Failed to load unassigned events',
          description: (err as Error)?.message ?? 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    })
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const handleAssign = (eventId: string, matterId: string) => {
    startTransition(async () => {
      const result = await assignEventToMatter(eventId, matterId)
      if (!result.success) {
        toast({
          title: 'Event not assigned',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Event assigned' })
      load()
      onChanged()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          Unassigned events
          {summary && <Badge variant='secondary'>{summary.count}</Badge>}
        </CardTitle>
        <CardDescription>
          {summary
            ? `${formatUsd(summary.totalCost)} of AI cost has no matter yet.` +
              (summary.eventsMissingCost > 0
                ? ` ${summary.eventsMissingCost} of these events are still pending a price and count as $0 here.`
                : '') +
              ' Assign events here, or add routing rules and run them from the Rules tab.'
            : 'AI cost with no matter yet.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className='h-32 w-full' />
        ) : !summary || summary.count === 0 ? (
          <p className='text-sm text-muted-foreground'>
            Every event has a matter. New usage that neither carries a tag nor
            matches a rule will show up here.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead className='text-right'>Cost</TableHead>
                  <TableHead>Assign to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.events.map((event) => (
                  <TableRow key={event.eventId}>
                    <TableCell className='whitespace-nowrap text-xs'>
                      {event.usageDate.slice(0, 10)}
                    </TableCell>
                    <TableCell>{event.agentName}</TableCell>
                    <TableCell>{event.signalName}</TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {event.usageCost === null
                        ? 'pending'
                        : formatUsd(event.usageCost)}
                    </TableCell>
                    <TableCell>
                      <Select
                        onValueChange={(value) =>
                          handleAssign(event.eventId, value)
                        }
                        disabled={isPending || matters.length === 0}
                      >
                        <SelectTrigger className='h-7 w-[180px]'>
                          <SelectValue
                            placeholder={
                              matters.length === 0
                                ? 'No matters yet'
                                : 'Pick a matter'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {matters.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.matterNumber} · {m.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {summary.count > summary.events.length && (
              <p className='mt-2 text-xs text-muted-foreground'>
                Showing the {summary.events.length} most recent of{' '}
                {summary.count} unassigned events. Routing rules on the Rules
                tab can sweep the rest in one pass.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
