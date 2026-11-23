/**
 * @marginfront/react
 *
 * React components for MarginFront - pricing tables, invoices, usage charts, and billing UI
 *
 * Supports three authentication modes:
 *
 * @example API Key Mode (standard SDK usage)
 * ```tsx
 * import { MarginFrontProvider, InvoiceViewer } from '@marginfront/react';
 *
 * function App() {
 *   return (
 *     <MarginFrontProvider
 *       apiBaseUrl="https://billing.example.com/v1"
 *       apiKey="mf_sk_your_key"
 *       customerId="cust_123"
 *     >
 *       <InvoiceViewer invoiceId="inv_123" />
 *     </MarginFrontProvider>
 *   );
 * }
 * ```
 *
 * @example Portal Session Mode (customer portal)
 * ```tsx
 * // Use portal session token from portalSessions.create()
 * <MarginFrontProvider
 *   apiBaseUrl="https://billing.example.com/v1"
 *   sessionToken={portalSession.token}
 * >
 *   <InvoiceList />
 *   <UsageChart />
 * </MarginFrontProvider>
 * ```
 *
 * @example Public Mode (pricing pages)
 * ```tsx
 * <MarginFrontProvider apiBaseUrl="https://billing.example.com/v1" orgSlug="acme-corp">
 *   <PricingTable plans={plans} onSelectPlan={handleSelect} />
 * </MarginFrontProvider>
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Provider & Context
// ============================================================================

export { MarginFrontProvider, type MarginFrontProviderProps } from './provider';
export {
  MarginFrontContext,
  useMarginFrontContext,
  type MarginFrontContextValue,
  type MarginFrontTheme,
  type AuthMode,
} from './context';

// ============================================================================
// Hooks
// ============================================================================

export { useMarginFront } from './hooks/useMarginFront';
export { useInvoices, useInvoice } from './hooks/useInvoices';
export { useUsage } from './hooks/useUsage';
export { useSubscriptions, useSubscription } from './hooks/useSubscription';
export { useCustomer } from './hooks/useCustomer';

// ============================================================================
// Components - Full-Page Solutions
// ============================================================================

export { InvoiceHistory, type InvoiceHistoryProps } from './components/InvoiceHistory';
export { UsageDashboard, type UsageDashboardProps } from './components/UsageDashboard';
export { CustomerPortal, type CustomerPortalProps, type PortalTab } from './components/CustomerPortal';
export { CustomerProfile, type CustomerProfileProps } from './components/CustomerProfile';
export { SubscriptionOverview, type SubscriptionOverviewProps } from './components/SubscriptionOverview';
export { BillingSummary, type BillingSummaryProps } from './components/BillingSummary';
export { CheckoutForm, type CheckoutFormProps, type CheckoutData, type OrderItem } from './components/CheckoutForm';

// ============================================================================
// Components - Page Sections
// ============================================================================

export { InvoiceViewer } from './components/InvoiceViewer';
export { InvoiceList } from './components/InvoiceList';
export { UsageChart } from './components/UsageChart';
export { SubscriptionCard } from './components/SubscriptionCard';
export { PricingTable, type PricingPlan } from './components/PricingTable';

// Pricing Page Components
export { EstimateCost, type EstimateCostProps } from './components/EstimateCost';
export { PlanQuiz, PlanQuiz as ChooseBestPlan, type PlanQuizProps } from './components/PlanQuiz';
export { ROICalculator, type ROICalculatorProps } from './components/ROICalculator';

// ============================================================================
// Components - Primitives
// ============================================================================

export { MetricCard, type MetricCardProps } from './components/primitives/MetricCard';
export { StatusBadge, type StatusBadgeProps, type StatusType } from './components/primitives/StatusBadge';
export { SummaryCard, type SummaryCardProps } from './components/primitives/SummaryCard';
export { ComponentHeader, type ComponentHeaderProps } from './components/primitives/ComponentHeader';

// ============================================================================
// Types (re-exported from @marginfront/sdk for convenience)
// ============================================================================

export type {
  Invoice,
  InvoiceDetail,
  InvoiceStatus,
  Subscription,
  SubscriptionDetail,
  SubscriptionStatus,
  Customer,
} from '@marginfront/sdk';

export type { PricingPlanV2, BusinessContext } from './types/pricing';

// ============================================================================
// Utilities
// ============================================================================

export { cn } from './utils/cn';
