import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { Public } from '../auth/decorators/public.decorator';
import { CronSecretGuard } from '../../common/guards/cron-secret.guard';
// Invoices ARE the books. Every write handler below is gated so only
// a Manage-MONEY role (owner/admin/finance) in the caller's own org can mutate them. We
// reuse OrgRoleGuard but with MANAGE_MONEY_ROLES (finance included), NOT
// ORG_MANAGE_ROLES (owner/admin only) — locking finance out of the books would defeat the
// finance seat. Applied PER-METHOD on writes only; GET reads carry no role gate. The same MANAGE_MONEY_ROLES constant feeds the dashboard's money actions.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  RecordPaymentDto,
  CreateRefundDto,
  SendInvoiceDto,
  QueryInvoicesDto,
  GenerateInvoiceDto,
} from './dto/invoice.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

// Canonical:    /v1/invoices
// Alias:        /v1/org/:orgId/invoices
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Invoices')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get(['invoices', 'org/:orgId/invoices'])
  @ApiOperation({ summary: 'Get all invoices' })
  async getInvoices(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryInvoicesDto) {
    return this.invoicesService.getInvoices(user.organizationId, query);
  }

  @Post(['invoices', 'org/:orgId/invoices'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new invoice' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async createInvoice(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInvoiceDto) {
    const invoice = await this.invoicesService.createInvoice(user.organizationId, dto);
    return invoice;
  }

  // Server-to-server endpoint for the dashboard's "Generate from
  // Subscription" Server Action. Same behavior as the public /v1/invoices/generate endpoint
  // below, but authenticated via the shared CRON_SECRET (which the dashboard Server Action
  // reads from its own env). Separate route so the public API surface stays documented +
  // clean — this one is internal-only.
  //
  // CRON_SECRET must be set to the same value on BOTH the API and the dashboard.
  // Exempt from EVERY throttler bucket, not only default. WHY ALL THREE, NOT A BARE
  // @SkipThrottle(): a no-arg @SkipThrottle() defaults to { default: true },
  // so it skips ONLY the default bucket and leaves the public bucket (60/60s, keyed by
  // IP) applying. This route is @Public(), so it has no req.user and falls back to IP
  // keying — and every call can arrive from the dashboard host's one shared egress IP.
  // With throttling enforced, a normal burst of "Generate from Subscription" clicks from
  // that one IP could trip the 60/60s public bucket and 429 a legit invoice generation.
  // Naming all three (default + public + sdk) guarantees
  // no bucket can ever throttle this server-to-server route.
  @Post('invoices/generate-internal')
  @Public()
  @SkipThrottle({ default: true, public: true, sdk: true })
  @UseGuards(CronSecretGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'INTERNAL: generate draft invoice (authenticated by CRON_SECRET, no API key)',
    description:
      'For server-to-server calls from the dashboard Server Action. Same logic as ' +
      'POST /v1/invoices/generate; different auth scheme. Do not expose to external consumers.',
  })
  async generateInvoiceInternal(@Body() dto: GenerateInvoiceDto) {
    return this.invoicesService.generateInvoice(
      dto.customerId,
      dto.subscriptionId,
      dto.billingPeriodStart,
      dto.billingPeriodEnd,
    );
  }

  @Post(['invoices/generate', 'org/:orgId/invoices/generate'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate a draft invoice from a subscription period',
    description:
      'Takes a customer + subscription and (optionally) a billing period. ' +
      "Returns a draft invoice with line items computed from the period's real usage events. " +
      "When billing period is omitted, defaults to the subscription's current period — the right " +
      "answer for 99% of cron-driven and one-click 'bill now' flows.",
  })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async generateInvoice(@CurrentUser() user: AuthenticatedUser, @Body() dto: GenerateInvoiceDto) {
    // Cross-tenant WRITE: thread the caller's own org (from the
    // authenticated principal, never from the URL/body) so the service resolves the
    // subscription INSIDE this org. Without it, a money-role caller in org A could
    // pass org B's subscriptionId and create/read a draft invoice in org B.
    const invoice = await this.invoicesService.generateInvoice(
      dto.customerId,
      dto.subscriptionId,
      dto.billingPeriodStart,
      dto.billingPeriodEnd,
      user.organizationId,
    );
    return invoice;
  }

  @Get(['invoices/:invoiceId', 'org/:orgId/invoices/:invoiceId'])
  @ApiOperation({ summary: 'Get invoice by ID' })
  async getInvoice(@CurrentUser() user: AuthenticatedUser, @Param('invoiceId') invoiceId: string) {
    return this.invoicesService.getInvoiceById(invoiceId, user.organizationId);
  }

  @Put(['invoices/:invoiceId', 'org/:orgId/invoices/:invoiceId'])
  @ApiOperation({ summary: 'Update invoice' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async updateInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    const result = await this.invoicesService.updateInvoice(invoiceId, user.organizationId, dto);
    return result;
  }

  @Post(['invoices/:invoiceId/finalize', 'org/:orgId/invoices/:invoiceId/finalize'])
  @ApiOperation({ summary: 'Finalize invoice' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async finalizeInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    const result = await this.invoicesService.finalizeInvoice(invoiceId, user.organizationId);
    return result;
  }

  @Post(['invoices/:invoiceId/mark-paid', 'org/:orgId/invoices/:invoiceId/mark-paid'])
  @ApiOperation({ summary: 'Mark invoice as paid' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async markAsPaid(@CurrentUser() user: AuthenticatedUser, @Param('invoiceId') invoiceId: string) {
    const result = await this.invoicesService.markAsPaid(invoiceId, user.organizationId);
    return result;
  }

  @Post(['invoices/:invoiceId/void', 'org/:orgId/invoices/:invoiceId/void'])
  @ApiOperation({ summary: 'Void invoice' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async voidInvoice(@CurrentUser() user: AuthenticatedUser, @Param('invoiceId') invoiceId: string) {
    const result = await this.invoicesService.voidInvoice(invoiceId, user.organizationId);
    return result;
  }

  @Post(['invoices/:invoiceId/send', 'org/:orgId/invoices/:invoiceId/send'])
  @ApiOperation({ summary: 'Send invoice email' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async sendInvoiceEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: SendInvoiceDto,
  ) {
    const result = await this.invoicesService.sendInvoiceEmail(invoiceId, user.organizationId, dto);
    return result;
  }

  @Get(['invoices/:invoiceId/pdf', 'org/:orgId/invoices/:invoiceId/pdf'])
  @ApiOperation({ summary: 'Download invoice PDF' })
  @ApiResponse({ status: 200, description: 'PDF downloaded successfully' })
  async downloadInvoicePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.invoicesService.getInvoicePdf(invoiceId, user.organizationId);
  }

  @Get(['invoices/:invoiceId/payments', 'org/:orgId/invoices/:invoiceId/payments'])
  @ApiOperation({ summary: 'Get invoice payments' })
  async getInvoicePayments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.invoicesService.getInvoicePayments(invoiceId, user.organizationId);
  }

  @Get([
    'invoices/:invoiceId/payments/enhanced',
    'org/:orgId/invoices/:invoiceId/payments/enhanced',
  ])
  @ApiOperation({ summary: 'Get enhanced payment details with card info and refunds' })
  async getEnhancedPayments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.invoicesService.getEnhancedPayments(invoiceId, user.organizationId);
  }

  @Post(['invoices/:invoiceId/payments', 'org/:orgId/invoices/:invoiceId/payments'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a payment' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async recordPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: RecordPaymentDto,
  ) {
    const result = await this.invoicesService.recordPayment(invoiceId, user.organizationId, dto);
    return result;
  }

  @Get([
    'invoices/:invoiceId/payments/:paymentId',
    'org/:orgId/invoices/:invoiceId/payments/:paymentId',
  ])
  @ApiOperation({ summary: 'Get payment details' })
  async getPayment(@CurrentUser() user: AuthenticatedUser, @Param('paymentId') paymentId: string) {
    return this.invoicesService.getPayment(paymentId, user.organizationId);
  }

  @Post([
    'invoices/:invoiceId/payments/:paymentId/refund',
    'org/:orgId/invoices/:invoiceId/payments/:paymentId/refund',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create refund for a payment' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async createRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId') paymentId: string,
    @Body() dto: CreateRefundDto,
  ) {
    return this.invoicesService.createRefund(paymentId, user.organizationId, dto);
  }

  @Get([
    'invoices/:invoiceId/payments/:paymentId/refunds',
    'org/:orgId/invoices/:invoiceId/payments/:paymentId/refunds',
  ])
  @ApiOperation({ summary: 'Get refunds for a payment' })
  async getPaymentRefunds(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId') paymentId: string,
  ) {
    return this.invoicesService.getPaymentRefunds(paymentId, user.organizationId);
  }

  @Get(['invoices/:invoiceId/reminders', 'org/:orgId/invoices/:invoiceId/reminders'])
  @ApiOperation({ summary: 'Get reminder status' })
  async getReminderStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.invoicesService.getReminderStatus(invoiceId, user.organizationId);
  }

  @Post(['invoices/:invoiceId/reminders/pause', 'org/:orgId/invoices/:invoiceId/reminders/pause'])
  @ApiOperation({ summary: 'Pause reminders' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async pauseReminders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    const result = await this.invoicesService.pauseReminders(invoiceId, user.organizationId);
    return result;
  }

  @Post(['invoices/:invoiceId/reminders/resume', 'org/:orgId/invoices/:invoiceId/reminders/resume'])
  @ApiOperation({ summary: 'Resume reminders' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async resumeReminders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    const result = await this.invoicesService.resumeReminders(invoiceId, user.organizationId);
    return result;
  }

  @Post(['invoices/:invoiceId/reminders/send', 'org/:orgId/invoices/:invoiceId/reminders/send'])
  @ApiOperation({ summary: 'Send manual reminder' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async sendManualReminder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    const result = await this.invoicesService.sendManualReminder(invoiceId, user.organizationId);
    return result;
  }
}
