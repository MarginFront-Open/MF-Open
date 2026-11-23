import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/app/lib/db'
import { hashApiKeyForLookup } from '@marginfront/db'

/**
 * Compatibility route for invite links that carry a ?token=. It does NOT
 * authenticate anyone: it validates
 * the token, resolves the invitation id, and redirects to the accept page. The
 * accept page then requires the visitor to authenticate AS the invited email
 * (Google SSO matching that email, or a magic link sent to it) before any join.
 *
 * SECURITY SPINE: this route creates no user, no membership,
 * and no session, and sets no cookie. A leaked / forwarded link resolves only to
 * the accept page — the auth-as-invited gate there is the boundary, not the link.
 * The token is intentionally NOT consumed (left for retries); token single-use is
 * not the security control.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const token = searchParams.get('token')

  if (!token) {
    return NextResponse.redirect(
      new URL('/invite/success?error=missing_token', request.url)
    )
  }

  try {
    // Invite-magic rows store a SHA-256 hash of the token and are
    // matched ONLY by the hash of the incoming token. A lookup by the raw value
    // would let anyone who can read the table present a stored hash as a token.
    const verification = await prisma.ba_verification.findFirst({
      where: {
        identifier: { startsWith: 'invite-magic:' },
        value: hashApiKeyForLookup(token),
        expiresAt: { gt: new Date() },
      },
    })

    if (!verification) {
      console.error('[InviteVerify] Token not found or expired')
      return NextResponse.redirect(
        new URL('/invite/success?error=invalid_token', request.url)
      )
    }

    // identifier format: "invite-magic:{invitationId}"
    const invitationId = verification.identifier.replace('invite-magic:', '')

    // Route to the accept page. It re-validates the invitation itself
    // (getPublicInvitationDetails) and gates the join on auth-as-invited, so a
    // stale/accepted/expired invitation surfaces its own error state there.
    return NextResponse.redirect(
      new URL(`/invite/accept/${invitationId}`, request.url)
    )
  } catch (error: any) {
    console.error('[InviteVerify] Error:', error?.message || error)
    return NextResponse.redirect(
      new URL('/invite/success?error=verification_failed', request.url)
    )
  }
}
