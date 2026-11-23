/**
 * @marginfront/sdk
 *
 * Official Node.js SDK for MarginFront - usage-based billing, invoicing, and analytics
 *
 * @example
 * ```typescript
 * import { MarginFrontClient } from '@marginfront/sdk';
 *
 * const client = new MarginFrontClient('mf_sk_your_secret_key', {
 *   timeout: 10000,
 *   retries: 3,
 *   logging: { enabled: true, level: 'info' },
 *   telemetry: { enabled: true }
 * });
 *
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
 * // Manage customers
 * const customer = await client.customers.create({
 *   name: 'Acme Corp',
 *   externalId: 'acme_123'
 * });
 *
 * // Analytics
 * const analytics = await client.analytics.usage({
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31'
 * });
 *
 * const { invoices } = await client.invoices.list({ status: 'issued' });
 * const { subscriptions } = await client.subscriptions.list({ status: 'active' });
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Main Client
// ============================================================================

export {
  MarginFrontClient,
  parseApiKey,
  isSecretKey,
  isPublishableKey,
} from "./client";
export type { OrganizationInfo, ApiKeyType } from "./client";

// ============================================================================
// Update Awareness
// ============================================================================

export { checkForUpdate } from "./update";
export type { UpdateCheckResult } from "./update";

// ============================================================================
// Error Classes
// ============================================================================

export {
  MarginFrontError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ConflictError,
  NetworkError,
  TimeoutError,
  InternalError,
  InitializationError,
  ApiError,
  createErrorFromResponse,
  parseApiError,
  isAuthFailure,
} from "./errors";

// ============================================================================
// Types
// ============================================================================

export type {
  // Configuration
  MarginFrontConfig,
  ClientOptions,
  LogLevel,
  LogHandler,
  LoggingOptions,
  TelemetryHandler,
  TelemetryOptions,
  RequestMetrics,
  TelemetryStats,

  // API Verification
  Organization,
  VerifyResponse,
  WhoamiResponse,

  // Usage
  UsageRecord,
  TrackEventParams,
  TrackEventResponse,
  SingleEventResponse,
  BatchEventResponse,
  UsageRecordSuccess,
  UsageRecordFailure,
  UsageRecordResponse,

  // Customers
  CustomerStatus,
  CreateCustomerData,
  CustomerCreateParams,
  UpdateCustomerData,
  CustomerUpdateParams,
  CustomerSubscription,
  Customer,
  CustomerListParams,
  CustomerListResponse,

  // Invoices
  InvoiceStatus,
  InvoiceLineItem,
  InvoiceCustomer,
  Invoice,
  InvoiceDetail,
  ListInvoicesParams,
  ListInvoicesResponse,
  SendInvoiceParams,
  SendInvoiceResponse,

  // Analytics
  GroupBy,
  UsageAnalyticsParams,
  UsageAnalyticsSummary,
  UsageAnalyticsDataPoint,
  UsageAnalyticsResponse,

  // Canonical revenue / cost / MRR types.
  // One-and-only source of truth for every dollar-valued analytics shape
  // the SDK returns. Types mirror the canonical @marginfront/db schemas exactly
  // so end-to-end scenarios can assert shape at the SDK boundary.
  SubscriptionRevenue,
  StrategyRevenue,
  RevenueMetrics,
  InvoiceTotals,
  Mrr,
  RunRateMrrBreakdownRow,
  RunRateMrrResult,
  CommittedMrrBreakdownRow,
  CommittedMrrResult,
  CostByAgentRow,
  CostByCustomerRow,
  CostBySignalRow,
  CostByDayRow,
  CostByPlanRow,
  CostByModelRow,
  CostMetrics,
  AgentEarnedStrategyRow,
  AgentEarnedSubscriptionRow,
  AgentEarned,
  RevenueMetricsParams,
  CostMetricsParams,
  InvoiceTotalsParams,
  MrrParams,
  AgentEarnedParams,
  SubscriptionDetailWithRevenue,
  CustomerDetailWithRevenue,

  // Subscriptions
  SubscriptionStatus,
  SubscriptionCustomer,
  SubscriptionAgent,
  SubscriptionPlan,
  Subscription,
  SubscriptionUsage,
  SubscriptionDetail,
  ListSubscriptionsParams,
  ListSubscriptionsResponse,

  // Portal Sessions
  PortalFeature,
  CreatePortalSessionParams,
  PortalSession,
  ListPortalSessionsParams,
  ListPortalSessionsResponse,

  // Pricing Plans
  ChargeType,
  PricingModel,
  BillingFrequency,
  PricingTier,
  LinkedAgent,
  PricingStrategy,
  PricingPlan,
  CreatePricingPlanData,
  UpdatePricingPlanData,
  PricingPlanListParams,
  PricingPlanListResponse,
  CopyPricingPlanData,
  LinkAgentResponse,

  // Pricing Strategies
  CreditPoolInput,
  CreatePricingStrategyData,
  UpdatePricingStrategyData,
  PricingStrategyListParams,
  PricingStrategyListResponse,
  BulkUpdatePricingStrategiesData,
  BulkUpdatePricingStrategiesResponse,

  // Service Catalog
  ServiceCatalogEntry,
  ListServicesParams,
  ListServicesResponse,

  // Spend controls (Code Cost Clarity)
  SpendCapScope,
  SpendCapPeriod,
  SpendCapMode,
  SpendCap,
  CreateSpendCapParams,
  UpdateSpendCapParams,
  SpendScopeTotal,
  SpendReadback,
  SpendCoverage,
  // Per-tool coverage. Optional on SpendCoverage: a server may not send it.
  ToolCoverage,
  DeleteSpendCapResponse,

  // Spend controls: repo/branch breakdown
  SpendBreakdownDimension,
  SpendBreakdownBucket,
  SpendBreakdownRow,
  SpendBreakdownResponse,

  // Credit pool balances
  CreditBalance,
  CreditBalanceListParams,
  CreditBalanceListResponse,

  // Errors
  ApiErrorResponse,
} from "./types";
