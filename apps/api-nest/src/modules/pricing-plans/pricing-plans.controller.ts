import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { PricingPlansService } from './pricing-plans.service';
// Pricing plans set what customers are charged — money writes. Each
// write below is gated to Manage-MONEY roles (owner/admin/finance) in the caller's own org,
// the same lock as the dashboard pricing-plan Server Actions so a denied member can't replay
// their token here. @OrgFromUser because the service scopes every write to user.organizationId
// and ignores the :orgId alias. GET reads carry no role gate.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { CreatePricingPlanDto } from './dto/create-pricing-plan.dto';
import { UpdatePricingPlanDto } from './dto/update-pricing-plan.dto';
import { QueryPricingPlanDto } from './dto/query-pricing-plan.dto';
import { CopyPricingPlanDto } from './dto/copy-pricing-plan.dto';
import { LinkAgentDto } from './dto/link-agent.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

// Canonical:    /v1/pricing-plans
// Alias:        /v1/org/:orgId/pricing-plans
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Pricing Plans')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class PricingPlansController {
  constructor(private readonly pricingPlansService: PricingPlansService) {}

  @Post(['pricing-plans', 'org/:orgId/pricing-plans'])
  @ApiOperation({ summary: 'Create a new pricing plan' })
  @ApiResponse({ status: 201, description: 'Pricing plan created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createPricingPlanDto: CreatePricingPlanDto,
  ) {
    const plan = await this.pricingPlansService.create(user.organizationId, createPricingPlanDto);
    return plan;
  }

  @Get(['pricing-plans', 'org/:orgId/pricing-plans'])
  @ApiOperation({ summary: 'Get all pricing plans with pagination and filters' })
  @ApiResponse({ status: 200, description: 'List of pricing plans retrieved successfully' })
  async findAll(@CurrentUser() user: AuthenticatedUser, @Query() queryDto: QueryPricingPlanDto) {
    return this.pricingPlansService.findAll(user.organizationId, queryDto);
  }

  @Get(['pricing-plans/:id', 'org/:orgId/pricing-plans/:id'])
  @ApiOperation({ summary: 'Get pricing plan by ID' })
  @ApiResponse({ status: 200, description: 'Pricing plan retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Pricing plan not found' })
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pricingPlansService.findOne(id, user.organizationId);
  }

  @Patch(['pricing-plans/:id', 'org/:orgId/pricing-plans/:id'])
  @ApiOperation({ summary: 'Update pricing plan by ID' })
  @ApiResponse({ status: 200, description: 'Pricing plan updated successfully' })
  @ApiResponse({ status: 404, description: 'Pricing plan or agent not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updatePricingPlanDto: UpdatePricingPlanDto,
  ) {
    const result = await this.pricingPlansService.update(
      id,
      user.organizationId,
      updatePricingPlanDto,
    );
    return result;
  }

  @Delete(['pricing-plans/:id', 'org/:orgId/pricing-plans/:id'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete pricing plan by ID (soft delete)' })
  @ApiResponse({ status: 204, description: 'Pricing plan deleted successfully' })
  @ApiResponse({ status: 404, description: 'Pricing plan not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.pricingPlansService.remove(id, user.organizationId);
    return result;
  }

  @Post(['pricing-plans/:id/copy', 'org/:orgId/pricing-plans/:id/copy'])
  @ApiOperation({ summary: 'Copy pricing plan with its strategies and apply discount' })
  @ApiResponse({ status: 201, description: 'Pricing plan copied successfully' })
  @ApiResponse({ status: 404, description: 'Original pricing plan not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async copy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() copyDto: CopyPricingPlanDto,
  ) {
    const result = await this.pricingPlansService.copy(id, user.organizationId, copyDto);
    return result;
  }

  @Post(['pricing-plans/:id/agents', 'org/:orgId/pricing-plans/:id/agents'])
  @ApiOperation({ summary: 'Link a pricing plan to an agent' })
  @ApiResponse({ status: 201, description: 'Plan linked to agent successfully' })
  @ApiResponse({ status: 404, description: 'Plan or agent not found' })
  @ApiResponse({ status: 409, description: 'Plan is already linked to this agent' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async linkAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() linkAgentDto: LinkAgentDto,
  ) {
    const result = await this.pricingPlansService.linkAgent(
      id,
      linkAgentDto.agentId,
      user.organizationId,
    );
    return result;
  }

  @Delete(['pricing-plans/:id/agents/:agentId', 'org/:orgId/pricing-plans/:id/agents/:agentId'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink a pricing plan from an agent' })
  @ApiResponse({ status: 204, description: 'Plan unlinked from agent successfully' })
  @ApiResponse({ status: 400, description: 'Cannot unlink — active subscriptions exist' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async unlinkAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('agentId') agentId: string,
  ) {
    const result = await this.pricingPlansService.unlinkAgent(id, agentId, user.organizationId);
    return result;
  }
}
