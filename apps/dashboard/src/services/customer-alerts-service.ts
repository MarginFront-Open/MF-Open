/**
 * The polled unread count behind the red MFiQ sidebar badge. React Query
 * polls every 60s: an alert badge needs no faster refresh, and each tick is
 * one indexed COUNT per session.
 * The count comes from app/actions/customer-alert-notifications.ts,
 * components/layout/app-sidebar.tsx renders it, and features/mfiq/index.tsx
 * invalidates this key after mark-read so the badge clears immediately.
 */

import { useQuery } from '@tanstack/react-query'
import { getUnreadCustomerAlertCount } from '@/app/actions/customer-alert-notifications'

export const UNREAD_CUSTOMER_ALERT_QUERY_KEY = [
  'customer-alerts',
  'unread-count',
] as const

const POLL_MS = 60_000

export function useUnreadCustomerAlertCount() {
  return useQuery({
    queryKey: UNREAD_CUSTOMER_ALERT_QUERY_KEY,
    queryFn: async () => {
      const result = await getUnreadCustomerAlertCount()
      return result.count
    },
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    // A failed poll shows no badge rather than a stale or broken nav.
    retry: false,
  })
}
