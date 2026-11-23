'use server'

/**
 * Stripe Connect Server Actions
 * Server-side actions for Stripe Connect OAuth flow
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'

import { API_BASE_URL } from '@/lib/api/config'

// Types
export interface StripeConnectStatus {
  accountId: string | null
  status: 'not_connected' | 'pending' | 'active' | 'restricted'
  chargesEnabled: boolean
  detailsSubmitted: boolean
  requirements?: {
    currently_due?: string[]
    eventually_due?: string[]
    past_due?: string[]
    disabled_reason?: string | null
  }
}

export interface GenerateOAuthUrlResponse {
  authorizationUrl: string
  state: string
}

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Generate Stripe Connect OAuth URL
 * This redirects the user to Stripe to authorize their account
 */
export async function generateStripeOAuthUrl(
  redirectUri?: string
): Promise<ActionResult<GenerateOAuthUrlResponse>> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    // Check if already connected
    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: { stripe_connect_account_id: true },
    })

    if (org?.stripe_connect_account_id) {
      return {
        success: false,
        error: 'Stripe Connect account already connected',
      }
    }

    // Call NestJS API to generate OAuth URL
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(
      `${API_BASE_URL}/org/${orgId}/stripe-connect/oauth-url`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          redirectUri:
            redirectUri ||
            `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/stripe-connect/callback`,
        }),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[generateStripeOAuthUrl] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    console.error('[generateStripeOAuthUrl] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to generate OAuth URL',
    }
  }
}

/**
 * Complete Stripe Connect OAuth flow
 * Called after user returns from Stripe OAuth
 */
export async function connectStripeAccount(
  code: string,
  state: string
): Promise<ActionResult<{ accountId: string; message: string }>> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // Call NestJS API to complete OAuth
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(
      `${API_BASE_URL}/org/${session.session.activeOrganizationId}/stripe-connect/connect`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ code, state }),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[connectStripeAccount] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      data: {
        accountId: data.accountId,
        message:
          data.message || 'Stripe Connect account connected successfully',
      },
    }
  } catch (error) {
    console.error('[connectStripeAccount] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to connect Stripe account',
    }
  }
}

/**
 * Disconnect Stripe Connect account
 */
export async function disconnectStripeAccount(): Promise<
  ActionResult<{ message: string }>
> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    // Call NestJS API to disconnect
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(
      `${API_BASE_URL}/org/${orgId}/stripe-connect/disconnect`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[disconnectStripeAccount] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      data: { message: data.message || 'Stripe account disconnected' },
    }
  } catch (error) {
    console.error('[disconnectStripeAccount] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to disconnect Stripe account',
    }
  }
}

/**
 * Get Stripe Connect account status
 */
export async function getStripeConnectStatus(): Promise<
  ActionResult<StripeConnectStatus>
> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    // First check organization's local Stripe Connect info
    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: {
        stripe_connect_account_id: true,
        stripe_connect_status: true,
        stripe_connect_charges_enabled: true,
        stripe_connect_details_submitted: true,
        stripe_connect_requirements: true,
      },
    })

    if (!org?.stripe_connect_account_id) {
      return {
        success: true,
        data: {
          accountId: null,
          status: 'not_connected',
          chargesEnabled: false,
          detailsSubmitted: false,
        },
      }
    }

    // Try to get fresh status from NestJS API
    try {
      const cookieHeader = headersList.get('cookie') || ''

      const response = await fetch(
        `${API_BASE_URL}/org/${orgId}/stripe-connect/status`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookieHeader,
          },
        }
      )

      if (response.ok) {
        const data = await response.json()
        return {
          success: true,
          data: {
            accountId: data.accountId,
            status: data.status as StripeConnectStatus['status'],
            chargesEnabled: data.chargesEnabled,
            detailsSubmitted: data.detailsSubmitted,
            requirements: data.requirements,
          },
        }
      }
    } catch (apiError) {
      console.warn(
        '[getStripeConnectStatus] API call failed, using cached data:',
        apiError
      )
    }

    // Fallback to cached data in database
    return {
      success: true,
      data: {
        accountId: org.stripe_connect_account_id,
        status:
          (org.stripe_connect_status as StripeConnectStatus['status']) ||
          'pending',
        chargesEnabled: org.stripe_connect_charges_enabled || false,
        detailsSubmitted: org.stripe_connect_details_submitted || false,
        requirements:
          org.stripe_connect_requirements as StripeConnectStatus['requirements'],
      },
    }
  } catch (error) {
    console.error('[getStripeConnectStatus] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to get Stripe Connect status',
    }
  }
}

/**
 * Check if Stripe is connected for the current organization
 * Lightweight check that only queries the database
 */
export async function isStripeConnected(): Promise<
  ActionResult<{ connected: boolean; accountId: string | null }>
> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: {
        stripe_connect_account_id: true,
        stripe_connect_status: true,
      },
    })

    const connected = Boolean(
      org?.stripe_connect_account_id && org?.stripe_connect_status === 'active'
    )

    return {
      success: true,
      data: {
        connected,
        accountId: org?.stripe_connect_account_id || null,
      },
    }
  } catch (error) {
    console.error('[isStripeConnected] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to check Stripe connection',
    }
  }
}
