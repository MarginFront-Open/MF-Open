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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiSecurity,
} from '@nestjs/swagger';
import { PricingStrategiesService } from './pricing-strategies.service';
import { CreatePricingStrategyDto } from './dto/create-pricing-strategy.dto';
import { UpdatePricingStrategyDto } from './dto/update-pricing-strategy.dto';
import { QueryPricingStrategyDto } from './dto/query-pricing-strategy.dto';
import { BulkUpdatePricingStrategiesDto } from './dto/bulk-update-pricing-strategies.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
// Pricing strategies are the per-signal rate rules that set what a
// customer is billed — money writes. Each write below is gated to Manage-MONEY roles
// (owner/admin/finance) in the caller's own org, matching the dashboard pricing-plan
// strategy Server Actions so a denied member can't replay their token here. @OrgFromUser
// because the service scopes every write to user.organizationId (the :orgId alias is ignored).
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';

// Canonical:    /v1/pricing-plans/:planId/pricing-strategies
// Alias:        /v1/org/:orgId/pricing-plans/:planId/pricing-strategies
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Pricing Strategies')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class PricingStrategiesController {
  constructor(private readonly pricingStrategiesService: PricingStrategiesService) {}

  @Post([
    'pricing-plans/:planId/pricing-strategies',
    'org/:orgId/pricing-plans/:planId/pricing-strategies',
  ])
  @ApiOperation({ summary: 'Create multiple pricing strategies (bulk create)' })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiResponse({ status: 201, description: 'Pricing strategies created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 404, description: 'Pricing plan, agent, or signal not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async createBulk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Body() strategies: CreatePricingStrategyDto[],
  ) {
    const result = await this.pricingStrategiesService.createBulk(
      user.organizationId,
      planId,
      strategies,
    );
    return result;
  }

  @Patch([
    'pricing-plans/:planId/pricing-strategies',
    'org/:orgId/pricing-plans/:planId/pricing-strategies',
  ])
  @ApiOperation({
    summary: 'Bulk update pricing strategies (update existing and create new)',
  })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiResponse({ status: 200, description: 'Pricing strategies processed successfully' })
  @ApiResponse({ status: 404, description: 'Pricing plan or strategies not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async bulkUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Body() bulkUpdateDto: BulkUpdatePricingStrategiesDto,
  ) {
    const result = await this.pricingStrategiesService.bulkUpdate(
      user.organizationId,
      planId,
      bulkUpdateDto,
    );

    return {
      message: 'Pricing strategies processed successfully',
      updated: result.updated.count,
      created: result.created.count,
      result,
    };
  }

  @Get([
    'pricing-plans/:planId/pricing-strategies',
    'org/:orgId/pricing-plans/:planId/pricing-strategies',
  ])
  @ApiOperation({
    summary: 'Get all pricing strategies for a plan with pagination and filters',
  })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiResponse({ status: 200, description: 'List of pricing strategies retrieved successfully' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Query() queryDto: QueryPricingStrategyDto,
  ) {
    return this.pricingStrategiesService.findAll(user.organizationId, planId, queryDto);
  }

  @Get([
    'pricing-plans/:planId/pricing-strategies/:id',
    'org/:orgId/pricing-plans/:planId/pricing-strategies/:id',
  ])
  @ApiOperation({ summary: 'Get pricing strategy by ID' })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiParam({ name: 'id', description: 'Pricing strategy ID' })
  @ApiResponse({ status: 200, description: 'Pricing strategy retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Pricing strategy not found' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Param('id') id: string,
  ) {
    return this.pricingStrategiesService.findOne(id, user.organizationId, planId);
  }

  @Patch([
    'pricing-plans/:planId/pricing-strategies/:id',
    'org/:orgId/pricing-plans/:planId/pricing-strategies/:id',
  ])
  @ApiOperation({ summary: 'Update pricing strategy by ID' })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiParam({ name: 'id', description: 'Pricing strategy ID' })
  @ApiResponse({ status: 200, description: 'Pricing strategy updated successfully' })
  @ApiResponse({ status: 404, description: 'Pricing strategy not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Param('id') id: string,
    @Body() updateDto: UpdatePricingStrategyDto,
  ) {
    const result = await this.pricingStrategiesService.update(
      id,
      user.organizationId,
      planId,
      updateDto,
    );
    return result;
  }

  @Delete([
    'pricing-plans/:planId/pricing-strategies/:id',
    'org/:orgId/pricing-plans/:planId/pricing-strategies/:id',
  ])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete pricing strategy by ID (soft delete)' })
  @ApiParam({ name: 'planId', description: 'Pricing plan ID' })
  @ApiParam({ name: 'id', description: 'Pricing strategy ID' })
  @ApiResponse({ status: 204, description: 'Pricing strategy deleted successfully' })
  @ApiResponse({ status: 404, description: 'Pricing strategy not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Param('id') id: string,
  ) {
    const result = await this.pricingStrategiesService.remove(id, user.organizationId, planId);
    return result;
  }
}
