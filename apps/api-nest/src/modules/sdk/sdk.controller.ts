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
  UsePipes,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { SdkService } from './sdk.service';
import { RecordUsageDto } from './dto/record-usage.dto';
import { ingestValidationPipe } from './ingest-validation.pipe';
import { requireIngestOrganizationId } from './require-ingest-organization-id';
import { CreateSdkCustomerDto } from './dto/create-sdk-customer.dto';
import { UpdateSdkCustomerDto } from './dto/update-sdk-customer.dto';
import { QuerySdkInvoicesDto } from './dto/query-sdk-invoices.dto';
import { QuerySdkUsageDto } from './dto/query-sdk-usage.dto';
import { QuerySdkSubscriptionsDto } from './dto/query-sdk-subscriptions.dto';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
// The SDK customer WRITES (create/update/delete) are BUILD/operations
// management, gated to Manage-BUILD roles (owner/admin) via OrgRoleGuard + @OrgFromUser. This
// is SAFE for legitimate SDK traffic: OrgRoleGuard short-circuits a same-org api-key BEFORE any
// role check, so a customer's own SDK key keeps working — the gate blocks only
// cross-tenant keys and under-privileged HUMAN session/jwt callers. The pure INGESTION path
// (POST /sdk/usage/record) and all GET reads stay UNGATED so api-key event ingestion is never
// rejected. @OrgFromUser because every write is scoped to req.user.organizationId, not a URL param.
import {
  OrgRoleGuard,
  OrgRoles,
  OrgFromUser,
  IngestRoute,
} from '../../common/guards/org-role.guard';
import { PublishableKeyAllowed } from '../../common/guards/publishable-key-read.guard';
import { IngestKeyAllowed } from '../../common/guards/ingest-key-scope.guard';
import { MANAGE_BUILD_ROLES, MANAGE_MONEY_ROLES } from '@marginfront/db';
// SDK route for invoice-from-subscription generation.
// Mirrors the public POST /v1/invoices/generate route under the /v1/sdk/* prefix
// so @marginfront/sdk clients hit the same backend through their throttler bucket.
import { Inject, forwardRef } from '@nestjs/common';
import { InvoicesService } from '../invoices/invoices.service';
import { GenerateInvoiceDto, SendInvoiceDto } from '../invoices/dto/invoice.dto';

// SDK endpoints must be governed by the "sdk" throttler bucket ALONE
// (60K/60s per organizationId) — sized for high-volume event ingestion, where a
// single customer with thousands of end-users can legitimately push hundreds of
// events/sec.
//
// WHY BOTH DECORATORS ARE REQUIRED:
// the app registers THREE named buckets — default 1200/60s, sdk 60K/60s,
// public 60/60s (app.module.ts) — and EVERY bucket applies to EVERY request; a
// request must pass the MINIMUM of all active buckets. @Throttle({ sdk }) only
// RAISES the sdk bucket's number for these routes; it does NOT remove the default
// or public buckets. So @Throttle alone does NOT stop the default bucket from
// throttling customers — without the @SkipThrottle below, the default bucket
// silently caps ingest at 1200/60s and the public (IP-keyed) bucket at 60/60s,
// far under the 60K the SDK is sized for. @SkipThrottle turns BOTH of those off
// so the sdk bucket is the only governor. Skipping only `public` is NOT enough —
// `default` at 1200/60s would still throttle real customers, which is why we skip
// `default` AND `public` here.
@ApiTags('SDK')
@Controller('sdk')
@UseGuards(CombinedAuthGuard)
@ApiSecurity('api-key')
@SkipThrottle({ default: true, public: true })
@Throttle({ sdk: { limit: 60000, ttl: 60_000 } })
export class SdkController {
  constructor(
    private readonly sdkService: SdkService,
    // forwardRef because SdkModule and InvoicesModule may need each other indirectly
    // (Webhooks -> Invoices -> Subscription -> ...). Keeps Nest's DI graph happy.
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
  ) {}

  @Get('verify')
  // The /v1/sdk/verify alias must behave identically to the canonical /v1/verify,
  // including the publishable-key allowance (an SDK build in the field may hit either).
  // It carries the ingest-role allowance for the same "identical doors" reason:
  // the code-cost-clarity meter's default ingest target lives on this /v1/sdk/* prefix.
  @PublishableKeyAllowed()
  @IngestKeyAllowed()
  @ApiOperation({
    summary: 'Verify API key',
    description: 'Verify the API key and return organization information',
  })
  @ApiResponse({
    status: 200,
    description: 'API key verified successfully',
    schema: {
      type: 'object',
      properties: {
        organizationId: { type: 'string' },
        organizationName: { type: 'string' },
        verified: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Organization not found',
  })
  async verifyApiKey(@Req() req: any) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    const result = await this.sdkService.verifyApiKey(organizationId);
    return result;
  }

  @Post('usage/record')
  @IngestRoute()
  @HttpCode(HttpStatus.OK)
  @UsePipes(ingestValidationPipe)
  @ApiOperation({
    summary: 'Record usage events',
    description: 'Record usage events for customers. Accepts batch of 1-100 records.',
  })
  @ApiResponse({
    status: 200,
    description: 'Usage records processed',
    schema: {
      type: 'object',
      properties: {
        processed: { type: 'number' },
        successful: { type: 'number' },
        failed: { type: 'number' },
        results: {
          type: 'object',
          properties: {
            success: { type: 'array' },
            failed: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request data',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key, or a login token was sent instead of an API key.',
  })
  @ApiResponse({
    status: 503,
    description: 'MarginFront could not check the API key. Retry after the Retry-After interval.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many failed API key attempts from this network. Retry after the Retry-After interval.',
  })
  async recordUsage(@Req() req: any, @Body() recordUsageDto: RecordUsageDto) {
    const organizationId = requireIngestOrganizationId(req);
    const result = await this.sdkService.recordUsage(organizationId, recordUsageDto);
    return result;
  }

  @Post('customers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new customer',
    description:
      'Create a new customer. Optionally auto-create a subscription by providing agentId.',
  })
  @ApiResponse({
    status: 201,
    description: 'Customer created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request data or customer already exists',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async createCustomer(@Req() req: any, @Body() createCustomerDto: CreateSdkCustomerDto) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    const customer = await this.sdkService.createCustomer(organizationId, createCustomerDto);
    return customer;
  }

  @Get('customers')
  @ApiOperation({
    summary: 'Get all customers',
    description: 'Retrieve all customers for the organization',
  })
  @ApiResponse({
    status: 200,
    description: 'Customers retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  async getCustomers(@Req() req: any) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getCustomers(organizationId);
  }

  @Get('customers/:customerId')
  @ApiOperation({
    summary: 'Get customer by ID',
    description: 'Retrieve a specific customer by ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Customer retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Customer not found',
  })
  async getCustomer(@Req() req: any, @Param('customerId') customerId: string) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getCustomer(organizationId, customerId);
  }

  @Patch('customers/:customerId')
  @ApiOperation({
    summary: 'Update customer',
    description: 'Update customer information',
  })
  @ApiResponse({
    status: 200,
    description: 'Customer updated successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request data',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Customer not found',
  })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async updateCustomer(
    @Req() req: any,
    @Param('customerId') customerId: string,
    @Body() updateCustomerDto: UpdateSdkCustomerDto,
  ) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    const result = await this.sdkService.updateCustomer(
      organizationId,
      customerId,
      updateCustomerDto,
    );
    return result;
  }

  @Delete('customers/:customerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete customer',
    description: 'Soft delete a customer and associated subscriptions',
  })
  @ApiResponse({
    status: 204,
    description: 'Customer deleted successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Customer not found',
  })
  // CASCADE WARNING: the customer -> invoices and customer -> subscriptions FKs are
  // onDelete: Cascade (packages/db/prisma/schema.prisma). A HARD row delete would destroy
  // that customer's invoices and subscriptions — the BOOKS — which is exactly why delete is
  // owner/admin-gated. This service path is a SOFT delete, so the cascade stays latent here.
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async deleteCustomer(@Req() req: any, @Param('customerId') customerId: string) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    const result = await this.sdkService.deleteCustomer(organizationId, customerId);
    return result;
  }

  // ============================================
  // INVOICES
  // ============================================

  @Get('invoices')
  @ApiOperation({
    summary: 'Get invoices',
    description: 'Retrieve invoices for the organization with optional filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoices retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  async getInvoices(@Req() req: any, @Query() query: QuerySdkInvoicesDto) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getInvoices(organizationId, query);
  }

  @Get('invoices/:invoiceId')
  @ApiOperation({
    summary: 'Get invoice by ID',
    description: 'Retrieve a specific invoice with full details',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoice retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Invoice not found',
  })
  async getInvoice(@Req() req: any, @Param('invoiceId') invoiceId: string) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getInvoice(organizationId, invoiceId);
  }

  // SDK-prefixed alias for the public POST /v1/invoices/generate.
  // @marginfront/sdk's client.invoices.generate() calls /sdk/invoices/generate (not the
  // public path) so SDK traffic lands in the SDK throttler bucket (60K/60s per org).
  // Delegates to the same InvoicesService.generateInvoice as the public route, so
  // behavior stays in lockstep across surfaces.
  @Post('invoices/generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'SDK: generate draft invoice from subscription period',
    description:
      'Takes customer + subscription IDs and (optionally) a billing period. Returns a ' +
      "draft invoice with line items computed from the period's real usage events plus " +
      'any recurring/seat/onetime strategies on the plan. When billing period is omitted, ' +
      "defaults to the subscription's current period. The draft is not sent until " +
      'someone sends it.',
  })
  @ApiResponse({ status: 201, description: 'Draft invoice created with line items' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Subscription or customer not found' })
  // Mirror the finance-lane gate on the canonical POST /v1/invoices/generate
  // (MANAGE_MONEY_ROLES). Without it, any same-org key of any role could generate an
  // invoice through this alias. @OrgFromUser because the route is
  // param-less and scoped to req.user.organizationId.
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async generateInvoice(@Req() req: any, @Body() dto: GenerateInvoiceDto) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    // Cross-tenant WRITE: this handler resolves the caller's org from the API key
    // and passes it through so the service resolves the subscription ORG-SCOPED.
    // An org-A key can't generate a draft invoice against org B's subscriptionId.
    const invoice = await this.invoicesService.generateInvoice(
      dto.customerId,
      dto.subscriptionId,
      dto.billingPeriodStart,
      dto.billingPeriodEnd,
      organizationId,
    );
    return invoice;
  }

  // SDK-prefixed alias for POST /v1/invoices/:invoiceId/send, so
  // @marginfront/sdk and @marginfront/mcp can email a draft invoice to a
  // customer. Same behavior as the public route;
  // separate route so SDK traffic lands in the SDK throttler bucket
  // (60K/60s/org).
  @Post('invoices/:invoiceId/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SDK: send invoice email to customer',
    description:
      'Email an invoice to the customer with a Stripe Checkout deeplink. Use after ' +
      'generating a draft (or for re-sending an existing issued invoice). Optional body ' +
      'fields override defaults: recipientEmail (send to a different address than the ' +
      "customer's stored email), subject (custom subject line), message (note prepended " +
      'to the email body).',
  })
  @ApiResponse({ status: 200, description: 'Invoice email queued for send' })
  @ApiResponse({ status: 400, description: 'Invoice cannot be sent (e.g. already paid)' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  // Mirror the finance-lane gate on the canonical POST /v1/invoices/:id/send
  // (MANAGE_MONEY_ROLES).
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async sendInvoice(
    @Req() req: any,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: SendInvoiceDto,
  ) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    // SDK API keys are per-org, so thread the caller's org into the send so a
    // cross-tenant invoiceId 404s for SDK callers too (matches the REST surface).
    const result = await this.invoicesService.sendInvoiceEmail(invoiceId, organizationId, dto);
    return result;
  }

  // ============================================
  // ANALYTICS / USAGE
  // ============================================

  @Get('analytics/usage')
  @ApiOperation({
    summary: 'Get usage analytics',
    description: 'Get aggregated usage analytics with flexible filtering and grouping',
  })
  @ApiResponse({
    status: 200,
    description: 'Usage analytics retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  async getUsageAnalytics(@Req() req: any, @Query() query: QuerySdkUsageDto) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getUsageAnalytics(organizationId, query);
  }

  // ============================================
  // SUBSCRIPTIONS
  // ============================================

  @Get('subscriptions')
  @ApiOperation({
    summary: 'Get subscriptions',
    description: 'Retrieve subscriptions with optional filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Subscriptions retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  async getSubscriptions(@Req() req: any, @Query() query: QuerySdkSubscriptionsDto) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getSubscriptions(organizationId, query);
  }

  @Get('subscriptions/:subscriptionId')
  @ApiOperation({
    summary: 'Get subscription by ID',
    description: 'Retrieve a specific subscription with usage summary',
  })
  @ApiResponse({
    status: 200,
    description: 'Subscription retrieved successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing API key',
  })
  @ApiResponse({
    status: 404,
    description: 'Subscription not found',
  })
  async getSubscription(@Req() req: any, @Param('subscriptionId') subscriptionId: string) {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new Error('Organization ID not found in authenticated user');
    }
    return this.sdkService.getSubscription(organizationId, subscriptionId);
  }
}
