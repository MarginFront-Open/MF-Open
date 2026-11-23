/**
 * Answers, BEFORE the operator commits a mapping, whether the pricing row they
 * picked can price the events they picked it for. Judging that from input and
 * output rates alone reads a row with no cache rate as fully priced, and prompt
 * cache is most of an Anthropic bill.
 *
 * This must agree with `resolveEventPrice` (packages/db/src/lib/model-pricing.ts),
 * which is the authority that actually refuses; disagreement means the dialog
 * warns about mappings that work or stays quiet about ones that do not. The
 * agreement is pinned in __tests__/find-missing-cache-rates.test.ts.
 */

/** Same union `resolveEventPrice` reports in `missingRates`. */
export type UnpricedCacheRate = 'cacheReadCost' | 'cacheWriteCost'

/**
 * Only the "1M tokens" branch prices cache at all — every other cost unit
 * returns a hard $0 for cache whatever counts it is handed, so its total is
 * already correct and warning there would be noise. Most active "1M tokens"
 * rows carry no cacheWriteCost, so the check must also key on a positive
 * token count or it fires on nearly every mapping and gets ignored.
 */
const CACHE_PRICING_COST_UNIT = '1M tokens'

export function findMissingCacheRates({
  costUnit,
  cacheReadCost,
  cacheWriteCost,
  cacheReadTokens,
  cacheWriteTokens,
}: {
  costUnit: string | null
  cacheReadCost: number | null
  cacheWriteCost: number | null
  /** Summed over the events about to be mapped. */
  cacheReadTokens: number
  cacheWriteTokens: number
}): UnpricedCacheRate[] {
  if (costUnit !== CACHE_PRICING_COST_UNIT) return []

  const missing: UnpricedCacheRate[] = []
  // `== null`, not falsy: a stored 0 is a real, free rate that prices fine.
  // Only an absent rate is unpriceable.
  if (cacheReadTokens > 0 && cacheReadCost == null)
    missing.push('cacheReadCost')
  if (cacheWriteTokens > 0 && cacheWriteCost == null) {
    missing.push('cacheWriteCost')
  }
  return missing
}

/** The rate names are column names; this is what the dialog says instead. */
export function describeMissingCacheRates(
  // string[], not UnpricedCacheRate[], so callers can pass the action's
  // untyped `refusedRates` through without a cast.
  missing: readonly string[]
): string {
  const read = missing.includes('cacheReadCost')
  const write = missing.includes('cacheWriteCost')
  if (read && write) return 'reading from and writing to the cache'
  if (read) return 'reading from the cache'
  return 'writing to the cache'
}
