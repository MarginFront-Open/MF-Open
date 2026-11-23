import type { NavGroup } from '../types'

/**
 * WHAT THIS FILE DOES: merges the live unread customer-alert count into the
 * static sidebar data — the MFiQ item gains a red numeric badge when the
 * count is positive, and stays EXACTLY as authored otherwise. Pure so
 * node-jest can pin the merge without rendering (dashboard jest has no RTL).
 * CONNECTS TO: app-sidebar.tsx (the one caller),
 * services/customer-alerts-service.ts (the count),
 * data/sidebar-data.ts (the static input, never mutated).
 */

const MFIQ_URL = '/mfiq'
// Anything past two digits stops informing and starts shouting; the feed
// itself shows the real rows.
const BADGE_CAP = 99

export function formatUnreadBadge(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)
}

/**
 * Returns NEW group/item objects along the MFiQ path (never mutates
 * sidebar-data's module singleton — a mutated singleton would leak a badge
 * into renders that fetched no count). Count <= 0, NaN, or undefined returns
 * the input untouched, so the no-alerts sidebar is the same reference as
 * the static data.
 */
export function mergeUnreadBadge(
  groups: readonly NavGroup[],
  unreadCount: number | undefined
): readonly NavGroup[] {
  if (!unreadCount || !Number.isFinite(unreadCount) || unreadCount <= 0) {
    return groups
  }
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      'url' in item && item.url === MFIQ_URL
        ? {
            ...item,
            badge: formatUnreadBadge(unreadCount),
            badgeVariant: 'destructive' as const,
          }
        : item
    ),
  }))
}
