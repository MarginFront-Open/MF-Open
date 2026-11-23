import { storage } from '@/lib/storage'

// The ONE money/percent formatter for the dashboard. Use it instead of a local
// helper or a raw toFixed, so the same number renders the same way everywhere.

const ORG_CURRENCY_KEY = 'org_currency'
const DEFAULT_CURRENCY = 'USD'

function resolveCurrency(explicit?: string): string {
  return explicit || storage.getItem(ORG_CURRENCY_KEY) || DEFAULT_CURRENCY
}

/**
 * Fixed-precision, org-currency money — for tiles, tables, and invoice figures.
 * Uses the org currency from storage at fixed decimals. A `currency`
 * argument overrides the org currency.
 */
export function formatCurrency(
  amount: number | string,
  currency?: string,
  precision = 2
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: resolveCurrency(currency),
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(Number(amount))
}

/**
 * Magnitude-aware cost for per-event / per-task amounts (canon rule):
 * a sub-$1 amount shows up to 4 decimals so a $0.006 event never renders as
 * "$0"; with decimals=0, $100+ rounds to whole dollars for the clean-tile
 * look. With decimals=0:
 *
 *   0        → "$0"
 *   0.006    → "$0.0060"
 *   12.50    → "$12.50"
 *   1234.56  → "$1,235"
 *
 * Always $-prefixed: unlike formatCurrency, it ignores the org currency.
 */
export function formatCost(n: number, decimals = 2): string {
  const magnitude = Math.abs(n)
  const minDecimals =
    magnitude === 0 ? 0 : magnitude < 1 ? 4 : magnitude < 100 ? 2 : 0
  const fractionDigits = Math.max(decimals, minDecimals)
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`
}

/**
 * Percent where null renders as "—" (canon M1): a revenue=0 entity shows an
 * honest dash, never a misleading "0.0%".
 */
export function formatPct(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(1)}%`
}

/**
 * Per-1M-token catalog RATE, shown to natural precision (min 2, up to 4 decimals,
 * trailing zeros trimmed): $10.00 / $1.25 / $0.125 / $0.0435. formatCost is wrong
 * for rates — it forces 4 decimals on every sub-$1 value ($0.435 → "$0.4350"),
 * which misreads a published rate. Rates are still money, so they route through
 * this one canon helper rather than a hand-rolled template.
 */
export function formatRate(ratePerMillion: number): string {
  return `$${ratePerMillion.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`
}

/**
 * Client-safe margin percent (canon M2): null when revenue is 0 so a
 * cost-only entity shows an honest "—", never a fake 0%.
 *
 * This is a byte-faithful port of the canonical safeMarginPercent in
 * packages/db/src/lib/revenue-metrics.ts. It lives here — NOT imported from
 * @marginfront/db — because that package is a single-entry CJS bundle whose index
 * reaches the Prisma client and node built-ins (node:fs). A `'use client'`
 * file that value-imports it drags that whole chain into the browser bundle,
 * which crashes at runtime with "Cannot find module node:fs". canon-format.ts
 * is the sanctioned home for client-side money/percent math (the eslint canon
 * rule scopes its hand-rolled-percent ban to app/actions only). The two
 * implementations are kept in lockstep by a parity test that imports BOTH and
 * asserts identical behavior — break this and that test goes red.
 */
export function safeMarginPercent(
  revenue: number,
  margin: number
): number | null {
  if (revenue === 0) return null
  return (margin / revenue) * 100
}

/**
 * Client-safe C1 event-cost fold (canon C1a): null cost adds 0, still counts,
 * and increments eventsMissingCost — never silently zeroed.
 *
 * Byte-faithful port of the canonical rollupEventCosts in
 * packages/db/src/lib/canon-math.ts, living here for the same reason
 * safeMarginPercent above does: a src/** value import of @marginfront/db drags
 * Prisma + node:fs toward the browser bundle (see that function's comment).
 * Kept in lockstep by canon-format-rollup-parity.test.ts, which imports BOTH
 * and asserts identical output — break this and that test goes red.
 */
export interface EventCostRollup {
  cost: number
  eventCount: number
  eventsMissingCost: number
}

export function rollupEventCosts(
  events: ReadonlyArray<{ usageCost: number | null }>
): EventCostRollup {
  let cost = 0
  let eventsMissingCost = 0
  for (const ev of events) {
    if (ev.usageCost === null) {
      eventsMissingCost += 1
    } else {
      cost += ev.usageCost
    }
  }
  return { cost, eventCount: events.length, eventsMissingCost }
}
