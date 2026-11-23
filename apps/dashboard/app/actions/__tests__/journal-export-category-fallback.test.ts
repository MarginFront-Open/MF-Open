/**
 * WHAT THIS FILE DOES: proves the journal's read-side category →
 * GL fallback end-to-end, against a fully-mocked DB. A metered
 * claude-code-turn signal — categorized DEVELOPMENT_RD at ingest but never
 * given an explicit glCodeId — books to GL 6800 ("AI R&D") on the exported
 * journal instead of sitting in the "Unmapped: needs GL code" pile.
 *
 * THE GUARANTEES UNDER TEST:
 *   1. A DEVELOPMENT_RD signal with null glCodeId lands on 6800, NOT __unmapped.
 *   2. Operator mappings still win: a signal WITH an explicit glCodeId books to
 *      that code, never the category default (read-only, no clobber).
 *   3. UNCLASSIFIED stays __unmapped — we never auto-route an uncategorized signal.
 *   4. The grand total is unchanged: the fallback only MOVES a dollar between
 *      buckets, it never adds or drops one (canon C1 — cost is untouched).
 *   5. Fresh org (empty chart_of_accounts) still resolves 6800 via the seed.
 *   6. Deleted-6800 org: nothing to route to → those dollars stay __unmapped.
 *   7. Reconciliation: getJournalExport and getJournalAuditDetail bucket the
 *      same events identically, so their per-GL totals still match.
 *
 * CONNECTS TO: app/actions/journal-export.ts (both functions under test) and
 * @/app/lib/db (mocked — deterministic fixture instead of Postgres).
 */

// Module marker so top-level fixtures don't collide with sibling journal tests
// that reuse these names in the global scope.
export {}

const ACTIVE_ORG = 'org-journal-export'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ACTIVE_ORG },
        user: { id: 'user-1' },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
// Exercise the LIVE recompute path; the lock guard has its own suite.
jest.mock('../_shared/period-lock-store', () => ({
  findLockedPeriod: async () => null,
}))

// --- In-memory fixture ------------------------------------------------------
// sig-rd  : DEVELOPMENT_RD, NO glCodeId        → must fall back to 6800
// sig-cogs: PRODUCTION_COGS, explicit glCodeId → must stay on its mapped 5100
// sig-unc : UNCLASSIFIED, NO glCodeId          → must stay __unmapped
const SIGNALS = [
  {
    id: 'sig-rd',
    name: 'claude-code-turn',
    agentId: 'agent-cc',
    costCategory: 'DEVELOPMENT_RD',
    glCodeId: null,
    chart_of_accounts: null,
  },
  {
    id: 'sig-cogs',
    name: 'Inference call',
    agentId: 'agent-prod',
    costCategory: 'PRODUCTION_COGS',
    glCodeId: 'gl-5100',
    chart_of_accounts: {
      glCode: '5100',
      glName: 'AI Inference',
      accountingType: 'COGS',
    },
  },
  {
    id: 'sig-unc',
    name: 'Mystery usage',
    agentId: 'agent-x',
    costCategory: 'UNCLASSIFIED',
    glCodeId: null,
    chart_of_accounts: null,
  },
]

// sig-rd: 10, sig-cogs: 20, sig-unc: 5  → total 35
const EVENTS = [
  {
    id: 'ev-1',
    signalId: 'sig-rd',
    usageDate: new Date('2026-05-02T00:00:00.000Z'),
    usageCost: 10,
    environment: 'development',
    quantity: 1,
  },
  {
    id: 'ev-2',
    signalId: 'sig-cogs',
    usageDate: new Date('2026-05-03T00:00:00.000Z'),
    usageCost: 20,
    environment: 'production',
    quantity: 1,
  },
  {
    id: 'ev-3',
    signalId: 'sig-unc',
    usageDate: new Date('2026-05-04T00:00:00.000Z'),
    usageCost: 5,
    environment: null,
    quantity: 1,
  },
]

const signalsFindMany = jest.fn()
const eventsFindMany = jest.fn()
const overridesFindMany = jest.fn()
const chartFindMany = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    signals: { findMany: (args: unknown) => signalsFindMany(args) },
    signal_events: { findMany: (args: unknown) => eventsFindMany(args) },
    signal_classification_overrides: {
      findMany: (args: unknown) => overridesFindMany(args),
    },
    chart_of_accounts: { findMany: (args: unknown) => chartFindMany(args) },
    ba_member: { findFirst: async () => ({ role: 'finance' }) },
  },
}))

type JournalExportModule = typeof import('../journal-export')
let mod: JournalExportModule

beforeAll(async () => {
  mod = await import('../journal-export')
})

beforeEach(() => {
  signalsFindMany.mockReset().mockResolvedValue(SIGNALS)
  eventsFindMany.mockReset().mockResolvedValue(EVENTS)
  overridesFindMany.mockReset().mockResolvedValue([])
  // Default: fresh org with NO materialized chart → resolver uses the seed.
  chartFindMany.mockReset().mockResolvedValue([])
})

const FILTER = { startDate: '2026-05-01', endDate: '2026-05-31' }

describe('getJournalExport — DEVELOPMENT_RD → 6800 fallback', () => {
  it('books a categorized-but-unmapped R&D signal to 6800, not __unmapped', async () => {
    const out = await mod.getJournalExport(FILTER)
    expect(out).not.toBeNull()

    const row6800 = out!.rows.find((r) => r.glCode === '6800')
    expect(row6800).toBeDefined()
    expect(row6800!.amount).toBeCloseTo(10, 6)
    expect(row6800!.accountingType).toBe('OPEX_RD') // below gross margin (canon M1)
    expect(row6800!.glName).toBe('AI R&D: Experiments & Model Development')

    // The R&D dollar is NOT in the unmapped pile.
    const unmapped = out!.rows.find((r) => r.glCode === null)
    expect(unmapped?.amount ?? 0).toBeCloseTo(5, 6) // only sig-unc's $5
  })

  it('still routes an explicitly-mapped signal to its own GL code (no clobber)', async () => {
    const out = await mod.getJournalExport(FILTER)
    const row5100 = out!.rows.find((r) => r.glCode === '5100')
    expect(row5100!.amount).toBeCloseTo(20, 6) // sig-cogs via its real glCodeId
  })

  it('leaves UNCLASSIFIED spend in __unmapped (never auto-routed)', async () => {
    const out = await mod.getJournalExport(FILTER)
    const unmapped = out!.rows.find((r) => r.glCode === null)
    expect(unmapped).toBeDefined()
    expect(unmapped!.amount).toBeCloseTo(5, 6)
    expect(unmapped!.glName).toBe('Unmapped: needs GL code')
  })

  it('does NOT change the grand total — the fallback only moves a dollar (canon C1)', async () => {
    const out = await mod.getJournalExport(FILTER)
    // 10 + 20 + 5 = 35, identical to the raw event-cost sum. The R&D dollar
    // moved from __unmapped to 6800; the total is byte-for-byte unchanged.
    expect(out!.totalAmount).toBeCloseTo(35, 6)
    expect(out!.unmappedAmount).toBeCloseTo(5, 6)
    expect(out!.hasUnmapped).toBe(true)
  })
})

describe('getJournalExport — chart-of-accounts sourcing', () => {
  it('uses the seed (6800) when the org has NO materialized chart (fresh org)', async () => {
    chartFindMany.mockResolvedValue([]) // empty → seed fallback
    const out = await mod.getJournalExport(FILTER)
    expect(out!.rows.find((r) => r.glCode === '6800')?.amount).toBeCloseTo(
      10,
      6
    )
    // And the chart lookup was org-scoped (IDOR belt).
    expect(chartFindMany.mock.calls[0][0].where).toMatchObject({
      orgId: ACTIVE_ORG,
    })
  })

  it('uses the org row when DEVELOPMENT_RD has been renumbered in a materialized chart', async () => {
    // Operator renamed/renumbered their R&D account; the fallback must follow
    // the org's own chart, not the hardcoded seed.
    chartFindMany.mockResolvedValue([
      {
        glCode: '6850',
        glName: 'Custom AI R&D',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
        isDefault: true,
      },
    ])
    const out = await mod.getJournalExport(FILTER)
    expect(out!.rows.find((r) => r.glCode === '6850')?.amount).toBeCloseTo(
      10,
      6
    )
    expect(out!.rows.find((r) => r.glCode === '6800')).toBeUndefined()
  })

  it('leaves R&D unmapped when the org deleted its only R&D account (deleted-6800 edge)', async () => {
    // A materialized chart with NO DEVELOPMENT_RD account: cannot route there,
    // so the R&D dollar correctly stays in __unmapped.
    chartFindMany.mockResolvedValue([
      {
        glCode: '5100',
        glName: 'AI Inference',
        costCategory: 'PRODUCTION_COGS',
        accountingType: 'COGS',
        isDefault: true,
      },
    ])
    const out = await mod.getJournalExport(FILTER)
    expect(out!.rows.find((r) => r.glCode === '6800')).toBeUndefined()
    // sig-rd's $10 falls back into __unmapped alongside sig-unc's $5.
    expect(out!.rows.find((r) => r.glCode === null)?.amount).toBeCloseTo(15, 6)
    expect(out!.totalAmount).toBeCloseTo(35, 6) // total still conserved
  })
})

describe('getJournalExport.unmappedSignalCount — journal semantics, not glCodeId IS NULL', () => {
  it('counts only the signal behind __unmapped: 1 — a glCodeId-null count would read 2', async () => {
    const out = await mod.getJournalExport(FILTER)
    // sig-rd AND sig-unc both have glCodeId === null, but sig-rd books to
    // 6800 via the category fallback — only sig-unc is truly unmapped. This
    // fixture goes RED if the count ever keys off glCodeId === null instead
    // of the '__unmapped' booking key.
    expect(out!.unmappedSignalCount).toBe(1)
  })

  it("unmappedAmount is C's cost alone (sig-unc's $5), matching the counted signal", async () => {
    const out = await mod.getJournalExport(FILTER)
    expect(out!.unmappedAmount).toBeCloseTo(5, 6)
  })

  it('two unmapped events with NO signal collapse to a single synthetic member (+1, not +2)', async () => {
    eventsFindMany.mockResolvedValue([
      EVENTS[1], // sig-cogs, explicitly mapped — contributes nothing unmapped
      {
        id: 'ev-null-1',
        signalId: null,
        usageDate: new Date('2026-05-05T00:00:00.000Z'),
        usageCost: 3,
        environment: null,
        quantity: 1,
      },
      {
        id: 'ev-null-2',
        signalId: null,
        usageDate: new Date('2026-05-06T00:00:00.000Z'),
        usageCost: 4,
        environment: null,
        quantity: 1,
      },
    ])
    const out = await mod.getJournalExport(FILTER)
    expect(out!.unmappedSignalCount).toBe(1)
    // The count never reads 0 while unmapped dollars are nonzero.
    expect(out!.unmappedAmount).toBeCloseTo(7, 6)
  })
})

describe('reconciliation — export and audit-detail bucket identically', () => {
  it('per-GL totals match between getJournalExport and getJournalAuditDetail', async () => {
    const rollup = await mod.getJournalExport(FILTER)
    const detail = await mod.getJournalAuditDetail(FILTER)
    expect(rollup).not.toBeNull()
    expect(detail).not.toBeNull()

    // Same grand total.
    expect(detail!.totalAmount).toBeCloseTo(rollup!.totalAmount, 6)

    // Same per-GL amounts (keyed by glCode, unmapped = null). This is what keeps
    // the drill-through honest after the fallback — both must route sig-rd to 6800.
    const rollupByCode = new Map(
      rollup!.rows.map((r) => [r.glCode ?? '__unmapped', r.amount])
    )
    for (const line of detail!.glLines) {
      const key = line.glCode ?? '__unmapped'
      expect(line.amount).toBeCloseTo(rollupByCode.get(key) ?? -1, 6)
    }
    // Specifically: both surfaces agree 6800 carries the $10 R&D charge.
    expect(rollupByCode.get('6800')).toBeCloseTo(10, 6)
    expect(
      detail!.glLines.find((l) => l.glCode === '6800')?.amount
    ).toBeCloseTo(10, 6)
  })
})
