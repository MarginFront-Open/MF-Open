'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// A signal IS a meter definition — the metering plumbing that PRODUCES
// a cost. Defining, editing, bulk-upserting, or deleting one is a BUILD/operations write,
// owner/admin-only. (The signal's accounting cost-CLASSIFICATION stays a MONEY write in
// signal-classification.ts — that assigns a COGS/R&D category, which is a numbers decision.)
// The role is checked in the caller's active org, the same org these actions write to.
import { assertBuildManager } from './_shared/assert-build-manager'

// Types
export interface Signal {
  id: string
  name: string
  shortName: string | null
  type: 'volume' | 'usage' | null
  agentId: string
  orgId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  agent?: {
    id: string
    name: string
    agentCode: string
  }
}

export interface CreateSignalPayload {
  name: string
  shortName?: string
  type?: 'volume' | 'usage'
  agentId: string
}

export interface UpdateSignalPayload {
  name?: string
  shortName?: string
  type?: 'volume' | 'usage'
}

export interface BulkSignalRequest {
  id?: string
  name: string
  shortName?: string
  type?: 'volume' | 'usage'
  agentId: string
  isNew: boolean
}

export interface SignalsResponse {
  results: Signal[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface GetSignalsParams {
  page?: number
  limit?: number
  agentId?: string
  search?: string
}

// Helper function to generate shortName from signal name
const generateShortName = (name: string): string => {
  return name.toLowerCase().replace(/\s+/g, '_')
}

/**
 * Get signals with pagination and filtering
 */
export async function getSignals(params: GetSignalsParams = {}): Promise<{
  success: boolean
  data?: SignalsResponse
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
    const { limit = 10, page = 1, agentId, search } = params

    // Build where clause
    const where: Prisma.signalsWhereInput = {
      orgId,
      deletedAt: null,
    }

    if (agentId) {
      where.agentId = agentId
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { shortName: { contains: search, mode: 'insensitive' } },
      ]
    }

    // Get total count
    const total = await db.signals.count({ where })

    // Get signals with agent info
    const signals = await db.signals.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        agents: {
          select: { id: true, name: true, agentCode: true },
        },
      },
    })

    const results: Signal[] = signals.map((s) => ({
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      type: s.type as 'volume' | 'usage' | null,
      agentId: s.agentId,
      orgId: s.orgId,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      deletedAt: s.deletedAt?.toISOString() ?? null,
      agent: s.agents
        ? {
            id: s.agents.id,
            name: s.agents.name,
            agentCode: s.agents.agentCode,
          }
        : undefined,
    }))

    return {
      success: true,
      data: {
        results,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        totalResults: total,
      },
    }
  } catch (error) {
    console.error('[getSignals] Error:', error)
    return { success: false, error: 'Failed to fetch signals' }
  }
}

/**
 * Get signals for a specific agent
 */
export async function getAgentSignals(agentId: string): Promise<{
  success: boolean
  data?: SignalsResponse
  error?: string
}> {
  return getSignals({ agentId, limit: 100, page: 1 })
}

/**
 * Get a single signal by ID
 */
export async function getSignal(signalId: string): Promise<{
  success: boolean
  data?: Signal
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

    const signal = await db.signals.findFirst({
      where: {
        id: signalId,
        orgId,
        deletedAt: null,
      },
      include: {
        agents: {
          select: { id: true, name: true, agentCode: true },
        },
      },
    })

    if (!signal) {
      return { success: false, error: 'Signal not found' }
    }

    return {
      success: true,
      data: {
        id: signal.id,
        name: signal.name,
        shortName: signal.shortName,
        type: signal.type as 'volume' | 'usage' | null,
        agentId: signal.agentId,
        orgId: signal.orgId,
        createdAt: signal.createdAt.toISOString(),
        updatedAt: signal.updatedAt.toISOString(),
        deletedAt: signal.deletedAt?.toISOString() ?? null,
        agent: signal.agents
          ? {
              id: signal.agents.id,
              name: signal.agents.name,
              agentCode: signal.agents.agentCode,
            }
          : undefined,
      },
    }
  } catch (error) {
    console.error('[getSignal] Error:', error)
    return { success: false, error: 'Failed to fetch signal' }
  }
}

/**
 * Create a new signal
 */
export async function createSignal(data: CreateSignalPayload): Promise<{
  success: boolean
  data?: Signal
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may create a meter (signal).
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify agent belongs to org
    const agent = await db.agents.findFirst({
      where: {
        id: data.agentId,
        orgId,
        deletedAt: null,
      },
    })

    if (!agent) {
      return { success: false, error: 'Agent not found' }
    }

    const signal = await db.signals.create({
      data: {
        id: crypto.randomUUID(),
        orgId,
        agentId: data.agentId,
        name: data.name,
        shortName: data.shortName || generateShortName(data.name),
        type: data.type || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    // Fetch agent info separately
    const agentInfo = await db.agents.findUnique({
      where: { id: data.agentId },
      select: { id: true, name: true, agentCode: true },
    })

    revalidatePath('/signals')
    revalidatePath(`/agents/${data.agentId}`)

    return {
      success: true,
      data: {
        id: signal.id,
        name: signal.name,
        shortName: signal.shortName,
        type: signal.type as 'volume' | 'usage' | null,
        agentId: signal.agentId,
        orgId: signal.orgId,
        createdAt: signal.createdAt.toISOString(),
        updatedAt: signal.updatedAt.toISOString(),
        deletedAt: null,
        agent: agentInfo
          ? {
              id: agentInfo.id,
              name: agentInfo.name,
              agentCode: agentInfo.agentCode,
            }
          : undefined,
      },
    }
  } catch (error) {
    console.error('[createSignal] Error:', error)
    return { success: false, error: 'Failed to create signal' }
  }
}

/**
 * Update a signal
 */
export async function updateSignal(
  signalId: string,
  data: UpdateSignalPayload
): Promise<{
  success: boolean
  data?: Signal
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may edit a meter (signal).
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify signal belongs to org
    const existing = await db.signals.findFirst({
      where: {
        id: signalId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Signal not found' }
    }

    const signal = await db.signals.update({
      where: { id: signalId },
      data: {
        name: data.name,
        shortName:
          data.shortName ||
          (data.name ? generateShortName(data.name) : undefined),
        type: data.type,
      },
      include: {
        agents: {
          select: { id: true, name: true, agentCode: true },
        },
      },
    })

    revalidatePath('/signals')
    revalidatePath(`/signals/${signalId}`)

    return {
      success: true,
      data: {
        id: signal.id,
        name: signal.name,
        shortName: signal.shortName,
        type: signal.type as 'volume' | 'usage' | null,
        agentId: signal.agentId,
        orgId: signal.orgId,
        createdAt: signal.createdAt.toISOString(),
        updatedAt: signal.updatedAt.toISOString(),
        deletedAt: signal.deletedAt?.toISOString() ?? null,
        agent: signal.agents
          ? {
              id: signal.agents.id,
              name: signal.agents.name,
              agentCode: signal.agents.agentCode,
            }
          : undefined,
      },
    }
  } catch (error) {
    console.error('[updateSignal] Error:', error)
    return { success: false, error: 'Failed to update signal' }
  }
}

/**
 * Bulk create or update signals
 */
export async function bulkUpsertSignals(signals: BulkSignalRequest[]): Promise<{
  success: boolean
  data?: Signal[]
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may bulk-define meters (signals).
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId
    const results: Signal[] = []

    // Pre-fetch agent info for all unique agent IDs
    const agentIds = [...new Set(signals.map((s) => s.agentId))]
    const agents = await db.agents.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true, agentCode: true },
    })
    const agentMap = new Map(agents.map((a) => [a.id, a]))

    for (const signalData of signals) {
      if (signalData.isNew || !signalData.id) {
        // Create new signal
        const signal = await db.signals.create({
          data: {
            id: crypto.randomUUID(),
            orgId,
            agentId: signalData.agentId,
            name: signalData.name,
            shortName:
              signalData.shortName || generateShortName(signalData.name),
            type: signalData.type || null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
        const agentInfo = agentMap.get(signalData.agentId)
        results.push({
          id: signal.id,
          name: signal.name,
          shortName: signal.shortName,
          type: signal.type as 'volume' | 'usage' | null,
          agentId: signal.agentId,
          orgId: signal.orgId,
          createdAt: signal.createdAt.toISOString(),
          updatedAt: signal.updatedAt.toISOString(),
          deletedAt: null,
          agent: agentInfo
            ? {
                id: agentInfo.id,
                name: agentInfo.name,
                agentCode: agentInfo.agentCode,
              }
            : undefined,
        })
      } else {
        // Update existing signal
        const signal = await db.signals.update({
          where: { id: signalData.id },
          data: {
            name: signalData.name,
            shortName:
              signalData.shortName || generateShortName(signalData.name),
            updatedAt: new Date(),
          },
        })
        const agentInfo = agentMap.get(signal.agentId)
        results.push({
          id: signal.id,
          name: signal.name,
          shortName: signal.shortName,
          type: signal.type as 'volume' | 'usage' | null,
          agentId: signal.agentId,
          orgId: signal.orgId,
          createdAt: signal.createdAt.toISOString(),
          updatedAt: signal.updatedAt.toISOString(),
          deletedAt: signal.deletedAt?.toISOString() ?? null,
          agent: agentInfo
            ? {
                id: agentInfo.id,
                name: agentInfo.name,
                agentCode: agentInfo.agentCode,
              }
            : undefined,
        })
      }
    }

    revalidatePath('/signals')

    return { success: true, data: results }
  } catch (error) {
    console.error('[bulkUpsertSignals] Error:', error)
    return { success: false, error: 'Failed to bulk upsert signals' }
  }
}

/**
 * Delete a signal (soft delete)
 */
export async function deleteSignal(signalId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may delete a meter (signal).
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify signal belongs to org
    const existing = await db.signals.findFirst({
      where: {
        id: signalId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Signal not found' }
    }

    // Soft delete
    await db.signals.update({
      where: { id: signalId },
      data: { deletedAt: new Date() },
    })

    revalidatePath('/signals')

    return { success: true }
  } catch (error) {
    console.error('[deleteSignal] Error:', error)
    return { success: false, error: 'Failed to delete signal' }
  }
}
