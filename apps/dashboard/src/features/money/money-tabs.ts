/**
 * The ONE registry of Money sub-tabs: Breakdown (the landing view), Users,
 * Plans, Subscriptions, Invoices and Simulator. A new tab is a one-line
 * addition here, not a new tab-bar build. Pure + framework-free for RTL-free
 * testing.
 */

export type MoneyTabId =
  | 'breakdown'
  | 'users'
  | 'plans'
  | 'subscriptions'
  | 'invoices'
  | 'simulator'

export interface MoneyTabDef {
  id: MoneyTabId
  label: string
}

export const MONEY_TABS: readonly MoneyTabDef[] = [
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'users', label: 'Users' },
  { id: 'plans', label: 'Plans' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'simulator', label: 'Simulator' },
  // No 'spend-controls' id: spend controls live at /internal-ai-spend, a
  // next.config.ts redirect owns ?tab=spend-controls links, and
  // resolveMoneyTab's fallback covers the rest. Adding the id here would put
  // a tab behind that redirect.
]

export const DEFAULT_MONEY_TAB: MoneyTabId = 'breakdown'

const MONEY_TAB_IDS: ReadonlySet<string> = new Set(
  MONEY_TABS.map((tab) => tab.id)
)

/** Narrows an arbitrary `?tab=` query value to a known MoneyTabId, falling
 * back to the default for anything unrecognized (a stale bookmark, a typo'd
 * URL, or an unknown tab id) rather than rendering a blank tab. */
export function resolveMoneyTab(value: string | null): MoneyTabId {
  if (value !== null && MONEY_TAB_IDS.has(value)) return value as MoneyTabId
  return DEFAULT_MONEY_TAB
}
