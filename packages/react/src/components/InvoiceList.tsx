"use client";

import type { Invoice, InvoiceStatus } from "@marginfront/sdk";
import { useInvoices } from "../hooks/useInvoices";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";

interface InvoiceListProps {
  /** Filter by status */
  status?: InvoiceStatus;
  /** Number of invoices per page */
  limit?: number;
  /** Pre-loaded invoices (skips fetch) */
  invoices?: Invoice[];
  /** Callback when invoice is clicked */
  onInvoiceClick?: (invoice: Invoice) => void;
  /** Show load more button */
  showLoadMore?: boolean;
  /** Custom class name */
  className?: string;
  /** Empty state message */
  emptyMessage?: string;
}

const STATUS_STYLES: Record<
  InvoiceStatus,
  { bg: string; text: string; label: string }
> = {
  draft: { bg: "bg-gray-100", text: "text-gray-700", label: "Draft" },
  issued: { bg: "bg-blue-100", text: "text-blue-700", label: "Issued" },
  paid: { bg: "bg-green-100", text: "text-green-700", label: "Paid" },
  overdue: { bg: "bg-red-100", text: "text-red-700", label: "Overdue" },
  void: { bg: "bg-gray-100", text: "text-gray-500", label: "Void" },
  refunded: { bg: "bg-purple-100", text: "text-purple-700", label: "Refunded" },
};

/**
 * InvoiceList - Display a list of invoices
 *
 * @example
 * ```tsx
 * <InvoiceList
 *   status="pending"
 *   limit={10}
 *   onInvoiceClick={(invoice) => router.push(`/invoices/${invoice.id}`)}
 * />
 * ```
 */
export function InvoiceList({
  status,
  limit = 10,
  invoices: providedInvoices,
  onInvoiceClick,
  showLoadMore = true,
  className,
  emptyMessage = "No invoices found",
}: InvoiceListProps) {
  const { theme } = useMarginFrontContext();
  const {
    invoices: fetchedInvoices,
    isLoading,
    error,
    hasMore,
    fetchNextPage,
  } = useInvoices({
    status,
    limit,
    enabled: !providedInvoices,
  });

  const invoices = providedInvoices || fetchedInvoices;

  if (isLoading && invoices.length === 0) {
    return (
      <div className={cn("marginfront-invoice-list", className)}>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="animate-pulse bg-white rounded-lg border border-gray-200 p-4"
            >
              <div className="flex justify-between items-center">
                <div className="space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-32" />
                  <div className="h-3 bg-gray-200 rounded w-24" />
                </div>
                <div className="h-6 bg-gray-200 rounded w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("marginfront-invoice-list", className)}>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
          <p className="text-red-700">Failed to load invoices</p>
          <p className="text-red-500 text-sm mt-1">{error.message}</p>
        </div>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className={cn("marginfront-invoice-list", className)}>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-500">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("marginfront-invoice-list", className)}>
      <div className="space-y-3">
        {invoices.map((invoice) => {
          const statusStyle =
            STATUS_STYLES[invoice.status] || STATUS_STYLES.draft;

          return (
            <div
              key={invoice.id}
              onClick={() => onInvoiceClick?.(invoice)}
              className={cn(
                "bg-white rounded-lg border border-gray-200 p-4 transition-all",
                onInvoiceClick &&
                  "cursor-pointer hover:border-gray-300 hover:shadow-sm",
              )}
            >
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-medium text-gray-900">
                    {invoice.invoiceNumber}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    {formatDate(invoice.invoiceDate)}
                    {invoice.dueDate && ` · Due ${formatDate(invoice.dueDate)}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">
                    {formatCurrency(
                      Number(invoice.totalAmount),
                      invoice.currency,
                    )}
                  </p>
                  <span
                    className={cn(
                      "inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium",
                      statusStyle.bg,
                      statusStyle.text,
                    )}
                  >
                    {statusStyle.label}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showLoadMore && hasMore && (
        <div className="mt-4 text-center">
          <button
            onClick={() => fetchNextPage()}
            disabled={isLoading}
            style={{ color: theme.primary }}
            className="text-sm font-medium hover:underline disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

// Helper functions
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
