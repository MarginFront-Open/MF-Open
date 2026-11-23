'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Customer } from '@marginfront/sdk';
import { useMarginFrontContext } from '../context';

interface UseCustomerOptions {
  /** Override customer ID from context */
  customerId?: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UseCustomerReturn {
  /** Customer data */
  customer: Customer | null;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch customer */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch customer profile
 *
 * @example
 * ```tsx
 * const { customer, isLoading } = useCustomer();
 *
 * // Or with explicit customer ID
 * const { customer } = useCustomer({ customerId: 'cust_123' });
 * ```
 */
export function useCustomer(options: UseCustomerOptions = {}): UseCustomerReturn {
  const { client, isConnected, customerId: contextCustomerId } = useMarginFrontContext();
  const { customerId = contextCustomerId, enabled = true } = options;

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const hasFetched = useRef(false);

  const fetchCustomer = useCallback(async () => {
    if (!client || !isConnected || !customerId) return;

    try {
      setIsLoading(true);
      setError(null);

      const data = await client.customers.get(customerId);
      setCustomer(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch customer'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, customerId]);

  const refetch = useCallback(() => fetchCustomer(), [fetchCustomer]);

  // Fetch only once on mount when connected
  useEffect(() => {
    if (enabled && isConnected && customerId && !hasFetched.current) {
      hasFetched.current = true;
      fetchCustomer();
    }
  }, [enabled, isConnected, customerId]); // Intentionally exclude fetchCustomer

  // Reset hasFetched when customerId changes
  useEffect(() => {
    hasFetched.current = false;
  }, [customerId]);

  return {
    customer,
    isLoading,
    error,
    refetch,
  };
}
