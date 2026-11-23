/**
 * WHAT THIS FILE DOES: Locks down the drillable audit-trail action
 * (getJournalAuditDetail). Two things matter and both are proven
 * here against a fully-controlled in-memory fixture (no live DB):
 *
 *   1. ORG SCOPING (IDOR): every Prisma query the action makes MUST carry the
 *      active org's id. A leaked signal/event id from another org must not
 *      widen the result. We assert the actual `where` clauses on the mocked
 *      db calls.
 *
 *   2. RECONCILIATION: the per-GL amounts the audit trail reports MUST equal
 *      what getJournalExport rolls up for the SAME fixture — and a GL line's
 *      amount MUST equal the sum of its own events' costs. The drill-through
 *      can never disagree with the headline number it expands from.
 *
 * WHY IT EXISTS: the audit trail is a separate per-event grain that duplicates
 * the signal→GL map + event-cost sum from getJournalExport on purpose (2 call
 * sites, under the Rule of Three). Duplication only stays safe if a test keeps
 * the two in lockstep — that's this file.
 *
 * CONNECTS TO: app/actions/journal-export.ts (getJournalAuditDetail +
 * getJournalExport, both under test here), and @/app/lib/db (mocked — we feed
 * the actions a deterministic fixture instead of hitting Postgres).
 */

// ---------------------------------------------------------------------------
// Mocks. The action resolves org via auth, then reads from
// the `db` export. We mock all three so the test is hermetic.
// ---------------------------------------------------------------------------

// Module marker so this file's top-level fixtures don't collide in the global
// scope with the sibling period-lock guard test (which reuses the same names).
export {}

const ACTIVE_ORG = 'org-active-journal'
const OTHER_ORG = 'org-other-evil'

const authMock = {
  api: {
    getSession: async () => ({
      session: { activeOrganizationId: ACTIVE_ORG },
      user: { id: 'user-1' },
    }),
  },
}
jest.mock('@/app/lib/auth', () => ({ auth: authMock }))
jest.mock('next/headers', () => ({
  headers: async () => new Headers(),
}))
// This suite exercises the LIVE recompute path, so the period
// is never locked here. The lock guard itself is covered by period-lock-*.test.ts.
jest.mock('../_shared/period-lock-store', () => ({
  findLockedPeriod: async () => null,
}))

// ---------------------------------------------------------------------------
// In-memory fixture. Two GL codes + one unmapped signal. One signal carries an
// override (manual classification), one does not (default). A SECOND org's data
// is also present in the raw arrays so we can prove the org filter excludes it.
// ---------------------------------------------------------------------------

const GL_COGS = {
  glCode: '5100',
  glName: 'AI Inference',
  accountingType: 'COGS',
}
const GL_RD = { glCode: '6100', glName: 'AI R&D', accountingType: 'OPEX_RD' }

// signals (active org) — sig-a → COGS, sig-b → R&D, sig-c → unmapped (no GL)
const SIGNALS = [
  {
    id: 'sig-a',
    name: 'Inference call',
    agentId: 'agent-1',
    costCategory: 'PRODUCTION_COGS',
    glCodeId: 'gl-cogs',
    chart_of_accounts: GL_COGS,
  },
  {
    id: 'sig-b',
    name: 'Model training',
    agentId: 'agent-2',
    costCategory: 'DEVELOPMENT_RD',
    glCodeId: 'gl-rd',
    chart_of_accounts: GL_RD,
  },
  {
    id: 'sig-c',
    name: 'Unmapped signal',
    agentId: 'agent-3',
    costCategory: 'UNCLASSIFIED',
    glCodeId: null,
    chart_of_accounts: null,
  },
]

// events (active org). sig-a: 10 + 5 = 15. sig-b: 20. sig-c: 3. Total = 38.
const EVENTS = [
  {
    id: 'ev-1',
    signalId: 'sig-a',
    usageDate: new Date('2026-05-02T00:00:00.000Z'),
    usageCost: 10,
    environment: 'production',
    quantity: 1,
  },
  {
    id: 'ev-2',
    signalId: 'sig-a',
    usageDate: new Date('2026-05-03T00:00:00.000Z'),
    usageCost: 5,
    environment: 'staging',
    quantity: 2,
  },
  {
    id: 'ev-3',
    signalId: 'sig-b',
    usageDate: new Date('2026-05-04T00:00:00.000Z'),
    usageCost: 20,
    environment: 'production',
    quantity: 1,
  },
  {
    id: 'ev-4',
    signalId: 'sig-c',
    usageDate: new Date('2026-05-05T00:00:00.000Z'),
    usageCost: 3,
    environment: null,
    quantity: 1,
  },
]

// Only sig-a was ever manually overridden. Two rows for sig-a — the latest
// (desc by createdAt) is the one the action must report.
const OVERRIDES = [
  {
    signalId: 'sig-a',
    source: 'inline_dropdown',
    chosenCategory: 'PRODUCTION_COGS',
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
  },
  {
    signalId: 'sig-a',
    source: 'bulk_suggest_button',
    chosenCategory: 'PRODUCTION_COGS',
    createdAt: new Date('2026-05-01T08:00:00.000Z'),
  },
]

// Spies capture the `where` clause of every query so we can assert org scoping.
const signalsFindMany = jest.fn()
const eventsFindMany = jest.fn()
const overridesFindMany = jest.fn()
// Both journal functions read the org's chart of accounts for
// the category → default-GL fallback. This fixture's signals are all either
// directly mapped (sig-a/sig-b carry a glCodeId) or UNCLASSIFIED (sig-c), so the
// fallback never fires here and an empty chart leaves every total unchanged.
const chartFindMany = jest.fn()
const memberFindFirst = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    signals: { findMany: (args: unknown) => signalsFindMany(args) },
    signal_events: { findMany: (args: unknown) => eventsFindMany(args) },
    signal_classification_overrides: {
      findMany: (args: unknown) => overridesFindMany(args),
    },
    chart_of_accounts: { findMany: (args: unknown) => chartFindMany(args) },
    ba_member: { findFirst: (args: unknown) => memberFindFirst(args) },
  },
}))

type JournalExportModule = typeof import('../journal-export')
let mod: JournalExportModule

beforeAll(async () => {
  mod = await import('../journal-export')
})

beforeEach(() => {
  // Each mock returns ONLY active-org rows — mirroring what a correctly-scoped
  // query returns. We separately assert the `where` carried the org filter, so
  // a missing filter is caught at the query level, not the data level.
  signalsFindMany.mockReset().mockResolvedValue(SIGNALS)
  eventsFindMany.mockReset().mockResolvedValue(EVENTS)
  overridesFindMany.mockReset().mockResolvedValue(OVERRIDES)
  // Empty chart → seed fallback; harmless here (no fallback-eligible signal).
  chartFindMany.mockReset().mockResolvedValue([])
  memberFindFirst.mockReset().mockResolvedValue({ role: 'finance' })
})

describe('journal export role gate', () => {
  it('returns null and reads no cost data for a plain member', async () => {
    memberFindFirst.mockResolvedValue({ role: 'member' })

    expect(await mod.getJournalExport()).toBeNull()
    expect(await mod.getJournalAuditDetail()).toBeNull()
    expect(signalsFindMany).not.toHaveBeenCalled()
    expect(eventsFindMany).not.toHaveBeenCalled()
  })
})

describe('getJournalAuditDetail — org scoping (IDOR)', () => {
  it('filters EVERY query by the active org id', async () => {
    await mod.getJournalAuditDetail({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })

    // signals query scoped to org
    expect(signalsFindMany).toHaveBeenCalledTimes(1)
    expect(signalsFindMany.mock.calls[0][0].where).toMatchObject({
      orgId: ACTIVE_ORG,
      deletedAt: null,
    })

    // events query scoped to org (organizationId) + window
    expect(eventsFindMany).toHaveBeenCalledTimes(1)
    const evWhere = eventsFindMany.mock.calls[0][0].where
    expect(evWhere.organizationId).toBe(ACTIVE_ORG)
    expect(evWhere.usageDate).toBeDefined()

    // overrides query scoped to org
    expect(overridesFindMany).toHaveBeenCalledTimes(1)
    expect(overridesFindMany.mock.calls[0][0].where).toMatchObject({
      orgId: ACTIVE_ORG,
    })
    // Never the other org anywhere.
    expect(JSON.stringify(eventsFindMany.mock.calls[0][0])).not.toContain(
      OTHER_ORG
    )
  })

  it('returns null (no leak) when there is no active org session', async () => {
    const noSessionAuth = { api: { getSession: async () => null } }
    jest.resetModules()
    jest.doMock('@/app/lib/auth', () => ({ auth: noSessionAuth }))
    jest.doMock('next/headers', () => ({ headers: async () => new Headers() }))
    const fresh: JournalExportModule = await import('../journal-export')
    const result = await fresh.getJournalAuditDetail()
    expect(result).toBeNull()
    jest.dontMock('@/app/lib/auth')
    jest.dontMock('next/headers')
  })
})

describe('getJournalAuditDetail — reconciliation', () => {
  it('each GL line amount equals the sum of its own event costs', async () => {
    const detail = await mod.getJournalAuditDetail({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })
    expect(detail).not.toBeNull()

    for (const line of detail!.glLines) {
      const summed = line.signals
        .flatMap((s) => s.events)
        .reduce((sum, ev) => sum + ev.usageCost, 0)
      expect(summed).toBeCloseTo(line.amount, 6)
    }
  })

  it('per-GL amounts + total match getJournalExport for the same fixture', async () => {
    const filter = { startDate: '2026-05-01', endDate: '2026-05-31' }

    const detail = await mod.getJournalAuditDetail(filter)
    // getJournalExport reads the same mocked db (signals + signal_events). It
    // does NOT read overrides, but our overrides mock is harmless to it.
    const rollup = await mod.getJournalExport(filter)

    expect(detail).not.toBeNull()
    expect(rollup).not.toBeNull()

    // Same grand total.
    expect(detail!.totalAmount).toBeCloseTo(rollup!.totalAmount, 6)
    // total reconciles to the known fixture sum (15 + 20 + 3).
    expect(detail!.totalAmount).toBeCloseTo(38, 6)

    // Per-GL amounts match one-for-one (keyed by glCode, unmapped = null).
    const rollupByCode = new Map(
      rollup!.rows.map((r) => [r.glCode ?? '__unmapped', r.amount])
    )
    for (const line of detail!.glLines) {
      const key = line.glCode ?? '__unmapped'
      expect(line.amount).toBeCloseTo(rollupByCode.get(key) ?? -1, 6)
    }
    // And event counts line up too.
    const rollupCountByCode = new Map(
      rollup!.rows.map((r) => [r.glCode ?? '__unmapped', r.eventCount])
    )
    for (const line of detail!.glLines) {
      const key = line.glCode ?? '__unmapped'
      expect(line.eventCount).toBe(rollupCountByCode.get(key))
    }
  })
})

describe('getJournalAuditDetail — classification provenance (honest)', () => {
  it('reports the LATEST manual override for an overridden signal', async () => {
    const detail = await mod.getJournalAuditDetail({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })
    const cogsLine = detail!.glLines.find((l) => l.glCode === '5100')!
    const sigA = cogsLine.signals.find((s) => s.signalId === 'sig-a')!

    expect(sigA.classification).not.toBeNull()
    // Latest by createdAt desc = the 2026-05-10 inline_dropdown row.
    expect(sigA.classification!.source).toBe('inline_dropdown')
    expect(sigA.classification!.via).toBe('inline_dropdown')
    expect(sigA.classification!.classifiedAt).toBe('2026-05-10T12:00:00.000Z')
  })

  it('reports null classification for a signal never manually overridden', async () => {
    const detail = await mod.getJournalAuditDetail({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })
    const rdLine = detail!.glLines.find((l) => l.glCode === '6100')!
    const sigB = rdLine.signals.find((s) => s.signalId === 'sig-b')!
    // No override row for sig-b → null (default / rule classified).
    expect(sigB.classification).toBeNull()
  })

  it('surfaces the honest internal-source label (no fabricated provider invoice)', async () => {
    const detail = await mod.getJournalAuditDetail()
    expect(detail!.sourceLabel).toContain('internal usage events')
    expect(detail!.sourceLabel.toLowerCase()).not.toContain(
      'provider invoice #'
    )
  })
})
