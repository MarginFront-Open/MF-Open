/**
 * WHAT THIS FILE DOES: One USD formatter for the Law tab's cost cells,
 * routing through the canon money formatter (the eslint guard
 * forbids raw .toFixed on money).
 *
 * WHY IT EXISTS: per-token AI events are routinely sub-cent; canon
 * formatCost alone shows 4 decimals under $1, which rounds $0.000123 to
 * "$0.0001". Under a cent the Law tab bumps to the full 6 decimals the
 * schema stores (canon U1), so a billable sub-cent charge never reads as
 * rounding noise. The CSV export carries full precision regardless.
 *
 * CONNECTS TO: @/lib/canon-format (the underlying formatter), the three tab
 * components under ./components/.
 */

import { formatCost } from '@/lib/canon-format'

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return formatCost(amount, 6)
  return formatCost(amount)
}
