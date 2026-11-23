import { Controller, Get, Patch, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PortalSessionGuard, PortalSessionRequest } from '../../common/guards/portal-session.guard';
import { PortalApiService, UpdatePortalProfileDto } from './portal-api.service';

/**
 * Portal API Controller
 *
 * Customer-facing endpoints accessed via portal session tokens.
 * All endpoints require a valid portal session token (prtl_*).
 *
 * These endpoints allow customers to:
 * - View their profile and update basic info
 * - View their invoices and payment history
 * - View their subscriptions
 * - View their usage metrics
 *
 * @example
 * // Access with portal session token
 * fetch('https://api.example.com/portal/invoices', {
 *   headers: {
 *     'Authorization': 'Bearer prtl_xxx'
 *   }
 * })
 */
@ApiTags('portal')
@Controller('portal')
@UseGuards(PortalSessionGuard)
@ApiBearerAuth('portal-session')
export class PortalApiController {
  constructor(private readonly portalApiService: PortalApiService) {}

  /**
   * Get current session info
   */
  @Get('session')
  @ApiOperation({
    summary: 'Get session info',
    description: 'Returns information about the current portal session including expiration time.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session info retrieved successfully',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        customerId: 'cust_123',
        customerName: 'Acme Corp',
        customerEmail: 'billing@acme.example',
        expiresAt: '2024-01-01T01:00:00.000Z',
        features: ['invoices', 'subscriptions', 'usage', 'profile'],
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    },
  })
  async getSession(@Request() req: PortalSessionRequest) {
    return this.portalApiService.getSessionInfo(req.portalUser);
  }

  /**
   * Get customer profile
   */
  @Get('profile')
  @ApiOperation({
    summary: 'Get profile',
    description: 'Returns the customer profile associated with this portal session.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile retrieved successfully',
    schema: {
      example: {
        id: 'cust_123',
        name: 'Acme Corp',
        email: 'billing@acme.example',
        phone: '+1-555-0100',
        addressLine1: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        zipCode: '94102',
        country: 'US',
        timezone: 'America/Los_Angeles',
        currency: 'USD',
      },
    },
  })
  async getProfile(@Request() req: PortalSessionRequest) {
    return this.portalApiService.getProfile(req.portalUser);
  }

  /**
   * Update customer profile
   */
  @Patch('profile')
  @ApiOperation({
    summary: 'Update profile',
    description: 'Update the customer profile. Only provided fields will be updated.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
  })
  async updateProfile(@Request() req: PortalSessionRequest, @Body() dto: UpdatePortalProfileDto) {
    const result = await this.portalApiService.updateProfile(req.portalUser, dto);
    return result;
  }

  /**
   * List invoices
   */
  @Get('invoices')
  @ApiOperation({
    summary: 'List invoices',
    description: 'Returns all invoices for the customer.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status (draft, pending, paid, overdue, void)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of invoices to return (default: 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoices retrieved successfully',
    schema: {
      example: [
        {
          id: 'inv_123',
          invoiceNumber: 'INV-2024-001',
          invoiceDate: '2024-01-01T00:00:00.000Z',
          dueDate: '2024-01-31T00:00:00.000Z',
          status: 'paid',
          totalAmount: 150.0,
          subtotal: 150.0,
          amountPaid: 150.0,
          amountDue: 0,
          currency: 'USD',
          pdfUrl: 'https://...',
        },
      ],
    },
  })
  async listInvoices(
    @Request() req: PortalSessionRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
  ) {
    return this.portalApiService.listInvoices(req.portalUser, { status, limit });
  }

  /**
   * Get single invoice
   */
  @Get('invoices/:invoiceId')
  @ApiOperation({
    summary: 'Get invoice',
    description: 'Returns a single invoice with line item details.',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoice retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  async getInvoice(@Request() req: PortalSessionRequest, @Param('invoiceId') invoiceId: string) {
    return this.portalApiService.getInvoice(req.portalUser, invoiceId);
  }

  /**
   * List subscriptions
   */
  @Get('subscriptions')
  @ApiOperation({
    summary: 'List subscriptions',
    description: 'Returns all subscriptions for the customer.',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'Include cancelled/expired subscriptions',
  })
  @ApiResponse({
    status: 200,
    description: 'Subscriptions retrieved successfully',
    schema: {
      example: [
        {
          id: 'sub_123',
          name: 'Pro Plan - AI Assistant',
          status: 'active',
          startDate: '2024-01-01T00:00:00.000Z',
          billingCycle: 'monthly',
          currentBillingPeriodStart: '2024-01-01T00:00:00.000Z',
          currentBillingPeriodEnd: '2024-01-31T23:59:59.999Z',
          plan: {
            id: 'plan_456',
            name: 'Pro',
            description: 'For growing teams',
          },
          agent: {
            id: 'agent_789',
            name: 'AI Assistant',
          },
        },
      ],
    },
  })
  async listSubscriptions(
    @Request() req: PortalSessionRequest,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.portalApiService.listSubscriptions(req.portalUser, {
      includeInactive,
    });
  }

  /**
   * Get usage summary
   */
  @Get('usage')
  @ApiOperation({
    summary: 'Get usage summary',
    description: 'Returns usage metrics for the current or specified billing period.',
  })
  @ApiQuery({
    name: 'periodStart',
    required: false,
    type: String,
    description: 'Period start date (ISO 8601). Defaults to start of current month.',
  })
  @ApiQuery({
    name: 'periodEnd',
    required: false,
    type: String,
    description: 'Period end date (ISO 8601). Defaults to end of current month.',
  })
  @ApiResponse({
    status: 200,
    description: 'Usage summary retrieved successfully',
    schema: {
      example: {
        period: {
          start: '2024-01-01T00:00:00.000Z',
          end: '2024-01-31T23:59:59.999Z',
        },
        totalTasks: 15420,
        totalUnits: 10025.5,
        byAgent: [
          {
            agentId: 'agt_123',
            agentName: 'Reservation Bot',
            taskCount: 10000,
            totalUnits: 10000,
          },
        ],
        bySignal: [
          {
            signalId: 'sig_123',
            signalName: 'process_request',
            taskCount: 10000,
            totalUnits: 10000,
          },
          {
            signalId: 'sig_456',
            signalName: 'archive_record',
            taskCount: 5420,
            totalUnits: 25.5,
          },
        ],
      },
    },
  })
  async getUsage(
    @Request() req: PortalSessionRequest,
    @Query('periodStart') periodStart?: string,
    @Query('periodEnd') periodEnd?: string,
  ) {
    return this.portalApiService.getUsageSummary(req.portalUser, {
      periodStart: periodStart ? new Date(periodStart) : undefined,
      periodEnd: periodEnd ? new Date(periodEnd) : undefined,
    });
  }
}
