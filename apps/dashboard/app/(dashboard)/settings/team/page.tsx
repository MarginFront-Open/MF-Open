import { ORG_MANAGE_ROLES } from '@marginfront/db'
import { requireRouteRoles } from '@/app/lib/require-route-roles'
import Settings from '@/features/settings'
import TeamSettings from '@/features/settings/team'

// Org-management settings are owner/admin only (ORG_MANAGE_ROLES). This server
// wrapper enforces that before rendering the client feature — matching the
// sidebar's SETTINGS_PERMISSIONS.TEAM gate so the URL can't bypass it. The
// gate runs before the Settings shell mounts (no intermediate client layout
// in the way), so a denied role redirects cleanly to /403 instead of the
// shell starting to stream first. Each settings route wraps itself in the
// Settings shell.
export default async function TeamSettingsRoute() {
  await requireRouteRoles(ORG_MANAGE_ROLES)
  return (
    <Settings>
      <TeamSettings />
    </Settings>
  )
}
