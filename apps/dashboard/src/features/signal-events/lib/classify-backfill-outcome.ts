/**
 * Decides whether the Map Model and Fill Volume result panels earn green.
 * On a billing surface a false success tells the customer to stop looking
 * while cost stays unattached, so every non-success shape —
 * nothing matched, all-$0.00 against a paid rate, guard-refused children —
 * gets its own outcome.
 *
 * Kept React-free: the dashboard jest harness is node-only, so a component
 * could not exercise these branches.
 */

export type BackfillOutcome =
  | 'success'
  | 'zero_match'
  | 'zero_cost'
  | 'all_refused'
  | 'partial_refused'

export function classifyBackfillOutcome({
  backfilled,
  totalCostUsd,
  targetHasPaidRates,
  refused = 0,
}: {
  backfilled: number
  totalCostUsd: number
  targetHasPaidRates: boolean
  /** Children the price guard declined to price. */
  refused?: number
}): BackfillOutcome {
  // Must stay above zero_match: refused events DID match. "0 events matched"
  // would send the operator to fix the model name when the real fix is to
  // publish a missing rate.
  if (refused > 0) {
    return backfilled === 0 ? 'all_refused' : 'partial_refused'
  }
  if (backfilled === 0) return 'zero_match'
  // $0 against a PAID rate changed nothing billable. $0 against a free rate is
  // the correct price and stays a success.
  if (totalCostUsd === 0 && targetHasPaidRates) return 'zero_cost'
  return 'success'
}
