/**
 * MarginFront Client
 * Main entry point for the MarginFront SDK
 */

import { HttpClient } from "./utils/http";
import { RetryBuffer } from "./utils/buffer";
import { WarnLogger } from "./utils/warn-logger";
import {
  validateApiKey,
  parseApiKey,
  type ApiKeyType,
} from "./utils/validation";
import { UsageResource } from "./resources/usage";
import { CustomersResource } from "./resources/customers";
import { InvoicesResource } from "./resources/invoices";
import { AnalyticsResource } from "./resources/analytics";
import { SubscriptionsResource } from "./resources/subscriptions";
import { PortalSessionsResource } from "./resources/portal-sessions";
import { PricingPlansResource } from "./resources/pricing-plans";
import { PricingStrategiesResource } from "./resources/pricing-strategies";
import { ServicesResource } from "./resources/services";
import { SpendControlsResource } from "./resources/spend-controls";
import { CreditBalancesResource } from "./resources/credit-balances";
import { AuthenticationError, InitializationError } from "./errors";
import { maskApiKey } from "./transport-policy";
import type {
  MarginFrontConfig,
  ClientOptions,
  VerifyResponse,
  WhoamiResponse,
  TrackEventParams,
  TrackEventResponse,
  TelemetryStats,
  UsageRecordResponse,
} from "./types";

/**
 * Organization information from API key verification
 */
export interface OrganizationInfo {
  id: string;
  name: string;
  [key: string]: unknown;
}

/**
 * MarginFront SDK Client
 *
 * Provides access to all MarginFront API resources including usage tracking,
 * customer management, invoicing, analytics, and subscriptions.
 *
 * @example
 * ```typescript
 * import { MarginFrontClient } from '@marginfront/sdk';
 *
 * const client = new MarginFrontClient('mf_sk_your_secret_key');
 * await client.connect();
 *
 * // Track usage
 * await client.trackEvent({
 *   agentCode: 'agent_123',
 *   customerExternalId: 'customer_456',
 *   signalName: 'api_call',
 *   quantity: 1
 * });
 *
 * // Or with full configuration
 * const client = new MarginFrontClient('mf_sk_your_secret_key', {
 *   timeout: 10000,
 *   retries: 3,
 *   logging: { enabled: true, level: 'info' },
 *   telemetry: { enabled: true }
 * });
 * ```
 */
export class MarginFrontClient {
  private readonly http: HttpClient;
  private readonly _apiKey: string;
  private readonly _keyType: ApiKeyType;
  private readonly _buffer: RetryBuffer | null = null;
  private _orgInfo: OrganizationInfo | null = null;
  // Set only after whoami() resolves — the SDK never guesses a role from the key string.
  private _keyRole: string | null = null;

  /**
   * Usage tracking resource
   *
   * @example
   * ```typescript
   * await client.usage.record({
   *   customerExternalId: 'cust_123',
   *   agentCode: 'agent_abc',
   *   signalName: 'api_call',
   *   quantity: 1
   * });
   * ```
   */
  public readonly usage: UsageResource;

  /**
   * Customer management resource
   *
   * @example
   * ```typescript
   * const customer = await client.customers.create({
   *   name: 'Acme Corp',
   *   externalId: 'acme_123'
   * });
   * ```
   */
  public readonly customers: CustomersResource;

  /**
   * Invoice retrieval resource
   *
   * @example
   * ```typescript
   * const { invoices } = await client.invoices.list({
   *   status: 'issued'
   * });
   * ```
   */
  public readonly invoices: InvoicesResource;

  /**
   * Analytics resource
   *
   * @example
   * ```typescript
   * const analytics = await client.analytics.usage({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31'
   * });
   * ```
   */
  public readonly analytics: AnalyticsResource;

  /**
   * Subscription management resource
   *
   * @example
   * ```typescript
   * const { subscriptions } = await client.subscriptions.list({
   *   status: 'active'
   * });
   * ```
   */
  public readonly subscriptions: SubscriptionsResource;

  /**
   * Portal sessions resource
   * Create and manage customer portal sessions
   *
   * IMPORTANT: Requires a secret key (mf_sk_*). Publishable keys cannot create portal sessions.
   *
   * @example
   * ```typescript
   * const session = await client.portalSessions.create({
   *   customerId: 'cust_123',
   *   returnUrl: 'https://app.example.com/account'
   * });
   *
   * // Redirect customer to the portal
   * res.redirect(session.url);
   * ```
   */
  public readonly portalSessions: PortalSessionsResource;

  /**
   * Pricing plan management resource
   *
   * @example
   * ```typescript
   * const plan = await client.pricingPlans.create({ name: 'Pro Plan' });
   * await client.pricingPlans.linkAgent(plan.id, 'agent_uuid');
   * ```
   */
  public readonly pricingPlans: PricingPlansResource;

  /**
   * Pricing strategy management resource (nested under plans)
   *
   * @example
   * ```typescript
   * await client.pricingStrategies.createBulk('plan_uuid', [
   *   { name: 'API Calls', agentId: '...', chargeType: 'usage',
   *     pricingModel: 'credit_pool',
   *     tiers: [{ lower: 0, upper: 5000, rate: 99 }, { lower: 5000, upper: null, rate: 0.03 }] },
   * ]);
   * ```
   */
  public readonly pricingStrategies: PricingStrategiesResource;

  /**
   * Service catalog browser. Use this to discover the canonical model +
   * provider names MarginFront recognizes for cost calculation BEFORE firing
   * usage events. Helps avoid NEEDS_COST_BACKFILL on first-hit ingestion.
   *
   * @example
   * ```typescript
   * const { data } = await client.services.list({ provider: 'google' });
   * data.forEach(svc => console.log(svc.canonicalName, svc.costUnit));
   * ```
   */
  public readonly services: ServicesResource;

  /**
   * Spend Controls resource — read and manage internal code-spend caps
   * (policies, spend-vs-cap, coverage) from code. Writes are owner/finance-gated
   * server-side, exactly like the dashboard.
   *
   * @example
   * ```typescript
   * const { armed, total } = await client.spendControls.coverage();
   * const cap = await client.spendControls.create({
   *   scope: 'org', providerScope: 'all', amountUsd: 5000,
   *   period: 'month', mode: 'enforce',
   * });
   * console.log(cap.sentence);
   * ```
   */
  public readonly spendControls: SpendControlsResource;

  /**
   * Credit Balances resource — read your customers' credit-pool countdowns:
   * pool size, units used, units left, and units already billing as overage.
   * Reads only; adding units and pausing pool emails live in the dashboard,
   * behind the owner/admin/finance seat.
   *
   * Nothing stops when a pool empties. If you want your agent to react, read
   * the number and decide.
   *
   * @example
   * ```typescript
   * const { balances } = await client.creditBalances.list({ belowPercent: 20 });
   * const pool = await client.creditBalances.get(subscriptionId);
   * console.log(pool.remainingUnits, 'left;', pool.overageInProgressUnits, 'in overage');
   * ```
   */
  public readonly creditBalances: CreditBalancesResource;

  /**
   * Create a new MarginFront client
   *
   * @param apiKeyOrConfig - Either an API key string or a configuration object
   * @param options - Optional client options (when first param is API key)
   *
   * @example
   * ```typescript
   * // Point the client at your own MarginFront server
   * const client = new MarginFrontClient({
   *   apiKey: 'mf_sk_your_secret_key',
   *   baseUrl: 'https://billing.example.com/v1',
   * });
   *
   * // Key first, options second
   * const client = new MarginFrontClient('mf_sk_your_secret_key', {
   *   baseUrl: 'http://localhost:4000/v1',
   *   timeout: 10000,
   *   retries: 3
   * });
   *
   * // Key only: the server address comes from the MARGINFRONT_API_URL
   * // environment variable, and construction throws if it is not set
   * const client = new MarginFrontClient('mf_sk_your_secret_key');
   * ```
   */
  constructor(
    apiKeyOrConfig: string | MarginFrontConfig,
    options: ClientOptions = {},
  ) {
    let config: MarginFrontConfig;

    if (typeof apiKeyOrConfig === "string") {
      config = {
        apiKey: apiKeyOrConfig,
        ...options,
      };
    } else {
      config = apiKeyOrConfig;
    }

    validateApiKey(config.apiKey);

    // Parse prefix for a type hint — defaults to 'secret' if prefix is unrecognized.
    // The server is the authoritative source; this is used for convenience methods only.
    this._apiKey = config.apiKey;
    const keyInfo = parseApiKey(config.apiKey);
    this._keyType = keyInfo?.type ?? "secret";

    this.http = new HttpClient(config);

    // One warn sink shared by the buffer and the usage resource, so the
    // recovery counter stays coherent across both drop sites.
    const warnLogger = new WarnLogger(config);

    // Set up fireAndForget retry buffer (default: on). When enabled, usage
    // recording never throws — network errors go to a local retry buffer,
    // validation errors log a warning and drop, and auth failures (401/403)
    // drop with a warning naming the key.
    const fireAndForget = config.fireAndForget ?? true;
    if (fireAndForget) {
      this._buffer = new RetryBuffer(async (records) => {
        return await this.http.post<UsageRecordResponse>("/usage/record", {
          records,
        });
      }, warnLogger);
    }

    // Initialize resources
    this.usage = new UsageResource(
      this.http,
      fireAndForget,
      this._buffer,
      warnLogger,
    );
    this.customers = new CustomersResource(this.http);
    this.invoices = new InvoicesResource(this.http);
    this.analytics = new AnalyticsResource(this.http);
    this.subscriptions = new SubscriptionsResource(this.http);
    this.portalSessions = new PortalSessionsResource(this.http, () =>
      this.assertSecretKey(),
    );
    this.pricingPlans = new PricingPlansResource(this.http);
    this.pricingStrategies = new PricingStrategiesResource(this.http);
    this.services = new ServicesResource(this.http);
    this.spendControls = new SpendControlsResource(this.http);
    this.creditBalances = new CreditBalancesResource(this.http);
  }

  /**
   * No-op: the server enforces key type for secret-only operations.
   * PortalSessionsResource calls it before each request.
   */
  private assertSecretKey(): void {
    // no-op: server will return a clear error if a publishable key attempts a secret operation
  }

  /**
   * Connect to the MarginFront API and verify credentials
   *
   * This must be called once before using any API methods that require verification.
   * Optional but recommended for validating your API key.
   *
   * @returns Promise resolving to the client instance for chaining
   * @throws AuthenticationError if API key is invalid
   * @throws InitializationError for other initialization errors
   *
   * @example
   * ```typescript
   * const client = new MarginFrontClient('mf_sk_your_secret_key');
   *
   * try {
   *   await client.connect();
   *   console.log('Connected to MarginFront API');
   * } catch (error) {
   *   console.error('Failed to connect:', error);
   * }
   * ```
   */
  async connect(): Promise<MarginFrontClient> {
    try {
      const result = await this.http.get<VerifyResponse>("/verify");

      if (!result || !result.organization || !result.organization.id) {
        throw new InitializationError(
          "Unexpected response format from API key verification",
        );
      }

      this._orgInfo = result.organization as OrganizationInfo;

      return this;
    } catch (error: unknown) {
      const err = error as {
        statusCode?: number;
        response?: { status?: number };
        message?: string;
        requestId?: string;
      };
      const statusCode = err.statusCode || err.response?.status;
      const errorMessage = err.message || "Unknown error";
      const requestId = err.requestId || "unknown";

      if (statusCode === 401) {
        throw new AuthenticationError(
          "Invalid API key. Please check your API key and try again.",
          { requestId },
        );
      }

      throw new InitializationError(`Connection failed: ${errorMessage}`, {
        requestId,
      });
    }
  }

  /**
   * Verify the API key and get organization details
   *
   * @returns Verification result with organization info
   *
   * @example
   * ```typescript
   * const result = await client.verify();
   * if (result.verified) {
   *   console.log(`Connected to ${result.organization.name}`);
   * }
   * ```
   */
  async verify(): Promise<VerifyResponse> {
    const result = await this.http.get<VerifyResponse>("/verify");

    if (result.organization && !this._orgInfo) {
      this._orgInfo = result.organization as OrganizationInfo;
    }

    return result;
  }

  /**
   * Get organization information
   *
   * @returns Organization information from API key verification
   * @throws Error if organization info is not available (call connect() first)
   *
   * @example
   * ```typescript
   * await client.connect();
   * const org = client.getOrganization();
   * console.log(`Organization: ${org.name}`);
   * ```
   */
  getOrganization(): OrganizationInfo {
    if (!this._orgInfo) {
      throw new Error(
        "Organization information is not available. Make sure the API key is valid and you have called connect()",
      );
    }

    return { ...this._orgInfo };
  }

  /**
   * Track event for a customer (shorthand method)
   *
   * @param params - Event tracking parameters
   * @returns Tracked event data
   *
   * @example
   * ```typescript
   * // Simple event tracking
   * await client.trackEvent({
   *   agentCode: 'agent_123',
   *   customerExternalId: 'customer_456',
   *   signalName: 'api_call',
   *   quantity: 1
   * });
   *
   * // Batch tracking
   * await client.trackEvent({
   *   records: [
   *     { customerExternalId: 'cust_1', agentCode: 'agent_123', signalName: 'api_call', quantity: 10 },
   *     { customerExternalId: 'cust_2', agentCode: 'agent_123', signalName: 'storage', quantity: 100 }
   *   ]
   * });
   * ```
   */
  async trackEvent(params: TrackEventParams): Promise<TrackEventResponse> {
    return this.usage.trackEvent(params);
  }

  /**
   * Re-verify the API key
   *
   * Useful if you suspect the API key status might have changed
   *
   * @returns Updated organization information
   */
  async verifyApiKey(): Promise<OrganizationInfo> {
    const result = await this.verify();

    if (!result.organization) {
      throw new InitializationError(
        "Unexpected response format from API key verification",
      );
    }

    this._orgInfo = result.organization as OrganizationInfo;
    return { ...this._orgInfo };
  }

  /**
   * Get current telemetry statistics
   *
   * @returns Telemetry statistics
   *
   * @example
   * ```typescript
   * const stats = client.getTelemetryStats();
   * console.log(`Total Requests: ${stats.requestCount}`);
   * console.log(`Success Rate: ${(stats.successRate * 100).toFixed(2)}%`);
   * ```
   */
  getTelemetryStats(): TelemetryStats {
    return this.http.getTelemetryStats();
  }

  /**
   * Reset telemetry statistics
   */
  resetTelemetryStats(): void {
    this.http.resetTelemetryStats();
  }

  /**
   * Ask the server what this API key can do — its dashboard role and key type
   *Works for every key role, including an ingest-only key, so it's
   * safe to call at startup to assert identity before making a call that might 403.
   *
   * @returns the key's role (e.g. 'ingest', 'member', 'developer', 'finance', 'admin', 'owner') and key type
   *
   * @example
   * ```typescript
   * const identity = await client.whoami();
   * if (identity.role === 'ingest') {
   *   console.log('This key can send usage and read spend controls, including AI spend totals.');
   * }
   * ```
   */
  async whoami(): Promise<WhoamiResponse> {
    const result = await this.http.get<WhoamiResponse>("/me/key");
    this._keyRole = result.role;
    return result;
  }

  /**
   * The API key's dashboard role, if known.
   *
   * @returns the role from the last whoami() call, or null if whoami() hasn't been called yet
   */
  get keyRole(): string | null {
    return this._keyRole;
  }

  /**
   * Get the API key type (secret or publishable)
   *
   * @returns 'secret' for mf_sk_* keys, 'publishable' for mf_pk_* keys
   *
   * @example
   * ```typescript
   * if (client.getKeyType() === 'secret') {
   *   const session = await client.portalSessions.create({ ... });
   * }
   * ```
   */
  getKeyType(): ApiKeyType {
    return this._keyType;
  }

  /**
   * Check if the API key is a secret key (mf_sk_*)
   *
   * @returns true if the key can perform server-side operations
   */
  isSecretKey(): boolean {
    return this._keyType === "secret";
  }

  /**
   * Check if the API key is a publishable key (mf_pk_*)
   *
   * @returns true if the key is safe for frontend use
   */
  isPublishableKey(): boolean {
    return this._keyType === "publishable";
  }

  /**
   * Get a masked version of the API key for debugging
   *
   * @returns Masked API key showing only prefix and last 4 characters
   */
  getMaskedApiKey(): string {
    return maskApiKey(this._apiKey);
  }
}

// Re-export key utilities for convenience
export { parseApiKey, isSecretKey, isPublishableKey } from "./utils/validation";
export type { ApiKeyType } from "./utils/validation";
