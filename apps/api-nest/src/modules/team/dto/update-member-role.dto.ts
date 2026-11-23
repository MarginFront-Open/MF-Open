import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

/**
 * The roles a team member can hold. This is the full set so the grant matrix
 * (see canGrantRole in @marginfront/db) is enforceable: a role missing here would
 * be rejected with a 400 BEFORE any authorization logic ran.
 *
 * IMPORTANT: this enum is the source of truth for ROLE assignment via ba_member
 * (a free-form text column, so every role persists cleanly). The email-INVITATION path
 * (team_invitations) has a narrower DB enum {admin, member}; sendInvitation enforces
 * that narrower set separately. See team.service.ts.
 *
 * So developer (like finance/owner) is assigned by changing an existing member's
 * role via PATCH, NOT by email invite.
 */
export enum TeamRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  FINANCE = 'finance',
  DEVELOPER = 'developer',
  // The matter seat. Like finance/developer it is assigned by
  // role change, not by the email-invite path (team_invitations'
  // Postgres enum stays {admin, member} on purpose).
  LEGAL = 'legal',
  MEMBER = 'member',
}

export class UpdateMemberRoleDto {
  @ApiProperty({ description: 'New role for team member', enum: TeamRole })
  @IsEnum(TeamRole)
  role: TeamRole;
}
