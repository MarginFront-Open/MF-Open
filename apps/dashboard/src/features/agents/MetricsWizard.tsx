'use client'

/**
 * MetricsWizard — the metrics tab for agent setup.
 *
 * One editor surface:
 * name + services + count type visible at once, existing metrics editable
 * in place, cost-per-run shown on each saved metric's row.
 */

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconX,
  IconChartBar,
  IconLoader2,
} from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { ServiceCombobox } from '@/components/ui/service-combobox'
import { useServicePricing } from '@/hooks/use-service-pricing'
import { useAgentSignals, useDeleteSignal } from '@/services/signal-service'
import { useToast } from '@/hooks/use-toast'
import {
  createSignalWithServices,
  updateSignalWithServices,
  getSignalServices,
  type SignalServiceLink,
} from '@/app/actions/signal-services'
import type { ServicePricingEntry } from '@/app/actions/service-pricing'
import {
  previewMetricCosts,
  type PreviewMetric,
} from '@/app/actions/preview-cost'
import { formatCost as canonFormatCost } from '@/lib/canon-format'

interface SelectedService {
  id: string
  displayName: string
  serviceType: string
  inputCost: number | null
  outputCost: number | null
  costUnit: string
  isApi: boolean
  isCustom?: boolean
}

interface Metric {
  id: string
  name: string
  type: 'ACTIVITY' | 'OUTCOME'
  services: SelectedService[]
}

type EditorState = { mode: 'new' } | { mode: 'edit'; signalId: string } | null

const formatCost = (cost: number | null) =>
  cost === null ? '—' : canonFormatCost(cost)

// Preview cost is computed server-side via the previewMetricCosts server
// action — see apps/dashboard/app/actions/preview-cost.ts. That action
// wraps calculateEventCost from @marginfront/db, which uses Prisma.Decimal
// internally (Node-only). Keeping the math on the server avoids dragging
// Prisma runtime into the client bundle. Canonical simulator defaults
// (1000 in / 500 out tokens for LLM, qty=1 otherwise) live in that file
// so every "show users what one event costs" surface stays consistent.

export default function MetricsWizard() {
  const params = useParams()
  const router = useRouter()
  const agentId = params.agentId as string
  const { toast } = useToast()

  const {
    data: signalData,
    isLoading: signalsLoading,
    refetch: refetchSignals,
  } = useAgentSignals(agentId)
  const deleteSignalMutation = useDeleteSignal()

  const [completedMetrics, setCompletedMetrics] = useState<Metric[]>([])
  const [servicesLoaded, setServicesLoaded] = useState(false)

  // Server-computed preview cost per metric, keyed by metric id ('editor'
  // for the in-progress metric). Filled by the useEffect below.
  const [previewCosts, setPreviewCosts] = useState<Record<string, number>>({})

  // When signals load from DB, fetch their service links too
  useEffect(() => {
    if (!signalData?.results || servicesLoaded) return

    async function loadServiceLinks() {
      const metrics: Metric[] = []
      for (const signal of signalData!.results) {
        const serviceResult = await getSignalServices(signal.id)
        const services: SelectedService[] = (serviceResult.data || []).map(
          (link: SignalServiceLink) => ({
            id: link.service.externalId,
            displayName: link.service.displayName,
            serviceType: link.service.serviceType,
            inputCost: link.service.inputCost,
            outputCost: link.service.outputCost,
            costUnit: link.service.costUnit,
            isApi: link.service.isApi,
          })
        )
        metrics.push({
          id: signal.id,
          name: signal.name,
          // signal.type is already normalized to the UI classification enum
          // ('ACTIVITY' | 'OUTCOME') by convertApiSignalToUiSignal. Default to
          // 'ACTIVITY' when the type is absent so a signal row with no type
          // does not silently fall into the outcome bucket.
          type: signal.type ?? 'ACTIVITY',
          services,
        })
      }
      setCompletedMetrics(metrics)
      setServicesLoaded(true)
    }

    loadServiceLinks()
  }, [signalData, servicesLoaded])

  const [editor, setEditor] = useState<EditorState>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [metricName, setMetricName] = useState('')
  const [metricType, setMetricType] = useState<'ACTIVITY' | 'OUTCOME'>(
    'ACTIVITY'
  )
  const [metricServices, setMetricServices] = useState<SelectedService[]>([])

  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customCost, setCustomCost] = useState('')
  const [customUnit, setCustomUnit] = useState('requests')

  // Fetch server-computed preview costs whenever the metric list or the
  // in-progress editor changes. Rebuilds the request from state so the
  // deps are stable (derived arrays have fresh references every render).
  useEffect(() => {
    const metricsForPreview: PreviewMetric[] = [
      ...completedMetrics.map((m) => ({
        id: m.id,
        services: m.services.map((s) => ({
          inputCost: s.inputCost,
          outputCost: s.outputCost,
          costUnit: s.costUnit,
        })),
      })),
      ...(editor && metricServices.length > 0
        ? [
            {
              id: 'editor',
              services: metricServices.map((s) => ({
                inputCost: s.inputCost,
                outputCost: s.outputCost,
                costUnit: s.costUnit,
              })),
            },
          ]
        : []),
    ]

    if (metricsForPreview.length === 0) {
      setPreviewCosts({})
      return
    }

    let cancelled = false
    previewMetricCosts(metricsForPreview)
      .then((result) => {
        if (!cancelled) setPreviewCosts(result)
      })
      .catch((err) => {
        console.error('[MetricsWizard] preview cost fetch failed', err)
      })

    return () => {
      cancelled = true
    }
  }, [completedMetrics, editor, metricServices])

  // Live pricing from the service_pricing DB table
  const { entries: allEntries, isLoading: pricingLoading } = useServicePricing()

  const openEditor = (metric?: Metric) => {
    if (metric) {
      setEditor({ mode: 'edit', signalId: metric.id })
      setMetricName(metric.name)
      setMetricType(metric.type)
      setMetricServices(metric.services)
    } else {
      setEditor({ mode: 'new' })
      setMetricName('')
      setMetricType('ACTIVITY')
      setMetricServices([])
    }
    setShowCustomForm(false)
    setCustomName('')
    setCustomCost('')
  }

  const closeEditor = () => {
    setEditor(null)
    setShowCustomForm(false)
  }

  const saveMetric = async () => {
    if (!editor || !metricName.trim() || metricServices.length === 0) return
    setIsSaving(true)

    const name = metricName.trim()
    // Custom services have no service_pricing row to link to
    const serviceExternalIds = metricServices
      .filter((s) => !s.isCustom)
      .map((s) => s.id)
    const type =
      metricType === 'ACTIVITY' ? ('volume' as const) : ('usage' as const)

    try {
      if (editor.mode === 'edit') {
        const result = await updateSignalWithServices({
          signalId: editor.signalId,
          name,
          type,
          serviceExternalIds,
        })
        if (!result.success) {
          throw new Error(result.error || 'Failed to update metric')
        }
        setCompletedMetrics(
          completedMetrics.map((m) =>
            m.id === editor.signalId
              ? { ...m, name, type: metricType, services: metricServices }
              : m
          )
        )
        toast({
          title: 'Metric updated',
          description: `"${name}" has been saved.`,
        })
      } else {
        const result = await createSignalWithServices({
          name,
          agentId,
          type,
          serviceExternalIds,
        })
        if (!result.success) {
          throw new Error(result.error || 'Failed to create metric')
        }
        setCompletedMetrics([
          ...completedMetrics,
          {
            id: result.signalId!,
            name,
            type: metricType,
            services: metricServices,
          },
        ])
        toast({
          title: 'Metric created',
          description: `"${name}" has been saved with ${metricServices.length} service(s).`,
        })
      }

      setEditor(null)
      refetchSignals()
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to save metric',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const removeMetric = async (id: string) => {
    try {
      await deleteSignalMutation.mutateAsync(id)
      setCompletedMetrics(completedMetrics.filter((m) => m.id !== id))
    } catch (_error: any) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete metric',
      })
    }
  }

  const handleServiceSelect = (entry: ServicePricingEntry | null) => {
    if (!entry) return
    if (metricServices.some((s) => s.id === entry.id)) return
    setMetricServices([
      ...metricServices,
      {
        id: entry.id,
        displayName: entry.displayName,
        serviceType: entry.serviceType,
        inputCost: entry.inputCost,
        outputCost: entry.outputCost,
        costUnit: entry.costUnit,
        isApi: entry.isApi,
      },
    ])
  }

  const removeMetricService = (serviceId: string) => {
    setMetricServices(metricServices.filter((s) => s.id !== serviceId))
  }

  const addCustomService = () => {
    if (!customName.trim()) return
    setMetricServices([
      ...metricServices,
      {
        id: `custom-${Date.now()}`,
        displayName: customName,
        serviceType: 'Custom',
        inputCost: Number(customCost) || null,
        outputCost: null,
        costUnit: customUnit,
        isApi: true,
        isCustom: true,
      },
    ])
    setCustomName('')
    setCustomCost('')
    setShowCustomForm(false)
  }

  if (signalsLoading) {
    return (
      <div className='flex items-center justify-center py-12'>
        <IconLoader2 size={24} className='animate-spin text-muted-foreground' />
        <span className='ml-2 text-muted-foreground'>Loading metrics...</span>
      </div>
    )
  }

  const anyMetricHasServices = completedMetrics.some(
    (m) => m.services.length > 0
  )

  return (
    <div className='mx-auto max-w-3xl space-y-6'>
      <div>
        <h2 className='text-xl font-semibold'>
          Set up your agent&apos;s metrics
        </h2>
        <p className='mt-2 text-muted-foreground'>
          A metric is a task your agent performs, like generating a report or
          screening a candidate. Attach the services each task uses and we track
          what it costs you per run. What you charge customers comes later, on
          the Pricing page.
        </p>
      </div>

      {/* Saved metrics — editable in place */}
      {completedMetrics.length > 0 && (
        <div className='space-y-3'>
          {completedMetrics.map((metric) => (
            <Card key={metric.id}>
              <CardContent className='flex items-start justify-between gap-4 p-4'>
                <div className='min-w-0 space-y-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <p className='font-medium'>{metric.name}</p>
                    <Badge
                      variant='outline'
                      className='px-1.5 py-0 text-[10px]'
                    >
                      {metric.type === 'ACTIVITY'
                        ? 'counts every attempt'
                        : 'counts only results'}
                    </Badge>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    {metric.services.length > 0
                      ? metric.services
                          .map((s) => `${s.displayName} (${s.serviceType})`)
                          .join(' + ')
                      : 'No services attached yet. Edit this metric to add one and see its cost per run.'}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <div className='mr-3 text-right'>
                    <p className='text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
                      Cost per run
                    </p>
                    <p className='text-sm font-medium'>
                      {metric.services.length > 0 ? (
                        formatCost(previewCosts[metric.id] ?? 0)
                      ) : (
                        <span className='text-muted-foreground'>—</span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => openEditor(metric)}
                    disabled={editor !== null}
                    className='h-8 w-8 p-0 text-muted-foreground'
                    aria-label={`Edit ${metric.name}`}
                  >
                    <IconPencil size={14} />
                  </Button>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => removeMetric(metric.id)}
                    disabled={editor !== null}
                    className='h-8 w-8 p-0 text-muted-foreground hover:text-destructive'
                    aria-label={`Delete ${metric.name}`}
                  >
                    <IconTrash size={14} />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {anyMetricHasServices && (
            <p className='text-xs text-muted-foreground'>
              Cost per run assumes one typical event per metric (LLM services:
              1,000 input + 500 output tokens; other services: 1 unit). Real
              costs scale with your actual usage.
            </p>
          )}
        </div>
      )}

      {/* Editor — everything on one surface */}
      {editor ? (
        <Card className='border-primary/30 bg-primary/5'>
          <CardContent className='space-y-6 p-6'>
            <div>
              <h3 className='text-lg font-medium'>
                {editor.mode === 'edit' ? 'Edit metric' : 'Add a metric'}
              </h3>
              <p className='text-sm text-muted-foreground'>
                Name the task, pick the services it uses, and choose how to
                count it. Everything saves in one go.
              </p>
            </div>

            <div className='space-y-2'>
              <Label htmlFor='metric-name'>
                What task does your agent perform?
              </Label>
              <Input
                id='metric-name'
                value={metricName}
                onChange={(e) => setMetricName(e.target.value)}
                placeholder='e.g. Contract summary'
                className='bg-background'
                autoFocus
              />
              <p className='text-xs text-muted-foreground'>
                Write it the way it should appear on your customer&apos;s
                invoice. Be specific: &quot;Contract summary&quot; not
                &quot;report generation.&quot;
              </p>
              {editor.mode === 'edit' && (
                <p className='text-xs text-amber-700 dark:text-amber-400'>
                  Heads up: usage events match on this name. If your
                  agent&apos;s code keeps sending the old name, those events
                  will show up as a separate new metric.
                </p>
              )}
            </div>

            <div className='space-y-2'>
              <Label>What services power it?</Label>
              {metricServices.length > 0 && (
                <div className='space-y-2'>
                  {metricServices.map((service) => (
                    <div
                      key={service.id}
                      className='flex items-center justify-between rounded-md border bg-background px-3 py-2'
                    >
                      <div className='flex items-center gap-2'>
                        <Badge
                          variant='outline'
                          className='shrink-0 text-[10px]'
                        >
                          {service.serviceType}
                        </Badge>
                        <div>
                          <span className='font-medium'>
                            {service.displayName}
                          </span>
                          {service.isCustom ? (
                            <span className='ml-2 text-xs text-muted-foreground'>
                              {service.inputCost !== null
                                ? `${formatCost(service.inputCost)} per ${service.costUnit}`
                                : 'cost tracked via SDK'}
                            </span>
                          ) : (
                            <span className='ml-2 text-xs text-muted-foreground'>
                              {formatCost(service.inputCost)} in /{' '}
                              {formatCost(service.outputCost)} out per{' '}
                              {service.costUnit}
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => removeMetricService(service.id)}
                        className='h-6 w-6 p-0 text-muted-foreground hover:text-destructive'
                        aria-label={`Remove ${service.displayName}`}
                      >
                        <IconX size={14} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <ServiceCombobox
                entries={allEntries}
                value=''
                onSelect={handleServiceSelect}
                onAddCustom={(query) => {
                  setCustomName(query)
                  setShowCustomForm(true)
                }}
                placeholder={
                  metricServices.length > 0
                    ? 'Add another service...'
                    : 'Search LLMs, APIs, and other services...'
                }
                isLoading={pricingLoading}
              />
              <button
                onClick={() => {
                  setShowCustomForm(true)
                  setCustomName('')
                }}
                className='text-xs text-primary hover:underline'
              >
                Don&apos;t see yours? Add it manually
              </button>

              {showCustomForm && (
                <div className='rounded-lg border bg-muted/20 p-4'>
                  <Label className='mb-2 block text-sm font-medium'>
                    Add a custom service
                  </Label>
                  <div className='space-y-2'>
                    <div>
                      <Label className='text-xs text-muted-foreground'>
                        Name
                      </Label>
                      <Input
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder='e.g. Google Maps API, Twilio SMS'
                        className='bg-background'
                      />
                    </div>
                    <div className='grid grid-cols-2 gap-2'>
                      <div>
                        <Label className='text-xs text-muted-foreground'>
                          Cost per unit (optional)
                        </Label>
                        <div className='flex items-center gap-1'>
                          <span className='text-xs text-muted-foreground'>
                            $
                          </span>
                          <Input
                            type='number'
                            value={customCost}
                            onChange={(e) => setCustomCost(e.target.value)}
                            placeholder='0.005'
                            className='h-8 bg-background text-sm'
                            min={0}
                            step='any'
                          />
                        </div>
                      </div>
                      <div>
                        <Label className='text-xs text-muted-foreground'>
                          Unit
                        </Label>
                        <select
                          value={customUnit}
                          onChange={(e) => setCustomUnit(e.target.value)}
                          className='h-8 w-full rounded-md border bg-background px-2 text-sm'
                        >
                          <option value='requests'>requests</option>
                          <option value='1M tokens'>1M tokens</option>
                          <option value='seconds'>seconds</option>
                          <option value='images'>images</option>
                          <option value='characters'>characters</option>
                          <option value='GB'>GB</option>
                        </select>
                      </div>
                    </div>
                    <div className='flex gap-2'>
                      <Button
                        size='sm'
                        onClick={addCustomService}
                        disabled={!customName.trim()}
                      >
                        Add
                      </Button>
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setShowCustomForm(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className='space-y-2'>
              <Label>How should we count it?</Label>
              <div className='grid grid-cols-2 gap-3'>
                <Card
                  className={cn(
                    'cursor-pointer transition-all',
                    metricType === 'ACTIVITY'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'hover:border-primary/50'
                  )}
                  onClick={() => setMetricType('ACTIVITY')}
                >
                  <CardContent className='p-4'>
                    <p className='text-sm font-medium'>Count every attempt</p>
                    <p className='mt-1 text-xs text-muted-foreground'>
                      Your dashboard shows total runs. You can bill customers
                      for every attempt.
                    </p>
                  </CardContent>
                </Card>
                <Card
                  className={cn(
                    'cursor-pointer transition-all',
                    metricType === 'OUTCOME'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'hover:border-primary/50'
                  )}
                  onClick={() => setMetricType('OUTCOME')}
                >
                  <CardContent className='p-4'>
                    <p className='text-sm font-medium'>Count only results</p>
                    <p className='mt-1 text-xs text-muted-foreground'>
                      Your dashboard shows successful deliveries. You can bill
                      customers only for results.
                    </p>
                  </CardContent>
                </Card>
              </div>
              <p className='text-xs text-muted-foreground'>
                This choice never changes your costs. You pay for every run
                either way; it only changes what you count and can bill for.
              </p>
            </div>

            {metricServices.length > 0 && (
              <div className='flex items-center justify-between rounded-md border bg-background px-3 py-2'>
                <span className='text-sm text-muted-foreground'>
                  Estimated cost per run
                </span>
                <span className='text-sm font-semibold'>
                  {formatCost(previewCosts['editor'] ?? 0)}
                </span>
              </div>
            )}

            <div className='flex justify-end gap-2'>
              <Button variant='ghost' onClick={closeEditor} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                onClick={saveMetric}
                disabled={
                  isSaving || !metricName.trim() || metricServices.length === 0
                }
                className='flex items-center gap-2'
              >
                {isSaving ? (
                  <IconLoader2 size={16} className='animate-spin' />
                ) : (
                  <IconCheck size={16} />
                )}
                {isSaving
                  ? 'Saving...'
                  : editor.mode === 'edit'
                    ? 'Save changes'
                    : 'Add metric'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : completedMetrics.length === 0 ? (
        <Card className='border-dashed bg-muted/40'>
          <CardContent className='flex flex-col items-center justify-center p-12'>
            <IconChartBar size={32} className='mb-3 text-muted-foreground' />
            <h3 className='mb-2 font-medium'>No metrics yet</h3>
            <p className='mb-6 max-w-md text-center text-sm text-muted-foreground'>
              Add the tasks your agent performs. Each one becomes a metric you
              can track costs for.
            </p>
            <Button
              onClick={() => openEditor()}
              className='flex items-center gap-2'
            >
              <IconPlus size={16} />
              Add your first metric
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Button
          onClick={() => openEditor()}
          variant='outline'
          className='flex items-center gap-2'
        >
          <IconPlus size={16} />
          Add another metric
        </Button>
      )}

      <Separator className='my-12' />

      <div className='flex justify-between'>
        <Button
          variant='outline'
          className='flex items-center gap-2'
          onClick={() => router.push(`/build?agent=${agentId}`)}
        >
          <IconArrowLeft size={16} />
          BACK : AGENT
        </Button>
        <Button
          disabled={completedMetrics.length === 0}
          className='flex items-center gap-2'
          onClick={() => router.push(`/agents/${agentId}/pricing-plans`)}
        >
          NEXT : PRICING
          <IconArrowRight size={16} />
        </Button>
      </div>
    </div>
  )
}
