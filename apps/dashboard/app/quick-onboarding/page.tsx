import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
import QuickOnboardingClient from './QuickOnboardingClient'

/**
 * Quick Onboarding Route - Server Component
 *
 * Reads the session server-side to determine if the user already has
 * an active organization. If they do, they can cancel onboarding and
 * return to the dashboard. If not (first-time user), the cancel button
 * is hidden — they must complete onboarding.
 *
 * Org-redirect guard: a user whose org has ALREADY
 * finished onboarding (organizations.onboarding_complete = true) shouldn't
 * be able to land back on this wizard — send them through '/' instead,
 * same as every other stale-route bounce. This is deliberately gated on
 * onboarding_complete, not just "has an active org": create-organization's
 * own flow sets activeOrganizationId the moment the org is created and THEN
 * routes here to finish billing setup, so gating on org-presence alone
 * would bounce a brand-new org straight back out before the wizard ever
 * runs. '/' resolves the role-aware command-center landing server-side
 * (see auth-redirect-server.ts) and never redirects back to
 * /quick-onboarding for an org that has finished onboarding, so this can't
 * loop.
 *
 * ?new=true additional-org mode: team-switcher's "Add
 * organization" links here so an owner can spin up a SECOND org, which the
 * guard above would otherwise always bounce (their current org's
 * onboarding_complete is true by definition). Only the
 * ACTIVE org's OWNER may do this, checked by reading their own ba_member
 * row (same lookup require-route-roles.ts uses). Fails CLOSED: no session,
 * no active org, no user id, no membership row, or any role other than
 * 'owner' all bounce to '/', same as a stale/forged link. The wizard
 * itself needs no other change to stay safe here: organization-service.ts
 * always creates a FRESH org on submit and immediately sets it active, so
 * every later write in the flow (set-dashboard-mode, markOnboardingComplete)
 * targets that new org via the live session — never the org that was
 * active when ?new=true landed.
 */
export default async function QuickOnboardingRoute({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const isNewOrgRequest = params.new === 'true'

  let canCancel = false
  let alreadyOnboarded = false
  // ?new=true fails CLOSED by default — only a confirmed 'owner' ba_member
  // row for the caller's own active org clears it below.
  let blockNewOrgRequest = isNewOrgRequest

  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })
    const activeOrgId = session?.session?.activeOrganizationId
    const userId = session?.user?.id

    if (activeOrgId) {
      canCancel = true

      if (isNewOrgRequest) {
        if (userId) {
          const membership = await db.ba_member.findFirst({
            where: { organizationId: activeOrgId, userId },
            select: { role: true },
          })
          if (membership?.role === 'owner') {
            blockNewOrgRequest = false
          }
        }
      } else {
        const org = await db.organizations.findUnique({
          where: { id: activeOrgId },
          select: { onboarding_complete: true },
        })
        alreadyOnboarded = org?.onboarding_complete === true
      }
    }
  } catch (error) {
    console.error('[QuickOnboarding] Failed to read session:', error)
    // Default to false — don't show cancel if we can't verify, and don't
    // redirect on an error (fail open INTO onboarding, never out of it) —
    // EXCEPT ?new=true, which stays fail-CLOSED via blockNewOrgRequest's
    // initial value above.
  }

  // Deliberately outside the try/catch above: next/navigation's redirect()
  // throws a special NEXT_REDIRECT error that must propagate uncaught.
  if (blockNewOrgRequest || alreadyOnboarded) {
    redirect('/')
  }

  return <QuickOnboardingClient canCancel={canCancel} />
}
