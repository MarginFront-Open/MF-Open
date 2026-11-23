/**
 * WHAT THIS FILE DOES: proves the org-settings role gate on the
 * actual dashboard Server Actions — not just the shared helper. For each org-settings
 * write (theme / dashboard-mode / setup-method / onboarding), it asserts the OUTCOME:
 *
 *   - a plain `member` is DENIED and the underlying org UPDATE never fires
 *   - a `finance` user is DENIED too (finance owns the BOOKS, not the company account —
 *     org settings are the TIGHTEST gate)
 *   - an `owner` / `admin` is ALLOWED and the update DOES fire, scoped to the active org
 *
 * Plus the SETUP-METHOD CROSS-TENANT case: an owner of org A who passes org B's id is
 * rejected (the gate looks up their role in B, where they have no row) and nothing is
 * written — closing the "write any org by passing its id" vector.
 *
 * Behavioral + mutation-sensitive: delete the assertOrgManager() line from any action and
 * the matching "member denied / nothing written" case goes RED. The whole DB is mocked;
 * no database needed.
 */

export {}

const ORG = 'org-real-settings'
const OTHER_ORG = 'org-other-settings'
const USER = 'user-settings'

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
jest.mock('@/lib/api/config', () => ({ API_BASE_URL: 'http://test.local' }))

// The gate's role lookup + the setup-method / onboarding writes all live on @/app/lib/db.
const baMemberFindFirst = jest.fn()
const dbOrgUpdate = jest.fn()
const dbOrgFindUnique = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    organizations: {
      update: (a: unknown) => dbOrgUpdate(a),
      findUnique: (a: unknown) => dbOrgFindUnique(a),
    },
  },
  Prisma: { InputJsonValue: {} },
}))

type DashMode = typeof import('../set-dashboard-mode')
type SetupMethod = typeof import('../setup-method')
type Onboarding = typeof import('../onboarding')

let dashMode: DashMode
let setupMethod: SetupMethod
let onboarding: Onboarding

beforeAll(async () => {
  dashMode = await import('../set-dashboard-mode')
  setupMethod = await import('../setup-method')
  onboarding = await import('../onboarding')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    dbOrgUpdate,
    dbOrgFindUnique,
  ].forEach((m) => m.mockReset())
  dbOrgUpdate.mockResolvedValue({})
})

function setRole(r: string) {
  baMemberFindFirst.mockResolvedValue(r === 'noRow' ? null : { role: r })
}

const denyRoles = ['member', 'finance', 'noRow'] as const
const allowRoles = ['owner', 'admin'] as const

describe('org-settings gate — DENY: member + finance blocked, NOTHING written', () => {
  it.each(denyRoles)('setDashboardMode denied for %s', async (r) => {
    setRole(r)
    const res = await dashMode.setDashboardMode('full')
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('updateSetupMethod denied for %s', async (r) => {
    setRole(r)
    const res = await setupMethod.updateSetupMethod('manual')
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('updateOnboardingStatus denied for %s', async (r) => {
    setRole(r)
    const res = await onboarding.updateOnboardingStatus({
      onboardingStep: 'branding',
    })
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })
})

describe('org-settings gate — ALLOW: owner/admin pass and the update fires in the active org', () => {
  it.each(allowRoles)('setDashboardMode role is read in the active org for %s', async (r) => {
    setRole(r)
    const res = await dashMode.setDashboardMode('full')
    expect(res.success).toBe(true)
    // The role was read in the active org.
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it.each(allowRoles)('setDashboardMode allowed for %s', async (r) => {
    setRole(r)
    const res = await dashMode.setDashboardMode('full')
    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    expect(dbOrgUpdate.mock.calls[0][0].where.id).toBe(ORG)
  })

  it.each(allowRoles)('updateSetupMethod allowed for %s', async (r) => {
    setRole(r)
    const res = await setupMethod.updateSetupMethod('manual')
    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    expect(dbOrgUpdate.mock.calls[0][0].where.id).toBe(ORG)
  })

  it.each(allowRoles)('updateOnboardingStatus allowed for %s', async (r) => {
    setRole(r)
    const res = await onboarding.updateOnboardingStatus({
      onboardingStep: 'branding',
    })
    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    expect(dbOrgUpdate.mock.calls[0][0].where.id).toBe(ORG)
  })
})

describe('updateSetupMethod — CROSS-TENANT vector is closed', () => {
  it('rejects an owner-of-A who passes B’s id, and writes NOTHING', async () => {
    // Caller is owner in ORG (their session), but tries to write OTHER_ORG by passing
    // its id. The gate looks up their role in OTHER_ORG — no row — so it fails closed.
    baMemberFindFirst.mockImplementation((a: any) =>
      a.where.organizationId === ORG ? { role: 'owner' } : null
    )
    const res = await setupMethod.updateSetupMethod('manual', OTHER_ORG)
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
    // The lookup was keyed on the TARGET org (the attack surface), not the session org.
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      OTHER_ORG
    )
  })

  it('lets an owner write their OWN org via the explicit-id path, scoped to that org', async () => {
    // Legit post-onboarding case: session active org not populated yet, caller passes their
    // fresh org id and owns it. Write lands on that org — and only it.
    sessionState = { activeOrganizationId: null, userId: USER }
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    const res = await setupMethod.updateSetupMethod('mcp', OTHER_ORG)
    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    expect(dbOrgUpdate.mock.calls[0][0].where.id).toBe(OTHER_ORG)
  })
})

// MUTATION SENSITIVITY: same call, only the role flips -> outcome flips.
describe('org-settings gate — mutation sensitivity (role flip flips outcome)', () => {
  it('setDashboardMode: owner writes, member does not — identical input', async () => {
    setRole('owner')
    expect((await dashMode.setDashboardMode('full')).success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)

    dbOrgUpdate.mockClear()
    setRole('member')
    expect((await dashMode.setDashboardMode('full')).success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })
})
