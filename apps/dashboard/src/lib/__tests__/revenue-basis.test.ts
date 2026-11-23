/**
 * BASIS + HONEST-NULL (pure, no DB).
 *
 * Proves the definable set and its labels: agent/signal → 'earned' → "Earned",
 * customer/plan → 'billed' → "Billed", and every non-definable dimension
 * (model/environment/day/costCategory) → null so the UI renders '—' (canon M2)
 * instead of a fabricated per-bucket revenue.
 */

import { revenueBasisForDimension, revenueColumnLabel } from '../revenue-basis'
import { DIMENSION_REGISTRY, type Dimension } from '@/lib/component-catalog'

describe('revenueBasisForDimension — the definable set (BASIS)', () => {
  it('agent and signal are Earned', () => {
    expect(revenueBasisForDimension('agent')).toBe('earned')
    expect(revenueBasisForDimension('signal')).toBe('earned')
  })

  it('customer and plan are Billed', () => {
    expect(revenueBasisForDimension('customer')).toBe('billed')
    expect(revenueBasisForDimension('plan')).toBe('billed')
  })
})

describe('revenueBasisForDimension — non-definable dimensions (HONEST-NULL)', () => {
  it.each<Dimension>(['model', 'environment', 'day', 'costCategory'])(
    '%s has no revenue basis (renders "—", never fabricated)',
    (dimension) => {
      expect(revenueBasisForDimension(dimension)).toBeNull()
    }
  )

  it('every dimension in the registry resolves to a basis or null — no throw, no gap', () => {
    for (const dimension of DIMENSION_REGISTRY) {
      const basis = revenueBasisForDimension(dimension)
      expect(basis === null || basis === 'earned' || basis === 'billed').toBe(
        true
      )
    }
  })
})

describe('revenueColumnLabel — the column header text', () => {
  it('earned → "Earned", billed → "Billed"', () => {
    expect(revenueColumnLabel('earned')).toBe('Earned')
    expect(revenueColumnLabel('billed')).toBe('Billed')
  })
})
