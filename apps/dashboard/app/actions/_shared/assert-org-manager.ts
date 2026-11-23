/**
 * assert-org-manager.ts: the ONE server-side lock that stops a plain member
 * from editing the org account.
 *
 * WHY THIS EXISTS (plain English): hiding the org-settings screens' buttons in the
 * nav (branding/theme colors, the company logo, the onboarding flow, the setup-method
 * wizard, the dashboard mode) isn't protection. Anyone in the org can call the server
 * action directly (or hit the URL), so each action must check "are you allowed to run
 * the company account?", not only "are you logged in and in an org?".
 * This helper is the single gate every org-settings WRITE action calls before it does
 * anything, so the role check lives in ONE place instead of being copy-pasted (and
 * drifting) across files.
 *
 * THE ROLE LINE (do NOT blur it): org BRANDING / LOGO / ONBOARDING / SETUP / dashboard
 * mode are ORG-ADMINISTRATION = running the company account = OWNER/ADMIN ONLY. This is
 * the TIGHTEST of the three gates and stays that way:
 *   - MONEY (the books: invoices, pricing, tax, classification) = owner/admin/FINANCE
 *     — see assert-money-manager.ts. Org settings get NO finance.
 *   - BUILD (the plumbing: agents, customers, meters, API keys) = owner/admin/developer.
 *     See assert-build-manager.ts. Org settings get
 *     NO developer either.
 * Finance owns the numbers; developers own the meters; neither runs the company account.
 *
 * NOTE this is intentionally NOT a 'use server' file. A 'use server' module may only
 * export async functions — this module also exports its result TYPE, so it's a plain
 * server-only helper that the Server Actions import. It never becomes a callable action
 * itself, so it can't be invoked from the client. Mirrors assert-money-manager.ts /
 * assert-build-manager.ts exactly.
 *
 * THE ONE DELIBERATE DEVIATION from the money/build helpers — the optional `targetOrgId`
 * param: org-settings has a legit explicit-org case the books/plumbing don't. The
 * setup-method action runs right after a brand-new user finishes creating their org,
 * when `session.activeOrganizationId` may not be populated server-side yet but the
 * caller knows the fresh org id. Passing that id here means the role is checked in the
 * TARGET org by the caller's OWN userId, which also blocks a cross-tenant write
 * from setup-method: you can only write an org you are actually an owner/admin OF, so a
 * caller passing some OTHER org's id fails closed (no owner/admin ba_member row there).
 * For the no-arg callers (onboarding, set-dashboard-mode) it behaves exactly
 * like the money/build gates — orgToCheck == the session's active org.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
// Single source of truth for "who runs the company account" — the SAME constant the
// api-nest org-role guard re-exports, so the two surfaces can never drift. owner | admin.
import { ORG_MANAGE_ROLES } from '@marginfront/db'

/**
 * The result of the gate.
 *
 * Return-based (not throw-based) ON PURPOSE: every org-settings action already returns
 * `{ success: false, error: string }` on failure, so a caller can do
 * `if (!gate.ok) return { success: false, error: gate.error }` and stay perfectly in its
 * existing contract. Throwing here would surface as an unhandled 500 instead of the clean
 * error the UI already knows how to render.
 *
 * Field-for-field identical to MoneyManagerGate / BuildManagerGate so the three gates are
 * drop-in interchangeable at a call site. `orgId` is the org the gate VALIDATED the
 * caller's role in — for the explicit-orgId case it's that target org (which the caller is
 * proven to manage), so a write keyed to `gate.orgId` can never land in a foreign org.
 */
export type OrgManagerGate =
  | {
      ok: true
      orgId: string
      userId: string
      session: Awaited<ReturnType<typeof auth.api.getSession>>
    }
  | { ok: false; error: string }

/**
 * Gate an ORG-SETTINGS WRITE: confirm the caller is a real member of the org being
 * changed AND holds an org-manage role (owner / admin). Call this at the very top of
 * every org-settings write action; bail on `!gate.ok` before any DB mutation.
 *
 * @param targetOrgId  OPTIONAL. When omitted, the role is checked in the caller's REAL
 *   active org (identical to the money/build gates) — use this for onboarding,
 *   set-dashboard-mode. When provided (setup-method's post-onboarding session-lag case),
 *   the role is checked in THAT org by the caller's own userId, which both validates the
 *   caller manages it AND closes the cross-tenant vector — a foreign org id fails closed.
 *
 * Fails CLOSED: no session, no resolvable org, no userId, no membership row, or a role
 * outside the org-manage set all return `{ ok: false }`.
 */
export async function assertOrgManager(
  targetOrgId?: string
): Promise<OrgManagerGate> {
  const session = await auth.api.getSession({ headers: await headers() })

  // Which org are we validating the caller's role in? Either the explicitly-passed target
  // org (setup-method) or the caller's active org (everyone else).
  const orgToCheck =
    targetOrgId ?? session?.session?.activeOrganizationId ?? null
  if (!orgToCheck) {
    return { ok: false, error: 'Not authenticated' }
  }

  // We MUST know who the human is before we can look up their membership. If userId is
  // missing we CANNOT identify them, so we fail CLOSED — Prisma silently drops an
  // `undefined` where-field, so a lookup with `userId: undefined` would degenerate to
  // "first member of orgToCheck" and hand a stranger someone else's membership.
  const userId = session?.user?.id ?? null
  if (!userId) {
    return { ok: false, error: 'Not authenticated' }
  }

  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgToCheck, userId },
    select: { role: true },
  })

  // `ORG_MANAGE_ROLES` is a readonly tuple of string literals; widen it to string[] so we
  // can test an arbitrary stored role against it.
  if (
    !membership ||
    !(ORG_MANAGE_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      error: 'Only an admin or owner can change organization settings.',
    }
  }

  return { ok: true, orgId: orgToCheck, userId, session }
}
