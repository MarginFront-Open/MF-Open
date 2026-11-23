/**
 * WHAT THIS FILE DOES: pins the Law tab registry — the three sub-tabs, the
 * Matters default, and resolveLawTab's fallback for junk `?tab=` values.
 *
 * WHY IT EXISTS: the tab id doubles as a URL contract (deep links); a
 * silently renamed id would strand bookmarks on a blank tab.
 *
 * CONNECTS TO: ../law-tabs.ts (under test), ../index.tsx (the consumer).
 */

import { DEFAULT_LAW_TAB, LAW_TABS, resolveLawTab } from '../law-tabs'

describe('law-tabs registry', () => {
  it('exposes matters | rules | unassigned, with matters as the default', () => {
    expect(LAW_TABS.map((t) => t.id)).toEqual([
      'matters',
      'rules',
      'unassigned',
    ])
    expect(DEFAULT_LAW_TAB).toBe('matters')
  })

  it('resolves known ids and falls back on junk', () => {
    expect(resolveLawTab('rules')).toBe('rules')
    expect(resolveLawTab('unassigned')).toBe('unassigned')
    expect(resolveLawTab(null)).toBe('matters')
    expect(resolveLawTab('close')).toBe('matters')
    expect(resolveLawTab('')).toBe('matters')
  })
})
