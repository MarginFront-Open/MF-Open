/**
 * Analytics Resource
 *
 * Handles usage analytics + canonical revenue/cost/MRR reporting. The
 * canonical methods on this resource (everything below `usage()`) all
 * wrap the api-nest `/v1/analytics/*` endpoints, which compute with the
 * shared revenue library in `@marginfront/db` (`getRevenueMetrics`,
 * `getCostMetrics`). Response shapes match the canonical TS types exactly,
 * so the SDK and the dashboard report the same shapes.
 */

import type { HttpClient } from "../utils/http";
import type {
  AgentEarned,
  AgentEarnedParams,
  CommittedMrrResult,
  CostMetrics,
  CostMetricsParams,
  InvoiceTotals,
  InvoiceTotalsParams,
  Mrr,
  MrrParams,
  RevenueMetrics,
  RevenueMetricsParams,
  RunRateMrrResult,
  UsageAnalyticsParams,
  UsageAnalyticsResponse,
} from "../types";
import { validateRequired, validateDateString } from "../utils/validation";

/**
 * Resource for accessing analytics data: usage rollups plus the canonical
 * revenue/cost/MRR surface.
 */
export class AnalyticsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get usage analytics (events, quantity, cost) for a date range.
   *
   * Returns the simple time-series shape the dashboard uses
   * for daily/weekly activity charts. Not the canonical revenue metric.
   * For canonical revenue with cost + margin, use `.revenue()` instead.
   *
   * @example
   * ```typescript
   * const analytics = await client.analytics.usage({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   *   groupBy: 'daily',
   *   subscriptionId: 'sub_abc',  // optional filter
   * });
   * ```
   */
  async usage(params: UsageAnalyticsParams): Promise<UsageAnalyticsResponse> {
    validateRequired(params.startDate, "startDate");
    validateRequired(params.endDate, "endDate");
    validateDateString(params.startDate, "startDate");
    validateDateString(params.endDate, "endDate");

    return this.http.get<UsageAnalyticsResponse>(
      "/sdk/analytics/usage",
      params as unknown as Record<string, unknown>,
    );
  }

  // ------------------------------------------------------------------
  // Canonical revenue/cost/MRR methods
  // ------------------------------------------------------------------

  /**
   * Canonical revenue metrics (canon R1 + R2).
   *
   * Returns the full `RevenueMetrics` shape. Revenue, cost, margin,
   * marginPercent, usage/recurring/seat/onetime breakdown, bySubscription,
   * byStrategy. Scoped to the date window and any combination of entity
   * filters.
   *
   * Whenever a filter (customerId / subscriptionId / signalId) is set the
   * API always returns canonical shape. For the org-wide call (no filters)
   * the SDK passes `variant=canonical` so you get `RevenueMetrics` rather
   * than the MRR-trio breakdown the API returns by default.
   *
   * @example
   * ```typescript
   * // Org-wide revenue for last 30 days
   * const metrics = await client.analytics.revenue({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   * });
   * console.log(`Revenue: $${metrics.revenue.toFixed(2)}`);
   * console.log(`Margin: ${(metrics.marginPercent ?? 0).toFixed(1)}%`);
   *
   * // Per-customer revenue
   * const custMetrics = await client.analytics.revenue({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   *   customerId: 'cust_123',
   * });
   * ```
   */
  async revenue(params: RevenueMetricsParams): Promise<RevenueMetrics> {
    validateRequired(params.startDate, "startDate");
    validateRequired(params.endDate, "endDate");
    validateDateString(params.startDate, "startDate");
    validateDateString(params.endDate, "endDate");

    // Always request canonical shape. The API returns `RevenueMetrics` for
    // any filter OR when variant=canonical. Setting it unconditionally
    // keeps the contract predictable for SDK callers.
    return this.http.get<RevenueMetrics>("/analytics/revenue", {
      ...params,
      variant: "canonical",
    } as unknown as Record<string, unknown>);
  }

  /**
   * Canonical cost metrics (canon C1).
   *
   * Returns `CostMetrics`. Full cost breakdown by agent, customer, signal,
   * day, pricing plan, and LLM model. Includes `eventCountWithNullCost`
   * (the "needs attention" counter for events whose cost couldn't be
   * computed).
   *
   * Set `includePriorWindow: true` to also get period-over-period trend
   * data in the response's `prior` field (one extra DB query).
   *
   * @example
   * ```typescript
   * const cost = await client.analytics.costBreakdown({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   *   includePriorWindow: true,
   * });
   * console.log(`Cost this month: $${cost.cost.toFixed(2)}`);
   * if (cost.prior) {
   *   const delta = cost.cost - cost.prior.cost;
   *   console.log(`Δ vs prior window: $${delta.toFixed(2)}`);
   * }
   * ```
   */
  async costBreakdown(params: CostMetricsParams): Promise<CostMetrics> {
    validateRequired(params.startDate, "startDate");
    validateRequired(params.endDate, "endDate");
    validateDateString(params.startDate, "startDate");
    validateDateString(params.endDate, "endDate");

    return this.http.get<CostMetrics>(
      "/analytics/cost",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Canonical invoice totals (canon I2 + I3).
   *
   * Returns billed / collected / draft / outstanding / overdueAmount /
   * overdueCount / invoicesSentCount for the window. `outstanding` is open
   * accounts receivable right now (issued + overdue), with no date window.
   * `overdueAmount` is current-state too (no date filter).
   *
   * @example
   * ```typescript
   * const totals = await client.analytics.invoiceTotals({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   * });
   * console.log(`Billed: $${totals.billed}`);
   * console.log(`Collected: $${totals.collected}`);
   * console.log(`Outstanding: $${totals.outstanding}`);
   * if (totals.overdueCount > 0) {
   *   console.log(`⚠️  ${totals.overdueCount} overdue ($${totals.overdueAmount})`);
   * }
   * ```
   */
  async invoiceTotals(params: InvoiceTotalsParams): Promise<InvoiceTotals> {
    validateRequired(params.startDate, "startDate");
    validateRequired(params.endDate, "endDate");
    validateDateString(params.startDate, "startDate");
    validateDateString(params.endDate, "endDate");

    return this.http.get<InvoiceTotals>(
      "/analytics/invoice-totals",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Canonical MRR (MRR1): contracted monthly recurring revenue of active
   * subscriptions, today. Returns `{ mrr, arr }` where `arr = mrr * 12`. Optional `customerId` / `subscriptionId` narrows.
   *
   * For forward-looking questions (run-rate, contractual floor) use
   * `runRateMrr()` or `committedMrr()`.
   *
   * @example
   * ```typescript
   * const { mrr, arr } = await client.analytics.mrr();
   * console.log(`MRR: $${mrr}, ARR: $${arr}`);
   * ```
   */
  async mrr(params?: MrrParams): Promise<Mrr> {
    const response = await this.http.get<Mrr & { variant?: string }>(
      "/analytics/mrr",
      { ...params, variant: "canonical" } as unknown as Record<string, unknown>,
    );
    // API wraps the canonical MRR result with a `variant` discriminator;
    // strip it before handing to the caller so the return type is clean.
    const { variant: _v, ...mrrResult } = response;
    void _v;
    return mrrResult;
  }

  /**
   * Run-Rate MRR (MRR2). "what would we bill per month if the last 30 days
   * kept going?"
   *
   * Contract commitments plus actual 30-day usage, monthly-normalized.
   * Returns `{ mrr, breakdown[] }` with per-subscription recurring / seat /
   * usage / total contributions.
   *
   * @example
   * ```typescript
   * const { mrr, breakdown } = await client.analytics.runRateMrr();
   * for (const row of breakdown) {
   *   console.log(`Sub ${row.subscriptionId}: $${row.total} (usage: $${row.usage})`);
   * }
   * ```
   */
  async runRateMrr(params?: MrrParams): Promise<RunRateMrrResult> {
    const response = await this.http.get<
      RunRateMrrResult & { variant?: string }
    >("/analytics/mrr", { ...params, variant: "runRate" } as unknown as Record<
      string,
      unknown
    >);
    const { variant: _v, ...result } = response;
    void _v;
    return result;
  }

  /**
   * Committed MRR (MRR3). "contractual floor regardless of usage."
   *
   * Same shape as run-rate but usage is replaced with
   * `strategy.minimumCommitment × rate` (0 when no minimum is set). The
   * floor under run-rate: committed ≤ runRate by definition.
   *
   * @example
   * ```typescript
   * const { mrr, breakdown } = await client.analytics.committedMrr();
   * console.log(`Committed MRR floor: $${mrr}`);
   * ```
   */
  async committedMrr(params?: MrrParams): Promise<CommittedMrrResult> {
    const response = await this.http.get<
      CommittedMrrResult & { variant?: string }
    >("/analytics/mrr", {
      ...params,
      variant: "committed",
    } as unknown as Record<string, unknown>);
    const { variant: _v, ...result } = response;
    void _v;
    return result;
  }

  /**
   * Agent-Earned (canon R1 pure). Activity-only revenue.
   *
   * Events × pricing-strategy rate only. Excludes recurring fees, seat
   * fees, onetime fees, and prorations. This is the leading indicator at
   * the top of the Earned → Billed → Collected funnel. The "did my agent
   * do billable work?" number, independent of invoice cadence.
   *
   * @example
   * ```typescript
   * const earned = await client.analytics.agentEarned({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   *   agentId: 'agent_abc',
   * });
   * console.log(`Activity revenue: $${earned.revenue}`);
   * console.log(`Events: ${earned.eventCount}`);
   * ```
   */
  async agentEarned(params: AgentEarnedParams): Promise<AgentEarned> {
    validateRequired(params.startDate, "startDate");
    validateRequired(params.endDate, "endDate");
    validateDateString(params.startDate, "startDate");
    validateDateString(params.endDate, "endDate");

    return this.http.get<AgentEarned>(
      "/analytics/agent-earned",
      params as unknown as Record<string, unknown>,
    );
  }
}
