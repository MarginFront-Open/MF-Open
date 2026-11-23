/**
 * WHAT THIS FILE DOES: proves the server-side route guard bounces the wrong
 * roles and lets the right ones through, against a fully-mocked session + DB.
 *
 *   1. DENY: a plain member, a no-membership caller, a no-session caller, and a
 *      caller with no user id are all redirected to /403. For the no-session and
 *      no-userId cases the DB is NEVER queried (fail closed before the lookup).
 *   2. ALLOW: MANAGE_MONEY_ROLES lets owner/admin/finance through and denies
 *      member; ORG_MANAGE_ROLES lets owner/admin through and DENIES finance &
 *      member — proving the two policy sets are genuinely distinct.
 *   3. THE ORG INVARIANT (load-bearing): the ba_member lookup reads the
 *      caller's active org (session.activeOrganizationId).
 *      A guard that read any other org fails here.
 *
 * Mirrors app/actions/_shared/__tests__/assert-money-manager.test.ts. Drives the
 * role sets from the real '@marginfront/db' exports so the seam under test is the
 * actual shared constant, not a copy. redirect() is mocked to THROW (like Next's
 * real redirect, which throws a control-flow error) so it's observable.
 */

export {}

import { MANAGE_MONEY_ROLES, ORG_MANAGE_ROLES } from '@marginfront/db'

const ORG = 'org-real-1' // where the caller's ba_member row lives
const OTHER_ORG = 'org-other-1' // a DIFFERENT org — must never be the lookup org
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
              user: sessionState.userId ? { id: sessionState.userId } : {},
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

// Real redirect() throws to abort rendering; mirror that so a redirect is
// observable as a thrown 'REDIRECT:/403'.
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))

const baMemberFindFirst = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
  },
}))

type Mod = typeof import('../require-route-roles')
let mod: Mod

beforeAll(async () => {
  mod = await import('../require-route-roles')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

// Convenience: run the guard and report whether it redirected to /403.
async function denied(allowed: readonly string[]): Promise<boolean> {
  try {
    await mod.requireRouteRoles(allowed)
    return false
  } catch (e) {
    expect((e as Error).message).toBe('REDIRECT:/403')
    return true
  }
}

describe('requireRouteRoles — shared-constant sanity', () => {
  it('locks the money set to owner/admin/finance', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual([
      'admin',
      'finance',
      'owner',
    ])
  })
  it('locks the org-manage set to owner/admin (no finance)', () => {
    expect([...ORG_MANAGE_ROLES].sort()).toEqual(['admin', 'owner'])
  })
})

describe('requireRouteRoles — DENY paths', () => {
  it('redirects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect(await denied(MANAGE_MONEY_ROLES)).toBe(true)
    // The lookup read the active org, never some other org.
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('redirects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    expect(await denied(MANAGE_MONEY_ROLES)).toBe(true)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('redirects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    expect(await denied(MANAGE_MONEY_ROLES)).toBe(true)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('redirects when there is a session but no user id, WITHOUT a DB lookup', async () => {
    // Guards the Prisma "undefined where-field degenerates to first member" trap.
    sessionState = { activeOrganizationId: ORG, userId: null }
    expect(await denied(MANAGE_MONEY_ROLES)).toBe(true)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('requireRouteRoles — ALLOW paths (money set)', () => {
  it.each(['finance', 'admin', 'owner'])(
    'lets a %s through the money gate',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      expect(await denied(MANAGE_MONEY_ROLES)).toBe(false)
      // Even on the happy path, the role was read in the active org.
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )

  it('denies a member at the money gate', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect(await denied(MANAGE_MONEY_ROLES)).toBe(true)
  })
})

describe('requireRouteRoles — the two sets are DISTINCT (org-manage set)', () => {
  it.each(['admin', 'owner'])(
    'lets a %s through the org-manage gate',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      expect(await denied(ORG_MANAGE_ROLES)).toBe(false)
    }
  )

  it('DENIES finance at the org-manage gate (finance is money-only, not org-mgmt)', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    expect(await denied(ORG_MANAGE_ROLES)).toBe(true)
  })

  it('denies a member at the org-manage gate', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect(await denied(ORG_MANAGE_ROLES)).toBe(true)
  })
})

describe('requireRouteRoles — org invariant', () => {
  it('gates on the active org even when a different org exists in the system', async () => {
    // A lookup keyed on any org other than the session's
    // active org fails this assertion.
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.requireRouteRoles(MANAGE_MONEY_ROLES)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
