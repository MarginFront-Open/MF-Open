'use client'

/**
 * Money → Subscriptions tab. Unlike the other
 * Money tabs (Users/Plans/Invoices, which are lighter previews reusing only
 * the underlying server actions), Subscriptions embeds the SAME table
 * component the standalone `/subscriptions` route renders
 * (SubscriptionsListTable), a full search/filter/paginate/CRUD table, so
 * there's nothing lighter to build. It's the identical component, without
 * the `Page` chrome.
 */
import { SubscriptionsListTable } from '@/features/subscriptions/components/subscriptions-list-table'

export function MoneySubscriptionsTab() {
  return <SubscriptionsListTable />
}
