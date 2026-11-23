/**
 * The membership writes that happen inside node_modules.
 *
 * Better Auth's organization plugin OWNS `ba_member` (auth.ts maps its `member` model to that
 * table) and creates, re-roles and deletes rows there from its own route handlers. No Prisma call
 * appears in our source, so neither the membership sweep nor a reviewer can see those writes, and
 * the plugin knows nothing about `user_organizations` or `team_members`. These hooks are the only
 * place the projections can be kept in step with them.
 *
 * SIX ROUTES CAN CHANGE MEMBERSHIP, and only five of them can be hooked. All are live at
 * /api/auth/organization/* whether our UI calls them or not; a session is the only requirement:
 *
 *   create              -> afterAddMember          org creation mints the creator's owner row
 *   accept-invitation   -> afterAcceptInvitation   the main join path
 *   add-member          -> afterAddMember
 *   update-member-role  -> afterUpdateMemberRole
 *   remove-member       -> afterRemoveMember
 *   delete              -> afterDeleteOrganization bulk-deletes every ba_member row for the org
 *                                                  with NO per-member hook, so afterRemoveMember
 *                                                  never fires and only an org-wide sweep keeps up
 *   leave               -> NOTHING. See below.
 *
 * THE SIXTH DOOR: /organization/leave. Its handler calls `adapter.deleteMember` and fires no
 * organizationHooks at all (node_modules/better-auth/dist/plugins/organization/routes/
 * crud-members.mjs), and Better Auth 1.5.6 ships no leave hook to attach. It is mounted regardless
 * of whether our UI offers it (organization.mjs), so any session holder can POST it and lose their
 * canonical row while both mirrors survive. It is closed one level up instead, by a Better Auth
 * `hooks.after` matcher on that path in ./auth.ts, which calls `leftOrganization` below.
 *
 * BEST-EFFORT, NEVER FATAL. Better Auth AWAITS these hooks, so a throw fails the request that
 * triggered it: a projection row that could not be written would block a signup or an invite
 * acceptance. The projections gate nothing (every authorization surface reads `ba_member`), so
 * the request goes through and the failure is logged with MEMBERSHIP_PROJECTION_DRIFT and the
 * step an operator can take in the product. The hook runs after Better Auth has committed the
 * canonical row on its own connection, so there is no transaction to join. What IS guaranteed is
 * that the two mirrors move together: every helper opens its own transaction when handed a
 * top-level client (packages/db/src/lib/membership.ts, `runPaired`).
 */

import {
  deleteMembershipProjections,
  deleteOrganizationMembershipProjections,
  syncMembershipProjectionRole,
  writeMembershipProjections,
  type MembershipProjectionClient,
} from '@marginfront/db'

/** The subset of Better Auth's `member` payload these hooks read. */
interface BetterAuthMember {
  organizationId: string
  userId: string
  role: string
}

/**
 * The one string an operator greps for. Kept out of the sentence so it survives any rewording of
 * the message around it.
 */
export const MEMBERSHIP_DRIFT_MARKER = 'MEMBERSHIP_PROJECTION_DRIFT'

async function bestEffort(
  hook: string,
  scope: string,
  remedy: string,
  write: () => Promise<void>
): Promise<void> {
  try {
    await write()
  } catch (error) {
    console.error(
      `[membership] ${MEMBERSHIP_DRIFT_MARKER} Better Auth ${hook}: could not update the ` +
        `user_organizations and team_members rows for ${scope}. Access is correct, because ` +
        `permission checks read ba_member. ${remedy}`,
      error
    )
  }
}

const REINVITE_REMEDY =
  'Nothing is blocked. To rebuild the rows, an owner or admin can remove this user under ' +
  'Settings, then Team, and invite them again.'

const ROLE_REMEDY = 'No action is needed: roles are read from ba_member.'

const REMOVAL_REMEDY =
  'The leftover rows grant nothing. To clear them, an owner or admin can invite this user ' +
  'again under Settings, then Team, and remove them after they join.'

const DELETION_REMEDY = 'The organization is gone, so no action is needed.'

const memberScope = (member: BetterAuthMember) =>
  `user ${member.userId} in org ${member.organizationId}`

/**
 * Build the `organizationHooks` object for Better Auth's organization plugin.
 *
 * Takes the Prisma client as an argument rather than importing one, so the hooks can be exercised
 * against a stand-in store without booting Better Auth or opening a database connection.
 */
export function membershipProjectionHooks(prisma: MembershipProjectionClient) {
  return {
    afterAddMember: async ({ member }: { member: BetterAuthMember }) =>
      bestEffort('afterAddMember', memberScope(member), REINVITE_REMEDY, () =>
        writeMembershipProjections(prisma, {
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        })
      ),

    afterAcceptInvitation: async ({ member }: { member: BetterAuthMember }) =>
      bestEffort('afterAcceptInvitation', memberScope(member), REINVITE_REMEDY, () =>
        writeMembershipProjections(prisma, {
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        })
      ),

    // Better Auth hands over the ALREADY-UPDATED member row, so `member.role` is the new role.
    afterUpdateMemberRole: async ({ member }: { member: BetterAuthMember }) =>
      bestEffort('afterUpdateMemberRole', memberScope(member), ROLE_REMEDY, () =>
        syncMembershipProjectionRole(prisma, {
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        })
      ),

    afterRemoveMember: async ({ member }: { member: BetterAuthMember }) =>
      bestEffort('afterRemoveMember', memberScope(member), REMOVAL_REMEDY, () =>
        deleteMembershipProjections(prisma, {
          organizationId: member.organizationId,
          userId: member.userId,
        })
      ),

    /**
     * Org-wide, because Better Auth deletes the org's ba_member rows in one bulk statement and
     * fires no afterRemoveMember for any of them. `user_organizations` would follow by FK cascade
     * on its own; `team_members` has no FK to `organizations` and would be left holding rows
     * pointing at an org id that no longer exists.
     */
    afterDeleteOrganization: async ({
      organization,
    }: {
      organization: { id: string }
    }) =>
      bestEffort('afterDeleteOrganization', `org ${organization.id}`, DELETION_REMEDY, () =>
        deleteOrganizationMembershipProjections(prisma, {
          organizationId: organization.id,
        })
      ),
  }
}

/**
 * The projection half of /api/auth/organization/leave, which has no organizationHooks entry to
 * hang it on. Called from the `hooks.after` matcher in ./auth.ts, which is the only place Better
 * Auth lets us see that route at all.
 *
 * Same best-effort contract as the five above, and the same reason: it runs after Better Auth has
 * committed the canonical delete, so throwing here would fail a request whose real work is already
 * done and irreversible.
 */
export async function leftOrganization(
  prisma: MembershipProjectionClient,
  member: BetterAuthMember
): Promise<void> {
  await bestEffort('organization/leave', memberScope(member), REMOVAL_REMEDY, () =>
    deleteMembershipProjections(prisma, {
      organizationId: member.organizationId,
      userId: member.userId,
    })
  )
}
