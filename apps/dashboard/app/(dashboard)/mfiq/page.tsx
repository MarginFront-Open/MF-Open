import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Mfiq from '@/features/mfiq'

export default async function MfiqRoute() {
  // Money-gated: the page's center of gravity is finance
  // state — close status, GL mapping, account types, margin.
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  return <Mfiq />
}
