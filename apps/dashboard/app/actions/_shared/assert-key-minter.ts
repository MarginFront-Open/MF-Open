/**
 * assert-key-minter.ts — the server-side door for the dashboard's own
 * API-key mint/revoke actions (role-mirrored API keys).
 *
 * WHY THIS IS NOT assertBuildManager: MINT_KEY_ROLES is DELIBERATELY WIDER
 * than MANAGE_BUILD_ROLES — it adds 'finance', so a finance user can reach
 * this door to mint a finance-scoped key for their accountant's billing
 * script. Reusing assertBuildManager
 * here would either lock finance out of minting or
 * open every OTHER build write (agents, customers, signals) to finance — a
 * real breach. Mirrors api-nest's MINT_KEY_ROLES route gate on the api-keys
 * controller so the dashboard's parallel create/revoke actions can't drift
 * from the door api-nest already enforces.
 *
 * This gate only answers "may you reach the mint/revoke door at all." It does
 * NOT decide which key role you may stamp — that ceiling is
 * mintableKeyRoles(minterRole), enforced by the caller using the minterRole
 * this gate returns.
 *
 * The minter's role is looked up in their active org
 * (session.activeOrganizationId).
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { MINT_KEY_ROLES } from '@marginfront/db'

export type KeyMinterGate =
  | {
      ok: true
      orgId: string
      userId: string
      minterRole: string
    }
  | { ok: false; error: string }

/**
 * Gate reaching the API-key mint/revoke door: confirm the caller is a real
 * member of their active org AND holds a MINT_KEY_ROLES role (owner / admin /
 * developer / finance). Returns the minter's role so the caller can enforce
 * the per-role mint ceiling on top of this.
 *
 * Fails CLOSED: no session, no active org, no membership row, or a role
 * outside MINT_KEY_ROLES all return `{ ok: false }`.
 */
export async function assertKeyMinter(): Promise<KeyMinterGate> {
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
    !(MINT_KEY_ROLES as readonly string[]).includes(membership.role)
  ) {
    return {
      ok: false,
      error:
        'Only owner, admin, developer, or finance roles can create or revoke API keys.',
    }
  }

  return { ok: true, orgId, userId: userId!, minterRole: membership.role }
}
