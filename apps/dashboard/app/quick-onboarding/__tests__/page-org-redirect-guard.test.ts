/**
 * /quick-onboarding org-redirect guard, driven
 * fully behaviorally against mocked session/DB/redirect (mirrors
 * app/lib/__tests__/require-route-roles.test.ts's technique). page.tsx is
 * an async Server Component, so it can't be RENDERED under this repo's
 * Node-only jest — but calling its default export directly with a mocked
 * searchParams Promise and mocked auth/db/redirect exercises the exact
 * same branch logic a real request would hit, without a database or a browser.
 * QuickOnboardingClient is mocked to a trivial stub so importing page.tsx
 * doesn't pull in its client-component import graph (framer-motion, etc.)
 * — irrelevant to the guard under test.
 *
 * Without ?new=true: bounce to '/' once the ACTIVE
 * org's onboarding_complete is true; otherwise render with canCancel
 * reflecting whether an active org exists at all.
 *
 * With ?new=true (org creation is OWNER-only): bounce to
 * '/' unless the caller holds a confirmed 'owner' ba_member row in their
 * OWN active org. Fails closed on: no session, no active org, no user id,
 * no membership row, or any role other than 'owner' — and never even
 * queries onboarding_complete on this path (additional-org mode must not
 * care whether the active org is already onboarded — it always is).
 */

import type { ReactElement } from 'react'

const ORG = 'org-1'
const USER = 'user-1'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: null, userId: null }

let orgOnboardingComplete = false
const baMemberFindFirst = jest.fn()
const orgFindUnique = jest.fn()

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => {
        if (
          sessionState.activeOrganizationId === null &&
          sessionState.userId === null
        ) {
          return null
        }
        return {
          session: { activeOrganizationId: sessionState.activeOrganizationId },
          user: sessionState.userId ? { id: sessionState.userId } : {},
        }
      },
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
// Real redirect() throws to abort rendering; mirror that so a redirect is
// observable as a thrown 'REDIRECT:/'.
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
jest.mock('@/app/lib/db', () => ({
  db: {
    organizations: { findUnique: (a: unknown) => orgFindUnique(a) },
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
  },
}))
jest.mock('../QuickOnboardingClient', () => ({
  __esModule: true,
  default: () => null,
}))

type Mod = typeof import('../page')
let mod: Mod

beforeAll(async () => {
  mod = await import('../page')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: null, userId: null }
  orgOnboardingComplete = false
  baMemberFindFirst.mockReset()
  orgFindUnique.mockReset()
  orgFindUnique.mockImplementation(async () => ({
    onboarding_complete: orgOnboardingComplete,
  }))
})

type Query = Record<string, string>

// Runs the route; reports whether it redirected to '/', and — when it
// didn't — the canCancel prop it would have rendered QuickOnboardingClient
// with (read straight off the returned element, no rendering needed).
async function run(
  query: Query = {}
): Promise<{ redirected: true } | { redirected: false; canCancel: boolean }> {
  try {
    const el = (await mod.default({
      searchParams: Promise.resolve(query),
    })) as ReactElement<{ canCancel: boolean }>
    return { redirected: false, canCancel: el.props.canCancel }
  } catch (e) {
    expect((e as Error).message).toBe('REDIRECT:/')
    return { redirected: true }
  }
}

describe('/quick-onboarding — first-org guard, no ?new=true', () => {
  it('renders (no redirect), canCancel=false, for a first-time user with no active org', async () => {
    sessionState = { activeOrganizationId: null, userId: null }
    const result = await run()
    expect(result).toEqual({ redirected: false, canCancel: false })
    expect(orgFindUnique).not.toHaveBeenCalled()
  })

  it('renders with canCancel=true when the active org has NOT finished onboarding', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    orgOnboardingComplete = false
    const result = await run()
    expect(result).toEqual({ redirected: false, canCancel: true })
  })

  it("redirects to '/' when the active org HAS finished onboarding", async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    orgOnboardingComplete = true
    expect(await run()).toEqual({ redirected: true })
  })

  it('never queries ba_member on the first-org path', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    await run()
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})

describe('/quick-onboarding?new=true — additional-org guard (owner-only)', () => {
  it('allows an OWNER through even though their active org is already onboarded', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    orgOnboardingComplete = true // must be IRRELEVANT on this path
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })

    const result = await run({ new: 'true' })

    expect(result).toEqual({ redirected: false, canCancel: true })
    // Additional-org mode must never even ask whether the active org is
    // already onboarded — it always is, by construction.
    expect(orgFindUnique).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it.each(['member', 'finance', 'developer', 'admin'])(
    'redirects a %s to "/"',
    async (role) => {
      sessionState = { activeOrganizationId: ORG, userId: USER }
      baMemberFindFirst.mockResolvedValue({ role })
      expect(await run({ new: 'true' })).toEqual({ redirected: true })
    }
  )

  it('redirects when there is no ba_member row at all', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockResolvedValue(null)
    expect(await run({ new: 'true' })).toEqual({ redirected: true })
  })

  it('redirects (fails closed) when the ba_member lookup itself throws', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    baMemberFindFirst.mockRejectedValue(new Error('connection pool timeout'))
    expect(await run({ new: 'true' })).toEqual({ redirected: true })
  })

  it('redirects when there is no session, WITHOUT a DB lookup (fail closed)', async () => {
    sessionState = { activeOrganizationId: null, userId: null }
    expect(await run({ new: 'true' })).toEqual({ redirected: true })
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('redirects when logged in but there is no active org, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: null, userId: USER }
    expect(await run({ new: 'true' })).toEqual({ redirected: true })
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('redirects when there is an active org but no user id, WITHOUT a DB lookup', async () => {
    sessionState = { activeOrganizationId: ORG, userId: null }
    expect(await run({ new: 'true' })).toEqual({ redirected: true })
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })

  it('a plain "/quick-onboarding?new=false" is treated as the first-org path, not additional-org mode', async () => {
    sessionState = { activeOrganizationId: ORG, userId: USER }
    orgOnboardingComplete = false
    const result = await run({ new: 'false' })
    expect(result).toEqual({ redirected: false, canCancel: true })
    expect(baMemberFindFirst).not.toHaveBeenCalled()
  })
})
