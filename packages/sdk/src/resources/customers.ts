/**
 * Customers Resource
 * Handles customer CRUD operations
 */

import type { HttpClient } from "../utils/http";
import type {
  Customer,
  CreateCustomerData,
  CustomerDetailWithRevenue,
  CustomerListParams,
  CustomerListResponse,
  RevenueMetrics,
  UpdateCustomerData,
} from "../types";
import { validateRequired, validateDateString } from "../utils/validation";

/**
 * Optional window for `client.customers.getWithRevenue()`. Both fields
 * together or neither. Omit to default to the last 30 days.
 */
export interface CustomerRevenueWindow {
  /** Start date (ISO format). */
  startDate?: string;
  /** End date (ISO format). */
  endDate?: string;
}

/**
 * Resource for managing customers
 */
export class CustomersResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a new customer
   *
   * @param params - Customer creation parameters
   * @returns The created customer
   *
   * @example
   * ```typescript
   * const customer = await client.customers.create({
   *   name: 'Acme Corp',
   *   externalId: 'acme_123',
   *   email: 'billing@acme.example',
   *   agentCode: 'agent_abc' // auto-creates subscription
   * });
   * ```
   */
  async create(params: CreateCustomerData): Promise<Customer> {
    validateRequired(params.name, "name");
    return this.http.post<Customer>("/sdk/customers", params);
  }

  /**
   * Get a single customer by ID
   *
   * @param id - The customer's ID
   * @returns The customer with subscriptions
   *
   * @example
   * ```typescript
   * const customer = await client.customers.get('cust_123');
   * console.log(customer.name);
   * ```
   */
  async get(id: string): Promise<Customer> {
    validateRequired(id, "id");
    return this.http.get<Customer>(`/sdk/customers/${id}`);
  }

  /**
   * Update an existing customer
   *
   * @param id - The customer's ID
   * @param params - Fields to update
   * @returns The updated customer
   *
   * @example
   * ```typescript
   * const customer = await client.customers.update('cust_123', {
   *   name: 'New Company Name',
   *   email: 'new-email@company.example'
   * });
   * ```
   */
  async update(id: string, params: UpdateCustomerData): Promise<Customer> {
    validateRequired(id, "id");
    return this.http.patch<Customer>(`/sdk/customers/${id}`, params);
  }

  /**
   * Delete a customer
   *
   * @param id - The customer's ID
   *
   * @example
   * ```typescript
   * await client.customers.delete('cust_123');
   * ```
   */
  async delete(id: string): Promise<void> {
    validateRequired(id, "id");
    await this.http.delete(`/sdk/customers/${id}`);
  }

  /**
   * List customers with pagination and filtering
   *
   * @param params - List parameters
   * @returns Paginated list of customers
   *
   * @example
   * ```typescript
   * const { data, totalResults, hasMore } = await client.customers.list({
   *   limit: 10,
   *   page: 1
   * });
   * ```
   */
  async list(
    params?: CustomerListParams,
  ): Promise<CustomerListResponse | Customer[]> {
    const response = await this.http.get<Customer[] | CustomerListResponse>(
      "/sdk/customers",
      params as unknown as Record<string, unknown>,
    );

    // If the API returns an array, wrap it in CustomerListResponse
    if (Array.isArray(response)) {
      return {
        data: response,
        totalResults: response.length,
        page: params?.page || 1,
        limit: params?.limit || response.length,
        hasMore: false,
      };
    }

    return response;
  }

  /**
   * Get a customer together with canonical revenue metrics for a window.
   *
   * Makes two API calls in parallel: the
   * standard customer fetch plus the canonical per-customer revenue
   * endpoint, and returns both in one object. Lets SDK consumers build
   * a customer-detail page in one round-trip without picking which call
   * happens first.
   *
   * If `window.startDate` / `window.endDate` are omitted, the revenue
   * call defaults to the last 30 days UTC (matches the dashboard default).
   *
   * @param id - The customer's ID
   * @param window - Optional date window for the revenue block
   * @returns Object with `customer` (the usual Customer shape) and `revenue` (canonical RevenueMetrics)
   *
   * @example
   * ```typescript
   * // Default window (last 30 days)
   * const { customer, revenue } = await client.customers.getWithRevenue('cust_123');
   * console.log(`${customer.name}: $${revenue.revenue} revenue, ${revenue.eventCount} events`);
   *
   * // Explicit window
   * const result = await client.customers.getWithRevenue('cust_123', {
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   * });
   * ```
   */
  async getWithRevenue(
    id: string,
    window?: CustomerRevenueWindow,
  ): Promise<CustomerDetailWithRevenue> {
    validateRequired(id, "id");
    if (window?.startDate) validateDateString(window.startDate, "startDate");
    if (window?.endDate) validateDateString(window.endDate, "endDate");

    // Parallel fetch: the customer record (/sdk/customers/:id path)
    // and the canonical per-customer revenue endpoint. No ordering
    // constraint between them, so fire both and await.
    const revenueParams: Record<string, string> = {};
    if (window?.startDate) revenueParams.startDate = window.startDate;
    if (window?.endDate) revenueParams.endDate = window.endDate;

    const [customer, revenue] = await Promise.all([
      this.http.get<Customer>(`/sdk/customers/${id}`),
      this.http.get<RevenueMetrics>(
        `/customers/${id}/revenue`,
        revenueParams as unknown as Record<string, unknown>,
      ),
    ]);

    return { customer, revenue };
  }
}
