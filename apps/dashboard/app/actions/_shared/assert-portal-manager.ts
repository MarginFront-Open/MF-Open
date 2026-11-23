/**
 * Server-side role gate for every action that opens a customer's billing
 * portal. A portal session shows the books, so it uses MANAGE_MONEY_ROLES;
 * the customer detail page mirrors that set with canManageMoney().
 * Cloned from assert-money-manager.ts per the one-gate-file-per-surface rule
 * in assert-law-manager.ts.
 *
 * The role is read in the caller's active org (session.activeOrganizationId).
 *
 * Not a 'use server' file: it exports a type.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { MANAGE_MONEY_ROLES } from '@marginfront/db'

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

export type PortalManagerGate =
  | {
      ok: true
      orgId: string
      userId: string
      session: Session
    }
  | { ok: false; reason: 'unauthenticated' | 'forbidden'; error: string }

/** Call first in every portal action and bail on `!gate.ok` before any lookup or mint. */
export async function assertPortalManager(): Promise<PortalManagerGate> {
  const session = await auth.api.getSession({ headers: await headers() })

  const orgId = session?.session?.activeOrganizationId
  const userId = session?.user?.id
  if (!session || !orgId || !userId) {
    return {
      ok: false,
      reason: 'unauthenticated',
      error: 'You need to be signed in.',
    }
  }

  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })

  if (
    !membership ||
    !(MANAGE_MONEY_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      reason: 'forbidden',
      error:
        'Only finance, admin, or owner roles can open or share a customer portal.',
    }
  }

  return { ok: true, orgId, userId, session }
}
