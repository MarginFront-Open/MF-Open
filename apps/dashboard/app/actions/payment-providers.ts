// @ts-nocheck
'use server'
// TypeScript checking is off: some queries here use field names that differ
// from the generated Prisma types.

/**
 * Payment Providers Server Actions
 * Server-side actions for managing payment provider configurations
 *
 * Note: Operations involving API secrets (connect) should use the NestJS API
 * because they require proper encryption and potentially OAuth flows.
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
import { API_BASE_URL } from '@/lib/api/config'
// Payout connectors are revenue-routing, so they are owner/admin only (the ORG_MANAGE
// gate), not the build gate. Two write actions here (updatePaymentProvider and the
// own-keys branch of disconnect) talk to the database directly instead of going through
// the API, so the API's role gate does not cover them. They need their own gate here.
import { assertOrgManager } from './_shared/assert-org-manager'

// Types
export type PaymentProviderType = 'stripe'

export interface PaymentProvider {
  id: string
  organizationId: string
  type: PaymentProviderType
  code: string
  name: string
  isDefault: boolean
  isActive: boolean
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface UpdatePaymentProviderParams {
  name?: string
  isDefault?: boolean
  isActive?: boolean
  settings?: Record<string, unknown>
}

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Get all payment providers for the current organization
 */
export async function getPaymentProviders(): Promise<
  ActionResult<PaymentProvider[]>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const providers = await db.payment_providers.findMany({
      where: {
        organization_id: orgId,
        deleted_at: null,
      },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    })

    const formattedProviders: PaymentProvider[] = providers.map((p: any) => ({
      id: p.id,
      organizationId: p.organization_id,
      type: p.type as PaymentProviderType,
      code: p.code,
      name: p.name,
      isDefault: p.is_default,
      isActive: p.is_active,
      settings: (p.settings as Record<string, unknown>) || {},
      createdAt: p.created_at?.toISOString() || new Date().toISOString(),
      updatedAt: p.updated_at?.toISOString() || new Date().toISOString(),
      // Note: encrypted_secrets is intentionally NOT returned
    }))

    return { success: true, data: formattedProviders }
  } catch (error) {
    console.error('Error in getPaymentProviders:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to get payment providers',
    }
  }
}

/**
 * Get a single payment provider by ID
 */
export async function getPaymentProvider(
  providerId: string
): Promise<ActionResult<PaymentProvider>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const provider = await db.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: orgId,
        deleted_at: null,
      },
    })

    if (!provider) {
      return { success: false, error: 'Payment provider not found' }
    }

    const formattedProvider: PaymentProvider = {
      id: provider.id,
      organizationId: provider.organization_id,
      type: provider.type as PaymentProviderType,
      code: provider.code,
      name: provider.name,
      isDefault: provider.is_default,
      isActive: provider.is_active,
      settings: (provider.settings as Record<string, unknown>) || {},
      createdAt: provider.created_at?.toISOString() || new Date().toISOString(),
      updatedAt: provider.updated_at?.toISOString() || new Date().toISOString(),
    }

    return { success: true, data: formattedProvider }
  } catch (error) {
    console.error('Error in getPaymentProvider:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to get payment provider',
    }
  }
}

/**
 * Update a payment provider's non-sensitive settings
 * Note: API keys/secrets should be updated through the NestJS API
 */
export async function updatePaymentProvider(
  providerId: string,
  params: UpdatePaymentProviderParams
): Promise<ActionResult<PaymentProvider>> {
  try {
    // GATE FIRST: this action can flip `isDefault` — which redirects
    // which provider receives the org's revenue — and toggle `isActive`. That is a payout
    // decision, so only an owner/admin may run it. Developers/finance/members are denied.
    const gate = await assertOrgManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    // Verify the provider belongs to this organization
    const existingProvider = await db.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: orgId,
        deleted_at: null,
      },
    })

    if (!existingProvider) {
      return { success: false, error: 'Payment provider not found' }
    }

    // If setting this provider as default, unset other defaults
    if (params.isDefault) {
      await db.payment_providers.updateMany({
        where: {
          organization_id: orgId,
          id: { not: providerId },
          deleted_at: null,
        },
        data: {
          is_default: false,
          updated_at: new Date(),
        },
      })
    }

    const updatedProvider = await db.payment_providers.update({
      where: { id: providerId },
      data: {
        ...(params.name !== undefined && { name: params.name }),
        ...(params.isDefault !== undefined && { is_default: params.isDefault }),
        ...(params.isActive !== undefined && { is_active: params.isActive }),
        ...(params.settings !== undefined && {
          settings: {
            ...(existingProvider.settings as Record<string, unknown>),
            ...params.settings,
          },
        }),
        updated_at: new Date(),
      },
    })

    const formattedProvider: PaymentProvider = {
      id: updatedProvider.id,
      organizationId: updatedProvider.organization_id,
      type: updatedProvider.type as PaymentProviderType,
      code: updatedProvider.code,
      name: updatedProvider.name,
      isDefault: updatedProvider.is_default,
      isActive: updatedProvider.is_active,
      settings: (updatedProvider.settings as Record<string, unknown>) || {},
      createdAt:
        updatedProvider.created_at?.toISOString() || new Date().toISOString(),
      updatedAt:
        updatedProvider.updated_at?.toISOString() || new Date().toISOString(),
    }

    return { success: true, data: formattedProvider }
  } catch (error) {
    console.error('Error in updatePaymentProvider:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update payment provider',
    }
  }
}

/**
 * Disconnect (soft delete) a payment provider
 */
export async function disconnectPaymentProvider(
  providerId: string
): Promise<ActionResult<{ message: string }>> {
  try {
    // GATE FIRST: disconnecting a payout provider stops revenue from
    // landing where the org set it to land — a payout decision, so owner/admin ONLY. This
    // covers BOTH branches below: the OAuth branch (which also gets re-gated downstream by
    // the ORG_MANAGE api-nest endpoint) AND the secret-key branch (which writes
    // the database DIRECTLY here and would otherwise have NO role check at all).
    const gate = await assertOrgManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    // Verify the provider belongs to this organization
    const existingProvider = await db.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: orgId,
        deleted_at: null,
      },
    })

    if (!existingProvider) {
      return { success: false, error: 'Payment provider not found' }
    }

    // A Stripe Connect provider must disconnect through the stripe-connect endpoint so
    // we (1) call Stripe's deauthorize API and (2) clear the org's stripe_connect_*
    // mirror fields. The plain payment_providers soft-delete below does neither, which
    // would leave "Connect" refusing with "already connected" after a disconnect.
    const settings =
      (existingProvider.settings as { source?: string } | null) ?? {}
    if (settings.source === 'oauth') {
      const cookieHeader = (await headers()).get('cookie') || ''
      const endpoint = `${API_BASE_URL}/org/${orgId}/stripe-connect/disconnect`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        return {
          success: false,
          error: errorData.message || `API error: ${response.status}`,
        }
      }
      return {
        success: true,
        data: { message: 'Stripe disconnected' },
      }
    }

    // Own-keys path: soft-delete the payment_providers row directly. A secret-key
    // provider has no Stripe-side grant to revoke and no org mirror fields to clear.
    await db.payment_providers.update({
      where: { id: providerId },
      data: {
        deleted_at: new Date(),
        is_active: false,
        is_default: false,
        encrypted_secrets: null, // Clear secrets on disconnect
        updated_at: new Date(),
      },
    })

    return {
      success: true,
      data: { message: 'Payment provider disconnected successfully' },
    }
  } catch (error) {
    console.error('Error in disconnectPaymentProvider:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to disconnect payment provider',
    }
  }
}

/**
 * Get the default payment provider for the organization
 */
export async function getDefaultPaymentProvider(): Promise<
  ActionResult<PaymentProvider | null>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const provider = await db.payment_providers.findFirst({
      where: {
        organization_id: orgId,
        is_default: true,
        is_active: true,
        deleted_at: null,
      },
    })

    if (!provider) {
      return { success: true, data: null }
    }

    const formattedProvider: PaymentProvider = {
      id: provider.id,
      organizationId: provider.organization_id,
      type: provider.type as PaymentProviderType,
      code: provider.code,
      name: provider.name,
      isDefault: provider.is_default,
      isActive: provider.is_active,
      settings: (provider.settings as Record<string, unknown>) || {},
      createdAt: provider.created_at?.toISOString() || new Date().toISOString(),
      updatedAt: provider.updated_at?.toISOString() || new Date().toISOString(),
    }

    return { success: true, data: formattedProvider }
  } catch (error) {
    console.error('Error in getDefaultPaymentProvider:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to get default payment provider',
    }
  }
}
