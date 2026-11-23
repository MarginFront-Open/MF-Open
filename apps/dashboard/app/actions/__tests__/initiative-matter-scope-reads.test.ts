/**
 * The pure half of a matter-scoped ROI initiative: the read
 * mapping in _shared/initiative-metric-values.ts.
 *
 * Under a matter scope only the cost family is answerable, because the one
 * matter-aware aggregator (getMatterCostRollups, canon C1) returns cost and
 * event count and nothing else. Every other metric is null — the honest dash
 * (canon M2), never a zero that reads like a measurement of the matter.
 * No fetching here, so no database: the rollup arrives as a plain value.
 */

import {
  actualForMetric,
  matterScopedReads,
  NO_READS,
} from '../_shared/initiative-metric-values'
import type { InitiativeMetric } from '../initiatives'

describe('matterScopedReads — only the cost family survives a matter scope', () => {
  const ROLLUP = { cost: 412.5, eventCount: 30 }

  it('cost, eventCount and costPerTask come from the matter rollup', () => {
    const reads = matterScopedReads(ROLLUP)
    expect(actualForMetric('cost', reads)).toBe(412.5)
    expect(actualForMetric('eventCount', reads)).toBe(30)
    expect(actualForMetric('costPerTask', reads)).toBeCloseTo(412.5 / 30, 9)
  })

  it('every other metric is null — never 0 under a matter scope', () => {
    const reads = matterScopedReads(ROLLUP)
    const unanswerable: InitiativeMetric[] = [
      'revenue',
      'margin',
      'marginPercent',
      'unmappedCount',
      'mrr',
      'arr',
      'newCustomers',
      'internalCost',
      'externalCost',
    ]
    for (const metric of unanswerable) {
      expect(actualForMetric(metric, reads)).toBeNull()
    }
  })

  it('a matter with no events in the window reads a real 0 cost and 0 events', () => {
    const reads = matterScopedReads({ cost: 0, eventCount: 0 })
    expect(actualForMetric('cost', reads)).toBe(0)
    expect(actualForMetric('eventCount', reads)).toBe(0)
    // costPerTask over zero events stays null (canon M2), same as org-wide.
    expect(actualForMetric('costPerTask', reads)).toBeNull()
  })

  it('a missing rollup nulls the cost family too, and equals the no-reads shape', () => {
    expect(matterScopedReads(null)).toEqual(NO_READS)
    expect(actualForMetric('cost', matterScopedReads(null))).toBeNull()
  })
})
