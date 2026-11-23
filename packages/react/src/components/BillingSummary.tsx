"use client";

/**
 * BillingSummary Component
 * Standalone billing overview with summary cards and recent invoices
 * Follows the InvoiceHistory pattern for consistency
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  CreditCard,
  FileText,
  CheckCircle,
  Clock,
  AlertCircle,
  ChevronRight,
} from "lucide-react";
import type { Invoice } from "@marginfront/sdk";
import { useInvoices } from "../hooks/useInvoices";
import { useSubscriptions } from "../hooks/useSubscription";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";
import { ComponentHeader } from "./primitives/ComponentHeader";

export interface BillingSummaryProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Pre-loaded invoices (skips fetch) */
  invoices?: Invoice[];
  /** Number of recent invoices to show */
  recentLimit?: number;
  /** Show recent invoices list */
  showRecentInvoices?: boolean;
  /** Callback when "View All" is clicked */
  onViewAllInvoices?: () => void;
  /** Callback when an invoice row is clicked */
  onInvoiceClick?: (invoice: Invoice) => void;
  /** Show header */
  showHeader?: boolean;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: "light" | "dark";
}

const statusConfig: Record<
  string,
  { icon: typeof CheckCircle; color: string; bg: string; label: string }
> = {
  paid: {
    icon: CheckCircle,
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
    label: "Paid",
  },
  pending: {
    icon: Clock,
    color: "text-amber-500",
    bg: "bg-amber-500/10",
    label: "Pending",
  },
  issued: {
    icon: Clock,
    color: "text-amber-500",
    bg: "bg-amber-500/10",
    label: "Issued",
  },
  overdue: {
    icon: AlertCircle,
    color: "text-red-500",
    bg: "bg-red-500/10",
    label: "Overdue",
  },
  draft: {
    icon: FileText,
    color: "text-gray-500",
    bg: "bg-gray-500/10",
    label: "Draft",
  },
  void: {
    icon: AlertCircle,
    color: "text-gray-400",
    bg: "bg-gray-400/10",
    label: "Void",
  },
};

export function BillingSummary({
  companyName = "Your Product",
  logo,
  invoices: providedInvoices,
  recentLimit = 3,
  showRecentInvoices = true,
  onViewAllInvoices,
  onInvoiceClick,
  showHeader = false,
  showCustomize = false,
  onCustomize,
  className,
  brandColor,
  theme: themeProp,
}: BillingSummaryProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || "#047857";
  const isDark = themeProp === "dark";

  const {
    invoices: fetchedInvoices,
    isLoading: invoicesLoading,
    error: invoicesError,
  } = useInvoices({
    limit: recentLimit + 10, // fetch extra for summary calculation
    enabled: !providedInvoices,
  });

  const { subscriptions, isLoading: subsLoading } = useSubscriptions({
    limit: 1,
    status: "active",
  });

  const invoices = providedInvoices || fetchedInvoices;
  const isLoading = invoicesLoading || subsLoading;
  const error = invoicesError;

  const activeSubscription = subscriptions[0];

  // Calculate billing summary
  const summary = useMemo(() => {
    let totalPaid = 0;
    let outstanding = 0;

    invoices.forEach((inv) => {
      const amount = Number(inv.totalAmount) || 0;
      if (inv.status === "paid") totalPaid += amount;
      if (inv.status === "issued" || inv.status === "overdue") {
        outstanding += Number(inv.amountDue) || amount;
      }
    });

    // Next billing from subscription
    const nextBilling = activeSubscription?.endDate
      ? formatDate(activeSubscription.endDate)
      : null;

    return { totalPaid, outstanding, nextBilling };
  }, [invoices, activeSubscription]);

  const recentInvoices = invoices.slice(0, recentLimit);

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: "bg-slate-900",
        cardBg: "bg-slate-800",
        text: "text-white",
        textMuted: "text-slate-400",
        border: "border-slate-700",
        rowHover: "hover:bg-slate-700",
      };
    }
    return {
      bg: "bg-white",
      cardBg: "bg-gray-50",
      text: "text-gray-900",
      textMuted: "text-gray-600",
      border: "border-gray-200",
      rowHover: "hover:bg-gray-100",
    };
  };

  const styles = getThemeStyles();

  // Loading state
  if (isLoading && invoices.length === 0) {
    return (
      <div
        className={cn(
          "marginfront-billing-summary rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        {showHeader && (
          <div
            className="px-4 py-3 border-b animate-pulse"
            style={{ borderColor: isDark ? "#334155" : "#f3f4f6" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-gray-200" />
              <div className="h-4 w-24 bg-gray-200 rounded" />
            </div>
          </div>
        )}
        <div className="p-4 animate-pulse space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className={cn("rounded-lg p-3", styles.cardBg)}>
                <div className="h-3 w-12 bg-gray-200 rounded mb-1" />
                <div className="h-5 w-16 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
          {showRecentInvoices && (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-11 bg-gray-100 rounded-lg" />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        className={cn(
          "marginfront-billing-summary rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        <div className="p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
            <AlertCircle className="w-6 h-6 text-red-500" />
          </div>
          <p className={cn("font-medium", styles.text)}>
            Failed to load billing
          </p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            {error.message}
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (invoices.length === 0 && !isLoading) {
    return (
      <div
        className={cn(
          "marginfront-billing-summary rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        {showHeader && (
          <ComponentHeader
            companyName={companyName}
            logo={logo}
            componentLabel="Billing"
            showCustomize={showCustomize}
            onCustomize={onCustomize}
            brandColor={primaryColor}
          />
        )}
        <div className="p-12 text-center">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: `${primaryColor}15` }}
          >
            <CreditCard className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className={cn("font-medium", styles.text)}>No billing activity</p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            Invoices and payments will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn(
        "marginfront-billing-summary rounded-xl border overflow-hidden",
        styles.bg,
        styles.border,
        className,
      )}
    >
      {/* Header */}
      {showHeader && (
        <ComponentHeader
          companyName={companyName}
          logo={logo}
          componentLabel="Billing"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      <div className="p-4 space-y-3">
        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-2">
          {[
            {
              label: "Total Paid",
              value: formatCurrency(summary.totalPaid),
              color: "emerald",
            },
            {
              label: "Outstanding",
              value: formatCurrency(summary.outstanding),
              color: summary.outstanding > 0 ? "amber" : "emerald",
            },
            {
              label: "Next Billing",
              value: summary.nextBilling || "—",
              color: "gray",
            },
          ].map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 * (index + 1) }}
              className={cn(
                "rounded-lg p-3 border",
                styles.cardBg,
                styles.border,
              )}
            >
              <div className={cn("text-xs mb-0.5", styles.textMuted)}>
                {stat.label}
              </div>
              <div className={cn("text-base font-bold", styles.text)}>
                {stat.value}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Recent Invoices */}
        {showRecentInvoices && recentInvoices.length > 0 && (
          <div
            className={cn(
              "rounded-xl border overflow-hidden",
              styles.cardBg,
              styles.border,
            )}
          >
            <div
              className={cn(
                "px-4 py-2 border-b flex items-center justify-between",
                styles.border,
              )}
            >
              <span className={cn("text-xs font-medium", styles.textMuted)}>
                Recent Invoices
              </span>
              {onViewAllInvoices && (
                <button
                  onClick={onViewAllInvoices}
                  className="text-xs font-medium flex items-center gap-0.5 transition-opacity hover:opacity-70"
                  style={{ color: primaryColor }}
                >
                  View All
                  <ChevronRight className="w-3 h-3" />
                </button>
              )}
            </div>

            {recentInvoices.map((invoice, index) => {
              const config = statusConfig[invoice.status] || statusConfig.draft;
              const StatusIcon = config.icon;

              return (
                <motion.div
                  key={invoice.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + index * 0.08 }}
                  onClick={() => onInvoiceClick?.(invoice)}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 transition-colors",
                    styles.rowHover,
                    index !== recentInvoices.length - 1 &&
                      `border-b ${styles.border}`,
                    onInvoiceClick && "cursor-pointer",
                  )}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${primaryColor}15` }}
                  >
                    <FileText
                      className="w-3.5 h-3.5"
                      style={{ color: primaryColor }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-xs font-medium truncate",
                        styles.text,
                      )}
                    >
                      {invoice.invoiceNumber}
                    </div>
                    <div className={cn("text-[10px]", styles.textMuted)}>
                      {formatDate(invoice.invoiceDate)}
                    </div>
                  </div>
                  <div className="text-right flex items-center gap-2">
                    <span className={cn("text-xs font-semibold", styles.text)}>
                      {formatCurrency(
                        Number(invoice.totalAmount),
                        invoice.currency,
                      )}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium",
                        config.color,
                        config.bg,
                      )}
                    >
                      <StatusIcon className="w-2.5 h-2.5" />
                      {config.label}
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function formatCurrency(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
