'use client';

import { useMarginFrontContext } from '../context';

/**
 * Hook to access the MarginFront client and context
 *
 * @example
 * ```tsx
 * const { client, isConnected, theme } = useMarginFront();
 *
 * if (!isConnected) return <div>Connecting...</div>;
 *
 * // Use client directly
 * const invoices = await client.invoices.list();
 * ```
 */
export function useMarginFront() {
  const context = useMarginFrontContext();

  return {
    /** SDK client instance */
    client: context.client,
    /** Whether connected to API */
    isConnected: context.isConnected,
    /** Whether connecting */
    isConnecting: context.isConnecting,
    /** Connection error */
    error: context.error,
    /** Organization ID */
    orgId: context.orgId,
    /** Customer ID */
    customerId: context.customerId,
    /** Theme configuration */
    theme: context.theme,
  };
}
