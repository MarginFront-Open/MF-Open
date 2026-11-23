import { LAW_MANAGE_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Law from '@/features/law'

export default async function LawRoute() {
  // Server-side role gate: the Law tab is owner/admin/finance/legal only.
  // Matches the sidebar's requiredRoles so typing the URL can't bypass the
  // hidden nav.
  await requireRouteRoles(LAW_MANAGE_ROLES)

  return <Law />
}
