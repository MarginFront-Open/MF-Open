/**
 * The registry of Needs Attention sub-tabs, mirroring
 * money-tabs.ts / finops-tabs.ts / build-tabs.ts. Pure + framework-free so
 * this repo's node-only jest can assert the `?tab=` contract directly.
 *
 * The ids below are a contract shared with deep links elsewhere in the app;
 * change them together. Unlike the sibling registries the default is
 * data-dependent: no param opens the first tab that actually has rows.
 */

export type NeedsAttentionTabId =
  | 'cost-backfill'
  | 'missing-volume'
  | 'credit-pools'

export interface NeedsAttentionTabDef {
  id: NeedsAttentionTabId
  label: string
}

export const NEEDS_ATTENTION_TABS: readonly NeedsAttentionTabDef[] = [
  { id: 'cost-backfill', label: 'Cost backfill' },
  { id: 'missing-volume', label: 'Missing volume' },
  { id: 'credit-pools', label: 'Credit pools' },
]

export const DEFAULT_NEEDS_ATTENTION_TAB: NeedsAttentionTabId = 'cost-backfill'

export type NeedsAttentionTabCounts = Record<NeedsAttentionTabId, number>

const NEEDS_ATTENTION_TAB_IDS: ReadonlySet<string> = new Set(
  NEEDS_ATTENTION_TABS.map((tab) => tab.id)
)

/** The tab to open when `?tab=` is absent or unusable: first tab with rows,
 * else cost backfill. */
export function defaultNeedsAttentionTab(
  counts: NeedsAttentionTabCounts
): NeedsAttentionTabId {
  const firstWithRows = NEEDS_ATTENTION_TABS.find((tab) => counts[tab.id] > 0)
  return firstWithRows?.id ?? DEFAULT_NEEDS_ATTENTION_TAB
}

/** Narrows an arbitrary `?tab=` query value to a known NeedsAttentionTabId,
 * falling back to the default for anything unrecognized (a stale bookmark or
 * a typo'd URL) rather than rendering a blank tab. */
export function resolveNeedsAttentionTab(
  value: string | null,
  counts: NeedsAttentionTabCounts
): NeedsAttentionTabId {
  if (value !== null && NEEDS_ATTENTION_TAB_IDS.has(value)) {
    return value as NeedsAttentionTabId
  }
  return defaultNeedsAttentionTab(counts)
}
