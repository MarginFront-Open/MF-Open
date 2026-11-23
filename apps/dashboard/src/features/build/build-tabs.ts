/**
 * The registry of Build sub-tabs, mirroring
 * money-tabs.ts. Build's agents content (table, event stream, KPI tiles)
 * is the "Agents" tab; "API keys" holds the keys (keys are org-level,
 * not agent-tied, so they get a tab of their own); "Simulator" embeds the
 * SDK Simulator feature. Pure + framework-free for RTL-free testing.
 */

export type BuildTabId = 'agents' | 'keys' | 'simulator'

export interface BuildTabDef {
  id: BuildTabId
  label: string
}

export const BUILD_TABS: readonly BuildTabDef[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'keys', label: 'API keys' },
  { id: 'simulator', label: 'Simulator' },
]

export const DEFAULT_BUILD_TAB: BuildTabId = 'agents'

const BUILD_TAB_IDS: ReadonlySet<string> = new Set(
  BUILD_TABS.map((tab) => tab.id)
)

/** Narrows an arbitrary `?tab=` query value to a known BuildTabId, falling
 * back to the default for anything unrecognized (a stale bookmark, a typo'd
 * URL, or an unknown tab id) rather than rendering a blank tab. */
export function resolveBuildTab(value: string | null): BuildTabId {
  if (value !== null && BUILD_TAB_IDS.has(value)) return value as BuildTabId
  return DEFAULT_BUILD_TAB
}
