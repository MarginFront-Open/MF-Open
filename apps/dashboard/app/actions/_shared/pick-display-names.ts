/**
 * Choose the org-facing spelling for each canonical model id. An org can pay
 * for one model under several catalog spellings
 * ('claude-opus-4.1' and 'claude-opus-4-1-20250805' both remap to
 * 'anthropic/claude-opus-4-1'); the card names the incumbent by the spelling
 * carrying the MOST of the org's window spend — the spelling the customer
 * actually uses — with lexicographic order only as the final tie-break on equal
 * spend so the pick can never go nondeterministic.
 *
 * Pure and DB-free so the tie-break is unit-testable outside the 'use server'
 * action (which cannot export sync helpers).
 */
export function pickDisplayNames(
  spendBySpelling: ReadonlyMap<string, ReadonlyMap<string, number>>
): Map<string, string> {
  const picked = new Map<string, string>()
  for (const [canonicalId, spellings] of spendBySpelling) {
    let bestName: string | null = null
    let bestSpendUsd = -Infinity
    for (const [name, spendUsd] of spellings) {
      if (
        spendUsd > bestSpendUsd ||
        (spendUsd === bestSpendUsd && bestName !== null && name < bestName)
      ) {
        bestName = name
        bestSpendUsd = spendUsd
      }
    }
    if (bestName !== null) picked.set(canonicalId, bestName)
  }
  return picked
}
