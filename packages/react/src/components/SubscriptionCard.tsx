"use client";

import type { SubscriptionDetail, SubscriptionStatus } from "@marginfront/sdk";
import { useSubscription } from "../hooks/useSubscription";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";

interface SubscriptionCardProps {
  /** Subscription ID to display */
  subscriptionId: string;
  /** Pre-loaded subscription data (skips fetch) */
  subscription?: SubscriptionDetail;
  /** Show usage summary */
  showUsage?: boolean;
  /** Callback when manage is clicked */
  onManage?: (subscription: SubscriptionDetail) => void;
  /** Custom class name */
  className?: string;
}

const STATUS_STYLES: Record<
  SubscriptionStatus,
  { bg: string; text: string; label: string }
> = {
  upcoming: { bg: "bg-blue-100", text: "text-blue-700", label: "Upcoming" },
  active: { bg: "bg-green-100", text: "text-green-700", label: "Active" },
  pending: { bg: "bg-yellow-100", text: "text-yellow-700", label: "Pending" },
  ended: { bg: "bg-gray-100", text: "text-gray-500", label: "Ended" },
  canceled: { bg: "bg-red-100", text: "text-red-700", label: "Canceled" },
  expired: { bg: "bg-gray-100", text: "text-gray-500", label: "Expired" },
};

/**
 * SubscriptionCard - Display subscription details
 *
 * @example
 * ```tsx
 * <SubscriptionCard
 *   subscriptionId="sub_123"
 *   showUsage
 *   onManage={(sub) => console.log('Manage', sub)}
 * />
 * ```
 */
export function SubscriptionCard({
  subscriptionId,
  subscription: providedSubscription,
  showUsage = true,
  onManage,
  className,
}: SubscriptionCardProps) {
  const { theme } = useMarginFrontContext();
  const {
    subscription: fetchedSubscription,
    isLoading,
    error,
  } = useSubscription({
    subscriptionId,
    enabled: !providedSubscription,
  });

  const subscription = providedSubscription || fetchedSubscription;

  if (isLoading) {
    return (
      <div className={cn("marginfront-subscription-card", className)}>
        <div className="bg-white rounded-lg border border-gray-200 p-6 animate-pulse">
          <div className="flex justify-between items-start mb-4">
            <div className="space-y-2">
              <div className="h-5 bg-gray-200 rounded w-32" />
              <div className="h-4 bg-gray-200 rounded w-24" />
            </div>
            <div className="h-6 bg-gray-200 rounded w-20" />
          </div>
          <div className="h-20 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("marginfront-subscription-card", className)}>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-700">Failed to load subscription</p>
          <p className="text-red-500 text-sm mt-1">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!subscription) {
    return (
      <div className={cn("marginfront-subscription-card", className)}>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-gray-500">Subscription not found</p>
        </div>
      </div>
    );
  }

  const statusStyle =
    STATUS_STYLES[subscription.status] || STATUS_STYLES.active;
  const isActive =
    subscription.status === "active" || subscription.status === "pending";

  return (
    <div className={cn("marginfront-subscription-card", className)}>
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="p-6">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {subscription.plan?.name || "Subscription"}
              </h3>
              {subscription.agent && (
                <p className="text-sm text-gray-500 mt-1">
                  {subscription.agent.name}
                </p>
              )}
            </div>
            <span
              className={cn(
                "px-3 py-1 rounded-full text-sm font-medium",
                statusStyle.bg,
                statusStyle.text,
              )}
            >
              {statusStyle.label}
            </span>
          </div>

          {/* Dates */}
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                Start Date
              </p>
              <p className="text-sm font-medium text-gray-900 mt-1">
                {formatDate(subscription.startDate)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                {subscription.endDate ? "End Date" : "Period End"}
              </p>
              <p className="text-sm font-medium text-gray-900 mt-1">
                {subscription.endDate
                  ? formatDate(subscription.endDate)
                  : subscription.usage?.periodEnd
                    ? formatDate(subscription.usage.periodEnd)
                    : "—"}
              </p>
            </div>
          </div>
        </div>

        {/* Usage Summary */}
        {showUsage && subscription.usage && (
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-3">
              Current Period Usage
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p
                  className="text-2xl font-semibold"
                  style={{ color: theme.primary }}
                >
                  {formatNumber(subscription.usage.totalQuantity)}
                </p>
                <p className="text-sm text-gray-500">Total Units</p>
              </div>
              <div>
                <p
                  className="text-2xl font-semibold"
                  style={{ color: theme.accent }}
                >
                  {formatNumber(subscription.usage.totalEvents)}
                </p>
                <p className="text-sm text-gray-500">Total Events</p>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        {onManage && isActive && (
          <div className="px-6 py-4 border-t border-gray-200">
            <button
              onClick={() => onManage(subscription)}
              className="w-full px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Manage Subscription
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Helper functions
function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
