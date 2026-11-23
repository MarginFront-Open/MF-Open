import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { avgPer, growthPercent, safeMarginPercent, shareOfTotal } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueMetricsService } from './revenue-metrics.service';
import {
  QueryUsageAnalyticsDto,
  GroupByEnum,
  BreakdownByEnum,
} from './dto/query-usage-analytics.dto';
import { QueryCostAnalyticsDto } from './dto/query-cost-analytics.dto';
import { QuerySubscriptionAnalyticsDto } from './dto/query-subscription-analytics.dto';
import { ANALYTICS_MAX_ROWS } from './analytics-bounds';

@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaService,
    private revenueMetrics: RevenueMetricsService,
  ) {}

  /**
   * Normalize an endDate string to end-of-day UTC (23:59:59.999) so that events
   * recorded on the last day of a query window are included.
   *
   * Without this, `new Date("2026-04-14")` resolves to 2026-04-14 00:00:00 UTC,
   * causing any event timestamped later on that day to be silently excluded
   * from analytics results, producing wrong dashboard totals for "today."
   *
   * Accepts full ISO timestamps too (returns them as-is via Date parsing).
   */
  private toEndOfDay(dateInput: string | Date): Date {
    const d = new Date(dateInput);
    // If caller passed a full ISO timestamp with a time component, respect it.
    // If they passed just a date (YYYY-MM-DD → midnight UTC), push to end of day.
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      d.setUTCHours(23, 59, 59, 999);
    }
    return d;
  }

  async getUsageAnalytics(organizationId: string, queryDto: QueryUsageAnalyticsDto) {
    const {
      startDate,
      endDate,
      groupBy = GroupByEnum.DAILY,
      customerId,
      agentId,
      signalId,
      breakdownBy,
    } = queryDto;

    const whereClause: any = {
      organizationId,
      usageDate: {
        gte: new Date(startDate),
        lte: this.toEndOfDay(endDate),
      },
    };

    if (customerId) {
      const customer = await this.prisma.customers.findUnique({ where: { id: customerId } });
      if (!customer) {
        return this._getEmptyUsageResponse(queryDto);
      }
      whereClause.customerExternalId = customer.externalId;
    }

    if (agentId) {
      const agent = await this.prisma.agents.findUnique({ where: { id: agentId } });
      if (!agent) {
        return this._getEmptyUsageResponse(queryDto);
      }
      whereClause.agentId = agentId;
    }

    if (signalId) {
      const signal = await this.prisma.signals.findUnique({ where: { id: signalId } });
      if (!signal) {
        return this._getEmptyUsageResponse(queryDto);
      }
      whereClause.signalId = signalId;
    }

    const events = await this.prisma.signal_events.findMany({
      where: whereClause,
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
          },
        },
        customers: {
          select: {
            id: true,
            name: true,
            externalId: true,
          },
        },
      },
      orderBy: {
        usageDate: 'asc',
      },
    });

    const timeSeriesData = this._aggregateTimeSeriesData(events, groupBy);
    const summary = this._calculateSummary(events);
    const metadata = this._extractMetadata(events);
    const dimensionBreakdown = breakdownBy
      ? this._createDimensionBreakdown(events, breakdownBy, groupBy)
      : undefined;

    return {
      dateRange: {
        start: startDate,
        end: endDate,
        groupBy,
      },
      filters: {
        customerId,
        agentId,
        signalId,
        breakdownBy,
      },
      summary,
      timeSeriesData,
      metadata,
      dimensionBreakdown,
    };
  }

  /**
   * Core totals + byAgent/byCustomer/bySignal/byDay route through the
   * canonical `getCostMetrics` (packages/db/src/lib/revenue-metrics.ts).
   * The `priorWindow` option gives period-over-period growth without any
   * hand-rolled "previous period" query.
   *
   * The extra response surfaces (service breakdown, volatility, forecast)
   * read the underlying events. That data isn't part of the canon shape and
   * lives on this endpoint only.
   */
  async getCostAnalytics(organizationId: string, queryDto: QueryCostAnalyticsDto) {
    const {
      startDate,
      endDate,
      groupBy = GroupByEnum.DAILY,
      customerId,
      agentId,
      signalId,
      includeServiceBreakdown = true,
    } = queryDto;

    // A missing customer/agent/signal returns the empty response shape.
    // The customer filter is translated to
    // customerExternalId for the raw-event reads AND threaded via
    // customerId into the canonical library.
    let customerExternalId: string | null = null;
    if (customerId) {
      const customer = await this.prisma.customers.findUnique({
        where: { id: customerId },
      });
      if (!customer) {
        return this._getEmptyCostResponse(queryDto);
      }
      customerExternalId = customer.externalId;
    }
    if (agentId) {
      const agent = await this.prisma.agents.findUnique({ where: { id: agentId } });
      if (!agent) {
        return this._getEmptyCostResponse(queryDto);
      }
    }
    if (signalId) {
      const signal = await this.prisma.signals.findUnique({
        where: { id: signalId },
      });
      if (!signal) {
        return this._getEmptyCostResponse(queryDto);
      }
    }

    // Canon window (C2: usageDate). endDate normalizes to end-of-day UTC
    // so events logged late on the last day aren't silently excluded.
    const windowStart = new Date(startDate);
    const windowEnd = this.toEndOfDay(endDate);

    // Canon prior window. Symmetric span immediately preceding primary.
    // The library computes the prior totals in a second query when this
    // option is supplied.
    const periodDays = Math.max(
      1,
      Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24)),
    );
    const priorWindowEnd = new Date(windowStart);
    priorWindowEnd.setUTCDate(priorWindowEnd.getUTCDate() - 1);
    priorWindowEnd.setUTCHours(23, 59, 59, 999);
    const priorWindowStart = new Date(priorWindowEnd);
    priorWindowStart.setUTCDate(priorWindowStart.getUTCDate() - periodDays);

    // Canon cost aggregation. No hand-rolled per-event summing.
    const canonCost = await this.revenueMetrics.getCostMetrics(
      organizationId,
      { start: windowStart, end: windowEnd },
      {
        customerId: customerId || undefined,
        agentId: agentId || undefined,
        signalId: signalId || undefined,
      },
      { priorWindow: { start: priorWindowStart, end: priorWindowEnd } },
    );

    // The service-breakdown / volatility / forecast extras live outside the
    // canon shape, and the cost-analytics dashboard reads them, so the raw
    // events are read to produce those. The canon
    // totals above are the source of truth for any number a test can lock
    // down; these extras are presentation on top.
    const rawEventsWhere: any = {
      organizationId,
      usageDate: { gte: windowStart, lte: windowEnd },
    };
    if (customerExternalId) rawEventsWhere.customerExternalId = customerExternalId;
    if (agentId) rawEventsWhere.agentId = agentId;
    if (signalId) rawEventsWhere.signalId = signalId;

    const events = await this.prisma.signal_events.findMany({
      where: rawEventsWhere,
      include: {
        signals: {
          select: { id: true, name: true, shortName: true },
        },
        agents: {
          select: { id: true, name: true, agentCode: true },
        },
        customers: {
          select: { id: true, name: true, externalId: true },
        },
      },
      orderBy: { usageDate: 'asc' },
    });

    // Totals come from canonCost; the per-event aggregate helpers produce
    // the time-series and service-breakdown shapes. totalCost below must
    // match canonCost.cost.
    const timeSeriesData = this._aggregateCostTimeSeriesData(events, groupBy);
    const summary = {
      totalCost: canonCost.cost,
      totalEvents: canonCost.eventCount,
      totalQuantity: events.reduce((s, e) => s + Number(e.quantity || 0), 0),
      avgCostPerEvent: avgPer(canonCost.cost, canonCost.eventCount),
    };
    const priorCost = canonCost.prior?.cost ?? 0;
    const priorEvents = canonCost.prior?.eventCount ?? 0;
    const previousSummary = {
      totalCost: priorCost,
      totalEvents: priorEvents,
      totalQuantity: 0,
      avgCostPerEvent: avgPer(priorCost, priorEvents),
    };
    const serviceBreakdownArray = includeServiceBreakdown
      ? this._calculateServiceBreakdown(events)
      : [];
    const dimensionBreakdowns = this._calculateAllDimensionBreakdowns(events, groupBy);
    const trends = this._calculateTrends(summary, previousSummary);

    const uniquePeriods = new Set(timeSeriesData.map((d: any) => d.date)).size;

    const avgDailyCost = avgPer(summary.totalCost, periodDays);
    const forecast = {
      next30Days: avgDailyCost === null ? null : avgDailyCost * 30,
      next60Days: avgDailyCost === null ? null : avgDailyCost * 60,
      next90Days: avgDailyCost === null ? null : avgDailyCost * 90,
    };

    const serviceMetrics: Record<string, { cost: number; units: number; costPerUnit: number }> = {};
    events.forEach((event: any) => {
      if (event.usageCostData && typeof event.usageCostData === 'object') {
        Object.entries(event.usageCostData).forEach(([serviceName, data]: [string, any]) => {
          if (!serviceMetrics[serviceName]) {
            serviceMetrics[serviceName] = { cost: 0, units: 0, costPerUnit: 0 };
          }
          serviceMetrics[serviceName].cost += parseFloat(data.cost) || 0;
          serviceMetrics[serviceName].units += parseInt(data.units) || 0;
        });
      }
    });

    let highestService = { name: 'None', cost: 0, units: 0 };
    let mostExpensivePerUnit = { name: 'None', costPerUnit: 0 };
    Object.entries(serviceMetrics).forEach(([name, data]) => {
      data.costPerUnit = data.units > 0 ? data.cost / data.units : 0;
      if (data.cost > highestService.cost) {
        highestService = { name, cost: data.cost, units: data.units };
      }
      if (data.costPerUnit > mostExpensivePerUnit.costPerUnit) {
        mostExpensivePerUnit = { name, costPerUnit: data.costPerUnit };
      }
    });

    const dailyCosts = timeSeriesData.map((d: any) => d.totalCost || 0);
    const mean =
      dailyCosts.length > 0
        ? dailyCosts.reduce((a: number, b: number) => a + b, 0) / dailyCosts.length
        : 0;
    const squaredDiffs = dailyCosts.map((cost: number) => Math.pow(cost - mean, 2));
    const standardDeviation =
      squaredDiffs.length > 0
        ? Math.sqrt(squaredDiffs.reduce((a: number, b: number) => a + b, 0) / squaredDiffs.length)
        : 0;
    const coefficientOfVariation = mean > 0 ? standardDeviation / mean : 0;
    const volatility =
      coefficientOfVariation > 0.5 ? 'high' : coefficientOfVariation > 0.2 ? 'medium' : 'low';

    return {
      dateRange: {
        start: startDate,
        end: endDate,
        groupBy,
        totalDays: periodDays,
        uniquePeriods,
      },
      filters: {
        customerId: customerId || null,
        agentId: agentId || null,
        signalId: signalId || null,
        organizationId,
      },
      stats: {
        totalCost: summary.totalCost,
        totalEvents: summary.totalEvents,
        avgCostPerEvent: summary.avgCostPerEvent,
      },
      costSummary: {
        overall: {
          avgCostPerEvent: summary.avgCostPerEvent,
          avgDailyCost,
          avgPeriodCost: avgPer(summary.totalCost, uniquePeriods),
          totalCost: summary.totalCost,
          totalEvents: summary.totalEvents,
          periodOverPeriodGrowth: trends.costGrowth,
          eventGrowthRate: trends.eventGrowth,
          standardDeviation,
          volatility,
          trend: {
            direction:
              trends.costGrowth !== null && trends.costGrowth > 5
                ? 'increasing'
                : trends.costGrowth !== null && trends.costGrowth < -5
                  ? 'decreasing'
                  : 'stable',
            slope: trends.costGrowth === null ? null : trends.costGrowth / 100,
          },
        },
        services: {
          highest: highestService,
          mostExpensivePerUnit,
          topByAvgCost: Object.entries(serviceMetrics)
            .map(([serviceName, data]) => ({
              serviceName,
              avgCost: avgPer(data.cost, data.units),
              totalCost: data.cost,
              eventCount: data.units,
              volatility: 'low' as const,
              costPerUnit: data.costPerUnit,
            }))
            .sort((a, b) => b.totalCost - a.totalCost)
            .slice(0, 5),
        },
        providers: {
          highest: { name: 'Default', cost: summary.totalCost, units: summary.totalEvents },
        },
        unitTypes: {
          highest: { name: 'Default', cost: summary.totalCost, units: summary.totalEvents },
        },
        forecast,
      },
      timeSeriesData: timeSeriesData.map((d: any) => ({
        date: d.date,
        totalCost: d.totalCost || 0,
        eventCount: d.eventCount || 0,
        avgCostPerEvent: avgPer(d.totalCost || 0, d.eventCount || 0),
      })),
      serviceBreakdown: {
        summary: serviceBreakdownArray.map((s: any) => ({
          serviceName: s.signalName || s.serviceName || 'Unknown',
          totalCost: s.totalCost || 0,
          totalUnits: s.totalEvents || s.totalQuantity || 0,
          eventCount: s.totalEvents || 0,
          avgCostPerEvent: avgPer(s.totalCost, s.totalEvents),
          percentage: shareOfTotal(s.totalCost, summary.totalCost),
          volatility: 'low' as const,
          topProviders: [{ name: 'Default', cost: s.totalCost }],
        })),
        timeline: [],
      },
      dimensions: dimensionBreakdowns || {
        signal: { dimensionType: 'signal', summary: [], timeline: [] },
        agent: { dimensionType: 'agent', summary: [], timeline: [] },
        customer: { dimensionType: 'customer', summary: [], timeline: [] },
      },
      metadata: {
        signals: [],
        services: Object.keys(serviceMetrics).map((name) => ({
          name,
          providers: [],
          unitType: '',
        })),
        customers: [],
        agents: [],
      },
    };
  }

  async getSubscriptionAnalytics(
    organizationId: string,
    subscriptionId: string,
    queryDto: QuerySubscriptionAnalyticsDto,
  ) {
    const subscription = await this.prisma.subscriptions.findUnique({
      where: {
        id: subscriptionId,
        organizationId,
      },
      include: {
        customers: {
          select: {
            id: true,
            name: true,
            externalId: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
          },
        },
        pricing_plans: {
          include: {
            pricing_strategies: {
              include: {
                signals: {
                  select: {
                    id: true,
                    name: true,
                    shortName: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    if (!subscription.pricing_plans) {
      throw new BadRequestException('Subscription has no associated pricing plan');
    }

    if (!subscription.agents) {
      throw new BadRequestException('Subscription has no associated agent');
    }

    if (!subscription.customers) {
      throw new BadRequestException('Subscription has no associated customer');
    }

    const startDate =
      queryDto.billingPeriodStart ||
      subscription.currentBillingPeriodStart?.toISOString().split('T')[0];
    const endDate =
      queryDto.billingPeriodEnd ||
      subscription.currentBillingPeriodEnd?.toISOString().split('T')[0];

    if (!startDate || !endDate) {
      throw new BadRequestException('Billing period dates are required');
    }

    const customerExternalId = subscription.customers.externalId;

    const whereClause: any = {
      organizationId,
      agentId: subscription.agentId,
      usageDate: {
        gte: new Date(startDate),
        lte: this.toEndOfDay(endDate),
      },
    };

    if (customerExternalId) {
      whereClause.customerExternalId = customerExternalId;
    }

    const usageEvents = await this.prisma.signal_events.findMany({
      where: whereClause,
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
      },
      orderBy: {
        usageDate: 'asc',
      },
    });

    // Calculate usage by signal (display-only aggregation; the canonical
    // totalCost below is what any downstream math consumes).
    const usageBySignal = this._calculateUsageBySignal(usageEvents);

    // Canon revenue/cost for the subscription in the window. The subscriptionId filter
    // routes through getRevenueMetrics so recurring, seat, usage, and
    // onetime contributions are all in one number. Canon R1 + R2 + C1.
    const canonWindow = {
      start: new Date(startDate),
      end: this.toEndOfDay(endDate),
    };
    const subMetrics = await this.revenueMetrics.getRevenueMetrics(organizationId, canonWindow, {
      subscriptionId,
    });

    // Get invoices for this subscription in the period. Canon I3:
    // invoiceDate, not billingPeriodStart/End, not createdAt.
    const invoices = await this.prisma.invoices.findMany({
      where: {
        subscriptionId,
        invoiceDate: {
          gte: canonWindow.start,
          lte: canonWindow.end,
        },
      },
      orderBy: {
        invoiceDate: 'asc',
      },
    });

    const signalDetails = (subscription.pricing_plans.pricing_strategies || [])
      .filter((strategy: any) => strategy.signals)
      .map((strategy: any) => ({
        id: strategy.signals.id,
        name: strategy.signals.name,
        shortName: strategy.signals.shortName,
        pricingModel: strategy.pricingModel,
        chargeType: strategy.chargeType,
      }));

    return {
      subscription: {
        id: subscription.id,
        name: subscription.name,
        status: subscription.status,
        billingCycle: subscription.billingCycle,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        currentBillingPeriodStart: subscription.currentBillingPeriodStart,
        currentBillingPeriodEnd: subscription.currentBillingPeriodEnd,
      },
      agent: {
        id: subscription.agents.id,
        name: subscription.agents.name,
        agentCode: subscription.agents.agentCode,
      },
      customer: {
        id: subscription.customers.id,
        name: subscription.customers.name,
        externalId: subscription.customers.externalId,
      },
      plan: {
        id: subscription.pricing_plans.id,
        name: subscription.pricing_plans.name,
        description: subscription.pricing_plans.description,
      },
      billingPeriod: {
        start: startDate,
        end: endDate,
      },
      signalDetails,
      // Usage block. Canon totals first, detail breakdown second.
      usage: {
        totalEvents: subMetrics.eventCount,
        totalQuantity: usageEvents.reduce((s, e) => s + Number(e.quantity || 0), 0),
        totalCost: subMetrics.cost,
        totalRevenue: subMetrics.revenue,
        margin: subMetrics.margin,
        marginPercent: subMetrics.marginPercent,
        usageRevenue: subMetrics.usageRevenue,
        recurringRevenue: subMetrics.recurringRevenue,
        seatRevenue: subMetrics.seatRevenue,
        onetimeRevenue: subMetrics.onetimeRevenue,
        bySignal: usageBySignal,
      },
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        totalAmount: inv.totalAmount,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
      })),
    };
  }

  private _getEmptyUsageResponse(queryDto: QueryUsageAnalyticsDto) {
    return {
      dateRange: {
        start: queryDto.startDate,
        end: queryDto.endDate,
        groupBy: queryDto.groupBy,
      },
      filters: {
        customerId: queryDto.customerId,
        agentId: queryDto.agentId,
        signalId: queryDto.signalId,
        breakdownBy: queryDto.breakdownBy,
      },
      summary: {
        totalEvents: 0,
        totalQuantity: 0,
        totalCost: 0,
      },
      timeSeriesData: [],
      metadata: {
        signals: {},
        customers: {},
        agents: {},
      },
      dimensionBreakdown: queryDto.breakdownBy
        ? {
            dimensionType: queryDto.breakdownBy,
            summary: [],
            timeline: [],
          }
        : undefined,
    };
  }

  private _getEmptyCostResponse(queryDto: QueryCostAnalyticsDto) {
    const { startDate, endDate, groupBy, customerId, agentId, signalId } = queryDto;
    return {
      dateRange: { start: startDate, end: endDate, groupBy, totalDays: 0, uniquePeriods: 0 },
      filters: {
        customerId: customerId || null,
        agentId: agentId || null,
        signalId: signalId || null,
        organizationId: null,
      },
      stats: { totalCost: 0, totalEvents: 0, avgCostPerEvent: null },
      costSummary: {
        overall: {
          avgCostPerEvent: null,
          avgDailyCost: null,
          avgPeriodCost: null,
          totalCost: 0,
          totalEvents: 0,
          periodOverPeriodGrowth: null,
          eventGrowthRate: null,
          standardDeviation: 0,
          volatility: 'low' as const,
          trend: {
            direction: 'stable' as const,
            slope: null,
          },
        },
        services: {
          highest: { name: 'None', cost: 0, units: 0 },
          mostExpensivePerUnit: { name: 'None', costPerUnit: 0 },
          topByAvgCost: [],
        },
        providers: {
          highest: { name: 'None', cost: 0, units: 0 },
        },
        unitTypes: {
          highest: { name: 'None', cost: 0, units: 0 },
        },
        forecast: { next30Days: null, next60Days: null, next90Days: null },
      },
      timeSeriesData: [],
      serviceBreakdown: { summary: [], timeline: [] },
      dimensions: {
        signal: { dimensionType: 'signal', summary: [], timeline: [] },
        agent: { dimensionType: 'agent', summary: [], timeline: [] },
        customer: { dimensionType: 'customer', summary: [], timeline: [] },
      },
      metadata: { signals: [], services: [], customers: [], agents: [] },
    };
  }

  private _aggregateTimeSeriesData(events: any[], groupBy: GroupByEnum) {
    const dataMap = new Map<string, any>();

    events.forEach((event) => {
      const dateKey = this._getDateKey(event.usageDate, groupBy);

      if (!dataMap.has(dateKey)) {
        dataMap.set(dateKey, {
          date: dateKey,
          eventCount: 0,
          totalQuantity: 0,
          totalCost: 0,
        });
      }

      const entry = dataMap.get(dateKey);
      entry.eventCount += 1;
      entry.totalQuantity += Number(event.quantity || 0);
      entry.totalCost += Number(event.usageCost || 0);
    });

    return Array.from(dataMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  private _aggregateCostTimeSeriesData(events: any[], groupBy: GroupByEnum) {
    return this._aggregateTimeSeriesData(events, groupBy);
  }

  private _calculateSummary(events: any[]) {
    const totalEvents = events.length;
    const totalQuantity = events.reduce((sum, e) => sum + Number(e.quantity || 0), 0);
    const totalCost = events.reduce((sum, e) => sum + Number(e.usageCost || 0), 0);
    const avgCostPerEvent = totalEvents > 0 ? totalCost / totalEvents : 0;

    return {
      totalEvents,
      totalQuantity,
      totalCost,
      avgCostPerEvent,
    };
  }

  private _calculateCostSummary(events: any[]) {
    return this._calculateSummary(events);
  }

  private _extractMetadata(events: any[]) {
    const metadata: any = {
      signals: {},
      customers: {},
      agents: {},
    };

    events.forEach((event) => {
      if (event.signals && !metadata.signals[event.signalId]) {
        metadata.signals[event.signalId] = {
          id: event.signals.id,
          name: event.signals.name,
          shortName: event.signals.shortName,
        };
      }

      if (event.customers && !metadata.customers[event.customerId]) {
        metadata.customers[event.customerId] = {
          id: event.customers.id,
          name: event.customers.name,
          externalId: event.customers.externalId,
        };
      }

      if (event.agents && !metadata.agents[event.agentId]) {
        metadata.agents[event.agentId] = {
          id: event.agents.id,
          name: event.agents.name,
          agentCode: event.agents.agentCode,
        };
      }
    });

    return metadata;
  }

  private _createDimensionBreakdown(
    events: any[],
    breakdownBy: BreakdownByEnum,
    groupBy: GroupByEnum,
  ) {
    const summaryMap = new Map<string, any>();
    const timelineMap = new Map<string, Map<string, any>>();

    const getDimensionKey = (event: any) => {
      switch (breakdownBy) {
        case BreakdownByEnum.AGENT:
          return event.agentId;
        case BreakdownByEnum.CUSTOMER:
          return event.customerId;
        case BreakdownByEnum.SIGNAL:
          return event.signalId;
        default:
          return 'unknown';
      }
    };

    const getDimensionLabel = (event: any) => {
      switch (breakdownBy) {
        case BreakdownByEnum.AGENT:
          return event.agents?.name || event.agentId;
        case BreakdownByEnum.CUSTOMER:
          return event.customers?.name || event.customerId;
        case BreakdownByEnum.SIGNAL:
          return event.signals?.name || event.signalId;
        default:
          return 'Unknown';
      }
    };

    events.forEach((event) => {
      const dimensionKey = getDimensionKey(event);
      const dimensionLabel = getDimensionLabel(event);
      const dateKey = this._getDateKey(event.usageDate, groupBy);

      if (!summaryMap.has(dimensionKey)) {
        summaryMap.set(dimensionKey, {
          dimensionId: dimensionKey,
          dimensionLabel,
          totalEvents: 0,
          totalQuantity: 0,
          totalCost: 0,
        });
      }

      const summary = summaryMap.get(dimensionKey);
      summary.totalEvents += 1;
      summary.totalQuantity += Number(event.quantity || 0);
      summary.totalCost += Number(event.usageCost || 0);

      if (!timelineMap.has(dimensionKey)) {
        timelineMap.set(dimensionKey, new Map());
      }

      const dimTimeline = timelineMap.get(dimensionKey)!;
      if (!dimTimeline.has(dateKey)) {
        dimTimeline.set(dateKey, {
          date: dateKey,
          dimensionId: dimensionKey,
          dimensionLabel,
          eventCount: 0,
          totalQuantity: 0,
          totalCost: 0,
        });
      }

      const timelineEntry = dimTimeline.get(dateKey);
      timelineEntry.eventCount += 1;
      timelineEntry.totalQuantity += Number(event.quantity || 0);
      timelineEntry.totalCost += Number(event.usageCost || 0);
    });

    const timeline: any[] = [];
    timelineMap.forEach((dimTimeline) => {
      dimTimeline.forEach((entry) => timeline.push(entry));
    });

    timeline.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.dimensionId.localeCompare(b.dimensionId);
    });

    return {
      dimensionType: breakdownBy,
      // Cost-desc list, silently clamped to the top ANALYTICS_MAX_ROWS rows.
      summary: Array.from(summaryMap.values())
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, ANALYTICS_MAX_ROWS),
      timeline,
    };
  }

  private _calculateTrends(current: any, previous: any) {
    const costChange = current.totalCost - previous.totalCost;
    const costGrowth = growthPercent(current.totalCost, previous.totalCost);
    const eventsChange = current.totalEvents - previous.totalEvents;
    const eventGrowth = growthPercent(current.totalEvents, previous.totalEvents);

    return {
      costChange,
      costGrowth,
      eventsChange,
      eventGrowth,
    };
  }

  private _calculateServiceBreakdown(events: any[]) {
    const breakdown = new Map<string, any>();

    events.forEach((event) => {
      const signalId = event.signalId;

      if (!breakdown.has(signalId)) {
        breakdown.set(signalId, {
          signalId,
          signalName: event.signals?.name || 'Unknown',
          totalCost: 0,
          totalEvents: 0,
          totalQuantity: 0,
        });
      }

      const entry = breakdown.get(signalId);
      entry.totalCost += Number(event.usageCost || 0);
      entry.totalEvents += 1;
      entry.totalQuantity += Number(event.quantity || 0);
    });

    // Cost-desc list, silently clamped to the top ANALYTICS_MAX_ROWS rows.
    return Array.from(breakdown.values())
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, ANALYTICS_MAX_ROWS);
  }

  private _calculateAllDimensionBreakdowns(events: any[], groupBy: GroupByEnum) {
    const totalCost = events.reduce((sum, e) => sum + Number(e.usageCost || 0), 0);

    const signalBreakdown = new Map<string, any>();
    const signalTimeline = new Map<string, Map<string, any>>();

    const agentBreakdown = new Map<string, any>();
    const agentTimeline = new Map<string, Map<string, any>>();

    const customerBreakdown = new Map<string, any>();
    const customerTimeline = new Map<string, Map<string, any>>();

    events.forEach((event) => {
      const dateKey = this._getDateKey(event.usageDate, groupBy);
      const eventCost = Number(event.usageCost || 0);

      if (event.signalId) {
        if (!signalBreakdown.has(event.signalId)) {
          signalBreakdown.set(event.signalId, {
            id: event.signalId,
            name: event.signals?.name || 'Unknown',
            totalCost: 0,
            eventCount: 0,
          });
        }
        const signalEntry = signalBreakdown.get(event.signalId);
        signalEntry.totalCost += eventCost;
        signalEntry.eventCount += 1;

        if (!signalTimeline.has(dateKey)) {
          signalTimeline.set(dateKey, new Map());
        }
        const signalDateMap = signalTimeline.get(dateKey)!;
        if (!signalDateMap.has(event.signalId)) {
          signalDateMap.set(event.signalId, {
            id: event.signalId,
            name: event.signals?.name || 'Unknown',
            cost: 0,
          });
        }
        signalDateMap.get(event.signalId)!.cost += eventCost;
      }

      if (event.agentId) {
        if (!agentBreakdown.has(event.agentId)) {
          agentBreakdown.set(event.agentId, {
            id: event.agentId,
            name: event.agents?.name || 'Unknown',
            totalCost: 0,
            eventCount: 0,
          });
        }
        const agentEntry = agentBreakdown.get(event.agentId);
        agentEntry.totalCost += eventCost;
        agentEntry.eventCount += 1;

        if (!agentTimeline.has(dateKey)) {
          agentTimeline.set(dateKey, new Map());
        }
        const agentDateMap = agentTimeline.get(dateKey)!;
        if (!agentDateMap.has(event.agentId)) {
          agentDateMap.set(event.agentId, {
            id: event.agentId,
            name: event.agents?.name || 'Unknown',
            cost: 0,
          });
        }
        agentDateMap.get(event.agentId)!.cost += eventCost;
      }

      if (event.customerExternalId) {
        const customerId = event.customers?.id || event.customerExternalId;
        if (!customerBreakdown.has(customerId)) {
          customerBreakdown.set(customerId, {
            id: customerId,
            name: event.customers?.name || 'Unknown',
            totalCost: 0,
            eventCount: 0,
          });
        }
        const customerEntry = customerBreakdown.get(customerId);
        customerEntry.totalCost += eventCost;
        customerEntry.eventCount += 1;

        if (!customerTimeline.has(dateKey)) {
          customerTimeline.set(dateKey, new Map());
        }
        const customerDateMap = customerTimeline.get(dateKey)!;
        if (!customerDateMap.has(customerId)) {
          customerDateMap.set(customerId, {
            id: customerId,
            name: event.customers?.name || 'Unknown',
            cost: 0,
          });
        }
        customerDateMap.get(customerId)!.cost += eventCost;
      }
    });

    const formatBreakdown = (
      breakdown: Map<string, any>,
      timeline: Map<string, Map<string, any>>,
    ) => {
      // Cost-desc list, silently clamped to the top ANALYTICS_MAX_ROWS rows.
      const summaryArray = Array.from(breakdown.values())
        .map((item) => ({
          ...item,
          avgCostPerEvent: avgPer(item.totalCost, item.eventCount),
          percentage: shareOfTotal(item.totalCost, totalCost),
          topServices: [],
        }))
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, ANALYTICS_MAX_ROWS);

      const timelineArray = Array.from(timeline.entries())
        .map(([date, itemsMap]) => ({
          date,
          items: Array.from(itemsMap.values()),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        dimensionType: '',
        summary: summaryArray,
        timeline: timelineArray,
      };
    };

    return {
      signal: { ...formatBreakdown(signalBreakdown, signalTimeline), dimensionType: 'signal' },
      agent: { ...formatBreakdown(agentBreakdown, agentTimeline), dimensionType: 'agent' },
      customer: {
        ...formatBreakdown(customerBreakdown, customerTimeline),
        dimensionType: 'customer',
      },
    };
  }

  private _calculateUsageBySignal(events: any[]) {
    const bySignal = new Map<string, any>();

    events.forEach((event) => {
      const signalId = event.signalId;

      if (!bySignal.has(signalId)) {
        bySignal.set(signalId, {
          signalId,
          signalName: event.signals?.name || 'Unknown',
          shortName: event.signals?.shortName || '',
          totalEvents: 0,
          totalQuantity: 0,
          totalCost: 0,
        });
      }

      const entry = bySignal.get(signalId);
      entry.totalEvents += 1;
      entry.totalQuantity += Number(event.quantity || 0);
      entry.totalCost += Number(event.usageCost || 0);
    });

    return Array.from(bySignal.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);
  }

  private _getDateKey(date: Date, groupBy: GroupByEnum): string {
    const d = new Date(date);

    switch (groupBy) {
      case GroupByEnum.DAILY:
        return d.toISOString().split('T')[0];

      case GroupByEnum.WEEKLY: {
        const startOfWeek = new Date(d);
        const day = startOfWeek.getDay();
        const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
        startOfWeek.setDate(diff);
        return startOfWeek.toISOString().split('T')[0];
      }

      case GroupByEnum.MONTHLY:
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

      default:
        return d.toISOString().split('T')[0];
    }
  }

  async getCustomerAnalytics(
    organizationId: string,
    params: {
      customerId: string;
      startDate: string;
      endDate: string;
      groupBy?: string;
    },
  ) {
    const { customerId, startDate, endDate, groupBy = 'daily' } = params;

    if (!customerId) {
      throw new BadRequestException('Customer ID is required');
    }

    const customer = await this.prisma.customers.findUnique({
      where: { id: customerId, organizationId },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const subscriptions = await this.prisma.subscriptions.findMany({
      where: { customerId, organizationId },
      include: {
        pricing_plans: true,
        agents: true,
      },
    });

    const usageEvents = await this.prisma.signal_events.findMany({
      where: {
        organizationId,
        customerExternalId: customer.externalId,
        usageDate: {
          gte: new Date(startDate),
          lte: this.toEndOfDay(endDate),
        },
      },
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
      },
      orderBy: {
        usageDate: 'asc',
      },
    });

    const invoices = await this.prisma.invoices.findMany({
      where: {
        customerId,
        organizationId,
        invoiceDate: {
          gte: new Date(startDate),
          lte: this.toEndOfDay(endDate),
        },
      },
      orderBy: {
        invoiceDate: 'asc',
      },
    });

    const signalDistribution = this._getSignalDistribution(usageEvents);

    // Canon revenue + cost + margin for the customer in the window.
    // Canon R1 + R2 + C1.
    const canonWindow = {
      start: new Date(startDate),
      end: this.toEndOfDay(endDate),
    };
    const canonMetrics = await this.revenueMetrics.getRevenueMetrics(organizationId, canonWindow, {
      customerId,
    });

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        externalId: customer.externalId,
      },
      dateRange: {
        start: startDate,
        end: endDate,
      },
      subscriptions: subscriptions.map((sub) => ({
        id: sub.id,
        name: sub.name,
        status: sub.status,
        planName: sub.pricing_plans?.name || '',
        agentName: sub.agents?.name || '',
        startDate: sub.startDate,
        endDate: sub.endDate,
      })),
      usageData: {
        totalEvents: canonMetrics.eventCount,
        totalQuantity: usageEvents.reduce((sum, e) => sum + Number(e.quantity || 0), 0),
        totalCost: canonMetrics.cost,
        totalRevenue: canonMetrics.revenue,
        margin: canonMetrics.margin,
        marginPercent: canonMetrics.marginPercent,
        timeSeriesData: this._aggregateTimeSeriesData(usageEvents, groupBy as GroupByEnum),
      },
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        amount: invoice.totalAmount,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
      })),
      signalDistribution,
    };
  }

  async getAgentAnalytics(
    organizationId: string,
    params: {
      agentId: string;
      startDate: string;
      endDate: string;
      groupBy?: string;
    },
  ) {
    const { agentId, startDate, endDate, groupBy = 'daily' } = params;

    if (!agentId) {
      throw new BadRequestException('Agent ID is required');
    }

    const agent = await this.prisma.agents.findFirst({
      where: { id: agentId, orgId: organizationId },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    const usageEvents = await this.prisma.signal_events.findMany({
      where: {
        organizationId,
        agentId,
        usageDate: {
          gte: new Date(startDate),
          lte: this.toEndOfDay(endDate),
        },
      },
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
        customers: {
          select: {
            id: true,
            name: true,
            externalId: true,
          },
        },
      },
      orderBy: {
        usageDate: 'asc',
      },
    });

    const customerDistribution = this._getCustomerDistribution(usageEvents);

    const signalDistribution = this._getSignalDistribution(usageEvents);

    const subscriptionCount = await this.prisma.subscriptions.count({
      where: { agentId, organizationId },
    });

    const growthTrend = this._calculateGrowthTrendData(usageEvents, groupBy as GroupByEnum);

    // Canon revenue + cost for the agent in the window. Canon
    // R1 + R2 + C1. Cost is also canonical (byAgent filter on
    // getCostMetrics).
    const canonWindow = {
      start: new Date(startDate),
      end: this.toEndOfDay(endDate),
    };
    const [agentRevenue, agentCost] = await Promise.all([
      this.revenueMetrics.getRevenueMetrics(organizationId, canonWindow, {
        agentId,
      }),
      this.revenueMetrics.getCostMetrics(organizationId, canonWindow, {
        agentId,
      }),
    ]);

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        agentCode: agent.agentCode,
      },
      dateRange: {
        start: startDate,
        end: endDate,
      },
      usageData: {
        totalEvents: agentCost.eventCount,
        totalQuantity: usageEvents.reduce((sum, e) => sum + Number(e.quantity || 0), 0),
        totalCost: agentCost.cost,
        totalRevenue: agentRevenue.revenue,
        margin: agentRevenue.margin,
        marginPercent: agentRevenue.marginPercent,
        timeSeriesData: this._aggregateTimeSeriesData(usageEvents, groupBy as GroupByEnum),
      },
      customerDistribution,
      signalDistribution,
      subscriptionCount,
      growthTrend,
    };
  }

  /**
   * Get revenue analytics. MRR trio + invoice totals + revenue by
   * period/customer/agent.
   *
   * Totals route through the canonical library:
   *   - totalRevenue = `getInvoiceTotals().billed + .collected` (canon I2)
   *   - mrr/arr = `getMrr()` (canon MRR1)
   *   - runRateMrr + committedMrr = MRR2 + MRR3 trio
   *
   * Per-period / per-customer / per-agent breakdowns read the raw
   * invoices because the canon library does not expose a time-series
   * shape for invoice totals. Those lists sum `totalAmount` across non-draft
   * invoices only (canon I2. Draft is never billed).
   */
  async getRevenueAnalytics(
    organizationId: string,
    params: {
      startDate: string;
      endDate: string;
      groupBy?: string;
      agentId?: string;
    },
  ) {
    const { startDate, endDate, groupBy = 'monthly', agentId } = params;

    if (!startDate || !endDate) {
      throw new BadRequestException('Start date and end date are required');
    }

    const canonWindow = {
      start: new Date(startDate),
      end: this.toEndOfDay(endDate),
    };

    // Canon invoice filter. Non-draft only, per I2. Agent filter joins via
    // subscriptions.agentId the same way the raw read does.
    const whereClause: any = {
      organizationId,
      invoiceDate: {
        gte: canonWindow.start,
        lte: canonWindow.end,
      },
      status: { in: ['issued', 'paid', 'overdue'] },
    };
    if (agentId) {
      whereClause.subscriptions = { agentId };
    }

    // Canon totals live alongside the raw invoice read. Canon
    // getInvoiceTotals accepts an agentId filter (routes through
    // the invoice → subscription → agent relation). Whether or not the
    // caller passed agentId, totalRevenue comes from canon: billed (gross,
    // issued + overdue) + collected (paid, NET of refunds per canon I2).
    // The raw `invoices` read feeds the per-period / per-customer /
    // per-agent breakdowns, which need line-level invoice data canon does
    // not expose. Those breakdowns are gross by line-item nature.
    const canonInvoiceFilters = agentId ? { agentId } : undefined;
    const [invoices, canonTotals, canonMrr, canonRunRate, canonCommitted] = await Promise.all([
      this.prisma.invoices.findMany({
        where: whereClause,
        include: {
          customers: {
            select: { id: true, name: true, externalId: true },
          },
          subscriptions: {
            select: {
              id: true,
              agentId: true,
              agents: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { invoiceDate: 'asc' },
      }),
      this.revenueMetrics.getInvoiceTotals(organizationId, canonWindow, canonInvoiceFilters),
      this.revenueMetrics.getMrr(organizationId),
      this.revenueMetrics.getRunRateMrr(organizationId),
      this.revenueMetrics.getCommittedMrr(organizationId),
    ]);

    // Revenue by time period (invoiceDate bucket, non-draft totals only).
    const revenueByPeriod = this._aggregateRevenueByPeriod(invoices, groupBy);

    // Per-customer revenue (non-draft totals only).
    const revenueByCustomer = this._getRevenueByCustomerData(invoices);

    // Per-agent revenue (non-draft totals only). Skipped when filtering to
    // one agent because the rollup is uninformative.
    let revenueByAgent: any[] = [];
    if (!agentId) {
      revenueByAgent = this._getRevenueByAgentData(invoices);
    }

    // Canon-authoritative totalRevenue for both filtered and unfiltered
    // branches. Canon's billed (gross issued + overdue) + collected (paid
    // net of refunds) is the single source of truth.
    const totalRevenue = canonTotals.billed + canonTotals.collected;
    const totalInvoices = invoices.length;

    return {
      dateRange: {
        start: startDate,
        end: endDate,
      },
      // Canon MRR trio. Forward-looking MRR2/MRR3 alongside canon MRR1.
      mrr: {
        canonical: canonMrr.mrr,
        arr: canonMrr.arr,
        runRate: canonRunRate.mrr,
        committed: canonCommitted.mrr,
      },
      invoiceTotals: {
        billed: canonTotals.billed,
        collected: canonTotals.collected,
        outstanding: canonTotals.outstanding,
        overdueAmount: canonTotals.overdueAmount,
        overdueCount: canonTotals.overdueCount,
      },
      revenueByPeriod,
      revenueByCustomer,
      revenueByAgent,
      totalRevenue,
      totalInvoices,
    };
  }

  /**
   * Profit margins by signal: cost against usage (Agent-Earned) revenue, per
   * canon R1.
   */
  async getProfitabilityAnalytics(
    organizationId: string,
    params: {
      startDate: string;
      endDate: string;
      customerId?: string;
      agentId?: string;
    },
  ) {
    const { startDate, endDate, customerId, agentId } = params;

    if (!startDate || !endDate) {
      throw new BadRequestException('Start date and end date are required');
    }

    // calculatedRevenue is Agent-Earned (canon R1: usage-only, tier-correct);
    // cost/eventCount are canon C1 (org-window scoped, orphan events count).
    const window = {
      start: new Date(startDate),
      end: this.toEndOfDay(endDate),
    };
    const filters = { customerId, agentId };

    const [earned, costs] = await Promise.all([
      this.revenueMetrics.getAgentEarned(organizationId, window, filters),
      this.revenueMetrics.getCostMetrics(organizationId, window, filters),
    ]);

    // Agent-Earned revenue + quantity grouped per signal. Σ over these
    // buckets equals earned.revenue, so overall === Σ bySignal by
    // construction.
    const revenueBySignal = new Map<string | null, { revenue: number; quantity: number }>();
    for (const row of earned.byStrategy) {
      const bucket = revenueBySignal.get(row.signalId) ?? { revenue: 0, quantity: 0 };
      bucket.revenue += row.revenue;
      bucket.quantity += row.quantity;
      revenueBySignal.set(row.signalId, bucket);
    }

    const costBySignal = new Map<string | null, { cost: number; eventCount: number }>();
    for (const row of costs.bySignal) {
      costBySignal.set(row.signalId, { cost: row.cost, eventCount: row.eventCount });
    }

    // Union of both keys: a signal can have cost but no priced strategy
    // (revenue 0), or minimum-commitment revenue with zero events (cost 0).
    const signalIds = new Set<string | null>([...revenueBySignal.keys(), ...costBySignal.keys()]);
    const namedSignalIds = [...signalIds].filter((id): id is string => id !== null);
    const signalRows = namedSignalIds.length
      ? await this.prisma.signals.findMany({
          where: { id: { in: namedSignalIds } },
          select: { id: true, name: true, shortName: true },
        })
      : [];
    const signalNameById = new Map(signalRows.map((s) => [s.id, s]));

    const bySignal = [...signalIds].map((signalId) => {
      const revenue = revenueBySignal.get(signalId);
      const cost = costBySignal.get(signalId);
      const calculatedRevenue = revenue?.revenue ?? 0;
      const totalCost = cost?.cost ?? 0;
      const named = signalId ? signalNameById.get(signalId) : undefined;
      return {
        signalId,
        signalName: named?.name || '',
        signalShortName: named?.shortName || '',
        totalQuantity: revenue?.quantity ?? 0,
        totalCost,
        calculatedRevenue,
        profit: calculatedRevenue - totalCost,
        profitMargin: safeMarginPercent(calculatedRevenue, calculatedRevenue - totalCost),
        eventCount: cost?.eventCount ?? 0,
      };
    });

    const overallQuantity = earned.byStrategy.reduce((sum, row) => sum + row.quantity, 0);

    return {
      dateRange: {
        start: startDate,
        end: endDate,
      },
      overall: {
        totalQuantity: overallQuantity,
        totalCost: costs.cost,
        calculatedRevenue: earned.revenue,
        profit: earned.revenue - costs.cost,
        profitMargin: safeMarginPercent(earned.revenue, earned.revenue - costs.cost),
        eventCount: costs.eventCount,
      },
      bySignal: bySignal.sort((a, b) => b.profit - a.profit),
    };
  }

  async aggregateEvents(
    organizationId: string,
    params: {
      startDate: string;
      endDate: string;
      groupBy?: string;
      customerId?: string;
      customerExternalId?: string;
      agentId?: string;
      signalId?: string;
      dimension?: string;
    },
  ) {
    const {
      startDate,
      endDate,
      groupBy = 'daily',
      customerId,
      customerExternalId,
      agentId,
      signalId,
      dimension,
    } = params;

    if (!startDate || !endDate) {
      throw new BadRequestException('Start date and end date are required');
    }

    const whereClause: any = {
      organizationId,
      usageDate: {
        gte: new Date(startDate),
        lte: this.toEndOfDay(endDate),
      },
    };

    let customerExtId = customerExternalId;

    if (customerId) {
      const customer = await this.prisma.customers.findUnique({
        where: { id: customerId, organizationId },
      });
      if (!customer) {
        throw new NotFoundException('Customer not found');
      }
      customerExtId = customer.externalId;
    }

    if (customerExtId) {
      whereClause.customerExternalId = customerExtId;
    }

    if (agentId) {
      whereClause.agentId = agentId;
    }

    if (signalId) {
      whereClause.signalId = signalId;
    }

    const events = await this.prisma.signal_events.findMany({
      where: whereClause,
      include: {
        signals:
          dimension?.toLowerCase() === 'signal'
            ? {
                select: {
                  id: true,
                  name: true,
                  shortName: true,
                },
              }
            : undefined,
        agents:
          dimension?.toLowerCase() === 'agent'
            ? {
                select: {
                  id: true,
                  name: true,
                  agentCode: true,
                },
              }
            : undefined,
        customers:
          dimension?.toLowerCase() === 'customer'
            ? {
                select: {
                  id: true,
                  name: true,
                  externalId: true,
                },
              }
            : undefined,
      },
      orderBy: {
        usageDate: 'asc',
      },
    });

    return this._formatAggregatedEventsResults(events, dimension, groupBy);
  }

  private _getSignalDistribution(events: any[]) {
    const distribution = new Map<string, any>();

    events.forEach((event) => {
      const signalId = event.signalId;

      if (!distribution.has(signalId)) {
        distribution.set(signalId, {
          signalId,
          signalName: event.signals?.name || 'Unknown',
          shortName: event.signals?.shortName || '',
          eventCount: 0,
          totalQuantity: 0,
          totalUsageCost: 0,
        });
      }

      const dist = distribution.get(signalId)!;
      dist.eventCount += 1;
      dist.totalQuantity += Number(event.quantity || 0);
      dist.totalUsageCost += Number(event.usageCost || 0);
    });

    return Array.from(distribution.values())
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, 10); // Top 10
  }

  private _getCustomerDistribution(events: any[]) {
    const distribution = new Map<string, any>();

    events.forEach((event) => {
      const customerExternalId = event.customerExternalId;

      if (!distribution.has(customerExternalId)) {
        distribution.set(customerExternalId, {
          customerExternalId,
          customerName: event.customers?.name || 'Unknown',
          customerId: event.customers?.id || '',
          eventCount: 0,
          totalQuantity: 0,
          totalUsageCost: 0,
        });
      }

      const dist = distribution.get(customerExternalId)!;
      dist.eventCount += 1;
      dist.totalQuantity += Number(event.quantity || 0);
      dist.totalUsageCost += Number(event.usageCost || 0);
    });

    return Array.from(distribution.values())
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, 10); // Top 10
  }

  private _calculateGrowthTrendData(events: any[], groupBy: GroupByEnum) {
    const timeSeriesData = this._aggregateTimeSeriesData(events, groupBy);

    const growthData = {
      overall: {
        firstPeriodEvents: 0,
        lastPeriodEvents: 0,
        growthRate: 0,
      },
      periods: timeSeriesData,
    };

    if (timeSeriesData.length >= 2) {
      const firstPeriod = timeSeriesData[0];
      const lastPeriod = timeSeriesData[timeSeriesData.length - 1];

      growthData.overall.firstPeriodEvents = firstPeriod.eventCount;
      growthData.overall.lastPeriodEvents = lastPeriod.eventCount;

      growthData.overall.growthRate =
        growthPercent(lastPeriod.eventCount, firstPeriod.eventCount) ??
        growthData.overall.growthRate;
    }

    return growthData;
  }

  private _aggregateRevenueByPeriod(invoices: any[], groupBy: string) {
    const periodMap = new Map<string, any>();

    invoices.forEach((invoice) => {
      const dateKey = this._getDateKey(invoice.invoiceDate, groupBy as GroupByEnum);

      if (!periodMap.has(dateKey)) {
        periodMap.set(dateKey, {
          period: dateKey,
          revenue: 0,
          invoiceCount: 0,
        });
      }

      const period = periodMap.get(dateKey)!;
      period.revenue += Number(invoice.totalAmount || 0);
      period.invoiceCount += 1;
    });

    return Array.from(periodMap.values()).sort((a, b) => a.period.localeCompare(b.period));
  }

  private _getRevenueByCustomerData(invoices: any[]) {
    const customerMap = new Map<string, any>();

    invoices.forEach((invoice) => {
      const customerId = invoice.customerId;

      if (!customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customerId,
          customerName: invoice.customers?.name || 'Unknown',
          revenue: 0,
          invoiceCount: 0,
        });
      }

      const customer = customerMap.get(customerId)!;
      customer.revenue += Number(invoice.totalAmount || 0);
      customer.invoiceCount += 1;
    });

    return Array.from(customerMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10); // Top 10
  }

  private _getRevenueByAgentData(invoices: any[]) {
    const agentMap = new Map<string, any>();

    invoices.forEach((invoice) => {
      const agentId = invoice.subscriptions?.agentId;

      if (!agentId) return;

      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, {
          agentId,
          agentName: invoice.subscriptions?.agents?.name || 'Unknown',
          revenue: 0,
          invoiceCount: 0,
        });
      }

      const agent = agentMap.get(agentId)!;
      agent.revenue += Number(invoice.totalAmount || 0);
      agent.invoiceCount += 1;
    });

    return Array.from(agentMap.values()).sort((a, b) => b.revenue - a.revenue);
  }

  private _formatAggregatedEventsResults(
    events: any[],
    dimension: string | undefined,
    groupBy: string,
  ) {
    const response: any = {
      timeSeriesData: [],
      totalEvents: 0,
      totalQuantity: 0,
      totalUsageCost: 0,
    };

    if (dimension) {
      response.dimensionBreakdown = {};

      events.forEach((event) => {
        let dimensionValue: string;

        switch (dimension.toLowerCase()) {
          case 'customer':
            dimensionValue = event.customerExternalId;
            break;
          case 'agent':
            dimensionValue = event.agentId;
            break;
          case 'signal':
            dimensionValue = event.signalId;
            break;
          default:
            dimensionValue = 'unknown';
        }

        if (!response.dimensionBreakdown[dimensionValue]) {
          response.dimensionBreakdown[dimensionValue] = {
            timeSeriesData: [],
            totalEvents: 0,
            totalQuantity: 0,
            totalUsageCost: 0,
          };

          if (dimension === 'agent' && event.agents) {
            response.dimensionBreakdown[dimensionValue].metadata = {
              name: event.agents.name,
              agentCode: event.agents.agentCode,
            };
          } else if (dimension === 'signal' && event.signals) {
            response.dimensionBreakdown[dimensionValue].metadata = {
              name: event.signals.name,
              shortName: event.signals.shortName,
            };
          } else if (dimension === 'customer' && event.customers) {
            response.dimensionBreakdown[dimensionValue].metadata = {
              name: event.customers.name,
              externalId: event.customers.externalId,
            };
          }
        }

        const dimData = response.dimensionBreakdown[dimensionValue];
        dimData.totalEvents += 1;
        dimData.totalQuantity += Number(event.quantity || 0);
        dimData.totalUsageCost += Number(event.usageCost || 0);
      });

      Object.keys(response.dimensionBreakdown).forEach((dimValue) => {
        const dimEvents = events.filter((e) => {
          switch (dimension.toLowerCase()) {
            case 'customer':
              return e.customerExternalId === dimValue;
            case 'agent':
              return e.agentId === dimValue;
            case 'signal':
              return e.signalId === dimValue;
            default:
              return false;
          }
        });
        response.dimensionBreakdown[dimValue].timeSeriesData = this._aggregateTimeSeriesData(
          dimEvents,
          groupBy as GroupByEnum,
        );
      });
    }

    response.timeSeriesData = this._aggregateTimeSeriesData(events, groupBy as GroupByEnum);

    response.totalEvents = events.length;
    response.totalQuantity = events.reduce((sum, e) => sum + Number(e.quantity || 0), 0);
    response.totalUsageCost = events.reduce((sum, e) => sum + Number(e.usageCost || 0), 0);

    return response;
  }
}
