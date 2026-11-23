'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Subscription, SubscriptionDetail, ListSubscriptionsParams } from '@marginfront/sdk';
import { useMarginFrontContext } from '../context';

interface UseSubscriptionsOptions extends Omit<ListSubscriptionsParams, 'customerId'> {
  /** Override customer ID from context */
  customerId?: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UseSubscriptionsReturn {
  /** List of subscriptions */
  subscriptions: Subscription[];
  /** Total count */
  total: number;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch subscriptions */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch customer subscriptions
 *
 * @example
 * ```tsx
 * const { subscriptions, isLoading } = useSubscriptions({
 *   status: 'active'
 * });
 * ```
 */
export function useSubscriptions(options: UseSubscriptionsOptions = {}): UseSubscriptionsReturn {
  const { client, isConnected, customerId: contextCustomerId } = useMarginFrontContext();
  const { customerId = contextCustomerId, enabled = true, status, limit, page } = options;

  // Memoize params to prevent infinite loops
  const params = useMemo(
    () => ({ status, limit, page }),
    [status, limit, page]
  );

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track if initial fetch has happened
  const hasFetched = useRef(false);

  const fetchSubscriptions = useCallback(async () => {
    if (!client || !isConnected) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await client.subscriptions.list({
        ...params,
        customerId: customerId || undefined,
      });

      setSubscriptions(response.subscriptions);
      setTotal(response.totalResults);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch subscriptions'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, customerId, params]);

  const refetch = useCallback(() => fetchSubscriptions(), [fetchSubscriptions]);

  // Fetch only once on mount when connected
  useEffect(() => {
    if (enabled && isConnected && !hasFetched.current) {
      hasFetched.current = true;
      fetchSubscriptions();
    }
  }, [enabled, isConnected]); // Intentionally exclude fetchSubscriptions

  // Reset hasFetched when key dependencies change
  useEffect(() => {
    hasFetched.current = false;
  }, [customerId, params.status, params.limit]);

  return {
    subscriptions,
    total,
    isLoading,
    error,
    refetch,
  };
}

interface UseSubscriptionOptions {
  /** Subscription ID to fetch */
  subscriptionId: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UseSubscriptionReturn {
  /** Subscription details */
  subscription: SubscriptionDetail | null;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch subscription */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch a single subscription by ID
 *
 * @example
 * ```tsx
 * const { subscription, isLoading } = useSubscription({
 *   subscriptionId: 'sub_123'
 * });
 *
 * // Access usage info
 * console.log(subscription?.usage.totalQuantity);
 * ```
 */
export function useSubscription(options: UseSubscriptionOptions): UseSubscriptionReturn {
  const { client, isConnected } = useMarginFrontContext();
  const { subscriptionId, enabled = true } = options;

  const [subscription, setSubscription] = useState<SubscriptionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track if initial fetch has happened
  const hasFetched = useRef(false);

  const fetchSubscription = useCallback(async () => {
    if (!client || !isConnected || !subscriptionId) return;

    try {
      setIsLoading(true);
      setError(null);

      const data = await client.subscriptions.get(subscriptionId);
      setSubscription(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch subscription'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, subscriptionId]);

  const refetch = useCallback(() => fetchSubscription(), [fetchSubscription]);

  // Fetch only once on mount when connected
  useEffect(() => {
    if (enabled && isConnected && subscriptionId && !hasFetched.current) {
      hasFetched.current = true;
      fetchSubscription();
    }
  }, [enabled, isConnected, subscriptionId]); // Intentionally exclude fetchSubscription

  // Reset hasFetched when subscriptionId changes
  useEffect(() => {
    hasFetched.current = false;
  }, [subscriptionId]);

  return {
    subscription,
    isLoading,
    error,
    refetch,
  };
}
