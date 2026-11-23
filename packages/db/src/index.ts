export { db, connectDb, disconnectDb } from "./client";

// The ONE source for every $-valued dashboard surface. Rules: packages/db/CANON.md.
export {
  getRevenueMetrics,
  getInvoiceTotals,
  getMrr,
  getRunRateMrr,
  getCommittedMrr,
  getAgentEarned,
  getCostMetrics,
  // Seed + invoice generator import these directly, so tier math has one home (canon R3).
  calcCreditPool,
  calcCreditPoolWithBreakdown,
  calcFlat,
  calcGraduated,
  calcGraduatedWithBreakdown,
  calcVolume,
  calcVolumeWithBreakdown,
  calcRouted,
  calcUsageCharge,
  calcUsageRevenue,
  calcRecurringRevenue,
  calcSeatRevenue,
  calcOnetimeRevenue,
  calcProrationFactor,
  applyMinCommitment,
  creditPoolFee,
  toNumber,
  safeMarginPercent,
} from "./lib/revenue-metrics";
export type {
  CalcStrategy,
  CalcTier,
  TierBreakdownRow,
} from "./lib/revenue-metrics";

// canon M2 + I4. These return null when undefined, never 0 or NaN (canon M1 family).
export {
  growthPercent,
  shareOfTotal,
  avgPer,
  costPerTask,
  invoiceAgingBuckets,
  rollupEventCosts,
} from "./lib/canon-math";
export type {
  AgingInvoice,
  AgingBucket,
  InvoiceAgingBuckets,
  EventCostRollup,
} from "./lib/canon-math";

// Action files MUST type their returns with these (ESLint no-restricted-syntax).
export {
  ChargeTypeSchema,
  PricingModelSchema,
  RevenueMetricsSchema,
  SubscriptionRevenueSchema,
  StrategyRevenueSchema,
  InvoiceTotalsSchema,
  MrrSchema,
  MrrFiltersSchema,
  RunRateMrrResultSchema,
  RunRateMrrBreakdownRowSchema,
  CommittedMrrResultSchema,
  CommittedMrrBreakdownRowSchema,
  RevenueWindowSchema,
  RevenueFiltersSchema,
  AgentEarnedSchema,
  AgentEarnedStrategyRowSchema,
  AgentEarnedSubscriptionRowSchema,
  CostMetricsSchema,
  CostByAgentRowSchema,
  CostByCustomerRowSchema,
  CostBySignalRowSchema,
  CostByDayRowSchema,
  CostByRepoRowSchema,
  CostByBranchRowSchema,
} from "./schemas/revenue-metrics";
export type {
  ChargeType,
  PricingModel,
  RevenueMetrics,
  SubscriptionRevenue,
  StrategyRevenue,
  InvoiceTotals,
  Mrr,
  MrrFilters,
  RunRateMrrResult,
  RunRateMrrBreakdownRow,
  CommittedMrrResult,
  CommittedMrrBreakdownRow,
  RevenueWindow,
  RevenueFilters,
  AgentEarned,
  AgentEarnedStrategyRow,
  AgentEarnedSubscriptionRow,
  CostMetrics,
  CostByAgentRow,
  CostByCustomerRow,
  CostBySignalRow,
  CostByDayRow,
  CostByRepoRow,
  CostByBranchRow,
} from "./schemas/revenue-metrics";

// The SQL twin of getCostMetrics: same numbers, grouped in
// Postgres instead of transferring every event row. Both must agree.
export {
  getCostBreakdown,
  getMatterCostRollups,
  COST_BREAKDOWN_DEFAULT_PAGE_SIZE,
  ANALYTICS_MAX_ROWS,
} from "./lib/cost-grouping";
export type {
  CostBreakdownOptions,
  FinishedWorkScope,
  MatterCostRollupFilters,
  MatterCostRollupClient,
} from "./lib/cost-grouping";
export {
  DimensionSchema,
  BreakdownRowSchema,
  CostBreakdownTotalsSchema,
  CostBreakdownOtherSchema,
  CostBreakdownSchema,
  CostBreakdownFinishedWorkSchema,
  FinishedThingRowSchema,
  FinishedWorkBucketRowSchema,
  NamedUsageRowSchema,
  MatterCostRollupSchema,
} from "./schemas/cost-grouping";
export type {
  Dimension,
  BreakdownRow,
  CostBreakdownTotals,
  CostBreakdownOther,
  CostBreakdown,
  CostBreakdownFinishedWork,
  FinishedThingRow,
  FinishedWorkBucketRow,
  NamedUsageRow,
  MatterCostRollup,
} from "./schemas/cost-grouping";

// resolveEventPrice is the guarded entry point every path that WRITES a billable
// cost must use; calculateEventCost is the pure multiplier underneath it and
// cannot refuse a cache count against a NULL rate.
export {
  calculateEventCost,
  resolveEventPrice,
  isPriceRefused,
  unguardedCacheTokens,
  applyCacheWriteTtl,
  lookupModelInCatalog,
} from "./lib/model-pricing";
export type {
  CostEntry,
  EventCostResult,
  CatalogLookupResult,
  GuardedCacheTokenCount,
  PriceResolution,
  PriceResolved,
  PriceRefused,
  PriceRefusalKind,
  ResolveEventPriceArgs,
  UnpricedCacheRate,
} from "./lib/model-pricing";

// The canon rollup invariant: parent usageCost is null if ANY child is unresolved,
// otherwise the SUM; the parent only flips PROCESSED when all children are.
export {
  recomputeParentUsageCost,
  assertEventCostInvariant,
  worstStatus,
  STATUS_PRIORITY,
} from "./lib/signal-event-rollup";
export type { SignalEventStatus } from "./lib/signal-event-rollup";

// Which roles an actor may hand out. api-nest team endpoints and the dashboard team
// Server Actions both gate on these; they must not drift.
export {
  GRANTABLE_ROLES,
  canGrantRole,
  MANAGE_MONEY_ROLES,
  MANAGE_BUILD_ROLES,
  ORG_MANAGE_ROLES,
  // Who may touch the Law tab (matters, routing rules, the audit export):
  // owner/admin/finance/legal.
  LAW_MANAGE_ROLES,
  // Who may write a spend cap: owner/finance only. Deliberately NARROWER than
  // MANAGE_MONEY_ROLES: admin is excluded.
  CAP_MANAGE_ROLES,
  // MINT_KEY_ROLES gates the mint/revoke routes; mintableKeyRoles() is the separate
  // per-minter ceiling on which role a NEW key may carry.
  MINT_KEY_ROLES,
  mintableKeyRoles,
  // Privileged-read gates for the key-list, payout-status and
  // payment-provider/webhook-config GETs. api-nest guards the routes with
  // these and the dashboard renders its no-access state from the same sets,
  // so the two must not drift.
  PRIV_READ_KEYS,
  PRIV_READ_PAYOUT,
  PRIV_READ_WEBHOOK,
} from "./lib/org-roles";

// Org membership lives in THREE tables and only ba_member decides anything.
// Both apps write membership (api-nest's team API and the dashboard's own team
// Server Actions, which never call api-nest), so the projection writes and the
// last-owner lock live here once.
export {
  toUserOrganizationsRole,
  toLegacyTeamMembersRole,
  countOwnersForUpdate,
  writeMembershipProjections,
  setDefaultOrganization,
  syncMembershipProjectionRole,
  deleteMembershipProjections,
  deleteOrganizationMembershipProjections,
} from "./lib/membership";
export type {
  MembershipProjectionClient,
  MembershipOwnerLockClient,
  MembershipProjectionInput,
} from "./lib/membership";

// A second implementation of this hash silently breaks auth: write-time and
// verify-time must compute api_keys.apiKeyLookupHash identically.
export { hashApiKeyForLookup } from "./lib/api-key-hash";

// Key generation and the secret key-pair row, in one place so every mint path
// writes the same rows.
export {
  generateApiKey,
  mintedKeyPermissions,
  secretPairKeyCreateData,
  SECRET_PAIR_NAME_SUFFIX,
  SECRET_PAIR_DEFAULT_DESCRIPTION,
} from "./lib/api-key-mint";
export type {
  ApiKeyType,
  GeneratedApiKey,
  MintProvenance,
  MintedKeyPermissions,
  SecretPairKeyInput,
} from "./lib/api-key-mint";

// Revoking a secret key must end the org's live portal magic links + sessions in
// the same transaction. Both revoke doors — the dashboard actions and
// api-nest's revoke endpoint — call this one cascade so they cannot drift.
export { revokePortalAccessForOrg } from "./lib/portal-access-revocation";
export type {
  PortalAccessRevocationClient,
  PortalAccessRevoked,
} from "./lib/portal-access-revocation";

// api_keys.permissions → the role a key carries. Fails CLOSED to the 'ingest' floor
// on any malformed or unrecognized shape.
export { parseKeyRole } from "./lib/parse-key-role";
export type { KeyRole } from "./lib/parse-key-role";

// The unbreakable-ceiling rule and the UTC reset-window math,
// dependency-free so every caller shares one implementation.
export {
  CAP_SCOPES,
  CAP_PERIODS,
  CAP_MODES,
  CAP_PROVIDER_SCOPE_ALL,
  isCapScope,
  isCapPeriod,
  isCapMode,
  checkCapWithinCeiling,
  resolveApplicableCeiling,
  currentPeriodWindow,
  CCC_AGENT_CODES,
  cccInternalEventFilter,
} from "./lib/cap-policy";
export type {
  CapScope,
  CapPeriod,
  CapMode,
  OrgCeiling,
  CapCeilingCheckInput,
  CapCeilingCheckResult,
} from "./lib/cap-policy";

// Customer Watch Alerts: the window + dedup rules for per-customer
// cost/revenue tripwires — dependency-free so the api-nest evaluator, the DTOs,
// and the MCP tool schemas all share one implementation.
export {
  CUSTOMER_ALERT_METRICS,
  CUSTOMER_ALERT_WINDOW_MODES,
  CUSTOMER_ALERT_ROLLING_DAYS,
  CUSTOMER_ALERT_MAX_PER_ORG,
  isCustomerAlertMetric,
  isCustomerAlertWindowMode,
  resolveCustomerAlertEvaluation,
  utcDayStart,
} from "./lib/customer-alert";
export type {
  CustomerAlertMetric,
  CustomerAlertWindowMode,
  CustomerAlertWindowConfig,
  CustomerAlertEvaluationPlan,
} from "./lib/customer-alert";

// Key derivation for the meter-stamped git coordinates (signal_events.metadata
// .repo/.branch). CostMetrics byRepo/byBranch and GET /control/spend/breakdown must
// bucket identically.
export { gitRepoKey, gitBranchKey, gitCommitSha } from "./lib/git-coordinates";

// "N of M developers armed". The per-event verdicts are exported so
// callers assert against the same function; CODEX_CONTROL_STAMP_VERSION rides along
// so nothing hardcodes a second '2' that can drift from it.
export {
  getSpendCoverage,
  claudeVerdictForEvent,
  codexVerdictForEvent,
  CODEX_CONTROL_STAMP_VERSION,
} from "./lib/spend-coverage";
export type { ToolArmedVerdict } from "./lib/spend-coverage";
export type {
  CoverageQueryClient,
  SpendCoverageCounts,
} from "./lib/spend-coverage";

// The plain-English cap wording api-nest write responses echo, so MCP and the SDK
// never re-derive it.
export {
  buildCapSentence,
  capProviderLabel,
  sentenceMoney,
  CAP_PROVIDER_LABELS,
} from "./lib/cap-sentence";
export type { CapSentenceParts } from "./lib/cap-sentence";

// The credit-pool ledger: grant idempotency, draw order, cache
// semantics. Track-only: never gates ingest, never touches invoice math.
export {
  mintPeriodGrant,
  consumeUnits,
  computeBalance,
  sweepExpiredGrants,
  findCreditPoolStrategy,
  memberRate,
  poolMemberRates,
  poolIsRated,
  poolSizeFromTiers,
} from "./lib/credit-ledger";
export type {
  CreditLedgerClient,
  CreditLedgerTxClient,
  CreditPoolSubscriptionRow,
  CreditPoolStrategyRow,
  MintPeriodGrantInput,
  MintPeriodGrantResult,
  ConsumeUnitsInput,
  ConsumeUnitsResult,
  ComputeBalanceInput,
  ComputeBalanceResult,
  SweepExpiredGrantsInput,
  SweepExpiredGrantsResult,
} from "./lib/credit-ledger";

// The credit-pool READ path. The two overage numbers are NOT
// interchangeable: remainingUnits is top-up aware, overageInProgressUnits is the
// invoice's own top-up-blind math.
export { getCreditBalances, getCreditBalance } from "./lib/credit-balance";
export type {
  CreditBalanceQueryClient,
  CreditBalanceFilters,
  CreditBalanceRow,
} from "./lib/credit-balance";

// The credit-pool shape rule: every one of the EIGHT lanes that can
// write pricing_strategies.tiers must validate through it. compileCreditPool turns
// the {poolSize, poolPrice, overageRate} sugar into the exact tiers calcCreditPool
// bills; deriveCreditPool is its read-side inverse.
export {
  validateCreditPoolTiers,
  validateCreditPoolInput,
  validateCreditRatesReferences,
  validateSinglePoolPerPlan,
  compileCreditPool,
  deriveCreditPool,
  creditPoolErrorMessage,
  isLivePoolStrategy,
  CREDIT_POOL_MODEL,
} from "./lib/credit-pool-tiers";
export type {
  CreditPoolSugar,
  CreditPoolTier,
  CreditPoolIssue,
  CreditPoolIssueCode,
  CreditPoolValidationInput,
  CreditPoolValidationResult,
  CreditRatesReferenceInput,
  PlanStrategyState,
} from "./lib/credit-pool-tiers";

// Coding-spend rollup by repo/branch and the (commit, teammate)
// drill behind one branch row.
export {
  computeSpendBreakdown,
  computeSpendBreakdownDrill,
} from "./lib/spend-breakdown";
export type {
  SpendBreakdownQueryClient,
  SpendBreakdownDimension,
  SpendBreakdownBucket,
  SpendBreakdownRow,
  SpendBreakdownQuery,
  SpendBreakdownResult,
  SpendBreakdownDrillQuery,
  SpendBreakdownDrillRow,
  SpendBreakdownDrillResult,
} from "./lib/spend-breakdown";

// Where a dollar amount becomes the integer a payment provider charges. The
// multiplier belongs to the CURRENCY, not to a constant: a flat `× 100` bills a JPY
// invoice 100x.
export {
  ZERO_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  WHOLE_UNIT_ONLY_CURRENCIES,
  currencyExponent,
  minorUnitStep,
  normalizeCurrency,
  toMinorUnits,
  fromMinorUnits,
  formatMinorUnits,
  unchargeableReason,
} from "./lib/money";

// Which of a line item's three money columns is the truth: `amount` is
// what the customer is billed. quantity × unitPrice cannot reproduce it for a
// blended price.
export { invoiceLineAmount, invoiceSubtotal } from "./lib/invoice-lines";
export type { InvoiceLineAmountInput } from "./lib/invoice-lines";

export * from "@prisma/client";
