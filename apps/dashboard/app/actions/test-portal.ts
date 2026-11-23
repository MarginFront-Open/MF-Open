'use server'

import { db as prisma } from '@/app/lib/db'
import { assertPortalManager } from './_shared/assert-portal-manager'
import { createPortalSession } from '@/app/lib/portal-auth'
import { buildRedeemUrl } from '@/lib/portal-url'

export interface TestPortalResult {
  success: boolean
  data?: {
    portalUrl: string
    customerName: string
  }
  error?: string
}

/**
 * Get the admin's test customer and create impersonation session.
 * This allows admins to test the customer portal with their own account.
 */
export async function openTestPortal(): Promise<TestPortalResult> {
  try {
    const gate = await assertPortalManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const { session, orgId } = gate
    const adminEmail = session.user.email

    if (!adminEmail) {
      return { success: false, error: 'Admin email not found' }
    }

    // Find admin's test customer (created during onboarding)
    const testCustomer = await prisma.customers.findFirst({
      where: {
        organizationId: orgId,
        email: adminEmail,
        status: 'active',
      },
    })

    if (!testCustomer) {
      return {
        success: false,
        error:
          'No test customer found. Complete onboarding to create your test account.',
      }
    }

    // Get organization for portal URL
    const org = await prisma.organizations.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    })

    if (!org?.slug) {
      return {
        success: false,
        error:
          'Portal not configured. Your organization needs a slug for the customer portal.',
      }
    }

    // Mint a prefixed `prtl_<32>` session (30-min lifetime, audit-stamped).
    const token = await createPortalSession(
      testCustomer.id,
      orgId,
      null,
      'Developer Zone Test',
      {
        impersonatedBy: session.user.id,
      }
    )

    console.log(
      `[TestPortal] Admin ${session.user.email} opened test portal for org ${org.name}`
    )

    return {
      success: true,
      data: {
        // Single redeemer at /r/<token>; admin opens this URL.
        portalUrl: buildRedeemUrl(token),
        customerName: testCustomer.name,
      },
    }
  } catch (error) {
    console.error('[TestPortal] Error:', error)
    return { success: false, error: 'Failed to open test portal' }
  }
}
