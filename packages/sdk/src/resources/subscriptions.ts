/**
 * Subscriptions Resource
 * Handles subscription management operations
 */

import type { HttpClient } from "../utils/http";
import type {
  ListSubscriptionsParams,
  ListSubscriptionsResponse,
  RevenueMetrics,
  SubscriptionDetail,
  SubscriptionDetailWithRevenue,
} from "../types";
import { validateRequired, validateDateString } from "../utils/validation";

/**
 * Optional window for `client.subscriptions.getWithRevenue()`. Both fields
 * together or neither. Omit to default to the last 30 days.
 */
export interface SubscriptionRevenueWindow {
  /** Start date (ISO format). */
  startDate?: string;
  /** End date (ISO format). */
  endDate?: string;
}

/**
 * Resource for managing subscriptions
 */
export class SubscriptionsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List subscriptions with optional filters
   *
   * @param params - Optional filter parameters
   * @returns Paginated list of subscriptions
   *
   * @example
   * ```typescript
   * const { subscriptions, totalResults } = await client.subscriptions.list({
   *   status: 'active',
   *   customerId: 'cust_123',
   *   page: 1,
   *   limit: 20
   * });
   * ```
   */
  async list(
    params?: ListSubscriptionsParams,
  ): Promise<ListSubscriptionsResponse> {
    return this.http.get<ListSubscriptionsResponse>(
      "/sdk/subscriptions",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get a single subscription by ID
   *
   * @param subscriptionId - The subscription's ID
   * @returns The subscription with full details including usage summary
   *
   * @example
   * ```typescript
   * const sub = await client.subscriptions.get('sub_abc');
   * console.log(`Status: ${sub.status}`);
   * console.log(`Usage this period: ${sub.usage.totalQuantity}`);
   * ```
   */
  async get(subscriptionId: string): Promise<SubscriptionDetail> {
    validateRequired(subscriptionId, "subscriptionId");
    return this.http.get<SubscriptionDetail>(
      `/sdk/subscriptions/${subscriptionId}`,
    );
  }

  /**
   * Get a subscription together with canonical revenue metrics for a window.
   *
   * Makes two API calls in parallel: the
   * standard subscription fetch plus the canonical per-subscription revenue
   * endpoint, and returns both in one object. Lets SDK consumers build
   * a subscription-detail page in one round-trip.
   *
   * If `window.startDate` / `window.endDate` are omitted, the revenue
   * call defaults to the last 30 days UTC.
   *
   * @param subscriptionId - The subscription's ID
   * @param window - Optional date window for the revenue block
   * @returns Object with `subscription` (SubscriptionDetail) and `revenue` (canonical RevenueMetrics)
   *
   * @example
   * ```typescript
   * // Default window (last 30 days)
   * const { subscription, revenue } = await client.subscriptions.getWithRevenue('sub_abc');
   * console.log(`Plan: ${subscription.plan.name}`);
   * console.log(`Revenue: $${revenue.revenue}, Margin: ${revenue.marginPercent ?? 0}%`);
   *
   * // Explicit window
   * const result = await client.subscriptions.getWithRevenue('sub_abc', {
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   * });
   * ```
   */
  async getWithRevenue(
    subscriptionId: string,
    window?: SubscriptionRevenueWindow,
  ): Promise<SubscriptionDetailWithRevenue> {
    validateRequired(subscriptionId, "subscriptionId");
    if (window?.startDate) validateDateString(window.startDate, "startDate");
    if (window?.endDate) validateDateString(window.endDate, "endDate");

    // Parallel fetch: the subscription record (/sdk/subscriptions/:id
    // path) plus the canonical per-subscription revenue endpoint.
    const revenueParams: Record<string, string> = {};
    if (window?.startDate) revenueParams.startDate = window.startDate;
    if (window?.endDate) revenueParams.endDate = window.endDate;

    const [subscription, revenue] = await Promise.all([
      this.http.get<SubscriptionDetail>(`/sdk/subscriptions/${subscriptionId}`),
      this.http.get<RevenueMetrics>(
        `/subscriptions/${subscriptionId}/revenue`,
        revenueParams as unknown as Record<string, unknown>,
      ),
    ]);

    return { subscription, revenue };
  }
}
