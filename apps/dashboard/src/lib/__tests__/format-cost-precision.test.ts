/**
 * Command Center money formatter precision.
 *
 * Guards the magnitude-aware rule in the canon formatter:
 *   apps/dashboard/src/lib/canon-format.ts — formatCost(n, decimals = 2)
 *
 * Imports the real function: canon-format has no client dependency.
 * formatCost uses the runtime default locale, so these expected strings
 * assume an en-US locale.
 *
 * What this guards: hero tiles call `formatCost(value, 0)`. At a flat 0
 * decimals any positive amount under $0.50 would round to the string "$0", so
 * a first test event costing ~$0.006 would read as "$0". Precision is
 * magnitude-aware so a real positive amount never collapses to "$0", while
 * big whole-dollar tiles stay clean ("$1,234", not "$1,234.0000") and detail
 * rows keep their cents.
 */

import { formatCost as formatCostAtCallSite } from '@/lib/canon-format'

describe('formatCost precision (@/lib/canon-format)', () => {
  // ── The contract (hero tiles pass `, 0`) ─────────────
  it('formatCost(0, 0) → "$0" (true zero stays clean — no "$0.0000")', () => {
    expect(formatCostAtCallSite(0, 0)).toBe('$0')
  })

  it('formatCost(0.006, 0) → "$0.0060" (a sub-cent first event)', () => {
    expect(formatCostAtCallSite(0.006, 0)).toBe('$0.0060')
  })

  it('formatCost(0.0025, 0) → "$0.0025" (sub-cent)', () => {
    expect(formatCostAtCallSite(0.0025, 0)).toBe('$0.0025')
  })

  it('formatCost(12.5, 0) → "$12.50" (under $100 → 2 decimals)', () => {
    expect(formatCostAtCallSite(12.5, 0)).toBe('$12.50')
  })

  it('formatCost(1234.56, 0) → "$1,235" (>= $100 → clean whole-dollar tile)', () => {
    expect(formatCostAtCallSite(1234.56, 0)).toBe('$1,235')
  })

  // ── Sub-dollar band: never reads as "$0" when the value is positive ────────
  it('formatCost(0.5, 0) → "$0.5000" (sub-dollar always shows 4 decimals)', () => {
    expect(formatCostAtCallSite(0.5, 0)).toBe('$0.5000')
  })

  it('formatCost(0.9999, 0) → "$0.9999" (just under a dollar, 4 decimals)', () => {
    expect(formatCostAtCallSite(0.9999, 0)).toBe('$0.9999')
  })

  // ── Band boundaries ───────────────────────────────────────────────────────
  it('formatCost(1, 0) → "$1.00" ($1 is in the 2-decimal band, not sub-dollar)', () => {
    expect(formatCostAtCallSite(1, 0)).toBe('$1.00')
  })

  it('formatCost(99.99, 0) → "$99.99" (still under $100 → 2 decimals)', () => {
    expect(formatCostAtCallSite(99.99, 0)).toBe('$99.99')
  })

  it('formatCost(100, 0) → "$100" ($100 crosses into the whole-dollar band)', () => {
    expect(formatCostAtCallSite(100, 0)).toBe('$100')
  })

  // ── Thousands separators ──────────────────────────────────────────────────
  it('formatCost(1000000, 0) → "$1,000,000" (comma grouping preserved)', () => {
    expect(formatCostAtCallSite(1000000, 0)).toBe('$1,000,000')
  })

  // ── Default `decimals = 2`: detail / breakdown rows keep their cents ───────
  it('formatCost(250) → "$250.00" (default 2 — a $250 row must keep cents)', () => {
    expect(formatCostAtCallSite(250)).toBe('$250.00')
  })

  it('formatCost(1234.56) → "$1,234.56" (default 2 — detail row keeps cents)', () => {
    expect(formatCostAtCallSite(1234.56)).toBe('$1,234.56')
  })

  it('formatCost(0) → "$0.00" (default 2)', () => {
    expect(formatCostAtCallSite(0)).toBe('$0.00')
  })

  // ── Negative amounts: sign follows the $, precision still applies ────────
  it('formatCost(-50, 0) → "$-50.00" (sign untouched, 2-decimal band)', () => {
    expect(formatCostAtCallSite(-50, 0)).toBe('$-50.00')
  })

  it('formatCost(-0.006, 0) → "$-0.0060" (negative sub-dollar still visible)', () => {
    expect(formatCostAtCallSite(-0.006, 0)).toBe('$-0.0060')
  })
})
