/**
 * WHAT THIS FILE DOES: The /v1 REST surface for the Law tab — 13
 * endpoints mirroring the dashboard's 12 matter/rule server actions, so an
 * MCP agent can do everything a person can do on the Law tab.
 *
 * WHY IT EXISTS: the MCP server is a thin wrapper over /v1; the Law feature
 * existed only as dashboard Server Actions it can't reach.
 *
 * CONNECTS TO: matters.service.ts (all queries), packages/mcp/src/index.ts
 * (the 12 matter tools calling these routes), common/guards/org-role.guard.ts
 * (the role gate) and common/guards/legal-key-scope.guard.ts (the global
 * confinement that makes 'legal' in @OrgRoles below double as the legal key's
 * allowlist).
 *
 * ROUTE ORDER IS LOAD-BEARING: 'matters/audit' and 'matters/unassigned' are
 * declared BEFORE 'matters/:id', or Nest routes those words into :id.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MattersService } from './matters.service';
import {
  AssignEventDto,
  CreateMatterDto,
  CreateMatterRuleDto,
  MatterAuditQueryDto,
  MatterListQueryDto,
  UpdateMatterDto,
  UpdateMatterRuleDto,
} from './dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { OrgFromUser, OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';

/**
 * Value-identical TWIN of LAW_MANAGE_ROLES in @marginfront/db (org-roles.ts) — the one
 * source of truth for "who may touch the Law surface": owner/admin/finance/legal.
 * Local for the same hard operational reason as ORG_MANAGE_ROLES in org-role.guard.ts:
 * every @OrgRoles(...) below SPREADS this at MODULE-LOAD time, and a stale @marginfront/db
 * dist would make the import undefined and kill api-nest at BOOT, not at request time.
 * If the set ever changes, change both (there are only two).
 *
 * 'legal' appearing in this list is doing double duty: OrgRoleGuard reads it as "these
 * roles pass" (under enforce), and the global LegalKeyScopeGuard reads it as "this route
 * is inside the legal key's reachable surface" — which is why EVERY route here carries
 * the full trio, reads included (the dashboard gates its Law reads the same way).
 */
const LAW_MANAGE_ROLES = ['owner', 'admin', 'finance', 'legal'];

@ApiTags('matters')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class MattersController {
  constructor(private readonly mattersService: MattersService) {}

  @Get('matters/audit')
  @ApiOperation({
    summary:
      'Org-wide windowed audit view mirroring the Law tab CSV export: summary = one row ' +
      'per matter + Unassigned + totals, reconciling to the org cost headline (canon C1).',
  })
  @ApiResponse({ status: 200, description: 'Audit summary (or detail rows with format=detail)' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async getAudit(@CurrentUser() user: AuthenticatedUser, @Query() query: MatterAuditQueryDto) {
    return this.mattersService.getAudit(user.organizationId, query);
  }

  @Get('matters/unassigned')
  @ApiOperation({
    summary:
      'Usage events not attributed to any matter. totalResults is the badge count ' +
      '(all-time, never windowed); totalCost sums the whole unassigned set.',
  })
  @ApiResponse({ status: 200, description: 'Paginated unassigned events + totals' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async getUnassigned(@CurrentUser() user: AuthenticatedUser, @Query() query: MatterListQueryDto) {
    return this.mattersService.getUnassigned(user.organizationId, query);
  }

  @Post('matters/assign')
  @ApiOperation({
    summary:
      'Manually assign a usage event to a matter (or null to unassign). Stamped source ' +
      "'manual', which outranks tag and rule attribution.",
  })
  @ApiResponse({ status: 201, description: 'Event moved' })
  @ApiResponse({ status: 404, description: 'Event or matter not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async assignEvent(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssignEventDto) {
    const result = await this.mattersService.assignEvent(user.organizationId, dto);
    return result;
  }

  @Get('matters')
  @ApiOperation({ summary: 'List matters with all-time actual AI cost and event count' })
  @ApiResponse({ status: 200, description: 'Paginated matters' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async listMatters(@CurrentUser() user: AuthenticatedUser, @Query() query: MatterListQueryDto) {
    return this.mattersService.listMatters(user.organizationId, query);
  }

  @Post('matters')
  @ApiOperation({ summary: 'Create a matter' })
  @ApiResponse({ status: 201, description: 'Matter created' })
  @ApiResponse({ status: 409, description: 'Matter number already exists in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async createMatter(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMatterDto) {
    const matter = await this.mattersService.createMatter(user.organizationId, dto);
    return matter;
  }

  @Get('matters/:id')
  @ApiOperation({
    summary:
      'One matter with all-time cost, event count, and its 100 most recent events ' +
      '(eventsCap in the response; the audit endpoint carries the full record).',
  })
  @ApiResponse({ status: 200, description: 'Matter detail' })
  @ApiResponse({ status: 404, description: 'Matter not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async getMatter(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.mattersService.getMatterDetail(user.organizationId, id);
  }

  @Patch('matters/:id')
  @ApiOperation({ summary: 'Update a matter (only the provided fields change)' })
  @ApiResponse({ status: 200, description: 'Matter updated' })
  @ApiResponse({ status: 404, description: 'Matter not found in this organization' })
  @ApiResponse({ status: 409, description: 'Matter number already exists in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async updateMatter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMatterDto,
  ) {
    const matter = await this.mattersService.updateMatter(user.organizationId, id, dto);
    return matter;
  }

  @Delete('matters/:id')
  @ApiOperation({
    summary:
      'Delete a matter. Its usage events survive and return to Unassigned (the response ' +
      "counts them); the matter's routing rules are deleted with it.",
  })
  @ApiResponse({ status: 200, description: 'Matter deleted; events returned to Unassigned' })
  @ApiResponse({ status: 404, description: 'Matter not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async deleteMatter(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.mattersService.deleteMatter(user.organizationId, id);
    return result;
  }

  @Get('matter-rules')
  @ApiOperation({
    summary:
      'List routing rules in EVALUATION order (priority asc, ties by creation): the ' +
      'order the ingest hook and apply-rules actually run.',
  })
  @ApiResponse({ status: 200, description: 'Paginated rules' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async listRules(@CurrentUser() user: AuthenticatedUser, @Query() query: MatterListQueryDto) {
    return this.mattersService.listRules(user.organizationId, query);
  }

  @Post('matter-rules')
  @ApiOperation({ summary: 'Create a routing rule (at least one matcher required)' })
  @ApiResponse({ status: 201, description: 'Rule created' })
  @ApiResponse({ status: 400, description: 'No matcher provided' })
  @ApiResponse({ status: 404, description: 'Target matter not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async createRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMatterRuleDto) {
    const rule = await this.mattersService.createRule(user.organizationId, dto);
    return rule;
  }

  @Post('matter-rules/apply')
  @ApiOperation({
    summary:
      'Sweep events with no matter AND no attribution history onto matters, rule by ' +
      'rule in priority order. Never overrides a tag, rule, or manual decision.',
  })
  @ApiResponse({ status: 201, description: 'Count of events assigned' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async applyRules(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.mattersService.applyRules(user.organizationId);
    return result;
  }

  @Patch('matter-rules/:id')
  @ApiOperation({
    summary:
      'Update a routing rule (only the provided fields change; null clears a matcher; ' +
      'the rule must keep at least one matcher).',
  })
  @ApiResponse({ status: 200, description: 'Rule updated' })
  @ApiResponse({ status: 404, description: 'Rule not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async updateRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMatterRuleDto,
  ) {
    const rule = await this.mattersService.updateRule(user.organizationId, id, dto);
    return rule;
  }

  @Delete('matter-rules/:id')
  @ApiOperation({ summary: 'Delete a routing rule' })
  @ApiResponse({ status: 200, description: 'Rule deleted' })
  @ApiResponse({ status: 404, description: 'Rule not found in this organization' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...LAW_MANAGE_ROLES)
  @OrgFromUser()
  async deleteRule(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.mattersService.deleteRule(user.organizationId, id);
    return result;
  }
}
