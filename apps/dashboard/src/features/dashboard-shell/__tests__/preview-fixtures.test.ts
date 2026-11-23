/**
 * Preview-fixtures.ts data integrity.
 *
 * Three contracts:
 *   1. Every COMPONENT_CATALOG id has a runtime fixture entry. Type-level
 *      completeness is already enforced by preview-fixtures.ts's own
 *      `satisfies Record<ComponentId, object>`, but that only proves the
 *      SHAPE compiles — this is the runtime key-set mirror.
 *   2. The breakdown-table fixture's rows + other reconcile to its own
 *      stated `totals` — the component renders `totals` verbatim and never
 *      re-sums client-side, so the FIXTURE must already satisfy
 *      the invariant it's demonstrating, or the preview would be lying.
 *   3. The category-donut fixture carries a null-key row, so the
 *      "Unassigned" bucket is actually visible in the preview rather than a
 *      silently-dropped orphan.
 */

import { COMPONENT_CATALOG } from '@/lib/component-catalog'
import {
  BREAKDOWN_TABLE_FIXTURE,
  CATALOG_PREVIEW_FIXTURES,
  CATEGORY_DONUT_FIXTURE,
} from '../preview-fixtures'

describe('CATALOG_PREVIEW_FIXTURES — one entry per COMPONENT_CATALOG id', () => {
  it('runtime key set matches COMPONENT_CATALOG exactly', () => {
    expect(Object.keys(CATALOG_PREVIEW_FIXTURES).sort()).toEqual(
      [...COMPONENT_CATALOG].sort()
    )
  })

  it.each(COMPONENT_CATALOG)('%s has a non-empty fixture object', (id) => {
    const fixture = CATALOG_PREVIEW_FIXTURES[id] as object
    expect(fixture).toBeTruthy()
    expect(Object.keys(fixture).length).toBeGreaterThan(0)
  })
})

describe('breakdown-table fixture — rows + other reconcile to the stated totals', () => {
  it('sum(rows.cost) + other.cost === totals.cost', () => {
    const { breakdown, totals } = BREAKDOWN_TABLE_FIXTURE
    const rowSum = breakdown.rows.reduce((sum, row) => sum + row.cost, 0)
    const otherCost = breakdown.other?.cost ?? 0
    expect(rowSum + otherCost).toBe(totals.cost)
  })

  it('sum(rows.eventCount) + other.eventCount === totals.eventCount', () => {
    const { breakdown, totals } = BREAKDOWN_TABLE_FIXTURE
    const rowSum = breakdown.rows.reduce((sum, row) => sum + row.eventCount, 0)
    const otherEventCount = breakdown.other?.eventCount ?? 0
    expect(rowSum + otherEventCount).toBe(totals.eventCount)
  })

  it('totalRowCount accounts for at least every row rendered on this page', () => {
    const { breakdown } = BREAKDOWN_TABLE_FIXTURE
    // totalRowCount (6) = 5 shown rows + 1 folded into "other" on this
    // fixture's page — never fewer than what's actually rendered.
    expect(breakdown.totalRowCount).toBeGreaterThanOrEqual(
      breakdown.rows.length
    )
  })
})

describe('category-donut fixture — includes a null-key row', () => {
  it('at least one row has key: null (the "Unassigned" bucket)', () => {
    expect(CATEGORY_DONUT_FIXTURE.rows.some((row) => row.key === null)).toBe(
      true
    )
  })

  it('resolveLabel renders the null-key row as "Unassigned", never blank or dropped', () => {
    const nullRow = CATEGORY_DONUT_FIXTURE.rows.find((row) => row.key === null)
    expect(nullRow).toBeDefined()
    expect(CATEGORY_DONUT_FIXTURE.resolveLabel?.(nullRow!.key)).toBe(
      'Unassigned'
    )
  })
})
