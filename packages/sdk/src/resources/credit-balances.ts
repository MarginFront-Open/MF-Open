/**
 * Credit Balances Resource
 *
 * Read your customers' credit-pool countdowns from code — the same numbers the
 * MarginFront dashboard shows, from the same server path, so your product and
 * your billing page can never disagree about how many units a customer has
 * left.
 *
 * READS ONLY, on purpose. Adding units and pausing pool emails are money
 * writes that live in the dashboard, where a human with an owner, admin, or
 * finance seat makes the call. To do them programmatically, add a method here
 * that calls a role-gated api-nest endpoint.
 *
 * Two numbers on every row are deliberately different and both are true:
 * `remainingUnits` counts manual top-ups; `overageInProgressUnits` is the
 * invoice's own math (usage past the pool size, top-up blind). A topped-up
 * pool can honestly read "1,200 units left" and "300 units billing as
 * overage" at once. Bill against the second, count down with the first.
 *
 * And the rule worth building around: nothing stops at zero. The pool is a
 * meter, not a breaker. If you want your agent to slow down when a customer
 * runs out, read `remainingUnits` and decide that yourself.
 */

import type { HttpClient } from "../utils/http";
import { validateRequired } from "../utils/validation";
import type {
  CreditBalance,
  CreditBalanceListParams,
  CreditBalanceListResponse,
} from "../types";

/**
 * Resource for reading credit-pool balances.
 */
export class CreditBalancesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Every credit-pool balance in the organization, emptiest first.
   * Subscriptions whose plan sells no credit pool are absent, never listed
   * with a zero.
   *
   * @example
   * ```typescript
   * const { balances } = await client.creditBalances.list();
   * balances.forEach((b) =>
   *   console.log(b.customerName, b.remainingUnits, "left")
   * );
   *
   * // Just the pools that need a human: 20% or less remaining.
   * const lowPools = await client.creditBalances.list({ belowPercent: 20 });
   * ```
   */
  async list(
    params: CreditBalanceListParams = {},
  ): Promise<CreditBalanceListResponse> {
    return this.http.get<CreditBalanceListResponse>("/credit-balances", {
      customerId: params.customerId,
      agentId: params.agentId,
      belowPercent: params.belowPercent,
    });
  }

  /**
   * One subscription's balance. Throws a plain-English 404 when the
   * subscription isn't yours or its plan sells no credit pool.
   *
   * @example
   * ```typescript
   * const pool = await client.creditBalances.get(subscriptionId);
   * if (pool.remainingUnits <= 0) {
   *   // Nothing is blocked. This is your call, not the platform's.
   *   console.log(`Overage so far: ${pool.overageInProgressUnits} units`);
   * }
   * ```
   */
  async get(subscriptionId: string): Promise<CreditBalance> {
    validateRequired(subscriptionId, "subscriptionId");
    return this.http.get<CreditBalance>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/credit-balance`,
    );
  }
}
