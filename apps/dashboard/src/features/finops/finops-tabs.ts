/**
 * The registry of FinOps sub-tabs, mirroring money-tabs.ts and build-tabs.ts.
 * "Close" is the FinOps close surface (the default); "Cost management" and
 * "Settings" hold the /cost-management and /finops-settings content, and
 * those routes 307-redirect to `?tab=`. Pure + framework-free for RTL-free
 * testing.
 */

export type FinopsTabId = 'close' | 'cost-management' | 'settings'

export interface FinopsTabDef {
  id: FinopsTabId
  label: string
}

export const FINOPS_TABS: readonly FinopsTabDef[] = [
  { id: 'close', label: 'Close' },
  { id: 'cost-management', label: 'Cost management' },
  { id: 'settings', label: 'Settings' },
]

export const DEFAULT_FINOPS_TAB: FinopsTabId = 'close'

const FINOPS_TAB_IDS: ReadonlySet<string> = new Set(
  FINOPS_TABS.map((tab) => tab.id)
)

/** Narrows an arbitrary `?tab=` query value to a known FinopsTabId, falling
 * back to the default for anything unrecognized (a stale bookmark or a typo'd
 * URL) rather than rendering a blank tab. */
export function resolveFinopsTab(value: string | null): FinopsTabId {
  if (value !== null && FINOPS_TAB_IDS.has(value)) return value as FinopsTabId
  return DEFAULT_FINOPS_TAB
}
