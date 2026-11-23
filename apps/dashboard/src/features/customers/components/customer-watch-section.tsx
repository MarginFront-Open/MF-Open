'use client'

/**
 * WHAT THIS FILE DOES: the "Alerts" card on the customer detail page
 * — list, create, edit, and delete this customer's watches
 * ("email me when Acme's cost passes $500 this month"). Lives OUTSIDE the
 * @ts-nocheck page so every prop and payload here is fully type-checked; the
 * page itself only mounts <CustomerWatchSection/>.
 * CONNECTS TO: app/actions/customer-alerts.ts (reads + cookie-forwarded
 * writes; api-nest is the authority), customer-watch-logic.ts (validation,
 * payloads, sentences — node-jest tested).
 *
 * Role posture: the PAGE stays open to every role; only these
 * controls are money-gated. A non-money caller gets canManage false from the
 * list action and this section renders nothing — a cosmetic hide over the
 * real server-side gates (action guard + api-nest OrgRoleGuard).
 */

import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  createCustomerWatch,
  deleteCustomerWatch,
  getCustomerWatches,
  updateCustomerWatch,
  type CustomerWatchView,
} from '@/app/actions/customer-alerts'
import {
  EMPTY_WATCH_FORM,
  WATCH_WINDOW_LABELS,
  buildWatchWriteInput,
  customRangeLine,
  validateWatchForm,
  watchSentence,
  watchToForm,
  type WatchFormState,
} from '../customer-watch-logic'

export function CustomerWatchSection({ customerId }: { customerId: string }) {
  const { toast } = useToast()
  const [watches, setWatches] = useState<CustomerWatchView[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<WatchFormState>(EMPTY_WATCH_FORM)
  // Bumped after every successful write so the list refetches (the mount
  // fetch itself is the effect below — the mfiq/index.tsx pattern).
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    getCustomerWatches(customerId)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setWatches(result.watches ?? [])
          setCanManage(result.canManage ?? false)
        }
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [customerId, reloadTick])

  // Cosmetic hide for non-money roles (the PAGE stays open);
  // the server enforces the same set on every read and write regardless.
  if (!loading && !canManage) return null

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_WATCH_FORM)
    setFormOpen(true)
  }

  const openEdit = (watch: CustomerWatchView) => {
    setEditingId(watch.id)
    setForm(watchToForm(watch))
    setFormOpen(true)
  }

  const submit = async () => {
    const validationError = validateWatchForm(form)
    if (validationError) {
      toast({ title: validationError, variant: 'destructive' })
      return
    }
    setBusy(true)
    const input = buildWatchWriteInput(form)
    const result = editingId
      ? await updateCustomerWatch(editingId, input)
      : await createCustomerWatch(customerId, input)
    setBusy(false)
    if (!result.success) {
      toast({
        title: result.error ?? "The watch wasn't saved.",
        variant: 'destructive',
      })
      return
    }
    toast({
      title: editingId
        ? 'Watch updated.'
        : 'Watch created. A confirmation email is on its way.',
    })
    setFormOpen(false)
    setEditingId(null)
    setReloadTick((tick) => tick + 1)
  }

  const remove = async (watchId: string) => {
    setBusy(true)
    const result = await deleteCustomerWatch(watchId)
    setBusy(false)
    if (!result.success) {
      toast({
        title: result.error ?? "The watch wasn't deleted.",
        variant: 'destructive',
      })
      return
    }
    toast({ title: 'Watch deleted.' })
    setReloadTick((tick) => tick + 1)
  }

  return (
    <Card className='mb-6 overflow-hidden'>
      <CardHeader className='flex flex-row items-center justify-between border-b bg-muted/20 pb-4 pt-4'>
        <CardTitle>Alerts</CardTitle>
        <Button
          size='sm'
          variant='outline'
          onClick={openCreate}
          disabled={busy}
        >
          <Plus className='mr-1.5 h-4 w-4' />
          New watch
        </Button>
      </CardHeader>
      <CardContent className='p-5'>
        {loading ? (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            Loading watches…
          </div>
        ) : (
          <>
            {watches.length === 0 && !formOpen && (
              <p className='text-sm text-muted-foreground'>
                No watches yet. A watch emails you the moment this
                customer&apos;s cost or revenue passes a line you set.
              </p>
            )}
            <div className='space-y-2'>
              {watches.map((watch) => (
                <div
                  key={watch.id}
                  className='flex items-center justify-between rounded-md border px-3 py-2'
                >
                  <div>
                    <div className='text-sm font-medium'>
                      {watchSentence(watch)}
                    </div>
                    <div className='text-xs text-muted-foreground'>
                      {customRangeLine(watch)
                        ? `${customRangeLine(watch)} · `
                        : ''}
                      Sends to {watch.recipientEmail}
                    </div>
                  </div>
                  <div className='flex items-center gap-1'>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => openEdit(watch)}
                      disabled={busy}
                      aria-label='Edit watch'
                    >
                      <Pencil className='h-4 w-4' />
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => void remove(watch.id)}
                      disabled={busy}
                      aria-label='Delete watch'
                    >
                      <Trash2 className='h-4 w-4' />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {formOpen && (
              <WatchForm
                form={form}
                setForm={setForm}
                busy={busy}
                editing={editingId !== null}
                onSubmit={() => void submit()}
                onCancel={() => {
                  setFormOpen(false)
                  setEditingId(null)
                }}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function WatchForm({
  form,
  setForm,
  busy,
  editing,
  onSubmit,
  onCancel,
}: {
  form: WatchFormState
  setForm: (next: WatchFormState) => void
  busy: boolean
  editing: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div className='mt-4 space-y-3 rounded-md border bg-muted/10 p-4'>
      <div className='grid grid-cols-1 gap-3 md:grid-cols-3'>
        <div>
          <label className='mb-1 block text-xs text-muted-foreground'>
            Watch
          </label>
          <Select
            value={form.metric}
            onValueChange={(metric) => setForm({ ...form, metric })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='cost'>Cost (what they cost us)</SelectItem>
              <SelectItem value='revenue'>
                Revenue (what they owe us)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className='mb-1 block text-xs text-muted-foreground'>
            Passes ($)
          </label>
          <Input
            type='number'
            min='0'
            step='0.01'
            placeholder='500'
            value={form.threshold}
            onChange={(e) => setForm({ ...form, threshold: e.target.value })}
          />
        </div>
        <div>
          <label className='mb-1 block text-xs text-muted-foreground'>
            Window
          </label>
          <Select
            value={form.windowMode}
            onValueChange={(windowMode) => setForm({ ...form, windowMode })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='month'>{WATCH_WINDOW_LABELS.month}</SelectItem>
              <SelectItem value='rolling'>
                {WATCH_WINDOW_LABELS.rolling}
              </SelectItem>
              <SelectItem value='custom'>
                {WATCH_WINDOW_LABELS.custom}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {form.windowMode === 'custom' && (
        <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
          <div>
            <label className='mb-1 block text-xs text-muted-foreground'>
              From (UTC)
            </label>
            <Input
              type='date'
              value={form.customStartDate}
              onChange={(e) =>
                setForm({ ...form, customStartDate: e.target.value })
              }
            />
          </div>
          <div>
            <label className='mb-1 block text-xs text-muted-foreground'>
              To (UTC)
            </label>
            <Input
              type='date'
              value={form.customEndDate}
              onChange={(e) =>
                setForm({ ...form, customEndDate: e.target.value })
              }
            />
          </div>
        </div>
      )}
      <p className='text-xs text-muted-foreground'>
        Alerts email you (the watch&apos;s creator) and show up on MFiQ. The
        customer never sees them.
      </p>
      <div className='flex gap-2'>
        <Button size='sm' onClick={onSubmit} disabled={busy}>
          {busy && <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />}
          {editing ? 'Save changes' : 'Create watch'}
        </Button>
        <Button size='sm' variant='outline' onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
