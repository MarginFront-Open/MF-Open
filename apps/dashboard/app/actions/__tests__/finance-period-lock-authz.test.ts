/**
 * WHAT THIS FILE DOES: proves the two period-lock guarantees on the
 * write actions, against a
 * fully-mocked DB:
 *
 *   1. ROLE GATE: a plain `member` is rejected server-side on BOTH lockPeriod
 *      and unlockPeriod, so a member who POSTs the action directly (bypassing
 *      the hidden UI button) can't close OR silently reopen a posted period.
 *      Only finance / admin / owner get through.
 *
 *   2. AUDIT TRAIL: every close writes a durable `closed` row and every reopen
 *      writes a `reopened` row to finance_period_lock_events — and the reopen
 *      row is written BEFORE the lock row is deleted (it's the only surviving
 *      record of who reopened), fail-closed if that write throws.
 *
 * The role check reads ba_member on the caller's active org
 * (session.activeOrganizationId), and the data + audit writes go to that org.
 *
 * CONNECTS TO: app/actions/finance-period-lock.ts (under test); the role-gate
 * idiom it mirrors lives in app/actions/set-dashboard-mode.ts.
 */

// Mark this file a module so its top-level fixtures don't collide in the global
// scope with sibling action tests (same convention as period-lock-guard.test.ts).
export {}

const ORG = 'org-period-lock'
const USER = 'user-period-lock'

// Controllable session — each test sets the org/user before calling.
let sessionState: { activeOrganizationId: string | null; userId: string | null } =
  { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
// revalidatePath needs Next's static-generation store, which doesn't exist in a
// plain jest run — stub it so the success paths can reach their return.
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))

// The snapshot fan-out lockPeriod does on the happy path. Each only has to be
// truthy so the "all five payloads present" guard passes — we don't assert on
// their contents (that's period-lock-guard.test.ts's job).
jest.mock('../journal-export', () => ({
  getJournalExport: async () => ({ rows: [] }),
  getJournalAuditDetail: async () => ({ glLines: [] }),
}))
jest.mock('../cost-command-center', () => ({
  getCostClassificationBreakdown: async () => ({ categories: [] }),
}))
jest.mock('../finance-metrics', () => ({
  getDefensibilityScore: async () => ({ scorePercent: 100 }),
  getProductLineMargins: async () => ({ rows: [] }),
}))

// DB spies: the role lookup, the lock read, the lock create/delete and the
// audit-event create.
const baMemberFindFirst = jest.fn()
const lockFindUnique = jest.fn()
const lockCreate = jest.fn()
const lockDeleteMany = jest.fn()
const eventCreate = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    finance_period_locks: {
      findUnique: (a: unknown) => lockFindUnique(a),
      create: (a: unknown) => lockCreate(a),
      deleteMany: (a: unknown) => lockDeleteMany(a),
    },
    finance_period_lock_events: { create: (a: unknown) => eventCreate(a) },
  },
}))

type Mod = typeof import('../finance-period-lock')
let mod: Mod

beforeAll(async () => {
  // Silence the deliberate console.error from the best-effort close-audit path.
  jest.spyOn(console, 'error').mockImplementation(() => {})
  mod = await import('../finance-period-lock')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  lockFindUnique.mockReset()
  lockCreate.mockReset().mockResolvedValue(undefined)
  lockDeleteMany.mockReset().mockResolvedValue({ count: 1 })
  eventCreate.mockReset().mockResolvedValue(undefined)
})

// A real, past, closable period (May 2026 is firmly behind any future run, so
// isPeriodClosable — the un-mocked real helper — returns true deterministically).
const CLOSE_PARAMS = {
  startDate: '2026-05-01',
  endDate: '2026-05-31',
  periodLabel: 'May 2026',
}
const REOPEN_PARAMS = { startDate: '2026-05-01', endDate: '2026-05-31' }
const DENY_MSG = /finance, admin, or owner/i

describe('lockPeriod — role gate', () => {
  it('rejects a plain member and writes NOTHING', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })

    const res = await mod.lockPeriod(CLOSE_PARAMS)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(DENY_MSG)
    expect(lockCreate).not.toHaveBeenCalled()
    expect(eventCreate).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects when the caller has no membership row in their org', async () => {
    baMemberFindFirst.mockResolvedValue(null)

    const res = await mod.lockPeriod(CLOSE_PARAMS)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(DENY_MSG)
    expect(lockCreate).not.toHaveBeenCalled()
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('lets a finance user close, and writes a `closed` audit row scoped to the active org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    lockFindUnique.mockResolvedValue(null) // not already closed

    const res = await mod.lockPeriod(CLOSE_PARAMS)

    expect(res.success).toBe(true)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(ORG)
    expect(lockCreate.mock.calls[0][0].data.orgId).toBe(ORG)
    // The audit row: correct action + actor, scoped to the active org.
    expect(eventCreate).toHaveBeenCalledTimes(1)
    expect(eventCreate.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      action: 'closed',
      actorUserId: USER,
      periodLabel: 'May 2026',
    })
  })

  it('still reports success if the close audit write fails (best-effort mirror)', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'admin' })
    lockFindUnique.mockResolvedValue(null)
    eventCreate.mockRejectedValue(new Error('audit table unavailable'))

    const res = await mod.lockPeriod(CLOSE_PARAMS)

    // The close itself is durable + attributed on the lock row, so a mirror
    // hiccup must not surface as a failed close.
    expect(res.success).toBe(true)
    expect(lockCreate).toHaveBeenCalledTimes(1)
  })
})

describe('unlockPeriod — role gate + reopen audit', () => {
  it('rejects a plain member and does NOT delete or record anything', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })

    const res = await mod.unlockPeriod(REOPEN_PARAMS)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(DENY_MSG)
    expect(lockDeleteMany).not.toHaveBeenCalled()
    expect(eventCreate).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(ORG)
  })

  it('records the `reopened` audit row BEFORE deleting the lock', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    lockFindUnique.mockResolvedValue({ periodLabel: 'May 2026' })

    const res = await mod.unlockPeriod(REOPEN_PARAMS)

    expect(res.success).toBe(true)
    expect(eventCreate.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      action: 'reopened',
      actorUserId: USER,
      periodLabel: 'May 2026',
    })
    expect(lockDeleteMany).toHaveBeenCalledTimes(1)
    // Ordering is the guarantee: the only surviving record of the reopen must be
    // written before the lock row (the close's record) is destroyed.
    expect(eventCreate.mock.invocationCallOrder[0]).toBeLessThan(
      lockDeleteMany.mock.invocationCallOrder[0]
    )
  })

  it('is fail-closed: if the reopen audit write throws, the lock is NOT deleted', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    lockFindUnique.mockResolvedValue({ periodLabel: 'May 2026' })
    eventCreate.mockRejectedValue(new Error('audit table unavailable'))

    await expect(mod.unlockPeriod(REOPEN_PARAMS)).rejects.toThrow(
      'audit table unavailable'
    )
    // A reopen we can't record is a reopen we don't perform.
    expect(lockDeleteMany).not.toHaveBeenCalled()
  })

  it('is a no-op (no audit, no delete) when the period is not actually closed', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'admin' })
    lockFindUnique.mockResolvedValue(null) // nothing locked

    const res = await mod.unlockPeriod(REOPEN_PARAMS)

    expect(res.success).toBe(true)
    expect(eventCreate).not.toHaveBeenCalled()
    expect(lockDeleteMany).not.toHaveBeenCalled()
  })
})
