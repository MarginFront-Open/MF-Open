'use client';

import { useState, useEffect, useCallback } from 'react';
import type { UsageAnalyticsParams, UsageAnalyticsResponse, GroupBy } from '@marginfront/sdk';
import { useMarginFrontContext } from '../context';

interface UseUsageOptions {
  /** Start date (YYYY-MM-DD) */
  startDate?: string;
  /** End date (YYYY-MM-DD) */
  endDate?: string;
  /** Grouping interval */
  groupBy?: GroupBy;
  /** Override customer ID from context */
  customerId?: string;
  /** Agent ID filter */
  agentId?: string;
  /** Signal ID filter */
  signalId?: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UsageSummary {
  totalQuantity: number;
  totalCost: number;
  totalEvents: number;
  uniqueCustomers: number;
  uniqueAgents: number;
  uniqueSignals: number;
  avgQuantity: number;
  avgCost: number;
}

interface UsageTimeSeriesPoint {
  date: string;
  quantity: number;
  cost: number;
  eventCount: number;
}

interface UseUsageReturn {
  /** Usage analytics data */
  data: UsageAnalyticsResponse | null;
  /** Summary stats */
  summary: UsageSummary | null;
  /** Time series data points */
  timeSeries: UsageTimeSeriesPoint[];
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch data */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch usage analytics
 *
 * @example
 * ```tsx
 * const { summary, timeSeries, isLoading } = useUsage({
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31',
 *   groupBy: 'daily'
 * });
 *
 * // Display total usage
 * <p>Total: {summary?.totalQuantity} units</p>
 *
 * // Chart data
 * timeSeries.map(point => ...)
 * ```
 */
export function useUsage(options: UseUsageOptions = {}): UseUsageReturn {
  const { client, isConnected, customerId: contextCustomerId } = useMarginFrontContext();
  const {
    startDate = getDefaultStartDate(),
    endDate = getDefaultEndDate(),
    groupBy = 'daily',
    customerId = contextCustomerId,
    agentId,
    signalId,
    enabled = true,
  } = options;

  const [data, setData] = useState<UsageAnalyticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!client || !isConnected) return;

    try {
      setIsLoading(true);
      setError(null);

      const params: UsageAnalyticsParams = {
        startDate,
        endDate,
        groupBy,
      };

      if (customerId) params.customerId = customerId;
      if (agentId) params.agentId = agentId;
      if (signalId) params.signalId = signalId;

      const response = await client.analytics.usage(params);
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch usage analytics'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, startDate, endDate, groupBy, customerId, agentId, signalId]);

  const refetch = useCallback(() => fetchUsage(), [fetchUsage]);

  // Fetch when connected and when key dependencies change
  useEffect(() => {
    if (enabled && isConnected) {
      fetchUsage();
    }
  }, [enabled, isConnected, startDate, endDate, groupBy, customerId, agentId, signalId, fetchUsage]);

  // Derived data
  const timeSeries = data?.data || [];

  const summary: UsageSummary | null = data?.summary
    ? {
        totalQuantity: data.summary.totalQuantity,
        totalCost: data.summary.totalCost,
        totalEvents: data.summary.totalEvents,
        uniqueCustomers: data.summary.uniqueCustomers,
        uniqueAgents: data.summary.uniqueAgents,
        uniqueSignals: data.summary.uniqueSignals,
        avgQuantity: timeSeries.length > 0
          ? data.summary.totalQuantity / timeSeries.length
          : 0,
        avgCost: timeSeries.length > 0
          ? data.summary.totalCost / timeSeries.length
          : 0,
      }
    : null;

  return {
    data,
    summary,
    timeSeries,
    isLoading,
    error,
    refetch,
  };
}

// Helper functions
function getDefaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().split('T')[0];
}

function getDefaultEndDate(): string {
  return new Date().toISOString().split('T')[0];
}
