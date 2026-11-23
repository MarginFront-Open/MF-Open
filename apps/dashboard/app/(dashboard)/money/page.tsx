import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Money from '@/features/money'

export default async function MoneyPageRoute() {
  // Server-side role gate: money screens are owner/admin/finance only.
  // Matches the sidebar's requiredRoles so typing the URL can't bypass the
  // hidden nav (same pattern as finops-settings/page.tsx).
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  return <Money />
}
