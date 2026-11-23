import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { RevenueMetricsService } from './revenue-metrics.service';
import { QueryUsageAnalyticsDto } from './dto/query-usage-analytics.dto';
import { QueryCostAnalyticsDto } from './dto/query-cost-analytics.dto';
import { QuerySubscriptionAnalyticsDto } from './dto/query-subscription-analytics.dto';
import { QueryRevenueMetricsDto, RevenueVariantEnum } from './dto/query-revenue-metrics.dto';
import { QueryCostMetricsDto } from './dto/query-cost-metrics.dto';
import { QueryMrrDto, MrrVariantEnum } from './dto/query-mrr.dto';
import { QueryCustomerAnalyticsDto } from './dto/query-customer-analytics.dto';
import { QueryAgentAnalyticsDto } from './dto/query-agent-analytics.dto';
import { QueryProfitabilityAnalyticsDto } from './dto/query-profitability-analytics.dto';
import { QueryAggregateEventsDto } from './dto/query-aggregate-events.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

// Canonical:    /v1/analytics/*
// Alias:        /v1/org/:orgId/analytics/*
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Analytics')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller()
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  @Get(['analytics/usage', 'org/:orgId/analytics/usage'])
  @ApiOperation({
    summary: 'Get usage analytics with flexible filtering and breakdown options',
  })
  @ApiResponse({ status: 200, description: 'Returns usage analytics data' })
  async getUsageAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryUsageAnalyticsDto,
  ) {
    return this.analyticsService.getUsageAnalytics(user.organizationId, queryDto);
  }

  @Get(['analytics/costs', 'org/:orgId/analytics/costs'])
  @ApiOperation({
    summary: 'Get cost analytics with flexible filtering and breakdown options',
  })
  @ApiResponse({ status: 200, description: 'Returns cost analytics data' })
  async getCostAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryCostAnalyticsDto,
  ) {
    return this.analyticsService.getCostAnalytics(user.organizationId, queryDto);
  }

  @Get([
    'analytics/subscription/:subscriptionId',
    'org/:orgId/analytics/subscription/:subscriptionId',
  ])
  @ApiOperation({
    summary: 'Get subscription analytics data for a specific subscription',
  })
  @ApiResponse({ status: 200, description: 'Returns subscription analytics data' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async getSubscriptionAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriptionId') subscriptionId: string,
    @Query() queryDto: QuerySubscriptionAnalyticsDto,
  ) {
    return this.analyticsService.getSubscriptionAnalytics(
      user.organizationId,
      subscriptionId,
      queryDto,
    );
  }

  @Get(['analytics/customer', 'org/:orgId/analytics/customer'])
  @ApiOperation({
    summary: 'Get customer analytics - LTV, usage patterns, invoices, signal distribution',
  })
  @ApiResponse({ status: 200, description: 'Returns customer analytics data' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async getCustomerAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryCustomerAnalyticsDto,
  ) {
    const { customerId, startDate, endDate, groupBy } = queryDto;
    return this.analyticsService.getCustomerAnalytics(user.organizationId, {
      customerId,
      startDate,
      endDate,
      groupBy,
    });
  }

  @Get(['analytics/agent', 'org/:orgId/analytics/agent'])
  @ApiOperation({
    summary: 'Get agent analytics - Performance, customer distribution, revenue attribution',
  })
  @ApiResponse({ status: 200, description: 'Returns agent analytics data' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getAgentAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryAgentAnalyticsDto,
  ) {
    const { agentId, startDate, endDate, groupBy } = queryDto;
    return this.analyticsService.getAgentAnalytics(user.organizationId, {
      agentId,
      startDate,
      endDate,
      groupBy,
    });
  }

  @Get(['analytics/revenue', 'org/:orgId/analytics/revenue'])
  @ApiOperation({
    summary:
      'Get revenue analytics. Canonical RevenueMetrics shape when any entity filter (customerId / subscriptionId / signalId) is set OR when variant=canonical is passed; legacy MRR-trio breakdown otherwise.',
  })
  @ApiResponse({ status: 200, description: 'Returns revenue analytics data' })
  async getRevenueAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryRevenueMetricsDto,
    @Query('groupBy') groupBy?: string,
  ) {
    const { startDate, endDate, customerId, agentId, signalId, subscriptionId, variant } = queryDto;

    // Canonical branch. Triggered any time the caller narrows by customer /
    // subscription / signal OR explicitly asks for the canonical shape via
    // variant=canonical. The SDK `client.analytics.revenue()` method always
    // passes variant=canonical so it can return `RevenueMetrics` even for
    // org-wide calls; dashboard consumers leave variant off and get the
    // org-wide MRR-trio breakdown shape.
    if (customerId || subscriptionId || signalId || variant === RevenueVariantEnum.CANONICAL) {
      return this.revenueMetrics.getRevenueMetrics(
        user.organizationId,
        {
          start: new Date(startDate),
          end: new Date(endDate),
        },
        { customerId, agentId, signalId, subscriptionId },
      );
    }

    // Org-wide branch: MRR trio + invoice totals + periodic breakdowns,
    // computed from the canonical library.
    return this.analyticsService.getRevenueAnalytics(user.organizationId, {
      startDate,
      endDate,
      groupBy,
      agentId,
    });
  }

  /**
   * Canonical cost metrics endpoint.
   *
   * Wraps `canonGetCostMetrics` directly. Returns the full `CostMetrics`
   * shape (cost + eventCount + byAgent/byCustomer/bySignal/byDay/byPlan/
   * byModel/byRepo/byBranch + optional priorWindow trend). Customer scope via
   * `customerId` parameter routes through the canonical filter.
   */
  @Get(['analytics/cost', 'org/:orgId/analytics/cost'])
  @ApiOperation({
    summary:
      'Canonical cost metrics. Returns full CostMetrics shape (byAgent/byCustomer/bySignal/byDay/byPlan/byModel/byRepo/byBranch) with optional prior-window trend. byRepo/byBranch group by the git coordinates recorded on internal coding events; events without them land in the null bucket.',
  })
  @ApiResponse({ status: 200, description: 'Returns canonical CostMetrics' })
  async getCostMetrics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryCostMetricsDto,
  ) {
    const {
      startDate,
      endDate,
      customerId,
      agentId,
      signalId,
      subscriptionId,
      includePriorWindow,
    } = queryDto;
    const windowStart = new Date(startDate);
    const windowEnd = new Date(endDate);

    let priorWindow: { start: Date; end: Date } | undefined;
    if (includePriorWindow) {
      const periodDays = Math.max(
        1,
        Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const priorEnd = new Date(windowStart);
      priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
      priorEnd.setUTCHours(23, 59, 59, 999);
      const priorStart = new Date(priorEnd);
      priorStart.setUTCDate(priorStart.getUTCDate() - periodDays);
      priorWindow = { start: priorStart, end: priorEnd };
    }

    return this.revenueMetrics.getCostMetrics(
      user.organizationId,
      { start: windowStart, end: windowEnd },
      { customerId, agentId, signalId, subscriptionId },
      { priorWindow },
    );
  }

  /**
   * Canonical MRR endpoint. MRR1, MRR2, MRR3, or all three.
   *
   * Canon MRR1. Contracted recurring value of active subs (recurring +
   * seat, monthly-normalized; usage/onetime excluded).
   * Canon MRR2 (run-rate). Contract commitments plus last-30-days usage,
   * monthly-normalized.
   * Canon MRR3 (committed). Contractual floor only, usage replaced with
   * strategy.minimumCommitment × rate.
   */
  @Get(['analytics/mrr', 'org/:orgId/analytics/mrr'])
  @ApiOperation({
    summary:
      'Canonical MRR. variant=canonical|runRate|committed|all. Optional customerId / subscriptionId narrows the result.',
  })
  @ApiResponse({ status: 200, description: 'Returns MRR data for the chosen variant' })
  async getMrr(@CurrentUser() user: AuthenticatedUser, @Query() queryDto: QueryMrrDto) {
    const { variant = MrrVariantEnum.CANONICAL, customerId, subscriptionId } = queryDto;
    const orgId = user.organizationId;
    const filters = { customerId, subscriptionId };

    switch (variant) {
      case MrrVariantEnum.CANONICAL: {
        const r = await this.revenueMetrics.getMrr(orgId, filters);
        return { variant, ...r };
      }
      case MrrVariantEnum.RUN_RATE: {
        const r = await this.revenueMetrics.getRunRateMrr(orgId, filters);
        return { variant, ...r };
      }
      case MrrVariantEnum.COMMITTED: {
        const r = await this.revenueMetrics.getCommittedMrr(orgId, filters);
        return { variant, ...r };
      }
      case MrrVariantEnum.ALL: {
        const [canonical, runRate, committed] = await Promise.all([
          this.revenueMetrics.getMrr(orgId, filters),
          this.revenueMetrics.getRunRateMrr(orgId, filters),
          this.revenueMetrics.getCommittedMrr(orgId, filters),
        ]);
        return { variant, canonical, runRate, committed };
      }
    }
  }

  /**
   * Canonical Agent-Earned endpoint.
   *
   * Returns the AgentEarned shape (canon R1 pure). Events × pricing-strategy
   * rate only. No recurring, no seat, no onetime fees. This is the leading
   * indicator at the top of the Earned → Billed → Collected funnel and the
   * surface end-to-end scenarios assert against for usage-only revenue.
   */
  @Get(['analytics/agent-earned', 'org/:orgId/analytics/agent-earned'])
  @ApiOperation({
    summary:
      'Canonical Agent-Earned (R1). Events × pricing-strategy rate. Excludes recurring / seat / onetime. Filters: customerId, agentId, signalId, subscriptionId.',
  })
  @ApiResponse({ status: 200, description: 'Returns canonical AgentEarned' })
  async getAgentEarned(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryRevenueMetricsDto,
  ) {
    const { startDate, endDate, customerId, agentId, signalId, subscriptionId } = queryDto;
    return this.revenueMetrics.getAgentEarned(
      user.organizationId,
      {
        start: new Date(startDate),
        end: new Date(endDate),
      },
      { customerId, agentId, signalId, subscriptionId },
    );
  }

  /**
   * Canonical invoice-totals endpoint.
   *
   * Returns `InvoiceTotals` (billed / collected / draft / outstanding /
   * overdueAmount / overdueCount / invoicesSentCount) per canon I2 + I3.
   * Scope with optional `customerId`. The single place per-customer
   * billed / collected math runs across the codebase.
   */
  @Get(['analytics/invoice-totals', 'org/:orgId/analytics/invoice-totals'])
  @ApiOperation({
    summary:
      'Canonical InvoiceTotals (I2 + I3). Billed / collected / draft / outstanding / overdue for the window. Optional customerId scope.',
  })
  @ApiResponse({ status: 200, description: 'Returns canonical InvoiceTotals' })
  async getInvoiceTotals(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryRevenueMetricsDto,
  ) {
    const { startDate, endDate, customerId } = queryDto;
    return this.revenueMetrics.getInvoiceTotals(
      user.organizationId,
      {
        start: new Date(startDate),
        end: new Date(endDate),
      },
      { customerId },
    );
  }

  @Get(['analytics/profitability', 'org/:orgId/analytics/profitability'])
  @ApiOperation({
    summary:
      'Get profitability analytics - Profit margins, cost vs usage (Agent-Earned) revenue per canon R1, by signal',
  })
  @ApiResponse({ status: 200, description: 'Returns profitability analytics data' })
  async getProfitabilityAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryProfitabilityAnalyticsDto,
  ) {
    const { startDate, endDate, customerId, agentId } = queryDto;
    return this.analyticsService.getProfitabilityAnalytics(user.organizationId, {
      startDate,
      endDate,
      customerId,
      agentId,
    });
  }

  @Get(['analytics/events/aggregate', 'org/:orgId/analytics/events/aggregate'])
  @ApiOperation({
    summary: 'Enhanced flexible event aggregation with dimension support',
  })
  @ApiResponse({ status: 200, description: 'Returns aggregated event data' })
  async aggregateEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: QueryAggregateEventsDto,
  ) {
    const {
      startDate,
      endDate,
      groupBy,
      customerId,
      customerExternalId,
      agentId,
      signalId,
      dimension,
    } = queryDto;
    return this.analyticsService.aggregateEvents(user.organizationId, {
      startDate,
      endDate,
      groupBy,
      customerId,
      customerExternalId,
      agentId,
      signalId,
      dimension,
    });
  }
}
