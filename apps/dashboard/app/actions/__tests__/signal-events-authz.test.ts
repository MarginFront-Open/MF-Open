/**
 * WHAT THIS FILE DOES: proves the BUILD-write gate on the signal-events
 * operational writes — bulkDeleteEvents (the destructive one) being the representative case.
 *
 * BUILD, not MONEY: deleting cost events /
 * remapping a model / filling volume are OPERATIONAL metering edits (which model an event used,
 * a meter's makeup) — dev plumbing, NOT accounting numbers — so they sit behind
 * Manage-BUILD, not Manage-MONEY. The load-bearing case this test pins: a FINANCE user, who COULD
 * reasonably expect to run these, is DENIED — finance owns the books, not the build plumbing.
 *
 * These actions write to the caller's active org — so the role
 * lens AND the data lens are both the real active org. Fully mocked DB; no database needed.
 *
 *   - member / finance / no-membership -> { success: false }, NO signal_events.deleteMany
 *   - admin / owner                    -> the delete fires, scoped to the caller's active org, and
 *                                         the role lookup used that same active org
 */

export {}

const ORG = 'org-real-events' // active org: both the role lens and the data lens here
const USER = 'user-events'

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
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('../_shared/parse-window-filter', () => ({
  parseWindowFilter: () => ({}),
}))

const baMemberFindFirst = jest.fn()
const eventsDeleteMany = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    signal_events: { deleteMany: (a: unknown) => eventsDeleteMany(a) },
  },
  // Bindings the module destructures at import; never called on the delete path.
  Prisma: {},
  calculateEventCost: jest.fn(),
  recomputeParentUsageCost: jest.fn(),
}))

type Mod = typeof import('../signal-events')
let mod: Mod

beforeAll(async () => {
  mod = await import('../signal-events')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  eventsDeleteMany.mockReset().mockResolvedValue({ count: 3 })
})

describe('bulkDeleteEvents — BUILD-write gate', () => {
  it('rejects a plain member and deletes NOTHING', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.bulkDeleteEvents(['e1', 'e2'])
    expect(res.success).toBe(false)
    expect(eventsDeleteMany).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a FINANCE user — operations is dev plumbing, not the books', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    const res = await mod.bulkDeleteEvents(['e1', 'e2'])
    expect(res.success).toBe(false)
    expect(eventsDeleteMany).not.toHaveBeenCalled()
  })

  it('rejects a caller with no membership row and deletes NOTHING', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.bulkDeleteEvents(['e1'])
    expect(res.success).toBe(false)
    expect(eventsDeleteMany).not.toHaveBeenCalled()
  })

  it.each(['admin', 'owner'])(
    'lets an %s delete — role and data both scoped to the real active org',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const res = await mod.bulkDeleteEvents(['e1', 'e2'])
      expect(res.success).toBe(true)
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
      // The destructive write is scoped to the caller's active org.
      expect(eventsDeleteMany.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )
})
