/**
 * Which revenue basis (if any) a breakdown dimension
 * can be attributed to. PURE and client-safe: no Prisma, no DB, no server-only
 * imports, so both the resolver (server) and the breakdown table/donut
 * (client) read the same source of truth for column labels and gating.
 *
 *   'earned' — agent + signal: per-event usage earnings (events × pricing
 *              rate via calcRouted). Attributes to the entity that did the
 *              work. Matches the XLSX Agent/Task Earned columns.
 *   'billed' — customer + plan: invoice totals (SUM of invoice.totalAmount).
 *              Attributes to who/what got invoiced. Matches the XLSX
 *              Customer/Plan Billed columns.
 *   null     — model, environment, day, costCategory: NO honest per-bucket
 *              revenue exists. Per-model revenue in the XLSX is cost-share
 *              ALLOCATED (≈ fabrication) and its cost grouping (payload.model)
 *              already diverges from the Service-sheet pricing model;
 *              day/environment/category map to no revenue source at all.
 *              The UI renders '—' (canon M2), never a fabricated number.
 */

import type { Dimension } from '@/lib/component-catalog'

export type RevenueBasis = 'earned' | 'billed'

const EARNED_DIMENSIONS: ReadonlySet<Dimension> = new Set<Dimension>([
  'agent',
  'signal',
])
const BILLED_DIMENSIONS: ReadonlySet<Dimension> = new Set<Dimension>([
  'customer',
  'plan',
])

/**
 * The revenue basis for a dimension, or null when revenue is not
 * canon-definable for it. The ONE place the definable set is declared —
 * resolver gating, column visibility, and the donut toggle all read it so a
 * new definable dimension is a single-line change here.
 */
export function revenueBasisForDimension(
  dimension: Dimension
): RevenueBasis | null {
  if (EARNED_DIMENSIONS.has(dimension)) return 'earned'
  if (BILLED_DIMENSIONS.has(dimension)) return 'billed'
  return null
}

/** The table/donut column header for a basis. Earned vs Billed is a real
 * semantic distinction (activity vs invoicing), not cosmetic — the tooltip
 * spells it out. */
export function revenueColumnLabel(basis: RevenueBasis): string {
  return basis === 'earned' ? 'Earned' : 'Billed'
}
