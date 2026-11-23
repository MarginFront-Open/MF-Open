'use server'

import { db as prisma } from '@/app/lib/db'
import { assertPortalManager } from './_shared/assert-portal-manager'
import { createPortalSession } from '@/app/lib/portal-auth'
import { buildRedeemUrl } from '@/lib/portal-url'

// Shorter session duration for impersonation (30 minutes)
const IMPERSONATION_SESSION_DURATION_MS = 30 * 60 * 1000

export interface ImpersonateCustomerResult {
  success: boolean
  data?: {
    sessionToken: string
    portalUrl: string
    customerName: string
    expiresAt: string
  }
  error?: string
}

/**
 * Create an impersonation session for viewing the customer portal as a customer.
 *
 * Security checks:
 * 1. Verify the caller is signed in AND holds a portal role (owner/admin/finance)
 * 2. Verify customer belongs to the caller's organization
 * 3. Create short-lived session with audit trail
 */
export async function impersonateCustomer(
  customerId: string
): Promise<ImpersonateCustomerResult> {
  try {
    // 1. Role gate before any lookup or mint.
    const gate = await assertPortalManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const { session, userId: adminUserId, orgId } = gate

    // 2. Verify customer exists and belongs to the same organization
    const customer = await prisma.customers.findFirst({
      where: {
        id: customerId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!customer) {
      return {
        success: false,
        error: 'Customer not found in this organization',
      }
    }

    // 3. Get organization details for portal URL
    const organization = await prisma.organizations.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    })

    if (!organization?.slug) {
      return {
        success: false,
        error: 'Organization does not have a portal configured',
      }
    }

    // 4. Mint the session via the shared helper (prefixed `prtl_<32>` token,
    // 30-min lifetime, impersonatedBy stamped for audit).
    const token = await createPortalSession(
      customer.id,
      orgId,
      null,
      'Admin Impersonation',
      {
        impersonatedBy: adminUserId,
      }
    )
    const expiresAt = new Date(Date.now() + IMPERSONATION_SESSION_DURATION_MS)

    // 5. Log impersonation event for audit
    console.log(
      `[Impersonation] Admin ${adminUserId} (${session.user.email}) impersonating customer ${customerId} (${customer.name}) in org ${orgId} (${organization.name})`
    )

    // 6. Build redeem URL — admin opens this; /r/<token> sets the cookie
    // and redirects to /<slug>/.
    const portalUrl = buildRedeemUrl(token)

    return {
      success: true,
      data: {
        sessionToken: token,
        portalUrl,
        customerName: customer.name,
        expiresAt: expiresAt.toISOString(),
      },
    }
  } catch (error) {
    console.error('[impersonateCustomer] Error:', error)
    return { success: false, error: 'Failed to create impersonation session' }
  }
}
