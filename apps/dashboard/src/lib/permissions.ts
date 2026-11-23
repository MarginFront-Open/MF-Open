/**
 * Permissions and role-based access control utilities
 */

export enum UserRole {
  ADMIN = 'admin',
  MEMBER = 'member',
  OWNER = 'owner',
  // FINANCE is NOT view-only: MANAGE_MONEY_ROLES (owner/admin/finance)
  // lets a finance user write to the
  // books (invoices, pricing, tax, cost classification — see canManageMoney()
  // below). It IS still absent from the SETTINGS_PERMISSIONS maps below,
  // because those gate ORG settings (owner/admin only), not money.
  FINANCE = 'finance',
  // DEVELOPER is the build/operations seat — can write to
  // the BUILD area (agents, customers, signals, API keys — see
  // canManageBuild() below) but has no money or org-settings power.
  DEVELOPER = 'developer',
  // LEGAL is the matter seat — sees the Law tab only. It joins NO
  // capability helper below (no money, build, key, or settings power); its one
  // gate is LAW_MANAGE_ROLES in @marginfront/db.
  LEGAL = 'legal',
}

export interface PermissionConfig {
  allowedRoles: UserRole[]
}

/**
 * Check if a user has permission based on their role
 */
export function hasPermission(
  userRole: string | undefined,
  allowedRoles: readonly UserRole[]
): boolean {
  if (!userRole) return false
  return allowedRoles.includes(userRole.toLowerCase() as UserRole)
}

/**
 * Check if user is admin or owner
 */
export function isAdmin(userRole: string | undefined): boolean {
  return hasPermission(userRole, [UserRole.ADMIN, UserRole.OWNER])
}

/**
 * Check if user is owner
 */
export function isOwner(userRole: string | undefined): boolean {
  return hasPermission(userRole, [UserRole.OWNER])
}

/**
 * Check if user is member (non-admin)
 */
export function isMember(userRole: string | undefined): boolean {
  return hasPermission(userRole, [UserRole.MEMBER])
}

// NOTE: there is deliberately NO isFinance() helper.
// A role-named predicate sitting next to isAdmin()/isOwner() would invite a
// future caller to gate on "is this person finance" rather than "is this
// person allowed to do X" — the wrong question once a role can do SOME things
// but not others. canManageMoney()/canManageBuild() below are CAPABILITY-named
// instead, which is the safe shape: they answer "can this role do X", and stay
// correct even as new roles pick up a subset of an existing capability.

/**
 * Cosmetic-only mirror of MANAGE_MONEY_ROLES (`@marginfront/db`'s org-roles.ts) —
 * owner/admin/finance. Use this to HIDE money-write controls (Mark as Paid,
 * Void, Finalize, etc.) from roles the server would refuse anyway; it does
 * NOT enforce anything itself. The server-side gate (assertMoneyManager /
 * requireRouteRoles(MANAGE_MONEY_ROLES)) is the real lock and must stay in
 * lock-step with this; if the two ever drift, this helper only hides a
 * button that would otherwise get a refusal toast, nothing worse.
 */
export function canManageMoney(userRole: string | undefined): boolean {
  return hasPermission(userRole, [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.FINANCE,
  ])
}

/**
 * Cosmetic-only mirror of MANAGE_BUILD_ROLES (`@marginfront/db`'s org-roles.ts) —
 * owner/admin/developer. Use this to HIDE build-write controls (Create key,
 * Revoke, etc.) from roles the server would refuse anyway; it does NOT
 * enforce anything itself. The server-side gate (assertBuildManager) is the
 * real lock and must stay in lock-step with this; if the two ever drift,
 * this helper only hides a button that would otherwise get a refusal toast,
 * nothing worse.
 */
export function canManageBuild(userRole: string | undefined): boolean {
  return hasPermission(userRole, [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.DEVELOPER,
  ])
}

/**
 * Cosmetic-only mirror of MINT_KEY_ROLES (`@marginfront/db`'s org-roles.ts) —
 * owner/admin/developer/finance. Use this to show/hide the API-key mint and
 * revoke controls. DELIBERATELY WIDER than canManageBuild() by 'finance'
 * because a finance user may mint (and revoke) a
 * finance-scoped key without gaining any other BUILD write — reusing
 * canManageBuild() here would wrongly hide the key controls from finance.
 * The server-side gate (assertKeyMinter) is the real
 * lock and must stay in lock-step with this.
 */
export function canMintKeys(userRole: string | undefined): boolean {
  return hasPermission(userRole, [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.DEVELOPER,
    UserRole.FINANCE,
  ])
}

/**
 * Settings tab permissions.
 *
 * PROFILE and PREFERENCES have NO entry here on purpose: the tab-bar filter in src/features/settings/index.tsx treats a
 * missing key as "no restriction, always visible" — `permission ? hasPermission(...)
 * True`. Every org member manages their OWN profile and theme/notification
 * preferences regardless of role, so an allow-list is the wrong shape for
 * these two: an allow-list has to be updated by hand every time a role is
 * added, and a missed update hides the tab bar from that role. Omitting the
 * entry makes "no restriction" the default, so a new role gets no
 * restriction until one is written.
 *
 * TEAM/BILLING/INTEGRATIONS keep explicit allow-lists — those genuinely ARE
 * admin/owner-only, so an allow-list is the correct shape there.
 */
export const SETTINGS_PERMISSIONS = {
  TEAM: {
    allowedRoles: [UserRole.ADMIN, UserRole.OWNER], // Only admins can manage team
  },
  BILLING: {
    allowedRoles: [UserRole.ADMIN, UserRole.OWNER], // Only admins can manage billing
  },
  INTEGRATIONS: {
    allowedRoles: [UserRole.ADMIN, UserRole.OWNER], // Only admins can manage integrations
  },
} as const

/**
 * Returns only the settings tab keys a given role should see. Kept pure for
 * the same reason as nav-visibility.ts's getVisibleNavItems: this repo's
 * Node-only jest can't render Settings (it depends on
 * useCurrentOrganization/usePathname), but a pure function CAN be unit-tested
 * directly.
 */
export function getVisibleSettingsTabKeys(
  tabKeys: readonly string[],
  userRole: string | undefined
): string[] {
  return tabKeys.filter((key) => {
    const permission =
      SETTINGS_PERMISSIONS[key as keyof typeof SETTINGS_PERMISSIONS]
    return permission ? hasPermission(userRole, permission.allowedRoles) : true
  })
}
