'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import {
  db,
  Prisma,
  resolveEventPrice,
  recomputeParentUsageCost,
} from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { parseWindowFilter } from './_shared/parse-window-filter'
// These are BUILD writes (metering plumbing), not MONEY writes —
// assigning a COGS/R&D category is the MONEY write, see signal-classification.ts.
import { assertBuildManager } from './_shared/assert-build-manager'

// Field names mirror what `mf.usage.record()` accepts and returns in
// `services[]`, so the dashboard renders the SDK caller's shape untranslated.
export interface SignalEventService {
  model: string
  modelProvider: string
  inputTokens: number | null
  outputTokens: number | null
  quantity: number | null
  usageCost: number | null
  eventStatus:
    | 'PENDING'
    | 'PROCESSED'
    | 'ERROR'
    | 'NEEDS_COST_BACKFILL'
    | 'MISSING_VOLUME_DATA'
}

export interface SignalEvent {
  id: string
  usageDate: string
  agentId: string
  customerId: string
  customerExternalId: string
  subscriptionId: string
  signalId: string | null
  quantity: number
  // Drives the COGS (production) vs R&D (dev/testing) split, so it is
  // serialized here to keep the P&L bucket auditable from the event itself
  //Null when the SDK sent no tag.
  environment: 'production' | 'staging' | 'development' | 'testing' | null
  metadata: Record<string, unknown> | null
  usageCost: number | null
  // Keys are "<model>/<direction>": input, output, cache_read, cache_write.
  // Multi-service events merge keys across services (Claude+GPT-4o → 4 keys).
  usageCostData: Record<string, unknown> | null
  // raw_ingest_events.payload verbatim — what the customer actually sent.
  // Null for an event with no stored payload.
  rawPayload: Record<string, unknown> | null
  // signal_event_services children. Always populated.
  services: SignalEventService[]
  eventProcessed:
    | 'PENDING'
    | 'PROCESSED'
    | 'ERROR'
    | 'NEEDS_COST_BACKFILL'
    | 'MISSING_VOLUME_DATA'
  eventProcessedAt: string | null
  createdAt: string
  updatedAt: string
  signal?: {
    id: string
    name: string
    shortName: string | null
    type?: string
  } | null
  customer?: {
    id: string
    name: string
    email: string | null
  }
  agent?: {
    id: string
    name: string
    agentCode: string
  }
  /**
   * Populated by getSignalEvent only (not list fetches) when a backfill
   * touched the event. rawPayload and usageCostData stay historically
   * truthful — this field is the acknowledgement, never a rewrite of them.
   */
  resolution?: {
    // Set when an org_model_mappings row exists for the submitted
    // (model, provider); future events with that tuple price against `target`.
    modelMapping?: {
      sourceModel: string
      sourceProvider: string
      target: {
        canonicalName: string
        displayName: string
        provider: string
      }
    }
    // Set when volume was filled manually via the MISSING_VOLUME_DATA
    // drill-down. Values come from the usageCostData written at fill time.
    volumeFill?: {
      inputTokens?: number
      outputTokens?: number
      quantity?: number
    }
    // eventProcessedAt, ISO.
    resolvedAt: string | null
  } | null
}

export interface SignalEventsResponse {
  results: SignalEvent[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface GetSignalEventsParams {
  page?: number
  limit?: number
  agentId?: string
  customerId?: string
  signalId?: string
  subscriptionId?: string
  startDate?: string
  endDate?: string
  eventProcessed?:
    | 'PENDING'
    | 'PROCESSED'
    | 'ERROR'
    | 'NEEDS_COST_BACKFILL'
    | 'MISSING_VOLUME_DATA'
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface TimeRange {
  startDate: string
  endDate: string
}

export interface RawEvents {
  total: number
  PROCESSED: number
  PENDING: number
  ERROR: number
  NEEDS_COST_BACKFILL: number
  MISSING_VOLUME_DATA: number
}

export interface SignalDistribution {
  signalId: string
  signalName: string
  shortName: string | null
  count: number
  totalQuantity: number
}

export interface DateWiseEvent {
  date: string
  count: number
  signals: Array<{
    signalId: string
    signalName: string
    signalShortName: string | null
    count: number
    totalQuantity: number
  }>
}

export interface EventsAnalyticsResponse {
  timeRange: TimeRange
  rawEvents: RawEvents
  signalDistribution: SignalDistribution[]
  dateWiseEvents: DateWiseEvent[]
  totalQuantity: number
  totalUsageCost: number
}

export interface GetEventsAnalyticsParams {
  startDate?: string
  endDate?: string
  agentId?: string
  customerId?: string
  signalId?: string
}

const mapSignalEvent = (event: any): SignalEvent => ({
  id: event.id,
  usageDate: event.usageDate.toISOString(),
  agentId: event.agentId,
  customerId: event.customerId,
  customerExternalId: event.customerExternalId,
  subscriptionId: event.subscriptionId,
  signalId: event.signalId,
  quantity: Number(event.quantity),
  environment: event.environment ?? null,
  metadata: event.metadata as Record<string, unknown> | null,
  usageCost: event.usageCost ? Number(event.usageCost) : null,
  usageCostData: (event.usageCostData ?? null) as Record<
    string,
    unknown
  > | null,
  rawPayload: (event.raw_ingest_events?.payload ?? null) as Record<
    string,
    unknown
  > | null,
  services: Array.isArray(event.signal_event_services)
    ? event.signal_event_services.map(
        (c: {
          model: string
          modelProvider: string
          inputTokens: number | null
          outputTokens: number | null
          quantity: unknown
          usageCost: unknown
          eventStatus: SignalEventService['eventStatus']
        }) => ({
          model: c.model,
          modelProvider: c.modelProvider,
          inputTokens: c.inputTokens ?? null,
          outputTokens: c.outputTokens ?? null,
          quantity: c.quantity != null ? Number(c.quantity) : null,
          usageCost: c.usageCost != null ? Number(c.usageCost) : null,
          eventStatus: c.eventStatus,
        })
      )
    : [],
  eventProcessed: event.eventProcessed,
  eventProcessedAt: event.eventProcessedAt?.toISOString() ?? null,
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
  signal: event.signals
    ? {
        id: event.signals.id,
        name: event.signals.name,
        shortName: event.signals.shortName,
        type: event.signals.type,
      }
    : null,
  customer: event.customers
    ? {
        id: event.customers.id,
        name: event.customers.name,
        email: event.customers.email,
      }
    : undefined,
  agent: event.agents
    ? {
        id: event.agents.id,
        name: event.agents.name,
        agentCode: event.agents.agentCode,
      }
    : undefined,
})

export async function getSignalEvents(
  params: GetSignalEventsParams = {}
): Promise<{
  success: boolean
  data?: SignalEventsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const {
      page = 1,
      limit = 100,
      agentId,
      customerId,
      signalId,
      subscriptionId,
      startDate,
      endDate,
      eventProcessed,
      sortBy = 'usageDate',
      sortOrder = 'desc',
    } = params

    const where: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
    }

    if (agentId) {
      where.agentId = agentId
    }

    if (customerId) {
      where.customerId = customerId
    }

    if (signalId) {
      where.signalId = signalId
    }

    if (subscriptionId) {
      where.subscriptionId = subscriptionId
    }

    if (eventProcessed) {
      where.eventProcessed = eventProcessed
    }

    if (startDate || endDate) {
      const { windowStart, windowEnd } = parseWindowFilter({
        startDate,
        endDate,
      })
      where.usageDate = { gte: windowStart, lte: windowEnd }
    } else {
      where.usageDate = { lte: new Date() }
    }

    const orderBy: Prisma.signal_eventsOrderByWithRelationInput = {}
    if (sortBy === 'usageDate') {
      orderBy.usageDate = sortOrder
    } else if (sortBy === 'createdAt') {
      orderBy.createdAt = sortOrder
    } else if (sortBy === 'quantity') {
      orderBy.quantity = sortOrder
    } else if (sortBy === 'usageCost') {
      orderBy.usageCost = sortOrder
    } else {
      orderBy.usageDate = 'desc'
    }

    const total = await db.signal_events.count({ where })

    const events = await db.signal_events.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
        },
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
          },
        },
        raw_ingest_events: {
          select: {
            payload: true,
          },
        },
        signal_event_services: {
          orderBy: { createdAt: 'asc' },
          select: {
            model: true,
            modelProvider: true,
            inputTokens: true,
            outputTokens: true,
            quantity: true,
            usageCost: true,
            eventStatus: true,
          },
        },
      },
    })

    return {
      success: true,
      data: {
        results: events.map(mapSignalEvent),
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        totalResults: total,
      },
    }
  } catch (error) {
    console.error('[getSignalEvents] Error:', error)
    return { success: false, error: 'Failed to fetch signal events' }
  }
}

export async function bulkDeleteEvents(eventIds: string[]): Promise<{
  success: boolean
  data?: { deletedCount: number }
  error?: string
}> {
  try {
    // BUILD write: deleting operational cost events is metering plumbing — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    if (!eventIds || eventIds.length === 0) {
      return { success: false, error: 'No event IDs provided' }
    }

    const result = await db.signal_events.deleteMany({
      where: {
        id: { in: eventIds },
        organizationId: orgId,
      },
    })

    revalidatePath('/signal-events')

    return {
      success: true,
      data: { deletedCount: result.count },
    }
  } catch (error) {
    console.error('[bulkDeleteEvents] Error:', error)
    return { success: false, error: 'Failed to delete signal events' }
  }
}

export async function getEventAnalytics(
  params: GetEventsAnalyticsParams = {}
): Promise<{
  success: boolean
  data?: EventsAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const { startDate, endDate, agentId, customerId, signalId } = params

    // Defaults to the last 30 days when neither bound is supplied.
    const { windowStart: effectiveStartDate, windowEnd: effectiveEndDate } =
      parseWindowFilter({ startDate, endDate })

    const where: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
      usageDate: {
        gte: effectiveStartDate,
        lte: effectiveEndDate,
      },
    }

    if (agentId) {
      where.agentId = agentId
    }

    if (customerId) {
      where.customerId = customerId
    }

    if (signalId) {
      where.signalId = signalId
    }

    // ERROR comes from raw_ingest_events because a storage failure never
    // writes a signal_events row. It is therefore org-wide + date-bounded
    // ONLY: customerId/agentId/signalId cannot filter it, since errors happen
    // before auto-provisioning resolves those foreign keys.
    const [statusCounts, rawErrorCount] = await Promise.all([
      db.signal_events.groupBy({
        by: ['eventProcessed'],
        where,
        _count: true,
      }),
      db.raw_ingest_events.count({
        where: {
          organizationId: orgId,
          receivedAt: {
            gte: effectiveStartDate,
            lte: effectiveEndDate,
          },
          status: 'ERROR',
        },
      }),
    ])

    const rawEvents: RawEvents = {
      total: 0,
      PROCESSED: 0,
      PENDING: 0,
      ERROR: rawErrorCount,
      NEEDS_COST_BACKFILL: 0,
      MISSING_VOLUME_DATA: 0,
    }

    // ERROR is skipped here: it already came from raw_ingest_events above and
    // counting it again would double it.
    statusCounts.forEach((item) => {
      const key = item.eventProcessed as keyof RawEvents
      if (key in rawEvents && key !== 'ERROR' && key !== 'total') {
        rawEvents[key] = item._count
      }
      rawEvents.total += item._count
    })
    rawEvents.total += rawErrorCount

    const signalGroups = await db.signal_events.groupBy({
      by: ['signalId'],
      where: {
        ...where,
        signalId: { not: null },
      },
      _count: true,
      _sum: {
        quantity: true,
      },
    })

    const signalIds = signalGroups
      .map((g) => g.signalId)
      .filter((id): id is string => id !== null)

    const signals = await db.signals.findMany({
      where: { id: { in: signalIds } },
      select: { id: true, name: true, shortName: true },
    })

    const signalMap = new Map(signals.map((s) => [s.id, s]))

    const signalDistribution: SignalDistribution[] = signalGroups.map(
      (group) => {
        const signal = signalMap.get(group.signalId!)
        return {
          signalId: group.signalId!,
          signalName: signal?.name || 'Unknown',
          shortName: signal?.shortName || null,
          count: group._count,
          totalQuantity: Number(group._sum.quantity) || 0,
        }
      }
    )

    const events = await db.signal_events.findMany({
      where,
      select: {
        usageDate: true,
        signalId: true,
        quantity: true,
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
        },
      },
      orderBy: { usageDate: 'asc' },
    })

    const dateMap = new Map<
      string,
      {
        count: number
        signals: Map<
          string,
          {
            count: number
            totalQuantity: number
            name: string
            shortName: string | null
          }
        >
      }
    >()

    let totalQuantity = 0
    let totalUsageCost = 0

    events.forEach((event) => {
      const dateKey = event.usageDate.toISOString().split('T')[0]
      totalQuantity += Number(event.quantity)

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { count: 0, signals: new Map() })
      }

      const dateData = dateMap.get(dateKey)!
      dateData.count++

      if (event.signalId && event.signals) {
        if (!dateData.signals.has(event.signalId)) {
          dateData.signals.set(event.signalId, {
            count: 0,
            totalQuantity: 0,
            name: event.signals.name,
            shortName: event.signals.shortName,
          })
        }
        const signalData = dateData.signals.get(event.signalId)!
        signalData.count++
        signalData.totalQuantity += Number(event.quantity)
      }
    })

    const dateWiseEvents: DateWiseEvent[] = Array.from(dateMap.entries()).map(
      ([date, data]) => ({
        date,
        count: data.count,
        signals: Array.from(data.signals.entries()).map(
          ([signalId, signalData]) => ({
            signalId,
            signalName: signalData.name,
            signalShortName: signalData.shortName,
            count: signalData.count,
            totalQuantity: signalData.totalQuantity,
          })
        ),
      })
    )

    const costResult = await db.signal_events.aggregate({
      where,
      _sum: {
        usageCost: true,
      },
    })

    totalUsageCost = Number(costResult._sum.usageCost) || 0

    return {
      success: true,
      data: {
        timeRange: {
          startDate: effectiveStartDate.toISOString(),
          endDate: effectiveEndDate.toISOString(),
        },
        rawEvents,
        signalDistribution,
        dateWiseEvents,
        totalQuantity,
        totalUsageCost,
      },
    }
  } catch (error) {
    console.error('[getEventAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch event analytics' }
  }
}

export async function getSignalEvent(eventId: string): Promise<{
  success: boolean
  data?: SignalEvent
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const event = await db.signal_events.findFirst({
      where: {
        id: eventId,
        organizationId: orgId,
      },
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
        },
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
          },
        },
        raw_ingest_events: {
          select: {
            payload: true,
          },
        },
        signal_event_services: {
          orderBy: { createdAt: 'asc' },
          select: {
            model: true,
            modelProvider: true,
            inputTokens: true,
            outputTokens: true,
            quantity: true,
            usageCost: true,
            eventStatus: true,
          },
        },
      },
    })

    if (!event) {
      return { success: false, error: 'Signal event not found' }
    }

    const mappedEvent = mapSignalEvent(event)
    const payload = event.raw_ingest_events?.payload as
      | Record<string, unknown>
      | null
      | undefined
    const submittedModel =
      typeof payload?.model === 'string' ? payload.model : null
    const submittedProvider =
      typeof payload?.modelProvider === 'string' ? payload.modelProvider : null

    let modelMapping: NonNullable<SignalEvent['resolution']>['modelMapping'] =
      undefined
    if (submittedModel && submittedProvider) {
      const mapping = await db.org_model_mappings.findFirst({
        where: {
          organizationId: orgId,
          sourceModel: submittedModel.trim().toLowerCase(),
          sourceProvider: submittedProvider.trim().toLowerCase(),
        },
        select: {
          sourceModel: true,
          sourceProvider: true,
          service_pricing: {
            select: {
              canonicalName: true,
              displayName: true,
              provider: true,
            },
          },
        },
      })
      if (mapping?.service_pricing) {
        modelMapping = {
          sourceModel: mapping.sourceModel,
          sourceProvider: mapping.sourceProvider,
          target: {
            canonicalName: mapping.service_pricing.canonicalName,
            displayName: mapping.service_pricing.displayName,
            provider: mapping.service_pricing.provider,
          },
        }
      }
    }

    // No flag records a manual fill, so it is inferred: PROCESSED, priced,
    // ingest payload carried no volume, yet usageCostData has non-zero units.
    // Only a fill through the MISSING_VOLUME_DATA drill-down produces that.
    let volumeFill: NonNullable<SignalEvent['resolution']>['volumeFill'] =
      undefined
    const isProcessed = mappedEvent.eventProcessed === 'PROCESSED'
    const hasUsageCost = mappedEvent.usageCost !== null
    const payloadInputTokens = payload?.inputTokens
    const payloadOutputTokens = payload?.outputTokens
    const payloadQuantity = payload?.quantity
    const rawPayloadMissingVolume =
      (payloadInputTokens == null || typeof payloadInputTokens !== 'number') &&
      (payloadOutputTokens == null ||
        typeof payloadOutputTokens !== 'number') &&
      (payloadQuantity == null || typeof payloadQuantity !== 'number')

    if (isProcessed && hasUsageCost && rawPayloadMissingVolume) {
      // Matched by "/input" and "/output" suffix: the model half of the key
      // is the raw ingest string and cannot be reconstructed reliably here.
      const costData = mappedEvent.usageCostData
      if (costData && typeof costData === 'object') {
        let filledInput: number | undefined
        let filledOutput: number | undefined
        for (const [key, value] of Object.entries(costData)) {
          if (
            value &&
            typeof value === 'object' &&
            'units' in value &&
            typeof (value as { units: unknown }).units === 'number'
          ) {
            const units = (value as { units: number }).units
            if (units > 0) {
              if (key.endsWith('/input')) filledInput = units
              else if (key.endsWith('/output')) filledOutput = units
            }
          }
        }
        const hasFilledTokens =
          filledInput !== undefined || filledOutput !== undefined
        if (hasFilledTokens) {
          volumeFill = {
            ...(filledInput !== undefined ? { inputTokens: filledInput } : {}),
            ...(filledOutput !== undefined
              ? { outputTokens: filledOutput }
              : {}),
          }
        } else if (mappedEvent.quantity && mappedEvent.quantity > 0) {
          // Non-LLM fill: quantity on the event is the filled value.
          volumeFill = { quantity: mappedEvent.quantity }
        }
      }
    }

    const resolution: SignalEvent['resolution'] =
      modelMapping || volumeFill
        ? {
            ...(modelMapping ? { modelMapping } : {}),
            ...(volumeFill ? { volumeFill } : {}),
            resolvedAt: mappedEvent.eventProcessedAt,
          }
        : null

    return {
      success: true,
      data: { ...mappedEvent, resolution },
    }
  } catch (error) {
    console.error('[getSignalEvent] Error:', error)
    return { success: false, error: 'Failed to fetch signal event' }
  }
}

// ============================================================================
// Needs-cost-backfill queue + model mapping
// ============================================================================

export interface BackfillGroupSample {
  eventId: string
  agentCode: string
  agentName: string
  customerName: string
  customerExternalId: string
  signalName: string | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface BackfillGroup {
  model: string
  provider: string
  count: number
  oldestEventDate: string
  /**
   * Summed over the group's queued events for the dialog's pre-commit check.
   * The guard fires per child on a POSITIVE count against a null rate, so a
   * positive sum here means at least one child will be refused.
   */
  cacheReadTokens: number
  cacheWriteTokens: number
  samples: BackfillGroupSample[]
}

/** Feeds the "Needs attention" drill-down page. */
export async function getNeedsCostBackfillGroups(): Promise<{
  success: boolean
  data?: { groups: BackfillGroup[]; totalEvents: number }
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    // Group on the children, NOT the parent's raw_ingest_events.payload: the
    // payload only carries model/provider for single-service ingests, so
    // grouping on it collapses every multi-service child into one (NULL, NULL)
    // row.
    const groups = await db.$queryRaw<
      {
        model: string
        provider: string
        count: number
        oldestEventDate: Date
        cacheReadTokens: number
        cacheWriteTokens: number
      }[]
    >`
      SELECT
        ses.model              AS "model",
        ses."modelProvider"    AS "provider",
        COUNT(*)::int          AS "count",
        MIN(se."usageDate")    AS "oldestEventDate",
        -- float8, NOT ::int: these sums can exceed int4 and the cast would throw.
        COALESCE(SUM(ses."cacheReadTokens"), 0)::float8  AS "cacheReadTokens",
        COALESCE(SUM(ses."cacheWriteTokens"), 0)::float8 AS "cacheWriteTokens"
      FROM signal_event_services ses
      JOIN signal_events se ON ses."signalEventId" = se.id
      WHERE se."organizationId" = ${orgId}::uuid
        AND ses."eventStatus" = 'NEEDS_COST_BACKFILL'
        AND se."usageDate" <= now()
      GROUP BY ses.model, ses."modelProvider"
      ORDER BY "count" DESC
    `

    const totalEvents = groups.reduce((sum, g) => sum + g.count, 0)

    const groupsWithSamples = await Promise.all(
      groups.map(async (g) => {
        // Token counts come off the child, not the parent payload, which may
        // not carry volume for multi-service events.
        const samples = await db.$queryRaw<BackfillGroupSample[]>`
          SELECT DISTINCT ON (a."agentCode")
            se.id                  AS "eventId",
            a."agentCode"          AS "agentCode",
            a.name                 AS "agentName",
            c.name                 AS "customerName",
            c."externalId"         AS "customerExternalId",
            s.name                 AS "signalName",
            ses."inputTokens"      AS "inputTokens",
            ses."outputTokens"     AS "outputTokens"
          FROM signal_event_services ses
          JOIN signal_events se ON ses."signalEventId" = se.id
          JOIN agents a ON se."agentId" = a.id
          JOIN customers c ON se."customerId" = c.id
          LEFT JOIN signals s ON se."signalId" = s.id
          WHERE se."organizationId" = ${orgId}::uuid
            AND ses."eventStatus" = 'NEEDS_COST_BACKFILL'
            AND se."usageDate" <= now()
            AND ses.model = ${g.model}
            AND ses."modelProvider" = ${g.provider}
          ORDER BY a."agentCode", se."usageDate" DESC
          LIMIT 5
        `
        return {
          ...g,
          oldestEventDate: g.oldestEventDate.toISOString(),
          samples,
        }
      })
    )

    return {
      success: true,
      data: {
        groups: groupsWithSamples,
        totalEvents,
      },
    }
  } catch (error) {
    console.error('[getNeedsCostBackfillGroups] Error:', error)
    return { success: false, error: 'Failed to fetch backfill queue' }
  }
}

/**
 * Maps an unknown model onto a service_pricing row and reprices every matching
 * NEEDS_COST_BACKFILL child, in a single transaction.
 */
export async function mapModelAndBackfill(
  sourceModel: string,
  sourceProvider: string,
  targetPricingId: string
): Promise<{
  success: boolean
  data?: {
    backfilled: number
    /** Children left unpriced because the target row has no rate for a cache direction they used. */
    refused: number
    /** Which rate(s) were missing, for the operator-facing "populate these" hint. */
    refusedRates: string[]
    totalCostUsd: number
    mappingId: string
  }
  error?: string
}> {
  try {
    // BUILD write: which MODEL an event used is operational metering data — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId
    const normalizedModel = sourceModel.trim().toLowerCase()
    const normalizedProvider = sourceProvider.trim().toLowerCase()

    const result = await db.$transaction(async (tx: any) => {
      // targetPricingId is the externalId, not the id: useServicePricing()
      // maps externalId → id for the frontend.
      const target = await tx.service_pricing.findUnique({
        where: { externalId: targetPricingId },
      })
      if (!target) throw new Error('Target pricing row not found')

      // Org-scoped: future events auto-resolve for THIS org only.
      const mapping = await tx.org_model_mappings.upsert({
        where: {
          organizationId_sourceModel_sourceProvider: {
            organizationId: orgId,
            sourceModel: normalizedModel,
            sourceProvider: normalizedProvider,
          },
        },
        create: {
          organizationId: orgId,
          sourceModel: normalizedModel,
          sourceProvider: normalizedProvider,
          targetPricingId: target.id,
        },
        update: {
          targetPricingId: target.id,
        },
      })

      // Case-insensitive: children keep the RAW ingest casing
      // ("WebSearch") while these inputs are normalized lowercase, so an
      // exact match silently skips them.
      // TWIN of api-nest SignalEventsService.mapModel — four things move
      // together: this matcher, the select below, the cache rates on the cost
      // entry, and the conditional cache lines in usageCostData.
      const childrenToBackfill = await tx.signal_event_services.findMany({
        where: {
          eventStatus: 'NEEDS_COST_BACKFILL',
          model: { equals: normalizedModel, mode: 'insensitive' },
          modelProvider: { equals: normalizedProvider, mode: 'insensitive' },
          signal_events: { organizationId: orgId },
        },
        select: {
          id: true,
          signalEventId: true,
          model: true,
          modelProvider: true,
          inputTokens: true,
          outputTokens: true,
          quantity: true,
          // Required by CANON V3: drop these and the recompute re-prices with
          // no cache terms at all and under-bills cache tokens.
          cacheReadTokens: true,
          cacheWriteTokens: true,
          // Parent metadata carries the cache-write TTL hint.
          // Without it a 5m event re-prices at the stored 1-hour ceiling.
          signal_events: { select: { metadata: true } },
        },
      })

      // resolveEventPrice is the guarded entry point every path that writes a
      // billable cost goes through.
      const costEntry = {
        inputCost: target.inputCost ? Number(target.inputCost) : 0,
        outputCost: target.outputCost ? Number(target.outputCost) : 0,
        // Absent rate → undefined, NOT 0. resolveEventPrice reads undefined as
        // "no rate published" and refuses; 0 would price the cache as free.
        cacheReadCost:
          target.cacheReadCost != null
            ? Number(target.cacheReadCost)
            : undefined,
        cacheWriteCost:
          target.cacheWriteCost != null
            ? Number(target.cacheWriteCost)
            : undefined,
        costUnit: target.costUnit,
      }
      let totalCostUsd = 0
      const affectedParentIds = new Set<string>()
      // Reported back so the dialog can say "mapped 8, 2 still need a cache
      // rate" instead of claiming a clean run.
      const refusedChildren: Array<{
        model: string
        missingRates: string[]
      }> = []

      for (const child of childrenToBackfill) {
        const inputTokens = Number(child.inputTokens ?? 0)
        const outputTokens = Number(child.outputTokens ?? 0)
        const quantity = Number(child.quantity ?? 1)
        const cacheReadTokens = Number(child.cacheReadTokens ?? 0)
        const cacheWriteTokens = Number(child.cacheWriteTokens ?? 0)
        const cacheWriteTtl = (
          child.signal_events?.metadata as Record<string, unknown> | null
        )?.cacheWriteTtl

        // Most active "1M tokens" rows carry no cacheWriteCost, so an operator
        // can easily pick one. Rather than write a quietly-low cost and stamp
        // it PROCESSED, resolveEventPrice refuses and the child stays visible
        // in NEEDS_COST_BACKFILL.
        const resolution = resolveEventPrice({
          inputTokens,
          outputTokens,
          quantity,
          entry: costEntry,
          cacheReadTokens,
          cacheWriteTokens,
          provider: child.modelProvider ?? normalizedProvider,
          cacheWriteTtl,
          model: child.model || normalizedModel,
        })
        if (!resolution.ok) {
          refusedChildren.push({
            model: child.model || normalizedModel,
            missingRates: resolution.missingRates,
          })
          continue
        }
        const costResult = resolution.price

        totalCostUsd += costResult.totalCostUsd.toNumber()

        const modelKey = child.model || normalizedModel
        const usageCostData: Record<
          string,
          { cost: number; units: number; costPerUnit: number }
        > = {
          [`${modelKey}/input`]: {
            cost: costResult.inputCostUsd.toNumber(),
            units: inputTokens,
            costPerUnit: costResult.inputCostPerToken,
          },
          [`${modelKey}/output`]: {
            cost: costResult.outputCostUsd.toNumber(),
            units: outputTokens,
            costPerUnit: costResult.outputCostPerToken,
          },
        }
        // != null, not > 0: a stored 0 is a real measurement and keeps its
        // line, while an absent count leaves the shape as ingest wrote it.
        if (child.cacheReadTokens != null) {
          usageCostData[`${modelKey}/cache_read`] = {
            cost: costResult.cacheReadCostUsd.toNumber(),
            units: cacheReadTokens,
            costPerUnit: costResult.cacheReadCostPerToken,
          }
        }
        if (child.cacheWriteTokens != null) {
          usageCostData[`${modelKey}/cache_write`] = {
            cost: costResult.cacheWriteCostUsd.toNumber(),
            units: cacheWriteTokens,
            costPerUnit: costResult.cacheWriteCostPerToken,
          }
        }

        await tx.signal_event_services.update({
          where: { id: child.id },
          data: {
            usageCost: costResult.totalCostUsd,
            usageCostData: usageCostData as any,
            eventStatus: 'PROCESSED',
            servicePricingId: target.id,
          },
        })

        affectedParentIds.add(child.signalEventId)
      }

      // Canon: parent usageCost is null while ANY child is unresolved, and the
      // parent flips PROCESSED only once every child is.
      for (const parentId of affectedParentIds) {
        await recomputeParentUsageCost(parentId, db as any, tx)
      }

      return {
        // Priced children, NOT children considered — a refused child is still
        // unresolved and must not read as backfilled.
        backfilled: childrenToBackfill.length - refusedChildren.length,
        refused: refusedChildren.length,
        refusedRates: [
          ...new Set(refusedChildren.flatMap((c) => c.missingRates)),
        ],
        totalCostUsd,
        mappingId: mapping.id,
      }
    })

    revalidatePath('/metrics-events')
    return { success: true, data: result }
  } catch (error) {
    console.error('[mapModelAndBackfill] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to map model',
    }
  }
}

export async function getServicePricingEntries(): Promise<{
  success: boolean
  data?: Array<{
    id: string
    displayName: string
    provider: string
    serviceType: string
    inputCost: number | null
    outputCost: number | null
    costUnit: string
    contextWindow: number | null
    isApi: boolean
  }>
  error?: string
}> {
  try {
    const entries = await db.service_pricing.findMany({
      where: { isActive: true },
      select: {
        id: true,
        displayName: true,
        provider: true,
        serviceType: true,
        inputCost: true,
        outputCost: true,
        costUnit: true,
        contextWindow: true,
        isApi: true,
      },
      orderBy: [{ provider: 'asc' }, { displayName: 'asc' }],
    })

    return {
      success: true,
      data: entries.map((e) => ({
        ...e,
        inputCost: e.inputCost ? Number(e.inputCost) : null,
        outputCost: e.outputCost ? Number(e.outputCost) : null,
      })),
    }
  } catch (error) {
    console.error('[getServicePricingEntries] Error:', error)
    return { success: false, error: 'Failed to fetch pricing entries' }
  }
}

// ============================================
// MISSING VOLUME DATA — Resolution
// ============================================

export interface MissingVolumeGroupSample {
  eventId: string
  agentCode: string
  agentName: string
  customerName: string
  customerExternalId: string
  signalName: string | null
}

export interface MissingVolumeGroup {
  model: string
  provider: string
  costUnit: string | null
  count: number
  oldestEventDate: string
  samples: MissingVolumeGroupSample[]
}

/** costUnit rides along so the UI knows to prompt for tokens or quantity. */
export async function getMissingVolumeGroups(): Promise<{
  success: boolean
  data?: { groups: MissingVolumeGroup[]; totalEvents: number }
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    // Grouped on the children for the same reason as the needs-cost-backfill
    // query above. costUnit joins off the child's model/provider so the prompt
    // knows whether to ask for tokens (LLM) or quantity (non-LLM).
    const groups = await db.$queryRaw<
      {
        model: string
        provider: string
        costUnit: string | null
        count: number
        oldestEventDate: Date
      }[]
    >`
      SELECT
        ses.model              AS "model",
        ses."modelProvider"    AS "provider",
        sp."costUnit"          AS "costUnit",
        COUNT(*)::int          AS "count",
        MIN(se."usageDate")    AS "oldestEventDate"
      FROM signal_event_services ses
      JOIN signal_events se ON ses."signalEventId" = se.id
      LEFT JOIN service_pricing sp
        ON LOWER(TRIM(sp."canonicalName")) = LOWER(TRIM(ses.model))
        AND LOWER(TRIM(sp.provider)) = LOWER(TRIM(ses."modelProvider"))
        AND sp."isActive" = true
      WHERE se."organizationId" = ${orgId}::uuid
        AND ses."eventStatus" = 'MISSING_VOLUME_DATA'
        AND se."usageDate" <= now()
      GROUP BY ses.model, ses."modelProvider", sp."costUnit"
      ORDER BY "count" DESC
    `

    const totalEvents = groups.reduce((sum, g) => sum + g.count, 0)

    const groupsWithSamples = await Promise.all(
      groups.map(async (g) => {
        const samples = await db.$queryRaw<MissingVolumeGroupSample[]>`
          SELECT DISTINCT ON (a."agentCode")
            se.id                  AS "eventId",
            a."agentCode"          AS "agentCode",
            a.name                 AS "agentName",
            c.name                 AS "customerName",
            c."externalId"         AS "customerExternalId",
            s.name                 AS "signalName"
          FROM signal_event_services ses
          JOIN signal_events se ON ses."signalEventId" = se.id
          JOIN agents a ON se."agentId" = a.id
          JOIN customers c ON se."customerId" = c.id
          LEFT JOIN signals s ON se."signalId" = s.id
          WHERE se."organizationId" = ${orgId}::uuid
            AND ses."eventStatus" = 'MISSING_VOLUME_DATA'
            AND se."usageDate" <= now()
            AND ses.model = ${g.model}
            AND ses."modelProvider" = ${g.provider}
          ORDER BY a."agentCode", se."usageDate" DESC
          LIMIT 5
        `
        return {
          ...g,
          oldestEventDate: g.oldestEventDate.toISOString(),
          samples,
        }
      })
    )

    return {
      success: true,
      data: { groups: groupsWithSamples, totalEvents },
    }
  } catch (error) {
    console.error('[getMissingVolumeGroups] Error:', error)
    return { success: false, error: 'Failed to fetch missing volume queue' }
  }
}

/** The model is already known here; only the volume is missing. */
export async function fillMissingVolume(
  sourceModel: string,
  sourceProvider: string,
  inputTokens?: number,
  outputTokens?: number,
  quantity?: number
): Promise<{
  success: boolean
  data?: {
    backfilled: number
    /** Children left unpriced because the row has no rate for a cache direction they used. */
    refused: number
    /** Which rate(s) were missing, for the operator-facing "populate these" hint. */
    refusedRates: string[]
    totalCostUsd: number
    targetHasPaidRates: boolean
  }
  error?: string
}> {
  try {
    // BUILD write: filling an event's volume is operational metering data — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId
    const normalizedModel = sourceModel.trim().toLowerCase()
    const normalizedProvider = sourceProvider.trim().toLowerCase()

    const result = await db.$transaction(async (tx: any) => {
      const target = await tx.service_pricing.findFirst({
        where: {
          canonicalName: normalizedModel,
          provider: normalizedProvider,
          isActive: true,
        },
      })
      if (!target)
        throw new Error(`Model "${sourceModel}" not found in pricing table`)

      const isLlm = target.costUnit === '1M tokens'
      if (isLlm && (inputTokens == null || outputTokens == null)) {
        throw new Error(`LLM model requires both inputTokens and outputTokens`)
      }
      if (!isLlm && quantity == null) {
        throw new Error(
          `Non-LLM service (costUnit: "${target.costUnit}") requires quantity`
        )
      }

      // Case-insensitive: same silent-miss as the cost-backfill
      // matcher above — children keep the RAW ingest casing.
      const childrenToFill = await tx.signal_event_services.findMany({
        where: {
          eventStatus: 'MISSING_VOLUME_DATA',
          model: { equals: normalizedModel, mode: 'insensitive' },
          modelProvider: { equals: normalizedProvider, mode: 'insensitive' },
          signal_events: { organizationId: orgId },
        },
        select: {
          id: true,
          signalEventId: true,
          model: true,
          modelProvider: true,
          // MISSING_VOLUME_DATA only concerns input/output volume; cache
          // tokens were captured at ingest and must still be priced.
          cacheReadTokens: true,
          cacheWriteTokens: true,
          // Cache-write TTL hint, as in the cost-backfill matcher.
          signal_events: { select: { metadata: true } },
        },
      })

      // The prompt is per-(model, provider) group, not per-event, so ONE
      // caller-supplied volume is written to every matching child. Cache
      // tokens are the exception — per-child, so pricing runs in the loop.
      const costEntry = {
        inputCost: target.inputCost ? Number(target.inputCost) : 0,
        outputCost: target.outputCost ? Number(target.outputCost) : 0,
        cacheReadCost:
          target.cacheReadCost != null
            ? Number(target.cacheReadCost)
            : undefined,
        cacheWriteCost:
          target.cacheWriteCost != null
            ? Number(target.cacheWriteCost)
            : undefined,
        costUnit: target.costUnit,
      }
      let totalCostUsd = 0
      const affectedParentIds = new Set<string>()
      const refusedChildren: Array<{ missingRates: string[] }> = []

      for (const child of childrenToFill) {
        const cacheReadTokens = Number(child.cacheReadTokens ?? 0)
        const cacheWriteTokens = Number(child.cacheWriteTokens ?? 0)
        const cacheWriteTtl = (
          child.signal_events?.metadata as Record<string, unknown> | null
        )?.cacheWriteTtl

        const resolution = resolveEventPrice({
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          quantity: quantity ?? 1,
          entry: costEntry,
          cacheReadTokens,
          cacheWriteTokens,
          provider: child.modelProvider ?? normalizedProvider,
          cacheWriteTtl,
          model: child.model || normalizedModel,
        })
        if (!resolution.ok) {
          refusedChildren.push({ missingRates: resolution.missingRates })
          continue
        }
        const costResult = resolution.price

        totalCostUsd += costResult.totalCostUsd.toNumber()

        const modelKey = child.model || normalizedModel
        const usageCostData: Record<
          string,
          { cost: number; units: number; costPerUnit: number }
        > = {
          [`${modelKey}/input`]: {
            cost: costResult.inputCostUsd.toNumber(),
            units: inputTokens ?? 0,
            costPerUnit: costResult.inputCostPerToken,
          },
          [`${modelKey}/output`]: {
            cost: costResult.outputCostUsd.toNumber(),
            units: outputTokens ?? 0,
            costPerUnit: costResult.outputCostPerToken,
          },
        }
        // != null, not > 0: a stored 0 is a real measurement and keeps its line.
        if (child.cacheReadTokens != null) {
          usageCostData[`${modelKey}/cache_read`] = {
            cost: costResult.cacheReadCostUsd.toNumber(),
            units: cacheReadTokens,
            costPerUnit: costResult.cacheReadCostPerToken,
          }
        }
        if (child.cacheWriteTokens != null) {
          usageCostData[`${modelKey}/cache_write`] = {
            cost: costResult.cacheWriteCostUsd.toNumber(),
            units: cacheWriteTokens,
            costPerUnit: costResult.cacheWriteCostPerToken,
          }
        }

        await tx.signal_event_services.update({
          where: { id: child.id },
          data: {
            inputTokens: inputTokens ?? null,
            outputTokens: outputTokens ?? null,
            quantity: quantity ?? null,
            usageCost: costResult.totalCostUsd,
            usageCostData: usageCostData as any,
            eventStatus: 'PROCESSED',
            servicePricingId: target.id,
          },
        })

        affectedParentIds.add(child.signalEventId)
      }

      // Canon: parent usageCost is null while ANY child is unresolved, and the
      // parent flips PROCESSED only once every child is.
      for (const parentId of affectedParentIds) {
        await recomputeParentUsageCost(parentId, db as any, tx)
      }

      return {
        // Priced children, NOT children considered — a refused child is still
        // unresolved and must not read as filled.
        backfilled: childrenToFill.length - refusedChildren.length,
        refused: refusedChildren.length,
        refusedRates: [
          ...new Set(refusedChildren.flatMap((c) => c.missingRates)),
        ],
        totalCostUsd,
        // This dialog has no pricing picker to read rates from, unlike
        // map-model, so the flag has to ride back on the result.
        targetHasPaidRates: costEntry.inputCost > 0 || costEntry.outputCost > 0,
      }
    })

    revalidatePath('/metrics-events')
    return { success: true, data: result }
  } catch (error) {
    console.error('[fillMissingVolume] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fill volume data',
    }
  }
}
