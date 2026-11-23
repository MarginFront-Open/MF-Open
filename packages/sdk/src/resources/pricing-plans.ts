/**
 * Pricing Plans Resource
 * Handles pricing plan CRUD, copying, and agent linking
 */

import type { HttpClient } from "../utils/http";
import type {
  PricingPlan,
  CreatePricingPlanData,
  UpdatePricingPlanData,
  PricingPlanListParams,
  PricingPlanListResponse,
  CopyPricingPlanData,
  LinkAgentResponse,
} from "../types";
import { validateRequired } from "../utils/validation";

/**
 * Resource for managing pricing plans
 *
 * Pricing plans are containers for pricing strategies. A plan holds the rules
 * (charge types, tiers, rates) that determine how a customer gets billed.
 * Plans can be linked to one or more agents and assigned to customers via
 * subscriptions.
 */
export class PricingPlansResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a new pricing plan
   *
   * @param params - Plan creation parameters
   * @returns The created plan
   *
   * @example
   * ```typescript
   * const plan = await client.pricingPlans.create({
   *   name: 'Pro Plan',
   *   description: 'Usage-based with overage',
   * });
   * ```
   */
  async create(params: CreatePricingPlanData): Promise<PricingPlan> {
    validateRequired(params.name, "name");
    return this.http.post<PricingPlan>("/pricing-plans", params);
  }

  /**
   * List pricing plans with optional filters
   *
   * @param params - Optional filter and pagination parameters
   * @returns Paginated list of plans
   *
   * @example
   * ```typescript
   * const { results } = await client.pricingPlans.list({
   *   isActive: true,
   *   includeStrategies: true,
   * });
   * ```
   */
  async list(params?: PricingPlanListParams): Promise<PricingPlanListResponse> {
    return this.http.get<PricingPlanListResponse>(
      "/pricing-plans",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get a single pricing plan by ID
   *
   * @param planId - The plan's UUID
   * @returns The plan with linked agents and strategies
   *
   * @example
   * ```typescript
   * const plan = await client.pricingPlans.get('plan_uuid');
   * console.log(plan.agents); // agents linked to this plan
   * ```
   */
  async get(planId: string): Promise<PricingPlan> {
    validateRequired(planId, "planId");
    return this.http.get<PricingPlan>(`/pricing-plans/${planId}`);
  }

  /**
   * Update a pricing plan's metadata
   *
   * @param planId - The plan's UUID
   * @param params - Fields to update (name, description, featuresList, isActive)
   * @returns The updated plan
   *
   * @example
   * ```typescript
   * const plan = await client.pricingPlans.update('plan_uuid', {
   *   name: 'Enterprise Plan',
   *   isActive: true,
   * });
   * ```
   */
  async update(
    planId: string,
    params: UpdatePricingPlanData,
  ): Promise<PricingPlan> {
    validateRequired(planId, "planId");
    return this.http.patch<PricingPlan>(`/pricing-plans/${planId}`, params);
  }

  /**
   * Soft-delete a pricing plan
   *
   * @param planId - The plan's UUID
   *
   * @example
   * ```typescript
   * await client.pricingPlans.delete('plan_uuid');
   * ```
   */
  async delete(planId: string): Promise<void> {
    validateRequired(planId, "planId");
    await this.http.delete(`/pricing-plans/${planId}`);
  }

  /**
   * Copy a pricing plan (with all its strategies) and optionally apply a discount
   *
   * @param planId - The source plan's UUID
   * @param params - Copy parameters (new name, optional discount percentage)
   * @returns The newly created plan with copied strategies
   *
   * @example
   * ```typescript
   * // Copy with a 20% discount for yearly billing
   * const yearlyPlan = await client.pricingPlans.copy('plan_uuid', {
   *   newName: 'Pro Plan (Yearly)',
   *   discount: 20,
   *   requestedYearly: true,
   * });
   * ```
   */
  async copy(
    planId: string,
    params: CopyPricingPlanData,
  ): Promise<PricingPlan> {
    validateRequired(planId, "planId");
    validateRequired(params.newName, "newName");
    return this.http.post<PricingPlan>(`/pricing-plans/${planId}/copy`, params);
  }

  /**
   * Link a pricing plan to an agent (many-to-many)
   *
   * @param planId - The plan's UUID
   * @param agentId - The agent's UUID to link
   * @returns The updated link record
   *
   * @example
   * ```typescript
   * const { message } = await client.pricingPlans.linkAgent('plan_uuid', 'agent_uuid');
   * console.log(message); // "Plan linked to agent successfully"
   * ```
   */
  async linkAgent(planId: string, agentId: string): Promise<LinkAgentResponse> {
    validateRequired(planId, "planId");
    validateRequired(agentId, "agentId");
    return this.http.post<LinkAgentResponse>(
      `/pricing-plans/${planId}/agents`,
      { agentId },
    );
  }

  /**
   * Unlink a pricing plan from an agent
   *
   * Fails if active subscriptions exist using this plan+agent combination.
   *
   * @param planId - The plan's UUID
   * @param agentId - The agent's UUID to unlink
   *
   * @example
   * ```typescript
   * await client.pricingPlans.unlinkAgent('plan_uuid', 'agent_uuid');
   * ```
   */
  async unlinkAgent(planId: string, agentId: string): Promise<void> {
    validateRequired(planId, "planId");
    validateRequired(agentId, "agentId");
    await this.http.delete(`/pricing-plans/${planId}/agents/${agentId}`);
  }
}
