'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// An agent is the metering plumbing (which model it runs on, what it
// meters) — a BUILD/operations record, not the books. Creating, editing, or deleting one
// is owner/admin-only. The role is checked in the caller's active org, the same org
// these actions write to.
import { assertBuildManager } from './_shared/assert-build-manager'

// Types
export interface Agent {
  id: string
  name: string
  description: string
  agentCode: string
  orgId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  activeSubscriptionsCount?: number
  signalsCount?: number
  activePlansCount?: number
}

export interface CreateAgentPayload {
  name: string
  description: string
  agentCode: string
  isActive?: boolean
}

export interface UpdateAgentPayload {
  name?: string
  description?: string
  agentCode?: string
  isActive?: boolean
}

export interface AgentsResponse {
  results: Agent[]
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface GetAgentsParams {
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  isActive?: boolean
  search?: string
}

/**
 * Get agents with pagination and filtering
 */
export async function getAgents(params: GetAgentsParams = {}): Promise<{
  success: boolean
  data?: AgentsResponse
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
      limit = 10,
      page = 1,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      isActive,
      search,
    } = params

    // Build where clause
    const where: Prisma.agentsWhereInput = {
      orgId,
      deletedAt: null,
    }

    if (isActive !== undefined) {
      where.isActive = isActive
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { agentCode: { contains: search, mode: 'insensitive' } },
      ]
    }

    // Get total count
    const total = await db.agents.count({ where })

    // Get agents with related counts
    const agents = await db.agents.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        _count: {
          select: {
            subscriptions: {
              where: { status: 'active', deletedAt: null },
            },
            signals: {
              where: { deletedAt: null },
            },
            // Count linked plans via the junction table, not the unused pricing_plans.agentId FK
            agent_pricing_plans: {
              where: { pricing_plans: { isActive: true, deletedAt: null } },
            },
          },
        },
      },
    })

    const results: Agent[] = agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description || '',
      agentCode: a.agentCode,
      orgId: a.orgId,
      isActive: a.isActive ?? true,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      deletedAt: a.deletedAt?.toISOString() ?? null,
      activeSubscriptionsCount: a._count.subscriptions,
      signalsCount: a._count.signals,
      activePlansCount: a._count.agent_pricing_plans,
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
    console.error('[getAgents] Error:', error)
    return { success: false, error: 'Failed to fetch agents' }
  }
}

/**
 * Get a single agent by ID
 */
export async function getAgent(agentId: string): Promise<{
  success: boolean
  data?: Agent
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

    const agent = await db.agents.findFirst({
      where: {
        id: agentId,
        orgId,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            subscriptions: {
              where: { status: 'active', deletedAt: null },
            },
            signals: {
              where: { deletedAt: null },
            },
            agent_pricing_plans: {
              where: { pricing_plans: { isActive: true, deletedAt: null } },
            },
          },
        },
      },
    })

    if (!agent) {
      return { success: false, error: 'Agent not found' }
    }

    return {
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        agentCode: agent.agentCode,
        orgId: agent.orgId,
        isActive: agent.isActive ?? true,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        deletedAt: agent.deletedAt?.toISOString() ?? null,
        activeSubscriptionsCount: agent._count.subscriptions,
        signalsCount: agent._count.signals,
        activePlansCount: agent._count.agent_pricing_plans,
      },
    }
  } catch (error) {
    console.error('[getAgent] Error:', error)
    return { success: false, error: 'Failed to fetch agent' }
  }
}

/**
 * Create a new agent
 */
export async function createAgent(data: CreateAgentPayload): Promise<{
  success: boolean
  data?: Agent
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may create an agent.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Check if agent code already exists
    const existing = await db.agents.findFirst({
      where: {
        orgId,
        agentCode: data.agentCode,
        deletedAt: null,
      },
    })

    if (existing) {
      return { success: false, error: 'Agent code already exists' }
    }

    const agent = await db.agents.create({
      data: {
        id: crypto.randomUUID(),
        orgId,
        name: data.name,
        description: data.description,
        agentCode: data.agentCode,
        isActive: data.isActive ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    return {
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        agentCode: agent.agentCode,
        orgId: agent.orgId,
        isActive: agent.isActive ?? true,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        deletedAt: null,
      },
    }
  } catch (error) {
    console.error('[createAgent] Error:', error)
    return { success: false, error: 'Failed to create agent' }
  }
}

/**
 * Update an agent
 */
export async function updateAgent(
  agentId: string,
  data: UpdateAgentPayload
): Promise<{
  success: boolean
  data?: Agent
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may edit an agent.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify agent belongs to org
    const existing = await db.agents.findFirst({
      where: {
        id: agentId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Agent not found' }
    }

    // Check for duplicate agent code if being changed
    if (data.agentCode && data.agentCode !== existing.agentCode) {
      const duplicate = await db.agents.findFirst({
        where: {
          orgId,
          agentCode: data.agentCode,
          deletedAt: null,
          id: { not: agentId },
        },
      })

      if (duplicate) {
        return { success: false, error: 'Agent code already exists' }
      }
    }

    const agent = await db.agents.update({
      where: { id: agentId },
      data: {
        name: data.name,
        description: data.description,
        agentCode: data.agentCode,
        isActive: data.isActive,
      },
    })

    revalidatePath('/build')

    return {
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        agentCode: agent.agentCode,
        orgId: agent.orgId,
        isActive: agent.isActive ?? true,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        deletedAt: agent.deletedAt?.toISOString() ?? null,
      },
    }
  } catch (error) {
    console.error('[updateAgent] Error:', error)
    return { success: false, error: 'Failed to update agent' }
  }
}

/**
 * Delete an agent (soft delete)
 */
export async function deleteAgent(agentId: string): Promise<{
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

    // BUILD write: only owner/admin may delete an agent.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify agent belongs to org
    const existing = await db.agents.findFirst({
      where: {
        id: agentId,
        orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Agent not found' }
    }

    // Soft delete
    await db.agents.update({
      where: { id: agentId },
      data: { deletedAt: new Date() },
    })

    return { success: true }
  } catch (error) {
    console.error('[deleteAgent] Error:', error)
    return { success: false, error: 'Failed to delete agent' }
  }
}
