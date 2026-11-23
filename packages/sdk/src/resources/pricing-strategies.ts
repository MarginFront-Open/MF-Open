/**
 * Pricing Strategies Resource
 * Handles pricing strategy CRUD (nested under pricing plans)
 */

import type { HttpClient } from "../utils/http";
import type {
  PricingStrategy,
  CreatePricingStrategyData,
  CreditPoolInput,
  UpdatePricingStrategyData,
  PricingStrategyListParams,
  PricingStrategyListResponse,
  BulkUpdatePricingStrategiesData,
  BulkUpdatePricingStrategiesResponse,
} from "../types";
import { validateRequired } from "../utils/validation";

/**
 * Resource for managing pricing strategies
 *
 * Strategies are the actual pricing rules inside a plan. The charge types,
 * pricing models, tiers, and rates that determine what a customer pays.
 *
 * All operations are scoped to a specific pricing plan (planId).
 */
export class PricingStrategiesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create one or more pricing strategies on a plan
   *
   * The API accepts an array. Send one strategy or many in one call.
   *
   * @param planId - The plan's UUID
   * @param strategies - Array of strategies to create
   * @returns The created strategies
   *
   * @example
   * ```typescript
   * // Create a credit pool strategy: 5,000 calls for $99, then $0.03 overage
   * const strategies = await client.pricingStrategies.createBulk('plan_uuid', [
   *   {
   *     name: 'API Call Pool',
   *     agentId: 'agent_uuid',
   *     chargeType: 'usage',
   *     pricingModel: 'credit_pool',
   *     signalId: 'signal_uuid',
   *     creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.03 },
   *   },
   * ]);
   * ```
   */
  async createBulk(
    planId: string,
    strategies: CreatePricingStrategyData[],
  ): Promise<PricingStrategy[]> {
    validateRequired(planId, "planId");
    // Controller expects the array directly as the request body
    return this.http.post<PricingStrategy[]>(
      `/pricing-plans/${planId}/pricing-strategies`,
      strategies,
    );
  }

  /**
   * Create a credit-pool strategy in one call
   *
   * A credit pool is "$X per cycle buys N units, extras cost Y each." Nothing
   * stops when the pool empties — the overage keeps billing. Send the three
   * numbers; the server compiles the tier shape.
   *
   * @param planId - The plan's UUID
   * @param params - The strategy, with `creditPool` instead of `tiers`
   * @returns The created strategy
   *
   * @example
   * ```typescript
   * // 5,000 calls for $99/cycle, then 3¢ each
   * const strategy = await client.pricingStrategies.createCreditPool('plan_uuid', {
   *   name: 'API Call Pool',
   *   agentId: 'agent_uuid',
   *   signalId: 'signal_uuid',
   *   poolSize: 5000,
   *   poolPrice: 99,
   *   overageRate: 0.03,
   * });
   * ```
   */
  async createCreditPool(
    planId: string,
    params: CreditPoolInput & {
      name: string;
      agentId: string;
      signalId: string;
      billingFrequency?: CreatePricingStrategyData["billingFrequency"];
      tags?: string[];
      active?: boolean;
    },
  ): Promise<PricingStrategy> {
    validateRequired(planId, "planId");
    validateRequired(params?.name, "name");
    validateRequired(params?.agentId, "agentId");
    validateRequired(params?.signalId, "signalId");

    const { poolSize, poolPrice, overageRate, ...rest } = params;
    // Forwarded verbatim: packages/sdk cannot import @marginfront/db, so compile and
    // shape-check both happen once at the api-nest service layer.
    const created = await this.createBulk(planId, [
      {
        ...rest,
        chargeType: "usage",
        pricingModel: "credit_pool",
        creditPool: { poolSize, poolPrice, overageRate },
      },
    ]);
    return created[0];
  }

  /**
   * List pricing strategies for a plan
   *
   * @param planId - The plan's UUID
   * @param params - Optional filter and pagination parameters
   * @returns Paginated list of strategies
   *
   * @example
   * ```typescript
   * const { results } = await client.pricingStrategies.list('plan_uuid', {
   *   chargeType: 'usage',
   *   active: true,
   * });
   * ```
   */
  async list(
    planId: string,
    params?: PricingStrategyListParams,
  ): Promise<PricingStrategyListResponse> {
    validateRequired(planId, "planId");
    return this.http.get<PricingStrategyListResponse>(
      `/pricing-plans/${planId}/pricing-strategies`,
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get a single pricing strategy by ID
   *
   * @param planId - The plan's UUID
   * @param strategyId - The strategy's UUID
   * @returns The strategy with signal details
   *
   * @example
   * ```typescript
   * const strategy = await client.pricingStrategies.get('plan_uuid', 'strategy_uuid');
   * console.log(strategy.chargeType, strategy.pricingModel);
   * ```
   */
  async get(planId: string, strategyId: string): Promise<PricingStrategy> {
    validateRequired(planId, "planId");
    validateRequired(strategyId, "strategyId");
    return this.http.get<PricingStrategy>(
      `/pricing-plans/${planId}/pricing-strategies/${strategyId}`,
    );
  }

  /**
   * Update a single pricing strategy
   *
   * @param planId - The plan's UUID
   * @param strategyId - The strategy's UUID
   * @param params - Fields to update
   * @returns The updated strategy
   *
   * @example
   * ```typescript
   * const updated = await client.pricingStrategies.update(
   *   'plan_uuid',
   *   'strategy_uuid',
   *   { rate: 0.05, active: true },
   * );
   * ```
   */
  async update(
    planId: string,
    strategyId: string,
    params: UpdatePricingStrategyData,
  ): Promise<PricingStrategy> {
    validateRequired(planId, "planId");
    validateRequired(strategyId, "strategyId");
    return this.http.patch<PricingStrategy>(
      `/pricing-plans/${planId}/pricing-strategies/${strategyId}`,
      params,
    );
  }

  /**
   * Bulk update existing strategies and/or create new ones in one call
   *
   * @param planId - The plan's UUID
   * @param params - Object with `strategies.new` and/or `strategies.update` arrays
   * @returns Summary of created and updated strategies
   *
   * @example
   * ```typescript
   * const result = await client.pricingStrategies.bulkUpdate('plan_uuid', {
   *   strategies: {
   *     new: [{ name: 'New Fee', agentId: '...', chargeType: 'recurring', rate: 49 }],
   *     update: [{ id: 'existing_uuid', rate: 59 }],
   *   },
   * });
   * ```
   */
  async bulkUpdate(
    planId: string,
    params: BulkUpdatePricingStrategiesData,
  ): Promise<BulkUpdatePricingStrategiesResponse> {
    validateRequired(planId, "planId");
    return this.http.patch<BulkUpdatePricingStrategiesResponse>(
      `/pricing-plans/${planId}/pricing-strategies`,
      params,
    );
  }

  /**
   * Soft-delete a pricing strategy
   *
   * @param planId - The plan's UUID
   * @param strategyId - The strategy's UUID
   *
   * @example
   * ```typescript
   * await client.pricingStrategies.delete('plan_uuid', 'strategy_uuid');
   * ```
   */
  async delete(planId: string, strategyId: string): Promise<void> {
    validateRequired(planId, "planId");
    validateRequired(strategyId, "strategyId");
    await this.http.delete(
      `/pricing-plans/${planId}/pricing-strategies/${strategyId}`,
    );
  }
}
