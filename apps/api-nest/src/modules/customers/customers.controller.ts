import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, UpdateCustomerDto, QueryCustomerDto } from './dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
// A customer record is part of the metering plumbing — a BUILD/operations
// write, not the books. Its create/update/delete writes are gated to Manage-BUILD roles
// (owner/admin) in the caller's OWN org, matching the dashboard customer Server Actions.
// @OrgFromUser because the service scopes every write to user.organizationId (the :orgId alias
// is ignored). Reads (GET) stay open. Same-org API keys still pass the guard (within-org SDK
// traffic); plain human members are blocked.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_BUILD_ROLES } from '@marginfront/db';
// Per-customer canonical revenue endpoint wraps the shared
// RevenueMetricsService. Defined in the analytics module and exported there.
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

// Canonical:    /v1/customers
// Alias:        /v1/org/:orgId/customers
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('customers')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  @Post(['customers', 'org/:orgId/customers'])
  @ApiOperation({ summary: 'Create a new customer' })
  @ApiResponse({ status: 201, description: 'Customer created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async createCustomer(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCustomerDto) {
    const customer = await this.customersService.createCustomer(user.organizationId, dto);
    return customer;
  }

  @Get(['customers', 'org/:orgId/customers'])
  @ApiOperation({ summary: 'Get all customers for an organization' })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCustomers(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryCustomerDto) {
    return this.customersService.getCustomers(user.organizationId, query);
  }

  @Get(['customers/:customerId', 'org/:orgId/customers/:customerId'])
  @ApiOperation({ summary: 'Get a specific customer by ID' })
  @ApiResponse({ status: 200, description: 'Customer retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
  ) {
    return this.customersService.getCustomerById(customerId, user.organizationId);
  }

  @Patch(['customers/:customerId', 'org/:orgId/customers/:customerId'])
  @ApiOperation({ summary: 'Update a customer' })
  @ApiResponse({ status: 200, description: 'Customer updated successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async updateCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const customer = await this.customersService.updateCustomer(
      customerId,
      user.organizationId,
      dto,
    );
    return customer;
  }

  @Delete(['customers/:customerId', 'org/:orgId/customers/:customerId'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a customer (soft delete)' })
  @ApiResponse({ status: 204, description: 'Customer deleted successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  // CASCADE WARNING: the customer -> invoices and customer -> subscriptions FKs are
  // onDelete: Cascade (packages/db/prisma/schema.prisma). A HARD row delete would destroy
  // that customer's invoices and subscriptions — the BOOKS — which is exactly why delete is
  // owner/admin-gated. This service path is a SOFT delete, so the cascade stays latent here.
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async deleteCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
  ) {
    await this.customersService.deleteCustomer(customerId, user.organizationId);
  }

  /**
   * Canonical per-customer revenue endpoint.
   *
   * Returns `RevenueMetrics` (rules R1 + R2 in packages/db/CANON.md) for a single customer over a
   * date window. Thin wrapper over RevenueMetricsService. All math lives
   * in the canonical library. If `startDate` / `endDate` are omitted, the
   * window defaults to the last 30 days (UTC).
   *
   * The SDK method `client.customers.getWithRevenue(id)` wraps this endpoint.
   */
  @Get(['customers/:customerId/revenue', 'org/:orgId/customers/:customerId/revenue'])
  @ApiOperation({
    summary:
      'Canonical per-customer revenue metrics (R1 + R2). Returns RevenueMetrics scoped to one customer over the window.',
  })
  @ApiResponse({ status: 200, description: 'Returns RevenueMetrics for the customer' })
  async getCustomerRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // Default to last 30 days if no window is passed. Matches the
    // dashboard default range so the SDK and UI share one assumption.
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    return this.revenueMetrics.getRevenueMetrics(
      user.organizationId,
      { start, end },
      { customerId },
    );
  }
}
