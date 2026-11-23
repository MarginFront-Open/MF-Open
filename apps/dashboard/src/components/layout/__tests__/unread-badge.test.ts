/**
 * The sidebar badge merge, pinned in node jest (no RTL — the
 * render path is Playwright's job; the MERGE is the logic that can rot):
 *   1. Zero/undefined/garbage counts return the input UNTOUCHED (referential
 *      identity, so the no-alerts sidebar is the static sidebar unchanged).
 *   2. A positive count decorates EXACTLY the MFiQ item: red variant, the
 *      count as the badge string.
 *   3. The static sidebar-data singleton is never mutated (a leaked mutation
 *      would badge renders that fetched no count).
 *   4. 99+ cap.
 */

import { mergeUnreadBadge, formatUnreadBadge } from '../data/unread-badge'
import { sidebarData } from '../data/sidebar-data'
import type { NavGroup } from '../types'

function findMfiq(groups: readonly NavGroup[]) {
  for (const g of groups) {
    for (const item of g.items) {
      if ('url' in item && item.url === '/mfiq') return item
    }
  }
  return null
}

describe('mergeUnreadBadge', () => {
  it('count 0 / undefined / NaN / negative returns the SAME array reference', () => {
    for (const count of [0, undefined, NaN, -3]) {
      expect(mergeUnreadBadge(sidebarData.navGroups, count as number)).toBe(
        sidebarData.navGroups
      )
    }
  })

  it('a positive count badges the MFiQ item red with the count', () => {
    const merged = mergeUnreadBadge(sidebarData.navGroups, 3)
    const mfiq = findMfiq(merged)
    expect(mfiq).not.toBeNull()
    expect(mfiq!.badge).toBe('3')
    expect(mfiq!.badgeVariant).toBe('destructive')
  })

  it('every non-MFiQ item is untouched (same object references)', () => {
    const merged = mergeUnreadBadge(sidebarData.navGroups, 5)
    for (let g = 0; g < sidebarData.navGroups.length; g++) {
      const original = sidebarData.navGroups[g].items
      const mergedItems = merged[g].items
      for (let i = 0; i < original.length; i++) {
        const item = original[i]
        if ('url' in item && item.url === '/mfiq') continue
        expect(mergedItems[i]).toBe(item)
      }
    }
  })

  it('NEVER mutates the static sidebar-data singleton', () => {
    mergeUnreadBadge(sidebarData.navGroups, 7)
    const mfiq = findMfiq(sidebarData.navGroups)
    expect(mfiq).not.toBeNull()
    expect(mfiq!.badge).toBeUndefined()
    expect(mfiq!.badgeVariant).toBeUndefined()
  })

  it('the sidebar actually HAS an MFiQ item to badge (wiring sanity)', () => {
    expect(findMfiq(sidebarData.navGroups)).not.toBeNull()
  })
})

describe('formatUnreadBadge', () => {
  it('caps three-digit counts at 99+', () => {
    expect(formatUnreadBadge(3)).toBe('3')
    expect(formatUnreadBadge(99)).toBe('99')
    expect(formatUnreadBadge(100)).toBe('99+')
    expect(formatUnreadBadge(1500)).toBe('99+')
  })
})
