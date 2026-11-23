/**
 * assert-law-manager.ts: the ONE server-side lock on every Law-tab action:
 * Matters CRUD, routing rules, manual assignment, and the
 * per-matter audit export.
 *
 * Clone of assert-money-manager.ts with the role set swapped to
 * LAW_MANAGE_ROLES (owner/admin/finance/legal). Cloned rather than
 * parameterized on purpose: a shared helper taking "any role set" invites a
 * call with the wrong set. One gate file per surface keeps each allow-list
 * greppable.
 *
 * The Law export calls this gate too, so a plain member can never pull a firm's
 * matter cost data by URL.
 *
 * NOT a 'use server' file — it exports a type, so it stays a plain
 * server-only helper the Server Actions import.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { LAW_MANAGE_ROLES } from '@marginfront/db'

export type LawManagerGate =
  | {
      ok: true
      orgId: string
      userId: string
    }
  | { ok: false; error: string }

/**
 * Gate a Law-tab action: confirm the caller is a real member of their real
 * org AND holds a LAW_MANAGE role (owner / admin / finance / legal). Call at
 * the very top of every matters/rules/assignment/export action; bail on
 * `!gate.ok` before any DB access.
 *
 * Fails CLOSED: no session, no active org, no membership row, or a role
 * outside the set all return `{ ok: false }`.
 */
export async function assertLawManager(): Promise<LawManagerGate> {
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

  if (
    !membership ||
    !(LAW_MANAGE_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      error:
        'Only legal, finance, admin, or owner roles can work with matters.',
    }
  }

  return { ok: true, orgId, userId: userId! }
}
