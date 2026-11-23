import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import InitiativeDetail from '@/features/roi/detail'

export default async function RoiInitiativeRoute({
  params,
}: {
  params: Promise<{ initiativeId: string }>
}) {
  // Same server-side role gate as /roi: the
  // detail renders revenue/margin actuals — money numbers, the class
  // Money/FinOps gate.
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  const { initiativeId } = await params
  return <InitiativeDetail initiativeId={initiativeId} />
}
