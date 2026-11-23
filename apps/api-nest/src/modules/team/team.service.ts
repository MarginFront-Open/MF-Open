import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ConfigService } from '@nestjs/config';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { SendInvitationDto } from './dto/send-invitation.dto';
import { v4 as uuidv4 } from 'uuid';
import { canGrantRole, hashApiKeyForLookup } from '@marginfront/db';
import { ORG_MANAGE_ROLES } from '../../common/guards/org-role.guard';
// The projection writes and the last-owner lock live in @marginfront/db
// (packages/db/src/lib/membership.ts) because the DASHBOARD writes membership too,
// through its own Server Actions that never reach api-nest. One implementation, so
// the two apps cannot disagree about what a projected role is.
import {
  countOwnersForUpdate,
  deleteMembershipProjections,
  syncMembershipProjectionRole,
  writeMembershipProjections,
} from '@marginfront/db';

/**
 * Roles the EMAIL-INVITATION path (team_invitations) can actually persist.
 *
 * team_invitations.role is a Postgres ENUM limited to {admin, member} (see
 * schema.prisma -> enum_team_invitations_role). So even though the grant matrix would
 * authorize an owner to invite at finance/owner, the database cannot store those values
 * on an invitation. Rather than let Prisma throw a raw 500, sendInvitation rejects them
 * with a clear message. This mirrors the dashboard's documented invite-path limitation
 * (see apps/dashboard/app/actions/team.ts InviteMemberPayload comment): finance/owner are
 * assigned via Add Member or a role change, both of which write the free-form ba_member
 * column and therefore support every role.
 */
const INVITABLE_ROLES: readonly string[] = ['admin', 'member'];

@Injectable()
export class TeamService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  /**
   * Load the acting caller's CANONICAL membership row (ba_member).
   * This is the single place every mutating method learns the actor's real role from, so
   * the role the grant matrix and the relational guards check is the same role the
   * coarse OrgRoleGuard authorized against. Returns null if the caller isn't a member
   * (e.g. an API key, which has no human ba_member row) — callers must fail closed on null.
   */
  private async getActorMembership(organizationId: string, actorUserId: string) {
    return this.prisma.ba_member.findFirst({
      where: { organizationId, userId: actorUserId },
      select: { role: true, userId: true },
    });
  }

  async getTeamMembers(organizationId: string) {
    // Canonical membership store is ba_member: the same table OrgRoleGuard authorizes
    // against and every mutation here writes.
    const members = await this.prisma.ba_member.findMany({
      where: { organizationId },
      include: {
        users: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return members;
  }

  async getTeamMember(organizationId: string, memberId: string) {
    const member = await this.prisma.ba_member.findFirst({
      where: { id: memberId, organizationId },
      include: {
        users: { select: { id: true, name: true, email: true, createdAt: true } },
      },
    });

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    return member;
  }

  async addMember(organizationId: string, userId: string, role: string, actorUserId: string) {
    // GRANT CAP: the actor may only add a member at a role inside their grantable set.
    // canGrantRole fails closed when the actor isn't a member (actorRole undefined) — so an
    // API key, which has no ba_member row, can never add members through this path.
    const actor = await this.getActorMembership(organizationId, actorUserId);
    if (!canGrantRole(actor?.role ?? '', role)) {
      throw new ForbiddenException(`You are not allowed to grant the "${role}" role.`);
    }

    // Check if the target user exists at all.
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if the target user is already a member.
    const existingMember = await this.prisma.ba_member.findFirst({
      where: { organizationId, userId },
    });
    if (existingMember) {
      throw new BadRequestException('User is already a team member');
    }

    // The canonical row and BOTH projections in ONE transaction. Writing team_members alone
    // leaves the member with no `user_organizations` row, so the org never appears in their
    // own org list. Two separate statements would cover the steady state and leave a window open: a pod restart or a dropped pooler connection landing between
    // the commits mints exactly the orphan row this code exists to prevent. See
    // packages/db/src/lib/membership.ts for which table is canonical.
    const member = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ba_member.create({
        data: {
          id: uuidv4(),
          organizationId,
          userId,
          role,
          createdAt: new Date(),
        },
        include: {
          users: { select: { id: true, name: true, email: true } },
        },
      });

      await writeMembershipProjections(tx, {
        organizationId,
        userId,
        role,
        invitedBy: actorUserId,
      });

      return row;
    });

    return member;
  }

  async updateMemberRole(
    organizationId: string,
    memberId: string,
    updateDto: UpdateMemberRoleDto,
    actorUserId: string,
  ) {
    const newRole = updateDto.role as string;

    // Defense in depth: the coarse OrgRoleGuard already restricts this route to owner/admin
    // for HUMAN callers, but it lets a same-org API key through without a role check. Re-role
    // is privilege-granting, so we re-assert owner/admin here against the canonical row.
    const actor = await this.getActorMembership(organizationId, actorUserId);
    // ORG_MANAGE_ROLES is the local owner/admin string[] from org-role.guard.ts; plain
    // .includes() against the stored role string. Owner/admin only.
    if (!actor || !ORG_MANAGE_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Insufficient permissions to update member roles');
    }

    const target = await this.prisma.ba_member.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!target) {
      throw new NotFoundException('Team member not found');
    }

    // SELF-PROMOTION BLOCK. Without this, any owner/admin could set their OWN role to owner.
    if (target.userId === actorUserId) {
      throw new ForbiddenException('Cannot change your own role');
    }

    // OWNER-ONLY-TOUCHES-OWNER: only an owner may promote someone TO owner or alter an
    // existing owner. Stops an admin from demoting an owner even though admin can otherwise
    // grant admin/finance/member.
    if ((newRole === 'owner' || target.role === 'owner') && actor.role !== 'owner') {
      throw new ForbiddenException('Only owners can manage owner roles');
    }

    // ADMIN-CANT-TOUCH-ADMIN: admins may manage members/finance, not their peers.
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new ForbiddenException('Admins cannot change other admin roles');
    }

    // GRANT CAP: the new role must be inside the actor's grantable set.
    if (!canGrantRole(actor.role, newRole)) {
      throw new ForbiddenException(`You are not allowed to grant the "${newRole}" role.`);
    }

    // LAST-OWNER GUARD + the role write, in ONE transaction so concurrent demotions can't
    // both pass the check and orphan the org. The check (a locked recount of owners) and the
    // write live in the SAME transaction; when we're demoting an owner we first FOR UPDATE-lock
    // the org's owner rows, so a second concurrent owner-demotion blocks until this one commits
    // and then correctly sees only one owner left. See countOwnersForUpdate for the full why.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (target.role === 'owner' && newRole !== 'owner') {
        const ownerCount = await countOwnersForUpdate(tx, organizationId);
        if (ownerCount <= 1) {
          throw new ForbiddenException('Cannot demote the last owner of the organization');
        }
      }

      const row = await tx.ba_member.update({
        where: { id: memberId },
        data: { role: newRole },
        include: {
          users: { select: { id: true, name: true, email: true } },
        },
      });

      // Re-project in the SAME transaction so the three tables cannot disagree about
      // a role if the request dies between writes. Both projections are lossy and neither gates
      // access; syncing them just stops them looking authoritative AND wrong.
      await syncMembershipProjectionRole(tx, {
        organizationId,
        userId: target.userId,
        role: newRole,
      });

      return row;
    });

    return updated;
  }

  async removeMember(organizationId: string, memberId: string, actorUserId: string) {
    // Defense in depth (same reasoning as updateMemberRole): re-assert owner/admin against
    // the canonical row so a same-org API key can't slip past the coarse guard.
    const actor = await this.getActorMembership(organizationId, actorUserId);
    // ORG_MANAGE_ROLES is the local owner/admin string[] from org-role.guard.ts; plain
    // .includes() against the stored role string. Owner/admin only.
    if (!actor || !ORG_MANAGE_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Insufficient permissions to remove members');
    }

    const target = await this.prisma.ba_member.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!target) {
      throw new NotFoundException('Team member not found');
    }

    // Can't remove yourself (avoids an admin/owner accidentally locking themselves out and
    // sidestepping the last-owner guard on their own row).
    if (target.userId === actorUserId) {
      throw new ForbiddenException('Cannot remove yourself from the organization');
    }

    // OWNER-ONLY: only an owner may remove an owner.
    if (target.role === 'owner' && actor.role !== 'owner') {
      throw new ForbiddenException('Only owners can remove other owners');
    }

    // ADMIN-CANT-TOUCH-ADMIN.
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new ForbiddenException('Admins cannot remove other admins');
    }

    const removedUserId = target.userId;

    // REVOCATION — the point of removeMember is to actually cut the user off, so four doors
    // have to close, each guarding a different surface:
    //
    // 1) ba_member row deleted: the canonical membership OrgRoleGuard, this service,
    //    OrgAccessGuard and PaymentProvidersController all authorize against. After this
    //    the user is no longer "a member" for any ba_member check.
    //
    // 2) user_organizations row deleted: a projection no surface authorizes off
    //    (OrganizationsService checks ba_member). Three dashboard server actions read the
    //    table as an org LIST (get-organizations-onboarding-status, check-org-by-name,
    //    onboarding), so a row left behind would keep listing the org for a removed person.
    //
    // 3) team_members row deleted: team_members is a MIRROR that no surface
    //    authorizes off. Deleting it keeps the mirror in step with the canonical store.
    //    Purely SUBTRACTIVE: it can only take access away, never grant it.
    //
    // 4) Stored sessions killed (below, OUTSIDE the transaction): drop any ba_session whose
    //    ACTIVE org is this one.
    //
    // The LAST-OWNER GUARD + doors (1)-(3) run in ONE transaction so two concurrent
    // owner-removals can't both pass the count check and orphan the org, and so no crash can
    // leave a HALF-REMOVED member holding one table's authority. When removing an owner we FOR
    // UPDATE-lock the org's owner rows first (countOwnersForUpdate); the second concurrent
    // removal blocks until this commits, then re-reads only one owner left and is rejected.
    //
    // What removal does NOT revoke instantly:
    //   - HUMAN JWT auth (authMethod 'jwt', see auth.service.ts) is STATELESS: the token is not
    //     stored in ba_session, so the session delete is a no-op for it. A JWT minted before
    //     removal keeps working until it expires.
    //   - The ba_member checks above also short-circuit on a `user.organizationId === orgId`
    //     fast-path. A removed user whose PRIMARY org is this org (their token still carries
    //     organizationId === orgId) passes that fast-path until the token refreshes.
    //   - Org-scoped API keys are server creds, not user sessions, and are not revoked here.
    await this.prisma.$transaction(async (tx) => {
      if (target.role === 'owner') {
        const ownerCount = await countOwnersForUpdate(tx, organizationId);
        if (ownerCount <= 1) {
          throw new ForbiddenException('Cannot remove the last owner of the organization');
        }
      }

      await tx.ba_member.delete({ where: { id: memberId } });

      await deleteMembershipProjections(tx, {
        organizationId,
        userId: removedUserId,
      });
    });

    // SESSION INVALIDATION, the same rule the dashboard applies (apps/dashboard/app/actions/team.ts).
    // Revokes stored sessions whose active org is this one. Kept OUTSIDE the transaction: it is
    // best-effort cleanup, not part of the zero-owner invariant, and it touches a different table.
    // See the residual note above for the stateless-JWT case this cannot reach.
    await this.prisma.ba_session.deleteMany({
      where: { userId: removedUserId, activeOrganizationId: organizationId },
    });
  }

  async sendInvitation(organizationId: string, sendDto: SendInvitationDto, invitedBy: string) {
    const role = sendDto.role as string;

    // GRANT CAP: actor may only invite at a role inside their grantable set. Fails closed
    // for non-members (API keys).
    const actor = await this.getActorMembership(organizationId, invitedBy);
    if (!canGrantRole(actor?.role ?? '', role)) {
      throw new ForbiddenException(`You are not allowed to invite at the "${role}" role.`);
    }

    // PERSISTENCE GUARD: the team_invitations DB enum only stores {admin, member}. Reject
    // owner/finance here with a clear message instead of letting Prisma throw a raw error.
    // (Authorization above is still the full matrix; this is a storage limit, and it fails
    // safe — no invitation is created.)
    if (!INVITABLE_ROLES.includes(role)) {
      throw new BadRequestException(
        `Email invitations support only the admin and member roles. To grant "${role}", use Add Member or change an existing member's role.`,
      );
    }

    const existingUser = await this.prisma.users.findUnique({
      where: { email: sendDto.email },
    });

    if (existingUser) {
      // Canonical membership check is ba_member, matching getTeamMembers.
      const existingMember = await this.prisma.ba_member.findFirst({
        where: { organizationId, userId: existingUser.id },
      });

      if (existingMember) {
        throw new BadRequestException('User is already a team member');
      }
    }

    const existingInvitation = await this.prisma.team_invitations.findFirst({
      where: {
        organization_id: organizationId,
        email: sendDto.email,
        status: 'pending',
      },
    });

    if (existingInvitation) {
      throw new BadRequestException('Invitation already sent to this email');
    }

    const token = uuidv4();
    // Store the SHA-256 hash at rest. verify/accept hash the incoming
    // token to match. The raw token is the shareable secret the caller emails, so
    // we return it (overriding the hashed column) — never expose the stored hash.
    const invitation = await this.prisma.team_invitations.create({
      data: {
        id: uuidv4(),
        organization_id: organizationId,
        email: sendDto.email,
        role: role as any,
        token: hashApiKeyForLookup(token),
        invited_by: invitedBy,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    });

    return { ...invitation, token };
  }

  async resendInvitation(organizationId: string, invitationId: string) {
    const invitation = await this.prisma.team_invitations.findFirst({
      where: {
        id: invitationId,
        organization_id: organizationId,
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new BadRequestException('Can only resend pending invitations');
    }

    const updated = await this.prisma.team_invitations.update({
      where: { id: invitationId },
      data: {
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Token is stored hashed and can't be reconstructed. Resend only
    // extends expiry (no rotation), so the original emailed link still works —
    // never return the hashed token (it would leak the hash / hand out a dead link).
    const { token: _hashed, ...safe } = updated;
    return safe;
  }

  async cancelInvitation(organizationId: string, invitationId: string) {
    const invitation = await this.prisma.team_invitations.findFirst({
      where: {
        id: invitationId,
        organization_id: organizationId,
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    await this.prisma.team_invitations.delete({
      where: { id: invitationId },
    });
  }

  async verifyInvitationToken(token: string) {
    // Only the hash is stored, so never match the raw value (a stored
    // hash presented as a token must not work).
    const invitation = await this.prisma.team_invitations.findFirst({
      where: { token: hashApiKeyForLookup(token), status: 'pending' },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found or expired');
    }

    if (new Date() > new Date(invitation.expires_at)) {
      throw new BadRequestException('Invitation has expired');
    }

    // Fetch organization separately
    const organization = await this.prisma.organizations.findUnique({
      where: { id: invitation.organization_id },
      select: {
        id: true,
        name: true,
        logo: true,
      },
    });

    return {
      success: true,
      data: {
        organization,
        invitation: {
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expires_at,
        },
      },
    };
  }

  async acceptInvitation(token: string, userId: string) {
    const invitation = await this.prisma.team_invitations.findFirst({
      where: { token: hashApiKeyForLookup(token), status: 'pending' },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (new Date() > new Date(invitation.expires_at)) {
      throw new BadRequestException('Invitation has expired');
    }

    // Get user details
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if user email matches invitation
    if (user.email !== invitation.email) {
      throw new BadRequestException('This invitation was sent to a different email address');
    }

    // Get organization details
    const organization = await this.prisma.organizations.findUnique({
      where: { id: invitation.organization_id },
    });

    // Create the membership in the CANONICAL store (ba_member), so a token-accepted invite
    // shows up in getTeamMembers (ba_member-backed) and is governed by the same role
    // rules as every other membership. Idempotent: if the user is somehow already a member,
    // don't double-insert (ba_member has a unique (organizationId, userId) constraint) —
    // just mark the invitation accepted and return the existing row.
    const existingMember = await this.prisma.ba_member.findFirst({
      where: { organizationId: invitation.organization_id, userId },
      include: {
        users: { select: { id: true, name: true, email: true } },
      },
    });

    // Canonical row, both projections, and the invitation status in ONE transaction.
    // Split across separate statements, a crash between them leaves either a canonical member
    // with no projection rows (a fresh orphan) or
    // an accepted membership against an invitation still marked pending.
    const teamMember = await this.prisma.$transaction(async (tx) => {
      const row =
        existingMember ??
        (await tx.ba_member.create({
          data: {
            id: uuidv4(),
            organizationId: invitation.organization_id,
            userId,
            role: invitation.role as string,
            createdAt: new Date(),
          },
          include: {
            users: { select: { id: true, name: true, email: true } },
          },
        }));

      // Project the CANONICAL role, not the invitation's. On the already-a-member branch those
      // differ whenever the person was promoted after the invite was sent, and projecting the
      // stale invitation role would manufacture the very role disagreement membership.ts
      // promises cannot happen.
      await writeMembershipProjections(tx, {
        organizationId: invitation.organization_id,
        userId,
        role: row.role,
        invitedBy: invitation.invited_by ?? undefined,
      });

      await tx.team_invitations.update({
        where: { id: invitation.id },
        data: { status: 'accepted' },
      });

      return row;
    });

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        organization: {
          id: organization?.id,
          name: organization?.name,
        },
        teamMember,
      },
    };
  }
}
