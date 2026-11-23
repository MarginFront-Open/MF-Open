'use client'

/**
 * WHAT THIS FILE DOES: The "Chart of accounts" editor — the table where a
 *   finance user maintains the GL codes (5100 AI Inference, 6800 AI R&D, etc.)
 *   that signals get mapped to for the journal export. Add a code, delete a
 *   code, or restore the seeded defaults.
 *
 * Deleting a GL code un-maps every signal mapped to it (SetNull cascade), so:
 *   1. DELETE SAFETY: delete goes through a confirmation dialog that shows how
 *      many signals will be un-mapped, and a success toast reports the count
 *      after. The delete action's revalidatePath re-syncs the Cost Management
 *      signals table the next time it loads.
 *   2. CATEGORY ↔ TYPE CAN'T MISMATCH: pairing "Production COGS" with an "R&D"
 *      type would silently move real cost below the gross-margin line on the
 *      exported P&L, so the type is DERIVED one-way from the category
 *      (CATEGORY_TO_ACCOUNTING_TYPE) and shown read-only; the server rejects
 *      bad pairs too. A banner surfaces any existing mismatched signals.
 * CONNECTS TO:
 *   - ../index.tsx (the FinOps Settings page that stacks this + the rules editor)
 *   - app/actions/chart-of-accounts.ts (get / upsert / delete / restore +
 *     getGlCodeSignalCount + getMismatchedSignalCount)
 *   - features/cost-management/classification-utils.ts (CATEGORY_TO_ACCOUNTING_TYPE)
 *   - features/cost-management/.../cost-classification-panel.tsx READS the
 *     GL codes (for the signals table's "GL code" dropdown) but does not edit
 *     them.
 */

import { useEffect, useState, useTransition } from 'react'
import { Plus, Trash2, RotateCcw, AlertCircle } from 'lucide-react'
import {
  getChartOfAccounts,
  upsertGlCode,
  deleteGlCode,
  restoreDefaultGlCodes,
  getGlCodeSignalCount,
  getMismatchedSignalCount,
} from '@/app/actions/chart-of-accounts'
import {
  CATEGORY_TO_ACCOUNTING_TYPE,
  type CostCategoryKey,
  type GlCode,
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

// Local label/color maps — see the note in classification-rules-editor.tsx for
// why these are intentionally duplicated rather than extracted (Rule of Three).
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

export default function ChartOfAccountsEditor() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [glCodes, setGlCodes] = useState<GlCode[]>([])
  const [newGlCode, setNewGlCode] = useState('')
  const [newGlName, setNewGlName] = useState('')
  const [newGlCategory, setNewGlCategory] =
    useState<Exclude<CostCategoryKey, 'UNCLASSIFIED'>>('PRODUCTION_COGS')
  // The accounting type is derived
  // one-way from the category so the two can never be set to contradict each
  // other. Category → Type is a total function; the reverse is not (OPEX_GA maps
  // from both General & Admin and Internal tooling), so we never go the other way.
  const newGlAccountingType = CATEGORY_TO_ACCOUNTING_TYPE[newGlCategory]
  // Count of existing signals whose cost bucket disagrees with their
  // GL code's accounting type. Drives the reconciliation banner.
  const [mismatchCount, setMismatchCount] = useState(0)
  const [isPending, startTransition] = useTransition()

  const loadAll = () => {
    startTransition(async () => {
      setLoading(true)
      try {
        const [glRows, mismatch] = await Promise.all([
          getChartOfAccounts(),
          getMismatchedSignalCount(),
        ])
        setGlCodes(glRows)
        setMismatchCount(mismatch.success ? mismatch.count : 0)
      } catch (err) {
        toast({
          title: 'Failed to load chart of accounts',
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

  // Re-read the mismatch count after any action that could change which signals
  // are mapped (delete un-maps; restore can re-type GL codes). Cheap, org-scoped.
  const refreshMismatchCount = async () => {
    const res = await getMismatchedSignalCount()
    if (res.success) setMismatchCount(res.count)
  }

  const handleAddGlCode = async () => {
    const codeTrim = newGlCode.trim()
    const nameTrim = newGlName.trim()
    if (!codeTrim || !nameTrim) {
      toast({
        title: 'GL code and name are required',
        variant: 'destructive',
      })
      return
    }
    const res = await upsertGlCode({
      glCode: codeTrim,
      glName: nameTrim,
      costCategory: newGlCategory,
      // Derived from the category — guaranteed compatible with the server's
      // cross-check, so a valid add never trips the validation error.
      accountingType: newGlAccountingType,
    })
    if (!res.success || !res.glCode) {
      toast({
        title: 'Could not add GL code',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    setGlCodes((codes) =>
      [...codes, res.glCode!].sort((a, b) => a.glCode.localeCompare(b.glCode))
    )
    setNewGlCode('')
    setNewGlName('')
    setNewGlCategory('PRODUCTION_COGS')
  }

  const handleDeleteGlCode = async (id: string) => {
    const previous = glCodes
    setGlCodes((codes) => codes.filter((g) => g.id !== id))
    const res = await deleteGlCode(id)
    if (!res.success) {
      setGlCodes(previous)
      toast({
        title: 'Could not delete GL code',
        description: res.error ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    // Tell the operator exactly how many signals the delete un-mapped, so a
    // single click never silently strips GL mappings.
    const unmapped = res.orphanedSignalCount ?? 0
    toast({
      title: 'GL code deleted',
      description:
        unmapped === 0
          ? 'No signals were mapped to it.'
          : `${unmapped} signal${unmapped === 1 ? '' : 's'} unmapped. Their costs fall into the Unmapped journal bucket until re-mapped.`,
    })
    void refreshMismatchCount()
    // No local signals refresh: this page has no signals table, and the
    // delete action's revalidatePath re-syncs Cost Management on its next load.
  }

  const handleRestoreGlDefaults = async () => {
    const res = await restoreDefaultGlCodes()
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
      description: `${res.count} default GL code${res.count === 1 ? '' : 's'} re-seeded. User-added codes kept.`,
    })
    const fresh = await getChartOfAccounts()
    setGlCodes(fresh)
    // Re-typing GL codes back to defaults can change which signals are
    // mismatched, so refresh the banner.
    void refreshMismatchCount()
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
            <CardTitle>Chart of accounts</CardTitle>
            <CardDescription>
              GL codes you map signals to. Drives the journal-entry export
              (QuickBooks IIF / NetSuite CSV / Xero CSV) on Cost Management.
            </CardDescription>
          </div>
          <Button
            size='sm'
            variant='ghost'
            onClick={handleRestoreGlDefaults}
            disabled={isPending}
            className='gap-1.5'
          >
            <RotateCcw className='h-3.5 w-3.5' />
            Restore defaults
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Reconciliation banner for signals whose cost bucket and GL
            accounting type disagree. Charts read the bucket; the exported P&L
            reads the accounting type — so a mismatch quietly distorts margin. */}
        {mismatchCount > 0 && (
          <div className='mb-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive'>
            <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
            <div>
              <span className='font-medium'>
                {mismatchCount} signal{mismatchCount === 1 ? '' : 's'}{' '}
                {mismatchCount === 1 ? 'has' : 'have'} a cost bucket that
                disagrees with the mapped GL code&rsquo;s accounting type.
              </span>{' '}
              The dashboard charts read the cost bucket, but the exported
              P&amp;L reads the accounting type, so reported margin may be off
              until these are reconciled. Review and re-map them on Cost
              Management.
            </div>
          </div>
        )}
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[100px]'>GL code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className='w-[160px]'>Category</TableHead>
                <TableHead className='w-[120px]'>Type</TableHead>
                <TableHead className='w-[60px]' />
              </TableRow>
            </TableHeader>
            <TableBody>
              {glCodes.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className='py-6 text-center text-sm text-muted-foreground'
                  >
                    No GL codes yet. Defaults will be seeded on next refresh, or
                    add one below.
                  </TableCell>
                </TableRow>
              ) : (
                glCodes.map((gl) => (
                  <TableRow key={gl.id}>
                    <TableCell className='font-mono text-sm'>
                      {gl.glCode}
                    </TableCell>
                    <TableCell>
                      <div className='text-sm'>{gl.glName}</div>
                      {gl.isDefault && (
                        <Badge variant='secondary' className='mt-1 text-xs'>
                          default
                        </Badge>
                      )}
                      {gl.description && (
                        <div className='mt-1 text-xs text-muted-foreground'>
                          {gl.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='secondary'
                        style={{
                          borderLeft: `3px solid ${CATEGORY_COLOR[gl.costCategory]}`,
                        }}
                      >
                        {CATEGORY_LABEL[gl.costCategory]}
                      </Badge>
                    </TableCell>
                    <TableCell className='font-mono text-xs text-muted-foreground'>
                      {gl.accountingType}
                    </TableCell>
                    <TableCell>
                      <DeleteGlCodeConfirm
                        glCode={gl.glCode}
                        glCodeId={gl.id}
                        disabled={isPending}
                        onConfirm={handleDeleteGlCode}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Add-new-GL-code row */}
        <div className='mt-3 flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center'>
          <Input
            value={newGlCode}
            onChange={(e) => setNewGlCode(e.target.value)}
            placeholder='Code (e.g. 5130)'
            className='h-9 sm:w-[120px]'
          />
          <Input
            value={newGlName}
            onChange={(e) => setNewGlName(e.target.value)}
            placeholder='Name (e.g. AI Fine-Tuning)'
            className='h-9 flex-1'
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddGlCode()
            }}
          />
          <Select
            value={newGlCategory}
            onValueChange={(v) =>
              setNewGlCategory(v as Exclude<CostCategoryKey, 'UNCLASSIFIED'>)
            }
          >
            <SelectTrigger className='h-9 w-full sm:w-[160px]'>
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
          {/* Accounting type is derived from the category, not chosen
              independently. Read-only so the pair can't be set to contradict the
              exported P&L. */}
          <div
            className='flex h-9 w-full items-center justify-center rounded-md border border-input bg-muted px-3 font-mono text-xs text-muted-foreground sm:w-[120px]'
            title='Set automatically from the category. Drives the exported P&L line.'
            aria-label={`Accounting type ${newGlAccountingType} (derived from category)`}
          >
            {newGlAccountingType}
          </div>
          <Button
            size='sm'
            onClick={handleAddGlCode}
            disabled={isPending || !newGlCode.trim() || !newGlName.trim()}
            className='gap-1.5'
          >
            <Plus className='h-3.5 w-3.5' />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Confirmation gate for deleting a GL code. Reuses the in-repo
 * AlertDialog idiom (see organization/members/.../remove-member-button.tsx).
 *
 * It lives as a per-row component (not inline in the table .map) because each
 * row needs its own dialog open-state and its own "how many signals will this
 * un-map?" count — and React hooks can't run inside a loop body. The count is
 * fetched lazily when the dialog opens so we don't N+1 the table on every load.
 */
function DeleteGlCodeConfirm({
  glCode,
  glCodeId,
  disabled,
  onConfirm,
}: {
  glCode: string
  glCodeId: string
  disabled: boolean
  onConfirm: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // null = not counted yet (still loading); a number once we know.
  const [count, setCount] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)

  const openDialog = () => {
    setOpen(true)
    setCount(null)
    setCounting(true)
    getGlCodeSignalCount(glCodeId)
      .then((res) => setCount(res.success ? res.count : 0))
      .catch(() => setCount(0))
      .finally(() => setCounting(false))
  }

  return (
    <>
      <Button
        size='sm'
        variant='ghost'
        onClick={openDialog}
        disabled={disabled}
        aria-label='Delete GL code'
      >
        <Trash2 className='h-3.5 w-3.5 text-muted-foreground' />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete GL code {glCode}?</AlertDialogTitle>
            <AlertDialogDescription>
              {counting
                ? 'Checking how many signals are mapped to this code…'
                : count && count > 0
                  ? `This un-maps ${count} signal${count === 1 ? '' : 's'}. Their costs fall into the Unmapped journal bucket until you re-map them. This can't be undone.`
                  : "No signals are currently mapped to this code. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onConfirm(glCodeId)}
              className='bg-red-500 hover:bg-red-600'
            >
              Delete GL code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
