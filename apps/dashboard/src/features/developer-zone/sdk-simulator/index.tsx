'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAgents } from '@/services/agent-service'
import { useCustomers } from '@/services/customers-service'
import { useAgentSignals, signalKeys } from '@/services/signal-service'
import { useServicePricing } from '@/hooks/use-service-pricing'
import { useSubscriptions } from '@/services/subscriptions-service'
import { analyticsKeys } from '@/services/analytics-service'
import { FILTERS_KEYS } from '@/services/filters-service'
import type { Subscription } from '@/app/actions/subscriptions'
import type { ServicePricingEntry } from '@/app/actions/service-pricing'
import { recordSdkUsage } from '@/app/actions/record-sdk-usage'
import { getSimulatorDemoPricingStatus } from '@/app/actions/get-simulator-demo-pricing-status'
import { createSimulatorDemoPricing } from '@/app/actions/create-simulator-demo-pricing'
import {
  Send,
  Copy,
  Check,
  Code,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Search,
  FileText,
  DollarSign,
  ExternalLink,
  Pencil,
} from 'lucide-react'
import { TerminalWindow } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { formatCost } from '@/lib/canon-format'
import { maskKeyForPreview } from '@/lib/api-key-mask'
import { useToast } from '@/hooks/use-toast'
import { Page } from '@/components/layouts/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { publicApiBaseUrl } from '@/config/operator'

const SDK_SIMULATOR_BREADCRUMB = [
  { name: 'Home', href: '/' },
  { name: 'SDK Simulator' },
]

export default function SdkSimulatorPage() {
  return (
    <Page
      title='SDK Simulator'
      headerProps={{ breadcrumb: SDK_SIMULATOR_BREADCRUMB }}
    >
      <SdkSimulatorTool />
    </Page>
  )
}

/** Embeds the SAME tool as a Build tab (no second copy
 * of the form or its `recordSdkUsage` wiring). Skips the <Page> wrapper on
 * purpose: <Page> pushes title/breadcrumb into the shared header via
 * useLayout(), and since Radix unmounts inactive TabsContent, nothing would
 * ever revert that relabeling once this tab is visited. */
export function SdkSimulatorEmbedded() {
  return <SdkSimulatorTool />
}

function SdkSimulatorTool() {
  const { toast } = useToast()

  // Form state
  const [pastedApiKey, setPastedApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  const [selectedAgentCodeInput, setSelectedAgentCodeInput] = useState('')
  const [selectedCustomerExternalId, setSelectedCustomerExternalId] =
    useState('')
  // Internal customer UUID — needed to look up subscriptions (the server
  // action filters by this, not by externalId). Set when the user picks a
  // customer from the dropdown; stays empty if they type a free-form ID.
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [selectedSignalName, setSelectedSignalName] = useState('')
  const [signalSearch, setSignalSearch] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [inputTokens, setInputTokens] = useState(1000)
  const [outputTokens, setOutputTokens] = useState(500)
  // Quantity is 1 for almost every real use case. It only goes above 1 when a
  // single LLM call fans out into multiple billable units (e.g. one batched
  // classification call that processed 50 items). Kept optional in the UI.
  const [quantity, setQuantity] = useState(1)
  const [usageDate, setUsageDate] = useState('')
  const [metadataJson, setMetadataJson] = useState('')

  // Submission state
  const [isSending, setIsSending] = useState(false)
  const [response, setResponse] = useState<Record<string, unknown> | null>(null)
  const [responseError, setResponseError] = useState<string | null>(null)

  // Clipboard state for code preview
  const [codeCopied, setCodeCopied] = useState(false)

  // Demo pricing state — drives the "Set up demo pricing" panel + modals
  // that let users create a plan+strategy+subscription chain so the
  // dashboard can show real margins instead of -100% for simulator events.
  const [showSetupModal, setShowSetupModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [ratePerUnitInput, setRatePerUnitInput] = useState('0.10')
  const [isSavingDemoPricing, setIsSavingDemoPricing] = useState(false)
  const queryClient = useQueryClient()

  // Data fetching
  const { data: agentsData, isLoading: isLoadingAgents } = useAgents({
    limit: 100,
  })
  const { data: customersData, isLoading: isLoadingCustomers } = useCustomers({
    limit: 100,
  })
  const { data: signalsData, isLoading: isLoadingSignals } =
    useAgentSignals(selectedAgentId)
  // Live model + service list from the service_pricing DB table.
  const {
    entries: models,
    search: searchModels,
    isLoading: isLoadingModels,
  } = useServicePricing()

  // Subscription lookup — fetches active subscriptions for the selected
  // agent + customer combo. This tells the user which pricing plan(s) the
  // API will bill against. Only fires when both IDs are set.
  const hasSubscriptionFilters = !!selectedAgentId && !!selectedCustomerId
  const { data: subscriptionsData, isLoading: isLoadingSubscriptions } =
    useSubscriptions(
      {
        agentId: selectedAgentId || undefined,
        customerId: selectedCustomerId || undefined,
        status: 'active',
        includeDetails: true,
        limit: 20,
      },
      { enabled: hasSubscriptionFilters }
    )

  // The subscriptions that match the current agent + customer selection.
  const matchedSubscriptions: Subscription[] = useMemo(
    () => (hasSubscriptionFilters ? (subscriptionsData?.results ?? []) : []),
    [hasSubscriptionFilters, subscriptionsData]
  )

  // Demo pricing — two predicates:
  //
  //   hasDemoPricingFields: the user has filled in agent, customer, and
  //   signal inputs at all (text). This is what controls whether the
  //   panel is visible. A fresh combo — where the user is typing brand-
  //   new values rather than picking from dropdowns — should still see
  //   the panel so they know pricing setup is a thing.
  //
  //   canCheckDemoPricing: we have resolved UUIDs for the agent AND
  //   customer (only set when the user picks from the dropdown). The
  //   status query and the "Set up demo pricing" action both require
  //   these — without them there's nothing to look up on the server and
  //   no valid row to link a new subscription to.
  //
  // When hasDemoPricingFields is true but canCheckDemoPricing is false,
  // the panel renders in a "pick existing agent + customer to set up"
  // state instead of disappearing silently.
  const hasDemoPricingFields =
    !!selectedAgentCodeInput &&
    !!selectedCustomerExternalId &&
    !!selectedSignalName
  const canCheckDemoPricing =
    !!selectedAgentId && !!selectedCustomerId && !!selectedSignalName
  const demoPricingQuery = useQuery({
    queryKey: [
      'simulator-demo-pricing',
      selectedAgentId,
      selectedCustomerId,
      selectedSignalName,
    ],
    queryFn: () =>
      getSimulatorDemoPricingStatus({
        agentId: selectedAgentId,
        customerId: selectedCustomerId,
        signalName: selectedSignalName,
      }),
    enabled: canCheckDemoPricing,
    staleTime: 30_000,
  })

  // Derived data
  const agents = useMemo(() => agentsData?.results ?? [], [agentsData])

  const selectedAgentCode = selectedAgentCodeInput

  const customers = useMemo(
    () => (customersData?.results ?? []).filter((c) => c.externalId),
    [customersData]
  )

  const signals = useMemo(() => signalsData?.results ?? [], [signalsData])

  const modelResults = useMemo(
    () => searchModels(modelSearch).slice(0, 50),
    [searchModels, modelSearch]
  )

  const selectedModel = useMemo<ServicePricingEntry | null>(
    () =>
      selectedModelId
        ? (models.find((m) => m.id === selectedModelId) ?? null)
        : null,
    [models, selectedModelId]
  )

  // Whether the selected service uses LLM-style token billing or non-LLM
  // (per-1K-unit / flat per-unit) billing. Drives whether the form shows
  // input/output token fields and whether quantity is the primary billable
  // input or just metadata. Defaults to true when nothing is selected so
  // the form opens in its most common shape.
  const isLlmRow = !selectedModel || selectedModel.costUnit === '1M tokens'

  // Human-readable name for the unit a non-LLM service bills by, used in
  // the Quantity helper text ("How many pages to track" instead of just
  // "How many units"). Strips the "1K " prefix if present.
  const nonLlmUnitLabel = !isLlmRow
    ? (selectedModel?.costUnit?.replace(/^1K /, '') ?? 'units')
    : 'units'

  // Reset signal when the user changes the agent. Tied to the text
  // input only — an internal UUID lift after demo-pricing setup
  // (see handleSubmitDemoPricing) updates selectedAgentId without
  // changing the displayed code, and should NOT wipe the metric field
  // the user just typed.
  useEffect(() => {
    setSelectedSignalName('')
    setSignalSearch('')
  }, [selectedAgentCodeInput])

  // Code preview
  const codePreview = useMemo(() => {
    const trimmedKey = pastedApiKey.trim()
    const maskedKey = trimmedKey
      ? maskKeyForPreview(trimmedKey)
      : 'YOUR_SECRET_API_KEY'

    const fields: string[] = [
      `  customerExternalId: '${selectedCustomerExternalId || 'CUSTOMER_EXTERNAL_ID'}',`,
      `  agentCode: '${selectedAgentCode || 'AGENT_CODE'}',`,
      `  signalName: '${selectedSignalName || 'SIGNAL_NAME'}',`,
      `  model: '${selectedModel?.canonicalName || selectedModelId || 'MODEL_ID'}',`,
      `  modelProvider: '${selectedModel?.provider || 'PROVIDER'}',`,
    ]

    // Tokens only appear in the snippet for LLM rows. For Textract / DALL-E /
    // Twilio etc. the customer doesn't have meaningful token counts and
    // shouldn't see them in the example code.
    if (isLlmRow) {
      fields.push(`  inputTokens: ${inputTokens},`)
      fields.push(`  outputTokens: ${outputTokens},`)
    }

    // Quantity rules:
    //   - LLM: hidden when 1 (default), shown when > 1 (rare batched case)
    //   - Non-LLM: ALWAYS shown — quantity IS the billable unit count
    if (!isLlmRow || quantity > 1) {
      fields.push(`  quantity: ${quantity},`)
    }

    if (usageDate) {
      fields.push(`  usageDate: '${new Date(usageDate).toISOString()}',`)
    }

    if (metadataJson.trim()) {
      try {
        const parsed = JSON.parse(metadataJson)
        const formatted = JSON.stringify(parsed, null, 2)
          .split('\n')
          .map((line, i) => (i === 0 ? line : `  ${line}`))
          .join('\n')
        fields.push(`  metadata: ${formatted},`)
      } catch {
        fields.push(`  metadata: { /* invalid JSON */ },`)
      }
    }

    return `import { MarginFrontClient } from '@marginfront/sdk';

const client = new MarginFrontClient({
  apiKey: '${maskedKey}',
  baseUrl: '${publicApiBaseUrl()}',
});

await client.trackEvent({
${fields.join('\n')}
});`
  }, [
    pastedApiKey,
    selectedAgentCode,
    selectedCustomerExternalId,
    selectedSignalName,
    selectedModelId,
    selectedModel,
    isLlmRow,
    inputTokens,
    outputTokens,
    quantity,
    usageDate,
    metadataJson,
  ])

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(codePreview).then(() => {
      setCodeCopied(true)
      toast({ title: 'Copied to clipboard', duration: 2000 })
      setTimeout(() => setCodeCopied(false), 2000)
    })
  }, [codePreview, toast])

  const handleSendEvent = useCallback(async () => {
    const apiKey = pastedApiKey.trim()
    if (!apiKey) {
      toast({
        variant: 'destructive',
        title: 'No secret key',
        description:
          'Paste a secret key (mf_sk_…) to authenticate the request.',
      })
      return
    }
    if (
      !selectedAgentCode ||
      !selectedCustomerExternalId ||
      !selectedSignalName ||
      !selectedModelId
    ) {
      toast({
        variant: 'destructive',
        title: 'Missing required fields',
        description: 'Agent, Customer, Metric, and Model are required.',
      })
      return
    }

    let metadata: Record<string, unknown> | undefined
    if (metadataJson.trim()) {
      try {
        metadata = JSON.parse(metadataJson)
      } catch {
        toast({
          variant: 'destructive',
          title: 'Invalid JSON',
          description: 'Metadata must be valid JSON.',
        })
        return
      }
    }

    setIsSending(true)
    setResponse(null)
    setResponseError(null)

    // Build the single record we're sending. The Server Action wraps it
    // in { records: [...] } so we don't have to here.
    //
    // Tokens are only included for LLM rows. For non-LLM services the SDK
    // DTO accepts them as optional, so we omit them; the customer's
    // real code wouldn't include them either.
    const record = {
      customerExternalId: selectedCustomerExternalId,
      agentCode: selectedAgentCode,
      signalName: selectedSignalName,
      model: selectedModel?.canonicalName ?? selectedModelId,
      modelProvider: selectedModel?.provider ?? '',
      ...(isLlmRow
        ? {
            inputTokens: Number(inputTokens),
            outputTokens: Number(outputTokens),
          }
        : {}),
      quantity: Number(quantity),
      ...(usageDate ? { usageDate: new Date(usageDate).toISOString() } : {}),
      ...(metadata ? { metadata } : {}),
    }

    try {
      // Server Action proxies to the NestJS API server-side — no CORS issues.
      const result = await recordSdkUsage(apiKey, [record])

      if (!result.success) {
        setResponseError(
          JSON.stringify(
            { status: result.status, error: result.error, ...result.data },
            null,
            2
          )
        )
      } else {
        setResponse({
          ...(result.data ?? {}),
          _meta: { statusCode: result.status, latencyMs: result.latencyMs },
        })
        toast({
          title: 'Event sent successfully',
          description: `Processed in ${result.latencyMs}ms`,
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unexpected error'
      setResponseError(message)
      console.error('[SDK Simulator] Server Action error:', err)
    } finally {
      setIsSending(false)
    }
  }, [
    pastedApiKey,
    selectedAgentCode,
    selectedCustomerExternalId,
    selectedSignalName,
    selectedModelId,
    selectedModel,
    isLlmRow,
    inputTokens,
    outputTokens,
    quantity,
    usageDate,
    metadataJson,
    toast,
  ])

  // Shared handler for the setup + edit-rate modals. The Server Action is
  // idempotent — calling it when the plan already exists just updates the
  // strategy's rate, so we can reuse it for both "create" and "edit" flows.
  const handleSubmitDemoPricing = useCallback(async () => {
    const rate = Number(ratePerUnitInput)
    if (!Number.isFinite(rate) || rate <= 0) {
      toast({
        variant: 'destructive',
        title: 'Invalid rate',
        description: 'Enter a rate greater than $0.',
      })
      return
    }

    setIsSavingDemoPricing(true)
    try {
      // Pass both resolved UUIDs (when the user picked from a dropdown)
      // AND the raw text inputs (the fresh-combo case where nothing's
      // resolved yet). The server action prefers UUIDs when present and
      // falls back to natural-key resolve-or-create otherwise, so a
      // fully-fresh triple bootstraps the agent + customer + signal
      // rows inside a single transaction.
      const result = await createSimulatorDemoPricing({
        agentId: selectedAgentId || undefined,
        agentCode: selectedAgentCodeInput || undefined,
        customerId: selectedCustomerId || undefined,
        customerExternalId: selectedCustomerExternalId || undefined,
        signalName: selectedSignalName,
        ratePerUnit: rate,
      })

      if (!result.success || !result.data) {
        toast({
          variant: 'destructive',
          title: 'Setup failed',
          description: result.error ?? 'Could not set up demo pricing.',
        })
        return
      }

      // Lift the resolved UUIDs into local state so subsequent
      // interactions on this page (status check, Send Event) see
      // the freshly-created rows as "known" entities instead of
      // free-form text.
      if (result.data.agentId && result.data.agentId !== selectedAgentId) {
        setSelectedAgentId(result.data.agentId)
      }
      if (
        result.data.customerId &&
        result.data.customerId !== selectedCustomerId
      ) {
        setSelectedCustomerId(result.data.customerId)
      }

      // Invalidate every list that may now contain the newly-created
      // agent / customer / signal so the simulator's dropdowns pick
      // them up without a page reload.
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
      // useAgentSignals reads with signalKeys.agentList(agentId) =
      // ['signals','list',{agentId}]. signalKeys.lists() = ['signals','list']
      // prefix-matches every agentList variant.
      await queryClient.invalidateQueries({ queryKey: signalKeys.lists() })
      await queryClient.invalidateQueries({
        queryKey: [
          'simulator-demo-pricing',
          result.data.agentId,
          result.data.customerId,
          selectedSignalName,
        ],
      })
      // Also invalidate subscriptions so the "Active Subscription" panel
      // above picks up the newly created subscription without a
      // page reload.
      await queryClient.invalidateQueries({ queryKey: ['subscriptions'] })
      // New entities feed analytics charts and filter dropdowns elsewhere
      // in the dashboard, so refresh those too.
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
      await queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })

      setShowSetupModal(false)
      setShowEditModal(false)
      toast({
        title: 'Demo pricing ready',
        description: `Rate set to ${formatCost(rate)} per unit. Fire an event to see revenue flow.`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error'
      toast({
        variant: 'destructive',
        title: 'Setup failed',
        description: message,
      })
      console.error('[SDK Simulator] Demo pricing error:', err)
    } finally {
      setIsSavingDemoPricing(false)
    }
  }, [
    ratePerUnitInput,
    selectedAgentId,
    selectedAgentCodeInput,
    selectedCustomerId,
    selectedCustomerExternalId,
    selectedSignalName,
    toast,
    queryClient,
  ])

  const isFormValid =
    pastedApiKey.trim() &&
    selectedAgentCode &&
    selectedCustomerExternalId &&
    selectedSignalName &&
    selectedModelId &&
    quantity >= 1 &&
    (isLlmRow ? inputTokens >= 0 && outputTokens >= 0 : true)

  return (
    <>
      <div className='w-full space-y-6'>
        {/* Hero Section */}
        <div className='relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/90 p-6 md:p-8'>
          <div className='absolute inset-0 overflow-hidden'>
            <div className='absolute -right-24 -top-24 h-96 w-96 rounded-full bg-secondary/20 blur-3xl' />
            <div className='absolute -bottom-32 -left-32 h-80 w-80 rounded-full bg-secondary/10 blur-3xl' />
            <div
              className='absolute inset-0 opacity-[0.03]'
              style={{
                backgroundImage:
                  'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
                backgroundSize: '32px 32px',
              }}
            />
          </div>

          <div className='relative z-10 min-w-[280px] flex-1'>
            <div className='mb-4 flex items-center gap-4'>
              <div className='flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-white/10 shadow-lg backdrop-blur-sm'>
                <TerminalWindow className='h-7 w-7 text-white' weight='bold' />
              </div>
              <div>
                <h2 className='text-2xl font-bold text-white'>SDK Simulator</h2>
                <p className='text-white/70'>
                  Test the usage recording endpoint without writing code
                </p>
              </div>
            </div>
            <p className='max-w-2xl text-sm text-white/80'>
              Build and send a real{' '}
              <code className='rounded bg-white/10 px-1.5 py-0.5'>
                trackEvent()
              </code>{' '}
              call using your API key. Events are recorded in your live
              environment.
            </p>
          </div>
        </div>

        {/* Warning Banner */}
        <Card className='border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'>
          <CardContent className='flex items-start gap-3 py-4'>
            <AlertTriangle className='mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400' />
            <div className='text-sm'>
              <p className='font-medium text-amber-900 dark:text-amber-100'>
                Live environment
              </p>
              <p className='mt-1 text-amber-800 dark:text-amber-200'>
                Events sent from this simulator are real and will appear in your
                usage data and billing.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Two-Column Layout */}
        <div className='grid gap-6 lg:grid-cols-2'>
          {/* Left Column: Form */}
          <Card>
            <CardHeader>
              <CardTitle>Event Configuration</CardTitle>
              <CardDescription>
                Configure the usage event to send
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              {/* Secret Key — pasted by the user, like a real SDK client. */}
              <div className='space-y-2'>
                <Label htmlFor='sdk-secret-key'>
                  Secret Key <span className='text-destructive'>*</span>
                </Label>
                <div className='relative'>
                  {/* sentry-mask: belt and braces on top of maskAllInputs,
                      because this field holds a live secret key. */}
                  <Input
                    id='sdk-secret-key'
                    type={showApiKey ? 'text' : 'password'}
                    className='sentry-mask pr-10 font-mono'
                    placeholder='mf_sk_…'
                    autoComplete='off'
                    value={pastedApiKey}
                    onChange={(e) => setPastedApiKey(e.target.value)}
                  />
                  <button
                    type='button'
                    onClick={() => setShowApiKey((v) => !v)}
                    className='absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'
                    aria-label={
                      showApiKey ? 'Hide secret key' : 'Show secret key'
                    }
                  >
                    {showApiKey ? (
                      <EyeOff className='h-4 w-4' />
                    ) : (
                      <Eye className='h-4 w-4' />
                    )}
                  </button>
                </div>
                <p className='text-xs text-muted-foreground'>
                  Paste a secret key (mf_sk_…) you copied when you created it.
                  The simulator sends a real test event using it. Need one?{' '}
                  <a href='/build?tab=keys' className='font-medium underline'>
                    Create a key
                  </a>
                  .
                </p>
              </div>

              {/* Agent Code */}
              <div className='space-y-2'>
                <Label>
                  Agent Code <span className='text-destructive'>*</span>
                </Label>
                <div className='relative'>
                  <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='pl-9'
                    placeholder={
                      isLoadingAgents
                        ? 'Loading agents...'
                        : 'Enter or search agent code'
                    }
                    value={agentSearch}
                    onChange={(e) => {
                      setAgentSearch(e.target.value)
                      setSelectedAgentCodeInput(e.target.value)
                      setSelectedAgentId('')
                    }}
                    disabled={isLoadingAgents}
                  />
                </div>
                {agentSearch &&
                  !isLoadingAgents &&
                  agents.filter(
                    (a) =>
                      a.agentCode
                        ?.toLowerCase()
                        .includes(agentSearch.toLowerCase()) ||
                      a.name?.toLowerCase().includes(agentSearch.toLowerCase())
                  ).length > 0 && (
                    <div className='max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md'>
                      {agents
                        .filter(
                          (a) =>
                            a.agentCode
                              ?.toLowerCase()
                              .includes(agentSearch.toLowerCase()) ||
                            a.name
                              ?.toLowerCase()
                              .includes(agentSearch.toLowerCase())
                        )
                        .map((agent) => (
                          <button
                            key={agent.id}
                            type='button'
                            className='flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent'
                            onClick={() => {
                              setAgentSearch(agent.agentCode ?? agent.name)
                              setSelectedAgentCodeInput(
                                agent.agentCode ?? agent.name
                              )
                              setSelectedAgentId(agent.id)
                            }}
                          >
                            <span className='font-medium'>{agent.name}</span>
                            <span className='ml-2 text-xs text-muted-foreground'>
                              {agent.agentCode}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                {selectedAgentCodeInput && (
                  <p className='text-xs text-muted-foreground'>
                    Agent code:{' '}
                    <code className='font-mono'>{selectedAgentCodeInput}</code>
                  </p>
                )}
              </div>

              {/* Customer External ID */}
              <div className='space-y-2'>
                <Label>
                  Customer External ID{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <div className='relative'>
                  <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='pl-9'
                    placeholder={
                      isLoadingCustomers
                        ? 'Loading customers...'
                        : 'Enter or search customer external ID'
                    }
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value)
                      setSelectedCustomerExternalId(e.target.value)
                      // Clear internal ID when user types free-form — we can
                      // only look up subscriptions when a known customer is
                      // picked from the dropdown.
                      setSelectedCustomerId('')
                    }}
                    disabled={isLoadingCustomers}
                  />
                </div>
                {customerSearch &&
                  !isLoadingCustomers &&
                  customers.filter(
                    (c) =>
                      c.externalId
                        ?.toLowerCase()
                        .includes(customerSearch.toLowerCase()) ||
                      c.name
                        ?.toLowerCase()
                        .includes(customerSearch.toLowerCase())
                  ).length > 0 && (
                    <div className='max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md'>
                      {customers
                        .filter(
                          (c) =>
                            c.externalId
                              ?.toLowerCase()
                              .includes(customerSearch.toLowerCase()) ||
                            c.name
                              ?.toLowerCase()
                              .includes(customerSearch.toLowerCase())
                        )
                        .map((customer) => (
                          <button
                            key={customer.id}
                            type='button'
                            className='flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent'
                            onClick={() => {
                              setCustomerSearch(customer.externalId!)
                              setSelectedCustomerExternalId(
                                customer.externalId!
                              )
                              setSelectedCustomerId(customer.id)
                            }}
                          >
                            <span className='font-medium'>{customer.name}</span>
                            <span className='ml-2 text-xs text-muted-foreground'>
                              {customer.externalId}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                {selectedCustomerExternalId && (
                  <p className='text-xs text-muted-foreground'>
                    External ID:{' '}
                    <code className='font-mono'>
                      {selectedCustomerExternalId}
                    </code>
                  </p>
                )}
              </div>

              {/* Subscription Info — shows which pricing plan(s) the API
                  will bill this event against. The NestJS SDK service
                  resolves the subscription automatically (findFirst where
                  customerId + agentId + status='active'), so this panel is
                  informational: the user sees WHICH plan applies before
                  they hit Send. Agents can have several plans via the
                  junction table. */}
              {hasSubscriptionFilters && (
                <div className='space-y-2'>
                  <Label className='flex items-center gap-1.5'>
                    <FileText className='h-3.5 w-3.5' />
                    Active Subscription
                  </Label>
                  {isLoadingSubscriptions ? (
                    <div className='flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground'>
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                      Looking up subscriptions...
                    </div>
                  ) : matchedSubscriptions.length === 0 ? (
                    <div className='rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2.5 text-xs dark:border-amber-800 dark:bg-amber-950/20'>
                      <p className='font-medium text-amber-900 dark:text-amber-100'>
                        No active subscription found
                      </p>
                      <p className='mt-0.5 text-amber-800 dark:text-amber-200'>
                        This event will record cost tracking only.
                      </p>
                    </div>
                  ) : matchedSubscriptions.length === 1 ? (
                    <div className='rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2.5 text-xs dark:border-emerald-800 dark:bg-emerald-950/20'>
                      <p className='font-medium text-emerald-900 dark:text-emerald-100'>
                        {matchedSubscriptions[0].name}
                      </p>
                      {matchedSubscriptions[0].pricingPlan && (
                        <p className='mt-0.5 text-emerald-800 dark:text-emerald-200'>
                          Plan:{' '}
                          <span className='font-medium'>
                            {matchedSubscriptions[0].pricingPlan.name}
                          </span>
                          {matchedSubscriptions[0].pricingPlan.description && (
                            <span className='ml-1 text-emerald-700 dark:text-emerald-300'>
                              ·{' '}
                              {matchedSubscriptions[0].pricingPlan.description}
                            </span>
                          )}
                        </p>
                      )}
                      <p className='mt-0.5 text-emerald-700 dark:text-emerald-300'>
                        This event will be billed under this subscription.
                      </p>
                    </div>
                  ) : (
                    <div className='rounded-md border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-xs dark:border-blue-800 dark:bg-blue-950/20'>
                      <p className='font-medium text-blue-900 dark:text-blue-100'>
                        {matchedSubscriptions.length} active subscriptions found
                      </p>
                      <p className='mt-0.5 text-blue-800 dark:text-blue-200'>
                        The API picks the first match. It will use one of these:
                      </p>
                      <ul className='mt-1.5 space-y-1'>
                        {matchedSubscriptions.map((sub) => (
                          <li
                            key={sub.id}
                            className='flex items-center gap-2 text-blue-800 dark:text-blue-200'
                          >
                            <span className='h-1 w-1 rounded-full bg-blue-500' />
                            <span className='font-medium'>{sub.name}</span>
                            {sub.pricingPlan && (
                              <span className='text-blue-600 dark:text-blue-300'>
                                ({sub.pricingPlan.name})
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Metric Name */}
              <div className='space-y-2'>
                <Label>
                  Metric <span className='text-destructive'>*</span>
                </Label>
                <div className='relative'>
                  <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='pl-9'
                    placeholder='Enter or search metric name'
                    value={signalSearch}
                    onChange={(e) => {
                      setSignalSearch(e.target.value)
                      setSelectedSignalName(e.target.value)
                    }}
                  />
                </div>
                {signalSearch &&
                  !isLoadingSignals &&
                  signals.filter((s) =>
                    s.name.toLowerCase().includes(signalSearch.toLowerCase())
                  ).length > 0 && (
                    <div className='max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md'>
                      {signals
                        .filter((s) =>
                          s.name
                            .toLowerCase()
                            .includes(signalSearch.toLowerCase())
                        )
                        .map((signal) => (
                          <button
                            key={signal.id}
                            type='button'
                            className='flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent'
                            onClick={() => {
                              setSignalSearch(signal.name)
                              setSelectedSignalName(signal.name)
                            }}
                          >
                            <span className='font-medium'>{signal.name}</span>
                            {signal.shortName && (
                              <span className='ml-2 text-xs text-muted-foreground'>
                                {signal.shortName}
                              </span>
                            )}
                          </button>
                        ))}
                    </div>
                  )}
                {selectedSignalName && (
                  <p className='text-xs text-muted-foreground'>
                    Metric:{' '}
                    <code className='font-mono'>{selectedSignalName}</code>
                  </p>
                )}
              </div>

              {/* Demo Pricing Status — when the user has filled in agent,
                  customer, and signal, show whether a "Simulator Demo Plan"
                  chain exists. If not, the dashboard will show $0 revenue
                  and -100% margin for simulator events. One-click setup
                  creates a real plan + strategy + subscription so the full
                  cost → revenue → margin flow works end-to-end.

                  The panel renders for fresh combos too (user typing brand-
                  new values instead of picking from the dropdown). When
                  agent/customer UUIDs aren't resolved yet, the status query
                  is skipped (nothing to look up) and the panel falls
                  through to the Set-up button — the server action upserts
                  agents, customers, and signals from the text fields so a
                  fully-fresh triple can bootstrap end-to-end. */}
              {hasDemoPricingFields && (
                <div className='space-y-2'>
                  <Label className='flex items-center gap-1.5'>
                    <DollarSign className='h-3.5 w-3.5' />
                    Demo Pricing
                  </Label>
                  {canCheckDemoPricing && demoPricingQuery.isLoading ? (
                    <div className='flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground'>
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                      Checking demo pricing...
                    </div>
                  ) : demoPricingQuery.data?.exists ? (
                    <div className='rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2.5 text-xs dark:border-emerald-800 dark:bg-emerald-950/20'>
                      <div className='flex items-start justify-between gap-2'>
                        <div>
                          <p className='font-medium text-emerald-900 dark:text-emerald-100'>
                            Demo pricing active
                          </p>
                          <p className='mt-0.5 text-emerald-800 dark:text-emerald-200'>
                            Simulator Demo Plan ·{' '}
                            <span className='font-mono font-medium'>
                              {formatCost(
                                demoPricingQuery.data.ratePerUnit ?? 0
                              )}
                            </span>{' '}
                            per unit
                          </p>
                          <p className='mt-0.5 text-emerald-700 dark:text-emerald-300'>
                            Events you send will show real revenue and margin.
                          </p>
                        </div>
                      </div>
                      <div className='mt-2 flex items-center gap-3 border-t border-emerald-200 pt-2 dark:border-emerald-800'>
                        <button
                          type='button'
                          className='flex items-center gap-1 text-xs font-medium text-emerald-800 hover:text-emerald-950 dark:text-emerald-200 dark:hover:text-emerald-50'
                          onClick={() => {
                            setRatePerUnitInput(
                              String(demoPricingQuery.data?.ratePerUnit ?? 0.1)
                            )
                            setShowEditModal(true)
                          }}
                        >
                          <Pencil className='h-3 w-3' />
                          Edit rate
                        </button>
                        {demoPricingQuery.data.planId && (
                          <Link
                            href={`/agents/${selectedAgentId}/pricing-plans/${demoPricingQuery.data.planId}`}
                            className='flex items-center gap-1 text-xs font-medium text-emerald-800 hover:text-emerald-950 dark:text-emerald-200 dark:hover:text-emerald-50'
                          >
                            Manage in Pricing Plans
                            <ExternalLink className='h-3 w-3' />
                          </Link>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className='rounded-md border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-xs dark:border-blue-800 dark:bg-blue-950/20'>
                      <p className='font-medium text-blue-900 dark:text-blue-100'>
                        Demo pricing not set up
                      </p>
                      <p className='mt-0.5 text-blue-800 dark:text-blue-200'>
                        Without a pricing plan for this metric, event reporting
                        will reflect cost attribution only.
                      </p>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='mt-2 h-7 border-blue-300 bg-white text-xs text-blue-900 hover:bg-blue-50 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100 dark:hover:bg-blue-900'
                        onClick={() => {
                          setRatePerUnitInput('0.10')
                          setShowSetupModal(true)
                        }}
                      >
                        <DollarSign className='mr-1 h-3 w-3' />
                        Set up demo pricing
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Model Selector */}
              <div className='space-y-2'>
                <Label>
                  AI Model <span className='text-destructive'>*</span>
                </Label>
                <div className='relative'>
                  <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='pl-9'
                    placeholder={
                      isLoadingModels
                        ? 'Loading models...'
                        : 'Search models (e.g. gpt-4o, claude-3-5-sonnet)'
                    }
                    value={modelSearch}
                    onChange={(e) => {
                      setModelSearch(e.target.value)
                      setSelectedModelId('')
                    }}
                    disabled={isLoadingModels}
                  />
                </div>
                {modelSearch && modelResults.length > 0 && !selectedModelId && (
                  <div className='max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md'>
                    {modelResults.map((model) => (
                      <button
                        key={model.id}
                        type='button'
                        className='flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent'
                        onClick={() => {
                          setSelectedModelId(model.id)
                          setModelSearch(model.id)
                        }}
                      >
                        <span className='font-mono'>{model.id}</span>
                        <span className='ml-2 text-xs text-muted-foreground'>
                          {model.provider}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {modelSearch &&
                  modelResults.length === 0 &&
                  !isLoadingModels && (
                    <p className='text-xs text-muted-foreground'>
                      No models match &quot;{modelSearch}&quot;
                    </p>
                  )}
                {selectedModelId && (
                  <p className='text-xs text-muted-foreground'>
                    Selected:{' '}
                    <code className='font-mono'>{selectedModelId}</code>
                  </p>
                )}
                {selectedModel && (
                  <div className='rounded-md border bg-muted/40 px-3 py-2.5 text-xs'>
                    <div className='mb-1.5 font-medium text-foreground'>
                      Pricing
                    </div>
                    <div className='grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground'>
                      <span>Input</span>
                      <span className='text-right font-mono text-foreground'>
                        {selectedModel.inputCost != null
                          ? `${formatCost(selectedModel.inputCost)} / ${selectedModel.costUnit}`
                          : '—'}
                      </span>
                      <span>Output</span>
                      <span className='text-right font-mono text-foreground'>
                        {selectedModel.outputCost != null
                          ? `${formatCost(selectedModel.outputCost)} / ${selectedModel.costUnit}`
                          : '—'}
                      </span>
                      {selectedModel.contextWindow != null && (
                        <>
                          <span>Context window</span>
                          <span className='text-right font-mono text-foreground'>
                            {selectedModel.contextWindow.toLocaleString()}{' '}
                            tokens
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Token Counts — only relevant for LLM services. Hidden for
                  Textract / DALL-E / Twilio etc. since those services don't
                  bill on tokens at all. */}
              {isLlmRow && (
                <>
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='space-y-2'>
                      <Label>
                        Input Tokens <span className='text-destructive'>*</span>
                      </Label>
                      <Input
                        type='number'
                        min={0}
                        step={1}
                        value={inputTokens}
                        onChange={(e) =>
                          setInputTokens(
                            e.target.value === '' ? 0 : Number(e.target.value)
                          )
                        }
                      />
                    </div>
                    <div className='space-y-2'>
                      <Label>
                        Output Tokens{' '}
                        <span className='text-destructive'>*</span>
                      </Label>
                      <Input
                        type='number'
                        min={0}
                        step={1}
                        value={outputTokens}
                        onChange={(e) =>
                          setOutputTokens(
                            e.target.value === '' ? 0 : Number(e.target.value)
                          )
                        }
                      />
                    </div>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    Cost is calculated automatically from the model&apos;s
                    pricing table
                  </p>
                </>
              )}

              {/* Quantity — meaning depends on the service type:
                  - LLM: optional metadata count of billable units inside one
                    LLM call. Almost always 1. Helper text leans on this.
                  - Non-LLM: REQUIRED. This IS the billable unit count
                    (pages, images, minutes, requests). Cost = quantity ×
                    rate, so the user has to set it. Red asterisk + unit-
                    aware helper text. */}
              <div className='space-y-2'>
                <Label>
                  Quantity{' '}
                  {isLlmRow ? (
                    <span className='text-muted-foreground'>(optional)</span>
                  ) : (
                    <span className='text-destructive'>*</span>
                  )}
                </Label>
                <Input
                  type='number'
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(e) =>
                    setQuantity(
                      e.target.value === '' ? 1 : Number(e.target.value)
                    )
                  }
                />
                <p className='text-xs text-muted-foreground'>
                  {isLlmRow
                    ? 'Defaults to 1. Only set higher when one event represents multiple billable units (e.g. batched classification of 50 items in one LLM call → quantity 50).'
                    : `How many ${nonLlmUnitLabel} to track. Cost = quantity × rate, so this is the actual billable count.`}
                </p>
              </div>

              {/* Usage Date (optional) */}
              <div className='space-y-2'>
                <Label>Usage Date (optional)</Label>
                <Input
                  type='datetime-local'
                  value={usageDate}
                  onChange={(e) => setUsageDate(e.target.value)}
                />
                <p className='text-xs text-muted-foreground'>
                  Defaults to now if not specified
                </p>
              </div>

              {/* Metadata (optional) */}
              <div className='space-y-2'>
                <Label>Metadata (optional)</Label>
                <Textarea
                  className='font-mono text-sm'
                  rows={3}
                  placeholder='{ "key": "value" }'
                  value={metadataJson}
                  onChange={(e) => setMetadataJson(e.target.value)}
                />
                <p className='text-xs text-muted-foreground'>
                  Must be valid JSON
                </p>
              </div>

              {/* Send Button */}
              <Button
                className='w-full'
                onClick={handleSendEvent}
                disabled={!isFormValid || isSending}
              >
                {isSending ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className='mr-2 h-4 w-4' />
                    Send Event
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Right Column: Code Preview + Response */}
          <div className='space-y-6'>
            {/* Code Preview */}
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-3'>
                <div>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Code className='h-4 w-4' />
                    SDK Code
                  </CardTitle>
                  <CardDescription>Equivalent TypeScript code</CardDescription>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-8 gap-1.5 text-xs'
                  onClick={handleCopyCode}
                >
                  {codeCopied ? (
                    <>
                      <Check className='h-3.5 w-3.5' />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className='h-3.5 w-3.5' />
                      Copy
                    </>
                  )}
                </Button>
              </CardHeader>
              <CardContent>
                {/* sentry-mask: the snippet embeds a mask of the pasted key,
                    so a defect in that mask would otherwise reach replay. */}
                <pre className='sentry-mask overflow-x-auto rounded-lg bg-zinc-950 p-4 text-sm leading-relaxed text-zinc-100'>
                  <code>{codePreview}</code>
                </pre>
              </CardContent>
            </Card>

            {/* Sent Summary — human-readable view of what we just submitted.
                Only shown after a successful send. For LLM events the rows
                are model + tokens + quantity; for non-LLM the token rows
                are dropped (they weren't sent) and the Quantity row gains
                a unit suffix so the count reads naturally. */}
            {response && (
              <Card>
                <CardHeader className='pb-3'>
                  <CardTitle className='text-base'>Sent</CardTitle>
                  <CardDescription>
                    What the simulator just submitted
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm'>
                    <dt className='text-muted-foreground'>Model</dt>
                    <dd className='font-mono text-xs'>{selectedModelId}</dd>
                    {isLlmRow && (
                      <>
                        <dt className='text-muted-foreground'>Input Tokens</dt>
                        <dd className='font-mono text-xs'>
                          {Number(inputTokens).toLocaleString()}
                        </dd>
                        <dt className='text-muted-foreground'>Output Tokens</dt>
                        <dd className='font-mono text-xs'>
                          {Number(outputTokens).toLocaleString()}
                        </dd>
                      </>
                    )}
                    <dt className='text-muted-foreground'>Quantity</dt>
                    <dd className='font-mono text-xs'>
                      {quantity}
                      {!isLlmRow && (
                        <span className='ml-1 text-muted-foreground'>
                          {nonLlmUnitLabel}
                        </span>
                      )}
                    </dd>
                    <dt className='text-muted-foreground'>Customer</dt>
                    <dd className='font-mono text-xs'>
                      {selectedCustomerExternalId}
                    </dd>
                    <dt className='text-muted-foreground'>Agent</dt>
                    <dd className='font-mono text-xs'>{selectedAgentCode}</dd>
                    <dt className='text-muted-foreground'>Metric</dt>
                    <dd className='font-mono text-xs'>{selectedSignalName}</dd>
                    {matchedSubscriptions.length > 0 && (
                      <>
                        <dt className='text-muted-foreground'>Subscription</dt>
                        <dd className='text-xs'>
                          {matchedSubscriptions[0].name}
                          {matchedSubscriptions[0].pricingPlan && (
                            <span className='ml-1 text-muted-foreground'>
                              ({matchedSubscriptions[0].pricingPlan.name})
                            </span>
                          )}
                        </dd>
                      </>
                    )}
                  </dl>
                </CardContent>
              </Card>
            )}

            {/* Response Panel */}
            {(response || responseError) && (
              <Card
                className={cn(
                  response
                    ? 'border-emerald-200 dark:border-emerald-800'
                    : 'border-destructive/50'
                )}
              >
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    {response ? (
                      <>
                        <CheckCircle2 className='h-4 w-4 text-emerald-600' />
                        Response
                        {!!response._meta &&
                          typeof response._meta === 'object' && (
                            <Badge
                              variant='outline'
                              className='ml-auto text-xs font-normal'
                            >
                              {String(
                                (response._meta as Record<string, unknown>)
                                  .latencyMs ?? ''
                              )}
                            </Badge>
                          )}
                      </>
                    ) : (
                      <>
                        <AlertTriangle className='h-4 w-4 text-destructive' />
                        Error
                      </>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className='overflow-x-auto rounded-lg bg-muted p-4 text-sm leading-relaxed'>
                    <code>
                      {response
                        ? JSON.stringify(response, null, 2)
                        : responseError}
                    </code>
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Setup modal — creates a "Simulator Demo Plan" + flat-rate strategy
          on the selected signal + active subscription linking the customer
          to the plan. All four writes happen in one transaction server-side. */}
      <Dialog open={showSetupModal} onOpenChange={setShowSetupModal}>
        <DialogContent className='sm:max-w-[480px]'>
          <DialogHeader>
            <DialogTitle>Set up demo pricing</DialogTitle>
            <DialogDescription>
              We&apos;ll create three things in your account so the dashboard
              can show real revenue and margin for simulator events.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4 py-2'>
            <div className='rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground'>
              <div className='space-y-1'>
                <div>
                  <span className='font-medium text-foreground'>
                    Pricing Plan:
                  </span>{' '}
                  &quot;Simulator Demo Plan&quot;
                </div>
                <div>
                  <span className='font-medium text-foreground'>Strategy:</span>{' '}
                  flat-rate on metric{' '}
                  <code className='font-mono'>{selectedSignalName}</code>
                </div>
                <div>
                  <span className='font-medium text-foreground'>
                    Subscription:
                  </span>{' '}
                  <code className='font-mono'>
                    {selectedCustomerExternalId}
                  </code>{' '}
                  → Simulator Demo Plan
                </div>
              </div>
              <p className='mt-2 border-t pt-2 text-muted-foreground'>
                All three are real entities. Edit the rate or delete them
                anytime from the Pricing Plans page.
              </p>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='demo-rate'>Rate per unit ($)</Label>
              <Input
                id='demo-rate'
                type='number'
                min={0.01}
                step={0.01}
                value={ratePerUnitInput}
                onChange={(e) => setRatePerUnitInput(e.target.value)}
                disabled={isSavingDemoPricing}
              />
              <p className='text-xs text-muted-foreground'>
                How much you&apos;d charge your customer for each billable unit
                of this metric. Default is $0.10.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => setShowSetupModal(false)}
              disabled={isSavingDemoPricing}
            >
              Cancel
            </Button>
            <Button
              type='button'
              onClick={handleSubmitDemoPricing}
              disabled={isSavingDemoPricing}
            >
              {isSavingDemoPricing ? (
                <>
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  Creating...
                </>
              ) : (
                'Create demo pricing'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit-rate modal — reuses the same Server Action since it's
          idempotent. If the rate is unchanged, the action is a no-op. */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className='sm:max-w-[400px]'>
          <DialogHeader>
            <DialogTitle>Edit demo pricing rate</DialogTitle>
            <DialogDescription>
              Update the per-unit rate for the &quot;Simulator Demo Plan&quot;
              strategy on this metric.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2 py-2'>
            <Label htmlFor='demo-rate-edit'>Rate per unit ($)</Label>
            <Input
              id='demo-rate-edit'
              type='number'
              min={0.01}
              step={0.01}
              value={ratePerUnitInput}
              onChange={(e) => setRatePerUnitInput(e.target.value)}
              disabled={isSavingDemoPricing}
            />
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => setShowEditModal(false)}
              disabled={isSavingDemoPricing}
            >
              Cancel
            </Button>
            <Button
              type='button'
              onClick={handleSubmitDemoPricing}
              disabled={isSavingDemoPricing}
            >
              {isSavingDemoPricing ? (
                <>
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
