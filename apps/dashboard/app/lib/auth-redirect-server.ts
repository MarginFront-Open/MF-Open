/**
 * Server-side Post-Authentication Redirect Logic
 *
 * This utility handles server-side redirect logic to prevent
 * any flash of content before redirect. Use this in Server Components.
 *
 * For client-side redirects, use auth-redirect.ts instead.
 */

import { headers } from 'next/headers'
import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { auth } from './auth'
import { db } from './db'
import { resolvePostAuthDestination } from './pending-invite'
import { safeRedirectPath } from './safe-redirect'

/**
 * Where a signed-in org member lands when there's no explicit redirectTo.
 * Money-managers (owner/admin/finance) get
 * the Money command center; everyone else gets Build, which is ungated
 * by design. The role is read from the caller's active org, mirroring
 * require-route-roles.ts — so a money-manager
 * who lands on /money clears that page's identical role gate, and a non-manager
 * never bounces off /money to /403. Fails safe to /build.
 */
async function resolveOrgLanding(
  orgId: string,
  userId: string | null
): Promise<string> {
  if (!userId) return '/build'
  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })
  const moneyRoles: readonly string[] = MANAGE_MONEY_ROLES
  if (membership && moneyRoles.includes(membership.role)) {
    return '/money'
  }
  return '/build'
}

export type PostAuthRedirectReason =
  | 'no-session'
  | 'no-organization'
  | 'has-organization'
  | 'pending-invite'

export type PostAuthRedirectResult = {
  url: string
  reason: PostAuthRedirectReason
}

/**
 * Server-side version for use in Server Components
 * This runs BEFORE the page renders, preventing any flash
 *
 * @param redirectTo - Optional path on this site to go to after successful
 *   auth. Anything that is not a same-site path is ignored.
 * @returns Object containing redirect URL and reason
 */
export async function getPostAuthRedirectServer(
  redirectTo?: string | null
): Promise<PostAuthRedirectResult> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    // No valid session - redirect to sign-in
    if (!session?.session) {
      console.log('[auth-redirect-server] No session found, redirecting to sign-in')
      return { url: '/sign-in', reason: 'no-session' }
    }

    // Check for active organization
    const activeOrgId = session.session.activeOrganizationId

    if (!activeOrgId) {
      // No active org. Before defaulting to onboarding, check for a pending
      // invite for THIS session's email — an invited teammate who
      // signs in organically must land on the accept page, not "create a new
      // workspace." Keyed off the session email only (no param → no IDOR).
      const destination = await resolvePostAuthDestination({
        activeOrgId,
        email: session.user?.email,
      })
      console.log(
        `[auth-redirect-server] No active org, resolved destination: ${destination.url} (${destination.reason})`
      )
      return destination
    }

    // Existing user with organization → the role-aware command-center landing.
    const targetUrl =
      safeRedirectPath(redirectTo) ||
      (await resolveOrgLanding(activeOrgId, session.user?.id ?? null))
    console.log(`[auth-redirect-server] Organization found, redirecting to ${targetUrl}`)
    return {
      url: targetUrl,
      reason: 'has-organization'
    }
  } catch (error) {
    console.error('[auth-redirect-server] Error determining redirect:', error)
    // Fail-safe: redirect to onboarding to ensure org is created
    return { url: '/quick-onboarding', reason: 'no-organization' }
  }
}
