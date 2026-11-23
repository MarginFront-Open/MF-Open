'use client'

/**
 * Standalone `/subscriptions` route. The actual list (search, filter,
 * paginate, create/edit/delete) lives in SubscriptionsListTable
 * (components/subscriptions-list-table.tsx) — this file only adds the `Page`
 * chrome. Money's Subscriptions tab embeds the
 * same SubscriptionsListTable directly, without Page, so the two surfaces
 * never fork.
 */
import { Page } from '@/components/layouts/page'
import { SubscriptionsListTable } from './components/subscriptions-list-table'

export default function Subscriptions() {
  return (
    <Page
      title='Subscriptions'
      description="Connects a customer to an agent's pricing plan."
      headerProps={{
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Subscriptions' }],
      }}
    >
      <SubscriptionsListTable />
    </Page>
  )
}
