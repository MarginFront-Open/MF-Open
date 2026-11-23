'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { Prisma } from '@prisma/client'
import { db as prisma } from '@/app/lib/db'
import {
  getInvoiceTotals as canonGetInvoiceTotals,
  getMrr as canonGetMrr,
  getRevenueMetrics as canonGetRevenueMetrics,
  getCostMetrics as canonGetCostMetrics,
  safeMarginPercent,
  shareOfTotal,
  growthPercent,
  avgPer,
} from '@marginfront/db'
import { parseWindowFilter } from './_shared/parse-window-filter'

// ============================================================================
// Types
// ============================================================================

export interface UsageAnalyticsParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  agentId?: string
  signalId?: string
}

export interface UsageAnalyticsResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalEvents: number
    avgEventsPerDay: number
  }
  timeSeriesData: Array<{
    date: string
    totalEvents: number
    signalBreakdown?: Record<string, number>
  }>
}

export interface CostAnalyticsParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  agentId?: string
  signalId?: string
}

export interface CostAnalyticsResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
    totalDays: number
    uniquePeriods?: number
  }
  filters?: {
    customerId: string | null
    agentId: string | null
    signalId: string | null
    breakdownBy: string | null
    organizationId: string
  }
  stats: {
    totalCost: number
    totalEvents: number
    avgCostPerEvent: number
  }
  costSummary?: {
    overall: {
      totalCost: number
      totalEvents: number
      avgDailyCost: number
      avgPeriodCost: number
      avgCostPerEvent: number
      periodOverPeriodGrowth: number
      eventGrowthRate: number
      volatility: 'low' | 'medium' | 'high'
      standardDeviation: number
      trend: {
        direction: 'increasing' | 'decreasing' | 'stable'
        slope: number
      }
    }
    services: {
      highest: { name: string; cost: number; units: number }
      mostExpensivePerUnit: { name: string; costPerUnit: number }
      topByAvgCost: Array<{
        serviceName: string
        avgCost: number
        totalCost: number
        eventCount: number
        volatility: 'low' | 'medium' | 'high'
        costPerUnit: number
      }>
    }
    providers: {
      highest: { name: string; cost: number; units: number }
    }
    unitTypes: {
      highest: { name: string; cost: number; units: number }
    }
    runRate: {
      monthly: number
      quarterly: number
      annual: number
      dailyAverage: number
      daysInPeriod: number
    }
  }
  timeSeriesData: Array<{
    date: string
    totalCost: number
    eventCount: number
    avgCostPerEvent: number
  }>
  serviceBreakdown:
    | Array<{
        serviceName: string
        totalCost: number
        percentage: number
      }>
    | {
        summary: Array<{
          serviceName: string
          totalCost: number
          totalUnits: number
          percentage: number
          avgCostPerEvent: number
          volatility: 'low' | 'medium' | 'high'
          topProviders: Array<{ name: string; cost: number; units: number }>
        }>
        timeline: Array<{
          date: string
          services: Record<string, { cost: number; units: number }>
        }>
      }
  dimensions?: unknown
  metadata?: unknown
}

export interface AgentAnalyticsParams {
  agentId: string
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
}

export interface AgentAnalyticsResponse {
  agent: {
    id: string
    name: string
    agentCode: string
  }
  stats: {
    totalRevenue: number
    totalCustomers: number
    totalSubscriptions: number
    totalSignals: number
    totalPlans: number
  }
  performanceMetrics: Array<{
    date: string
    revenue: number
    eventCount: number
  }>
  topCustomers: Array<{
    customerId: string
    customerName: string
    revenue: number
  }>
}

export interface RevenueAnalyticsParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  agentId?: string
}

export interface RevenueAnalyticsResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalRevenue: number
    mrr: number
    arr: number
    avgRevenuePerCustomer: number
  }
  timeSeriesData: Array<{
    date: string
    revenue: number
  }>
  breakdown: {
    byAgent: Array<{
      agentId: string
      agentName: string
      revenue: number
      percentage: number
    }>
    byPlan: Array<{
      planId: string
      planName: string
      revenue: number
      percentage: number
    }>
  }
}

export interface ProfitabilityAnalyticsParams {
  startDate: string
  endDate: string
  customerId?: string
  agentId?: string
}

export interface ProfitabilityAnalyticsResponse {
  dateRange: {
    start: string
    end: string
  }
  stats: {
    totalRevenue: number
    totalCost: number
    totalProfit: number
    /** Canon M1: null when revenue is 0 — rendered as "—", never "0%". */
    profitMargin: number | null
  }
  breakdown: {
    bySignal: Array<{
      signalId: string
      signalName: string
      revenue: number
      cost: number
      profit: number
      margin: number | null
    }>
    byAgent: Array<{
      agentId: string
      agentName: string
      revenue: number
      cost: number
      profit: number
      margin: number | null
    }>
  }
}

export interface EventAggregationParams {
  startDate: string
  endDate: string
  groupBy?: 'daily' | 'weekly' | 'monthly'
  customerId?: string
  agentId?: string
  signalId?: string
}

export interface EventAggregationResponse {
  dateRange: {
    start: string
    end: string
    groupBy: string
  }
  stats: {
    totalEvents: number
    totalQuantity: number
    uniqueCustomers: number
    uniqueSignals: number
  }
  aggregatedData: Array<{
    date: string
    totalEvents: number
    totalQuantity: number
    bySignal?: Record<string, { count: number; quantity: number }>
  }>
}

export interface SubscriptionAnalyticsParams {
  billingPeriodStart?: string
  billingPeriodEnd?: string
}

export interface SubscriptionAnalyticsResponse {
  subscription: {
    id: string
    name: string
    status: string
    billingCycle: string
    startDate: string
    endDate: string | null
    currentBillingPeriodStart: string | null
    currentBillingPeriodEnd: string | null
    billingDay: number
  }
  customer: {
    id: string
    name: string
    email: string | null
  }
  agent: {
    id: string
    name: string
    agentCode: string
  }
  plan: {
    id: string
    name: string
  } | null
  summary: {
    totalRevenue: number
    totalCost: number
    totalMargin: number
    totalEvents: number
  }
  signalSummary: Array<{
    signalId: string
    signalName: string
    totalQuantity: number
    totalCost: number
    totalRevenue: number
  }>
  dailyBreakdown: Array<{
    date: string
    signalName: string
    quantity: number
    cost: number
    revenue: number
  }>
}

// ============================================================================
// Helper Functions
// ============================================================================

function getDateKey(date: Date, groupBy: string): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  switch (groupBy) {
    case 'weekly':
      // Get the Monday of the week
      const dayOfWeek = date.getDay()
      const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)
      const monday = new Date(date)
      monday.setDate(diff)
      return monday.toISOString().split('T')[0]
    case 'monthly':
      return `${year}-${month}-01`
    default:
      return `${year}-${month}-${day}`
  }
}

function getDaysBetween(startDate: Date, endDate: Date): number {
  const diffTime = Math.abs(endDate.getTime() - startDate.getTime())
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
}

// ============================================================================
// Server Actions
// ============================================================================

export async function getUsageAnalytics(params: UsageAnalyticsParams): Promise<{
  success: boolean
  data?: UsageAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const {
      startDate,
      endDate,
      groupBy = 'daily',
      customerId,
      agentId,
      signalId,
    } = params

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const where: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
      usageDate: {
        gte: start,
        lte: end,
      },
    }

    if (customerId) where.customerId = customerId
    if (agentId) where.agentId = agentId
    if (signalId) where.signalId = signalId

    const events = await prisma.signal_events.findMany({
      where,
      select: {
        usageDate: true,
        quantity: true,
        signalId: true,
        signals: {
          select: { name: true },
        },
      },
      orderBy: { usageDate: 'asc' },
    })

    const dateMap = new Map<
      string,
      { count: number; signalBreakdown: Map<string, number> }
    >()

    events.forEach((event) => {
      const dateKey = getDateKey(event.usageDate, groupBy)

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { count: 0, signalBreakdown: new Map() })
      }

      const dateData = dateMap.get(dateKey)!
      dateData.count++

      if (event.signalId && event.signals) {
        const signalName = event.signals.name
        dateData.signalBreakdown.set(
          signalName,
          (dateData.signalBreakdown.get(signalName) || 0) + 1
        )
      }
    })

    const totalEvents = events.length
    const days = getDaysBetween(start, end) || 1

    const timeSeriesData = Array.from(dateMap.entries()).map(
      ([date, data]) => ({
        date,
        totalEvents: data.count,
        signalBreakdown: Object.fromEntries(data.signalBreakdown),
      })
    )

    return {
      success: true,
      data: {
        dateRange: {
          start: startDate,
          end: endDate,
          groupBy,
        },
        stats: {
          totalEvents,
          avgEventsPerDay: Math.round(totalEvents / days),
        },
        timeSeriesData,
      },
    }
  } catch (error) {
    console.error('[getUsageAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch usage analytics' }
  }
}

export async function getCostAnalytics(params: CostAnalyticsParams): Promise<{
  success: boolean
  data?: CostAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const {
      startDate,
      endDate,
      groupBy = 'daily',
      customerId,
      agentId,
      signalId,
    } = params

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const where: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
      usageDate: {
        gte: start,
        lte: end,
      },
    }

    if (customerId) where.customerId = customerId
    if (agentId) where.agentId = agentId
    if (signalId) where.signalId = signalId

    // Get events with cost data - join with signals to get unit cost
    const events = await prisma.signal_events.findMany({
      where,
      select: {
        usageDate: true,
        usageCost: true,
        usageCostData: true,
        quantity: true,
        agentId: true,
        signalId: true,
        agents: {
          select: { id: true, name: true },
        },
        signals: {
          select: { id: true, name: true },
        },
      },
      orderBy: { usageDate: 'asc' },
    })

    // Fetch metadata for filters (customers, agents, signals/metrics, and relationships)
    const [allCustomers, allAgents, allSignals, allSubscriptions] =
      await Promise.all([
        prisma.customers.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        prisma.agents.findMany({
          where: { orgId, deletedAt: null },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        prisma.signals.findMany({
          where: { orgId, deletedAt: null },
          select: { id: true, name: true, agentId: true },
          orderBy: { name: 'asc' },
        }),
        prisma.subscriptions.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { customerId: true, agentId: true },
          distinct: ['customerId', 'agentId'],
        }),
      ])

    const dateMap = new Map<string, { cost: number; count: number }>()
    const serviceMap = new Map<string, number>()
    const agentMap = new Map<
      string,
      { name: string; cost: number; count: number; quantity: number }
    >()
    const agentTimelineMap = new Map<
      string,
      Map<string, { id: string; name: string; cost: number }>
    >()
    let totalCost = 0
    let totalEvents = 0

    events.forEach((event) => {
      const dateKey = getDateKey(event.usageDate, groupBy)
      const quantity = Number(event.quantity) || 0

      // Calculate cost from usageCost on the event
      const cost = Number(event.usageCost) || 0

      totalCost += cost
      totalEvents++

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { cost: 0, count: 0 })
      }

      const dateData = dateMap.get(dateKey)!
      dateData.cost += cost
      dateData.count++

      if (event.agentId && event.agents) {
        const existing = agentMap.get(event.agentId) || {
          name: event.agents.name,
          cost: 0,
          count: 0,
          quantity: 0,
        }
        existing.cost += cost
        existing.count++
        existing.quantity += quantity
        agentMap.set(event.agentId, existing)

        if (!agentTimelineMap.has(dateKey)) {
          agentTimelineMap.set(dateKey, new Map())
        }
        const dateAgents = agentTimelineMap.get(dateKey)!
        const existingAgent = dateAgents.get(event.agentId) || {
          id: event.agentId,
          name: event.agents.name,
          cost: 0,
        }
        existingAgent.cost += cost
        dateAgents.set(event.agentId, existingAgent)
      }

      if (event.signalId && event.signals) {
        const signalName = event.signals.name
        serviceMap.set(signalName, (serviceMap.get(signalName) || 0) + cost)
      }
    })

    const days = getDaysBetween(start, end) || 1

    const timeSeriesData = Array.from(dateMap.entries())
      .map(([date, data]) => ({
        date,
        totalCost: data.cost,
        eventCount: data.count,
        avgCostPerEvent: avgPer(data.cost, data.count) ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const serviceBreakdown = Array.from(serviceMap.entries())
      .map(([serviceName, cost]) => ({
        serviceName,
        totalCost: cost,
        percentage: shareOfTotal(cost, totalCost) ?? 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost)

    const avgDailyCost = avgPer(totalCost, days) ?? 0
    const avgCostPerEvent = avgPer(totalCost, totalEvents) ?? 0

    const costs = timeSeriesData.map((d) => d.totalCost)
    const mean =
      costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0
    const variance =
      costs.length > 0
        ? costs.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
          costs.length
        : 0
    const standardDeviation = Math.sqrt(variance)

    const coefficientOfVariation =
      // eslint-disable-next-line no-restricted-syntax -- coefficient of variation, not money share
      mean > 0 ? (standardDeviation / mean) * 100 : 0
    const volatility: 'low' | 'medium' | 'high' =
      coefficientOfVariation < 20
        ? 'low'
        : coefficientOfVariation < 50
          ? 'medium'
          : 'high'

    // Calculate trend (simple linear regression)
    let slope = 0
    let trendDirection: 'increasing' | 'decreasing' | 'stable' = 'stable'
    if (costs.length >= 2) {
      const n = costs.length
      const sumX = (n * (n - 1)) / 2
      const sumY = costs.reduce((a, b) => a + b, 0)
      const sumXY = costs.reduce((sum, y, i) => sum + i * y, 0)
      const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6
      slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0

      if (slope > 0.01 * mean) trendDirection = 'increasing'
      else if (slope < -0.01 * mean) trendDirection = 'decreasing'
    }

    // Calculate period over period growth (compare first half to second half)
    const midpoint = Math.floor(costs.length / 2)
    const firstHalf = costs.slice(0, midpoint)
    const secondHalf = costs.slice(midpoint)
    const firstHalfAvg =
      firstHalf.length > 0
        ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
        : 0
    const secondHalfAvg =
      secondHalf.length > 0
        ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
        : 0
    const periodOverPeriodGrowth =
      growthPercent(secondHalfAvg, firstHalfAvg) ?? 0

    // Calculate run rates (simple industry-standard calculation)
    // Run Rate = (Total Cost / Days in Period) × Target Days
    const monthlyRunRate = avgDailyCost * 30
    const quarterlyRunRate = avgDailyCost * 90
    const annualRunRate = avgDailyCost * 365

    const highestService = serviceBreakdown[0] || {
      serviceName: 'N/A',
      totalCost: 0,
      percentage: 0,
    }

    const serviceBreakdownSummary = serviceBreakdown.map((s) => ({
      serviceName: s.serviceName,
      totalCost: s.totalCost,
      totalUnits: Math.round(s.totalCost / (avgCostPerEvent || 1)),
      percentage: s.percentage,
      avgCostPerEvent: avgCostPerEvent,
      volatility: volatility,
      topProviders: [
        {
          name: s.serviceName.split(' ')[0],
          cost: s.totalCost,
          units: totalEvents,
        },
      ],
    }))

    return {
      success: true,
      data: {
        dateRange: {
          start: startDate,
          end: endDate,
          groupBy,
          totalDays: days,
          uniquePeriods: timeSeriesData.length,
        },
        filters: {
          customerId: customerId || null,
          agentId: agentId || null,
          signalId: signalId || null,
          breakdownBy: null,
          organizationId: orgId,
        },
        stats: {
          totalCost,
          totalEvents,
          avgCostPerEvent,
        },
        costSummary: {
          overall: {
            totalCost,
            totalEvents,
            avgDailyCost,
            avgPeriodCost:
              timeSeriesData.length > 0 ? totalCost / timeSeriesData.length : 0,
            avgCostPerEvent,
            periodOverPeriodGrowth,
            eventGrowthRate: periodOverPeriodGrowth,
            volatility,
            standardDeviation,
            trend: {
              direction: trendDirection,
              slope,
            },
          },
          services: {
            highest: {
              name: highestService.serviceName,
              cost: highestService.totalCost,
              units: totalEvents,
            },
            mostExpensivePerUnit: {
              name: highestService.serviceName,
              costPerUnit: avgCostPerEvent,
            },
            topByAvgCost: serviceBreakdown.slice(0, 5).map((s) => ({
              serviceName: s.serviceName,
              avgCost: s.totalCost / (totalEvents || 1),
              totalCost: s.totalCost,
              eventCount: Math.round(s.totalCost / (avgCostPerEvent || 1)),
              volatility: volatility,
              costPerUnit: avgCostPerEvent,
            })),
          },
          providers: {
            highest: {
              name: highestService.serviceName.split(' ')[0],
              cost: highestService.totalCost,
              units: totalEvents,
            },
          },
          unitTypes: {
            highest: {
              name: 'events',
              cost: totalCost,
              units: totalEvents,
            },
          },
          runRate: {
            monthly: monthlyRunRate,
            quarterly: quarterlyRunRate,
            annual: annualRunRate,
            dailyAverage: avgDailyCost,
            daysInPeriod: days,
          },
        },
        timeSeriesData,
        serviceBreakdown: {
          summary: serviceBreakdownSummary,
          timeline: timeSeriesData.map((t) => ({
            date: t.date,
            services: serviceBreakdown.reduce(
              (acc, s) => {
                acc[s.serviceName] = {
                  cost: (t.totalCost * s.percentage) / 100,
                  units: Math.round((t.eventCount * s.percentage) / 100),
                }
                return acc
              },
              {} as Record<string, { cost: number; units: number }>
            ),
          })),
        },
        dimensions: {
          agent: {
            dimensionType: 'agent' as const,
            summary: Array.from(agentMap.entries())
              .map(([id, data]) => ({
                id,
                name: data.name,
                totalCost: data.cost,
                eventCount: data.count,
                totalQuantity: data.quantity,
                percentage: shareOfTotal(data.cost, totalCost) ?? 0,
                avgCostPerEvent: data.count > 0 ? data.cost / data.count : 0,
                avgCostPerUnit:
                  data.quantity > 0 ? data.cost / data.quantity : 0,
                topServices: [],
              }))
              .sort((a, b) => b.totalCost - a.totalCost),
            timeline: Array.from(agentTimelineMap.entries())
              .map(([date, agents]) => ({
                date,
                items: Array.from(agents.values()),
              }))
              .sort((a, b) => a.date.localeCompare(b.date)),
          },
        },
        metadata: {
          customers: allCustomers,
          agents: allAgents,
          signals: allSignals,
          subscriptions: allSubscriptions,
        },
      },
    }
  } catch (error) {
    console.error('[getCostAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch cost analytics' }
  }
}

export async function getAgentAnalytics(params: AgentAnalyticsParams): Promise<{
  success: boolean
  data?: AgentAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const { agentId, groupBy = 'daily' } = params

    const agent = await prisma.agents.findFirst({
      where: {
        id: agentId,
        orgId,
        deletedAt: null,
      },
    })

    if (!agent) {
      return { success: false, error: 'Agent not found' }
    }

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const [subscriptionCount, signalCount, planCount] = await Promise.all([
      prisma.subscriptions.count({
        where: { agentId, organizationId: orgId, deletedAt: null },
      }),
      prisma.signals.count({
        where: { agentId, orgId, deletedAt: null },
      }),
      prisma.pricing_plans.count({
        where: { agentId, orgId, deletedAt: null },
      }),
    ])

    const uniqueCustomers = await prisma.subscriptions.groupBy({
      by: ['customerId'],
      where: {
        agentId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    const invoices = await prisma.invoices.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        invoiceDate: {
          gte: start,
          lte: end,
        },
        subscriptions: {
          agentId,
        },
      },
      select: {
        totalAmount: true,
        invoiceDate: true,
        customerId: true,
        customers: {
          select: { name: true },
        },
      },
    })

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + Number(inv.totalAmount),
      0
    )

    const events = await prisma.signal_events.findMany({
      where: {
        agentId,
        organizationId: orgId,
        usageDate: {
          gte: start,
          lte: end,
        },
      },
      select: {
        usageDate: true,
      },
    })

    const dateMetrics = new Map<string, { revenue: number; events: number }>()

    invoices.forEach((inv) => {
      const dateKey = getDateKey(inv.invoiceDate, groupBy)
      if (!dateMetrics.has(dateKey)) {
        dateMetrics.set(dateKey, { revenue: 0, events: 0 })
      }
      dateMetrics.get(dateKey)!.revenue += Number(inv.totalAmount)
    })

    events.forEach((event) => {
      const dateKey = getDateKey(event.usageDate, groupBy)
      if (!dateMetrics.has(dateKey)) {
        dateMetrics.set(dateKey, { revenue: 0, events: 0 })
      }
      dateMetrics.get(dateKey)!.events++
    })

    const customerRevenue = new Map<string, { name: string; revenue: number }>()
    invoices.forEach((inv) => {
      const existing = customerRevenue.get(inv.customerId) || {
        name: inv.customers?.name || 'Unknown',
        revenue: 0,
      }
      existing.revenue += Number(inv.totalAmount)
      customerRevenue.set(inv.customerId, existing)
    })

    const topCustomers = Array.from(customerRevenue.entries())
      .map(([customerId, data]) => ({
        customerId,
        customerName: data.name,
        revenue: data.revenue,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)

    return {
      success: true,
      data: {
        agent: {
          id: agent.id,
          name: agent.name,
          agentCode: agent.agentCode,
        },
        stats: {
          totalRevenue,
          totalCustomers: uniqueCustomers.length,
          totalSubscriptions: subscriptionCount,
          totalSignals: signalCount,
          totalPlans: planCount,
        },
        performanceMetrics: Array.from(dateMetrics.entries())
          .map(([date, data]) => ({
            date,
            revenue: data.revenue,
            eventCount: data.events,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        topCustomers,
      },
    }
  } catch (error) {
    console.error('[getAgentAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch agent analytics' }
  }
}

export async function getRevenueAnalytics(
  params: RevenueAnalyticsParams
): Promise<{
  success: boolean
  data?: RevenueAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const { startDate, endDate, groupBy = 'daily', agentId } = params

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const invoiceWhere: Prisma.invoicesWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      status: { in: ['paid', 'issued', 'overdue'] },
      invoiceDate: {
        gte: start,
        lte: end,
      },
    }

    if (agentId) {
      invoiceWhere.subscriptions = { agentId }
    }

    const invoices = await prisma.invoices.findMany({
      where: invoiceWhere,
      select: {
        totalAmount: true,
        invoiceDate: true,
        customerId: true,
        subscriptionId: true,
        subscriptions: {
          select: {
            agentId: true,
            agents: {
              select: { id: true, name: true },
            },
            pricing_plans: {
              select: { id: true, name: true },
            },
          },
        },
      },
    })

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + Number(inv.totalAmount),
      0
    )
    const uniqueCustomers = new Set(invoices.map((inv) => inv.customerId))

    // MRR per canon MRR1: contracted monthly recurring revenue of active
    // subs (recurring + seat, monthly-normalized). Always canonical
    // regardless of the analytics view's date-range filter — MRR is a
    // single fixed metric, not date-range-bound.
    const { mrr, arr } = await canonGetMrr(prisma, orgId)

    const dateMap = new Map<string, number>()
    invoices.forEach((inv) => {
      const dateKey = getDateKey(inv.invoiceDate, groupBy)
      dateMap.set(
        dateKey,
        (dateMap.get(dateKey) || 0) + Number(inv.totalAmount)
      )
    })

    const agentMap = new Map<string, { name: string; revenue: number }>()
    invoices.forEach((inv) => {
      if (inv.subscriptions?.agents) {
        const agent = inv.subscriptions.agents
        const existing = agentMap.get(agent.id) || {
          name: agent.name,
          revenue: 0,
        }
        existing.revenue += Number(inv.totalAmount)
        agentMap.set(agent.id, existing)
      }
    })

    const planMap = new Map<string, { name: string; revenue: number }>()
    invoices.forEach((inv) => {
      if (inv.subscriptions?.pricing_plans) {
        const plan = inv.subscriptions.pricing_plans
        const existing = planMap.get(plan.id) || { name: plan.name, revenue: 0 }
        existing.revenue += Number(inv.totalAmount)
        planMap.set(plan.id, existing)
      }
    })

    return {
      success: true,
      data: {
        dateRange: {
          start: startDate,
          end: endDate,
          groupBy,
        },
        stats: {
          totalRevenue,
          mrr,
          arr,
          avgRevenuePerCustomer:
            uniqueCustomers.size > 0 ? totalRevenue / uniqueCustomers.size : 0,
        },
        timeSeriesData: Array.from(dateMap.entries())
          .map(([date, revenue]) => ({ date, revenue }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        breakdown: {
          byAgent: Array.from(agentMap.entries())
            .map(([agentId, data]) => ({
              agentId,
              agentName: data.name,
              revenue: data.revenue,
              percentage: shareOfTotal(data.revenue, totalRevenue) ?? 0,
            }))
            .sort((a, b) => b.revenue - a.revenue),
          byPlan: Array.from(planMap.entries())
            .map(([planId, data]) => ({
              planId,
              planName: data.name,
              revenue: data.revenue,
              percentage: shareOfTotal(data.revenue, totalRevenue) ?? 0,
            }))
            .sort((a, b) => b.revenue - a.revenue),
        },
      },
    }
  } catch (error) {
    console.error('[getRevenueAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch revenue analytics' }
  }
}

export async function getProfitabilityAnalytics(
  params: ProfitabilityAnalyticsParams
): Promise<{
  success: boolean
  data?: ProfitabilityAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const { startDate, endDate, customerId, agentId } = params

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const invoiceWhere: Prisma.invoicesWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      status: { in: ['paid', 'issued', 'overdue'] },
      invoiceDate: {
        gte: start,
        lte: end,
      },
    }

    const eventWhere: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
      usageDate: {
        gte: start,
        lte: end,
      },
    }

    if (customerId) {
      invoiceWhere.customerId = customerId
      eventWhere.customerId = customerId
    }

    if (agentId) {
      invoiceWhere.subscriptions = { agentId }
      eventWhere.agentId = agentId
    }

    const invoices = await prisma.invoices.findMany({
      where: invoiceWhere,
      select: {
        totalAmount: true,
        subscriptions: {
          select: {
            agentId: true,
            agents: {
              select: { id: true, name: true },
            },
          },
        },
      },
    })

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + Number(inv.totalAmount),
      0
    )

    const events = await prisma.signal_events.findMany({
      where: eventWhere,
      select: {
        signalId: true,
        agentId: true,
        usageCost: true,
        signals: {
          select: { id: true, name: true },
        },
        agents: {
          select: { id: true, name: true },
        },
      },
    })

    const totalCost = events.reduce(
      (sum, e) => sum + (Number(e.usageCost) || 0),
      0
    )
    const totalProfit = totalRevenue - totalCost
    const profitMargin = safeMarginPercent(totalRevenue, totalProfit)

    const signalMap = new Map<
      string,
      { name: string; revenue: number; cost: number }
    >()
    events.forEach((e) => {
      if (e.signalId && e.signals) {
        const existing = signalMap.get(e.signalId) || {
          name: e.signals.name,
          revenue: 0,
          cost: 0,
        }
        existing.cost += Number(e.usageCost) || 0
        signalMap.set(e.signalId, existing)
      }
    })

    const agentMap = new Map<
      string,
      { name: string; revenue: number; cost: number }
    >()
    events.forEach((e) => {
      if (e.agents) {
        const existing = agentMap.get(e.agentId) || {
          name: e.agents.name,
          revenue: 0,
          cost: 0,
        }
        existing.cost += Number(e.usageCost) || 0
        agentMap.set(e.agentId, existing)
      }
    })

    invoices.forEach((inv) => {
      if (inv.subscriptions?.agents) {
        const agentId = inv.subscriptions.agentId
        const existing = agentMap.get(agentId) || {
          name: inv.subscriptions.agents.name,
          revenue: 0,
          cost: 0,
        }
        existing.revenue += Number(inv.totalAmount)
        agentMap.set(agentId, existing)
      }
    })

    return {
      success: true,
      data: {
        dateRange: {
          start: startDate,
          end: endDate,
        },
        stats: {
          totalRevenue,
          totalCost,
          totalProfit,
          profitMargin,
        },
        breakdown: {
          bySignal: Array.from(signalMap.entries())
            .map(([signalId, data]) => ({
              signalId,
              signalName: data.name,
              revenue: data.revenue,
              cost: data.cost,
              profit: data.revenue - data.cost,
              margin: safeMarginPercent(data.revenue, data.revenue - data.cost),
            }))
            .sort((a, b) => b.profit - a.profit),
          byAgent: Array.from(agentMap.entries())
            .map(([agentId, data]) => ({
              agentId,
              agentName: data.name,
              revenue: data.revenue,
              cost: data.cost,
              profit: data.revenue - data.cost,
              margin: safeMarginPercent(data.revenue, data.revenue - data.cost),
            }))
            .sort((a, b) => b.profit - a.profit),
        },
      },
    }
  } catch (error) {
    console.error('[getProfitabilityAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch profitability analytics' }
  }
}

export async function getEventAggregation(
  params: EventAggregationParams
): Promise<{
  success: boolean
  data?: EventAggregationResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId
    const {
      startDate,
      endDate,
      groupBy = 'daily',
      customerId,
      agentId,
      signalId,
    } = params

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    const where: Prisma.signal_eventsWhereInput = {
      organizationId: orgId,
      usageDate: {
        gte: start,
        lte: end,
      },
    }

    if (customerId) where.customerId = customerId
    if (agentId) where.agentId = agentId
    if (signalId) where.signalId = signalId

    const events = await prisma.signal_events.findMany({
      where,
      select: {
        usageDate: true,
        quantity: true,
        signalId: true,
        customerId: true,
        signals: {
          select: { name: true },
        },
      },
      orderBy: { usageDate: 'asc' },
    })

    const dateMap = new Map<
      string,
      {
        count: number
        quantity: number
        bySignal: Map<string, { count: number; quantity: number }>
      }
    >()
    const uniqueCustomers = new Set<string>()
    const uniqueSignals = new Set<string>()
    let totalQuantity = 0

    events.forEach((event) => {
      const dateKey = getDateKey(event.usageDate, groupBy)
      const quantity = Number(event.quantity)

      totalQuantity += quantity
      uniqueCustomers.add(event.customerId)
      if (event.signalId) uniqueSignals.add(event.signalId)

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { count: 0, quantity: 0, bySignal: new Map() })
      }

      const dateData = dateMap.get(dateKey)!
      dateData.count++
      dateData.quantity += quantity

      if (event.signalId && event.signals) {
        const signalName = event.signals.name
        if (!dateData.bySignal.has(signalName)) {
          dateData.bySignal.set(signalName, { count: 0, quantity: 0 })
        }
        const signalData = dateData.bySignal.get(signalName)!
        signalData.count++
        signalData.quantity += quantity
      }
    })

    return {
      success: true,
      data: {
        dateRange: {
          start: startDate,
          end: endDate,
          groupBy,
        },
        stats: {
          totalEvents: events.length,
          totalQuantity,
          uniqueCustomers: uniqueCustomers.size,
          uniqueSignals: uniqueSignals.size,
        },
        aggregatedData: Array.from(dateMap.entries())
          .map(([date, data]) => ({
            date,
            totalEvents: data.count,
            totalQuantity: data.quantity,
            bySignal: Object.fromEntries(
              Array.from(data.bySignal.entries()).map(([name, d]) => [name, d])
            ),
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      },
    }
  } catch (error) {
    console.error('[getEventAggregation] Error:', error)
    return { success: false, error: 'Failed to fetch event aggregation' }
  }
}

export async function getSubscriptionAnalytics(
  subscriptionId: string,
  params: SubscriptionAnalyticsParams = {}
): Promise<{
  success: boolean
  data?: SubscriptionAnalyticsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const subscription = await prisma.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        customers: true,
        agents: true,
        pricing_plans: true,
      },
    })

    if (!subscription) {
      return { success: false, error: 'Subscription not found' }
    }

    const now = new Date()
    const billingStart = params.billingPeriodStart
      ? new Date(params.billingPeriodStart)
      : subscription.startDate
    const requestedEnd = params.billingPeriodEnd
      ? new Date(params.billingPeriodEnd)
      : subscription.endDate || now
    // A future endDate must not read as if that usage already happened.
    const billingEnd =
      requestedEnd.getTime() > now.getTime() ? now : requestedEnd
    const window = { start: billingStart, end: billingEnd }

    // Per-signal Agent-Earned (canon R1) + sub-level fees (R2) come from the
    // canonical revenue helper, not invoice line items: invoices materialize
    // at cycle-end, so an uninvoiced cycle would read zero.
    // canonGetRevenueMetrics is the same primitive the KPI tile uses, so the
    // rows reconcile with the tile by construction.
    const metrics = await canonGetRevenueMetrics(prisma, orgId, window, {
      subscriptionId,
    })

    const totalRevenue = metrics.revenue

    // Get signal events for this subscription — drives per-signal cost,
    // total cost, total event count, and the daily breakdown chart. The
    // canonical helper above already aggregated quantity per strategy, but
    // it does NOT expose per-event timestamps or per-event cost (canon C1
    // is computed from signal_events directly, never from invoices). We
    // still need this query for cost + chart, and for the date a signal
    // had activity.
    const events = await prisma.signal_events.findMany({
      where: {
        subscriptionId,
        organizationId: orgId,
        usageDate: {
          gte: billingStart,
          lte: billingEnd,
        },
      },
      select: {
        signalId: true,
        quantity: true,
        usageCost: true,
        usageDate: true,
        signals: {
          select: { id: true, name: true },
        },
      },
    })

    const totalCost = events.reduce(
      (sum, e) => sum + (Number(e.usageCost) || 0),
      0
    )
    const totalMargin = totalRevenue - totalCost

    // Aggregate per-signal canonical revenue from metrics.byStrategy. One
    // signal can be backed by multiple usage strategies (graduated tiers,
    // volume blocks, credit pools) so the group-by is mandatory — the
    // strategy is the canonical unit of pricing, but the table renders
    // one row per signal. Only usage-type strategies attach to a signal;
    // recurring / seat / onetime aggregate into the fees row below.
    //
    // Seeding from byStrategy (not from events) is what lets a usage
    // strategy with minimumCommitment but zero events render as a row
    // with revenue > 0, quantity 0, cost 0. A map seeded from events would
    // drop that row.
    const revenueBySignalId = new Map<
      string,
      { revenue: number; quantity: number }
    >()
    let usageRevenueWithoutSignal = 0
    for (const strat of metrics.byStrategy) {
      if (strat.chargeType !== 'usage') continue
      if (!strat.signalId) {
        // Unusual: a usage strategy with no signal linkage (no events can
        // attribute to it, but minimumCommitment can still fire). Roll
        // into the fees row so the total still closes against the tile.
        usageRevenueWithoutSignal += strat.revenue
        continue
      }
      const prior = revenueBySignalId.get(strat.signalId) ?? {
        revenue: 0,
        quantity: 0,
      }
      revenueBySignalId.set(strat.signalId, {
        revenue: prior.revenue + strat.revenue,
        quantity: prior.quantity + strat.quantity,
      })
    }

    // Lookup signal names for signalIds in revenueBySignalId. Events
    // already carry signal.name for active signals — but a min-commitment
    // usage strategy with zero events won't appear in the events query,
    // so we need a direct signals.findMany covering the canonical set.
    const signalIdsNeeded = Array.from(revenueBySignalId.keys())
    const signalNameRows =
      signalIdsNeeded.length > 0
        ? await prisma.signals.findMany({
            where: { id: { in: signalIdsNeeded }, orgId },
            select: { id: true, name: true },
          })
        : []
    const signalNameById = new Map<string, string>(
      signalNameRows.map((s) => [s.id, s.name])
    )

    // Build signalMap: source-of-truth for which rows render is the
    // canonical strategy list above. Events layer cost + (sanity-check)
    // quantity on top, but never introduce new rows on their own.
    const signalMap = new Map<
      string,
      { name: string; quantity: number; cost: number; revenue: number }
    >()
    for (const [signalId, agg] of revenueBySignalId) {
      // Fall back to the event-derived name only if signals.findMany
      // didn't return a row (e.g., signal soft-deleted mid-cycle). In
      // practice signalNameById will cover everything.
      const nameFromEvents =
        events.find((e) => e.signalId === signalId && e.signals)?.signals
          ?.name ?? null
      signalMap.set(signalId, {
        name:
          signalNameById.get(signalId) ?? nameFromEvents ?? 'Unknown signal',
        quantity: agg.quantity,
        cost: 0,
        revenue: agg.revenue,
      })
    }
    for (const e of events) {
      if (!e.signalId) continue
      const existing = signalMap.get(e.signalId)
      if (!existing) continue
      existing.cost += Number(e.usageCost) || 0
    }

    // Synthetic "Subscription fees" row carries the sub-level non-usage
    // revenue (recurring + seat + onetime per canon R2, plus the rare
    // signal-less usage min-commitment from above). Lets the breakdown
    // rows sum to the tile's canon Revenue. signalId is the synthetic
    // sentinel '__fees__' so React keys stay unique; the page never
    // links the row anywhere.
    const subscriptionFeesRevenue =
      metrics.recurringRevenue +
      metrics.seatRevenue +
      metrics.onetimeRevenue +
      usageRevenueWithoutSignal

    // Build daily breakdown — usage signals spread across event days; fees
    // spread across calendar days. Why calendar days for fees: a recurring-
    // only sub with zero events still accrues fees through the cycle, and
    // event-day spreading would hide that revenue from the chart entirely.
    const dailyMap = new Map<
      string,
      { signalName: string; quantity: number; cost: number }
    >()
    for (const e of events) {
      if (!e.signalId || !e.signals || !e.usageDate) continue
      const dateKey = e.usageDate.toISOString().split('T')[0]
      const key = `${dateKey}|${e.signals.name}`
      const existing = dailyMap.get(key) || {
        signalName: e.signals.name,
        quantity: 0,
        cost: 0,
      }
      existing.quantity += Number(e.quantity)
      existing.cost += Number(e.usageCost) || 0
      dailyMap.set(key, existing)
    }

    const daysPerSignal = new Map<string, number>()
    for (const [key] of dailyMap) {
      const signalName = key.split('|')[1]
      daysPerSignal.set(signalName, (daysPerSignal.get(signalName) ?? 0) + 1)
    }

    const dailyBreakdown = Array.from(dailyMap.entries()).map(([key, data]) => {
      const [date] = key.split('|')
      const signalEntry = Array.from(signalMap.values()).find(
        (s) => s.name === data.signalName
      )
      const signalRevenue = signalEntry?.revenue ?? 0
      const dayCount = daysPerSignal.get(data.signalName) ?? 1
      return {
        date,
        signalName: data.signalName,
        quantity: data.quantity,
        cost: data.cost,
        revenue: signalRevenue / dayCount,
      }
    })

    if (subscriptionFeesRevenue > 0) {
      // Distribute across calendar days so a fees-only / low-event sub
      // shows steady accrual instead of a single spike on one event day.
      const MS_PER_DAY = 24 * 60 * 60 * 1000
      const totalDays = Math.max(
        1,
        Math.ceil((billingEnd.getTime() - billingStart.getTime()) / MS_PER_DAY)
      )
      const perDay = subscriptionFeesRevenue / totalDays
      for (let i = 0; i < totalDays; i++) {
        const dayMs = billingStart.getTime() + i * MS_PER_DAY
        const dateKey = new Date(dayMs).toISOString().split('T')[0]
        dailyBreakdown.push({
          date: dateKey,
          signalName: 'Subscription fees',
          quantity: 0,
          cost: 0,
          revenue: perDay,
        })
      }
    }

    return {
      success: true,
      data: {
        subscription: {
          id: subscription.id,
          name: subscription.name,
          status: subscription.status || 'pending',
          billingCycle: subscription.billingCycle || 'monthly',
          startDate: subscription.startDate.toISOString(),
          endDate: subscription.endDate?.toISOString() || null,
          currentBillingPeriodStart:
            subscription.currentBillingPeriodStart?.toISOString() || null,
          currentBillingPeriodEnd:
            subscription.currentBillingPeriodEnd?.toISOString() || null,
          billingDay: subscription.billingDay ?? 1,
        },
        customer: {
          id: subscription.customers.id,
          name: subscription.customers.name,
          email: subscription.customers.email,
        },
        agent: {
          id: subscription.agents.id,
          name: subscription.agents.name,
          agentCode: subscription.agents.agentCode,
        },
        plan: subscription.pricing_plans
          ? {
              id: subscription.pricing_plans.id,
              name: subscription.pricing_plans.name,
            }
          : null,
        summary: {
          totalRevenue,
          totalCost,
          totalMargin,
          totalEvents: events.length,
        },
        signalSummary: [
          ...Array.from(signalMap.entries()).map(([signalId, data]) => ({
            signalId,
            signalName: data.name,
            totalQuantity: data.quantity,
            totalCost: data.cost,
            totalRevenue: data.revenue,
          })),
          // Append the fees row last so it renders at the bottom of the
          // table and reads as a footer-style line. Only emit it when
          // there's actual fee revenue — silent otherwise.
          ...(subscriptionFeesRevenue > 0
            ? [
                {
                  signalId: '__fees__',
                  signalName: 'Subscription fees',
                  totalQuantity: 0,
                  totalCost: 0,
                  totalRevenue: subscriptionFeesRevenue,
                },
              ]
            : []),
        ],
        dailyBreakdown,
      },
    }
  } catch (error) {
    console.error('[getSubscriptionAnalytics] Error:', error)
    return { success: false, error: 'Failed to fetch subscription analytics' }
  }
}

// ============================================================================
// Top Customers by Cost
// ============================================================================

export interface TopCustomersByCostParams {
  startDate: string
  endDate: string
}

export interface TopCustomerByCost {
  customerId: string
  customerName: string
  totalCost: number
  eventCount: number
  percentage: number
}

export interface TopCustomersByCostResponse {
  customers: TopCustomerByCost[]
  totalCost: number
}

/**
 * Get the top 5 customers ranked by how much they cost you in AI usage.
 * Used on the home page "By Customer" tab.
 */
export async function getTopCustomersByCost(
  params: TopCustomersByCostParams
): Promise<{
  success: boolean
  data?: TopCustomersByCostResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const { windowStart: start, windowEnd: end } = parseWindowFilter(params)

    // Pull all events for this org in the date range, grouped by customer
    const events = await prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: {
          gte: start,
          lte: end,
        },
      },
      select: {
        customerId: true,
        usageCost: true,
        customers: {
          select: { name: true },
        },
      },
    })

    const customerMap = new Map<
      string,
      { name: string; totalCost: number; eventCount: number }
    >()

    events.forEach((event) => {
      const existing = customerMap.get(event.customerId) || {
        name: event.customers.name,
        totalCost: 0,
        eventCount: 0,
      }
      existing.totalCost += Number(event.usageCost) || 0
      existing.eventCount += 1
      customerMap.set(event.customerId, existing)
    })

    // Sort by cost (highest first), take top 5
    const sorted = Array.from(customerMap.entries())
      .map(([customerId, data]) => ({
        customerId,
        customerName: data.name,
        totalCost: data.totalCost,
        eventCount: data.eventCount,
        percentage: 0, // filled in below
      }))
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5)

    const grandTotal = sorted.reduce((sum, c) => sum + c.totalCost, 0)
    sorted.forEach((c) => {
      c.percentage = shareOfTotal(c.totalCost, grandTotal) ?? 0
    })

    return {
      success: true,
      data: {
        customers: sorted,
        totalCost: grandTotal,
      },
    }
  } catch (error) {
    console.error('[getTopCustomersByCost] Error:', error)
    return { success: false, error: 'Failed to fetch top customers by cost' }
  }
}

// ============================================================================
// Canonical revenue + cost metrics
// Customer and subscription detail pages route their KPI tiles through these
// so the math matches the 4-label canon used on /home. getSubscriptionAnalytics
// serves dailyBreakdown, signalSummary, and plan/agent metadata, which are not
// re-derived here.
// ============================================================================

export interface CanonicalMetricsParams {
  // Both optional; default window is the 30 days ending now (UTC).
  // Either yyyy-MM-dd or a full ISO timestamp; Date constructor resolves both.
  startDate?: string
  endDate?: string
}

export interface CanonicalCustomerMetricsResponse {
  totals: {
    revenue: number
    cost: number
    margin: number
    marginPercent: number | null
  }
  bySubscription: Array<{
    subscriptionId: string
    revenue: number
    cost: number
    margin: number
    marginPercent: number | null
  }>
  period: { startDate: string; endDate: string }
}

export interface CanonicalSubscriptionMetricsResponse {
  subscriptionId: string
  revenue: number
  cost: number
  margin: number
  marginPercent: number | null
  period: { startDate: string; endDate: string }
}

export interface CustomerShareOfRevenueResponse {
  // All-time math: customer's paid invoices / org's paid invoices * 100.
  // Null when the org has zero paid invoices (avoids the 0/0 rendering trap).
  sharePercent: number | null
  customerCollected: number
  orgCollected: number
}

export interface CustomerShareOfCostResponse {
  // All-time math: customer's SUM(signal_events.usageCost) / org SUM * 100.
  // Null when the org has zero cost (avoids the 0/0 rendering trap).
  sharePercent: number | null
  customerCost: number
  orgCost: number
}

function resolveCanonicalWindow(params?: CanonicalMetricsParams): {
  start: Date
  end: Date
} {
  const { windowStart, windowEnd } = parseWindowFilter(params)
  return { start: windowStart, end: windowEnd }
}

/**
 * Canonical revenue + cost for a customer over a window. Returns totals
 * plus a per-subscription breakdown so the all-subs table can render
 * without a second round-trip per row.
 */
export async function getCanonicalCustomerMetrics(
  customerId: string,
  params?: CanonicalMetricsParams
): Promise<{
  success: boolean
  data?: CanonicalCustomerMetricsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId
    const window = resolveCanonicalWindow(params)

    const [revenue, cost] = await Promise.all([
      canonGetRevenueMetrics(prisma, orgId, window, { customerId }),
      canonGetCostMetrics(prisma, orgId, window, { customerId }),
    ])

    const totalMargin = revenue.revenue - cost.cost
    const totals = {
      revenue: revenue.revenue,
      cost: cost.cost,
      margin: totalMargin,
      marginPercent: safeMarginPercent(revenue.revenue, totalMargin),
    }

    // Per-subscription cost: one canon call per sub, so this is linear in the
    // customer's active subscription count.
    const subIds = revenue.bySubscription.map((s) => s.subscriptionId)
    const costBySubEntries = await Promise.all(
      subIds.map((subId) =>
        canonGetCostMetrics(prisma, orgId, window, {
          subscriptionId: subId,
        }).then((m) => [subId, m.cost] as const)
      )
    )
    const costBySubMap = new Map(costBySubEntries)

    const bySubscription = revenue.bySubscription.map((s) => {
      const subCost = costBySubMap.get(s.subscriptionId) ?? 0
      const subMargin = s.revenue - subCost
      return {
        subscriptionId: s.subscriptionId,
        revenue: s.revenue,
        cost: subCost,
        margin: subMargin,
        marginPercent: safeMarginPercent(s.revenue, subMargin),
      }
    })

    return {
      success: true,
      data: {
        totals,
        bySubscription,
        period: {
          startDate: window.start.toISOString(),
          endDate: window.end.toISOString(),
        },
      },
    }
  } catch (error) {
    console.error('[getCanonicalCustomerMetrics] Error:', error)
    return {
      success: false,
      error: 'Failed to fetch canonical customer metrics',
    }
  }
}

/**
 * Canonical revenue + cost for a single subscription over a window.
 * Subscription detail page calls this for its KPI tiles. Per-signal
 * canonical attribution IS a stated canon primitive (R1, computed per
 * pricing_strategies.signalId in canonGetRevenueMetrics.byStrategy) and
 * the breakdown table on the detail page reads through the same
 * primitive in getSubscriptionAnalytics — tile and rows share both the
 * window and the canonical source.
 */
export async function getCanonicalSubscriptionMetrics(
  subscriptionId: string,
  params?: CanonicalMetricsParams
): Promise<{
  success: boolean
  data?: CanonicalSubscriptionMetricsResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId
    const window = resolveCanonicalWindow(params)

    const [revenue, cost] = await Promise.all([
      canonGetRevenueMetrics(prisma, orgId, window, { subscriptionId }),
      canonGetCostMetrics(prisma, orgId, window, { subscriptionId }),
    ])

    const margin = revenue.revenue - cost.cost
    return {
      success: true,
      data: {
        subscriptionId,
        revenue: revenue.revenue,
        cost: cost.cost,
        margin,
        marginPercent: safeMarginPercent(revenue.revenue, margin),
        period: {
          startDate: window.start.toISOString(),
          endDate: window.end.toISOString(),
        },
      },
    }
  } catch (error) {
    console.error('[getCanonicalSubscriptionMetrics] Error:', error)
    return {
      success: false,
      error: 'Failed to fetch canonical subscription metrics',
    }
  }
}

/**
 * Customer share of paid revenue, NET of refunds. Customer's net paid
 * invoice total divided by the org's net paid invoice total. No lower
 * bound, bounded at today on the upper: the tile answers "how big is
 * this customer to us overall" rather than a period slice, so a 30-day
 * scope would misread stable long-term customers as small. Returns
 * sharePercent null when the org has no net paid revenue at all
 * (distinguishes "no revenue yet" from "0%").
 *
 * Routes through canon getInvoiceTotals so refund handling, soft-delete
 * filtering, and status-filter semantics stay in one place. A customer with
 * a $100 paid invoice and a $40 partial refund counts $60 toward share.
 */
export async function getCustomerShareOfRevenue(customerId: string): Promise<{
  success: boolean
  data?: CustomerShareOfRevenueResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const allTimeWindow = { start: new Date(0), end: new Date() }
    const [customerTotals, orgTotals] = await Promise.all([
      canonGetInvoiceTotals(prisma, orgId, allTimeWindow, { customerId }),
      canonGetInvoiceTotals(prisma, orgId, allTimeWindow),
    ])

    const customerCollected = customerTotals.collected
    const orgCollected = orgTotals.collected
    const sharePercent = shareOfTotal(customerCollected, orgCollected)

    return {
      success: true,
      data: { sharePercent, customerCollected, orgCollected },
    }
  } catch (error) {
    console.error('[getCustomerShareOfRevenue] Error:', error)
    return {
      success: false,
      error: 'Failed to fetch customer share of revenue',
    }
  }
}

/**
 * Customer share of cost. Customer's sum(signal_events.usageCost) divided by
 * the org's sum. Mirror of getCustomerShareOfRevenue but on the cost canon
 * (C1) instead of the invoice canon (I2/I3). No lower bound, bounded at today
 * on the upper, for the same reason: the tile answers "how big is this
 * customer to us overall" rather than a period slice. Returns sharePercent
 * null when the org has zero cost (avoids the 0/0 rendering trap).
 */
export async function getCustomerShareOfCost(customerId: string): Promise<{
  success: boolean
  data?: CustomerShareOfCostResponse
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    // Both halves must use the same instant.
    const throughNow = { lte: new Date() }
    const [customerAgg, orgAgg] = await Promise.all([
      prisma.signal_events.aggregate({
        where: { organizationId: orgId, customerId, usageDate: throughNow },
        _sum: { usageCost: true },
      }),
      prisma.signal_events.aggregate({
        where: { organizationId: orgId, usageDate: throughNow },
        _sum: { usageCost: true },
      }),
    ])

    const customerCost = Number(customerAgg._sum.usageCost ?? 0)
    const orgCost = Number(orgAgg._sum.usageCost ?? 0)
    const sharePercent = shareOfTotal(customerCost, orgCost)

    return {
      success: true,
      data: { sharePercent, customerCost, orgCost },
    }
  } catch (error) {
    console.error('[getCustomerShareOfCost] Error:', error)
    return {
      success: false,
      error: 'Failed to fetch customer share of cost',
    }
  }
}
