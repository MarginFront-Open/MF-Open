/**
 * assert-build-manager.ts: the ONE server-side lock that stops a plain member
 * from editing the build plumbing.
 *
 * WHY THIS EXISTS (plain English): hiding the BUILD screens' buttons in the nav
 * (agents, customers, the meters / signal definitions, API keys) isn't
 * protection. Anyone in the org can call the server action directly (or hit the
 * URL), so each action must check "are you allowed to manage the plumbing?", not
 * only "are you logged in and in an org?". This helper is the single gate every
 * BUILD write action calls before it does anything, so the role check lives in
 * ONE place instead of being copy-pasted into a dozen files.
 *
 * THE ROLE LINE (do NOT blur it): BUILD = the technical/operations plumbing that
 * PRODUCES a cost (a meter, the model an agent runs on, an API key, a customer
 * record). Developers own this. That is DISTINCT from MONEY (the books: invoices,
 * pricing, tax, cost CLASSIFICATION — see assert-money-manager.ts) and from TRUE
 * org management (invite members, delete the org — owner/admin only). BUILD is
 * owner/admin/developer (MANAGE_BUILD_ROLES).
 *
 * NOTE this is intentionally NOT a 'use server' file. A 'use server' module may
 * only export async functions — this module also exports its result TYPE, so it's
 * a plain server-only helper that the Server Actions import. It never becomes a
 * callable action itself, so it can't be invoked from the client. Mirrors
 * assert-money-manager.ts exactly.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
// Single source of truth for "who can manage the build plumbing" — shared with
// api-nest's agents/customers/signals/api-keys controllers so the two surfaces
// can never drift. owner | admin | developer.
import { MANAGE_BUILD_ROLES } from '@marginfront/db'

/**
 * The result of the gate.
 *
 * Return-based (not throw-based) ON PURPOSE: every build action already returns
 * `{ success: false, error: string }` on failure, so a caller can do
 * `if (!gate.ok) return { success: false, error: gate.error }` and stay perfectly
 * in its existing contract. Throwing here would surface as an unhandled 500
 * instead of the clean error the UI already knows how to render.
 *
 * Field-for-field identical to MoneyManagerGate so the two gates are
 * drop-in interchangeable at a call site.
 */
export type BuildManagerGate =
  | {
      ok: true
      orgId: string
      userId: string
      session: Awaited<ReturnType<typeof auth.api.getSession>>
    }
  | { ok: false; error: string }

/**
 * Gate a BUILD WRITE: confirm the caller is a real member of their active org AND
 * holds a Manage-BUILD role (owner / admin / developer). Call this at the very top of
 * every build write action; bail on `!gate.ok` before any DB mutation.
 *
 * Fails CLOSED: no session, no active org, no membership row, or a role outside
 * the Manage-BUILD set all return `{ ok: false }`.
 */
export async function assertBuildManager(): Promise<BuildManagerGate> {
  const session = await auth.api.getSession({ headers: await headers() })

  const orgId = session?.session?.activeOrganizationId
  if (!orgId) {
    return { ok: false, error: 'Not authenticated' }
  }

  const userId = session.user?.id ?? null

  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })

  // `MANAGE_BUILD_ROLES` is a readonly tuple of string literals; widen it to
  // string[] so we can test an arbitrary stored role against it.
  if (
    !membership ||
    !(MANAGE_BUILD_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      error:
        'Only owner, admin, or developer roles can manage agents, customers, signals, or API keys.',
    }
  }

  return { ok: true, orgId, userId: userId!, session }
}
