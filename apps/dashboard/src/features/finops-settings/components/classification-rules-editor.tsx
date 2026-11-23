'use client'

/**
 * WHAT THIS FILE DOES: The "Classification rules" editor — the table where a
 *   finance user adds/removes the keyword rules that auto-sort each AI signal
 *   into a cost bucket (COGS, R&D, etc.), plus "Restore defaults". It lives on
 *   the FinOps Settings page.
 *
 * WHY IT EXISTS: the two "setup" editors (this one + Chart of Accounts) sit on
 *   a dedicated FinOps Settings page so Cost Management stays a short
 *   "what am I spending" view. The editor self-fetches its own data.
 *
 *   WHY IT FETCHES SIGNALS TOO: the "Scope" dropdown (and the rule list's agent
 *   column) need the org's agent list, which is derived from the loaded
 *   signals. getSignalsForClassification is called only to build the agent
 *   options.
 *
 * CONNECTS TO:
 *   - ../index.tsx (the FinOps Settings page that stacks this + the GL editor)
 *   - app/actions/classification-rules.ts (get / upsert / delete / restore)
 *   - app/actions/signal-classification.ts (signals → agent options only)
 *   - features/cost-management/.../cost-classification-panel.tsx READS the
 *     rules (for its "Suggest classifications" button) but does not edit
 *     them. The server actions' revalidatePath keeps both pages in sync.
 */

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Plus, Trash2, RotateCcw } from 'lucide-react'
import {
  getClassificationRules,
  upsertClassificationRule,
  deleteClassificationRule,
  restoreDefaultClassificationRules,
} from '@/app/actions/classification-rules'
import {
  getSignalsForClassification,
  type SignalClassificationRow,
} from '@/app/actions/signal-classification'
import type {
  CostCategoryKey,
  ClassificationRule,
} from '@/features/cost-management/classification-utils'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
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
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

// Human-readable label + accent color per cost category. Kept local to this
// editor (and its GL-editor sibling) on purpose: the cost panel keeps its own
// copy too.
const CATEGORY_LABEL: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'Production COGS',
  DEVELOPMENT_RD: 'Development / R&D',
  SALES_SM: 'Sales & Marketing',
  GENERAL_GA: 'General & Admin',
  INTERNAL_TOOL: 'Internal tooling',
  UNCLASSIFIED: 'Unclassified',
}

const CATEGORY_COLOR: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'hsl(var(--chart-1))',
  DEVELOPMENT_RD: 'hsl(var(--chart-2))',
  SALES_SM: 'hsl(var(--chart-4))',
  GENERAL_GA: 'hsl(var(--chart-5))',
  INTERNAL_TOOL: 'hsl(var(--chart-3))',
  UNCLASSIFIED: 'hsl(var(--muted-foreground))',
}

export default function ClassificationRulesEditor() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<ClassificationRule[]>([])
  const [signals, setSignals] = useState<SignalClassificationRow[]>([])
  const [newPattern, setNewPattern] = useState('')
  const [newCategory, setNewCategory] =
    useState<Exclude<CostCategoryKey, 'UNCLASSIFIED'>>('PRODUCTION_COGS')
  const [newAgentId, setNewAgentId] = useState<string>('__any')
  const [isPending, startTransition] = useTransition()

  const loadAll = () => {
    startTransition(async () => {
      setLoading(true)
      try {
        // Signals are fetched only to derive the agent-scope options below.
        const [ruleRows, signalRows] = await Promise.all([
          getClassificationRules(),
          getSignalsForClassification(),
        ])
        setRules(ruleRows)
        setSignals(signalRows)
      } catch (err) {
        toast({
          title: 'Failed to load classification rules',
          description: (err as Error)?.message ?? 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    })
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  // List of unique agents from the loaded signals — used to populate the
  // agent-scope dropdown when adding a rule. Keeps the UI consistent with
  // what's actually classifiable without a separate agents fetch.
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of signals) {
      if (!seen.has(s.agentId)) seen.set(s.agentId, s.agentName)
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  }, [signals])

  const handleAddRule = async () => {
    const pattern = newPattern.trim()
    if (!pattern) {
      toast({
        title: 'Pattern required',
        description: 'Enter a substring to match against signal names.',
        variant: 'destructive',
      })
      return
    }
    // Place the new rule at the end (highest priority value = lowest precedence)
    const nextPriority =
      rules.length > 0 ? Math.max(...rules.map((r) => r.priority)) + 10 : 100
    const res = await upsertClassificationRule({
      pattern,
      category: newCategory,
      agentId: newAgentId === '__any' ? null : newAgentId,
      priority: nextPriority,
    })
    if (!res.success || !res.rule) {
      toast({
        title: 'Could not add rule',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    setRules((r) => [...r, res.rule!].sort((a, b) => a.priority - b.priority))
    setNewPattern('')
    setNewCategory('PRODUCTION_COGS')
    setNewAgentId('__any')
  }

  const handleDeleteRule = async (id: string) => {
    const previous = rules
    setRules((r) => r.filter((rule) => rule.id !== id))
    const res = await deleteClassificationRule(id)
    if (!res.success) {
      setRules(previous)
      toast({
        title: 'Could not delete rule',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    // Success toast only — no confirmation dialog or impact count.
    // Unlike a GL-code delete (SetNull cascade un-maps signals), rules are
    // advisory: there's no FK from signals to rules, so deleting one changes no
    // existing classification. Lower stakes, so a toast confirms it.
    toast({
      title: 'Rule deleted',
      description: 'Existing signal classifications are unchanged.',
    })
  }

  const handleRestoreDefaults = async () => {
    const res = await restoreDefaultClassificationRules()
    if (!res.success) {
      toast({
        title: 'Could not restore defaults',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    toast({
      title: 'Defaults restored',
      description: `${res.count} default rule${res.count === 1 ? '' : 's'} re-seeded. User-added rules kept.`,
    })
    const fresh = await getClassificationRules()
    setRules(fresh)
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-6 w-48' />
          <Skeleton className='mt-2 h-4 w-80' />
        </CardHeader>
        <CardContent>
          <Skeleton className='h-40 w-full' />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center'>
          <div>
            <CardTitle>Classification rules</CardTitle>
            <CardDescription>
              Keyword rules that auto-sort each signal into a cost bucket. Lower
              priority = matched first. First match wins. These power the
              &ldquo;Suggest classifications&rdquo; button on Cost Management.
            </CardDescription>
          </div>
          <Button
            size='sm'
            variant='ghost'
            onClick={handleRestoreDefaults}
            disabled={isPending}
            className='gap-1.5'
          >
            <RotateCcw className='h-3.5 w-3.5' />
            Restore defaults
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[60px]'>Priority</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className='w-[200px]'>Category</TableHead>
                <TableHead className='w-[60px]' />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className='py-6 text-center text-sm text-muted-foreground'
                  >
                    No rules yet. Defaults will be seeded on next refresh, or
                    add one below.
                  </TableCell>
                </TableRow>
              ) : (
                rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className='font-mono text-xs text-muted-foreground'>
                      {rule.priority}
                    </TableCell>
                    <TableCell>
                      <code className='rounded bg-muted px-1.5 py-0.5 text-xs'>
                        {rule.pattern}
                      </code>
                      {rule.isDefault && (
                        <Badge variant='secondary' className='ml-2 text-xs'>
                          default
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {rule.agentId
                        ? (agentOptions.find((a) => a.id === rule.agentId)
                            ?.name ?? 'Agent removed')
                        : 'Any agent'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='secondary'
                        style={{
                          borderLeft: `3px solid ${CATEGORY_COLOR[rule.category]}`,
                        }}
                      >
                        {CATEGORY_LABEL[rule.category]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => handleDeleteRule(rule.id)}
                        disabled={isPending}
                        aria-label='Delete rule'
                      >
                        <Trash2 className='h-3.5 w-3.5 text-muted-foreground' />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Add-new-rule row */}
        <div className='mt-3 flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center'>
          <div className='flex-1'>
            <Input
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              placeholder='Substring to match (e.g. "eval", "backfill")'
              className='h-9'
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddRule()
              }}
            />
          </div>
          <Select value={newAgentId} onValueChange={(v) => setNewAgentId(v)}>
            <SelectTrigger className='h-9 w-full sm:w-[180px]'>
              <SelectValue placeholder='Scope' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__any'>Any agent</SelectItem>
              {agentOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={newCategory}
            onValueChange={(v) =>
              setNewCategory(v as Exclude<CostCategoryKey, 'UNCLASSIFIED'>)
            }
          >
            <SelectTrigger className='h-9 w-full sm:w-[200px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='PRODUCTION_COGS'>
                {CATEGORY_LABEL.PRODUCTION_COGS}
              </SelectItem>
              <SelectItem value='DEVELOPMENT_RD'>
                {CATEGORY_LABEL.DEVELOPMENT_RD}
              </SelectItem>
              <SelectItem value='SALES_SM'>
                {CATEGORY_LABEL.SALES_SM}
              </SelectItem>
              <SelectItem value='GENERAL_GA'>
                {CATEGORY_LABEL.GENERAL_GA}
              </SelectItem>
              <SelectItem value='INTERNAL_TOOL'>
                {CATEGORY_LABEL.INTERNAL_TOOL}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            size='sm'
            onClick={handleAddRule}
            disabled={isPending || !newPattern.trim()}
            className='gap-1.5'
          >
            <Plus className='h-3.5 w-3.5' />
            Add rule
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
