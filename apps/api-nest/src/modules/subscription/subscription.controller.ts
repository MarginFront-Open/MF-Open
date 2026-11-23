import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';
// The ladder-alert evaluation rides the SAME single
// cron as invoice dispatch (no separate vercel.json entry). It runs after the invoice
// pass, guarded so an alert failure can never sink the billing run.
import { CostControlService } from '../cost-control/cost-control.service';
// The staged pool-alert evaluation is the cron's
// third job, same isolation contract as the cap-alert job above it.
import { CustomerAlertsService } from '../customer-alerts/customer-alerts.service';
import { PoolAlertEvaluator } from '../credit-pool/pool-alert-evaluator.service';
import {
  CreateSubscriptionDto,
  UpdateSubscriptionDto,
  UpdateInvoiceDatesDto,
  QuerySubscriptionDto,
  QueryChangelogDto,
} from './dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { Public } from '../auth/decorators/public.decorator';
import { CronSecretGuard } from '../../common/guards/cron-secret.guard';
// Subscriptions ARE the books (they drive what a customer is billed).
// Every write below is gated so only a Manage-MONEY role (owner/admin/finance) in the
// caller's own org can mutate them — same lock and same constant as the invoice controller
// and the dashboard subscription Server Actions, so a member denied in the UI can't replay
// their token against this REST surface. @OrgFromUser because the service always scopes the
// write to user.organizationId (the :orgId alias is ignored). GET reads carry no role gate.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_MONEY_ROLES } from '@marginfront/db';
import { getUserId } from '../../common/helpers/get-user-id';
// Per-subscription canonical revenue endpoint wraps the shared
// RevenueMetricsService. Defined in the analytics module and exported there.
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

// Canonical:    /v1/subscriptions
// Alias:        /v1/org/:orgId/subscriptions
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Subscriptions')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly revenueMetrics: RevenueMetricsService,
    // Scheduler endpoints below delegate to the billing service.
    private readonly subscriptionBilling: SubscriptionBillingService,
    // Cap ladder-alert evaluation, run inside the single cron dispatch.
    private readonly costControl: CostControlService,
    // Staged pool-alert evaluation + expired-grant sweep, cron job #3.
    private readonly poolAlerts: PoolAlertEvaluator,
    // Customer-watch backstop sweep, cron job #4.
    private readonly customerAlerts: CustomerAlertsService,
  ) {}

  @Post(['subscriptions', 'org/:orgId/subscriptions'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new subscription' })
  @ApiResponse({ status: 201, description: 'Subscription created successfully' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async createSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Request() req,
    @Body() dto: CreateSubscriptionDto,
  ) {
    const subscription = await this.subscriptionService.createSubscription(
      user.organizationId,
      getUserId(req.user),
      dto,
    );
    return subscription;
  }

  @Get(['subscriptions', 'org/:orgId/subscriptions'])
  @ApiOperation({ summary: 'Get all subscriptions for organization' })
  @ApiResponse({ status: 200, description: 'Subscriptions retrieved successfully' })
  async getSubscriptions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QuerySubscriptionDto,
  ) {
    return this.subscriptionService.getSubscriptionsByOrg(user.organizationId, query);
  }

  @Get(['subscriptions/:subscriptionId', 'org/:orgId/subscriptions/:subscriptionId'])
  @ApiOperation({ summary: 'Get subscription by ID' })
  @ApiResponse({ status: 200, description: 'Subscription retrieved successfully' })
  async getSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Query('includeDetails') includeDetails?: boolean,
  ) {
    return this.subscriptionService.getSubscriptionById(
      subscriptionId,
      user.organizationId,
      includeDetails || false,
    );
  }

  @Patch(['subscriptions/:subscriptionId', 'org/:orgId/subscriptions/:subscriptionId'])
  @ApiOperation({ summary: 'Update subscription' })
  @ApiResponse({ status: 200, description: 'Subscription updated successfully' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async updateSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Request() req,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    const result = await this.subscriptionService.updateSubscription(
      subscriptionId,
      user.organizationId,
      getUserId(req.user),
      dto,
    );
    return result;
  }

  @Patch([
    'subscriptions/:subscriptionId/invoice-dates',
    'org/:orgId/subscriptions/:subscriptionId/invoice-dates',
  ])
  @ApiOperation({ summary: 'Update active subscription invoice dates' })
  @ApiResponse({ status: 200, description: 'Invoice dates updated successfully' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async updateInvoiceDates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Request() req,
    @Body() dto: UpdateInvoiceDatesDto,
  ) {
    const result = await this.subscriptionService.updateInvoiceDates(
      subscriptionId,
      user.organizationId,
      getUserId(req.user),
      dto,
    );
    return result;
  }

  @Get([
    'subscriptions/:subscriptionId/changelog',
    'org/:orgId/subscriptions/:subscriptionId/changelog',
  ])
  @ApiOperation({ summary: 'Get subscription change logs' })
  @ApiResponse({ status: 200, description: 'Change logs retrieved successfully' })
  async getChangeLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Query() query: QueryChangelogDto,
  ) {
    return this.subscriptionService.getSubscriptionChangeLogs(
      subscriptionId,
      query,
      user.organizationId,
    );
  }

  /**
   * Canonical per-subscription revenue endpoint.
   *
   * Returns `RevenueMetrics` (canon R1 + R2) scoped to a single subscription
   * over a date window. Thin wrapper over RevenueMetricsService. Math lives
   * in the canonical library. If `startDate` / `endDate` are omitted, the
   * window defaults to the last 30 days (UTC).
   *
   * The SDK method `client.subscriptions.getWithRevenue(id)` wraps this
   * endpoint and merges the result with the regular subscription detail
   * shape.
   */
  @Get([
    'subscriptions/:subscriptionId/revenue',
    'org/:orgId/subscriptions/:subscriptionId/revenue',
  ])
  @ApiOperation({
    summary:
      'Canonical per-subscription revenue metrics (R1 + R2). Returns RevenueMetrics scoped to one subscription over the window.',
  })
  @ApiResponse({ status: 200, description: 'Returns RevenueMetrics for the subscription' })
  async getSubscriptionRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    return this.revenueMetrics.getRevenueMetrics(
      user.organizationId,
      { start, end },
      { subscriptionId },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Vercel Cron endpoints
  //
  // Vercel calls these on the schedule defined in apps/api-nest/vercel.json. It auto-injects
  // Authorization: Bearer <CRON_SECRET> on every request; CronSecretGuard verifies it.
  // Both routes are @Public() so they bypass the regular API-key auth (Vercel doesn't carry
  // a MarginFront API key) and @SkipThrottle() so the rate limiter never blocks them.
  //
  // Both are safe to call by hand for local testing: send the same
  // Authorization header with the CRON_SECRET env value.
  //
  // Vercel only fires these on a production deploy; anywhere else, schedule them yourself
  // (apps/api-nest/README.md lists both routes and their schedules).
  // ───────────────────────────────────────────────────────────────────────────

  // GET because Vercel Cron always issues GET requests
  // (https://vercel.com/docs/cron-jobs).
  //
  // @SkipThrottle() with no args ONLY skips the `default` throttler: the lib's
  // default arg is literally `{ default: true }`. Must list every bucket name
  // explicitly or the `sdk`/`public` throttlers still run and crash on the
  // first cold-start request.
  // The single-pass billing cron (vercel.json, 04:00 UTC). GET + explicit
  // per-bucket throttle skip, for the reasons above.
  @Get('subscriptions/cron/dispatch')
  @Public()
  @SkipThrottle({ default: true, sdk: true, public: true })
  @UseGuards(CronSecretGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'CRON: dispatch usage invoices in a single pass (issue + email customer + notify merchant)',
    description:
      'Scheduler endpoint (any cron service that sends the CRON_SECRET bearer token). Iterates ' +
      'every active usage/hybrid subscription whose nextUsageInvoiceAt has passed and, in one ' +
      'pass per sub: builds the invoice straight to "issued" with line items from real ' +
      'signal_events, generates the PDF, emails the end-customer, notifies the merchant, ' +
      'and advances the billing period + cycleNumber exactly once. The single ' +
      'period-advance is a compare-and-swap on nextUsageInvoiceAt, so a double-fire can ' +
      'never issue a duplicate invoice. Subs with zero billable usage get no invoice, and ' +
      'their period still advances. Per-subscription errors are logged and skipped, not allowed to kill the run. ' +
      'Authenticated via CRON_SECRET in the Authorization header.',
  })
  async cronDispatch() {
    const invoices = await this.subscriptionBilling.dispatchUsageInvoices();
    // Same cron, second job. Isolated so a cap-alert failure can never
    // sink the invoice run (its own per-cap errors are already caught inside).
    let capAlerts;
    try {
      capAlerts = await this.costControl.evaluateCapAlerts();
    } catch (err) {
      capAlerts = { error: err instanceof Error ? err.message : String(err) };
    }
    // Third job — staged pool alerts. Runs AFTER job #1 advanced
    // billing periods, which is exactly why the evaluator re-checks
    // just-ended periods first (the boundary rule), then current periods,
    // then sweeps expired grants. Isolated the same way: a pool failure can
    // never sink the invoice run.
    let poolAlerts;
    try {
      poolAlerts = await this.poolAlerts.evaluatePoolAlerts();
    } catch (err) {
      poolAlerts = { error: err instanceof Error ? err.message : String(err) };
    }
    // Fourth job — the customer-watch backstop sweep (revenue
    // watches can cross with no ingest event, so the cron is their only
    // guaranteed evaluation). Isolated the same way: a watch failure can never
    // sink the invoice run.
    let customerAlerts;
    try {
      customerAlerts = await this.customerAlerts.evaluateCustomerAlerts();
    } catch (err) {
      customerAlerts = { error: err instanceof Error ? err.message : String(err) };
    }
    return { ...invoices, capAlerts, poolAlerts, customerAlerts };
  }

  // Overdue-marking cron: marks issued past-due invoices overdue; nothing else
  // sets that status. GET + per-bucket throttle skip +
  // CronSecret, same contract as dispatch above. vercel.json fires it daily
  // at 05:00 UTC (an hour after dispatch).
  @Get('subscriptions/cron/mark-overdue')
  @Public()
  @SkipThrottle({ default: true, sdk: true, public: true })
  @UseGuards(CronSecretGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'CRON: mark issued invoices past their due date as overdue',
    description:
      'Scheduler endpoint (any cron service that sends the CRON_SECRET bearer token). Transitions every invoice still in "issued" ' +
      'whose dueDate has passed into "overdue" (statusReason=past_due), so the ' +
      'overdue metrics across the command center + dashboard reflect reality. ' +
      'Idempotent per run. Money paths are unaffected — overdue invoices stay fully payable. ' +
      'Authenticated via CRON_SECRET in the Authorization header.',
  })
  async cronMarkOverdue() {
    return this.subscriptionBilling.markOverdueInvoices();
  }
}
