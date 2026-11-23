/**
 * WHAT THIS FILE DOES: pins the reconciliation contract AT THE WIRE —
 * getMatterExport and canon getCostMetrics must issue the IDENTICAL
 * signal_events where-clause (organizationId + inclusive usageDate window,
 * NOTHING else) for the same org and window.
 *
 * WHY IT EXISTS: matter-export.test.ts proves the builder partitions its own
 * input correctly; that says nothing about whether the export and the org's
 * cost headline READ THE SAME EVENT SET. Any filter quietly added to
 * either side breaks "matters + Unassigned = org total" with every partition
 * test still green. This test fails instead.
 *
 * CONNECTS TO: app/actions/matter-export.ts (side A, mocked-Prisma capture),
 * packages/db revenue-metrics.ts getCostMetrics (side B, called with a mock
 * client), _shared/parse-window-filter.ts (the shared window semantics).
 */

export {}

import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { getCostMetrics } from '@marginfront/db'

const ORG = 'org-test'
// Fixed PAST dates: parseWindowFilter caps windowEnd at `now`, so a past
// window is the only fully deterministic one.
const START = '2026-08-01'
const END = '2026-08-31'

const exportFindMany = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    signal_events: {
      findMany: (args: unknown) => exportFindMany(args),
    },
  },
}))
jest.mock('@/app/actions/_shared/assert-law-manager', () => ({
  assertLawManager: async () => ({
    ok: true,
    orgId: 'org-test',
    userId: 'user-1',
  }),
}))
type ExportMod = typeof import('@/app/actions/matter-export')
let getMatterExport: ExportMod['getMatterExport']

beforeAll(async () => {
  getMatterExport = (await import('@/app/actions/matter-export'))
    .getMatterExport
})

beforeEach(() => {
  exportFindMany.mockReset()
  exportFindMany.mockResolvedValue([])
})

describe('reconciliation where-clause — export vs canon getCostMetrics', () => {
  it('both sides issue the IDENTICAL filter: organizationId + inclusive usageDate, nothing else', async () => {
    const result = await getMatterExport({ startDate: START, endDate: END })
    expect(result.ok).toBe(true)

    const canonFindMany = jest.fn()
    canonFindMany.mockResolvedValue([])
    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: START,
      endDate: END,
    })
    await getCostMetrics(
      { signal_events: { findMany: canonFindMany } } as never,
      ORG,
      { start: windowStart, end: windowEnd }
    )

    const exportWhere = exportFindMany.mock.calls[0][0].where
    const canonWhere = canonFindMany.mock.calls[0][0].where

    // Pin the exact shape first (so a failure names the offending side), then
    // the equality that IS the reconciliation guarantee.
    expect(exportWhere).toEqual({
      organizationId: ORG,
      usageDate: { gte: windowStart, lte: windowEnd },
    })
    expect(canonWhere).toEqual(exportWhere)
  })

  it('the default window (no dates) still filters on organizationId + usageDate alone', async () => {
    const result = await getMatterExport()
    expect(result.ok).toBe(true)

    const exportWhere = exportFindMany.mock.calls[0][0].where
    expect(Object.keys(exportWhere).sort()).toEqual([
      'organizationId',
      'usageDate',
    ])
    expect(Object.keys(exportWhere.usageDate).sort()).toEqual(['gte', 'lte'])
  })
})
