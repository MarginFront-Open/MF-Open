import React, { useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { SignalEvent } from '@/services/signal-events-service'
import {
  ArrowRight,
  Check,
  Users,
  ArrowUpDown,
  Inbox,
  User,
  DollarSign,
  Ticket,
  Copy,
  CheckCircle2,
  Sparkles,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { formatCost } from '@/lib/canon-format'
import { buildCostBreakdownRows } from '@/features/signal-events/lib/cost-breakdown-rows'

interface EventDetailsSidebarProps {
  event: SignalEvent | null
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

const EventDetailsSidebar: React.FC<EventDetailsSidebarProps> = ({
  event,
  isOpen,
  onOpenChange,
}) => {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  if (!event) return null

  const _formatUsageDate = (usageDate: string) => {
    try {
      return format(new Date(usageDate), 'MMM dd, yyyy HH:mm:ss')
    } catch (_error) {
      return usageDate
    }
  }

  const formatTimelineDate = (timeStamp: string) => {
    try {
      return format(new Date(timeStamp), 'MMM d, HH:mm:ss')
    } catch (_error) {
      return timeStamp
    }
  }

  // Make a deep copy to avoid mutation issues
  const eventMetadata = JSON.parse(JSON.stringify(event.metadata || {}))

  // Extract timeline events from the metadata
  const timeline = eventMetadata?.timeline
  const timelineEvents = Array.isArray(timeline) ? timeline : []

  // Create a copy of metadata without the timeline for the Properties tab
  const metadataWithoutTimeline = { ...eventMetadata }
  if (metadataWithoutTimeline?.timeline) {
    delete metadataWithoutTimeline.timeline
  }

  // Per-service rows (the canonical source). Length 1 for
  // single-service, N for multi-service. For an event with no
  // signal_event_services rows, this falls back to reading the top-level
  // model/tokens off the raw payload.
  const services = event.services ?? []
  const rawPayload = event.rawPayload ?? {}

  // Build the SDK-shape services array for the Properties JSON. For events
  // with children, use the canonical children. For events with no service
  // children, synthesize a single entry from the raw payload.
  const servicesForJson =
    services.length > 0
      ? services
      : (() => {
          const m = (rawPayload as { model?: unknown }).model
          const p = (rawPayload as { modelProvider?: unknown }).modelProvider
          if (typeof m !== 'string') return []
          return [
            {
              model: m,
              modelProvider: typeof p === 'string' ? p : 'unknown',
              inputTokens:
                typeof (rawPayload as { inputTokens?: unknown }).inputTokens ===
                'number'
                  ? (rawPayload as { inputTokens: number }).inputTokens
                  : null,
              outputTokens:
                typeof (rawPayload as { outputTokens?: unknown })
                  .outputTokens === 'number'
                  ? (rawPayload as { outputTokens: number }).outputTokens
                  : null,
              quantity: null,
              usageCost: event.usageCost,
              eventStatus: event.eventProcessed,
            },
          ]
        })()

  // Build comprehensive properties object with all event data
  const eventProperties = {
    // What the customer sent us — services[] is the canonical SDK shape.
    // For single-service events, this is a 1-element array mirroring the
    // top-level fields the SDK exposes; for multi-service, the full array.
    ...(servicesForJson.length > 0 ? { services: servicesForJson } : {}),
    // Core event data
    quantity: event.quantity,
    // The environment tag that drives COGS-vs-R&D auto-classification.
    environment: event.environment,
    usageCost: event.usageCost,
    eventProcessed: event.eventProcessed,
    usageDate: event.usageDate,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    eventProcessedAt: event.eventProcessedAt,
    // External identifiers the customer actually cares about
    customerExternalId: event.customerExternalId,
    subscriptionId: event.subscriptionId,
    // Related entities — nested objects carry both the id and the human name,
    // so we don't duplicate the top-level agentId/customerId/signalId.
    signal: event.signal,
    customer: event.customer,
    agent: event.agent,
    // Custom metadata (if any)
    ...(Object.keys(metadataWithoutTimeline).length > 0
      ? { metadata: metadataWithoutTimeline }
      : {}),
  }

  const propertiesStr = JSON.stringify(eventProperties, null, 2)

  const costBreakdownRows = buildCostBreakdownRows(
    event.usageCostData,
    services
  )

  // Get icon for timeline event type
  const getIconForEventType = (type: string) => {
    switch (type) {
      case 'ingest':
        return <Check className='h-4 w-4 text-white' />
      case 'customer':
        return <Users className='h-4 w-4 text-white' />
      case 'signal':
        return <ArrowUpDown className='h-4 w-4 text-white' />
      case 'agent':
        return <User className='h-4 w-4 text-white' />
      case 'cost':
        return <DollarSign className='h-4 w-4 text-white' />
      case 'subscription':
        return <Ticket className='h-4 w-4 text-white' />
      default:
        return <Inbox className='h-4 w-4 text-white' />
    }
  }

  const handleCopyClick = () => {
    navigator.clipboard.writeText(propertiesStr)
    setCopied(true)
    toast({
      title: 'Copied to clipboard',
      description: 'Properties JSON has been copied to clipboard',
      duration: 2000,
    })
    setTimeout(() => setCopied(false), 2000)
  }

  const hasTimelineData = timelineEvents && timelineEvents.length > 0

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent className='overflow-hidden p-0 sm:max-w-lg'>
        <SheetHeader className='p-4 pb-2'>
          <SheetTitle className='flex items-center gap-1.5'>
            Event ID
            <InfoTooltip {...tooltipDefinitions.eventId} />
          </SheetTitle>
          <SheetDescription>{event.id}</SheetDescription>
        </SheetHeader>

        <ScrollArea className='h-[calc(100vh-120px)]'>
          <div className='space-y-4 p-4 pt-2'>
            {/* Environment — the tag the SDK sent with this event. It's what
                auto-classifies the cost into COGS (production) vs R&D
                (development/testing), so showing it here makes the P&L-bucket
                decision auditable from the event itself. "Not tagged" means
                the customer didn't send one, so the cost stays unclassified
                until someone classifies the signal. */}
            <div className='flex items-center gap-2 text-sm'>
              <span className='text-muted-foreground'>Environment</span>
              <span className='font-medium'>
                {event.environment ?? 'Not tagged'}
              </span>
            </div>

            {/* Timeline */}
            <div className='border-t border-border pt-3'>
              <h3 className='mb-3 text-base font-medium'>Timeline</h3>

              {!hasTimelineData ? (
                <p className='text-xs text-muted-foreground'>
                  No timeline data available
                </p>
              ) : (
                <div className='relative'>
                  {timelineEvents.map((event, index) => (
                    <div
                      key={index}
                      className='relative flex items-start gap-4 pb-6 last:pb-0'
                    >
                      {/* Line connecting timeline events */}
                      {index < timelineEvents.length - 1 && (
                        <div className='absolute left-[14px] top-8 h-[calc(100%-8px)] w-0.5 bg-border'></div>
                      )}

                      {/* Event icon - using brand primary color */}
                      <div className='relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary shadow-sm'>
                        {getIconForEventType(event.type)}
                      </div>

                      {/* Event content */}
                      <div className='flex min-w-0 flex-1 flex-col justify-center pt-0.5'>
                        <div className='flex items-start justify-between gap-2'>
                          <h4 className='text-sm font-medium leading-tight'>
                            {event.message}
                          </h4>
                          <span className='flex-shrink-0 whitespace-nowrap text-xs text-muted-foreground'>
                            {formatTimelineDate(event.timestamp)}
                          </span>
                        </div>

                        {event.amount !== undefined && (
                          <p className='mt-1 text-xs text-muted-foreground'>
                            Amount: ${event.amount}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cost Breakdown — per-direction split computed at ingest time */}
            <div className='border-t border-border pt-3'>
              <h3 className='mb-2 text-sm font-medium text-muted-foreground'>
                Cost Breakdown
              </h3>
              {costBreakdownRows.length > 0 ? (
                <div className='overflow-hidden rounded-md border'>
                  <table className='w-full text-xs'>
                    <tbody>
                      {costBreakdownRows.map((row) => (
                        <tr key={row.key} className='border-b last:border-b-0'>
                          <td className='px-3 py-2 font-mono text-muted-foreground'>
                            {row.key}
                          </td>
                          <td className='px-3 py-2 text-right font-mono'>
                            {row.units !== null
                              ? row.units.toLocaleString()
                              : '—'}
                          </td>
                          <td className='px-3 py-2 text-right font-mono'>
                            {formatCost(row.cost)}
                          </td>
                        </tr>
                      ))}
                      <tr className='bg-muted/50'>
                        <td className='px-3 py-2 font-medium' colSpan={2}>
                          Total
                        </td>
                        <td className='px-3 py-2 text-right font-mono font-medium'>
                          {event.usageCost != null
                            ? formatCost(event.usageCost)
                            : '$0.0000'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className='text-xs text-muted-foreground'>
                  No cost breakdown available
                </p>
              )}
            </div>

            {/* Backfill — acknowledgement of any backfill action taken
                on this event (model map, volume fill). Rendered ONLY when
                the server-computed event.resolution is non-null — regular
                (never-backfilled) events show nothing here. Historical
                representations (rawPayload, usageCostData keys, the Cost
                Breakdown table above) stay untouched; this section is the
                plain-English delta spelled out for the user. */}
            {event.resolution && (
              <BackfillSection resolution={event.resolution} />
            )}

            {/* Properties */}
            <div className='border-t border-border pt-3'>
              <div className='mb-2 flex items-center justify-between'>
                <h3 className='text-sm font-medium text-muted-foreground'>
                  Properties
                </h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='h-6 w-6'
                        onClick={handleCopyClick}
                      >
                        {copied ? (
                          <CheckCircle2 className='h-3.5 w-3.5 text-theme-accent-500' />
                        ) : (
                          <Copy className='h-3.5 w-3.5' />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side='left'>
                      <p>Copy properties</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <pre className='mt-1 max-h-[250px] overflow-auto rounded-md bg-muted p-4 text-xs'>
                {propertiesStr}
              </pre>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

export default EventDetailsSidebar

// Backfill section — shown between Cost Breakdown and Properties when
// this event was touched by a backfill action. Two branches, either or
// both may render:
//
//   Model mapping — an org_model_mappings row matches this event's
//   submitted (model, provider). Frames the mapping as a go-forward rule
//   so users understand: "this is how future events of this model will
//   be priced, not just this one backfilled historical row."
//
//   Volume fill — the event is PROCESSED with cost, but the raw ingest
//   payload was missing volume. Shows the filled values the user typed
//   via FillVolumeDialog.
//
// Separate, dedicated section by design — we deliberately don't mutate
// the Cost Breakdown row keys or the Properties JSON, keeping ingest
// history intact. The acknowledgement is additive. Section hides entirely
// when event.resolution is null (a regular, never-backfilled event).
function BackfillSection({
  resolution,
}: {
  resolution: NonNullable<SignalEvent['resolution']>
}) {
  const { modelMapping, volumeFill, resolvedAt } = resolution

  const formatResolvedTime = (iso: string | null) => {
    if (!iso) return null
    try {
      return `${formatDistanceToNowStrict(new Date(iso), {
        addSuffix: true,
      })}`
    } catch {
      return null
    }
  }
  const relativeTime = formatResolvedTime(resolvedAt)

  return (
    <div className='border-t border-border pt-3'>
      <div className='mb-3 flex items-center gap-2'>
        <Sparkles className='h-4 w-4 text-primary' />
        <h3 className='text-base font-medium'>Backfill</h3>
      </div>
      <p className='mb-3 text-xs text-muted-foreground'>
        This event was backfilled. Here&apos;s what changed and how future
        events of this kind will behave:
      </p>

      <div className='space-y-3'>
        {modelMapping && (
          <div className='rounded-md border bg-muted/30 px-3 py-2.5'>
            <p className='mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
              Model mapping
            </p>
            <div className='flex flex-wrap items-center gap-2 text-sm'>
              <span className='font-mono'>{modelMapping.sourceModel}</span>
              <span className='text-xs text-muted-foreground'>
                · {modelMapping.sourceProvider}
              </span>
              <ArrowRight className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
              <span className='font-medium'>
                {modelMapping.target.displayName}
              </span>
              <span className='text-xs text-muted-foreground'>
                · {modelMapping.target.provider}
              </span>
            </div>
            <p className='mt-1.5 text-xs text-muted-foreground'>
              Future events with{' '}
              <span className='font-mono text-foreground'>
                {modelMapping.sourceModel}
              </span>{' '}
              auto-map here.
            </p>
          </div>
        )}

        {volumeFill && (
          <div className='rounded-md border bg-muted/30 px-3 py-2.5'>
            <p className='mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
              Volume filled
            </p>
            <div className='flex flex-wrap items-baseline gap-4 text-sm'>
              {volumeFill.inputTokens !== undefined && (
                <div>
                  <span className='font-mono tabular-nums'>
                    {volumeFill.inputTokens.toLocaleString()}
                  </span>
                  <span className='ml-1 text-xs text-muted-foreground'>
                    input tokens
                  </span>
                </div>
              )}
              {volumeFill.outputTokens !== undefined && (
                <div>
                  <span className='font-mono tabular-nums'>
                    {volumeFill.outputTokens.toLocaleString()}
                  </span>
                  <span className='ml-1 text-xs text-muted-foreground'>
                    output tokens
                  </span>
                </div>
              )}
              {volumeFill.quantity !== undefined && (
                <div>
                  <span className='font-mono tabular-nums'>
                    {volumeFill.quantity.toLocaleString()}
                  </span>
                  <span className='ml-1 text-xs text-muted-foreground'>
                    units
                  </span>
                </div>
              )}
            </div>
            <p className='mt-1.5 text-xs text-muted-foreground'>
              Applied to every event in this (model, provider) group that was
              waiting for volume.
            </p>
          </div>
        )}

        {relativeTime && (
          <p className='text-xs text-muted-foreground'>
            Backfilled {relativeTime}.
          </p>
        )}
      </div>
    </div>
  )
}
