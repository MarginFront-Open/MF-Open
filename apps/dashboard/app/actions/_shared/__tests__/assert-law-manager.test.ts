/**
 * WHAT THIS FILE DOES: proves the ONE shared Law-tab gate against
 * a fully-mocked DB, no database needed.
 *
 *   1. ROLE GATE: member, developer, and a no-membership caller are all
 *      rejected; owner / admin / finance / legal get `{ ok: true }`.
 *      (developer is DENIED on purpose — the matter record is a billing
 *      surface, not build plumbing; legal is the dedicated seat and this is
 *      the ONLY gate it clears anywhere in the app.)
 *   2. THE ORG INVARIANT: the role lookup reads ba_member on the caller's
 *      active org (session.activeOrganizationId).
 *
 * Mirrors assert-build-manager.test.ts. Drives LAW_MANAGE_ROLES from the real
 * '@marginfront/db' export so the seam under test is the actual shared constant.
 */

export {}

import { LAW_MANAGE_ROLES } from '@marginfront/db'

const ORG = 'org-real-1'
const OTHER_ORG = 'org-other-1'
const USER = 'user-1'

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

type Mod = typeof import('../assert-law-manager')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-law-manager')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertLawManager — sanity on the shared constant', () => {
  it('locks the Law set to owner/admin/finance/legal (NOT developer, NOT member)', () => {
    expect([...LAW_MANAGE_ROLES].sort()).toEqual([
      'admin',
      'finance',
      'legal',
      'owner',
    ])
  })
})

describe('assertLawManager — DENY paths', () => {
  it('rejects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const gate = await mod.assertLawManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/legal, finance, admin, or owner/i)
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a developer — the matter record is a billing surface, not build plumbing', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'developer' })
    const gate = await mod.assertLawManager()
    expect(gate.ok).toBe(false)
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertLawManager()
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('rejects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    const gate = await mod.assertLawManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertLawManager — ALLOW paths', () => {
  it.each(['owner', 'admin', 'finance', 'legal'])(
    'lets a %s through and returns the active org + user id',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertLawManager()
      expect(gate.ok).toBe(true)
      if (gate.ok) {
        expect(gate.orgId).toBe(ORG)
        expect(gate.userId).toBe(USER)
      }
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )

  it('gates on the active org even when a different org exists in the system', async () => {
    // A lookup keyed on any org other than the session's
    // active org fails this assertion.
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'legal' })
    await mod.assertLawManager()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
