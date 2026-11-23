'use client';

import { useMemo } from 'react';
import type { GroupBy } from '@marginfront/sdk';
import { useUsage } from '../hooks/useUsage';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';

interface UsageChartProps {
  /** Start date (YYYY-MM-DD) */
  startDate?: string;
  /** End date (YYYY-MM-DD) */
  endDate?: string;
  /** Grouping interval */
  groupBy?: GroupBy;
  /** Chart height in pixels */
  height?: number;
  /** Show summary cards */
  showSummary?: boolean;
  /** Custom class name */
  className?: string;
  /** Chart title */
  title?: string;
}

/**
 * UsageChart - Display usage metrics with a bar chart
 *
 * @example
 * ```tsx
 * <UsageChart
 *   startDate="2024-01-01"
 *   endDate="2024-01-31"
 *   groupBy="daily"
 *   showSummary
 * />
 * ```
 */
export function UsageChart({
  startDate,
  endDate,
  groupBy = 'daily',
  height = 200,
  showSummary = true,
  className,
  title = 'Usage Overview',
}: UsageChartProps) {
  const { theme } = useMarginFrontContext();
  const { summary, timeSeries, isLoading, error } = useUsage({
    startDate,
    endDate,
    groupBy,
  });

  // Calculate max value for scaling
  const maxValue = useMemo(() => {
    if (!timeSeries.length) return 0;
    return Math.max(...timeSeries.map((d) => d.quantity));
  }, [timeSeries]);

  if (isLoading) {
    return (
      <div className={cn('marginfront-usage-chart', className)}>
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="animate-pulse">
            <div className="h-6 bg-gray-200 rounded w-40 mb-6" />
            {showSummary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="bg-gray-100 rounded-lg p-4">
                    <div className="h-4 bg-gray-200 rounded w-20 mb-2" />
                    <div className="h-6 bg-gray-200 rounded w-16" />
                  </div>
                ))}
              </div>
            )}
            <div className="h-48 bg-gray-100 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('marginfront-usage-chart', className)}>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-700">Failed to load usage data</p>
          <p className="text-red-500 text-sm mt-1">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('marginfront-usage-chart', className)}>
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-6">{title}</h3>

        {/* Summary Cards */}
        {showSummary && summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <SummaryCard
              label="Total Usage"
              value={formatNumber(summary.totalQuantity)}
              color={theme.primary}
            />
            <SummaryCard
              label="Total Cost"
              value={formatCurrency(summary.totalCost)}
              color={theme.accent}
            />
            <SummaryCard
              label="Avg Daily"
              value={formatNumber(summary.avgQuantity)}
              color={theme.secondary}
            />
            <SummaryCard
              label="Avg Cost"
              value={formatCurrency(summary.avgCost)}
              color={theme.secondary}
            />
          </div>
        )}

        {/* Bar Chart */}
        {timeSeries.length > 0 ? (
          <div style={{ height }} className="relative">
            <div className="absolute inset-0 flex items-end gap-1">
              {timeSeries.map((point, idx) => {
                const barHeight = maxValue > 0 ? (point.quantity / maxValue) * 100 : 0;

                return (
                  <div
                    key={point.date || idx}
                    className="flex-1 flex flex-col items-center group"
                  >
                    {/* Bar */}
                    <div className="w-full flex items-end justify-center" style={{ height: '100%' }}>
                      <div
                        className="w-full max-w-8 rounded-t transition-all hover:opacity-80"
                        style={{
                          height: `${Math.max(barHeight, 2)}%`,
                          backgroundColor: theme.primary,
                        }}
                      />
                    </div>

                    {/* Tooltip */}
                    <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
                        <p className="font-medium">{formatNumber(point.quantity)} units</p>
                        <p className="text-gray-300">{formatShortDate(point.date)}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Y-axis labels */}
            <div className="absolute left-0 top-0 bottom-0 w-12 flex flex-col justify-between text-xs text-gray-400 -ml-14">
              <span>{formatNumber(maxValue)}</span>
              <span>{formatNumber(maxValue / 2)}</span>
              <span>0</span>
            </div>
          </div>
        ) : (
          <div
            style={{ height }}
            className="flex items-center justify-center bg-gray-50 rounded-lg"
          >
            <p className="text-gray-500">No usage data for this period</p>
          </div>
        )}

        {/* X-axis labels */}
        {timeSeries.length > 0 && (
          <div className="flex justify-between mt-2 text-xs text-gray-400">
            <span>{formatShortDate(timeSeries[0]?.date)}</span>
            <span>{formatShortDate(timeSeries[timeSeries.length - 1]?.date)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Summary Card Component
function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-xl font-semibold mt-1" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

// Helper functions
function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatShortDate(dateString: string): string {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
