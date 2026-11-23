import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { SendInvitationDto } from './dto/send-invitation.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { Public } from '../auth/decorators/public.decorator';
import { getUserId, requireHumanAuth } from '../../common/helpers/get-user-id';
import { Throttle } from '@nestjs/throttler';
import {
  OrgRoleGuard,
  OrgRoles,
  ORG_MANAGE_ROLES,
  HumanOnly,
} from '../../common/guards/org-role.guard';

/**
 * Team-management endpoints, all scoped to a single org in the URL (/org/:orgId/team).
 *
 * AUTHORIZATION:
 *  - @UseGuards(OrgRoleGuard) at the class level is the COARSE lock. It reads the
 *    canonical ba_member table and answers two questions before any
 *    handler runs: "is this caller actually a member of THIS org?" and "do they hold a
 *    high enough role for this route?" A check against any other table, or with no role,
 *    would leave a cross-tenant hole.
 *  - @OrgRoles() (no args) = any member may call (reads, plus invite/add — those are
 *    further capped by the grant matrix in the service).
 *  - @OrgRoles(...ORG_MANAGE_ROLES) = owner/admin only (re-role, remove, cancel, resend).
 *
 * The FINE-GRAINED relational rules a static guard can't express — the grantable cap,
 * owner-only-touches-owner, self-promotion block, admin-can't-touch-admin, last-owner
 * guard, and session invalidation on removal — all live in TeamService, which is why each
 * mutating handler passes the actor's user id (getUserId(user)) down to the service.
 */
@ApiTags('Team Management')
@ApiBearerAuth()
@UseGuards(OrgRoleGuard)
@Controller('org/:orgId/team')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  @OrgRoles() // any member of the org may list the team
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOperation({ summary: 'Get all team members' })
  @ApiResponse({ status: 200, description: 'Returns list of team members' })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  async getTeamMembers(@Param('orgId') orgId: string) {
    return this.teamService.getTeamMembers(orgId);
  }

  @Post()
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles() // any member may add — but the grant matrix in the service caps WHICH role
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOperation({ summary: 'Add team member directly (without invitation)' })
  @ApiResponse({ status: 201, description: 'Member added successfully' })
  @ApiResponse({ status: 400, description: 'User already a member' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({
    status: 403,
    description: 'Caller may not grant the requested role',
  })
  async addMember(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() addDto: AddMemberDto,
  ) {
    const result = await this.teamService.addMember(
      orgId,
      addDto.userId,
      addDto.role,
      getUserId(user),
    );
    return result;
  }

  @Get(':memberId')
  @OrgRoles() // any member may view another member
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'memberId', description: 'Team Member ID' })
  @ApiOperation({ summary: 'Get team member details' })
  @ApiResponse({ status: 200, description: 'Returns team member details' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  async getTeamMember(@Param('orgId') orgId: string, @Param('memberId') memberId: string) {
    return this.teamService.getTeamMember(orgId, memberId);
  }

  @Patch(':memberId/role')
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles(...ORG_MANAGE_ROLES) // owner/admin only (service hardens owner-vs-owner etc.)
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'memberId', description: 'Team Member ID' })
  @ApiOperation({ summary: 'Update team member role' })
  @ApiResponse({
    status: 200,
    description: 'Member role updated successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Not permitted to assign this role to this member',
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async updateMemberRole(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() updateDto: UpdateMemberRoleDto,
  ) {
    const result = await this.teamService.updateMemberRole(
      orgId,
      memberId,
      updateDto,
      getUserId(user),
    );
    return result;
  }

  @Delete(':memberId')
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles(...ORG_MANAGE_ROLES) // owner/admin only
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'memberId', description: 'Team Member ID' })
  @ApiOperation({ summary: 'Remove team member' })
  @ApiResponse({ status: 204, description: 'Member removed successfully' })
  @ApiResponse({
    status: 403,
    description: 'Not permitted to remove this member',
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async removeMember(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
  ) {
    const result = await this.teamService.removeMember(orgId, memberId, getUserId(user));
    return result;
  }

  @Post('invitations')
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles() // any member may invite — the grant matrix in the service caps WHICH role
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOperation({ summary: 'Send team invitation' })
  @ApiResponse({ status: 201, description: 'Invitation sent successfully' })
  @ApiResponse({
    status: 400,
    description: 'User already a member or invitation exists',
  })
  @ApiResponse({
    status: 403,
    description: 'Caller may not invite at the requested role',
  })
  async sendInvitation(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() sendDto: SendInvitationDto,
  ) {
    const result = await this.teamService.sendInvitation(orgId, sendDto, getUserId(user));
    return result;
  }

  @Post('invitations/:invitationId/resend')
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles(...ORG_MANAGE_ROLES) // owner/admin only
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation ID' })
  @ApiOperation({ summary: 'Resend team invitation' })
  @ApiResponse({ status: 200, description: 'Invitation resent successfully' })
  @ApiResponse({
    status: 400,
    description: 'Can only resend pending invitations',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async resendInvitation(
    @Param('orgId') orgId: string,
    @Param('invitationId') invitationId: string,
  ) {
    const result = await this.teamService.resendInvitation(orgId, invitationId);
    return result;
  }

  @Delete('invitations/:invitationId')
  @HumanOnly() // team management is a person's decision, never an API key's
  @OrgRoles(...ORG_MANAGE_ROLES) // owner/admin only
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation ID' })
  @ApiOperation({ summary: 'Cancel team invitation' })
  @ApiResponse({
    status: 204,
    description: 'Invitation cancelled successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async cancelInvitation(
    @Param('orgId') orgId: string,
    @Param('invitationId') invitationId: string,
  ) {
    const result = await this.teamService.cancelInvitation(orgId, invitationId);
    return result;
  }
}

// Public invitation endpoints (no orgId in path).
// Public bucket (60/60s per IP). The verify GET below tightens for
// token brute-force defense (30/60s).
//
// NOTE: these stay token-based on the team_invitations table on purpose — ba_invitation
// (the table the gated org-scoped invites above use) has no token column, so the public
// accept-by-token contract cannot move onto it without a schema migration. This
// controller is intentionally NOT behind OrgRoleGuard: it has no orgId
// in the path and is reached by a not-yet-a-member user holding an invitation token.
@ApiTags('Invitations')
@Controller('invitations')
@Throttle({ public: { limit: 60, ttl: 60_000 } })
export class InvitationsController {
  constructor(private readonly teamService: TeamService) {}

  // Token brute-force defense: 30/60s/IP. Lookup is cheap, but an attacker
  // could otherwise enumerate invitation tokens fast.
  @Throttle({ public: { limit: 30, ttl: 60_000 } })
  @Get('verify/:token')
  @Public() // Public endpoint - no authentication required
  @ApiOperation({ summary: 'Verify invitation token (public endpoint)' })
  @ApiResponse({ status: 200, description: 'Invitation verified successfully' })
  @ApiResponse({ status: 404, description: 'Invitation not found or expired' })
  async verifyInvitation(@Param('token') token: string) {
    return this.teamService.verifyInvitationToken(token);
  }

  @Post('accept/:token')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept invitation (requires authentication)' })
  @ApiResponse({ status: 200, description: 'Invitation accepted successfully' })
  @ApiResponse({ status: 404, description: 'Invitation not found or expired' })
  async acceptInvitation(@Param('token') token: string, @Request() req: any) {
    requireHumanAuth(req.user);
    const result = await this.teamService.acceptInvitation(token, getUserId(req.user));
    return result;
  }
}
