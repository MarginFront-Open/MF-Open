"use client";

/**
 * InvoiceViewer Component
 * Standalone single-invoice detail view with line items, totals, and actions
 * Follows the InvoiceHistory pattern for consistency
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  FileText,
  Download,
  CreditCard,
  AlertCircle,
  CheckCircle,
  Clock,
} from "lucide-react";
import type { InvoiceDetail, InvoiceStatus } from "@marginfront/sdk";
import { useInvoice } from "../hooks/useInvoices";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";

export interface InvoiceViewerProps {
  /** Invoice ID to display */
  invoiceId: string;
  /** Pre-loaded invoice data (skips fetch) */
  invoice?: InvoiceDetail;
  /** Show download PDF button */
  showDownload?: boolean;
  /** Show pay button for unpaid invoices */
  showPayButton?: boolean;
  /** Callback when pay is clicked */
  onPay?: (invoice: InvoiceDetail) => void;
  /** Callback when download is clicked */
  onDownload?: (invoice: InvoiceDetail) => void;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: "light" | "dark";
}

const statusConfig: Record<
  InvoiceStatus,
  { icon: typeof CheckCircle; color: string; bg: string; label: string }
> = {
  paid: {
    icon: CheckCircle,
    color: "text-emerald-600",
    bg: "bg-emerald-500/10",
    label: "Paid",
  },
  issued: {
    icon: Clock,
    color: "text-amber-600",
    bg: "bg-amber-500/10",
    label: "Issued",
  },
  overdue: {
    icon: AlertCircle,
    color: "text-red-600",
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
  refunded: {
    icon: AlertCircle,
    color: "text-purple-600",
    bg: "bg-purple-500/10",
    label: "Refunded",
  },
};

export function InvoiceViewer({
  invoiceId,
  invoice: providedInvoice,
  showDownload = true,
  showPayButton = true,
  onPay,
  onDownload,
  className,
  brandColor,
  theme: themeProp,
}: InvoiceViewerProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || "#047857";
  const isDark = themeProp === "dark";

  const {
    invoice: fetchedInvoice,
    isLoading,
    error,
  } = useInvoice({
    invoiceId,
    enabled: !providedInvoice,
  });

  const invoice = providedInvoice || fetchedInvoice;

  const isPaid = invoice?.status === "paid";
  const canPay =
    invoice &&
    !isPaid &&
    invoice.status !== "void" &&
    invoice.status !== "draft";

  const formattedTotal = useMemo(() => {
    if (!invoice) return "$0.00";
    return formatCurrency(Number(invoice.totalAmount), invoice.currency);
  }, [invoice]);

  const formattedAmountDue = useMemo(() => {
    if (!invoice) return "$0.00";
    return formatCurrency(Number(invoice.amountDue), invoice.currency);
  }, [invoice]);

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: "bg-slate-900",
        cardBg: "bg-slate-800",
        text: "text-white",
        textMuted: "text-slate-400",
        border: "border-slate-700",
        rowBorder: "border-slate-700/50",
      };
    }
    return {
      bg: "bg-white",
      cardBg: "bg-gray-50",
      text: "text-gray-900",
      textMuted: "text-gray-600",
      border: "border-gray-200",
      rowBorder: "border-gray-100",
    };
  };

  const styles = getThemeStyles();

  // Loading state
  if (isLoading && !invoice) {
    return (
      <div
        className={cn(
          "marginfront-invoice-viewer rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        <div className="p-4 animate-pulse space-y-3">
          <div className="flex justify-between">
            <div className="space-y-2">
              <div className="h-5 w-36 bg-gray-200 rounded" />
              <div className="h-3 w-24 bg-gray-200 rounded" />
            </div>
            <div className="h-6 w-16 bg-gray-200 rounded-full" />
          </div>
          <div className="h-12 bg-gray-100 rounded-lg" />
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-gray-100 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        className={cn(
          "marginfront-invoice-viewer rounded-xl border overflow-hidden",
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
            Failed to load invoice
          </p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            {error.message}
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!invoice) {
    return (
      <div
        className={cn(
          "marginfront-invoice-viewer rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        <div className="p-12 text-center">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: `${primaryColor}15` }}
          >
            <FileText className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className={cn("font-medium", styles.text)}>Invoice not found</p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            This invoice does not exist or has been removed
          </p>
        </div>
      </div>
    );
  }

  const config = statusConfig[invoice.status] || statusConfig.draft;
  const StatusIcon = config.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn(
        "marginfront-invoice-viewer rounded-xl border overflow-hidden",
        styles.bg,
        styles.border,
        className,
      )}
    >
      {/* Header */}
      <div className={cn("px-4 py-3 border-b", styles.border)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${primaryColor}15` }}
            >
              <FileText className="w-4 h-4" style={{ color: primaryColor }} />
            </div>
            <div>
              <h2 className={cn("text-sm font-semibold", styles.text)}>
                {invoice.invoiceNumber}
              </h2>
              <p className={cn("text-xs", styles.textMuted)}>
                {formatDate(invoice.invoiceDate)}
                {invoice.dueDate && ` · Due ${formatDate(invoice.dueDate)}`}
              </p>
            </div>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium",
              config.color,
              config.bg,
            )}
          >
            <StatusIcon className="w-3 h-3" />
            {config.label}
          </span>
        </div>
      </div>

      {/* Bill To */}
      {invoice.customer && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15 }}
          className={cn("px-4 py-3 border-b", styles.border, styles.cardBg)}
        >
          <p
            className={cn(
              "text-[10px] uppercase tracking-wide mb-0.5",
              styles.textMuted,
            )}
          >
            Bill To
          </p>
          <p className={cn("text-xs font-medium", styles.text)}>
            {invoice.customer.name}
          </p>
          {invoice.customer.email && (
            <p className={cn("text-xs", styles.textMuted)}>
              {invoice.customer.email}
            </p>
          )}
        </motion.div>
      )}

      {/* Line Items */}
      <div className="px-4 py-3">
        {/* Table Header */}
        <div
          className={cn(
            "grid gap-2 pb-2 text-[10px] uppercase tracking-wide font-medium border-b",
            styles.textMuted,
            styles.border,
          )}
          style={{ gridTemplateColumns: "2fr 0.7fr 1fr 1fr" }}
        >
          <div>Description</div>
          <div className="text-right">Qty</div>
          <div className="text-right">Unit Price</div>
          <div className="text-right">Amount</div>
        </div>

        {/* Rows */}
        {invoice.lineItems?.map((item, idx) => (
          <motion.div
            key={item.id || idx}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 + idx * 0.05 }}
            className={cn(
              "grid gap-2 py-2.5 text-xs items-center",
              idx !== (invoice.lineItems?.length ?? 0) - 1 &&
                `border-b ${styles.rowBorder}`,
            )}
            style={{ gridTemplateColumns: "2fr 0.7fr 1fr 1fr" }}
          >
            <div className={cn("font-medium", styles.text)}>
              {item.description}
            </div>
            <div className={cn("text-right", styles.textMuted)}>
              {item.quantity}
            </div>
            <div className={cn("text-right", styles.textMuted)}>
              {formatCurrency(Number(item.unitPrice), invoice.currency)}
            </div>
            <div className={cn("text-right font-medium", styles.text)}>
              {formatCurrency(Number(item.amount), invoice.currency)}
            </div>
          </motion.div>
        ))}

        {/* Totals */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className={cn("mt-3 pt-3 border-t", styles.border)}
        >
          <div className="flex justify-end">
            <div className="w-48 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className={styles.textMuted}>Subtotal</span>
                <span className={styles.text}>{formattedTotal}</span>
              </div>
              {invoice.amountPaid && Number(invoice.amountPaid) > 0 && (
                <div className="flex justify-between text-xs">
                  <span className={styles.textMuted}>Paid</span>
                  <span className="text-emerald-600">
                    -
                    {formatCurrency(
                      Number(invoice.amountPaid),
                      invoice.currency,
                    )}
                  </span>
                </div>
              )}
              <div
                className={cn(
                  "flex justify-between text-sm font-semibold pt-1.5 border-t",
                  styles.border,
                )}
              >
                <span className={styles.text}>Amount Due</span>
                <span
                  style={{ color: canPay ? primaryColor : undefined }}
                  className={isPaid ? "text-emerald-600" : ""}
                >
                  {formattedAmountDue}
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Actions */}
      {(showDownload || (showPayButton && canPay)) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className={cn(
            "px-4 py-3 border-t flex justify-end gap-2",
            styles.border,
            styles.cardBg,
          )}
        >
          {showDownload && (
            <button
              onClick={() => onDownload?.(invoice)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                styles.border,
                styles.text,
                isDark ? "hover:bg-slate-700" : "hover:bg-gray-100",
              )}
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>
          )}
          {showPayButton && canPay && (
            <button
              onClick={() => onPay?.(invoice)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: primaryColor }}
            >
              <CreditCard className="w-3.5 h-3.5" />
              Pay Now
            </button>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

function formatCurrency(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
