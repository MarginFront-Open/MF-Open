import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Finops from '@/features/finops'

export default async function FinopsRoute() {
  // Server-side role gate: money screens are owner/admin/finance only. Matches
  // the sidebar's requiredRoles so typing the URL can't bypass the hidden nav.
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  return <Finops />
}
