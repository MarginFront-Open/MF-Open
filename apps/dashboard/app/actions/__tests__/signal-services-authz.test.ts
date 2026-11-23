/**
 * WHAT THIS FILE DOES: proves the BUILD-write gate on setSignalServices — the
 * action that rewrites a signal's SERVICE MAKEUP (which services power the meter: Claude + Google
 * Maps, etc.).
 *
 * BUILD, not MONEY: a meter's service makeup is OPERATIONAL metering plumbing — dev
 * data, NOT an accounting number — so it sits behind Manage-BUILD, not Manage-MONEY.
 * The load-bearing case this test pins: a FINANCE user is
 * DENIED — finance owns the books, not the build plumbing. Like signal-events, this action writes
 * to the caller's RAW active org, so the role lens and data lens are the same active org. Fully
 * mocked DB; no database needed.
 *
 *   - member / finance / no-membership -> { success: false }, signal lookup + $transaction NEVER run
 *   - admin / owner                    -> gets past the gate; signal lookup is scoped to the real
 *                                         org, and the link-rewrite transaction fires
 */

export {}

const ORG = 'org-real-svc'
const USER = 'user-svc'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = {
  activeOrganizationId: ORG,
  userId: USER,
}

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
const baMemberFindFirst = jest.fn()
const signalsFindFirst = jest.fn()
const servicePricingFindMany = jest.fn()
const txn = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    signals: { findFirst: (a: unknown) => signalsFindFirst(a) },
    service_pricing: { findMany: (a: unknown) => servicePricingFindMany(a) },
    signal_services: { deleteMany: jest.fn(), create: jest.fn() },
    $transaction: (a: unknown) => txn(a),
  },
}))

type Mod = typeof import('../signal-services')
let mod: Mod

beforeAll(async () => {
  mod = await import('../signal-services')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  signalsFindFirst.mockReset().mockResolvedValue({ id: 'sig-1' })
  servicePricingFindMany.mockReset().mockResolvedValue([])
  txn.mockReset().mockResolvedValue([])
})

describe('setSignalServices — BUILD-write gate', () => {
  it('rejects a plain member and never touches the signal or the transaction', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.setSignalServices('sig-1', ['svc-a'])
    expect(res.success).toBe(false)
    expect(signalsFindFirst).not.toHaveBeenCalled()
    expect(txn).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a FINANCE user — meter makeup is dev plumbing, not the books', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    const res = await mod.setSignalServices('sig-1', ['svc-a'])
    expect(res.success).toBe(false)
    expect(signalsFindFirst).not.toHaveBeenCalled()
    expect(txn).not.toHaveBeenCalled()
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.setSignalServices('sig-1', ['svc-a'])
    expect(res.success).toBe(false)
    expect(txn).not.toHaveBeenCalled()
  })

  it.each(['admin', 'owner'])(
    'lets an %s rewrite the links — role + signal lookup both on the active org',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const res = await mod.setSignalServices('sig-1', ['svc-a'])
      expect(res.success).toBe(true)
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
      expect(signalsFindFirst.mock.calls[0][0].where.orgId).toBe(ORG)
      expect(txn).toHaveBeenCalled()
    }
  )
})
