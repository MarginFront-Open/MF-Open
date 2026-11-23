/**
 * WHAT THIS FILE DOES: Decides which sidebar nav items a given user can SEE,
 *   based on the user's role. It's the plain, side-effect-free brain behind
 *   the sidebar — give it the list of items and the user's role, and it hands
 *   back only the items that should appear.
 *
 * WHY IT EXISTS: the "FinOps" section is hidden unless you're
 *   finance/admin/owner. The rule lives here, not inline in
 *   nav-group.tsx, because this repo's jest runs in a Node environment and
 *   can't render the real React component (it leans on useSidebar/useAuth).
 *   A pure function CAN be unit-tested directly. nav-group.tsx is its single
 *   caller.
 *
 * CONNECTS TO:
 *   - src/components/layout/nav-group.tsx (the only caller; passes the live
 *     role and renders whatever this returns)
 *   - src/components/layout/types.ts (NavItem / requiredRoles)
 *   - src/components/layout/__tests__/nav-visibility.test.ts (the unit test)
 *
 * IMPORTANT: This is a VISIBILITY rule, not a security boundary. Hiding a nav
 *   item here does NOT stop someone from typing the URL; the server-side gates
 *   (requireRouteRoles and the server actions) are the security boundary.
 */

import type { NavItem } from './types'

/**
 * Returns only the nav items the user should see.
 *
 * ROLE gate: if an item names `requiredRoles`, the user's role must be in
 * that list (compared lower-cased) or the item is hidden.
 */
export function getVisibleNavItems(
  items: NavItem[],
  role: string | undefined
): NavItem[] {
  // Normalize the role once. Undefined/empty falls back to 'member' so an
  // un-resolved user is treated as the least-privileged real role.
  const normalizedRole = (role ?? 'member').toLowerCase()

  return items.filter((item) => {
    if (
      item.requiredRoles &&
      !item.requiredRoles.map((r) => r.toLowerCase()).includes(normalizedRole)
    ) {
      return false
    }
    return true
  })
}

/**
 * Resolves the LOGGED-IN user's role from the org's member list.
 *
 * WHY THIS EXISTS: the sidebar must gate on the role of the person actually
 * viewing it, looked up by session user id (not the org creator's role).
 * use-auth.ts resolves through this same function, so the two agree by
 * construction.
 *
 * Falls back to 'member' (least privilege) when there's no match yet — session
 * or membership still loading, or the user simply isn't in the active org's
 * list. Kept here (a pure function) so the Node-only jest harness can test the
 * lookup directly, the same reason getVisibleNavItems lives here.
 */
export function resolveCurrentUserRole(
  members:
    | ReadonlyArray<{ userId?: string | null; role?: string | null }>
    | null
    | undefined,
  currentUserId: string | null | undefined
): string {
  if (!members || !currentUserId) return 'member'
  const ownMembership = members.find((m) => m.userId === currentUserId)
  return ownMembership?.role ?? 'member'
}
