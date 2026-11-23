/**
 * Services Catalog Resource
 *
 * Read-only access to the global service_pricing catalog. Use this BEFORE
 * firing usage events with new model/provider names to discover what
 * MarginFront recognizes for cost calculation. If your service isn't in the
 * catalog, the event still lands but cost stays null (NEEDS_COST_BACKFILL)
 * until the catalog is updated. The map_model endpoint can then redirect to
 * an existing entry; it cannot create new rates.
 */

import type { HttpClient } from "../utils/http";
import type {
  ListServicesParams,
  ListServicesResponse,
  ServiceCatalogEntry,
} from "../types";
import { validateRequired } from "../utils/validation";

/**
 * Resource for browsing the MarginFront service catalog.
 */
export class ServicesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List entries from the global service catalog.
   *
   * @param params - Optional filters and pagination
   * @returns Paginated list of catalog entries
   *
   * @example
   * ```typescript
   * // Find every Google service in the catalog
   * const { data } = await client.services.list({ provider: 'google' });
   * data.forEach(entry => {
   *   console.log(`${entry.canonicalName} (${entry.serviceType}): ${entry.inputCost} per ${entry.costUnit}`);
   * });
   *
   * // Find non-LLM APIs only
   * const { data } = await client.services.list({ isApi: true });
   *
   * // Search by name
   * const { data } = await client.services.list({ search: 'gpt-4o' });
   * ```
   */
  async list(params?: ListServicesParams): Promise<ListServicesResponse> {
    return this.http.get<ListServicesResponse>(
      "/services",
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get a single catalog entry by its UUID.
   *
   * @param id - The catalog entry's UUID (from a prior `list()` call)
   * @returns The catalog entry
   *
   * @example
   * ```typescript
   * const entry = await client.services.get('11111111-2222-4333-8444-555555555555');
   * console.log(`Send '${entry.canonicalName}' as model with provider '${entry.provider}'`);
   * ```
   */
  async get(id: string): Promise<ServiceCatalogEntry> {
    validateRequired(id, "id");
    return this.http.get<ServiceCatalogEntry>(`/services/${id}`);
  }
}
