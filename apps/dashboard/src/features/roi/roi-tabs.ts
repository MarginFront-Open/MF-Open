/**
 * The registry of ROI child tabs, mirroring build-tabs.ts.
 * Each tab answers one reader question, in the order a reader asks them:
 * did AI pay for itself (Summary), what did we get for it (Finished work),
 * are we on track for what we said we'd hit (Goals).
 *
 * Pure and framework-free, so the resolver is testable without RTL.
 */

export type RoiTabId = 'summary' | 'finished' | 'goals'

export interface RoiTabDef {
  id: RoiTabId
  label: string
}

export const ROI_TABS: readonly RoiTabDef[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'finished', label: 'Finished work' },
  { id: 'goals', label: 'Goals' },
]

export const DEFAULT_ROI_TAB: RoiTabId = 'summary'

const ROI_TAB_IDS: ReadonlySet<string> = new Set(ROI_TABS.map((tab) => tab.id))

/** Narrows an arbitrary `?tab=` query value to a known RoiTabId, falling back
 * to the default for anything unrecognized (a stale bookmark, a typo'd URL, or
 * any unknown tab id) rather than rendering a blank panel. */
export function resolveRoiTab(value: string | null | undefined): RoiTabId {
  if (value !== null && value !== undefined && ROI_TAB_IDS.has(value)) {
    return value as RoiTabId
  }
  return DEFAULT_ROI_TAB
}
