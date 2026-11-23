import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { InvoiceCalculatorService } from './invoice-calculator.service';
import { CalculateInvoiceDto, SimulateRevenueDto } from './dto';
// Cross-tenant READ: every lookup scopes to the caller's org (user.organizationId)
// so a cross-org id 404s. OrgRoleGuard + @OrgFromUser guarantees that org is present before the
// service filters on it (an undefined org would let Prisma drop the filter and re-open the leak).
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

@ApiTags('invoice-calculator')
@Controller('org/:orgId/invoice-calculator')
@ApiBearerAuth()
export class InvoiceCalculatorController {
  constructor(private readonly invoiceCalculatorService: InvoiceCalculatorService) {}

  @Post('billing/calculate')
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({ summary: 'Calculate invoice for a subscription' })
  @ApiResponse({ status: 200, description: 'Invoice calculated successfully' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async calculateInvoice(@CurrentUser() user: AuthenticatedUser, @Body() dto: CalculateInvoiceDto) {
    return this.invoiceCalculatorService.calculateInvoice(dto, user.organizationId);
  }

  @Get('billing-status/:subscriptionId')
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({ summary: 'Get billing status for a subscription' })
  @ApiResponse({ status: 200, description: 'Billing status retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async getBillingStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    return this.invoiceCalculatorService.getBillingStatus(subscriptionId, user.organizationId);
  }

  @Post('billing/simulate')
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({ summary: 'Simulate revenue based on projected usage' })
  @ApiResponse({ status: 200, description: 'Revenue simulated successfully' })
  @ApiResponse({ status: 404, description: 'Pricing plan not found' })
  async simulateRevenue(@CurrentUser() user: AuthenticatedUser, @Body() dto: SimulateRevenueDto) {
    return this.invoiceCalculatorService.simulateRevenue(dto, user.organizationId);
  }
}
