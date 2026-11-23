/**
 * WHAT THIS FILE DOES: proves the API-key mint/revoke door
 * does its job against a fully-mocked DB, no database needed.
 *
 *   1. ROLE GATE: a plain `member` and a no-membership caller are rejected;
 *      admin / owner / developer / FINANCE all get `{ ok: true }` — finance is
 *      the deliberate widening over assertBuildManager.
 *   2. THE MINTER ROLE is returned on success, so a caller can enforce the
 *      per-role mint ceiling (mintableKeyRoles) on top of this door.
 *   3. THE ORG INVARIANT: the role lookup reads ba_member on the caller's
 *      active org (session.activeOrganizationId).
 *
 * Mirrors assert-build-manager.test.ts. Drives MINT_KEY_ROLES from the real
 * '@marginfront/db' export so the seam under test is the actual shared constant.
 */

export {}

import { MINT_KEY_ROLES } from '@marginfront/db'

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

type Mod = typeof import('../assert-key-minter')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-key-minter')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertKeyMinter — sanity on the shared constant', () => {
  it('locks MINT_KEY_ROLES to admin/developer/finance/owner (wider than MANAGE_BUILD_ROLES by finance)', () => {
    expect([...MINT_KEY_ROLES].sort()).toEqual([
      'admin',
      'developer',
      'finance',
      'owner',
    ])
  })
})

describe('assertKeyMinter — DENY paths', () => {
  it('rejects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const gate = await mod.assertKeyMinter()
    expect(gate.ok).toBe(false)
    if (!gate.ok)
      expect(gate.error).toMatch(/owner, admin, developer, or finance/i)
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertKeyMinter()
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('rejects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    const gate = await mod.assertKeyMinter()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertKeyMinter — ALLOW paths', () => {
  it.each(['admin', 'owner', 'developer', 'finance'])(
    'lets a %s through, returns the active org + user id + minterRole',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertKeyMinter()
      expect(gate.ok).toBe(true)
      if (gate.ok) {
        expect(gate.orgId).toBe(ORG)
        expect(gate.userId).toBe(USER)
        expect(gate.minterRole).toBe(role)
      }
      expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
        ORG
      )
    }
  )

  it('gates on the active org even when a different org exists in the system', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.assertKeyMinter()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})
