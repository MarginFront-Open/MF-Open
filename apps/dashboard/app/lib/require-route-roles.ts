/**
 * require-route-roles.ts: the server-side lock that makes the URL respect the
 * sidebar.
 *
 * WHY THIS EXISTS (plain English): the sidebar HIDES role-gated screens (the
 * money screens, the org-settings screens) from people who aren't allowed to
 * see them. Hiding the link doesn't stop anyone from TYPING the URL.
 * This helper is the server-side bouncer: a role-gated
 * page calls it at the very top, and anyone whose role isn't on the allow-list
 * gets bounced to /403 before the page renders. The nav SHOWS the policy; this
 * ENFORCES the exact same policy.
 *
 * IT REUSES THE NAV'S POLICY, IT DOES NOT INVENT ONE: callers pass the same role
 * constants the sidebar already declares — MANAGE_MONEY_ROLES (owner/admin/
 * finance) for the money screens, ORG_MANAGE_ROLES (owner/admin) for org
 * settings. Both come from '@marginfront/db' so the dashboard and api-nest can never
 * drift apart.
 *
 * NOTE this is NOT a 'use server' module. It's a plain server-only helper that
 * server components await at the top of their render — it never becomes a
 * client-callable action.
 */

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'

/**
 * Bounce the viewer to /403 unless their role (in their active org) is on the
 * allow-list. Returns void on success so a server component can just
 * `await requireRouteRoles(MANAGE_MONEY_ROLES)` and then render.
 *
 * Fails CLOSED: no session, no active org, no user id, no membership row, or a
 * role outside the allow-list all redirect to /403. (A missing user id must be
 * guarded explicitly — Prisma drops an `undefined` where-field, so a userId-less
 * lookup would silently degenerate into "first member found".)
 */
export async function requireRouteRoles(
  allowedRoles: readonly string[]
): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() })

  const orgId = session?.session?.activeOrganizationId
  if (!orgId) {
    redirect('/403')
  }

  const userId = session?.user?.id ?? null
  if (!userId) {
    redirect('/403')
  }

  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })

  if (!membership || !allowedRoles.includes(membership.role)) {
    redirect('/403')
  }
}
