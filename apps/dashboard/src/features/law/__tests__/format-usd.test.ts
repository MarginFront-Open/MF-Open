/**
 * WHAT THIS FILE DOES: pins that sub-cent AI costs render at full precision
 * instead of collapsing to "$0.00" (the misread the Law tab exists to stop).
 *
 * CONNECTS TO: ../format-usd.ts (under test).
 */

import { formatUsd } from '../format-usd'

describe('formatUsd', () => {
  it('shows sub-cent amounts at 6 decimals, never as $0.00', () => {
    expect(formatUsd(0.000123)).toBe('$0.000123')
  })

  it('follows canon formatCost above a cent (sub-$1 shows 4 decimals)', () => {
    expect(formatUsd(1.25)).toBe('$1.25')
    expect(formatUsd(0.01)).toBe('$0.0100')
    expect(formatUsd(0.5)).toBe('$0.5000')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
