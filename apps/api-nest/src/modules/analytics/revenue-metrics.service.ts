/**
 * RevenueMetricsService. Thin NestJS wrapper around the canonical
 * `@marginfront/db` revenue library.
 *
 * This service exists solely so NestJS modules and controllers can
 * constructor-inject a typed provider instead of importing @marginfront/db
 * directly. The math and queries live in the shared package; this file is
 * pure dependency-injection plumbing. No business logic, no duplicates.
 *
 * See packages/db/CANON.md for the rules these functions enforce.
 */

import { Injectable } from '@nestjs/common';
import {
  getAgentEarned,
  getCommittedMrr,
  getCostMetrics,
  getInvoiceTotals,
  getMrr,
  getRevenueMetrics,
  getRunRateMrr,
  type AgentEarned,
  type CommittedMrrResult,
  type CostMetrics,
  type InvoiceTotals,
  type Mrr,
  type MrrFilters,
  type RevenueFilters,
  type RevenueMetrics,
  type RevenueWindow,
  type RunRateMrrResult,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class RevenueMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Revenue = Agent-Earned + prorated recurring + prorated seat + onetime.
   * "What the customer owes us for this window." Canon R1 + R2.
   */
  getRevenueMetrics(
    orgId: string,
    window: RevenueWindow,
    filters?: RevenueFilters,
  ): Promise<RevenueMetrics> {
    return getRevenueMetrics(this.prisma.getClient(), orgId, window, filters);
  }

  /**
   * Agent-Earned = events × pricing-strategy rate. Pure activity, no fees,
   * no proration. The leading indicator in the Earned → Billed → Collected
   * funnel. Canon R1 only.
   */
  getAgentEarned(
    orgId: string,
    window: RevenueWindow,
    filters?: RevenueFilters,
  ): Promise<AgentEarned> {
    return getAgentEarned(this.prisma.getClient(), orgId, window, filters);
  }

  /**
   * Cost = SUM(signal_events.usageCost) for the window. Org-wide, no
   * subscription attribution required. Canon C1 + C2.
   *
   * Pass `options.priorWindow` to populate the `prior` field for trend
   * comparison (one extra DB query). Used by analytics endpoints that need
   * period-over-period growth without re-implementing the aggregation.
   */
  getCostMetrics(
    orgId: string,
    window: RevenueWindow,
    filters?: RevenueFilters,
    options?: { priorWindow?: RevenueWindow },
  ): Promise<CostMetrics> {
    return getCostMetrics(this.prisma.getClient(), orgId, window, filters, options);
  }

  /**
   * Invoice totals for the window (billed/collected/outstanding/overdue).
   * Canon I2 + I3.
   *
   * Pass `filters.customerId` to scope to one customer. `subscriptionId`
   * scopes to one subscription. `agentId` scopes through the subscription
   * relation (invoices.subscriptions.agentId). Single place per-customer
   * + per-subscription + per-agent billed/collected math runs across
   * the codebase.
   */
  getInvoiceTotals(
    orgId: string,
    window: RevenueWindow,
    filters?: RevenueFilters,
  ): Promise<InvoiceTotals> {
    return getInvoiceTotals(this.prisma.getClient(), orgId, window, filters);
  }

  /**
   * MRR per canon MRR1: contracted monthly recurring revenue — active
   * subscriptions' recurring + seat strategies, monthly-normalized;
   * usage and onetime excluded.
   *
   * Filter narrowing lets a customer detail page request MRR for one
   * customer without re-implementing the formula; narrowing is by
   * subscription fields (customerId / subscriptionId).
   */
  getMrr(orgId: string, filters?: MrrFilters): Promise<Mrr> {
    return getMrr(this.prisma.getClient(), orgId, filters);
  }

  /**
   * MRR2. Run-Rate MRR. Contract commitments plus actual last-30-days
   * usage activity, monthly-normalized. Forward-looking trajectory.
   */
  getRunRateMrr(orgId: string, filters?: MrrFilters): Promise<RunRateMrrResult> {
    return getRunRateMrr(this.prisma.getClient(), orgId, filters);
  }

  /**
   * MRR3. Committed MRR (CMRR). Contractual floor regardless of actual
   * usage. Used for forecasting and sales-pipeline projections.
   */
  getCommittedMrr(orgId: string, filters?: MrrFilters): Promise<CommittedMrrResult> {
    return getCommittedMrr(this.prisma.getClient(), orgId, filters);
  }
}
