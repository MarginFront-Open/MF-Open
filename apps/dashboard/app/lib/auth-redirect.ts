/**
 * Unified Post-Authentication Redirect Logic
 *
 * This utility centralizes the redirect logic after authentication,
 * ensuring consistent behavior across all auth flows:
 * - Email/Password sign-in
 * - Sign-up + OTP verification
 * - OAuth (Google/GitHub)
 *
 * Flow:
 * 1. No session → /sign-in
 * 2. Session but no organization → /quick-onboarding
 * 3. Session with organization → / (root resolves the role-aware landing) or redirectTo
 */

import { authClient } from './auth-client'
import { safeRedirectPath } from './safe-redirect'

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
 * Ask the server where a just-authenticated, org-less session should go.
 *
 * This is how the client-side redirect path reaches the pending-invite lookup:
 * GET /api/pending-invite reads the invited email from the SESSION only (no
 * param), so it can't be steered at another user's invitations. We only divert
 * when the server reports an actual pending invite; anything else falls through
 * to the caller's existing onboarding default.
 */
async function fetchPendingInviteRedirect(): Promise<PostAuthRedirectResult | null> {
  try {
    const res = await fetch('/api/pending-invite', {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { url?: string; reason?: string }
    if (data?.reason === 'pending-invite' && typeof data.url === 'string') {
      return { url: data.url, reason: 'pending-invite' }
    }
    return null
  } catch (error) {
    console.error('[auth-redirect] pending-invite lookup failed:', error)
    return null
  }
}

/**
 * `redirectTo` comes from the query string, which anyone can write into a link.
 * Only a path on this site is honoured; a full URL to somewhere else is dropped.
 */
function isInviteAcceptPath(path: string | null): path is string {
  return !!path && path.startsWith('/invite/accept/')
}

/**
 * Determines where to redirect user after authentication
 * Centralized logic used by all auth flows
 *
 * @param redirectTo - Optional URL to redirect to after successful auth (only used if user has org)
 * @returns Object containing redirect URL and reason
 */
export async function getPostAuthRedirect(
  redirectTo?: string | null
): Promise<PostAuthRedirectResult> {
  const safeRedirectTo = safeRedirectPath(redirectTo)
  try {
    const session = await authClient.getSession()

    // No valid session - redirect to sign-in
    if (!session?.data?.session) {
      console.log('[auth-redirect] No session found, redirecting to sign-in')
      return { url: '/sign-in', reason: 'no-session' }
    }

    // Check for active organization
    const activeOrgId = session.data.session.activeOrganizationId

    // Special case: Allow invitation URLs even without an org
    // (accepting an invite will add user to the org)
    if (isInviteAcceptPath(safeRedirectTo)) {
      console.log(
        `[auth-redirect] Invitation redirect, going to ${safeRedirectTo}`
      )
      return { url: safeRedirectTo, reason: 'has-organization' }
    }

    if (!activeOrgId) {
      // No active org. Before defaulting to onboarding, check for a pending
      // invite for THIS session's email so an invited teammate who
      // signs in organically joins their org instead of being sent to "create a
      // new workspace." The lookup is server-side and keyed off the session
      // email only (no param → no IDOR).
      const invite = await fetchPendingInviteRedirect()
      if (invite) {
        console.log(`[auth-redirect] Pending invite found, redirecting to ${invite.url}`)
        return invite
      }
      console.log('[auth-redirect] No organization found, redirecting to onboarding')
      return { url: '/quick-onboarding', reason: 'no-organization' }
    }

    // Existing user with organization. Send them to the root, which resolves
    // the role-aware landing server-side (getPostAuthRedirectServer) — this
    // client path has no DB access to read the org role itself. '/' never
    // resolves back to '/', so there's no redirect loop.
    const targetUrl = safeRedirectTo || '/'
    console.log(`[auth-redirect] Organization found, redirecting to ${targetUrl}`)
    return {
      url: targetUrl,
      reason: 'has-organization'
    }
  } catch (error) {
    console.error('[auth-redirect] Error determining redirect:', error)
    // Fail-safe: redirect to onboarding to ensure org is created
    return { url: '/quick-onboarding', reason: 'no-organization' }
  }
}

/**
 * Synchronous version that uses existing session data
 * Use this when you already have session data and don't want to refetch
 *
 * @param sessionData - Session data from authClient.getSession()
 * @param redirectTo - Optional URL to redirect to after successful auth
 * @returns Object containing redirect URL and reason
 */
export function getPostAuthRedirectSync(
  sessionData: { session?: { activeOrganizationId?: string } } | null,
  redirectTo?: string | null
): PostAuthRedirectResult {
  const safeRedirectTo = safeRedirectPath(redirectTo)

  // No valid session
  if (!sessionData?.session) {
    return { url: '/sign-in', reason: 'no-session' }
  }

  // Special case: Allow invitation URLs even without an org
  if (isInviteAcceptPath(safeRedirectTo)) {
    return { url: safeRedirectTo, reason: 'has-organization' }
  }

  // Check for active organization
  const activeOrgId = sessionData.session.activeOrganizationId

  if (!activeOrgId) {
    // NOTE: this synchronous variant cannot perform the server-side
    // pending-invite lookup (that needs an async fetch to /api/pending-invite).
    // Any org-less path where a dropped invite matters must use the async
    // getPostAuthRedirect() above, which diverts to the accept page. This
    // fallback stays onboarding-only.
    return { url: '/quick-onboarding', reason: 'no-organization' }
  }

  // Has organization → root resolves the role-aware landing server-side.
  return {
    url: safeRedirectTo || '/',
    reason: 'has-organization'
  }
}

