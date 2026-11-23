'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
// The setup wizard is org-administration = owner/admin only, AND the
// gate also blocks cross-tenant writes through the explicit-orgId arg (see updateSetupMethod).
import { assertOrgManager } from './_shared/assert-org-manager'

// The ways a user can choose to set up their command center.
// This gets saved to the org so we only ask once. 'ccc' = internal
// coding-agent spend via the code-cost-clarity connector.
export type SetupMethod = 'mcp' | 'sdk' | 'api' | 'manual' | 'ccc'

/**
 * Resolve the org ID — either from an explicit parameter or from the server session.
 * We accept an explicit orgId because after onboarding, the server-side session
 * may not have activeOrganizationId yet (it was only set client-side via
 * authClient.organization.setActive). The client-side useAuth() hook does have it,
 * so the caller can pass it directly.
 */
async function resolveOrgId(explicitOrgId?: string): Promise<string | null> {
  if (explicitOrgId) return explicitOrgId

  const session = await auth.api.getSession({
    headers: await headers(),
  })
  return session?.session?.activeOrganizationId ?? null
}

/**
 * Save the user's chosen setup method to their organization.
 * Called when they pick an option from the setup method modal on the home page.
 */
export async function updateSetupMethod(
  method: SetupMethod,
  orgId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Role gate + cross-tenant guard. We pass the caller-supplied `orgId`
    // straight into the gate as the TARGET org. The gate looks up the caller's OWN ba_member
    // role in EXACTLY that org, so:
    //   - a member/finance/developer is rejected (not an owner/admin), and
    //   - a caller passing ANOTHER org's id is rejected too — they have no owner/admin
    //     membership there, so the gate fails closed.
    // The legit post-onboarding case still works: the brand-new owner DOES have an 'owner'
    // ba_member row in their fresh org even before session.activeOrganizationId is populated.
    // We then write to `gate.orgId`, the org the gate PROVED the caller manages,
    // never the unvalidated pass-through id.
    const gate = await assertOrgManager(orgId)
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    await db.organizations.update({
      where: { id: gate.orgId },
      data: { setup_method: method },
    })

    console.log(
      '[updateSetupMethod] Org:',
      gate.orgId,
      'setup_method set to:',
      method
    )

    return { success: true }
  } catch (error) {
    console.error('[updateSetupMethod] Error:', error)
    return {
      success: false,
      error: 'Something went wrong saving your setup choice. Try again.',
    }
  }
}

/**
 * Get the org's current setup method. Returns null if they haven't picked yet
 * (which means we should show the setup method modal).
 */
export async function getSetupMethod(orgId?: string): Promise<{
  success: boolean
  data?: SetupMethod | null
  error?: string
}> {
  try {
    const resolvedOrgId = await resolveOrgId(orgId)

    if (!resolvedOrgId) {
      return { success: false, error: 'No active organization' }
    }

    const org = await db.organizations.findUnique({
      where: { id: resolvedOrgId },
      select: { setup_method: true },
    })

    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    return {
      success: true,
      data: (org.setup_method as SetupMethod) ?? null,
    }
  } catch (error) {
    console.error('[getSetupMethod] Error:', error)
    return { success: false, error: 'Failed to fetch setup method' }
  }
}
