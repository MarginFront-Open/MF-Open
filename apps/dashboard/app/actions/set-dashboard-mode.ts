'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
// Dashboard mode is org-administration = owner/admin only. It reads the shared
// ORG_MANAGE_ROLES through the gate so it can't drift from the other org-settings writes.
import { assertOrgManager } from './_shared/assert-org-manager'

// The three modes a user can pick — controls which sidebar sections they see
export type DashboardMode = 'cost_tracking' | 'revenue' | 'full'

// The bouncer: only these three values get past the door
const VALID_MODES: DashboardMode[] = ['cost_tracking', 'revenue', 'full']

/**
 * Server Action: save the user's chosen dashboard mode to the database.
 *
 * Called during onboarding ("What brings you here?") and from the sidebar
 * mode-switcher dropdown. Writes directly to the organizations table so we
 * don't need the NestJS API running.
 */
export async function setDashboardMode(
  mode: DashboardMode
): Promise<{ success: boolean; error?: string }> {
  try {
    // Input validation — TypeScript types disappear at runtime,
    // so we check the value is actually one of the three we accept
    if (!VALID_MODES.includes(mode)) {
      return {
        success: false,
        error: `Invalid mode: "${mode}". Must be one of: ${VALID_MODES.join(', ')}`,
      }
    }

    // Role gate: only owners/admins may change the org-wide dashboard
    // mode. The gate checks the role in the caller's REAL active org and returns that org
    // id; we write to exactly the org it validated. A plain member (or finance/developer)
    // is rejected here before any write.
    const gate = await assertOrgManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    await prisma.organizations.update({
      where: { id: gate.orgId },
      data: { dashboard_mode: mode },
    })

    console.log(
      '[setDashboardMode] Saved mode:',
      mode,
      'for org:',
      gate.orgId
    )

    return { success: true }
  } catch (error) {
    console.error('[setDashboardMode] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to save dashboard mode',
    }
  }
}

/**
 * Server Action: read the current dashboard mode from the database.
 *
 * Used by the mode-switcher to show which mode is active.
 */
export async function getDashboardMode(): Promise<{
  success: boolean
  mode?: DashboardMode | null
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

    const org = await prisma.organizations.findUnique({
      where: { id: orgId },
      select: { dashboard_mode: true },
    })

    return { success: true, mode: org?.dashboard_mode as DashboardMode | null }
  } catch (error) {
    console.error('[getDashboardMode] Error:', error)
    return { success: false, error: 'Failed to fetch dashboard mode' }
  }
}
