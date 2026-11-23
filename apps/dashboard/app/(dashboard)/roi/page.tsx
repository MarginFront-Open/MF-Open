import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Roi from '@/features/roi'

export default async function RoiRoute() {
  // Server-side role gate: ROI cards render
  // revenue/margin actuals — money numbers, the same class Money/FinOps
  // gate — and every initiative write is already finance/admin/owner.
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  return <Roi />
}
