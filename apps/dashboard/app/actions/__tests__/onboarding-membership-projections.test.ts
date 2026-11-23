/**
 * Completing onboarding leaves a user in ALL THREE membership tables, with this org
 * stamped as their default.
 *
 * WHY THE BACK-FILL EXISTS. Better Auth's organization plugin owns `ba_member` (app/lib/auth.ts
 * maps its `member` model to that table) and mints the creator's canonical row from inside
 * node_modules. It knows nothing about `user_organizations` or `team_members`, so onboarding
 * must write both projections itself, with the canonical role (the gate above it admits owner
 * AND admin, so hardcoding 'owner' would be wrong).
 *
 * WHY IT MUST UPDATE, NOT ONLY CREATE. `afterAddMember` projects the canonical row at
 * ORG-CREATION time, so the row already exists by the time onboarding finishes — with
 * `isDefault` false, because that flag is one-per-user and no per-member hook may set it. A
 * create-if-absent back-fill would find the row, do nothing, and leave every new signup with NO
 * default organization. The store in these tests models the hook having run first, which is
 * the only way that failure is visible: a store that starts empty passes either way.
 *
 * The last test is the one that is easy to leave out. This back-fill sits in the same outer
 * `try` as the welcome email, so a throw here would silently skip the email for a real signup.
 */

export {}

const ORG = 'org-membership-projection'
const OTHER_ORG = 'org-the-user-already-had'
const USER = 'user-membership-projection'

type Row = Record<string, unknown>

let canonicalRole: string | null = 'owner'
let userOrganizationsRows: Row[] = []
let teamMembersRows: Row[] = []
let projectionWriteFails = false
let transactionsOpened = 0
let welcomeEmailsSent = 0

/** Mirrors createMany + skipDuplicates on the (user, org) unique pair. */
const insertMany = (
  rows: Row[],
  data: Row[],
  keyOf: (row: Row) => string
): { count: number } => {
  let count = 0
  for (const item of data) {
    if (rows.some((existing) => keyOf(existing) === keyOf(item))) continue
    rows.push(item)
    count++
  }
  return { count }
}

/** Prisma semantics: an undefined field is dropped, and `{ not: v }` is an inequality. */
const whereMatches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true
    if (value !== null && typeof value === 'object' && 'not' in value) {
      return row[field] !== (value as { not: unknown }).not
    }
    return row[field] === value
  })

const updateMany = (rows: Row[], where: Row, data: Row): { count: number } => {
  const hits = rows.filter((row) => whereMatches(row, where))
  hits.forEach((row) => Object.assign(row, data))
  return { count: hits.length }
}

jest.mock('next/headers', () => ({
  headers: async () => new Map(),
}))

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: USER, name: 'New Signup', email: 'new@example.test' },
      }),
    },
  },
}))

jest.mock('@/app/actions/_shared/assert-org-manager', () => ({
  assertOrgManager: async () => ({ ok: true }),
}))

jest.mock('@/app/lib/db', () => {
  const client: Record<string, unknown> = {
    organizations: {
      findUnique: async () => ({
        onboarding_complete: false,
        designjson: null,
        owner_id: USER,
      }),
      update: async () => ({ id: ORG }),
    },
    users: {
      findUnique: async () => ({
        id: USER,
        name: 'New Signup',
        email: 'new@example.test',
      }),
      update: async () => ({ id: USER }),
    },
    ba_member: {
      findFirst: async () =>
        canonicalRole === null ? null : { role: canonicalRole },
    },
    user_organizations: {
      // The second-org lookup the welcome email reads. Always "no other org".
      findFirst: async () => null,
      createMany: async ({ data }: { data: Row[] }) => {
        if (projectionWriteFails) throw new Error('pooler connection dropped')
        return insertMany(
          userOrganizationsRows,
          data,
          (r) => `${r.userId}::${r.organizationId}`
        )
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (projectionWriteFails) throw new Error('pooler connection dropped')
        return updateMany(userOrganizationsRows, where, data)
      },
    },
    team_members: {
      createMany: async ({ data }: { data: Row[] }) =>
        insertMany(
          teamMembersRows,
          data,
          (r) => `${r.user_id}::${r.organization_id}`
        ),
      updateMany: async ({ where, data }: { where: Row; data: Row }) =>
        updateMany(teamMembersRows, where, data),
    },
  }

  // The tx handed to the callback has NO $transaction, matching Prisma's interactive-transaction
  // deny list. The shared helpers read that absence to decide whether to open one, so a double
  // that kept it would exercise a nesting path the real client cannot reach.
  client.$transaction = async (
    run: (tx: Record<string, unknown>) => Promise<unknown>
  ) => {
    transactionsOpened++
    const { $transaction: _denied, ...tx } = client
    return run(tx)
  }

  return { Prisma: {}, db: client }
})

jest.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async () => {
        welcomeEmailsSent++
        return { error: null }
      },
    }
  },
}))

beforeEach(() => {
  jest.resetModules()
  canonicalRole = 'owner'
  userOrganizationsRows = []
  teamMembersRows = []
  projectionWriteFails = false
  transactionsOpened = 0
  welcomeEmailsSent = 0

  // lib/api/config.ts throws at module load without this, and onboarding.ts imports it.
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:4000/v1'
  process.env.RESEND_API_KEY = 're_fake_key'
  process.env.RESEND_FROM_EMAIL = 'team@marginfront.test'

  global.fetch = jest.fn(
    async () =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response
  ) as unknown as typeof fetch
})

/**
 * What `afterAddMember` leaves behind at org-creation time: both mirror rows present, isDefault
 * false. Every real dashboard signup reaches onboarding in this state.
 */
function seedRowsTheHookAlreadyWrote(role = 'owner'): void {
  userOrganizationsRows.push({
    id: 'uo-from-hook',
    userId: USER,
    organizationId: ORG,
    role: role === 'owner' ? 'owner' : 'member',
    isDefault: false,
  })
  teamMembersRows.push({
    id: 'tm-from-hook',
    user_id: USER,
    organization_id: ORG,
    role: role === 'owner' || role === 'admin' ? 'admin' : 'member',
    status: 'active',
  })
}

async function completeOnboarding() {
  const { updateOnboardingStatus } = await import('../onboarding')
  return updateOnboardingStatus({ onboardingComplete: true })
}

describe('onboarding back-fills BOTH projections, not just one', () => {
  it('writes user_organizations AND team_members for the new org', async () => {
    await completeOnboarding()

    expect(userOrganizationsRows).toHaveLength(1)
    // team_members is the projection that is easy to forget.
    expect(teamMembersRows).toHaveLength(1)
    expect(userOrganizationsRows[0]).toMatchObject({
      userId: USER,
      organizationId: ORG,
      role: 'owner',
      isDefault: true,
    })
    expect(teamMembersRows[0]).toMatchObject({
      user_id: USER,
      organization_id: ORG,
      role: 'admin',
    })
  })

  it('projects the CANONICAL role instead of hardcoding owner', async () => {
    // assertOrgManager admits owner AND admin, so an admin can reach this line. Stamping
    // 'owner' on their projection row regardless would invent ownership, the one wrong
    // answer that would matter if anything ever read the column.
    canonicalRole = 'admin'

    await completeOnboarding()

    // 'admin' has no representation in enum_user_organizations_role {member, owner,
    // superadmin}, so it flattens to member; enum_team_members_role {admin, member} keeps it.
    expect(userOrganizationsRows[0].role).toBe('member')
    expect(teamMembersRows[0].role).toBe('admin')
  })

  it('is idempotent: completing onboarding twice leaves one row per table', async () => {
    // The helper is createMany + skipDuplicates, not a separate exists-check.
    await completeOnboarding()
    await completeOnboarding()

    expect(userOrganizationsRows).toHaveLength(1)
    expect(teamMembersRows).toHaveLength(1)
  })

  it('falls back to member, never owner, when no canonical row can be read', async () => {
    canonicalRole = null

    await completeOnboarding()

    expect(userOrganizationsRows[0].role).toBe('member')
  })

  it('a failed back-fill does NOT skip the welcome email', async () => {
    projectionWriteFails = true

    const result = await completeOnboarding()

    // Onboarding still completes and the welcome email still goes out. If this goes red, the
    // back-fill has escaped its own try/catch and a repair failure is skipping the rest of
    // the completion work.
    expect(result.success).toBe(true)
    expect(welcomeEmailsSent).toBe(1)
  })
})

describe('the new org becomes the default even though the hook wrote the row first', () => {
  it('flips isDefault on a row afterAddMember already created', async () => {
    // THE FAILURE THIS FILE EXISTS TO CATCH. A create-if-absent back-fill finds this row,
    // skips it on the unique pair, and leaves isDefault false forever — so a brand-new signup
    // has no default org, and getCurrentOrganization falls through to whatever ba_member.createdAt
    // ordering happens to put first (getCurrentOrganization in apps/api-nest/src/modules/
    // organizations/organizations.service.ts). A store that starts EMPTY cannot see this.
    seedRowsTheHookAlreadyWrote()

    await completeOnboarding()

    expect(userOrganizationsRows).toHaveLength(1)
    expect(userOrganizationsRows[0]).toMatchObject({
      id: 'uo-from-hook',
      isDefault: true,
    })
  })

  it('clears the flag on the user OTHER orgs, so they never hold two defaults', async () => {
    // isDefault is one flag across all of a user's orgs, not a property of one membership. Two
    // of them is a user whose current org depends on row order.
    userOrganizationsRows.push({
      id: 'uo-older-org',
      userId: USER,
      organizationId: OTHER_ORG,
      role: 'owner',
      isDefault: true,
    })
    seedRowsTheHookAlreadyWrote()

    await completeOnboarding()

    const byOrg = Object.fromEntries(
      userOrganizationsRows.map((r) => [r.organizationId, r.isDefault])
    )
    expect(byOrg).toEqual({ [ORG]: true, [OTHER_ORG]: false })
  })

  it('opens ONE transaction, so the clear and the set cannot land apart', async () => {
    // Outside a transaction, a failure between "clear every flag" and "set this one" leaves the
    // user with no default org at all — the same end state as the create-if-absent failure
    // above, arrived at by a different route.
    seedRowsTheHookAlreadyWrote()

    await completeOnboarding()

    expect(transactionsOpened).toBe(1)
  })

  it('still repairs a mirror row the hook failed to write', async () => {
    // The hook is best-effort: user_organizations can exist while team_members does not. The
    // back-fill has to create what is missing, not only flip a flag on what is there.
    userOrganizationsRows.push({
      id: 'uo-from-hook',
      userId: USER,
      organizationId: ORG,
      role: 'owner',
      isDefault: false,
    })

    await completeOnboarding()

    expect(teamMembersRows).toHaveLength(1)
    expect(teamMembersRows[0]).toMatchObject({
      user_id: USER,
      organization_id: ORG,
      role: 'admin',
      status: 'active',
    })
  })
})
