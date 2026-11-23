/**
 * WHAT THIS FILE DOES: proves the ONE shared org-settings gate
 * does its job against a fully-mocked DB, no database needed.
 *
 *   1. ROLE GATE: a plain `member`, a `finance` user, a `developer` (which
 *      MUST stay out of this set), and a no-membership caller
 *      are all rejected; only admin / owner get `{ ok: true }`. finance is DENIED on
 *      purpose — finance owns the BOOKS, not the company account; this is the TIGHTEST
 *      of the three gates.
 *   2. THE ORG INVARIANT: with no targetOrgId, the role lookup reads ba_member on
 *      the caller's active org (session.activeOrganizationId).
 *   3. THE CROSS-TENANT GUARD (setup-method's reason for the optional arg): when a
 *      targetOrgId IS passed, the role is looked up in THAT org by the caller's OWN
 *      userId — so a caller who is owner of org A but passes org B's id is checked in B
 *      (where they have no row) and fails closed. setup-method can't write an org
 *      the caller doesn't manage by passing its id.
 *
 * Mirrors assert-build-manager.test.ts. Drives ORG_MANAGE_ROLES from the real
 * '@marginfront/db' export so the seam under test is the actual shared constant.
 */

export {}

import { ORG_MANAGE_ROLES } from '@marginfront/db'

const ORG = 'org-real-1' // where the caller's ba_member row lives
const OTHER_ORG = 'org-other-1' // a DIFFERENT org — the cross-tenant target
const USER = 'user-1'

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
        sessionState.activeOrganizationId || sessionState.userId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: sessionState.userId
                ? { id: sessionState.userId }
                : undefined,
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

type Mod = typeof import('../assert-org-manager')
let mod: Mod

beforeAll(async () => {
  mod = await import('../assert-org-manager')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
})

describe('assertOrgManager — sanity on the shared constant', () => {
  it('locks the org-manage set to admin/owner (NOT finance, NOT developer, NOT member)', () => {
    expect([...ORG_MANAGE_ROLES].sort()).toEqual(['admin', 'owner'])
  })
})

describe('assertOrgManager — DENY paths', () => {
  it('rejects a plain member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/admin or owner/i)
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a finance user — finance owns the books, not the company account', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
  })

  it('rejects a developer — the build role never joins the org-manage set', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'developer' })
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it('rejects when there is no session / no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: null }
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the user id is missing (never lets Prisma drop the userId filter)', async () => {
    sessionState = { activeOrganizationId: ORG, userId: null }
    const gate = await mod.assertOrgManager()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toMatch(/not authenticated/i)
    // Critically, no lookup ran — a `userId: undefined` where would match a stranger.
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('assertOrgManager — ALLOW paths (no targetOrgId)', () => {
  it.each(['admin', 'owner'])(
    'lets a %s through and returns the active org + user id',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const gate = await mod.assertOrgManager()
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
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.assertOrgManager()
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).not.toBe(
      OTHER_ORG
    )
  })
})

describe('assertOrgManager — explicit targetOrgId (cross-tenant guard)', () => {
  it('checks the role in the TARGET org, not the session active org', async () => {
    // Caller is owner in ORG, but asks to act on OTHER_ORG. The lookup MUST key on
    // OTHER_ORG so an attacker can only ever write an org they actually manage.
    baMemberFindFirst.mockResolvedValue(null) // no row for this user in OTHER_ORG
    const gate = await mod.assertOrgManager(OTHER_ORG)
    expect(gate.ok).toBe(false)
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: OTHER_ORG,
      userId: USER,
    })
  })

  it('allows + returns the TARGET org when the caller IS owner/admin there (post-onboarding case)', async () => {
    // The session active org may not be populated yet (fresh signup); the caller passes
    // its new org id and owns it. orgId must be the validated TARGET org so the write
    // lands there — and ONLY there.
    sessionState = { activeOrganizationId: null, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    const gate = await mod.assertOrgManager(OTHER_ORG)
    expect(gate.ok).toBe(true)
    if (gate.ok) expect(gate.orgId).toBe(OTHER_ORG)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      OTHER_ORG
    )
  })
})
