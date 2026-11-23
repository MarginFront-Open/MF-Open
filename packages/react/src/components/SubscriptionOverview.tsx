"use client";

/**
 * SubscriptionOverview Component
 * Standalone subscription view with plan card, usage bar, features, and actions
 * Follows the InvoiceHistory pattern for consistency
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Package, Calendar, Zap } from "lucide-react";
import type { SubscriptionDetail } from "@marginfront/sdk";
import { useSubscriptions, useSubscription } from "../hooks/useSubscription";
import { useUsage } from "../hooks/useUsage";
import { useMarginFrontContext } from "../context";
import { cn } from "../utils/cn";
import { ComponentHeader } from "./primitives/ComponentHeader";
import { StatusBadge } from "./primitives/StatusBadge";

export interface SubscriptionOverviewProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Subscription ID (auto-detects active subscription if not provided) */
  subscriptionId?: string;
  /** Pre-loaded subscription data (skips fetch) */
  subscription?: SubscriptionDetail;
  /** Show usage progress bar */
  showUsageBar?: boolean;
  /** Show plan features */
  showFeatures?: boolean;
  /** Callback when upgrade is clicked */
  onUpgrade?: () => void;
  /** Callback when manage is clicked */
  onManage?: (subscription: SubscriptionDetail) => void;
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

export function SubscriptionOverview({
  companyName = "Your Product",
  logo,
  subscriptionId: providedSubId,
  subscription: providedSubscription,
  showUsageBar = true,
  showFeatures = true,
  onUpgrade,
  onManage,
  showHeader = false,
  showCustomize = false,
  onCustomize,
  className,
  brandColor,
  theme: themeProp,
}: SubscriptionOverviewProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || "#047857";
  const secondaryColor = contextTheme.secondary || "#6B7280";
  const accentColor = contextTheme.accent || "#10B981";
  const isDark = themeProp === "dark";

  // Auto-detect active subscription if no ID provided
  const { subscriptions, isLoading: listLoading } = useSubscriptions({
    limit: 1,
    status: "active",
    enabled: !providedSubscription && !providedSubId,
  });

  const resolvedSubId = providedSubId || subscriptions[0]?.id || "";

  const { subscription: fetchedSubscription, isLoading: detailLoading } =
    useSubscription({
      subscriptionId: resolvedSubId,
      enabled: !providedSubscription && !!resolvedSubId,
    });

  const subscription = providedSubscription || fetchedSubscription;

  // Fetch usage for the current period
  const { summary: usageSummary, isLoading: usageLoading } = useUsage({
    enabled: showUsageBar && !!subscription,
  });

  const isLoading =
    listLoading || detailLoading || (showUsageBar && usageLoading);

  // Derive display data
  const planData = useMemo(() => {
    if (!subscription) return null;

    const usage = subscription.usage;
    const totalQuantity =
      usageSummary?.totalQuantity ?? usage?.totalQuantity ?? 0;
    const totalEvents = usage?.totalEvents ?? 0;

    return {
      name: subscription.plan?.name || "Subscription",
      description: subscription.plan?.description,
      features: subscription.plan?.features || [],
      billingCycle: subscription.billingCycle || "Monthly",
      status: subscription.status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      periodStart: usage?.periodStart,
      periodEnd: usage?.periodEnd,
      totalQuantity,
      totalEvents,
      agentName: subscription.agent?.name,
    };
  }, [subscription, usageSummary]);

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: "bg-slate-900",
        cardBg: "bg-slate-800",
        text: "text-white",
        textMuted: "text-slate-400",
        border: "border-slate-700",
      };
    }
    return {
      bg: "bg-white",
      cardBg: "bg-gray-50",
      text: "text-gray-900",
      textMuted: "text-gray-600",
      border: "border-gray-200",
    };
  };

  const styles = getThemeStyles();

  // Loading state
  if (isLoading && !subscription) {
    return (
      <div
        className={cn(
          "marginfront-subscription-overview rounded-xl border overflow-hidden",
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
              <div className="h-4 w-28 bg-gray-200 rounded" />
            </div>
          </div>
        )}
        <div className="p-4 animate-pulse space-y-3">
          <div className="h-28 bg-gray-100 rounded-xl" />
          <div className="h-16 bg-gray-100 rounded-xl" />
          <div className="flex gap-2">
            <div className="h-9 flex-1 bg-gray-100 rounded-lg" />
            <div className="h-9 flex-1 bg-gray-100 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  // Error / empty state
  if (!subscription && !isLoading) {
    return (
      <div
        className={cn(
          "marginfront-subscription-overview rounded-xl border overflow-hidden",
          styles.bg,
          styles.border,
          className,
        )}
      >
        {showHeader && (
          <ComponentHeader
            companyName={companyName}
            logo={logo}
            componentLabel="Subscription"
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
            <Package className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className={cn("font-medium", styles.text)}>
            No active subscription
          </p>
          <p className={cn("text-sm mt-1", styles.textMuted)}>
            Subscribe to a plan to get started
          </p>
          {onUpgrade && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={onUpgrade}
              className="mt-4 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: primaryColor }}
            >
              View Plans
            </motion.button>
          )}
        </div>
      </div>
    );
  }

  if (!planData) return null;

  const statusMap: Record<string, "active" | "warning" | "error" | "info"> = {
    upcoming: "info",
    active: "active",
    pending: "warning",
    ended: "info",
    canceled: "error",
    expired: "info",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn(
        "marginfront-subscription-overview rounded-xl border overflow-hidden",
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
          componentLabel="Subscription"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      <div className="p-4 space-y-3">
        {/* Plan Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className={cn(
            "rounded-xl p-4 border relative overflow-hidden",
            styles.border,
          )}
          style={{
            background: `linear-gradient(135deg, ${primaryColor}20, ${secondaryColor}10)`,
          }}
        >
          <div className="absolute top-0 right-0 w-20 h-20 opacity-10">
            <Zap className="w-full h-full" style={{ color: primaryColor }} />
          </div>

          <div className="relative z-10">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Current Plan
                  </span>
                  <StatusBadge
                    status={statusMap[planData.status] || "active"}
                    label={
                      planData.status.charAt(0).toUpperCase() +
                      planData.status.slice(1)
                    }
                    size="sm"
                  />
                </div>
                <h3 className={cn("text-lg font-bold", styles.text)}>
                  {planData.name}
                </h3>
                {planData.description && (
                  <p className={cn("text-xs mt-0.5", styles.textMuted)}>
                    {planData.description}
                  </p>
                )}
              </div>
              <div className="text-right">
                <div className={cn("text-xs", styles.textMuted)}>
                  {planData.billingCycle} billing
                </div>
              </div>
            </div>

            {/* Usage Bar */}
            {showUsageBar && planData.totalQuantity > 0 && (
              <div className="mb-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className={styles.textMuted}>Usage this period</span>
                  <span className={styles.text}>
                    {formatNumber(planData.totalQuantity)} units
                  </span>
                </div>
                <div
                  className={cn(
                    "h-1.5 rounded-full overflow-hidden",
                    isDark ? "bg-white/10" : "bg-gray-200",
                  )}
                >
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: "100%" }}
                    transition={{ delay: 0.4, duration: 0.8, ease: "easeOut" }}
                    className="h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${primaryColor}, ${accentColor})`,
                    }}
                  />
                </div>
                {planData.totalEvents > 0 && (
                  <div className={cn("text-[10px] mt-1", styles.textMuted)}>
                    {formatNumber(planData.totalEvents)} events tracked
                  </div>
                )}
              </div>
            )}

            {/* Period Dates */}
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs",
                styles.textMuted,
              )}
            >
              <Calendar className="w-3 h-3" />
              <span>
                {planData.periodStart && planData.periodEnd
                  ? `${formatDate(planData.periodStart)} — ${formatDate(planData.periodEnd)}`
                  : `Started ${formatDate(planData.startDate)}`}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Features */}
        {showFeatures && planData.features.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className={cn(
              "rounded-xl p-4 border",
              styles.cardBg,
              styles.border,
            )}
          >
            <h4 className={cn("text-sm font-semibold mb-2", styles.text)}>
              Plan Features
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {planData.features.map((feature, index) => (
                <motion.div
                  key={feature}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + index * 0.05 }}
                  className="flex items-center gap-1.5"
                >
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${accentColor}20` }}
                  >
                    <Zap className="w-2 h-2" style={{ color: accentColor }} />
                  </div>
                  <span className={cn("text-xs", styles.textMuted)}>
                    {feature}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Action Buttons */}
        {(onUpgrade || onManage) && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="flex gap-2"
          >
            {onUpgrade && (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={onUpgrade}
                className="flex-1 py-2 px-3 rounded-lg text-sm font-medium text-white transition-all"
                style={{
                  background: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
                }}
              >
                Upgrade Plan
              </motion.button>
            )}
            {onManage && subscription && (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onManage(subscription)}
                className={cn(
                  "flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-all",
                  styles.border,
                  styles.text,
                )}
              >
                Manage Subscription
              </motion.button>
            )}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
