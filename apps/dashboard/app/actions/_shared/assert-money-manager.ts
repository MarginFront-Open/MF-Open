/**
 * assert-money-manager.ts — the ONE server-side lock on money writes.
 *
 * WHY THIS EXISTS: hiding a button in the nav doesn't stop a plain member from
 * calling the server action directly (or hitting the URL) and editing invoices,
 * GL codes, pricing or tax settings. This helper is the
 * single gate every money WRITE action calls before it does anything, so the role
 * check lives in ONE place instead of being copy-pasted into a dozen files (where
 * one of them would inevitably drift or get forgotten).
 *
 * NOTE this is intentionally NOT a 'use server' file. A 'use server' module may
 * only export async functions — this module also exports its result TYPE, so it's
 * a plain server-only helper that the Server Actions import. It never becomes a
 * callable action itself, so it can't be invoked from the client.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
// Single source of truth for "who can change the books" — shared with api-nest's
// invoice controller so the two surfaces can never drift. owner | admin | finance.
import { MANAGE_MONEY_ROLES } from '@marginfront/db'

/**
 * The result of the gate.
 *
 * Return-based (not throw-based) ON PURPOSE: every money action already returns
 * `{ success: false, error: string }` on failure, so a caller can do
 * `if (!gate.ok) return { success: false, error: gate.error }` and stay perfectly
 * in its existing contract. Throwing here would surface as an unhandled 500
 * instead of the clean error the UI already knows how to render.
 *
 * On success it hands back the org id and user id so the caller doesn't have
 * to re-fetch the session.
 */
export type MoneyManagerGate =
  | {
      ok: true
      orgId: string
      userId: string
      session: Awaited<ReturnType<typeof auth.api.getSession>>
    }
  | { ok: false; error: string }

/**
 * Gate a money WRITE: confirm the caller is a real member of their active org AND
 * holds a Manage-MONEY role (owner / admin / finance). Call this at the very top
 * of every money write action; bail on `!gate.ok` before any DB mutation.
 *
 * Fails CLOSED: no session, no active org, no membership row, or a role outside
 * the Manage-MONEY set all return `{ ok: false }`.
 */
export async function assertMoneyManager(): Promise<MoneyManagerGate> {
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

  // `MANAGE_MONEY_ROLES` is a readonly tuple of string literals; widen it to
  // string[] so we can test an arbitrary stored role against it.
  if (
    !membership ||
    !(MANAGE_MONEY_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      error:
        'Only finance, admin, or owner roles can change billing or financial records.',
    }
  }

  return { ok: true, orgId, userId: userId!, session }
}
