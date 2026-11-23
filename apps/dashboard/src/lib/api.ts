// Re-export everything from api modules
import {
  Customer,
  CreateCustomerPayload,
  UpdateCustomerPayload,
  PaginatedResponse,
  CustomerQueryParams,
  customersApi,
} from '@/services/customers-service'
import {
  Agent,
  CreateAgentPayload,
  AgentsResponse,
  GetAgentsParams,
  agentsApi,
} from './api/agents'
import apiClient, { formatUrl, getOrgId } from './api/client'
import {
  EventType,
  SubscriptionUsage,
  UsageSummary,
  DailyUsageData,
  DailyUsageResponse,
  GetUsageParams,
  customerTabsApi,
} from './api/customerTabs'
// Import the filters API
import {
  Agent as FilterAgent,
  Customer as FilterCustomer,
  PricingPlan as FilterPricingPlan,
  Signal as FilterSignal,
  FiltersResponse,
  FilterParams,
  filtersApi,
} from './api/filters'
import {
  SimulationPayload,
  SimulationResponse,
  PricingTier as SimulationPricingTier,
  ChargeDetail,
  ChargeGroup,
  StrategyCharge,
  StrategyBreakdownItem,
  StrategyBreakdown,
  SimulationSummary,
  invoiceCalculatorApi,
} from './api/invoice-calculator'
import {
  Invoice,
  Customer as InvoiceCustomer,
  InvoiceSubscription,
  InvoiceQueryParams,
  invoicesApi,
} from './api/invoices'
import {
  PricingPlan as PricingPlanOld,
  PricingPlansResponse,
  PricingStrategy,
  PricingTier,
  Signal,
  GetPricingPlansParams,
  CreatePricingPlanPayload,
  pricingPlansApi,
  pricingStrategiesApi,
} from './api/pricing'
// Subscription API
import {
  Subscription,
  PricingPlan,
  Agent as SubscriptionAgent,
  CreateSubscriptionPayload,
  UpdateSubscriptionPayload,
  RenewSubscriptionPayload,
  SubscriptionQueryParams,
  subscriptionsApi,
} from './api/subscriptions'
import { userApi } from './api/user'

// Re-export everything
export {
  apiClient,
  formatUrl,
  getOrgId,
  userApi,
  agentsApi,
  customersApi,
  customerTabsApi,
  pricingPlansApi,
  pricingStrategiesApi,
  invoiceCalculatorApi,
  subscriptionsApi,
  invoicesApi,
  filtersApi,
}

// Re-export types
export type {
  Agent,
  CreateAgentPayload,
  AgentsResponse,
  GetAgentsParams,
  Customer,
  CreateCustomerPayload,
  UpdateCustomerPayload,
  PaginatedResponse,
  CustomerQueryParams,
  // Customer Tabs types
  EventType,
  SubscriptionUsage,
  UsageSummary,
  DailyUsageData,
  DailyUsageResponse,
  GetUsageParams,
  // End Customer Tabs types
  PricingPlanOld,
  PricingPlansResponse,
  PricingStrategy,
  PricingTier,
  Signal,
  GetPricingPlansParams,
  CreatePricingPlanPayload,
  SimulationPayload,
  SimulationResponse,
  SimulationPricingTier,
  ChargeDetail,
  ChargeGroup,
  StrategyCharge,
  StrategyBreakdownItem,
  StrategyBreakdown,
  SimulationSummary,
  // Subscription API types
  Subscription,
  PricingPlan,
  SubscriptionAgent,
  CreateSubscriptionPayload,
  UpdateSubscriptionPayload,
  RenewSubscriptionPayload,
  SubscriptionQueryParams,

  // Invoice API types
  Invoice,
  InvoiceCustomer,
  InvoiceSubscription,
  InvoiceQueryParams,

  // Filters API types
  FilterAgent,
  FilterCustomer,
  FilterPricingPlan,
  FilterSignal,
  FiltersResponse,
  FilterParams,
}

export default apiClient
