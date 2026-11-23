/**
 * WHAT THIS FILE DOES: The registry of Law sub-tabs, mirroring
 * finops-tabs.ts / money-tabs.ts / build-tabs.ts. Tab choice lives in `?tab=`
 * (absent = Matters). Pure + framework-free so the fallback behavior is
 * unit-testable in the repo's Node-only jest.
 *
 * WHY IT EXISTS: the Law tab is the matters surface:
 * matters, routing rules, and the always-visible Unassigned bucket.
 *
 * CONNECTS TO: ./index.tsx (renders the tab bar), __tests__/law-tabs.test.ts.
 */

export type LawTabId = 'matters' | 'rules' | 'unassigned'

export interface LawTabDef {
  id: LawTabId
  label: string
}

export const LAW_TABS: readonly LawTabDef[] = [
  { id: 'matters', label: 'Matters' },
  { id: 'rules', label: 'Rules' },
  { id: 'unassigned', label: 'Unassigned' },
]

export const DEFAULT_LAW_TAB: LawTabId = 'matters'

const LAW_TAB_IDS: ReadonlySet<string> = new Set(LAW_TABS.map((tab) => tab.id))

/** Narrows an arbitrary `?tab=` value to a known LawTabId, falling back to
 * the default for anything unrecognized (stale bookmark, typo'd URL). */
export function resolveLawTab(value: string | null): LawTabId {
  if (value !== null && LAW_TAB_IDS.has(value)) return value as LawTabId
  return DEFAULT_LAW_TAB
}
