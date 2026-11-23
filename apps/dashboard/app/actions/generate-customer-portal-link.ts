'use server'

import { db as prisma } from '@/app/lib/db'
import {
  createPortalMagicLink,
  MAGIC_LINK_TOKEN_PREFIX,
} from '@/app/lib/portal-auth'
import { buildRedeemUrl } from '@/lib/portal-url'
import { assertPortalManager } from './_shared/assert-portal-manager'

// Single-use, 1-hour expiry. The `mgl_` prefix
// lives in @/app/lib/portal-auth so every magic-link mint point uses the
// same shape.
const MAGIC_LINK_EXPIRES_MS = 60 * 60 * 1000

export type GeneratePortalLinkErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'no_org_slug'
  | 'server_error'

export interface GeneratePortalLinkResult {
  success: boolean
  data?: {
    portalUrl: string
    customerId: string
    customerName: string
    customerEmail: string | null
    organizationName: string
    expiresAt: string
  }
  errorCode?: GeneratePortalLinkErrorCode
  error?: string
}

/**
 * Mint a single-use 1-hour magic link for a customer's portal.
 *
 * Caller is an owner/admin/finance user opening the customer detail page
 * (assertPortalManager). We validate the customer is in the caller's active
 * organization, then write a `portal_magic_links` row whose `usedAt IS NULL`.
 * The redeem flow lives at /api/portal-auth/from-magic-link.
 */
export async function generateCustomerPortalLink(
  customerId: string
): Promise<GeneratePortalLinkResult> {
  try {
    const gate = await assertPortalManager()
    if (!gate.ok) {
      return { success: false, errorCode: gate.reason, error: gate.error }
    }

    const orgId = gate.orgId

    const customer = await prisma.customers.findFirst({
      where: { id: customerId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, email: true },
    })

    if (!customer) {
      return {
        success: false,
        errorCode: 'not_found',
        error: 'Customer not found in this organization.',
      }
    }

    const organization = await prisma.organizations.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    })

    if (!organization?.slug) {
      return {
        success: false,
        errorCode: 'no_org_slug',
        error:
          'This organization has no slug configured. Portal links cannot be generated yet.',
      }
    }

    const token = await createPortalMagicLink(customer.id, orgId, {
      tokenPrefix: MAGIC_LINK_TOKEN_PREFIX,
      expiresInMs: MAGIC_LINK_EXPIRES_MS,
    })

    // Single redeemer at /r/<token>. The token resolves to the org
    // server-side so the URL doesn't disclose the slug.
    const portalUrl = buildRedeemUrl(token)
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRES_MS).toISOString()

    return {
      success: true,
      data: {
        portalUrl,
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email,
        organizationName: organization.name,
        expiresAt,
      },
    }
  } catch (error) {
    console.error('[generateCustomerPortalLink] Error:', error)
    return {
      success: false,
      errorCode: 'server_error',
      error: 'Something went wrong while generating the portal link.',
    }
  }
}
