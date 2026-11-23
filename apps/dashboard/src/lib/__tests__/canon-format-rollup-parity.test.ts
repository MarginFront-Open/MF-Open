import { rollupEventCosts as dbCanonImpl } from '@marginfront/db'
import { rollupEventCosts as clientPort } from '../canon-format'

/**
 * Parity pin for the client-safe rollupEventCosts port.
 *
 * canon-format.ts carries a byte-faithful copy of the canonical C1 fold
 * because src/** can't value-import @marginfront/db (it would crash the page
 * in the browser; see the comment on rollupEventCosts in canon-format.ts). This test
 * imports BOTH implementations (legal here, jest runs in node) and asserts identical output across the battery, so
 * a drift in either copy goes red before it ships a wrong audit total.
 */

const BATTERY: Array<Array<{ usageCost: number | null }>> = [
  [],
  [{ usageCost: 0 }],
  [{ usageCost: null }],
  [{ usageCost: 1.25 }, { usageCost: null }, { usageCost: 3.3 }],
  [{ usageCost: null }, { usageCost: null }, { usageCost: null }],
  [{ usageCost: 0.0001 }, { usageCost: 999999.99 }, { usageCost: 0 }],
  [{ usageCost: -0.5 }, { usageCost: 0.5 }],
  // A mixed batch: 12 priced + 2 pending.
  [
    ...Array.from({ length: 12 }, (_, i) => ({ usageCost: (i + 1) * 0.5 })),
    { usageCost: null },
    { usageCost: null },
  ],
]

describe('rollupEventCosts — canon-format port matches @marginfront/db exactly', () => {
  it.each(BATTERY.map((events, i) => [i, events] as const))(
    'battery case %#: identical rollup',
    (_i, events) => {
      expect(clientPort(events)).toEqual(dbCanonImpl(events))
    }
  )

  it('pins the C1 contract on both: null adds 0, counts, and flags', () => {
    const events = [{ usageCost: 2 }, { usageCost: null }]
    const expected = { cost: 2, eventCount: 2, eventsMissingCost: 1 }
    expect(clientPort(events)).toEqual(expected)
    expect(dbCanonImpl(events)).toEqual(expected)
  })
})
