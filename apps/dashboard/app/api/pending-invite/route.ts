import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { resolvePostAuthDestination } from '@/app/lib/pending-invite'

/**
 * Post-auth routing endpoint for client-side auth flows.
 *
 * Returns where the CURRENT authenticated session should go next (home, an
 * accept page for a pending invite, or onboarding).
 *
 * SECURITY: the email and active org are read from the session
 * ONLY. There is deliberately no request parameter for email or org, so this
 * cannot be pointed at another user's invitations — no IDOR / enumeration.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.session) {
    return NextResponse.json(
      { url: '/sign-in', reason: 'no-session' },
      { status: 401 }
    )
  }

  const destination = await resolvePostAuthDestination({
    activeOrgId: session.session.activeOrganizationId,
    email: session.user?.email,
  })

  return NextResponse.json(destination)
}
