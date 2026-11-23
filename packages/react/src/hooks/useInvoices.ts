'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Invoice, InvoiceDetail, ListInvoicesParams } from '@marginfront/sdk';
import { useMarginFrontContext } from '../context';

interface UseInvoicesOptions extends Omit<ListInvoicesParams, 'customerId'> {
  /** Override customer ID from context */
  customerId?: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UseInvoicesReturn {
  /** List of invoices */
  invoices: Invoice[];
  /** Total count */
  total: number;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch invoices */
  refetch: () => Promise<void>;
  /** Fetch next page */
  fetchNextPage: () => Promise<void>;
  /** Has more pages */
  hasMore: boolean;
}

/**
 * Hook to fetch customer invoices
 *
 * @example
 * ```tsx
 * const { invoices, isLoading, refetch } = useInvoices({
 *   status: 'pending',
 *   limit: 10
 * });
 * ```
 */
export function useInvoices(options: UseInvoicesOptions = {}): UseInvoicesReturn {
  const { client, isConnected, customerId: contextCustomerId } = useMarginFrontContext();
  const { customerId = contextCustomerId, enabled = true, limit, status, page: initialPage } = options;

  // Memoize params to prevent infinite loops - only re-create when values actually change
  const params = useMemo(
    () => ({ limit, status, page: initialPage }),
    [limit, status, initialPage]
  );

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // Track if initial fetch has happened to prevent double-fetching
  const hasFetched = useRef(false);

  const fetchInvoices = useCallback(async (pageNum: number = 1, append: boolean = false) => {
    if (!client || !isConnected) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await client.invoices.list({
        ...params,
        customerId: customerId || undefined,
        page: pageNum,
      });

      if (append) {
        setInvoices((prev) => [...prev, ...response.invoices]);
      } else {
        setInvoices(response.invoices);
      }

      setTotal(response.totalResults);
      setHasMore(response.invoices.length === (params.limit || 20));
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch invoices'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, customerId, params]);

  const refetch = useCallback(() => fetchInvoices(1, false), [fetchInvoices]);

  const fetchNextPage = useCallback(() => {
    if (hasMore && !isLoading) {
      return fetchInvoices(page + 1, true);
    }
    return Promise.resolve();
  }, [fetchInvoices, hasMore, isLoading, page]);

  // Fetch only once on mount when connected
  useEffect(() => {
    if (enabled && isConnected && !hasFetched.current) {
      hasFetched.current = true;
      fetchInvoices(1, false);
    }
  }, [enabled, isConnected]); // Intentionally exclude fetchInvoices to prevent re-fetching

  // Reset hasFetched when key dependencies change (to allow refetching)
  useEffect(() => {
    hasFetched.current = false;
  }, [customerId, params.status, params.limit]);

  return {
    invoices,
    total,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasMore,
  };
}

interface UseInvoiceOptions {
  /** Invoice ID to fetch */
  invoiceId: string;
  /** Auto-fetch on mount */
  enabled?: boolean;
}

interface UseInvoiceReturn {
  /** Invoice details */
  invoice: InvoiceDetail | null;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch invoice */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch a single invoice by ID
 *
 * @example
 * ```tsx
 * const { invoice, isLoading } = useInvoice({ invoiceId: 'inv_123' });
 * ```
 */
export function useInvoice(options: UseInvoiceOptions): UseInvoiceReturn {
  const { client, isConnected } = useMarginFrontContext();
  const { invoiceId, enabled = true } = options;

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track if initial fetch has happened
  const hasFetched = useRef(false);

  const fetchInvoice = useCallback(async () => {
    if (!client || !isConnected || !invoiceId) return;

    try {
      setIsLoading(true);
      setError(null);

      const data = await client.invoices.get(invoiceId);
      setInvoice(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch invoice'));
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, invoiceId]);

  const refetch = useCallback(() => fetchInvoice(), [fetchInvoice]);

  // Fetch only once on mount when connected
  useEffect(() => {
    if (enabled && isConnected && invoiceId && !hasFetched.current) {
      hasFetched.current = true;
      fetchInvoice();
    }
  }, [enabled, isConnected, invoiceId]); // Intentionally exclude fetchInvoice

  // Reset hasFetched when invoiceId changes
  useEffect(() => {
    hasFetched.current = false;
  }, [invoiceId]);

  return {
    invoice,
    isLoading,
    error,
    refetch,
  };
}
