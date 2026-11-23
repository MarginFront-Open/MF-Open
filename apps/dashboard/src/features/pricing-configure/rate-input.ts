/**
 * WHAT THIS FILE DOES: pure parse/display rules for the $/seat (and signal
 * tier) rate input in PricingTierManager. Decides when a keystroke commits a
 * number to pricing state and how a stored rate renders back into the box.
 *
 * WHY IT EXISTS: a rate input must not map every keystroke
 * straight to a number, with '' forced to 0. That would make the field
 * impossible to clear, turn a typed 0.5 into $5 (the re-render eats the
 * decimal point), and make a real $0 rate look the same as "not entered".
 * These helpers are pure so the node-only jest suite can pin the behavior.
 *
 * CONNECTS TO: components/PricingTierManager.tsx (the input),
 * __tests__/rate-input.test.ts (the pins).
 */

/**
 * Decide whether a raw input string is ready to commit to pricing state.
 * Returns the parsed rate, or null for transient/invalid states ('',
 * negatives, garbage) that should stay local to the input while typing.
 * '0.' commits its integer part (Number('0.') === 0); the draft keeps the
 * dot on screen so the next digit still lands after it.
 */
export function parseRateInput(raw: string): number | null {
  if (raw.trim() === '') return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/**
 * Render a stored rate back into the input. Zero and "not set" both render
 * empty so the 0.00 placeholder shows — same convention as the adjacent
 * minimum-commitment input.
 */
export function displayRate(rate: number | null | undefined): string {
  return rate ? String(rate) : ''
}
