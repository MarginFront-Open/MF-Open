/**
 * MarginFront SDK Types
 * TypeScript interfaces for all API requests and responses
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Log levels supported by the SDK
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Custom log handler function
 */
export type LogHandler = (
  level: LogLevel,
  message: string,
  data?: unknown,
) => void;

/**
 * Logging configuration options
 */
export interface LoggingOptions {
  /** Whether logging is enabled. Unset means HTTP debug/info logging is off
   * but data-loss warnings (retry buffer drops, auth drops) still print.
   * `false` silences both. */
  enabled?: boolean;
  /** Minimum log level to output. Applies to HTTP request logging only;
   * data-loss warnings ignore it and are silenced only by `enabled: false`. */
  level?: LogLevel;
  /** Custom log handler function. Receives data-loss warnings too. */
  handler?: LogHandler;
}

/**
 * Telemetry handler function
 */
export type TelemetryHandler = (metrics: RequestMetrics) => void;

/**
 * Telemetry configuration options
 */
export interface TelemetryOptions {
  /** Whether telemetry is enabled */
  enabled?: boolean;
  /** Sample rate for telemetry (0-1), 1 = track every request */
  sampleRate?: number;
  /** Custom handler for telemetry events */
  handler?: TelemetryHandler;
}

/**
 * Request metrics collected for telemetry
 */
export interface RequestMetrics {
  /** Unique ID for the request */
  requestId: string;
  /** Request method (GET, POST, etc) */
  method: string;
  /** Normalized request path */
  path: string;
  /** Timestamp when request started */
  startTime: number;
  /** Timestamp when request ended */
  endTime?: number;
  /** Duration of the request in milliseconds */
  duration?: number;
  /** HTTP status code */
  statusCode?: number;
  /** Whether the request was successful */
  success?: boolean;
  /** Error message if request failed */
  errorMessage?: string;
  /** Error type if request failed */
  errorType?: string;
  /** Number of retry attempts */
  retryCount?: number;
}

/**
 * Telemetry statistics
 */
export interface TelemetryStats {
  requestCount: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  averageDuration: number;
  errorBreakdown: Record<string, number>;
}

/**
 * Configuration options for the MarginFront client
 */
export interface MarginFrontConfig {
  /** API key for authentication (format: mf_sk_* or mf_pk_*) */
  apiKey: string;
  /**
   * Your MarginFront server's API address, including the /v1 path, for example
   * "https://billing.example.com/v1". Required: there is no built-in server.
   * When omitted, the MARGINFRONT_API_URL environment variable is used.
   * Must be https, or http to localhost / 127.0.0.1 / [::1].
   */
  baseUrl?: string;
  /** @deprecated Use baseUrl instead */
  baseURL?: string;
  /**
   * Allow unencrypted http to a server on another machine (the API key travels
   * in the clear). Off by default; only for a private network you trust.
   * When omitted, MARGINFRONT_ALLOW_INSECURE_HTTP=1 turns it on.
   */
  allowInsecureHttp?: boolean;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Number of retry attempts for failed requests (default: 3) */
  retries?: number;
  /** Delay between retry attempts in milliseconds (default: 300) */
  retryDelay?: number;
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
  /** Enable debug logging (shorthand for logging.enabled) */
  debug?: boolean;
  /** Logging configuration */
  logging?: LoggingOptions;
  /** Telemetry configuration for performance tracking */
  telemetry?: TelemetryOptions;
  /** When true (default), usage.record() never throws. Network errors go to
   * a local retry buffer, validation errors log a warning and drop, and auth
   * errors (401/403) drop immediately with a warning naming the key as the
   * cause (retrying can't fix a dead key). Set to false if you want to
   * handle errors yourself. */
  fireAndForget?: boolean;
}

/**
 * Client options (config without apiKey)
 */
export type ClientOptions = Omit<MarginFrontConfig, "apiKey">;

// ============================================================================
// API Verification Types
// ============================================================================

export interface Organization {
  id: string;
  name: string;
}

export interface VerifyResponse {
  organization: Organization;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Response shape for GET /me/key — the key's own dashboard role and
 * key type, so a caller can check "what can I do" before making a call that
 * might 403. Reachable by every key role, including the ingest floor.
 */
export interface WhoamiResponse {
  /** The key's dashboard role, e.g. 'ingest', 'member', 'developer', 'finance', 'admin', 'owner'. */
  role: string;
  keyType: "secret" | "publishable";
}

// ============================================================================
// Usage Types
// ============================================================================

/**
 * One service contribution within a multi-service usage event.
 *
 * Use this when a single business outcome (one report generated, one
 * call answered) is backed by more than one underlying service. For
 * example, a sourcing report that uses Claude for the LLM work and
 * Google Maps for places lookups would have two ServiceEntry items
 * inside one UsageRecord.
 */
export interface ServiceEntry {
  /** Model identifier from your provider (e.g. "gpt-4o", "claude-sonnet-4-6", "twilio-sms") */
  model: string;
  /** Provider name in lowercase (e.g. "openai", "anthropic", "google", "twilio") */
  modelProvider: string;
  /** Number of input (prompt) tokens. Required for LLM cost tracking, optional for non-LLM */
  inputTokens?: number;
  /** Number of output (completion) tokens. Required for LLM cost tracking, optional for non-LLM */
  outputTokens?: number;
  /**
   * Number of prompt-cache READ tokens (cache hits). Optional. Pass your
   * provider response's cache-read count (Anthropic `cache_read_input_tokens`,
   * OpenAI `prompt_tokens_details.cached_tokens`). Priced at the cheaper
   * cache-read rate instead of the full input rate.
   */
  cacheReadTokens?: number;
  /**
   * Number of prompt-cache WRITE tokens (cache creation). Optional. Pass your
   * provider response's cache-creation count (Anthropic
   * `cache_creation_input_tokens`). Priced at the cache-write rate.
   */
  cacheWriteTokens?: number;
  /** Quantity for non-LLM services (must be >= 0) */
  quantity?: number;
}

/**
 * Environment in which the usage event occurred. Drives the COGS vs R&D
 * accounting classification: `production` events flow into COGS, `development`
 * and `testing` events flow into R&D. `staging` is intentionally ambiguous —
 * the platform leaves the signal's `costCategory` untouched. When omitted,
 * the platform falls back to the signal's manually set classification.
 */
export type UsageEnvironment =
  | "production"
  | "staging"
  | "development"
  | "testing";

/**
 * Fields shared by both single-service and multi-service usage events.
 */
export interface CommonEventFields {
  /** Customer's external ID in your system */
  customerExternalId: string;
  /** External code of the agent/product being used (set in the UI when creating an agent) */
  agentCode: string;
  /** Name of the signal/metric being tracked */
  signalName: string;
  /** Optional date for the usage event (defaults to now) */
  usageDate?: string | Date;
  /** Optional metadata to attach to the usage event */
  metadata?: Record<string, unknown>;
  /**
   * Environment the event occurred in. Used by the platform to auto-classify
   * the parent signal as `PRODUCTION_COGS` or `DEVELOPMENT_RD` for accounting.
   * If omitted, the signal's existing `costCategory` is left unchanged.
   */
  environment?: UsageEnvironment;
}

/**
 * Single-service usage record. One business outcome backed by ONE
 * underlying service (the most common case).
 */
export interface SingleServiceEvent extends CommonEventFields {
  /** Model identifier from your provider (e.g. "gpt-4o", "claude-sonnet-4-6", "twilio-sms") */
  model: string;
  /** Provider name in lowercase (e.g. "openai", "anthropic", "google", "twilio") */
  modelProvider: string;
  /** Number of input (prompt) tokens. Required for LLM cost tracking, optional for non-LLM */
  inputTokens?: number;
  /** Number of output (completion) tokens. Required for LLM cost tracking, optional for non-LLM */
  outputTokens?: number;
  /**
   * Number of prompt-cache READ tokens (cache hits). Optional, LLM-only.
   * Pass your provider response's cache-read count (Anthropic
   * `cache_read_input_tokens`). Priced at the cheaper cache-read rate.
   */
  cacheReadTokens?: number;
  /**
   * Number of prompt-cache WRITE tokens (cache creation). Optional, LLM-only.
   * Pass your provider response's cache-creation count (Anthropic
   * `cache_creation_input_tokens`). Priced at the cache-write rate.
   */
  cacheWriteTokens?: number;
  /** Quantity to record (must be >= 0) */
  quantity?: number;
}

/**
 * Multi-service usage record. One business outcome backed by MULTIPLE
 * underlying services (e.g. one report = Claude tokens + Google Maps
 * queries). MarginFront aggregates per-service cost into the parent
 * event and exposes the per-service breakdown for analytics.
 */
export interface MultiServiceEvent extends CommonEventFields {
  /** Two or more services attributed to this single business outcome. */
  services: ServiceEntry[];
}

/**
 * A single usage record to be tracked. Either single-service (one
 * service per event, the common case) or multi-service (one event
 * carrying multiple services).
 *
 * The discriminator is the presence of `services`: if provided, the
 * record is multi-service; otherwise it's single-service. Both shapes
 * accept the same usage event metadata (customerExternalId, agentCode,
 * signalName, usageDate, metadata).
 */
export type UsageRecord = SingleServiceEvent | MultiServiceEvent;

/**
 * Parameters for tracking events - supports single record or batch
 */
export type TrackEventParams = UsageRecord | { records: UsageRecord[] };

/**
 * Response for a single tracked event
 */
export interface SingleEventResponse {
  /** ID of the recorded usage. Empty string when the event never reached the server. */
  id: string;
  /** true only when the server confirmed the event was stored. */
  success: boolean;
  /** true only when a server response was actually received. false means the
   * SDK swallowed a transport failure or validation drop (fireAndForget). */
  delivered: boolean;
  /** How many events the local retry buffer actually accepted after a
   * transport failure. 0 on validation drops — invalid events are never
   * buffered. Absent on delivered responses (nothing to buffer). If buffered
   * > 0 the SDK will retry those events itself; re-sending them from your
   * code would double-bill. */
  buffered?: number;
  /** Server event ID, present when the event was stored. */
  eventId?: string;
  /** Raw-ingest correlation handle for support debugging; null when the raw
   * row itself could not be created. */
  rawEventId?: string | null;
  /** Server-recorded timestamp, present when the event was stored. */
  timestamp?: string;
  /** Which entities this event auto-provisioned (first event for a new
   * customerExternalId/agentCode/signalName). Absent (undefined) on
   * transport failures and idempotent replays (an idempotencyKey
   * retry that collapsed into the already-recorded event) — undefined means
   * "no provisioning info", NOT "nothing created"; branch with
   * `created?.customer`, never `created.customer === false`. A re-ingest
   * that revives a soft-deleted customer/agent/signal reports false: the
   * row pre-existed and keeps its id and billing history. */
  created?: {
    customer: boolean;
    agent: boolean;
    signal: boolean;
  };
  /** Why the event failed or was dropped, when it was. */
  error?: string;
}

/**
 * Response for batch event tracking
 */
export interface BatchEventResponse {
  /** true only when every record was delivered and stored. A transport failure
   * is success: false even when the events were buffered for retry. */
  success: boolean;
  /** Total number of records processed */
  totalRecords: number;
  /** Number of records successfully processed */
  successCount: number;
  /** Number of records that failed to process */
  failureCount: number;
  /** How many records the local retry buffer actually accepted after a
   * transport failure. 0 on validation drops — invalid records are never
   * buffered. Absent on delivered responses (nothing to buffer). If buffered
   * > 0 the SDK will retry those records itself; re-sending them from your
   * code would double-bill. */
  buffered?: number;
  /** Results for each record */
  results: Array<{
    /** Whether this record was successfully processed */
    success: boolean;
    /** true only when a server response was actually received for this record. */
    delivered: boolean;
    /** The data for the record, if successful */
    responseData?: SingleEventResponse;
    /** Error message if the record failed */
    error?: string;
    /** Server failure code (e.g. NEEDS_COST_BACKFILL, MISSING_VOLUME_DATA,
     * INTERNAL_ERROR). Absent when the record never reached the server. */
    code?: string;
    /** false = not persisted (including transport failures — safe to retry);
     * true = persisted server-side despite the failure — do not re-send it.
     * Absent = the server did not say; the retry policy treats it as
     * persisted. */
    stored?: boolean;
    /** Server event ID, present when the failed event was still stored. */
    eventId?: string;
    /** Raw-ingest correlation handle for support debugging; null when the raw
     * row itself could not be created. */
    rawEventId?: string | null;
    /** Auto-provision flags for this record (see SingleEventResponse.created);
     * a stored failure still creates the customer/agent/signal. */
    created?: {
      customer: boolean;
      agent: boolean;
      signal: boolean;
    };
    /** The original data that was submitted */
    originalData?: Record<string, unknown>;
  }>;
}

/**
 * Response from event tracking - can be single or batch
 */
export type TrackEventResponse = SingleEventResponse | BatchEventResponse;

export interface UsageRecordSuccess {
  customerExternalId: string;
  agentCode: string;
  signalName: string;
  quantity: number;
  eventId: string;
  rawEventId: string;
  timestamp: string;
  /** Which entities this event auto-provisioned. `created.customer: true`
   * means this was the first event for that `customerExternalId` and
   * MarginFront created the customer from it (same for agent/signal).
   * Absent (undefined) on idempotent replays —
   * undefined means "no provisioning info", NOT "nothing created". A
   * re-ingest that revives a soft-deleted entity reports false (the row
   * pre-existed; billing history intact). */
  created?: {
    customer: boolean;
    agent: boolean;
    signal: boolean;
  };
}

export interface UsageRecordFailure {
  record: UsageRecord;
  error: string;
  /** Server failure code (e.g. NEEDS_COST_BACKFILL, MISSING_VOLUME_DATA,
   * INTERNAL_ERROR). Absent when the record never reached the server. */
  code?: string;
  /** false = not persisted (including transport failures — safe to retry);
   * true = persisted server-side despite the failure — do not re-send it.
   * Absent = the server did not say; the retry policy treats it as
   * persisted. */
  stored?: boolean;
  /** Server event ID, present when the failed event was still stored. */
  eventId?: string;
  /** Raw-ingest correlation handle for support debugging; null when the raw
   * row itself could not be created. */
  rawEventId?: string | null;
  /** Same auto-provision flags as UsageRecordSuccess: a stored failure (e.g.
   * NEEDS_COST_BACKFILL on a first event with an uncataloged model) still
   * creates the customer/agent/signal. Absent when the record never reached
   * entity provisioning AND on generic failures (e.g. INTERNAL_ERROR) where
   * provisioning may have happened but the error response can't report it. */
  created?: {
    customer: boolean;
    agent: boolean;
    signal: boolean;
  };
}

export interface UsageRecordResponse {
  processed: number;
  successful: number;
  failed: number;
  /** true only when a server response was actually received. false means the
   * SDK swallowed a transport failure or validation drop (fireAndForget). */
  delivered?: boolean;
  /** How many records the local retry buffer actually accepted after a
   * transport failure. 0 on validation drops — invalid records are never
   * buffered. Absent on delivered responses (nothing to buffer). If buffered
   * > 0 the SDK will retry those records itself; re-sending them from your
   * code would double-bill. */
  buffered?: number;
  results: {
    success: UsageRecordSuccess[];
    failed: UsageRecordFailure[];
  };
}

// ============================================================================
// Customer Types
// ============================================================================

export type CustomerStatus = "active" | "inactive" | "suspended";

/**
 * Data for creating a new customer
 */
export interface CreateCustomerData {
  /** Customer name (required) */
  name: string;
  /** Unique external ID in your system */
  externalId?: string;
  /** Customer email address */
  email?: string;
  /** Customer phone number */
  phone?: string;
  /** Customer timezone (default: UTC) */
  timezone?: string;
  /** Customer status */
  status?: CustomerStatus;
  /** Billing contact name */
  billingContactName?: string;
  /** Billing contact email */
  billingContactEmail?: string;
  /** Net payment terms in days (default: 30) */
  netTerms?: number;
  /** List of email addresses to receive invoices */
  invoiceEmailRecipients?: string[];
  /** Street address line 1 */
  addressLine1?: string;
  /** Street address line 2 */
  addressLine2?: string;
  /** City */
  city?: string;
  /** State or province */
  state?: string;
  /** ZIP or postal code */
  zipCode?: string;
  /** Country */
  country?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Agent code (external ID set in the UI) - if provided, auto-creates a subscription */
  agentCode?: string;
}

/** Alias for CreateCustomerData */
export type CustomerCreateParams = CreateCustomerData;

/**
 * Data for updating an existing customer
 */
export interface UpdateCustomerData {
  name?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  status?: CustomerStatus;
  billingContactName?: string;
  billingContactEmail?: string;
  netTerms?: number;
  invoiceEmailRecipients?: string[];
  metadata?: Record<string, unknown> | null;
}

/** Alias for UpdateCustomerData */
export type CustomerUpdateParams = UpdateCustomerData;

export interface CustomerSubscription {
  id: string;
  status: string;
  startDate: string;
  endDate: string | null;
  agent: {
    id: string;
    name: string;
    agentCode: string;
  };
  plan: {
    id: string;
    name: string;
  };
}

export interface Customer {
  id: string;
  name: string;
  externalId: string | null;
  email: string | null;
  phone: string | null;
  timezone: string;
  status: CustomerStatus;
  billingContactName: string | null;
  billingContactEmail: string | null;
  netTerms: number;
  invoiceEmailRecipients: string[];
  metadata: Record<string, unknown> | null;
  subscriptions?: CustomerSubscription[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Parameters for listing customers
 */
export interface CustomerListParams {
  /** Page number for pagination */
  page?: number;
  /** Number of items per page */
  limit?: number;
  /** Filter by external ID */
  externalId?: string;
  /** Filter by email */
  email?: string;
  /** Search query string */
  query?: string;
}

/**
 * Response for customer listing
 */
export interface CustomerListResponse {
  /** Array of customers */
  data: Customer[];
  /** Total number of results */
  totalResults: number;
  /** Current page number */
  page: number;
  /** Number of items per page */
  limit: number;
  /** Whether there's a next page */
  hasMore: boolean;
}

// ============================================================================
// Invoice Types
// ============================================================================

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "paid"
  | "overdue"
  | "void"
  | "refunded";

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  /** Unit price. */
  unitPrice: number;
  /** Line-item total (quantity × unitPrice). */
  amount: number;
  signalName?: string;
}

export interface InvoiceCustomer {
  id: string;
  name: string;
  email: string | null;
  externalId: string | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  invoiceDate: string;
  dueDate: string;
  /** Invoice total. */
  totalAmount: number;
  /** Amount paid to date. */
  amountPaid: number;
  /** Amount still due. */
  amountDue: number;
  currency: string;
  customer: InvoiceCustomer;
  lineItems: InvoiceLineItem[];
  createdAt: string;
}

export interface InvoiceDetail extends Invoice {
  payments?: Array<{
    id: string;
    /** Payment amount. */
    amount: number;
    paymentDate: string;
    paymentMethod: string;
  }>;
  subscription?: {
    id: string;
    status: string;
    agent: {
      id: string;
      name: string;
    };
    plan: {
      id: string;
      name: string;
    };
  };
}

export interface ListInvoicesParams {
  /** Filter by customer ID */
  customerId?: string;
  /** Filter by customer external ID */
  customerExternalId?: string;
  /** Filter by invoice status */
  status?: InvoiceStatus;
  /** Page number (default: 1) */
  page?: number;
  /** Results per page (default: 20) */
  limit?: number;
}

export interface ListInvoicesResponse {
  invoices: Invoice[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

/**
 * Options for `client.invoices.send()`. All fields are optional — by default the
 * invoice is emailed to the customer's stored email with auto-generated subject + body.
 */
export interface SendInvoiceParams {
  /** Override the destination address. Falls back to the customer's stored email. */
  recipientEmail?: string;
  /** Alias for `recipientEmail`. */
  email?: string;
  /** Custom subject line. Default: "Invoice {number} from {your business name}". */
  subject?: string;
  /** Optional note prepended to the email body, shown in a callout above the invoice details. */
  message?: string;
}

/**
 * Response from `client.invoices.send()`. If the invoice was a draft when this call
 * landed, the API also auto-finalizes it (status flips draft → issued) as a side effect.
 */
export interface SendInvoiceResponse {
  success: boolean;
  message: string;
  /** Resend message ID for tracking delivery (null if the email provider returned no ID). */
  emailId: string | null;
  /** The address the email was actually sent to (after applying any overrides). */
  recipientEmail: string;
}

// ============================================================================
// Analytics Types
// ============================================================================

export type GroupBy = "daily" | "weekly" | "monthly";

export interface UsageAnalyticsParams {
  /** Start date (ISO format, required) */
  startDate: string;
  /** End date (ISO format, required) */
  endDate: string;
  /** Grouping interval (default: daily) */
  groupBy?: GroupBy;
  /** Filter by customer ID */
  customerId?: string;
  /** Filter by customer external ID */
  customerExternalId?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by signal ID */
  signalId?: string;
  /** Filter by subscription ID */
  subscriptionId?: string;
}

export interface UsageAnalyticsSummary {
  totalEvents: number;
  totalQuantity: number;
  totalCost: number;
  uniqueCustomers: number;
  uniqueAgents: number;
  uniqueSignals: number;
}

export interface UsageAnalyticsDataPoint {
  date: string;
  quantity: number;
  cost: number;
  eventCount: number;
}

export interface UsageAnalyticsResponse {
  dateRange: {
    start: string;
    end: string;
    groupBy: GroupBy;
  };
  summary: UsageAnalyticsSummary;
  data: UsageAnalyticsDataPoint[];
}

// ============================================================================
// Canonical Revenue Types
// ============================================================================
//
// These types mirror @marginfront/db's `revenue-metrics` schemas exactly. They
// are the single canonical shape for every dollar-valued analytics surface
// the SDK returns. Revenue, cost, margin, billed, collected, MRR. The
// RevenueMetricsService in api-nest returns these shapes; the SDK methods
// below only type the wire response.
//
// All dollar amounts are plain `number` (full precision, not pre-rounded).
// Formatters at the UI layer round to 2 decimals exactly once per canon R4.
// Rule codes such as R1, C1, I2 and MRR1 refer to packages/db/CANON.md.

/** One entry per active subscription in scope for the window. */
export interface SubscriptionRevenue {
  subscriptionId: string;
  customerId: string;
  agentId: string;
  planId: string;
  revenue: number;
  cost: number;
  margin: number;
  usageRevenue: number;
  recurringRevenue: number;
  seatRevenue: number;
  onetimeRevenue: number;
  eventCount: number;
}

/** One entry per pricing strategy that contributed revenue in the window. */
export interface StrategyRevenue {
  strategyId: string;
  chargeType: ChargeType;
  pricingModel: PricingModel | null;
  signalId: string | null;
  revenue: number;
  /** For usage strategies: SUM(quantity) in the window. 0 for non-usage. */
  quantity: number;
}

/**
 * The canonical revenue shape. Returned by:
 *  - `client.analytics.revenue()`
 *  - `client.customers.getWithRevenue()` (embedded)
 *  - `client.subscriptions.getWithRevenue()` (embedded)
 *
 * `marginPercent` is `null` when revenue === 0 (rendered as "-"), never
 * 0%, never NaN%, never Infinity%. Per canon M1.
 */
export interface RevenueMetrics {
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: number | null;

  usageRevenue: number;
  recurringRevenue: number;
  seatRevenue: number;
  onetimeRevenue: number;

  eventCount: number;
  /** Events with usageCost IS NULL. Counted in eventCount, excluded from cost. Per C1. */
  eventCountWithNullCost: number;

  bySubscription: SubscriptionRevenue[];
  byStrategy: StrategyRevenue[];
}

/**
 * Invoice-totals for a window. Realized (invoice-materialized) amounts, not
 * the revenue formula. Per I1, non-draft invoices reconcile to
 * RevenueMetrics by construction. So billed/collected/outstanding are
 * consumable directly without re-deriving from events.
 */
export interface InvoiceTotals {
  /** I2: SUM(totalAmount) WHERE status IN ('issued','overdue') AND invoiceDate ∈ window. */
  billed: number;
  /** Cash collected: SUM(payment amount − refunded amount) WHERE paymentDate ∈ window. */
  collected: number;
  /** I2: SUM(totalAmount) WHERE status = 'draft' AND invoiceDate ∈ window. Inventory only. */
  draft: number;
  /** Open accounts receivable right now: SUM(totalAmount) WHERE status IN ('issued','overdue'). No date window. */
  outstanding: number;
  /** Current-state (no date filter). SUM(totalAmount) WHERE status = 'overdue'. */
  overdueAmount: number;
  overdueCount: number;
  /** COUNT WHERE status IN ('issued','paid','overdue') AND invoiceDate ∈ window. */
  invoicesSentCount: number;
}

/**
 * MRR per canon MRR1: contracted monthly recurring revenue of active
 * subscriptions, today. ARR = MRR × 12.
 */
export interface Mrr {
  mrr: number;
  arr: number;
}

/** Per-subscription breakdown for run-rate MRR (MRR2). */
export interface RunRateMrrBreakdownRow {
  subscriptionId: string;
  customerId: string;
  agentId: string;
  planId: string;
  /** Recurring fees monthly-normalized (divide by 12 if sub is yearly). */
  recurring: number;
  /** Seat fees: max(seatsCount, minCommit) × rate, monthly-normalized. */
  seatBased: number;
  /** Usage: actual last-30-days events through calcRouted(strategy, qty). */
  usage: number;
  /** Sum of the three. This sub's run-rate MRR contribution. */
  total: number;
}

/** Run-Rate MRR (MRR2). "trajectory if current 30-day pace continues". */
export interface RunRateMrrResult {
  mrr: number;
  breakdown: RunRateMrrBreakdownRow[];
}

/** Per-subscription breakdown for committed MRR (MRR3). Shape matches RunRate. */
export interface CommittedMrrBreakdownRow {
  subscriptionId: string;
  customerId: string;
  agentId: string;
  planId: string;
  recurring: number;
  seatBased: number;
  /** Usage floor: calcRouted(strategy, minimumCommitment). 0 when no min. */
  usage: number;
  total: number;
}

/** Committed MRR (MRR3). "contractual floor regardless of usage". */
export interface CommittedMrrResult {
  mrr: number;
  breakdown: CommittedMrrBreakdownRow[];
}

/** Per-agent cost breakdown row. */
export interface CostByAgentRow {
  agentId: string;
  cost: number;
  eventCount: number;
}

/** Per-customer cost breakdown row. */
export interface CostByCustomerRow {
  customerId: string;
  cost: number;
  eventCount: number;
}

/** Per-signal cost breakdown row. `signalId` is null for orphan events. */
export interface CostBySignalRow {
  signalId: string | null;
  cost: number;
  eventCount: number;
}

/**
 * Daily cost bucket. One row per UTC day with activity.
 * `date` is ISO string on the wire (JSON doesn't carry Date); convert at
 * the consumer if you need a Date object.
 */
export interface CostByDayRow {
  date: string;
  cost: number;
  eventCount: number;
}

/** Per-plan cost breakdown row. `planId: null` captures orphan events. */
export interface CostByPlanRow {
  planId: string | null;
  cost: number;
  eventCount: number;
}

/** Per-LLM-model cost breakdown row. `model: null` covers non-LLM + missing-model events. */
export interface CostByModelRow {
  model: string | null;
  cost: number;
  eventCount: number;
}

/**
 * Canonical cost shape. Returned by `client.analytics.costBreakdown()`.
 *
 * `prior` is populated only when the caller sets `includePriorWindow: true`
 *An optional period-over-period trend block with the same shape (minus
 * `prior` itself).
 */
export interface CostMetrics {
  /** SUM(usageCost) for the window. Null contributions count as 0. */
  cost: number;
  /** All events in window, including those with NULL usageCost. */
  eventCount: number;
  /** Events with usageCost IS NULL. "needs attention" indicator. Per C1. */
  eventCountWithNullCost: number;
  byAgent: CostByAgentRow[];
  byCustomer: CostByCustomerRow[];
  bySignal: CostBySignalRow[];
  byDay: CostByDayRow[];
  byPlan: CostByPlanRow[];
  byModel: CostByModelRow[];
  /** Populated only when `includePriorWindow` was true on the request. */
  prior?: Omit<CostMetrics, "prior">;
}

/** Per-strategy breakdown for Agent-Earned. One row per usage strategy in the window. */
export interface AgentEarnedStrategyRow {
  strategyId: string;
  pricingModel: PricingModel | null;
  signalId: string | null;
  /** Events × rate routed through pricingModel (flat/graduated/volume/credit_pool). */
  revenue: number;
  /** SUM(signal_events.quantity) for this strategy's signal in the window. */
  quantity: number;
}

/** Per-subscription breakdown for Agent-Earned. Activity revenue per sub. */
export interface AgentEarnedSubscriptionRow {
  subscriptionId: string;
  customerId: string;
  agentId: string;
  planId: string;
  revenue: number;
  eventCount: number;
}

/**
 * Agent-Earned (canon R1 pure). Events × pricing-strategy rate only. No
 * recurring, no seat, no prorations, no onetime. This is the leading
 * indicator at the top of the Earned → Billed → Collected funnel.
 */
export interface AgentEarned {
  /** Total activity-only revenue for the window. */
  revenue: number;
  /** Events that produced revenue (usage events attributable to a usage strategy). */
  eventCount: number;
  bySubscription: AgentEarnedSubscriptionRow[];
  byStrategy: AgentEarnedStrategyRow[];
}

// ---- Parameter shapes for canonical analytics methods -----------------

/** Parameters for `client.analytics.revenue()`. */
export interface RevenueMetricsParams {
  /** Start date (ISO format, required). */
  startDate: string;
  /** End date (ISO format, required). */
  endDate: string;
  /** Filter by customer ID. Narrowing by ANY entity triggers canonical shape. */
  customerId?: string;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by signal ID. */
  signalId?: string;
  /** Filter by subscription ID. */
  subscriptionId?: string;
}

/** Parameters for `client.analytics.costBreakdown()`. */
export interface CostMetricsParams {
  /** Start date (ISO format, required). */
  startDate: string;
  /** End date (ISO format, required). */
  endDate: string;
  /** Filter by customer ID. */
  customerId?: string;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by signal ID. */
  signalId?: string;
  /** Filter by subscription ID. */
  subscriptionId?: string;
  /** When true, adds `prior` field with symmetric-span trend data (one extra DB query). */
  includePriorWindow?: boolean;
}

/** Parameters for `client.analytics.invoiceTotals()`. */
export interface InvoiceTotalsParams {
  /** Start date (ISO format, required). */
  startDate: string;
  /** End date (ISO format, required). */
  endDate: string;
  /** Optional customer scope. The single place per-customer billed/collected math runs. */
  customerId?: string;
}

/** Parameters for `client.analytics.mrr()`, `runRateMrr()`, `committedMrr()`. */
export interface MrrParams {
  /** Filter by customer ID. */
  customerId?: string;
  /** Filter by subscription ID. */
  subscriptionId?: string;
}

/** Parameters for `client.analytics.agentEarned()`. */
export interface AgentEarnedParams {
  /** Start date (ISO format, required). */
  startDate: string;
  /** End date (ISO format, required). */
  endDate: string;
  customerId?: string;
  agentId?: string;
  signalId?: string;
  subscriptionId?: string;
}

/**
 * Response shape for `client.subscriptions.getWithRevenue()`. Wraps the
 * regular SubscriptionDetail with canonical revenue metrics for the window.
 */
export interface SubscriptionDetailWithRevenue {
  subscription: SubscriptionDetail;
  revenue: RevenueMetrics;
}

/**
 * Response shape for `client.customers.getWithRevenue()`. Wraps the
 * regular Customer with canonical revenue metrics for the window.
 */
export interface CustomerDetailWithRevenue {
  customer: Customer;
  revenue: RevenueMetrics;
}

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscriptionStatus =
  | "upcoming"
  | "active"
  | "ended"
  | "canceled"
  | "expired"
  | "pending";

export interface SubscriptionCustomer {
  id: string;
  name: string;
  email: string | null;
  externalId: string | null;
  phone?: string | null;
}

export interface SubscriptionAgent {
  id: string;
  name: string;
  agentCode: string;
  description?: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string;
  features?: string[];
}

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string | null;
  billingCycle: string;
  customer: SubscriptionCustomer;
  agent: SubscriptionAgent;
  plan: SubscriptionPlan;
  createdAt: string;
}

export interface SubscriptionUsage {
  totalQuantity: number;
  totalEvents: number;
  periodStart: string;
  periodEnd: string;
}

export interface SubscriptionDetail extends Subscription {
  timezone: string;
  usage: SubscriptionUsage;
  updatedAt: string;
}

export interface ListSubscriptionsParams {
  /** Filter by customer ID */
  customerId?: string;
  /** Filter by customer external ID */
  customerExternalId?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by subscription status */
  status?: SubscriptionStatus;
  /** Page number (default: 1) */
  page?: number;
  /** Results per page (default: 20) */
  limit?: number;
}

export interface ListSubscriptionsResponse {
  subscriptions: Subscription[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

// ============================================================================
// Portal Session Types
// ============================================================================

/**
 * Available features in a portal session
 */
export type PortalFeature = "invoices" | "subscriptions" | "usage" | "profile";

/**
 * Parameters for creating a portal session
 * Requires a secret key (mf_sk_*)
 */
export interface CreatePortalSessionParams {
  /** Customer ID (internal MarginFront ID) */
  customerId?: string;
  /** Customer external ID (your system's ID) */
  customerExternalId?: string;
  /** URL to redirect customer after portal session */
  returnUrl?: string;
  /** Features to enable in the portal (default: all) */
  features?: PortalFeature[];
}

/**
 * Portal session response (single-use magic link).
 *
 * `token` and `url` are only surfaced once — at creation. List/get responses
 * return ListedPortalSession instead, which intentionally OMITS these fields.
 */
export interface PortalSession {
  /** Portal session ID */
  id: string;
  /** Object type identifier */
  object: "portal_session";
  /** Full URL for the customer portal (single-use; mgl_ prefix on token) */
  url: string;
  /** Portal session token (mgl_*) */
  token: string;
  /** Customer ID */
  customerId: string;
  /** Customer name (omitted when null) */
  customerName?: string;
  /** Customer email (omitted when null) */
  customerEmail?: string;
  /** Session expiration time (ISO 8601 string on the wire) */
  expiresAt: string;
  /** Enabled features (informational; the single-page portal renders all) */
  features: PortalFeature[];
  /** Return URL after session (omitted when null) */
  returnUrl?: string;
  /** Session creation time */
  createdAt: string;
}

/**
 * Listed portal session — used by list() and get() responses.
 *
 * Token is intentionally omitted for security. URL is omitted because once a
 * single-use link is created and either redeemed or expired, sharing the URL
 * is meaningless.
 */
export interface ListedPortalSession {
  /** Portal session ID */
  id: string;
  /** Object type identifier */
  object: "portal_session";
  /** Customer ID */
  customerId: string;
  /** Customer name (omitted when null) */
  customerName?: string;
  /** Customer email (omitted when null) */
  customerEmail?: string;
  /** Session expiration time (ISO 8601 string on the wire) */
  expiresAt: string;
  /** Whether the magic link has expired */
  isExpired: boolean;
  /** Whether the magic link has been redeemed */
  isUsed: boolean;
  /** When it was redeemed (omitted when not yet used) */
  usedAt?: string;
  /** Session creation time */
  createdAt: string;
  /** Enabled features */
  features: PortalFeature[];
}

/**
 * List portal sessions parameters
 */
export interface ListPortalSessionsParams {
  /** Filter by customer ID */
  customerId?: string;
  /** Maximum number of sessions to return */
  limit?: number;
  /** Include expired sessions */
  includeExpired?: boolean;
}

/**
 * List portal sessions response (flat array — no envelope).
 */
export type ListPortalSessionsResponse = ListedPortalSession[];

// ============================================================================
// Pricing Plan Types
// ============================================================================

/** How the strategy charges: per-usage-event, fixed recurring, one-time setup, or per-seat. Mirrors Prisma enum `enum_pricing_strategies_chargeType`. */
export type ChargeType = "usage" | "recurring" | "onetime" | "seat_based";

/** How the rate math works for a given strategy */
export type PricingModel = "flat" | "graduated" | "volume" | "credit_pool";

/** How often the strategy bills. The database accepts only monthly and yearly. */
export type BillingFrequency = "monthly" | "yearly" | "quarterly" | "weekly";

/** A single tier in a tiered pricing strategy */
export interface PricingTier {
  /** Lower bound of this tier (inclusive for display, 0 for first tier) */
  lower: number;
  /** Upper bound of this tier (null = unbounded / infinity) */
  upper: number | null;
  /** Rate for this tier. Per-unit for graduated/volume, flat fee for credit_pool pool tier */
  rate: number;
}

/** An agent linked to a pricing plan */
export interface LinkedAgent {
  id: string;
  name: string;
  agentCode: string;
}

/** A pricing strategy (the actual pricing rules inside a plan) */
export interface PricingStrategy {
  id: string;
  name: string;
  agentId: string;
  signalId: string | null;
  chargeType: ChargeType;
  pricingModel: PricingModel | null;
  billingFrequency: BillingFrequency | null;
  tiers: PricingTier[] | null;
  /**
   * The three-number view of a credit pool's tiers, derived server-side.
   * null on every non-pool strategy, and on any pool whose stored tiers
   * aren't a clean two-tier shape — read `tiers` directly in that case.
   */
  creditPool: CreditPoolInput | null;
  /**
   * The pool's member metrics and their burn rates, `{signalId: creditsPerUnit}`.
   * Null or absent on a single-metric pool and on every non-pool strategy.
   */
  creditRates?: Record<string, number> | null;
  rate: string | null;
  tags: string[];
  active: boolean;
  minimumCommitment: number | null;
  signal?: {
    id: string;
    name: string;
    shortName: string | null;
    type?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/** A pricing plan (container for strategies, linked to agents) */
export interface PricingPlan {
  id: string;
  name: string;
  description: string | null;
  featuresList: Record<string, unknown> | null;
  isActive: boolean;
  agents: LinkedAgent[];
  pricingStrategies?: PricingStrategy[];
  createdAt: string;
  updatedAt: string;
}

/** Parameters for creating a pricing plan */
export interface CreatePricingPlanData {
  name: string;
  description?: string;
  featuresList?: Record<string, unknown>;
  agentId?: string;
  isActive?: boolean;
}

/** Parameters for updating a pricing plan */
export interface UpdatePricingPlanData {
  name?: string;
  description?: string;
  featuresList?: Record<string, unknown>;
  isActive?: boolean;
}

/** Query parameters for listing pricing plans */
export interface PricingPlanListParams {
  name?: string;
  agentId?: string;
  isActive?: boolean;
  includeStrategies?: boolean;
  sortBy?: "name" | "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

/** Paginated response for listing pricing plans */
export interface PricingPlanListResponse {
  results: PricingPlan[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

/** Parameters for copying a pricing plan (with optional discount) */
export interface CopyPricingPlanData {
  newName: string;
  newDescription?: string;
  /** Percentage discount applied to all rates (0-100) */
  discount?: number;
  /** Convert monthly billing to yearly */
  requestedYearly?: boolean;
}

// ============================================================================
// Pricing Strategy Types
// ============================================================================

/**
 * The credit-pool shortcut: the three numbers a human actually thinks in.
 * Send this instead of hand-building `tiers` and the server compiles the
 * canonical shape for you.
 *
 * Worth knowing: in the raw `tiers` array a credit pool's FIRST tier rate is a
 * flat fee for the whole pool while the second is per-unit. That asymmetry is
 * easy to get backwards, which is why this exists.
 */
export interface CreditPoolInput {
  /** How many units the pool covers each billing cycle. */
  poolSize: number;
  /** Flat fee charged every cycle for the pool, whether or not it gets used. */
  poolPrice: number;
  /** Per-unit price for usage beyond the pool. Nothing stops at empty. */
  overageRate: number;
}

/** Parameters for creating a pricing strategy */
export interface CreatePricingStrategyData {
  name: string;
  agentId: string;
  chargeType: ChargeType;
  signalId?: string;
  tags?: string[];
  pricingModel?: PricingModel;
  billingFrequency?: BillingFrequency;
  tiers?: PricingTier[];
  /** Credit-pool shortcut, compiled into `tiers` server-side. Wins over `tiers`. */
  creditPool?: CreditPoolInput;
  /**
   * Which metrics burn this pool's credits, and how many credits one unit of
   * each burns: `{signalId: creditsPerUnit}`. The pool's own signal is always a
   * member, at rate 1 unless you name it. Every value must be above zero; to
   * make a metric free, leave it out. Only valid when `pricingModel` is
   * `credit_pool`. Omit for a single-metric pool.
   */
  creditRates?: Record<string, number>;
  rate?: number;
  active?: boolean;
  minimumCommitment?: number;
}

/** Parameters for updating a pricing strategy */
export interface UpdatePricingStrategyData {
  name?: string;
  agentId?: string;
  signalId?: string;
  chargeType?: ChargeType;
  pricingModel?: PricingModel;
  billingFrequency?: BillingFrequency;
  tiers?: PricingTier[];
  /** Credit-pool shortcut, compiled into `tiers` server-side. Wins over `tiers`. */
  creditPool?: CreditPoolInput;
  /**
   * Burn rates for the pool's member metrics: `{signalId: creditsPerUnit}`.
   * Send `{}` to clear every rate; omitting the field leaves the stored rates
   * alone. See `CreatePricingStrategyData.creditRates`.
   */
  creditRates?: Record<string, number>;
  rate?: number;
  tags?: string[];
  active?: boolean;
  minimumCommitment?: number;
}

/** Query parameters for listing pricing strategies */
export interface PricingStrategyListParams {
  name?: string;
  chargeType?: ChargeType;
  pricingModel?: PricingModel;
  active?: boolean;
  sortBy?: "name" | "chargeType" | "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

/** Paginated response for listing pricing strategies */
export interface PricingStrategyListResponse {
  results: PricingStrategy[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

/** Parameters for bulk update + create in one call */
export interface BulkUpdatePricingStrategiesData {
  strategies: {
    new?: CreatePricingStrategyData[];
    update?: (UpdatePricingStrategyData & { id: string })[];
  };
}

/**
 * Response shape for `client.pricingPlans.linkAgent()`. The API returns a
 * simple success message after creating the junction row. No envelope
 * object or created record, just confirmation.
 */
export interface LinkAgentResponse {
  message: string;
}

/**
 * Response shape for `client.pricingStrategies.bulkUpdate()`. Wraps the
 * partial result (created + updated counts plus the actual strategy
 * records) with a message + top-level count summary for convenience.
 */
export interface BulkUpdatePricingStrategiesResponse {
  message: string;
  updated: number;
  created: number;
  result: {
    created: { count: number; strategies: PricingStrategy[] };
    updated: { count: number; strategies: PricingStrategy[] };
  };
}

// ============================================================================
// Service Catalog Types
// ============================================================================

/**
 * One entry from the global service_pricing catalog. Returned by
 * `client.services.list()` and `client.services.get()`. Customers use this to
 * discover canonical model + modelProvider names BEFORE firing usage events,
 * avoiding NEEDS_COST_BACKFILL on first hit.
 */
export interface ServiceCatalogEntry {
  /** UUID of the catalog entry. */
  id: string;
  /** Source-specific identifier (e.g. "litellm/gpt-4o", "tool/websearch"). */
  externalId: string;
  /** The lowercase canonical name to send as `model` in `usage.record(...)`. */
  canonicalName: string;
  /** Human-readable display name. */
  displayName: string;
  /** Lowercase provider name to send as `modelProvider` (e.g. "openai", "google", "tool"). */
  provider: string;
  /** Category label (e.g. "LLM", "Embeddings", "Web Search", "Agent Built-in"). */
  serviceType: string;
  /**
   * Cost per unit on the input side (LLM input tokens, or per-call rate for
   * non-LLM services). Returned as a string-formatted decimal so JS Number
   * precision can't truncate fractional cents. Null when the service does not
   * publish an input-side rate.
   */
  inputCost: string | null;
  /** Cost per unit on the output side (LLM output tokens). Null for non-LLM services. */
  outputCost: string | null;
  /** Unit the rates are denominated in (e.g. "1M tokens", "1K requests", "1K vCPU-seconds"). */
  costUnit: string;
  /** LLM context window size in tokens. Null for non-LLM services. */
  contextWindow: number | null;
  /** Where the price came from: "openrouter", "litellm", or "builtin". */
  source: string;
  /** True for entries that are not LLMs (agent tools, for example). */
  isApi: boolean;
  /** False if the entry has been deactivated. The list endpoint filters these out by default. */
  isActive: boolean;
}

/**
 * Optional filters for `client.services.list(...)`.
 */
export interface ListServicesParams {
  /** Filter by lowercase provider (e.g. "google", "openai"). */
  provider?: string;
  /** Filter by serviceType (e.g. "LLM", "Embeddings", "Web Search", "Agent Built-in"). */
  serviceType?: string;
  /** Filter by LLM (`false`) vs non-LLM API (`true`). Omit for both. */
  isApi?: boolean;
  /** Case-insensitive search across canonicalName and displayName. */
  search?: string;
  /** 1-based page number. */
  page?: number;
  /** Page size, 1-100. Defaults to 50. */
  limit?: number;
}

/**
 * Paginated response from `client.services.list(...)`.
 */
export interface ListServicesResponse {
  data: ServiceCatalogEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================================================
// Spend controls (Code Cost Clarity)
// ============================================================================
// Programmatic read + write for internal code-spend caps: the same policies,
// spend-vs-cap, and coverage the dashboard shows. Writes hit the SAME role-gated
// api-nest endpoints as the dashboard (owner/finance only) — no side door.

/** Who a cap governs. */
export type SpendCapScope = "org" | "team" | "dev";

/** A cap's reset cadence. Windows roll at UTC. */
export type SpendCapPeriod = "day" | "week" | "month";

/** 'track' watches and alerts (blocks nothing); 'enforce' hard-stops device-side. */
export type SpendCapMode = "track" | "enforce";

/** A stored spend cap, as the API returns it. amountUsd is an honest number. */
export interface SpendCap {
  id: string;
  scope: SpendCapScope;
  /** The scope's target: a teammate's customerExternalId/email (dev), a team
   * label (team), or null for an org ceiling. */
  scopeValue: string | null;
  /** 'all', or a single provider matching the modelProvider string ingest stores
   * (e.g. 'anthropic', 'openai', 'google'). */
  providerScope: string;
  amountUsd: number;
  period: SpendCapPeriod;
  mode: SpendCapMode;
  coolOffHours: number | null;
  /** The alert ladder: whole percents of the cap at which a heads-up fires. */
  alertThresholds: number[];
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The cap as one plain sentence, e.g. "Stop Claude spend at $200 for
   * alice@acme.example per week". Built server-side; never re-derive it client-side. */
  sentence: string;
}

export interface CreateSpendCapParams {
  /** The org ceiling or one teammate. Team caps can't be created. */
  scope: "org" | "dev";
  /** Required for dev caps; omit for an org ceiling. */
  scopeValue?: string;
  /** Caps cover all AI tools; omit or pass 'all'. */
  providerScope?: "all";
  amountUsd: number;
  period: SpendCapPeriod;
  mode: SpendCapMode;
  coolOffHours?: number;
  alertThresholds?: number[];
}

/** A cap's identity (scope/target/provider) is immutable; only these knobs change. */
export interface UpdateSpendCapParams {
  amountUsd?: number;
  period?: SpendCapPeriod;
  mode?: SpendCapMode;
  coolOffHours?: number;
  alertThresholds?: number[];
}

/** One scope's spend for the period. spentUsd is null when there is no priced
 * usage to report — honest absence, never a coerced 0. */
export interface SpendScopeTotal {
  customerExternalId?: string;
  spentUsd: number | null;
  eventCount: number;
  unpricedEventCount: number;
}

/** The spend read-back for a period. `dev` is present only when a
 * customerExternalId was supplied. */
export interface SpendReadback {
  period: SpendCapPeriod;
  window: { start: string; end: string };
  asOf: string;
  org: SpendScopeTotal;
  dev: SpendScopeTotal | null;
}

/** One tool's cap-check coverage over the trailing 7 days. Three answers, not
 * two: `unknown` is a teammate we could not vouch for, and it's NEVER
 * counted as armed. armed + notArmed + unknown === total. */
export interface ToolCoverage {
  /** Teammates whose every machine we saw for this tool had the cap check running. */
  armed: number;
  /** Teammates with at least one machine we PROVED was not running it. */
  notArmed: number;
  /** Teammates we could not vouch for: a meter build that doesn't report for this
   * tool, a check that did not answer, or no coding-turn record to read a verdict off. */
  unknown: number;
  /** Distinct teammates who used this tool in the window. */
  total: number;
}

/** Cap-check coverage over the trailing 7 days, PER TOOL. asOf is null when there
 * is no recent activity, never a fabricated time.
 *
 * Read `claudeCode` and `codex`, not the top-level pair. Claude Code and Codex are
 * armed by different mechanisms, so a blended number can report Codex as covered
 * when nothing about Codex was checked. */
export interface SpendCoverage {
  /** Blended count across both tools. In practice it reflects Claude Code only,
   * because the stamp it counts lands on Claude Code records alone. Use
   * `claudeCode` and `codex` instead. */
  armed: number;
  /** Blended denominator: distinct teammates with any internal
   * coding-agent event in the window, across BOTH tools. NOT the sum of
   * claudeCode.total and codex.total (someone using both is counted in each). */
  total: number;
  asOf: string | null;
  /** Absent when the server doesn't report per-tool coverage. Optional on
   * purpose: a required field the server never sends is `undefined` at runtime
   * with no type error, which turns a version mismatch into a crash downstream. */
  claudeCode?: ToolCoverage;
  /** Absent when the server doesn't report per-tool coverage. */
  codex?: ToolCoverage;
}

/** Confirmation of a deleted cap, echoing its plain sentence so the caller sees
 * exactly what was removed. */
export interface DeleteSpendCapResponse {
  deleted: boolean;
  sentence: string;
}

/** The two breakdown grains the platform can honestly serve. There is
 * deliberately NO 'pr': the pipeline records repo/branch/commit on each event,
 * not pull-request numbers, and branch is the closest honest stand-in. */
export type SpendBreakdownDimension = "repo" | "branch";

/** One bucket of internal AI spend. spentUsd is null when none of the
 * bucket's events are priced (honest absence, never a coerced 0). */
export interface SpendBreakdownBucket {
  spentUsd: number | null;
  eventCount: number;
  unpricedEventCount: number;
}

/** One row of the breakdown: a repo (dimension 'repo') or a repo#branch pair
 * (dimension 'branch'), with that bucket's spend. */
export interface SpendBreakdownRow extends SpendBreakdownBucket {
  key: string;
}

/** Internal AI spend for the current period, grouped by repo or branch.
 * `noMetadata` holds events recorded with no repo/branch at all, and
 * `coveragePercent` (null when there are no events) says how much of the
 * activity carries the repo/branch key. */
export interface SpendBreakdownResponse {
  dimension: SpendBreakdownDimension;
  period: SpendCapPeriod;
  window: { start: string; end: string };
  asOf: string;
  totals: SpendBreakdownBucket;
  rows: SpendBreakdownRow[];
  noMetadata: SpendBreakdownBucket;
  coveragePercent: number | null;
}

// ============================================================================
// Credit Pool Balances
// ============================================================================

/**
 * One credit-pool subscription's countdown.
 *
 * Two of these numbers are deliberately different and both are true:
 * `remainingUnits` counts manual top-ups, `overageInProgressUnits` is the
 * invoice's own math (usage past the pool size, top-up blind). A topped-up
 * pool can show units left AND overage at the same time; the invoice always
 * matches `overageInProgressUnits`.
 *
 * Nothing stops at zero. The pool is a meter, not a breaker: once
 * `remainingUnits` reaches zero, calls keep working and the overage keeps
 * billing.
 */
export interface CreditBalance {
  subscriptionId: string;
  subscriptionName: string;
  customerId: string;
  customerName: string | null;
  customerExternalId: string | null;
  agentId: string;
  planId: string;
  planName: string | null;
  /** The pool the plan sells, in usage units. */
  poolSizeUnits: number;
  /** Units drawn inside the current period. Top-up blind. */
  consumedUnits: number;
  /** Units left to draw, top-ups included. Negative once the pool is overdrawn. */
  remainingUnits: number;
  /** Units already billing as overage this period. Top-up blind. */
  overageInProgressUnits: number;
  /** `remainingUnits` as a percent of `poolSizeUnits`. Negative once overdrawn. */
  remainingPercent: number;
  /** Per-unit overage price, or null when the plan's tiers can't say. */
  overageRatePerUnit: number | null;
  /** Null when the subscription has no billing period yet — honest absence. */
  periodStart: string | null;
  periodEnd: string | null;
  /** True while this subscription's credit-pool emails are silenced. */
  alertsPaused: boolean;
  /** True when the subscription has no billing period yet. */
  noActivePeriod: boolean;
  /**
   * True when the period is active but its grant hasn't been minted yet. The
   * pool reads FULL, because an unminted grant is an untouched pool, not a
   * drained one.
   */
  implicitFullPool: boolean;
}

export interface CreditBalanceListParams {
  /** Only pools belonging to this customer. */
  customerId?: string;
  /** Only pools on subscriptions for this agent. */
  agentId?: string;
  /**
   * Only pools with this percent of the pool (or less) still left. 20 is the
   * near-empty cut the dashboard uses; 0 narrows it to pools at or past zero.
   */
  belowPercent?: number;
}

export interface CreditBalanceListResponse {
  balances: CreditBalance[];
  asOf: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface ApiErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
}
