import { MANAGE_MONEY_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import InternalAiSpend from '@/features/internal-ai-spend'

export default async function InternalAiSpendPageRoute() {
  // Server-side role gate with the money screens' allow-list. Matches the
  // sidebar's requiredRoles so typing the URL can't bypass the hidden nav
  // (same pattern as money/page.tsx).
  await requireRouteRoles(MANAGE_MONEY_ROLES)

  return <InternalAiSpend />
}
