'use server'

import { auth, sendInviteAcceptEmail } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Membership lives in THREE tables; only `ba_member` decides anything and
// the other two are projections that must be written as a pair. The helpers live in
// @marginfront/db (packages/db/src/lib/membership.ts) because api-nest's team API writes
// the same three tables, and the Team UI calls THESE actions rather than that API —
// two implementations of the projection rule is the drift this prevents.
import {
  countOwnersForUpdate,
  deleteMembershipProjections,
  syncMembershipProjectionRole,
  writeMembershipProjections,
} from '@marginfront/db'

/**
 * Thrown inside a membership transaction to roll it back and carry ONE specific
 * refusal out to the caller. Without it the throw lands in the generic catch and
 * the person is told "Failed to remove member", which reads as a bug rather than
 * the deliberate rule it is.
 *
 * Not exported: a 'use server' module may only export async functions.
 */
class LastOwnerBlocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LastOwnerBlocked'
  }
}

// Types
// The role unions below include '| finance' so the finance role can
// be assigned through the normal role UI. The runtime bodies pass `data.role` straight to Prisma,
// whose `role` column is a free-form String, so no migration or Better Auth
// access-control change is needed (the assignment path never hits Better Auth).
// EXCEPTION: InviteMemberPayload.role stays {owner,admin,member} — it feeds the
// Better Auth invite path, which can't accept 'finance' (see its own comment).
export interface TeamMember {
  id: string
  memberId: string
  oderId: string
  role: 'owner' | 'admin' | 'member' | 'finance'
  createdAt: string
  user: {
    id: string
    name: string
    email: string
    image: string | null
  }
}

export interface Invitation {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member' | 'finance'
  status: 'pending' | 'accepted' | 'expired' | 'canceled'
  expiresAt: string
  inviterId: string
  inviter?: {
    id: string
    name: string
    email: string
  }
  createdAt: string
}

export interface AddMemberPayload {
  email: string
  role: 'owner' | 'admin' | 'member' | 'finance'
}

export interface InviteMemberPayload {
  email: string
  // Excludes 'finance': this payload feeds
  // authClient.organization.inviteMember(), the Better Auth path that only
  // accepts the org plugin's registered roles {owner, admin, member} and would
  // throw ROLE_NOT_FOUND for 'finance'. Inviting by email as finance would need
  // a Better Auth access-control change. Assign finance via the members
  // table dropdown or Add Member instead — both write directly to Prisma.
  role: 'owner' | 'admin' | 'member'
  message?: string
}

export interface UpdateMemberRolePayload {
  // '| developer' so the role-change action can assign the
  // build/operations seat. ba_member.role is free-form text, so it persists
  // cleanly; api-nest's UpdateMemberRoleDto enum matches.
  // '| legal' — the matter seat, same free-form persistence.
  role: 'owner' | 'admin' | 'member' | 'finance' | 'developer' | 'legal'
}

// Helper to map database member to our type
const mapMember = (member: any): TeamMember => ({
  id: member.id,
  memberId: member.id,
  oderId: member.organizationId,
  role: member.role as TeamMember['role'],
  createdAt: member.createdAt.toISOString(),
  user: {
    id: member.users.id,
    name: member.users.name,
    email: member.users.email,
    image: null, // Users table doesn't have image field
  },
})

// Helper to map database invitation to our type
const mapInvitation = (invitation: any): Invitation => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role as Invitation['role'],
  status: invitation.status as Invitation['status'],
  expiresAt: invitation.expiresAt.toISOString(),
  inviterId: invitation.inviterId,
  inviter: invitation.users
    ? {
        id: invitation.users.id,
        name: invitation.users.name,
        email: invitation.users.email,
      }
    : undefined,
  createdAt: invitation.createdAt.toISOString(),
})

/**
 * Get all team members for the current organization
 */
export async function getTeamMembers(): Promise<{
  success: boolean
  data?: TeamMember[]
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const members = await db.ba_member.findMany({
      where: {
        organizationId: orgId,
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return {
      success: true,
      data: members.map(mapMember),
    }
  } catch (error) {
    console.error('[getTeamMembers] Error:', error)
    return { success: false, error: 'Failed to fetch team members' }
  }
}

/**
 * Get a single team member by ID
 */
export async function getTeamMember(memberId: string): Promise<{
  success: boolean
  data?: TeamMember
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const member = await db.ba_member.findFirst({
      where: {
        id: memberId,
        organizationId: orgId,
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    })

    if (!member) {
      return { success: false, error: 'Team member not found' }
    }

    return {
      success: true,
      data: mapMember(member),
    }
  } catch (error) {
    console.error('[getTeamMember] Error:', error)
    return { success: false, error: 'Failed to fetch team member' }
  }
}

/**
 * Add a member directly to the organization (user must already exist)
 */
export async function addMember(data: AddMemberPayload): Promise<{
  success: boolean
  data?: TeamMember
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const currentUserId = session.user?.id

    // Check if current user has permission to add members (must be owner or admin)
    const currentMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: currentUserId,
      },
    })

    if (!currentMember || !['owner', 'admin'].includes(currentMember.role)) {
      return {
        success: false,
        error: 'Insufficient permissions to add members',
      }
    }

    // Find user by email
    const user = await db.users.findUnique({
      where: { email: data.email.toLowerCase() },
    })

    if (!user) {
      return {
        success: false,
        error: 'User not found. Please send an invitation instead.',
      }
    }

    // Check if user is already a member
    const existingMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: user.id,
      },
    })

    if (existingMember) {
      return {
        success: false,
        error: 'User is already a member of this organization',
      }
    }

    // Only owners can add other owners
    if (data.role === 'owner' && currentMember.role !== 'owner') {
      return { success: false, error: 'Only owners can add other owners' }
    }

    // The canonical row and BOTH projections in ONE transaction. Three
    // sequential statements reach the same steady state and leave a window open: a
    // dropped pooler connection between them mints a member with no
    // `user_organizations` row, who then never sees the org in their own org list.
    const member = await db.$transaction(async (tx) => {
      const row = await tx.ba_member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: orgId,
          userId: user.id,
          role: data.role,
          createdAt: new Date(),
        },
        include: {
          users: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      })

      await writeMembershipProjections(tx, {
        organizationId: orgId,
        userId: user.id,
        role: data.role,
        invitedBy: currentUserId,
      })

      return row
    })

    revalidatePath('/settings/team')

    return {
      success: true,
      data: mapMember(member),
    }
  } catch (error) {
    console.error('[addMember] Error:', error)
    return { success: false, error: 'Failed to add member' }
  }
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  memberId: string,
  data: UpdateMemberRolePayload
): Promise<{
  success: boolean
  data?: TeamMember
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const currentUserId = session.user?.id

    // Check if current user has permission
    const currentMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: currentUserId,
      },
    })

    if (!currentMember || !['owner', 'admin'].includes(currentMember.role)) {
      return {
        success: false,
        error: 'Insufficient permissions to update member roles',
      }
    }

    // Get the member to update
    const memberToUpdate = await db.ba_member.findFirst({
      where: {
        id: memberId,
        organizationId: orgId,
      },
    })

    if (!memberToUpdate) {
      return { success: false, error: 'Team member not found' }
    }

    // Cannot change your own role
    if (memberToUpdate.userId === currentUserId) {
      return { success: false, error: 'Cannot change your own role' }
    }

    // Only owners can promote to owner or demote owners
    if (
      (data.role === 'owner' || memberToUpdate.role === 'owner') &&
      currentMember.role !== 'owner'
    ) {
      return { success: false, error: 'Only owners can manage owner roles' }
    }

    // Admins can only change member roles, not other admins
    if (currentMember.role === 'admin' && memberToUpdate.role === 'admin') {
      return { success: false, error: 'Admins cannot change other admin roles' }
    }

    // LAST-OWNER GUARD + the role write + both projections, in ONE transaction
    //The guard is not redundant with the checks above: demoting the
    // only owner is unreachable one request at a time, but TWO owners demoting each
    // other at the same instant both pass every check above and the org lands at
    // ZERO owners, which nothing in the product can undo. countOwnersForUpdate takes
    // a FOR UPDATE lock, so the second transaction blocks until the first commits
    // and then correctly sees one owner left.
    const updatedMember = await db.$transaction(async (tx) => {
      if (memberToUpdate.role === 'owner' && data.role !== 'owner') {
        const ownerCount = await countOwnersForUpdate(tx, orgId)
        if (ownerCount <= 1) {
          throw new LastOwnerBlocked(
            'Cannot demote the last owner of the organization'
          )
        }
      }

      const row = await tx.ba_member.update({
        where: { id: memberId },
        data: { role: data.role },
        include: {
          users: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      })

      // Re-project in the SAME transaction so the three tables cannot disagree
      // about a role if the request dies between writes. Both projections are
      // lossy and neither gates access; syncing them stops them looking
      // authoritative AND wrong.
      await syncMembershipProjectionRole(tx, {
        organizationId: orgId,
        userId: memberToUpdate.userId,
        role: data.role,
      })

      return row
    })

    revalidatePath('/settings/team')

    return {
      success: true,
      data: mapMember(updatedMember),
    }
  } catch (error) {
    if (error instanceof LastOwnerBlocked) {
      return { success: false, error: error.message }
    }
    console.error('[updateMemberRole] Error:', error)
    return { success: false, error: 'Failed to update member role' }
  }
}

/**
 * Remove a member from the organization
 */
export async function removeMember(memberId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const currentUserId = session.user?.id

    // Check if current user has permission
    const currentMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: currentUserId,
      },
    })

    if (!currentMember || !['owner', 'admin'].includes(currentMember.role)) {
      return {
        success: false,
        error: 'Insufficient permissions to remove members',
      }
    }

    // Get the member to remove
    const memberToRemove = await db.ba_member.findFirst({
      where: {
        id: memberId,
        organizationId: orgId,
      },
    })

    if (!memberToRemove) {
      return { success: false, error: 'Team member not found' }
    }

    // Cannot remove yourself
    if (memberToRemove.userId === currentUserId) {
      return {
        success: false,
        error: 'Cannot remove yourself from the organization',
      }
    }

    // Only owners can remove owners
    if (memberToRemove.role === 'owner' && currentMember.role !== 'owner') {
      return { success: false, error: 'Only owners can remove other owners' }
    }

    // Admins cannot remove other admins
    if (memberToRemove.role === 'admin' && currentMember.role === 'admin') {
      return { success: false, error: 'Admins cannot remove other admins' }
    }

    const userId = memberToRemove.userId

    // LAST-OWNER GUARD + all three membership rows, in ONE transaction.
    //
    // The guard has to be a LOCKED read, not a count, and it has to sit inside this
    // transaction. Postgres runs READ COMMITTED here and a count takes no locks, so
    // two concurrent owner-removals each read ownerCount = 2, each delete a DIFFERENT
    // owner, and the org ends with ZERO owners and no product path back.
    // countOwnersForUpdate takes SELECT ... FOR UPDATE on the owner rows, which only
    // protects the delete performed on that same client.
    //
    // deleteMembershipProjections is purely subtractive, so it is safe for a member
    // who never had projection rows.
    //
    // The ba_session cleanup below stays OUTSIDE the transaction, matching api-nest:
    // best-effort revocation of a different table, not part of the zero-owners
    // invariant.
    try {
      await db.$transaction(async (tx) => {
        if (memberToRemove.role === 'owner') {
          const ownerCount = await countOwnersForUpdate(tx, orgId)
          if (ownerCount <= 1) {
            throw new LastOwnerBlocked(
              'Cannot remove the last owner of the organization'
            )
          }
        }

        await tx.ba_member.delete({
          where: { id: memberId },
        })

        await deleteMembershipProjections(tx, {
          organizationId: orgId,
          userId,
        })
      })
    } catch (error) {
      if (error instanceof LastOwnerBlocked) {
        return { success: false, error: error.message }
      }
      throw error
    }

    // CRITICAL: Invalidate all sessions that have activeOrganizationId set to this organization
    // This prevents the removed user from accessing the organization with their existing session
    await db.ba_session.deleteMany({
      where: {
        userId: userId,
        activeOrganizationId: orgId,
      },
    })

    console.log(
      `[removeMember] Deleted sessions for user ${userId} with activeOrganizationId ${orgId}`
    )

    revalidatePath('/settings/team')

    return { success: true }
  } catch (error) {
    console.error('[removeMember] Error:', error)
    return { success: false, error: 'Failed to remove member' }
  }
}

/**
 * Get all pending invitations for the organization
 */
export async function getInvitations(): Promise<{
  success: boolean
  data?: Invitation[]
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const invitations = await db.ba_invitation.findMany({
      where: {
        organizationId: orgId,
        status: 'pending',
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: invitations.map(mapInvitation),
    }
  } catch (error) {
    console.error('[getInvitations] Error:', error)
    return { success: false, error: 'Failed to fetch invitations' }
  }
}

/**
 * Resend a pending invitation
 */
export async function resendInvitation(invitationId: string): Promise<{
  success: boolean
  data?: Invitation
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const currentUserId = session.user?.id

    // Check if current user has permission
    const currentMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: currentUserId,
      },
    })

    if (!currentMember || !['owner', 'admin'].includes(currentMember.role)) {
      return {
        success: false,
        error: 'Insufficient permissions to resend invitations',
      }
    }

    // Get the invitation
    const invitation = await db.ba_invitation.findFirst({
      where: {
        id: invitationId,
        organizationId: orgId,
      },
    })

    if (!invitation) {
      return { success: false, error: 'Invitation not found' }
    }

    if (invitation.status !== 'pending') {
      return { success: false, error: 'Can only resend pending invitations' }
    }

    // The email needs the org name for its subject + body.
    const organization = await db.organizations.findUnique({
      where: { id: orgId },
      select: { name: true },
    })

    if (!organization) {
      return { success: false, error: 'Organization not found' }
    }

    // Re-deliver the SAME accept-page email (/invite/accept/{invitationId}) via
    // the shared helper the initial invite uses. We deliberately touch NO
    // invite-magic ba_verification token: the accept page keys off the
    // invitation id + Better Auth's own auth, so that token is
    // unused here and rotating it risks an "auth looking for the old token"
    // stuck state. Calling the helper directly also bypasses
    // sendInvitationEmail's token-dedup, which would otherwise skip the resend.
    // It throws if Resend rejects, so a failed send falls through to the catch
    // and we never report a success we didn't deliver.
    await sendInviteAcceptEmail({
      email: invitation.email,
      organizationName: organization.name,
      invitationId,
    })

    // Email delivered — now re-arm the invite window (+7 days) and keep it
    // pending. Done after the send so a delivery failure mutates nothing.
    const newExpiresAt = new Date()
    newExpiresAt.setDate(newExpiresAt.getDate() + 7)

    const updatedInvitation = await db.ba_invitation.update({
      where: { id: invitationId },
      data: {
        expiresAt: newExpiresAt,
        status: 'pending',
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    })

    revalidatePath('/settings/team')

    return {
      success: true,
      data: mapInvitation(updatedInvitation),
    }
  } catch (error) {
    console.error('[resendInvitation] Error:', error)
    return { success: false, error: 'Failed to resend invitation' }
  }
}

/**
 * Cancel/revoke a pending invitation
 */
export async function cancelInvitation(invitationId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const currentUserId = session.user?.id

    // Check if current user has permission
    const currentMember = await db.ba_member.findFirst({
      where: {
        organizationId: orgId,
        userId: currentUserId,
      },
    })

    if (!currentMember || !['owner', 'admin'].includes(currentMember.role)) {
      return {
        success: false,
        error: 'Insufficient permissions to cancel invitations',
      }
    }

    // Get the invitation
    const invitation = await db.ba_invitation.findFirst({
      where: {
        id: invitationId,
        organizationId: orgId,
      },
    })

    if (!invitation) {
      return { success: false, error: 'Invitation not found' }
    }

    if (invitation.status !== 'pending') {
      return { success: false, error: 'Can only cancel pending invitations' }
    }

    // Update status to canceled (or delete)
    await db.ba_invitation.update({
      where: { id: invitationId },
      data: { status: 'canceled' },
    })

    revalidatePath('/settings/team')

    return { success: true }
  } catch (error) {
    console.error('[cancelInvitation] Error:', error)
    return { success: false, error: 'Failed to cancel invitation' }
  }
}

/**
 * Get team members and invitations combined (for team page)
 */
export async function getTeamData(): Promise<{
  success: boolean
  data?: {
    members: TeamMember[]
    invitations: Invitation[]
  }
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const [members, invitations] = await Promise.all([
      db.ba_member.findMany({
        where: { organizationId: orgId },
        include: {
          users: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.ba_invitation.findMany({
        where: {
          organizationId: orgId,
          status: 'pending',
        },
        include: {
          users: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    return {
      success: true,
      data: {
        members: members.map(mapMember),
        invitations: invitations.map(mapInvitation),
      },
    }
  } catch (error) {
    console.error('[getTeamData] Error:', error)
    return { success: false, error: 'Failed to fetch team data' }
  }
}

/**
 * Public invitation details type
 */
export interface PublicInvitationDetails {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member' | 'finance'
  status: 'pending' | 'accepted' | 'expired' | 'canceled'
  expiresAt: string
  organizationId: string
  organizationName: string
  inviterName: string | null
  isExpired: boolean
}

/**
 * Get public invitation details by ID (no auth required)
 * Used for the invitation acceptance page
 */
export async function getPublicInvitationDetails(
  invitationId: string
): Promise<{
  success: boolean
  data?: PublicInvitationDetails
  error?: string
}> {
  try {
    const invitation = await db.ba_invitation.findUnique({
      where: { id: invitationId },
      include: {
        organizations: {
          select: {
            name: true,
          },
        },
        users: {
          select: {
            name: true,
          },
        },
      },
    })

    if (!invitation) {
      return { success: false, error: 'Invitation not found' }
    }

    const isExpired =
      invitation.expiresAt < new Date() || invitation.status !== 'pending'

    return {
      success: true,
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role as PublicInvitationDetails['role'],
        status: invitation.status as PublicInvitationDetails['status'],
        expiresAt: invitation.expiresAt.toISOString(),
        organizationId: invitation.organizationId,
        organizationName:
          invitation.organizations?.name || 'Unknown Organization',
        inviterName: invitation.users?.name || null,
        isExpired,
      },
    }
  } catch (error) {
    console.error('[getPublicInvitationDetails] Error:', error)
    return { success: false, error: 'Failed to fetch invitation details' }
  }
}
