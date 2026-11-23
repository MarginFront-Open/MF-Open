'use client'

/**
 * Cost Classification Panel — COGS vs R&D vs Internal vs Unclassified.
 *
 * Lives at the top of the Cost Management page so the first thing a CFO sees
 * is the accounting split, not the per-day chart. Pulls data from the cost
 * server actions:
 *   - getCostClassificationBreakdown: aggregate $ + event counts per category
 *     and per environment (for the period filter, scoped to the active org).
 *   - getSignalsForClassification: full signal list with current bucket,
 *     edited inline via classifySignal.
 *   - getClassificationRules / getChartOfAccounts: loaded READ-ONLY (see below).
 *   - getJournalExport: drives the unmapped-cost warning + the CSV export period
 *     label (the journal CSV export is homed here).
 *
 * The Classification-rules and Chart-of-Accounts EDITORS live on the FinOps
 *   Settings page (src/features/finops-settings/), and the journal-by-GL
 *   TABLE lives only on Month-End Close. This panel loads rules + GL codes
 *   read-only because the Suggest button evaluates the rules and the signals
 *   table's GL dropdown needs the GL list.
 *
 * The math is canonical (getCostMetrics in @marginfront/db) — this component is
 * presentation only. Don't sum or recompute anything here.
 */

import { useEffect, useMemo, useState, useTransition } from 'react'
import { ArrowRight } from 'lucide-react'
import {
  getCostClassificationBreakdown,
  type CostClassificationBreakdown,
  type CostCategoryKey,
} from '@/app/actions/cost-command-center'
import type { WindowFilter } from '@/app/actions/_shared/parse-window-filter'
import {
  getSignalsForClassification,
  classifySignal,
  bulkClassifyUnclassifiedSignals,
  type SignalClassificationRow,
} from '@/app/actions/signal-classification'
// Read-only: rules feed the "Suggest classifications" button and GL codes feed
// the signals table's GL-assign dropdown. The mutation actions belong to the
// editors in src/features/finops-settings/.
import { getClassificationRules } from '@/app/actions/classification-rules'
import {
  getChartOfAccounts,
  assignSignalToGlCode,
} from '@/app/actions/chart-of-accounts'
import {
  getJournalExport,
  type JournalExport,
} from '@/app/actions/journal-export'
import { Download } from 'lucide-react'
import {
  evaluateRulesForSignal,
  suggestCostCategoryForSignalName,
  type ClassificationRule,
  type GlCode,
} from '@/features/cost-management/classification-utils'
import { formatCurrency } from '@/lib/canon-format'
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

const CATEGORY_LABEL: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'Production COGS',
  DEVELOPMENT_RD: 'Development / R&D',
  SALES_SM: 'Sales & Marketing',
  GENERAL_GA: 'General & Admin',
  INTERNAL_TOOL: 'Internal tooling',
  UNCLASSIFIED: 'Unclassified',
}

// Color palette tied to the existing chart CSS vars so this component matches
// the rest of Cost Management visually. COGS = chart-1 (primary), R&D = chart-2.
const CATEGORY_COLOR: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'hsl(var(--chart-1))',
  DEVELOPMENT_RD: 'hsl(var(--chart-2))',
  SALES_SM: 'hsl(var(--chart-4))',
  GENERAL_GA: 'hsl(var(--chart-5))',
  INTERNAL_TOOL: 'hsl(var(--chart-3))',
  UNCLASSIFIED: 'hsl(var(--muted-foreground))',
}

export default function CostClassificationPanel({
  filter,
  periodLabel,
}: {
  /** Billing-period window threaded from the page. Omitted = last 30 days. */
  filter?: WindowFilter
  /** Human label for the window (e.g. "June 2026"), used in the copy. */
  periodLabel?: string
} = {}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<CostClassificationBreakdown | null>(null)
  const [signals, setSignals] = useState<SignalClassificationRow[]>([])
  // `rules` and `glCodes` are READ-ONLY on this page: `rules` for the Suggest
  // button's rule evaluation, `glCodes` for the signals table's GL-assign
  // dropdown.
  const [rules, setRules] = useState<ClassificationRule[]>([])
  const [glCodes, setGlCodes] = useState<GlCode[]>([])
  const [journal, setJournal] = useState<JournalExport | null>(null)
  const [journalFormat, setJournalFormat] = useState<'summary' | 'journal'>(
    'summary'
  )
  const [isPending, startTransition] = useTransition()

  const loadAll = () => {
    startTransition(async () => {
      setLoading(true)
      try {
        // Window-scoped calls take the period filter so the breakdown + journal
        // reflect the selected month (canon W1). The signal/rule/GL lists are
        // global (not windowed), so they take no filter.
        const [breakdown, signalRows, ruleRows, glRows, journalRows] =
          await Promise.all([
            getCostClassificationBreakdown(filter),
            getSignalsForClassification(),
            getClassificationRules(),
            getChartOfAccounts(),
            getJournalExport(filter),
          ])
        setData(breakdown)
        setSignals(signalRows)
        setRules(ruleRows)
        setGlCodes(glRows)
        setJournal(journalRows)
      } catch (err) {
        toast({
          title: 'Failed to load classification',
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
    // Re-fetch when the selected period changes. loadAll closes over the latest
    // filter, so we key the effect on the primitive bounds (not loadAll itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the period bounds change
  }, [filter?.startDate, filter?.endDate])

  const unclassifiedSignals = useMemo(
    () => signals.filter((s) => s.isUnclassified),
    [signals]
  )

  // Optimistic single-row mutation. We update local state first so the table
  // feels snappy even if the server action takes a moment, then revert on
  // failure. revalidatePath in the action refreshes other consumers.
  // suggestedCategory captures what the rule list WOULD have picked so the
  // override log records suggestion vs. choice.
  const handleClassify = async (signalId: string, next: CostCategoryKey) => {
    const signal = signals.find((s) => s.id === signalId)
    const previous = signal?.costCategory
    const suggested = signal
      ? evaluateRulesForSignal(signal.name, signal.agentId, rules)
      : null
    setSignals((rows) =>
      rows.map((s) =>
        s.id === signalId
          ? {
              ...s,
              costCategory: next,
              isUnclassified: next === 'UNCLASSIFIED',
            }
          : s
      )
    )
    const res = await classifySignal(signalId, next, {
      suggestedCategory: suggested,
      source: 'inline_dropdown',
    })
    if (!res.success) {
      // Revert on failure.
      setSignals((rows) =>
        rows.map((s) =>
          s.id === signalId && previous
            ? {
                ...s,
                costCategory: previous,
                isUnclassified: previous === 'UNCLASSIFIED',
              }
            : s
        )
      )
      toast({
        title: 'Could not update classification',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    const fresh = await getCostClassificationBreakdown(filter)
    setData(fresh)
  }

  // Evaluates each unclassified signal against the org's rule list. If a
  // rule matches → use its category. If no rule matches → fall back to the
  // built-in name heuristic (which always returns a non-null category).
  // This means the button is useful whether the org has tuned the rules or
  // not.
  const handleApplySuggestions = async () => {
    if (unclassifiedSignals.length === 0) return
    // Track WHERE each guess came from so the success toast tells the truth.
    // A "rule match" means the org's own classification rules picked the
    // bucket; a "name guess" means no rule matched and we fell back to the
    // built-in keyword heuristic. Crediting the rules for every signal would
    // be false whenever the guesser did the work (e.g. an org with zero
    // rules), and a CFO-facing number needs true provenance.
    let ruleMatched = 0
    let nameGuessed = 0
    const assignments = unclassifiedSignals.map((s) => {
      const ruleMatch = evaluateRulesForSignal(s.name, s.agentId, rules)
      if (ruleMatch !== null) ruleMatched++
      else nameGuessed++
      const chosen = ruleMatch ?? suggestCostCategoryForSignalName(s.name)
      return {
        id: s.id,
        costCategory: chosen,
        suggestedCategory: chosen,
      }
    })
    const res = await bulkClassifyUnclassifiedSignals(assignments)
    if (!res.success) {
      toast({
        title: 'Bulk classification failed',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    // Build the provenance sentence from whichever sources actually fired.
    // Only name "your rules" when a rule really matched; only name the guesser
    // when it really ran. Every row stays editable in the table below, so we
    // always remind the user the change is reversible per-row.
    const provenanceParts: string[] = []
    if (ruleMatched > 0) {
      provenanceParts.push(`${ruleMatched} from your classification rules`)
    }
    if (nameGuessed > 0) {
      provenanceParts.push(
        `${nameGuessed} guessed from the signal name (no rule matched)`
      )
    }
    toast({
      title: 'Classified',
      description: `${res.updated} signal${res.updated === 1 ? '' : 's'} updated. ${provenanceParts.join(', ')}. Review or change any row below.`,
    })
    loadAll()
  }

  const handleAssignGlCode = async (
    signalId: string,
    glCodeId: string | null
  ) => {
    const previous = signals.find((s) => s.id === signalId)
    const newGl =
      glCodeId === null ? null : glCodes.find((g) => g.id === glCodeId)
    setSignals((rows) =>
      rows.map((s) =>
        s.id === signalId
          ? {
              ...s,
              glCodeId,
              glCodeDisplay: newGl ? `${newGl.glCode}: ${newGl.glName}` : null,
            }
          : s
      )
    )
    const res = await assignSignalToGlCode(signalId, glCodeId)
    if (!res.success) {
      setSignals((rows) =>
        rows.map((s) =>
          s.id === signalId && previous
            ? {
                ...s,
                glCodeId: previous.glCodeId,
                glCodeDisplay: previous.glCodeDisplay,
              }
            : s
        )
      )
      toast({
        title: 'Could not assign GL code',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
  }

  if (loading || !data) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-6 w-64' />
          <Skeleton className='mt-2 h-4 w-96' />
        </CardHeader>
        <CardContent>
          <div className='grid gap-4 md:grid-cols-4'>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className='h-24 w-full' />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center'>
          <div>
            <CardTitle>AI cost classification</CardTitle>
            <CardDescription>
              How your AI spend splits into COGS vs R&amp;D for accounting (
              {periodLabel ?? 'last 30 days'}). Production inference is COGS;
              dev/test is R&amp;D (ASC 730).
            </CardDescription>
          </div>
          {unclassifiedSignals.length > 0 && (
            <Button
              size='sm'
              variant='outline'
              onClick={handleApplySuggestions}
              disabled={isPending}
              className='gap-2'
            >
              Suggest classifications for {unclassifiedSignals.length} signal
              {unclassifiedSignals.length === 1 ? '' : 's'}
              <ArrowRight className='h-4 w-4' />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className='space-y-6'>
        {/* Category cards */}
        <div className='grid gap-4 md:grid-cols-4'>
          {data.categories.map((cat) => (
            <div
              key={cat.key}
              className='rounded-lg border p-4'
              style={{
                borderLeftWidth: 4,
                borderLeftColor: CATEGORY_COLOR[cat.key],
              }}
            >
              <div className='text-xs font-medium text-muted-foreground'>
                {CATEGORY_LABEL[cat.key]}
              </div>
              <div className='mt-1 text-2xl font-semibold'>
                {formatCurrency(cat.cost)}
              </div>
              <div className='mt-1 text-xs text-muted-foreground'>
                {cat.eventCount.toLocaleString()} event
                {cat.eventCount === 1 ? '' : 's'}
                {cat.shareOfClassified !== null && (
                  <>
                    {' · '}
                    {(cat.shareOfClassified * 100).toFixed(1)}% of classified
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* The CFO charts panel draws the category split as a donut, so this
            panel shows no split bar. The per-category CARDS above carry the
            event counts + share-of-classified the donut doesn't show. */}

        {/* Environment breakdown */}
        {data.environments.length > 0 && (
          <div>
            <div className='mb-2 text-xs font-medium text-muted-foreground'>
              By environment (events tagged via SDK)
            </div>
            <div className='flex flex-wrap gap-2'>
              {data.environments.map((env) => (
                <Badge key={env.key} variant='secondary' className='gap-1.5'>
                  <span className='font-medium'>{env.label}</span>
                  <span className='text-muted-foreground'>
                    {formatCurrency(env.cost)}
                  </span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Signals table */}
        <div>
          <div className='mb-2 flex items-center justify-between'>
            <div className='text-sm font-medium'>Signals</div>
            <div className='text-xs text-muted-foreground'>
              Set the bucket each signal flows into. Unclassified signals
              auto-classify when an SDK event arrives with an{' '}
              <code className='rounded bg-muted px-1'>environment</code> tag.
              Classifying applies to every event for this signal, past and
              future. No backfill needed.
            </div>
          </div>
          {signals.length === 0 ? (
            <div className='rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground'>
              No signals yet. Send an event with the MarginFront SDK to get
              started.
            </div>
          ) : (
            <div className='rounded-md border'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signal</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className='w-[240px]'>Classification</TableHead>
                    <TableHead className='w-[260px]'>GL code</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((s) => {
                    // Filter GL codes the signal can be mapped to: only those
                    // whose costCategory matches the signal's (so a R&D signal
                    // doesn't get mapped to a COGS code). UNCLASSIFIED signals
                    // can map to anything.
                    const compatibleGlCodes =
                      s.costCategory === 'UNCLASSIFIED'
                        ? glCodes
                        : glCodes.filter(
                            (g) => g.costCategory === s.costCategory
                          )
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className='font-medium'>{s.name}</div>
                          {s.shortName && (
                            <div className='text-xs text-muted-foreground'>
                              {s.shortName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className='text-muted-foreground'>
                          {s.agentName}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={s.costCategory}
                            onValueChange={(v) =>
                              handleClassify(s.id, v as CostCategoryKey)
                            }
                          >
                            <SelectTrigger
                              className={
                                s.isUnclassified
                                  ? 'border-yellow-400/60'
                                  : undefined
                              }
                            >
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
                              <SelectItem value='UNCLASSIFIED'>
                                {CATEGORY_LABEL.UNCLASSIFIED}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={s.glCodeId ?? '__unmapped'}
                            onValueChange={(v) =>
                              handleAssignGlCode(
                                s.id,
                                v === '__unmapped' ? null : v
                              )
                            }
                          >
                            <SelectTrigger
                              className={
                                !s.glCodeId && !s.isUnclassified
                                  ? 'border-yellow-400/60'
                                  : undefined
                              }
                            >
                              <SelectValue placeholder='Unmapped' />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value='__unmapped'>
                                Unmapped
                              </SelectItem>
                              {compatibleGlCodes.map((g) => (
                                <SelectItem key={g.id} value={g.id}>
                                  {g.glCode}: {g.glName}
                                </SelectItem>
                              ))}
                              {compatibleGlCodes.length === 0 && (
                                <div className='px-2 py-1.5 text-xs text-muted-foreground'>
                                  No GL codes for this category.
                                </div>
                              )}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Journal export */}
        <div>
          <div className='mb-2 flex items-center justify-between'>
            <div>
              <div className='text-sm font-medium'>Journal export</div>
              <div className='text-xs text-muted-foreground'>
                AI cost rolled up by GL code for{' '}
                {journal?.periodLabel ?? 'the last 30 days'}. Download a generic
                CSV your accountant can import.
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <Select
                value={journalFormat}
                onValueChange={(v) =>
                  setJournalFormat(v as 'summary' | 'journal')
                }
              >
                <SelectTrigger className='h-9 w-[200px]'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='summary'>Cost summary (CSV)</SelectItem>
                  <SelectItem value='journal'>Journal entries (CSV)</SelectItem>
                </SelectContent>
              </Select>
              <a
                href={`/api/export/journal?format=${journalFormat}${
                  filter?.startDate && filter?.endDate
                    ? `&start=${filter.startDate}&end=${filter.endDate}`
                    : ''
                }`}
                download
                className='inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90'
              >
                <Download className='h-3.5 w-3.5' />
                Download
              </a>
            </div>
          </div>

          {journal && journal.hasUnmapped && (
            <div className='mb-2 rounded-md border border-yellow-400/50 bg-yellow-50/50 px-3 py-2 text-xs dark:bg-yellow-950/20'>
              <span className='font-medium'>
                {formatCurrency(journal.unmappedAmount)} is unmapped.
              </span>{' '}
              These costs export under an{' '}
              <code className='rounded bg-muted px-1'>UNMAPPED</code> line.
              Assign GL codes in the Signals table above so they book to the
              right account.
            </div>
          )}
          {/* The journal-by-GL TABLE lives ONLY on Month-End Close (the
              period-frozen "close the books" view, with audit drill-through).
              The live journal CSV export stays here. The explainer below
              documents the two export formats the button offers. */}
          {/* The contra account is "Accrued AI Costs" (an accrued-
              liability account), NOT Accounts Payable — there's no provider
              invoice yet, so AP would assert a vendor bill that doesn't exist and
              fail an auditor's first reconciliation. Keep this copy in sync with
              OFFSET_ACCOUNT in journal-utils.ts. */}
          <div className='mt-2 text-xs text-muted-foreground'>
            <span className='font-medium'>Cost summary</span> = one row per GL
            code. <span className='font-medium'>Journal entries</span> =
            balanced double-entry (debits to the cost accounts, credit to
            Accrued AI Costs, an accrual that reverses when the provider invoice
            posts) you can post to your ledger. QuickBooks, NetSuite, and Xero
            native formats are coming. Tell us which ledger you use.
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
