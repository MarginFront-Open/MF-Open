/**
 * WHAT THIS FILE DOES: pure rules about a credit pool's burn-rate map
 * (creditRates): the {signalId: creditsPerUnit} object that says
 * which metrics draw from the pool and how hard.
 *
 * WHY IT'S ITS OWN FILE: same reason as rate-input.ts. usePricingOperations
 * imports the server action, which imports better-auth, which the node-only
 * jest slice can't load. Pure helpers live out here so the suite can pin them.
 *
 * CONNECTS TO: hooks/usePricingOperations.ts (change detection on save),
 * __tests__/credit-pool-burn-rates.test.ts (the pins).
 */

/**
 * Order-independent identity of a rates map, for "did this actually change?".
 *
 * An empty map and a null mean the same thing to every reader — absent rates
 * means the pool's own signal burns 1 per unit and nothing else draws — so
 * they fingerprint alike, and a no-op edit doesn't write `{}` over a NULL
 * column. Key order is JSON insertion order, which flips when a member is
 * removed and re-added, so keys are sorted first.
 */
export function creditRatesFingerprint(
  rates: Record<string, number> | null | undefined
): string {
  if (!rates) return ''
  return Object.keys(rates)
    .sort()
    .map((key) => `${key}:${rates[key]}`)
    .join(',')
}
