/**
 * Post-authentication routing helpers (server-only).
 *
 * SECURITY SPINE: the invited-email lookup keys off the
 * AUTHENTICATED SESSION EMAIL only. Callers pass the session's own email — never
 * a URL/query/body value — so there is no way to steer this at another user's
 * invitations (no IDOR / enumeration). The routing decision here only sends a
 * user toward an accept page; it never grants membership. Membership is still
 * gated server-side (email === invitation.email) at the accept surface.
 *
 * This module imports Prisma (`db`) and must only be used from server code
 * (route handlers, server components, the /api/pending-invite endpoint). The
 * client-side redirect path reaches it indirectly via GET /api/pending-invite.
 */

import { db } from './db'

export type PendingInvite = {
  invitationId: string
  organizationId: string
  organizationName: string
  email: string
}

/**
 * Most-recent pending, unexpired invitation for the given email.
 *
 * `email` MUST be the authenticated session's email. Keyed on the indexed
 * `ba_invitation.email` column.
 */
export async function findPendingInviteForEmail(
  email: string
): Promise<PendingInvite | null> {
  if (!email) return null

  const invitation = await db.ba_invitation.findFirst({
    where: {
      email,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      organizations: { select: { name: true } },
    },
  })

  if (!invitation) return null

  return {
    invitationId: invitation.id,
    organizationId: invitation.organizationId,
    organizationName: invitation.organizations?.name ?? 'the organization',
    email: invitation.email,
  }
}

export type PostAuthDestinationReason =
  | 'has-organization'
  | 'pending-invite'
  | 'no-organization'

export type PostAuthDestination = {
  url: string
  reason: PostAuthDestinationReason
}

/**
 * The single place that decides where a just-authenticated user goes, keyed off
 * the session only — so every call site routes "no org" the same way and none
 * can drop a pending invite on the way to onboarding.
 */
export async function resolvePostAuthDestination(args: {
  activeOrgId?: string | null
  email?: string | null
}): Promise<PostAuthDestination> {
  if (args.activeOrgId) {
    // Root resolves the role-aware command-center landing server-side; '/'
    // never resolves back to '/', so there's no redirect loop.
    return { url: '/', reason: 'has-organization' }
  }

  if (args.email) {
    const invite = await findPendingInviteForEmail(args.email)
    if (invite) {
      return {
        url: `/invite/accept/${invite.invitationId}`,
        reason: 'pending-invite',
      }
    }
  }

  return { url: '/quick-onboarding', reason: 'no-organization' }
}
