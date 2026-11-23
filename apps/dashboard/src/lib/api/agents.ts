// @ts-nocheck
// Deprecated: use Server Actions for new code.
import { API_ENDPOINTS } from '@/lib/api/config'
import apiClient from './client'
import { formatUrl, getOrgId } from './client'

// Agent types
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
}

export interface CreateAgentPayload {
  name: string
  description: string
  agentCode: string
  isActive: boolean
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

// Agents API functions
export const agentsApi = {
  // Get list of agents
  getAgents: async (params: GetAgentsParams = {}): Promise<AgentsResponse> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.AGENTS.BASE, { orgId })

    const response = await apiClient.get(url, { params })
    return response.data
  },

  // Get single agent by ID
  getAgent: async (agentId: string): Promise<Agent> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.AGENTS.DETAIL, { orgId, agentId })

    const response = await apiClient.get(url)
    return response.data
  },

  // Create a new agent
  createAgent: async (payload: CreateAgentPayload): Promise<Agent> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.AGENTS.BASE, { orgId })

    const response = await apiClient.post(url, payload)
    return response.data
  },

  // Update an agent
  updateAgent: async (
    agentId: string,
    payload: Partial<CreateAgentPayload>
  ): Promise<Agent> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.AGENTS.DETAIL, { orgId, agentId })

    const response = await apiClient.patch(url, payload)
    return response.data
  },

  // Delete an agent
  deleteAgent: async (agentId: string): Promise<void> => {
    const orgId = await getOrgId()
    const url = formatUrl(API_ENDPOINTS.AGENTS.DETAIL, { orgId, agentId })

    await apiClient.delete(url)
  },
}
