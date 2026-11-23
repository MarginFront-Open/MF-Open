import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MANAGE_MONEY_ROLES, toNumber } from '@marginfront/db';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgFromUser, OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';
import { CustomerAlertsService, type AlertRowWithCustomer } from './customer-alerts.service';
import { CreateCustomerAlertDto } from './dto/create-customer-alert.dto';
import { UpdateCustomerAlertDto } from './dto/update-customer-alert.dto';

/**
 * WHAT THIS FILE DOES: REST for Customer Watch Alerts — create,
 * list, edit, and delete per-customer cost/revenue tripwires.
 * CONNECTS TO: customer-alerts.service.ts (all rules live there), the
 * dashboard's customer-page Alerts section (via cookie-forwarding server
 * actions), and the MCP customer-alert tools.
 *
 * READ POSTURE: every route — reads included — takes the full
 * MANAGE_MONEY_ROLES gate. This deliberately does NOT clone the cap
 * controller's open-read posture: that exists so on-device brakes can poll
 * with a developer key, and no device consumes customer watches. A watch
 * exposes per-customer money, which is exactly what the money gate is for.
 */
@ApiTags('Customer Alerts')
@Controller('customer-alerts')
@UseGuards(CombinedAuthGuard)
@ApiSecurity('api-key')
export class CustomerAlertsController {
  constructor(private readonly customerAlerts: CustomerAlertsService) {}

  /**
   * An alert row as clean JSON: thresholdUsd as an honest number (a raw Prisma
   * Decimal serializes to a STRING over the wire — same toNumber convention as
   * every other money read), plus the customer label for lists and deep links.
   */
  private serializeAlert(alert: AlertRowWithCustomer) {
    return {
      id: alert.id,
      customerId: alert.customerId,
      customerName: alert.customers?.name ?? null,
      customerExternalId: alert.customers?.externalId ?? null,
      metric: alert.metric,
      thresholdUsd: toNumber(alert.thresholdUsd),
      windowMode: alert.windowMode,
      customStartDate: alert.customStartDate,
      customEndDate: alert.customEndDate,
      recipientEmail: alert.recipientEmail,
      createdByUserId: alert.createdByUserId,
      createdAt: alert.createdAt,
      updatedAt: alert.updatedAt,
    };
  }

  @Get()
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  @ApiOperation({ summary: "List the organization's customer watches" })
  @ApiResponse({ status: 200, description: 'Customer watches retrieved' })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  async listAlerts(@Req() req: any) {
    const alerts = await this.customerAlerts.listAlerts(req.user.organizationId);
    return alerts.map((alert) => this.serializeAlert(alert));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  @ApiOperation({
    summary: 'Create a customer watch',
    description:
      'Owner/admin/finance only. Emails the recipient when the customer’s cost or ' +
      'revenue passes the threshold for the chosen window. Internal code-cost-clarity accounts ' +
      'are refused — use Internal AI Spend caps for coding-agent spend.',
  })
  @ApiResponse({ status: 201, description: 'Customer watch created' })
  @ApiResponse({
    status: 400,
    description: 'Internal/deleted customer, bad window dates, bad recipient, or org watch limit',
  })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  @ApiResponse({ status: 404, description: 'No such customer in your organization' })
  @ApiResponse({ status: 409, description: 'An identical watch already exists' })
  async createAlert(@Req() req: any, @Body() dto: CreateCustomerAlertDto) {
    const alert = await this.customerAlerts.createAlert(
      req.user.organizationId,
      req.user.userId,
      dto,
    );
    return this.serializeAlert(alert);
  }

  @Patch(':id')
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  @ApiOperation({
    summary: 'Update a customer watch',
    description:
      'Owner/admin/finance only. Adjusts metric / threshold / window on an existing watch. ' +
      'The watched customer and the recipient are fixed at create.',
  })
  @ApiResponse({ status: 200, description: 'Customer watch updated' })
  @ApiResponse({ status: 400, description: 'Bad window dates for the resulting state' })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  @ApiResponse({ status: 404, description: 'No such watch in your organization' })
  async updateAlert(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCustomerAlertDto) {
    const alert = await this.customerAlerts.updateAlert(
      req.user.organizationId,
      id,
      req.user.userId,
      dto,
    );
    return this.serializeAlert(alert);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  @ApiOperation({ summary: 'Delete a customer watch', description: 'Owner/admin/finance only.' })
  @ApiResponse({ status: 200, description: 'Customer watch deleted (its feed rows go with it)' })
  @ApiResponse({ status: 403, description: 'Caller is not owner/admin/finance' })
  @ApiResponse({ status: 404, description: 'No such watch in your organization' })
  async deleteAlert(@Req() req: any, @Param('id') id: string) {
    const result = await this.customerAlerts.deleteAlert(req.user.organizationId, id);
    return { deleted: result.deleted, id: result.alert.id };
  }
}
