/**
 * assertPortalManager against a mocked ba_member. The allow-list comes from the
 * real MANAGE_MONEY_ROLES export, so widening that set shows up here.
 */

export {}

import { MANAGE_MONEY_ROLES } from '@marginfront/db'

const ORG = 'org-real-portal'
const OTHER_ORG = 'org-other-portal'
const USER = 'user-portal'

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
              user: sessionState.userId
                ? { id: sessionState.userId, email: 'a@example.com' }
                : {},
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

type Mod = typeof import('../assert-portal-manager')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-portal-manager')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertPortalManager — sanity on the shared constant', () => {
  it('gates on the Manage-MONEY set, owner/admin/finance', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual([
      'admin',
      'finance',
      'owner',
    ])
  })
})

describe('assertPortalManager — DENY paths', () => {
  it.each(['member', 'developer', 'legal'])(
    'refuses a %s as forbidden, reading the active org',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertPortalManager()
      expect(gate.ok).toBe(false)
      if (!gate.ok) {
        expect(gate.reason).toBe('forbidden')
        expect(gate.error).toMatch(/finance, admin, or owner/i)
      }
      expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
        organizationId: ORG,
        userId: USER,
      })
    }
  )

  it('refuses a caller with no membership row as forbidden', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertPortalManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.reason).toBe('forbidden')
  })

  it('refuses no session / no active org as unauthenticated, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    const gate = await mod.assertPortalManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.reason).toBe('unauthenticated')
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('refuses a session with no user id as unauthenticated, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: ORG, userId: null }
    const gate = await mod.assertPortalManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.reason).toBe('unauthenticated')
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertPortalManager — ALLOW paths', () => {
  it.each(['finance', 'admin', 'owner'])(
    'lets a %s through and returns the active org, user id and session',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertPortalManager()
      expect(gate.ok).toBe(true)
      if (gate.ok) {
        expect(gate.orgId).toBe(ORG)
        expect(gate.userId).toBe(USER)
        expect(gate.session.user.email).toBe('a@example.com')
      }
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )

  it('never reads the role from another org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.assertPortalManager()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
