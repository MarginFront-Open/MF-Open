/**
 * Customers Service
 * Handles all customer-related API operations with React Query integration
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCustomers as getCustomersAction,
  getCustomer as getCustomerAction,
  createCustomer as createCustomerAction,
  updateCustomer as updateCustomerAction,
  deleteCustomer as deleteCustomerAction,
  type Customer,
  type CreateCustomerPayload as CreatePayload,
  type UpdateCustomerPayload as UpdatePayload,
} from '@/app/actions/customers'
import { getOrgId as getOrgIdFromClient } from '@/lib/api/client'
import { analyticsKeys } from './analytics-service'
import { FILTERS_KEYS } from './filters-service'
import { useToast } from '@/hooks/use-toast'
import request, { formatUrl } from './api-request'

// Query Keys
export const CUSTOMERS_KEYS = {
  all: ['customers'] as const,
  lists: () => [...CUSTOMERS_KEYS.all, 'list'] as const,
  list: (filters: CustomerQueryParams) =>
    [...CUSTOMERS_KEYS.lists(), filters] as const,
  details: () => [...CUSTOMERS_KEYS.all, 'detail'] as const,
  detail: (id: string) => [...CUSTOMERS_KEYS.details(), id] as const,
}

// Types - Re-export from action for consistency
export type { Customer } from '@/app/actions/customers'

export interface CreateCustomerPayload {
  externalId?: string
  name: string
  email: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  zipCode?: string
  country?: string
  billingContactName?: string
  billingContactEmail?: string
  metadata?: {
    industry?: string
    size?: string
    region?: string
    [key: string]: any
  }
}

export interface UpdateCustomerPayload {
  externalId?: string
  name?: string
  email?: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  zipCode?: string
  country?: string
  billingContactName?: string
  billingContactEmail?: string
  metadata?: {
    industry?: string
    size?: string
    region?: string
    [key: string]: any
  }
}

export interface PaginatedResponse<T> {
  results: T[]
  total: number
  page: number
  limit: number
  totalPages: number
  totalResults?: number
  currentPage?: number
}

export interface CustomerQueryParams {
  limit?: number
  page?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  name?: string
  email?: string
  searchTerm?: string
  search?: string
}

// Helper function to get organization ID (async via Better Auth)
const getOrgId = async (): Promise<string> => {
  const orgId = await getOrgIdFromClient()

  if (!orgId) {
    throw new Error('No organization found')
  }

  return orgId
}

/**
 * API functions for direct calls (without React Query)
 */
export const customersApi = {
  // Get all customers
  getCustomers: async (
    params?: CustomerQueryParams
  ): Promise<PaginatedResponse<Customer>> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/customers`, {})
    return request.get(url, { params })
  },

  // Get customer by ID
  getCustomer: async (customerId: string): Promise<Customer> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/customers/${customerId}`, {})
    return request.get(url)
  },

  // Get customer by ID (using provided organization ID)
  getCustomerById: async (
    organizationId: string,
    customerId: string
  ): Promise<Customer> => {
    if (!organizationId) throw new Error('Organization ID is required')
    if (!customerId) throw new Error('Customer ID is required')

    const url = formatUrl(`/org/${organizationId}/customers/${customerId}`, {})
    return request.get(url)
  },

  // Create a New Account
  createCustomer: async (
    customerData: CreateCustomerPayload
  ): Promise<Customer> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/customers`, {})
    return request.post(url, customerData)
  },

  // Update customer
  updateCustomer: async (
    customerId: string,
    customerData: UpdateCustomerPayload
  ): Promise<Customer> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/customers/${customerId}`, {})
    return request.patch(url, customerData)
  },

  // Delete customer
  deleteCustomer: async (customerId: string): Promise<void> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(`/org/${orgId}/customers/${customerId}`, {})
    return request.delete(url)
  },
}

/**
 * React Query Hooks
 */

/**
 * Hook to fetch customers with pagination and filters via Server Action
 */
export const useCustomers = (params: CustomerQueryParams = {}) => {
  return useQuery({
    queryKey: CUSTOMERS_KEYS.list(params),
    queryFn: async () => {
      const result = await getCustomersAction(params)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch customers')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook to fetch a single customer by ID via Server Action
 */
export const useCustomer = (customerId: string) => {
  return useQuery({
    queryKey: CUSTOMERS_KEYS.detail(customerId),
    queryFn: async () => {
      const result = await getCustomerAction(customerId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch customer')
      }
      return result.data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!customerId,
  })
}

/**
 * Hook to fetch a customer by organization ID and customer ID
 * Uses React Query's useQuery for state management and caching
 */
export const useCustomerById = (organizationId: string, customerId: string) => {
  return useQuery({
    queryKey: [...CUSTOMERS_KEYS.detail(customerId), organizationId],
    queryFn: () => customersApi.getCustomerById(organizationId, customerId),
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!organizationId && !!customerId,
  })
}

/**
 * Hook to create a new customer via Server Action
 */
export const useCreateCustomer = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: CreateCustomerPayload) => {
      const result = await createCustomerAction(data as CreatePayload)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create customer')
      }
      return result.data
    },
    onSuccess: () => {
      toast({
        title: 'Customer created',
        description: 'Customer has been created successfully',
      })
      queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEYS.lists() })
      // New customer affects customer-analytics charts and dropdowns
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error creating customer',
        description: error.message || 'Failed to create customer',
      })
    },
  })
}

/**
 * Hook to update a customer via Server Action
 */
export const useUpdateCustomer = (customerId: string) => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: UpdateCustomerPayload) => {
      const result = await updateCustomerAction(
        customerId,
        data as UpdatePayload
      )
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update customer')
      }
      return result.data
    },
    onSuccess: (updatedCustomer) => {
      toast({
        title: 'Customer updated',
        description: 'Customer has been updated successfully',
      })
      queryClient.setQueryData(
        CUSTOMERS_KEYS.detail(customerId),
        updatedCustomer
      )
      queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEYS.lists() })
      // Customer edits feed customer-analytics rollups
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error updating customer',
        description: error.message || 'Failed to update customer',
      })
    },
  })
}

/**
 * Hook to delete a customer via Server Action
 */
export const useDeleteCustomer = () => {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (customerId: string) => {
      const result = await deleteCustomerAction(customerId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete customer')
      }
      return customerId
    },
    onSuccess: (customerId) => {
      toast({
        title: 'Customer deleted',
        description: 'Customer has been deleted successfully',
      })
      queryClient.removeQueries({ queryKey: CUSTOMERS_KEYS.detail(customerId) })
      queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEYS.lists() })
      // Removed customer drops out of analytics rollups and dropdowns
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
      queryClient.invalidateQueries({ queryKey: FILTERS_KEYS.all })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error deleting customer',
        description: error.message || 'Failed to delete customer',
      })
    },
  })
}
