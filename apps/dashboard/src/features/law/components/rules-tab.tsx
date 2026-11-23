'use client'

/**
 * WHAT THIS FILE DOES: The Rules sub-tab — the priority-ordered
 * routing rules that sweep untagged usage events onto matters, plus the
 * explicit "Apply rules to unassigned" pass.
 *
 * WHY IT EXISTS: firms whose agents don't tag every call still need the
 * per-matter record; rules catch the bulk by agent, customer, or signal name.
 *
 * CONNECTS TO: app/actions/matter-rules.ts (all data + writes),
 * app/actions/matters.ts (the matter options), api-nest
 * matter-attribution.util.ts (the same matcher semantics at ingest).
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import {
  applyMatterRulesToUnassigned,
  deleteMatterRule,
  getMatterRules,
  upsertMatterRule,
  type MatterRuleRow,
} from '@/app/actions/matter-rules'
import { getMatters, type MatterRow } from '@/app/actions/matters'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

export default function RulesTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<MatterRuleRow[]>([])
  const [matters, setMatters] = useState<MatterRow[]>([])
  const [newPriority, setNewPriority] = useState('100')
  const [newAgentCode, setNewAgentCode] = useState('')
  const [newCustomerId, setNewCustomerId] = useState('')
  const [newSignalPattern, setNewSignalPattern] = useState('')
  const [newMatterId, setNewMatterId] = useState('')
  const [isPending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true)
      try {
        const [ruleRows, matterRows] = await Promise.all([
          getMatterRules(),
          getMatters(),
        ])
        setRules(ruleRows)
        setMatters(matterRows)
      } catch (err) {
        toast({
          title: 'Failed to load routing rules',
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
    if (!newMatterId) {
      toast({
        title: 'Pick a matter',
        description: 'Every rule routes events onto one matter.',
        variant: 'destructive',
      })
      return
    }
    startTransition(async () => {
      // Number.isFinite, not `|| 100`: a user-entered priority 0 is falsy but
      // means "run this first" — it must survive the parse.
      const parsedPriority = Number.parseInt(newPriority, 10)
      const result = await upsertMatterRule({
        matterId: newMatterId,
        priority: Number.isFinite(parsedPriority) ? parsedPriority : 100,
        agentCode: newAgentCode,
        customerExternalId: newCustomerId,
        signalPattern: newSignalPattern,
      })
      if (!result.success) {
        toast({
          title: 'Rule not saved',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      setNewAgentCode('')
      setNewCustomerId('')
      setNewSignalPattern('')
      toast({ title: 'Rule added' })
      load()
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const result = await deleteMatterRule(id)
      if (!result.success) {
        toast({
          title: 'Rule not deleted',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      load()
    })
  }

  const handleApply = () => {
    startTransition(async () => {
      const result = await applyMatterRulesToUnassigned()
      if (!result.success) {
        // A partial run still moved events (rules commit one by one), and
        // this tab is all client state — refresh or the badge contradicts
        // the "stopped partway" toast.
        if (result.assigned > 0) {
          load()
          onChanged()
        }
        toast({
          title: 'Rules not applied',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      toast({
        title:
          result.assigned === 0
            ? 'Nothing to assign'
            : `${result.assigned} event${result.assigned === 1 ? '' : 's'} assigned`,
        description:
          result.assigned === 0
            ? 'No unassigned event matched a rule. Tagged, ruled, and manually handled events are never touched.'
            : 'Only events with no matter and no prior attribution were swept.',
      })
      load()
      onChanged()
    })
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between'>
        <div>
          <CardTitle>Routing rules</CardTitle>
          <CardDescription>
            First match wins, lowest priority number first. A rule matches when
            every filled field matches: agent code and customer ID must match
            exactly, and the signal matches when its name contains your text
            (capitals don&apos;t matter). A direct metadata.matterId tag always
            beats a rule.
          </CardDescription>
        </div>
        <Button size='sm' onClick={handleApply} disabled={isPending}>
          <Wand2 className='mr-1 h-3.5 w-3.5' />
          Apply rules to unassigned
        </Button>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-end gap-2'>
          <Input
            placeholder='Priority'
            type='number'
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value)}
            className='w-[90px]'
          />
          <Input
            placeholder='Agent code'
            value={newAgentCode}
            onChange={(e) => setNewAgentCode(e.target.value)}
            className='w-[160px]'
          />
          <Input
            placeholder='Customer ID'
            value={newCustomerId}
            onChange={(e) => setNewCustomerId(e.target.value)}
            className='w-[160px]'
          />
          <Input
            placeholder='Signal contains'
            value={newSignalPattern}
            onChange={(e) => setNewSignalPattern(e.target.value)}
            className='w-[160px]'
          />
          <Select value={newMatterId} onValueChange={setNewMatterId}>
            <SelectTrigger className='w-[180px]'>
              <SelectValue placeholder='Assign to matter' />
            </SelectTrigger>
            <SelectContent>
              {matters.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.matterNumber} · {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size='sm' onClick={handleAdd} disabled={isPending}>
            <Plus className='mr-1 h-3.5 w-3.5' />
            Add rule
          </Button>
        </div>

        {loading ? (
          <Skeleton className='h-32 w-full' />
        ) : rules.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No rules yet. Add one above to sweep untagged events onto a matter,
            by agent, customer, or signal name.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[80px]'>Priority</TableHead>
                <TableHead>Agent code</TableHead>
                <TableHead>Customer ID</TableHead>
                <TableHead>Signal contains</TableHead>
                <TableHead>Assigns to</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className='tabular-nums'>
                    {rule.priority}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {rule.agentCode ?? (
                      <span className='text-muted-foreground'>any</span>
                    )}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {rule.customerExternalId ?? (
                      <span className='text-muted-foreground'>any</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {rule.signalPattern ?? (
                      <span className='text-muted-foreground'>any</span>
                    )}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {rule.matterNumber}
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => handleDelete(rule.id)}
                      disabled={isPending}
                      title='Delete rule'
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
    </Card>
  )
}
