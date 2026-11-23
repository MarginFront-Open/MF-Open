/**
 * WHAT THIS FILE DOES: proves the ONE shared money-write gate
 * does its job against a fully-mocked DB, no database needed.
 *
 *   1. ROLE GATE: a plain `member` and a no-membership caller are both rejected;
 *      only finance / admin / owner get an `{ ok: true }`.
 *   2. THE ORG INVARIANT (load-bearing): the role lookup reads ba_member on
 *      the caller's active org (session.activeOrganizationId).
 *      We force the lookup's org to be asserted against the active org so
 *      a guard that gates on the wrong org is caught here, in one place,
 *      instead of leaking into every money action.
 *
 * Mirrors the harness in app/actions/__tests__/finance-period-lock-authz.test.ts.
 * Drives MANAGE_MONEY_ROLES from the real '@marginfront/db' export so the seam under
 * test is the actual shared constant, not a copy.
 */

export {}

import { MANAGE_MONEY_ROLES } from '@marginfront/db'

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

type Mod = typeof import('../assert-money-manager')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-money-manager')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertMoneyManager — sanity on the shared constant', () => {
  it('locks the Manage-MONEY set to owner/admin/finance', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual([
      'admin',
      'finance',
      'owner',
    ])
  })
})

describe('assertMoneyManager — DENY paths', () => {
  it('rejects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const gate = await mod.assertMoneyManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/finance, admin, or owner/i)
    // The lookup read the active org, never some other org.
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertMoneyManager()
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('rejects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    const gate = await mod.assertMoneyManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertMoneyManager — ALLOW paths', () => {
  it.each(['finance', 'admin', 'owner'])(
    'lets a %s through and returns the active org + user id',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertMoneyManager()
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
    await mod.assertMoneyManager()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
