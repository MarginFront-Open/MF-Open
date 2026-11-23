/**
 * The membership writes Better Auth makes behind our back.
 *
 * Better Auth's organization plugin owns `ba_member` and writes it from inside node_modules on
 * org creation, member add, role change and member removal. Nothing in our source calls Prisma
 * on those paths, so a search of our source cannot find them and neither can a reviewer. These hooks
 * are the only place the projections can be kept in step, which makes them worth a test that
 * pins BOTH halves of the contract: they write the right rows, and they never throw.
 *
 * The never-throw half is not defensive padding. Better Auth AWAITS these hooks, so a throw here
 * fails the request that triggered it: a projection row that could not be written would block a
 * signup or an invite acceptance. The projections gate nothing (every authorization surface reads
 * ba_member), so failing the user is strictly the worse trade.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { leftOrganization, membershipProjectionHooks } from '../membership-hooks'

const ORG = 'org-better-auth'
const USER = 'user-better-auth'

type Row = Record<string, unknown>

/**
 * Prisma semantics the helpers actually rely on: an `undefined` field is dropped from the query,
 * and `{ not: v }` is an inequality. The second one is not padding — `role: { not: 'superadmin' }`
 * is what stops a projection row nothing in this codebase can produce from being demoted, and a
 * double that read it as a literal object would match nothing and prove the wrong thing.
 */
const whereMatches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true
    if (value !== null && typeof value === 'object' && 'not' in value) {
      return row[field] !== (value as { not: unknown }).not
    }
    return row[field] === value
  })

function makeStore() {
  const userOrganizations: Row[] = []
  const teamMembers: Row[] = []
  const failures = new Set<string>()

  const guard = <T>(key: string, run: () => T): T => {
    if (failures.has(key)) throw new Error(`${key} exploded`)
    return run()
  }

  const table = (rows: Row[], name: string, uniqueBy: string[]) => {
    const key = (row: Row) => uniqueBy.map((f) => row[f]).join('::')
    return {
      createMany: async ({ data }: { data: Row[] }) =>
        guard(`${name}.createMany`, () => {
          let count = 0
          for (const item of data) {
            if (rows.some((r) => key(r) === key(item))) continue
            rows.push({ ...item })
            count++
          }
          return { count }
        }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) =>
        guard(`${name}.updateMany`, () => {
          const hits = rows.filter((r) => whereMatches(r, where))
          hits.forEach((r) => Object.assign(r, data))
          return { count: hits.length }
        }),
      deleteMany: async ({ where }: { where?: Row } = {}) =>
        guard(`${name}.deleteMany`, () => {
          const before = rows.length
          const kept = rows.filter((r) => !whereMatches(r, where))
          rows.length = 0
          rows.push(...kept)
          return { count: before - rows.length }
        }),
    }
  }

  const client: Record<string, unknown> = {
    user_organizations: table(userOrganizations, 'user_organizations', [
      'userId',
      'organizationId',
    ]),
    team_members: table(teamMembers, 'team_members', [
      'user_id',
      'organization_id',
    ]),
  }

  // auth.ts hands the hooks a real top-level PrismaClient, so the double has $transaction too —
  // that is what makes the helpers open one, which is the only reason the two mirrors cannot
  // split from each other on this path. The tx handed to the callback has it stripped, matching
  // Prisma's interactive-transaction deny list.
  client.$transaction = async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = {
      uo: userOrganizations.map((r) => ({ ...r })),
      tm: teamMembers.map((r) => ({ ...r })),
    }
    const { $transaction: _denied, ...tx } = client
    try {
      return await run(tx)
    } catch (error) {
      userOrganizations.length = 0
      userOrganizations.push(...snapshot.uo)
      teamMembers.length = 0
      teamMembers.push(...snapshot.tm)
      throw error
    }
  }

  return {
    client: client as never,
    userOrganizations,
    teamMembers,
    failures,
  }
}

const member = (role: string) => ({
  organizationId: ORG,
  userId: USER,
  role,
})

let errors: unknown[][]

beforeEach(() => {
  errors = []
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args)
  })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Better Auth hooks project every membership row it mints', () => {
  it('afterAddMember writes both projections (org creation mints the owner row here)', async () => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)

    await hooks.afterAddMember({ member: member('owner') })

    expect(store.userOrganizations).toHaveLength(1)
    expect(store.teamMembers).toHaveLength(1)
    expect(store.userOrganizations[0]).toMatchObject({
      userId: USER,
      organizationId: ORG,
      role: 'owner',
    })
  })

  it('afterAcceptInvitation writes both projections', async () => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)

    await hooks.afterAcceptInvitation({ member: member('finance') })

    // 'finance' exists in neither projection enum, so it flattens both ways.
    expect(store.userOrganizations[0]).toMatchObject({ role: 'member' })
    expect(store.teamMembers[0]).toMatchObject({ role: 'member' })
  })

  it('afterUpdateMemberRole re-projects using the NEW role Better Auth hands over', async () => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)
    await hooks.afterAddMember({ member: member('member') })

    // Better Auth passes the already-updated row, so member.role is the new role.
    await hooks.afterUpdateMemberRole({ member: member('admin') })

    expect(store.userOrganizations[0].role).toBe('member')
    // owner/admin both collapse to 'admin' in team_members' two-value enum.
    expect(store.teamMembers[0].role).toBe('admin')
  })

  it('afterRemoveMember clears both projections', async () => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)
    await hooks.afterAddMember({ member: member('member') })

    await hooks.afterRemoveMember({ member: member('member') })

    expect(store.userOrganizations).toEqual([])
    expect(store.teamMembers).toEqual([])
  })

  it('afterDeleteOrganization clears the whole org, because no per-member hook fires', async () => {
    // Better Auth's /organization/delete bulk-deletes every ba_member row for the org in one
    // statement and fires NO afterRemoveMember for any of them
    // (deleteOrganization in better-auth's organization plugin adapter). user_organizations
    // would follow by FK cascade on its own; team_members declares no relation to organizations
    // in schema.prisma, so without this hook its rows survive pointing at an org id that
    // no longer exists.
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)
    await hooks.afterAddMember({ member: member('owner') })
    await hooks.afterAddMember({
      member: { organizationId: ORG, userId: 'someone-else', role: 'member' },
    })
    // A DIFFERENT org the same user belongs to. An unscoped sweep would take this with it and
    // silently strip them from an org nobody deleted, so the scoping is the assertion.
    await hooks.afterAddMember({
      member: { organizationId: 'org-untouched', userId: USER, role: 'owner' },
    })

    await hooks.afterDeleteOrganization({ organization: { id: ORG } })

    expect(store.userOrganizations.map((r) => r.organizationId)).toEqual([
      'org-untouched',
    ])
    expect(store.teamMembers.map((r) => r.organization_id)).toEqual([
      'org-untouched',
    ])
  })
})

describe('the fifth door: /api/auth/organization/leave', () => {
  // Better Auth gives this route NO organizationHooks entry at all: leaveOrganization calls
  // adapter.deleteMember and fires nothing (crud-members in the organization plugin). It is
  // mounted for every session holder whether our UI links to it or not, so without a hook a user
  // leaving an org loses their canonical row while both mirrors survive forever. app/lib/auth.ts
  // reaches it with a `hooks.after` path matcher instead, and calls
  // this function.
  it('clears both projections for the member who left', async () => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)
    await hooks.afterAddMember({ member: member('member') })

    await leftOrganization(store.client, member('member'))

    expect(store.userOrganizations).toEqual([])
    expect(store.teamMembers).toEqual([])
  })

  it('is actually wired up in auth.ts, which is the only place it can be', async () => {
    // A source-shape assertion, like create-organization/__tests__/index-branding.test.ts.
    // Booting Better Auth in jest would need a database and the whole plugin chain, and the
    // realistic failure is not the logic below; it is someone editing auth.ts and dropping
    // the matcher, at which point leftOrganization is exported, tested, and called by nothing.
    // The five organizationHooks entries cannot rot that way; this one can, so it gets a gate.
    const source = readFileSync(join(__dirname, '..', 'auth.ts'), 'utf8')

    expect(source).toMatch(/after:\s*createAuthMiddleware/)
    expect(source).toContain("'/organization/leave'")
    expect(source).toMatch(/leftOrganization\s*\(/)
  })

  it('swallows a database failure, like the five hooks beside it', async () => {
    // It runs AFTER Better Auth has committed the canonical delete, so throwing would fail a
    // request whose real work is already done and cannot be undone.
    const store = makeStore()
    store.failures.add('user_organizations.deleteMany')

    await expect(
      leftOrganization(store.client, member('member'))
    ).resolves.toBeUndefined()

    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('MEMBERSHIP_PROJECTION_DRIFT')
  })
})

describe('a failing projection write never fails the request', () => {
  it.each([
    ['afterAddMember', 'user_organizations.createMany'],
    ['afterAcceptInvitation', 'team_members.createMany'],
    ['afterUpdateMemberRole', 'user_organizations.updateMany'],
    ['afterRemoveMember', 'team_members.deleteMany'],
  ])('%s swallows a database failure and logs it', async (hook, failing) => {
    const store = makeStore()
    const hooks = membershipProjectionHooks(store.client)
    store.failures.add(failing)

    // If any of these reject, Better Auth propagates it and the org creation / invite
    // acceptance that triggered the hook fails for the user.
    await expect(
      (hooks as Record<string, (arg: unknown) => Promise<void>>)[hook]({
        member: member('owner'),
      })
    ).resolves.toBeUndefined()

    // Silence would be worse than the drift: this line is what an operator greps for, and it
    // has to say what to do next.
    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('MEMBERSHIP_PROJECTION_DRIFT')
    expect(String(errors[0][0])).toMatch(/No action is needed|Settings, then Team/)
  })
})
