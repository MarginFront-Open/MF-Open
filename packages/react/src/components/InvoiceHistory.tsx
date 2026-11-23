"use client";

/**
 * InvoiceHistory Component
 * Beautiful invoice history with summary cards, animated table, and status icons
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  FileText,
  Download,
  CheckCircle,
  Clock,
  AlertCircle,
} from "lucide-react";
import type { Invoice, InvoiceStatus } from "@marginfront/sdk";
import { useInvoices } from "../hooks/useInvoices";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";
import { ComponentHeader } from "./primitives/ComponentHeader";

export interface InvoiceHistoryProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Filter by status */
  status?: InvoiceStatus;
  /** Number of invoices to display */
  limit?: number;
  /** Pre-loaded invoices (skips fetch) */
  invoices?: Invoice[];
  /** Callback when invoice row is clicked */
  onInvoiceClick?: (invoice: Invoice) => void;
  /** Callback when download is clicked */
  onDownload?: (invoice: Invoice) => void;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Show header */
  showHeader?: boolean;
  /** Show summary cards */
  showSummary?: boolean;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: "light" | "dark";
}

// Status config with icons
const statusConfig = {
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

export function InvoiceHistory({
  companyName = "Your Product",
  logo,
  status,
  limit = 10,
  invoices: providedInvoices,
  onInvoiceClick,
  onDownload,
  showCustomize = false,
  onCustomize,
  showHeader = false,
  showSummary = true,
  className,
  brandColor,
  theme: themeProp,
}: InvoiceHistoryProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || "#047857";
  const isDark = themeProp === "dark";

  const {
    invoices: fetchedInvoices,
    isLoading,
    error,
  } = useInvoices({
    status,
    limit,
    enabled: !providedInvoices,
  });

  const invoices = providedInvoices || fetchedInvoices;

  // Calculate summary totals
  const summary = useMemo(() => {
    const totals = { paid: 0, pending: 0, overdue: 0 };
    invoices.forEach((inv) => {
      const amount = Number(inv.totalAmount) || 0;
      if (inv.status === "paid") totals.paid += amount;
      else if (inv.status === "issued") totals.pending += amount;
      else if (inv.status === "overdue") totals.overdue += amount;
    });
    return totals;
  }, [invoices]);

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
          "marginfront-invoice-history rounded-xl border overflow-hidden",
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
        {showSummary && (
          <div className="grid grid-cols-3 gap-2 p-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={cn("rounded-lg p-3 animate-pulse", styles.cardBg)}
              >
                <div className="h-3 w-12 bg-gray-200 rounded mb-1" />
                <div className="h-5 w-16 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
        )}
        <div className="px-4 pb-4 space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="animate-pulse h-12 bg-gray-100 rounded-lg"
            />
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        className={cn(
          "marginfront-invoice-history rounded-xl border overflow-hidden",
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
            Failed to load invoices
          </p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            {error.message}
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (invoices.length === 0) {
    return (
      <div
        className={cn(
          "marginfront-invoice-history rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        {showHeader && (
          <ComponentHeader
            companyName={companyName}
            logo={logo}
            componentLabel="Invoice History"
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
            <FileText className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className={cn("font-medium", styles.text)}>No invoices yet</p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            Invoices will appear here once generated
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
        "marginfront-invoice-history rounded-xl border overflow-hidden",
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
          componentLabel="Invoice History"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      {/* Summary Cards */}
      {showSummary && (
        <div className="grid grid-cols-3 gap-2 p-4">
          {[
            {
              label: "Total Paid",
              value: formatCurrency(summary.paid),
              color: "emerald",
            },
            {
              label: "Pending",
              value: formatCurrency(summary.pending),
              color: "amber",
            },
            {
              label: "Overdue",
              value: formatCurrency(summary.overdue),
              color: "red",
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
      )}

      {/* Invoice Table */}
      <div
        className={cn(
          "rounded-xl border overflow-hidden mx-4 mb-4",
          styles.cardBg,
          styles.border,
        )}
      >
        {/* Table Header */}
        <div
          className={cn(
            "grid gap-2 px-4 py-2 border-b text-xs font-medium",
            styles.border,
            styles.textMuted,
          )}
          style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1fr 0.5fr" }}
        >
          <div>Invoice</div>
          <div>Date</div>
          <div>Amount</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>

        {/* Table Rows */}
        {invoices.slice(0, limit).map((invoice, index) => {
          const config =
            statusConfig[invoice.status as keyof typeof statusConfig] ||
            statusConfig.draft;
          const StatusIcon = config.icon;

          return (
            <motion.div
              key={invoice.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 + index * 0.1 }}
              onClick={() => onInvoiceClick?.(invoice)}
              className={cn(
                "grid gap-2 px-4 py-2.5 items-center transition-colors",
                styles.rowHover,
                index !== invoices.length - 1 && `border-b ${styles.border}`,
                onInvoiceClick && "cursor-pointer",
              )}
              style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1fr 0.5fr" }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: `${primaryColor}20` }}
                >
                  <FileText
                    className="w-3 h-3"
                    style={{ color: primaryColor }}
                  />
                </div>
                <span
                  className={cn("text-xs font-medium truncate", styles.text)}
                >
                  {invoice.invoiceNumber}
                </span>
              </div>
              <div className={cn("text-xs", styles.textMuted)}>
                {formatDate(invoice.invoiceDate)}
              </div>
              <div className={cn("text-xs font-semibold", styles.text)}>
                {formatCurrency(Number(invoice.totalAmount), invoice.currency)}
              </div>
              <div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium",
                    config.color,
                    config.bg,
                  )}
                >
                  <StatusIcon className="w-2.5 h-2.5" />
                  {config.label}
                </span>
              </div>
              <div className="text-right">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload?.(invoice);
                  }}
                  className="p-1 rounded-md transition-opacity hover:opacity-70 border-0 bg-transparent outline-none"
                  style={{ color: primaryColor }}
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}

// Helper functions
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
