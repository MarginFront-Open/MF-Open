'use client'

/**
 * WHAT THIS FILE DOES: The Matters sub-tab — the org's matter
 * list with all-time actual AI cost, an add-matter row, edit (see
 * matter-edit-dialog.tsx), close/reopen, delete, and a per-matter detail
 * dialog where an operator can re-assign or unassign individual events (the
 * manual override that outranks tag and rule).
 *
 * WHY IT EXISTS: matters are the unit a law firm bills against; this is
 * where they're created and corrected.
 *
 * CONNECTS TO: app/actions/matters.ts (all data + writes), ../index.tsx
 * (mounts this per tab and refreshes the Unassigned badge via onChanged).
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  assignEventToMatter,
  deleteMatter,
  getMatterDetail,
  getMatters,
  upsertMatter,
  type MatterDetail,
  type MatterRow,
} from '@/app/actions/matters'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import MatterEditDialog from './matter-edit-dialog'

const SOURCE_LABEL: Record<string, string> = {
  tag: 'Tagged at ingest',
  rule: 'Routing rule',
  manual: 'Manual',
}

export default function MattersTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [matters, setMatters] = useState<MatterRow[]>([])
  const [newNumber, setNewNumber] = useState('')
  const [newName, setNewName] = useState('')
  const [newClient, setNewClient] = useState('')
  const [detail, setDetail] = useState<MatterDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState<MatterRow | null>(null)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true)
      try {
        setMatters(await getMatters())
      } catch (err) {
        toast({
          title: 'Failed to load matters',
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

  const handleAdd = () => {
    startTransition(async () => {
      const result = await upsertMatter({
        matterNumber: newNumber,
        name: newName,
        clientName: newClient,
      })
      if (!result.success) {
        toast({
          title: 'Matter not saved',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      setNewNumber('')
      setNewName('')
      setNewClient('')
      toast({ title: 'Matter created' })
      load()
    })
  }

  const handleToggleStatus = (matter: MatterRow) => {
    startTransition(async () => {
      const result = await upsertMatter({
        id: matter.id,
        matterNumber: matter.matterNumber,
        name: matter.name,
        clientName: matter.clientName,
        status: matter.status === 'open' ? 'closed' : 'open',
        responsibleUserId: matter.responsibleUserId,
      })
      if (!result.success) {
        toast({
          title: 'Status not changed',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      load()
    })
  }

  const handleDelete = (matter: MatterRow) => {
    // The browser confirm is deliberate friction: deleting a matter sends its
    // events back to Unassigned.
    if (
      !window.confirm(
        `Delete matter ${matter.matterNumber}? Its ${matter.eventCount} events move back to Unassigned.`
      )
    ) {
      return
    }
    startTransition(async () => {
      const result = await deleteMatter(matter.id)
      if (!result.success) {
        toast({
          title: 'Matter not deleted',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      toast({
        title: 'Matter deleted',
        description: 'Its events are back in Unassigned.',
      })
      load()
      onChanged()
    })
  }

  const openDetail = (matterId: string) => {
    startTransition(async () => {
      const result = await getMatterDetail(matterId)
      if (!result) {
        toast({ title: 'Matter not found', variant: 'destructive' })
        return
      }
      setDetail(result)
      setDetailOpen(true)
    })
  }

  const handleReassign = (eventId: string, target: string) => {
    startTransition(async () => {
      const matterId = target === '__unassign' ? null : target
      const result = await assignEventToMatter(eventId, matterId)
      if (!result.success) {
        toast({
          title: 'Event not reassigned',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      if (detail) {
        const refreshed = await getMatterDetail(detail.matter.id)
        setDetail(refreshed)
      }
      load()
      onChanged()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matters</CardTitle>
        <CardDescription>
          Cost is the actual AI spend attributed to each matter, across all
          time. Tag events with metadata.matterId, or add routing rules on the
          Rules tab.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-end gap-2'>
          <Input
            placeholder='Matter number (e.g. M-2024-017)'
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            className='w-[200px]'
          />
          <Input
            placeholder='Matter name'
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className='w-[220px]'
          />
          <Input
            placeholder='Client or team'
            value={newClient}
            onChange={(e) => setNewClient(e.target.value)}
            className='w-[200px]'
          />
          <Button size='sm' onClick={handleAdd} disabled={isPending}>
            <Plus className='mr-1 h-3.5 w-3.5' />
            Add matter
          </Button>
        </div>

        {loading ? (
          <Skeleton className='h-32 w-full' />
        ) : matters.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No matters yet. Add your first matter above; its number is what you
            put in metadata.matterId when recording usage.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Matter #</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className='text-right'>Actual cost</TableHead>
                <TableHead className='text-right'>Events</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {matters.map((matter) => (
                <TableRow key={matter.id}>
                  <TableCell className='font-mono text-xs'>
                    {matter.matterNumber}
                  </TableCell>
                  <TableCell>{matter.name}</TableCell>
                  <TableCell>{matter.clientName}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        matter.status === 'open' ? 'default' : 'secondary'
                      }
                    >
                      {matter.status}
                    </Badge>
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {formatUsd(matter.actualCost)}
                    {matter.eventsMissingCost > 0 && (
                      <span className='block text-xs text-muted-foreground'>
                        {matter.eventsMissingCost} pending
                      </span>
                    )}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {matter.eventCount}
                  </TableCell>
                  <TableCell className='flex justify-end gap-1'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => openDetail(matter.id)}
                      title='View events'
                    >
                      <Eye className='h-3.5 w-3.5' />
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setEditing(matter)}
                      disabled={isPending}
                      title='Edit matter'
                    >
                      <Pencil className='h-3.5 w-3.5' />
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => handleToggleStatus(matter)}
                      disabled={isPending}
                    >
                      {matter.status === 'open' ? 'Close' : 'Reopen'}
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => handleDelete(matter)}
                      disabled={isPending}
                      title='Delete matter'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <MatterEditDialog
        matter={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          load()
        }}
      />

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className='max-w-3xl'>
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {detail.matter.matterNumber} · {detail.matter.name}
                </DialogTitle>
                <DialogDescription>
                  {detail.matter.clientName} · {detail.eventCount} events ·{' '}
                  {formatUsd(detail.actualCost)} actual AI cost
                  {detail.eventsMissingCost > 0 &&
                    ` (${detail.eventsMissingCost} events still pending a price, counted as $0 here)`}
                  . Showing the 100 most recent events; the audit CSV carries
                  the full record.
                </DialogDescription>
              </DialogHeader>
              <div className='max-h-[420px] overflow-y-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Signal</TableHead>
                      <TableHead className='text-right'>Cost</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Move to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.events.map((event) => (
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
                          <Badge variant='outline'>
                            {SOURCE_LABEL[event.source ?? ''] ?? 'Unassigned'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Select
                            onValueChange={(value) =>
                              handleReassign(event.eventId, value)
                            }
                          >
                            <SelectTrigger className='h-7 w-[160px]'>
                              <SelectValue placeholder='Reassign' />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value='__unassign'>
                                Unassign
                              </SelectItem>
                              {matters
                                .filter((m) => m.id !== detail.matter.id)
                                .map((m) => (
                                  <SelectItem key={m.id} value={m.id}>
                                    {m.matterNumber}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
