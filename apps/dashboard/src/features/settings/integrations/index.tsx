/**
 * Integrations Settings Page
 *
 * Manages the Stripe payment connection: Stripe Connect, or the
 * organization's own API keys with its own webhook endpoint.
 */
'use client'

import { useState } from 'react'
import {
  IconBrandStripe,
  IconLock,
  IconCheck,
  IconX,
  IconPlus,
  IconExternalLink,
  IconAlertCircle,
  IconLoader2,
  IconChevronDown,
} from '@tabler/icons-react'
import { generateStripeOAuthUrl } from '@/app/actions/stripe-connect'
import { OrgTaxToggle } from '@/features/settings/components/OrgTaxToggle'
import {
  usePaymentProviders,
  useConnectPaymentProvider,
  useDisconnectPaymentProvider,
  useUpdatePaymentProvider,
} from '@/services/payment-service'
import { API_BASE_URL } from '@/lib/api/config'
import {
  PaymentProvider,
  PaymentProviderType,
  getSupportedProviders,
} from '@/lib/api/payment-providers'
import { isAdmin } from '@/lib/permissions'
import { useCurrentOrganization } from '@/hooks/use-auth'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'

// =============================================================================
// PROVIDER CONFIG
// Each provider has its own icon, brand color, credential fields, webhook info,
// and help links. This is the single source of truth for what each provider needs.
// =============================================================================

/** Describes one credential field the user needs to fill in when connecting */
interface CredentialField {
  key: string // used as the form field key
  label: string // what the user sees
  placeholder: string // example text in the input
  required: boolean
  type: 'text' | 'password' // password hides the value
  helpText?: string // extra hint below the input
  helpLink?: { url: string; label: string } // link to the provider's docs
  /** Maps this field to the API request body. e.g. "apiKey" or "secretKey" */
  mapTo: 'apiKey' | 'secretKey' | 'webhookSecret'
}

/** Full configuration for a single provider */
interface ProviderConfig {
  type: PaymentProviderType
  name: string
  description: string // shown on the "not connected" card
  connectedDescription: string // shown on the "connected" card
  icon: React.ComponentType<{ className?: string }>
  iconBgClass: string // tailwind bg class for the icon wrapper
  iconColorClass: string // tailwind text class for the icon
  brandColor: string // background of the connect button
  credentialFields: CredentialField[]
  webhookEndpoint: string // the path after API_BASE_URL; the organization ID follows it
  webhookEvents: string[] // list of events the user should subscribe to
  dashboardUrl: string // link to the provider's dashboard / settings
  dashboardLabel: string // button text for the dashboard link
  capabilities: string[] // feature badges shown on the connected card
}

/**
 * Supported payment providers and what they need from the user.
 * To add a provider, add an entry here and its adapter in the API.
 */
const PROVIDER_CONFIGS: Record<PaymentProviderType, ProviderConfig> = {
  stripe: {
    type: 'stripe',
    name: 'Stripe',
    description: 'Accept payments for invoices via Stripe Checkout',
    connectedDescription: 'Payment processing and billing infrastructure',
    icon: IconBrandStripe,
    iconBgClass: 'bg-[#635bff]/10',
    iconColorClass: 'text-[#635bff]',
    brandColor: '#635bff',
    credentialFields: [
      {
        key: 'secretKey',
        label: 'Secret Key',
        placeholder: 'sk_live_... or sk_test_...',
        required: true,
        type: 'password',
        helpText:
          'Find this in your Stripe Dashboard under API keys. A standard Secret Key works for everything. ' +
          'If you prefer a restricted key, give it Write access to Checkout Sessions + Customers, and Read access to Payment Intents.',
        helpLink: {
          url: 'https://dashboard.stripe.com/apikeys',
          label: 'Stripe Dashboard',
        },
        mapTo: 'apiKey',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook Secret',
        placeholder: 'whsec_...',
        required: false,
        type: 'password',
        helpText:
          'Required for automatic payment status updates. Create a webhook endpoint in Stripe pointing to the URL shown below, then paste the signing secret here.',
        helpLink: {
          url: 'https://docs.stripe.com/webhooks#endpoint-secrets',
          label: 'How to find your webhook secret',
        },
        mapTo: 'webhookSecret',
      },
    ],
    webhookEndpoint: '/webhooks/stripe',
    // The event types StripeAdapter.verifyWebhook acts on. Keep the two in step.
    webhookEvents: [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'payment_intent.payment_failed',
      'refund.created',
      'refund.updated',
    ],
    dashboardUrl: 'https://dashboard.stripe.com/webhooks',
    dashboardLabel: 'Configure in Stripe Dashboard',
    capabilities: ['Checkout Sessions', 'Invoice Payments', 'Webhooks'],
  },
}

// =============================================================================
// PROVIDER CONNECT DIALOG
// Generic dialog that renders the right credential fields for any provider type.
// =============================================================================

interface ProviderConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  providerType: PaymentProviderType
  organizationId: string
}

function ProviderConnectDialog({
  open,
  onOpenChange,
  onSuccess,
  providerType,
  organizationId,
}: ProviderConnectDialogProps) {
  const providerConfig = PROVIDER_CONFIGS[providerType]
  const Icon = providerConfig.icon

  // One state object holds all field values keyed by field.key
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const connectProvider = useConnectPaymentProvider()

  /** Update a single field in the form */
  const updateField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }))
  }

  /** Validate Stripe secret key format specifically */
  const validateStripeKey = (key: string): boolean => {
    const stripeSecretKeyPattern = /^sk_(test|live)_[a-zA-Z0-9]{24,}$/
    return stripeSecretKeyPattern.test(key)
  }

  /** Check that all required fields are filled in */
  const validateForm = (): string | null => {
    for (const field of providerConfig.credentialFields) {
      const value = fieldValues[field.key]?.trim() || ''
      if (field.required && !value) {
        return `${field.label} is required.`
      }
    }

    const secretKeyValue = fieldValues['secretKey']?.trim() || ''
    if (secretKeyValue && !validateStripeKey(secretKeyValue)) {
      return 'Invalid Stripe Secret Key. Must be in format sk_test_... or sk_live_...'
    }

    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    // Build the API request by mapping each form field to its API key
    const requestData: Record<string, string | boolean | undefined> = {
      type: providerType,
      name: providerConfig.name,
      isDefault: true,
    }

    for (const field of providerConfig.credentialFields) {
      const value = fieldValues[field.key]?.trim() || ''
      if (value) {
        requestData[field.mapTo] = value
      }
    }

    // The API expects the Stripe key in both apiKey and secretKey
    if (requestData.apiKey) {
      requestData.secretKey = requestData.apiKey as string
    }

    try {
      await connectProvider.mutateAsync(requestData as any)
      onSuccess()
      onOpenChange(false)
      setFieldValues({})
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to connect ${providerConfig.name}`
      )
    }
  }

  /** Reset form when dialog closes */
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setFieldValues({})
      setError(null)
    }
    onOpenChange(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='sm:max-w-[500px]'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Icon className={`h-5 w-5 ${providerConfig.iconColorClass}`} />
            Connect {providerConfig.name}
          </DialogTitle>
          <DialogDescription>
            Enter your {providerConfig.name} credentials to enable payment
            processing for your invoices.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className='space-y-4 py-4'>
            {/* Error banner */}
            {error && (
              <div className='rounded-lg border border-red-200 bg-red-50 px-4 py-3'>
                <div className='flex items-center gap-2 text-sm text-red-800'>
                  <IconAlertCircle className='h-4 w-4' />
                  {error}
                </div>
              </div>
            )}

            {/* Render each credential field from the config */}
            {providerConfig.credentialFields.map((field) => (
              <div key={field.key} className='space-y-2'>
                <Label htmlFor={field.key}>
                  {field.label} {field.required ? '*' : '(Optional)'}
                </Label>
                <Input
                  id={field.key}
                  type={field.type}
                  placeholder={field.placeholder}
                  value={fieldValues[field.key] || ''}
                  onChange={(e) => updateField(field.key, e.target.value)}
                  required={field.required}
                />
                {/* Help text + optional link to provider docs */}
                {(field.helpText || field.helpLink) && (
                  <p className='text-xs text-muted-foreground'>
                    {field.helpText}{' '}
                    {field.helpLink && (
                      <a
                        href={field.helpLink.url}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='text-primary hover:underline'
                      >
                        {field.helpLink.label}{' '}
                        <IconExternalLink className='inline h-3 w-3' />
                      </a>
                    )}
                  </p>
                )}
              </div>
            ))}

            {/* Webhook setup instructions. The API-keys path means the merchant
                uses their OWN provider account (not Connect-routed), so they
                have to register a webhook on their own provider dashboard.
                Need everything to set it up: URL, required events, link to
                the right page in the provider's dashboard.
                Merchants connected through Stripe Connect don't see this
                dialog. Their events arrive on the platform webhook. */}
            <div className='space-y-3 rounded-lg border border-dashed border-border/50 bg-muted/20 px-3 py-3'>
              <p className='text-xs font-medium text-foreground'>
                Webhook setup ({providerConfig.name})
              </p>
              <div className='space-y-1'>
                <p className='text-xs text-muted-foreground'>
                  Point your {providerConfig.name} webhook endpoint to:
                </p>
                <code className='block break-all rounded bg-background px-2 py-1.5 text-xs'>
                  {`${API_BASE_URL}${providerConfig.webhookEndpoint}/${organizationId}`}
                </code>
              </div>
              <div className='text-xs text-muted-foreground'>
                <p className='mb-1 font-medium'>Subscribe to these events:</p>
                <ul className='list-inside list-disc space-y-0.5'>
                  {providerConfig.webhookEvents.map((event) => (
                    <li key={event} className='font-mono'>
                      {event}
                    </li>
                  ))}
                </ul>
              </div>
              <a
                href={providerConfig.dashboardUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='inline-flex items-center gap-1 text-xs text-primary hover:underline'
              >
                Open {providerConfig.name} Dashboard{' '}
                <IconExternalLink className='h-3 w-3' />
              </a>
            </div>
          </div>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type='submit' disabled={connectProvider.isPending}>
              {connectProvider.isPending ? (
                <>
                  <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
                  Connecting...
                </>
              ) : (
                `Connect ${providerConfig.name}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// PROVIDER CARD (connected state)
// Works for any provider type -- shows status, capabilities, disconnect button.
// =============================================================================

interface ProviderCardProps {
  provider: PaymentProvider
  hasAdminAccess: boolean
  onDisconnect: () => void
}

function ProviderCard({
  provider,
  hasAdminAccess,
  onDisconnect,
}: ProviderCardProps) {
  const providerConfig = PROVIDER_CONFIGS[provider.type]
  const Icon = providerConfig.icon

  const updateProvider = useUpdatePaymentProvider()
  const [showDisconnectAlert, setShowDisconnectAlert] = useState(false)
  const disconnectProvider = useDisconnectPaymentProvider()
  const { toast } = useToast()

  const handleToggleActive = async (checked: boolean) => {
    await updateProvider.mutateAsync({
      providerId: provider.id,
      data: { isActive: checked },
    })
  }

  const handleDisconnect = async () => {
    try {
      await disconnectProvider.mutateAsync(provider.id)
      onDisconnect()
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
  }

  return (
    <>
      <Card interactive className='card-md border-subtle'>
        <CardHeader>
          <div className='flex items-start justify-between'>
            <div className='flex items-center gap-3'>
              <div className={`rounded-lg p-2 ${providerConfig.iconBgClass}`}>
                <Icon className={`h-6 w-6 ${providerConfig.iconColorClass}`} />
              </div>
              <div>
                <div className='flex items-center gap-2'>
                  <CardTitle className='text-base'>
                    {providerConfig.name}
                  </CardTitle>
                  <Badge
                    variant='outline'
                    className={
                      provider.isActive
                        ? 'border-secondary/20 bg-secondary/10 text-secondary-dark'
                        : 'bg-muted text-muted-foreground'
                    }
                  >
                    {provider.isActive ? (
                      <>
                        <IconCheck className='mr-1 h-3 w-3' />
                        Connected
                      </>
                    ) : (
                      <>
                        <IconX className='mr-1 h-3 w-3' />
                        Disabled
                      </>
                    )}
                  </Badge>
                </div>
                <CardDescription className='text-helper'>
                  {providerConfig.connectedDescription}
                </CardDescription>
              </div>
            </div>
            {hasAdminAccess && (
              <Switch
                checked={provider.isActive}
                onCheckedChange={handleToggleActive}
                disabled={updateProvider.isPending}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='space-y-3'>
            {/* Provider code */}
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-sm font-medium'>Provider Code</p>
                <p className='mt-0.5 text-xs text-muted-foreground'>
                  {provider.code}
                </p>
              </div>
              {provider.isDefault && (
                <Badge
                  variant='secondary'
                  className='bg-primary/10 text-primary'
                >
                  Default
                </Badge>
              )}
            </div>
            <Separator />

            {/* Webhook section.
                - Stripe Connect merchants: events arrive on the platform webhook,
                  so there's nothing to configure. Show a one-line confirmation.
                - API-keys-connected merchants: they pasted credentials manually, which
                  means they ALSO have to set up the webhook in their provider dashboard.
                  Show the full block (URL + events + copy + dashboard link) so they
                  have everything they need without leaving the page. */}
            {provider.settings?.source === 'oauth' ? (
              <div className='rounded-lg border border-dashed border-border/50 bg-muted/20 px-3 py-3'>
                <div className='flex items-start gap-2'>
                  <IconCheck className='mt-0.5 h-4 w-4 flex-shrink-0 text-secondary-dark' />
                  <div className='space-y-1'>
                    <p className='text-sm font-medium'>
                      Webhooks handled by Stripe Connect
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      Payment events route through this server. Your invoices
                      update when customers pay.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className='space-y-3'>
                <div className='flex items-center justify-between'>
                  <div>
                    <p className='text-sm font-medium'>Webhook Status</p>
                    <p className='mt-0.5 text-xs text-muted-foreground'>
                      {provider.settings?.webhookId
                        ? 'Configured and receiving events'
                        : 'Not configured. Payments may not auto-update.'}
                    </p>
                  </div>
                  <Badge
                    variant='secondary'
                    className={
                      provider.settings?.webhookId
                        ? 'bg-secondary/10 text-secondary-dark'
                        : 'bg-amber-100 text-amber-800'
                    }
                  >
                    {provider.settings?.webhookId ? 'Active' : 'Not Set'}
                  </Badge>
                </div>
                <div className='rounded-lg border border-dashed border-border/50 bg-muted/20 px-3 py-2'>
                  <div className='flex items-start justify-between gap-2'>
                    <div className='min-w-0 flex-1'>
                      <p className='text-xs font-medium'>Webhook Endpoint</p>
                      <code className='mt-0.5 block break-all text-xs text-muted-foreground'>
                        {`${API_BASE_URL}${providerConfig.webhookEndpoint}/${provider.organizationId}`}
                      </code>
                    </div>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `${API_BASE_URL}${providerConfig.webhookEndpoint}/${provider.organizationId}`
                        )
                        toast({
                          title: 'Copied',
                          description: 'Webhook URL copied to clipboard',
                        })
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
                <div className='text-xs text-muted-foreground'>
                  <p className='mb-1 font-medium'>Required Events:</p>
                  <ul className='list-inside list-disc space-y-0.5'>
                    {providerConfig.webhookEvents.map((event) => (
                      <li key={event}>{event}</li>
                    ))}
                  </ul>
                </div>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    window.open(providerConfig.dashboardUrl, '_blank')
                  }
                >
                  <IconExternalLink className='mr-2 h-4 w-4' />
                  {providerConfig.dashboardLabel}
                </Button>
              </div>
            )}
            <Separator />

            {/* Capabilities */}
            <div>
              <p className='mb-2 text-sm font-medium'>Capabilities</p>
              <div className='flex flex-wrap gap-2'>
                {providerConfig.capabilities.map((cap) => (
                  <Badge key={cap} variant='outline' className='text-xs'>
                    {cap}
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />
            <OrgTaxToggle hasAdminAccess={hasAdminAccess} />
          </div>

          {/* Disconnect button (admin only) */}
          {hasAdminAccess && (
            <div className='pt-2'>
              <Button
                variant='ghost'
                size='sm'
                className='text-destructive hover:bg-destructive/10 hover:text-destructive'
                onClick={() => setShowDisconnectAlert(true)}
              >
                Disconnect {providerConfig.name}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Disconnect confirmation dialog */}
      <AlertDialog
        open={showDisconnectAlert}
        onOpenChange={setShowDisconnectAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {providerConfig.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will disable payment processing through {providerConfig.name}
              . Customers will no longer be able to pay invoices through this
              provider until you reconnect it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
            >
              {disconnectProvider.isPending ? 'Disconnecting...' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// =============================================================================
// PROVIDER NOT-CONNECTED CARD
// Shown when a provider is supported but the user hasn't connected it yet.
//
// "Connect with Stripe" starts the Stripe Connect OAuth flow. The API-key form sits
// behind a "Use API keys instead" disclosure.
// =============================================================================

interface ProviderNotConnectedCardProps {
  providerType: PaymentProviderType
  hasAdminAccess: boolean
  /** Opens the API-key dialog when the user clicks "Use API keys instead." */
  onConnect: () => void
}

function ProviderNotConnectedCard({
  providerType,
  hasAdminAccess,
  onConnect,
}: ProviderNotConnectedCardProps) {
  const providerConfig = PROVIDER_CONFIGS[providerType]
  const Icon = providerConfig.icon

  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthStarting, setOauthStarting] = useState<boolean>(false)
  const [apiKeysExpanded, setApiKeysExpanded] = useState<boolean>(false)

  const handleStripeOAuth = async () => {
    setOauthError(null)
    setOauthStarting(true)
    const result = await generateStripeOAuthUrl(
      `${window.location.origin}/stripe-connect/callback`
    )
    if (result.success) {
      window.location.href = result.data.authorizationUrl
      return
    }
    setOauthStarting(false)
    setOauthError(result.error)
  }

  return (
    <Card className='card-md border-dashed border-border/50'>
      <CardHeader>
        <div className='flex items-center gap-3'>
          <div className='rounded-lg bg-muted p-2'>
            <Icon className='h-6 w-6 text-muted-foreground' />
          </div>
          <div>
            <CardTitle className='text-base'>{providerConfig.name}</CardTitle>
            <CardDescription className='text-helper'>
              {providerConfig.description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasAdminAccess ? (
          <div className='rounded-lg border border-dashed border-border/50 bg-muted/20 px-4 py-3'>
            <p className='text-sm text-muted-foreground'>
              Ask an organization admin to connect {providerConfig.name}.
            </p>
          </div>
        ) : (
          <div className='space-y-4'>
            <Button
              onClick={handleStripeOAuth}
              disabled={oauthStarting}
              className='w-full'
              size='lg'
              style={{ backgroundColor: providerConfig.brandColor }}
            >
              {oauthStarting ? (
                <>
                  <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
                  Redirecting to {providerConfig.name}...
                </>
              ) : (
                <>
                  <Icon className='mr-2 h-4 w-4' />
                  Connect with {providerConfig.name}
                </>
              )}
            </Button>

            {oauthError && (
              <div className='rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800'>
                <IconAlertCircle className='mr-1 inline h-3 w-3' />
                {oauthError}
              </div>
            )}

            <p className='text-center text-xs text-muted-foreground'>
              Sign in to your Stripe account in one click. No copying API keys.
            </p>

            {/* Collapsible API-keys alternative */}
            <div className='border-t border-border/50 pt-3'>
              <button
                type='button'
                onClick={() => setApiKeysExpanded((prev) => !prev)}
                className='flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground'
              >
                <IconChevronDown
                  className={`h-3 w-3 transition-transform ${apiKeysExpanded ? 'rotate-180' : ''}`}
                />
                {apiKeysExpanded
                  ? 'Hide API-keys option'
                  : 'Use API keys instead'}
              </button>
              {apiKeysExpanded && (
                <div className='mt-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-3'>
                  <p className='mb-3 text-xs text-muted-foreground'>
                    Paste your {providerConfig.name} credentials directly. Use
                    this if your workflow already manages keys, or if{' '}
                    {providerConfig.name} OAuth isn&apos;t available in your
                    region.
                  </p>
                  <Button variant='outline' size='sm' onClick={onConnect}>
                    <IconPlus className='mr-2 h-4 w-4' />
                    Connect with API Keys
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// MAIN COMPONENT
// Loops over all supported providers and renders the right card for each one.
// =============================================================================

export default function IntegrationsSettings() {
  // isOrgLoading aliased because isLoading from usePaymentProviders below collides.
  const { organization: currentOrg, isLoading: isOrgLoading } =
    useCurrentOrganization()
  const userRole = currentOrg?.role
  const hasAdminAccess = isAdmin(userRole)

  // Which provider's connect dialog is open? null means none.
  const [connectingProvider, setConnectingProvider] =
    useState<PaymentProviderType | null>(null)

  // Fetch all payment providers the org has connected
  const { data: providers, isLoading, refetch } = usePaymentProviders()

  const supportedProviders = getSupportedProviders()

  // Helper: find connected provider by type
  const findConnectedProvider = (
    type: PaymentProviderType
  ): PaymentProvider | undefined => {
    return providers?.find((p) => p.type === type)
  }

  return (
    <>
      <div className='max-w-3xl space-y-6'>
        {/* Page Header */}
        <div>
          <div className='flex items-center gap-3'>
            <h2 className='section-header mt-0'>Integrations</h2>
            {hasAdminAccess && (
              <Badge
                variant='secondary'
                className='border-primary/20 bg-primary/10 text-primary'
              >
                Admin Access
              </Badge>
            )}
          </div>
          <p className='text-description'>
            Connect payment providers and external services to extend
            MarginFront functionality.
          </p>
        </div>

        {/* View-only banner for non-admins. Guarded on !isOrgLoading so it doesn't
            flash on hard refresh before the session resolves (role starts undefined =
            treated as non-admin = banner shows for ~50ms before disappearing). */}
        {!isOrgLoading && !hasAdminAccess && (
          <div className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950'>
            <div className='flex items-start gap-3'>
              <IconLock className='mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700 dark:text-amber-400' />
              <div>
                <p className='text-sm font-medium text-amber-900 dark:text-amber-100'>
                  View-Only Access
                </p>
                <p className='mt-1 text-xs text-amber-700 dark:text-amber-300'>
                  You don&apos;t have permission to manage integrations. Contact
                  your organization admin for access.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Payment Providers Section */}
        <div>
          <h3 className='section-header'>Payment Providers</h3>
          <p className='text-helper mb-4'>
            Connect a payment provider to enable online invoice payments
          </p>

          {isLoading ? (
            <Card className='card-md'>
              <CardContent className='p-8 text-center'>
                <IconLoader2 className='mx-auto h-8 w-8 animate-spin text-muted-foreground' />
                <p className='mt-2 text-sm text-muted-foreground'>
                  Loading providers...
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className='space-y-4'>
              {supportedProviders.map((sp) => {
                const connectedProvider = findConnectedProvider(sp.type)

                if (connectedProvider) {
                  // Provider is connected -- show the full card with status & controls
                  return (
                    <ProviderCard
                      key={sp.type}
                      provider={connectedProvider}
                      hasAdminAccess={hasAdminAccess}
                      onDisconnect={() => refetch()}
                    />
                  )
                }

                // Provider is not connected -- show the "connect me" card
                return (
                  <ProviderNotConnectedCard
                    key={sp.type}
                    providerType={sp.type}
                    hasAdminAccess={hasAdminAccess}
                    onConnect={() => setConnectingProvider(sp.type)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Connect Provider Dialog -- renders the right fields based on which provider is selected */}
      {connectingProvider && currentOrg && (
        <ProviderConnectDialog
          open={!!connectingProvider}
          onOpenChange={(isOpen) => {
            if (!isOpen) setConnectingProvider(null)
          }}
          onSuccess={() => refetch()}
          providerType={connectingProvider}
          organizationId={currentOrg.id}
        />
      )}
    </>
  )
}
