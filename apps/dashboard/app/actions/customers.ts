'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Creating, editing, or deleting a customer is a BUILD/operations
// write (the customer record is part of the metering plumbing, not the books). Only
// owner/admin may. The role is checked in the caller's active org, the same org these
// actions write to.
import { assertBuildManager } from './_shared/assert-build-manager'

export interface Customer {
  id: string
  externalId: string | null
  organizationId: string
  name: string
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  country: string | null
  billingContactName: string | null
  billingContactEmail: string | null
  status: string
  metadata: Record<string, unknown> | null
  invoiceEmailRecipients: string[] | null
  netTerms: number | null
  timezone: string | null
  createdAt: string
  updatedAt: string
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

export interface PaginatedResponse<T> {
  results: T[]
  total: number
  totalResults: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateCustomerPayload {
  externalId?: string
  name: string
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
  metadata?: Record<string, unknown>
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
  metadata?: Record<string, unknown>
  status?: string
  // Flips a record between real customer and internal seat. Live
  // flag: the internal/external cost split re-buckets ALL history on a flip;
  // revenue/MRR/invoice math never reads it.
  isInternal?: boolean
}

export async function getCustomers(params: CustomerQueryParams = {}): Promise<{
  success: boolean
  data?: PaginatedResponse<Customer>
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
      name,
      email,
      searchTerm,
      search,
    } = params

    const where: Prisma.customersWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    }

    const searchQuery = searchTerm || search || name
    if (searchQuery) {
      where.OR = [
        { name: { contains: searchQuery, mode: 'insensitive' } },
        { email: { contains: searchQuery, mode: 'insensitive' } },
        { externalId: { contains: searchQuery, mode: 'insensitive' } },
      ]
    }

    if (email && !searchQuery) {
      where.email = { contains: email, mode: 'insensitive' }
    }

    const total = await db.customers.count({ where })

    const customers = await db.customers.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    })

    const results: Customer[] = customers.map((c) => ({
      id: c.id,
      externalId: c.externalId,
      organizationId: c.organizationId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      addressLine1: c.addressLine1,
      addressLine2: c.addressLine2,
      city: c.city,
      state: c.state,
      zipCode: c.zipCode,
      country: c.country,
      billingContactName: c.billingContactName,
      billingContactEmail: c.billingContactEmail,
      status: c.status || 'active',
      metadata: c.metadata as Record<string, unknown> | null,
      invoiceEmailRecipients: c.invoiceEmailRecipients,
      netTerms: c.netTerms,
      timezone: c.timezone,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))

    return {
      success: true,
      data: {
        results,
        total,
        totalResults: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    }
  } catch (error) {
    console.error('[getCustomers] Error:', error)
    return { success: false, error: 'Failed to fetch customers' }
  }
}

export async function getCustomer(customerId: string): Promise<{
  success: boolean
  data?: Customer
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

    const customer = await db.customers.findFirst({
      where: {
        id: customerId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!customer) {
      return { success: false, error: 'Customer not found' }
    }

    return {
      success: true,
      data: {
        id: customer.id,
        externalId: customer.externalId,
        organizationId: customer.organizationId,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        addressLine1: customer.addressLine1,
        addressLine2: customer.addressLine2,
        city: customer.city,
        state: customer.state,
        zipCode: customer.zipCode,
        country: customer.country,
        billingContactName: customer.billingContactName,
        billingContactEmail: customer.billingContactEmail,
        status: customer.status || 'active',
        metadata: customer.metadata as Record<string, unknown> | null,
        invoiceEmailRecipients: customer.invoiceEmailRecipients,
        netTerms: customer.netTerms,
        timezone: customer.timezone,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      },
    }
  } catch (error) {
    console.error('[getCustomer] Error:', error)
    return { success: false, error: 'Failed to fetch customer' }
  }
}

export async function createCustomer(data: CreateCustomerPayload): Promise<{
  success: boolean
  data?: Customer
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may create a customer.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    const customer = await db.customers.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: orgId,
        name: data.name,
        email: data.email || null,
        externalId: data.externalId || null,
        phone: data.phone || null,
        addressLine1: data.addressLine1 || null,
        addressLine2: data.addressLine2 || null,
        city: data.city || null,
        state: data.state || null,
        zipCode: data.zipCode || null,
        country: data.country || null,
        billingContactName: data.billingContactName || null,
        billingContactEmail: data.billingContactEmail || null,
        metadata: data.metadata as Prisma.InputJsonValue,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    revalidatePath('/customers')

    return {
      success: true,
      data: {
        id: customer.id,
        externalId: customer.externalId,
        organizationId: customer.organizationId,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        addressLine1: customer.addressLine1,
        addressLine2: customer.addressLine2,
        city: customer.city,
        state: customer.state,
        zipCode: customer.zipCode,
        country: customer.country,
        billingContactName: customer.billingContactName,
        billingContactEmail: customer.billingContactEmail,
        status: customer.status || 'active',
        metadata: customer.metadata as Record<string, unknown> | null,
        invoiceEmailRecipients: customer.invoiceEmailRecipients,
        netTerms: customer.netTerms,
        timezone: customer.timezone,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      },
    }
  } catch (error) {
    console.error('[createCustomer] Error:', error)
    return { success: false, error: 'Failed to create customer' }
  }
}

export async function updateCustomer(
  customerId: string,
  data: UpdateCustomerPayload
): Promise<{
  success: boolean
  data?: Customer
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // BUILD write: only owner/admin may edit a customer.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify customer belongs to org
    const existing = await db.customers.findFirst({
      where: {
        id: customerId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Customer not found' }
    }

    const customer = await db.customers.update({
      where: { id: customerId },
      data: {
        name: data.name,
        // An empty email means "clear it" — store null, never "" — so contact
        // info can be un-set instead of one-way-ratcheted once set. An absent
        // key (undefined) still skips the column, leaving it unchanged.
        email: data.email !== undefined ? data.email || null : undefined,
        externalId: data.externalId,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        country: data.country,
        billingContactName: data.billingContactName,
        billingContactEmail: data.billingContactEmail,
        metadata: data.metadata as Prisma.InputJsonValue,
        status: data.status as 'active' | 'inactive' | 'suspended' | undefined,
        isInternal: data.isInternal,
        updatedAt: new Date(),
      },
    })

    revalidatePath('/customers')
    revalidatePath(`/customers/${customerId}`)

    return {
      success: true,
      data: {
        id: customer.id,
        externalId: customer.externalId,
        organizationId: customer.organizationId,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        addressLine1: customer.addressLine1,
        addressLine2: customer.addressLine2,
        city: customer.city,
        state: customer.state,
        zipCode: customer.zipCode,
        country: customer.country,
        billingContactName: customer.billingContactName,
        billingContactEmail: customer.billingContactEmail,
        status: customer.status || 'active',
        metadata: customer.metadata as Record<string, unknown> | null,
        invoiceEmailRecipients: customer.invoiceEmailRecipients,
        netTerms: customer.netTerms,
        timezone: customer.timezone,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      },
    }
  } catch (error) {
    console.error('[updateCustomer] Error:', error)
    return { success: false, error: 'Failed to update customer' }
  }
}

/**
 * Delete a customer (soft delete)
 */
export async function deleteCustomer(customerId: string): Promise<{
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

    // BUILD write: only owner/admin may delete a customer.
    //
    // CASCADE WARNING: the customer -> invoices and customer -> subscriptions FKs are
    // onDelete: Cascade (packages/db/prisma/schema.prisma). A HARD row delete of a
    // customer would therefore destroy that customer's invoices and subscriptions —
    // the BOOKS — along with its events and portal sessions. That destructive reach is
    // exactly why deletion is owner/admin-gated. This path is a SOFT delete (sets
    // deletedAt) so the cascade is latent, but the gate guards against a switch to a
    // hard delete. Nothing blocks deletion of a customer that has invoices.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify customer belongs to org
    const existing = await db.customers.findFirst({
      where: {
        id: customerId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existing) {
      return { success: false, error: 'Customer not found' }
    }

    await db.customers.update({
      where: { id: customerId },
      data: { deletedAt: new Date() },
    })

    revalidatePath('/customers')

    return { success: true }
  } catch (error) {
    console.error('[deleteCustomer] Error:', error)
    return { success: false, error: 'Failed to delete customer' }
  }
}
