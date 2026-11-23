/**
 * Portal Sessions Resource
 *
 * Create and manage portal sessions for your customers.
 * Portal sessions provide secure, short-lived URLs that allow customers
 * to access their billing information without exposing your API key.
 *
 * This follows the Stripe/Chargebee pattern:
 * 1. Your backend creates a portal session using your secret key
 * 2. You redirect the customer to the portal URL
 * 3. Customer can view invoices, subscriptions, usage (1 hour expiry)
 *
 * @example
 * ```typescript
 * import { MarginFrontClient } from '@marginfront/sdk';
 *
 * const client = new MarginFrontClient('mf_sk_your_secret_key');
 *
 * // Create a portal session
 * const session = await client.portalSessions.create({
 *   customerId: 'cust_123',
 *   returnUrl: 'https://app.example.com/account'
 * });
 *
 * // Redirect customer to the portal
 * res.redirect(session.url);
 * ```
 *
 * IMPORTANT: Portal session creation requires a secret key (mf_sk_*).
 * Publishable keys cannot create portal sessions.
 */

import { HttpClient } from "../utils/http";
import { ValidationError } from "../errors";
import type {
  PortalSession,
  CreatePortalSessionParams,
  ListPortalSessionsParams,
  ListPortalSessionsResponse,
} from "../types";

export class PortalSessionsResource {
  constructor(
    private readonly http: HttpClient,
    private readonly assertSecretKey: () => void,
  ) {}

  /**
   * Create a new portal session
   *
   * Creates a short-lived portal session for a customer.
   * The returned URL can be used to redirect the customer to their billing portal.
   *
   * @param params - Portal session parameters
   * @returns Created portal session with URL and token
   * @throws ValidationError if neither customerId nor customerExternalId is provided
   * @throws AuthenticationError if using a publishable key
   *
   * @example
   * ```typescript
   * // By customer ID
   * const session = await client.portalSessions.create({
   *   customerId: 'cust_123',
   *   returnUrl: 'https://app.example.com/account'
   * });
   *
   * // By external ID
   * const session = await client.portalSessions.create({
   *   customerExternalId: 'your_customer_id',
   *   features: ['invoices', 'usage']
   * });
   *
   * console.log(session.url); // Redirect customer here
   * ```
   */
  async create(params: CreatePortalSessionParams): Promise<PortalSession> {
    // A no-op: the server rejects a publishable key here.
    this.assertSecretKey();

    // Validate at least one customer identifier is provided
    if (!params.customerId && !params.customerExternalId) {
      throw new ValidationError(
        "Either customerId or customerExternalId is required",
      );
    }

    return this.http.post<PortalSession>("/portal-sessions", params);
  }

  /**
   * Get a portal session by ID
   *
   * @param sessionId - Portal session ID
   * @returns Portal session details
   *
   * @example
   * ```typescript
   * const session = await client.portalSessions.get('ps_123');
   * console.log(session.expiresAt);
   * ```
   */
  async get(sessionId: string): Promise<PortalSession> {
    this.assertSecretKey();

    if (!sessionId) {
      throw new ValidationError("sessionId is required");
    }

    return this.http.get<PortalSession>(`/portal-sessions/${sessionId}`);
  }

  /**
   * List portal sessions
   *
   * @param params - Optional filters
   * @returns List of portal sessions
   *
   * @example
   * ```typescript
   * // List all active sessions
   * const { data } = await client.portalSessions.list();
   *
   * // List sessions for a specific customer
   * const { data } = await client.portalSessions.list({
   *   customerId: 'cust_123',
   *   includeExpired: true
   * });
   * ```
   */
  async list(
    params?: ListPortalSessionsParams,
  ): Promise<ListPortalSessionsResponse> {
    this.assertSecretKey();

    return this.http.get<ListPortalSessionsResponse>("/portal-sessions", {
      customerId: params?.customerId,
      limit: params?.limit,
      includeExpired: params?.includeExpired,
    });
  }

  /**
   * Revoke a portal session
   *
   * Immediately invalidates the session, preventing further access.
   *
   * @param sessionId - Portal session ID to revoke
   *
   * @example
   * ```typescript
   * await client.portalSessions.revoke('ps_123');
   * ```
   */
  async revoke(sessionId: string): Promise<void> {
    this.assertSecretKey();

    if (!sessionId) {
      throw new ValidationError("sessionId is required");
    }

    await this.http.delete(`/portal-sessions/${sessionId}`);
  }
}
