import { safeMarginPercent as canonFormatImpl } from '@/lib/canon-format'
import { safeMarginPercent as dbCanonImpl } from '@marginfront/db'

/**
 * Anti-drift lock.
 *
 * canon-format's safeMarginPercent is a hand-port of the canonical one in
 * packages/db/src/lib/revenue-metrics.ts. The client bundle can't import
 * @marginfront/db directly without dragging Prisma + node:fs into the browser
 * (a runtime crash). jest is node, so BOTH impls
 * are importable here — this test asserts they behave identically so the copy
 * can never silently drift from the source of truth.
 */
describe('safeMarginPercent — canon-format port matches @marginfront/db exactly', () => {
  const cases: Array<[number, number]> = [
    [0, 0], // revenue 0 -> null
    [0, 100], // revenue 0, nonzero margin -> still null
    [200, -100], // negative margin -> -50
    [400, 300], // positive -> 75
    [3, 1], // fractional -> 33.333...
    [7, -2], // negative fractional
    [1000, 0], // zero margin on nonzero revenue -> 0 (NOT null)
    [-100, -50], // negative revenue (typed-possible)
  ]

  it.each(cases)(
    'revenue=%d margin=%d — both impls agree',
    (revenue, margin) => {
      expect(canonFormatImpl(revenue, margin)).toBe(
        dbCanonImpl(revenue, margin)
      )
    }
  )

  it('revenue 0 returns null from both (honest dash, canon M2)', () => {
    expect(canonFormatImpl(0, 0)).toBeNull()
    expect(dbCanonImpl(0, 0)).toBeNull()
    expect(canonFormatImpl(0, 500)).toBeNull()
    expect(dbCanonImpl(0, 500)).toBeNull()
  })

  it('negative margin yields a negative percent (not null, not 0)', () => {
    expect(canonFormatImpl(200, -100)).toBe(-50)
    expect(dbCanonImpl(200, -100)).toBe(-50)
  })

  it('fractional values match to full float precision', () => {
    expect(canonFormatImpl(3, 1)).toBe(dbCanonImpl(3, 1))
    expect(canonFormatImpl(3, 1)).toBeCloseTo(33.3333333, 5)
  })
})
