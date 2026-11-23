/**
 * WHAT THIS FILE DOES: proves the ONE shared build-write gate
 * does its job against a fully-mocked DB.
 *
 *   1. ROLE GATE: a plain `member`, a `finance` user, and a no-membership caller
 *      are all rejected; admin / owner / developer get an `{ ok: true }`. (finance
 *      is DENIED here on purpose — finance owns the BOOKS, not the build plumbing;
 *      developer is the build/operations seat.)
 *   2. THE ORG INVARIANT (load-bearing): the role lookup reads ba_member on
 *      the caller's active org (session.activeOrganizationId).
 *      We force the lookup's org to be asserted against the active org so
 *      a guard that gates on the wrong org is caught here, in one place,
 *      instead of leaking into every build action.
 *
 * Mirrors assert-money-manager.test.ts. Drives MANAGE_BUILD_ROLES from the real
 * '@marginfront/db' export so the seam under test is the actual shared constant.
 */

export {}

import { MANAGE_BUILD_ROLES } from '@marginfront/db'

const ORG = 'org-real-1' // where the caller's ba_member row lives
const OTHER_ORG = 'org-other-1' // a DIFFERENT org — must never be the gate's lookup org
const USER = 'user-1'

// Controllable session — each test sets the org/user before calling.
let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

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
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
  },
}))

type Mod = typeof import('../assert-build-manager')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-build-manager')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertBuildManager — sanity on the shared constant', () => {
  it('locks the Manage-BUILD set to admin/owner/developer (NOT finance, NOT member)', () => {
    // Developer is the build/operations seat. finance/member stay out.
    expect([...MANAGE_BUILD_ROLES].sort()).toEqual([
      'admin',
      'developer',
      'owner',
    ])
  })
})

describe('assertBuildManager — DENY paths', () => {
  it('rejects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const gate = await mod.assertBuildManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/owner, admin, or developer roles/i)
    // The lookup read the active org, never some other org.
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a finance user — finance owns the books, not the build plumbing', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    const gate = await mod.assertBuildManager()
    expect(gate.ok).toBe(false)
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertBuildManager()
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('rejects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    const gate = await mod.assertBuildManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertBuildManager — ALLOW paths', () => {
  it.each(['admin', 'owner', 'developer'])(
    'lets a %s through and returns the active org + user id',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertBuildManager()
      expect(gate.ok).toBe(true)
      if (gate.ok) {
        expect(gate.orgId).toBe(ORG)
        expect(gate.userId).toBe(USER)
      }
      // Even on the happy path, the role was read in the active org.
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )

  it('gates on the active org even when a different org exists in the system', async () => {
    // A lookup keyed on any org other than the session's
    // active org fails this assertion.
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.assertBuildManager()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
