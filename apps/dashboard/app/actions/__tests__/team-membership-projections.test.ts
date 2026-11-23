/**
 * The Team UI's own Server Actions keep all three membership
 * tables in step.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM api-nest's membership.spec.ts. api-nest is covered by
 * its own membership sweep, but the dashboard Team page calls THESE actions, never api-nest. If
 * one of them wrote `ba_member` alone, every add, re-role and remove in the Team page would
 * create the drift the api-nest side prevents: canonical rows with no `user_organizations`
 * row, so an added teammate couldn't see the org in their own org list.
 *
 * The tests drive the REAL exported Server Actions against ONE in-memory store, with the REAL
 * projection helpers from @marginfront/db (deliberately NOT mocked — mocking them would test that
 * the actions call a function, which is not the property under test). Only the seams outside
 * the database are stubbed: the session, next/headers, next/cache.
 *
 * The store reproduces three real Prisma behaviours, because a store that papered over them
 * would prove nothing:
 *   - `where` fields whose value is `undefined` are DROPPED, not compared.
 *   - `createMany({ skipDuplicates: true })` skips on the unique pair instead of throwing.
 *   - A throwing `$transaction` callback ROLLS BACK. Without that, a removal that clears two of
 *     three tables and then dies would look like a pass.
 *
 * It also records whether each write happened INSIDE a transaction, because "all three tables
 * end up right" is only half the requirement. Three sequential statements reach the same steady
 * state and still mint an orphan row the moment a pooler connection drops between them.
 */

export {}

const ORG = '11111111-1111-4111-8111-111111111111'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NEWCOMER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Row = Record<string, any>

/**
 * Mirrors Prisma: a `where` field whose value is `undefined` is DROPPED from the query rather
 * than compared, so a lookup with `userId: undefined` degenerates to "the first row".
 */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(
    ([field, value]) => value === undefined || row[field] === value
  )
}

interface WriteEntry {
  op: string
  inTransaction: boolean
}

class Table {
  rows: Row[] = []

  constructor(
    private readonly name: string,
    private readonly uniqueBy: string[],
    private readonly log: (op: string) => void
  ) {}

  private key = (row: Row) => this.uniqueBy.map((f) => row[f]).join('::')

  findFirst = async ({ where }: any = {}) =>
    this.rows.find((r) => matches(r, where)) ?? null

  findUnique = async ({ where }: any = {}) =>
    this.rows.find((r) => matches(r, where)) ?? null

  findMany = async ({ where }: any = {}) =>
    this.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))

  count = async ({ where }: any = {}) =>
    this.rows.filter((r) => matches(r, where)).length

  create = async ({ data }: any) => {
    this.log(`${this.name}.create`)
    const row = { ...data }
    this.rows.push(row)
    return { ...row }
  }

  createMany = async ({ data, skipDuplicates }: any) => {
    this.log(`${this.name}.createMany`)
    let count = 0
    for (const item of data) {
      if (this.rows.some((r) => this.key(r) === this.key(item))) {
        if (!skipDuplicates) {
          throw new Error(`unique constraint violated on ${this.name}`)
        }
        continue
      }
      this.rows.push({ ...item })
      count++
    }
    return { count }
  }

  update = async ({ where, data }: any) => {
    this.log(`${this.name}.update`)
    const row = this.rows.find((r) => matches(r, where))
    if (!row) throw new Error(`${this.name}.update matched no row`)
    Object.assign(row, data)
    return { ...row }
  }

  updateMany = async ({ where, data }: any) => {
    this.log(`${this.name}.updateMany`)
    const hits = this.rows.filter((r) => matches(r, where))
    hits.forEach((r) => Object.assign(r, data))
    return { count: hits.length }
  }

  delete = async ({ where }: any) => {
    this.log(`${this.name}.delete`)
    const index = this.rows.findIndex((r) => matches(r, where))
    if (index === -1) throw new Error(`${this.name}.delete matched no row`)
    return this.rows.splice(index, 1)[0]
  }

  deleteMany = async ({ where }: any = {}) => {
    this.log(`${this.name}.deleteMany`)
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !matches(r, where))
    return { count: before - this.rows.length }
  }
}

function makeStore() {
  const writeLog: WriteEntry[] = []
  let transactionDepth = 0
  const log = (op: string) =>
    writeLog.push({ op, inTransaction: transactionDepth > 0 })

  const tables = {
    ba_member: new Table('ba_member', ['organizationId', 'userId'], log),
    user_organizations: new Table(
      'user_organizations',
      ['userId', 'organizationId'],
      log
    ),
    team_members: new Table(
      'team_members',
      ['user_id', 'organization_id'],
      log
    ),
    users: new Table('users', ['id'], log),
    ba_session: new Table('ba_session', ['id'], log),
  }

  const withUser = (row: Row) => ({
    ...row,
    users: tables.users.rows.find((u) => u.id === row.userId) ?? null,
  })

  // `include` support only where the actions actually ask for it.
  const ba_member = {
    ...tables.ba_member,
    create: async ({ data, include }: any) => {
      const row = await tables.ba_member.create({ data })
      return include?.users ? withUser(row) : row
    },
    update: async ({ where, data, include }: any) => {
      const row = await tables.ba_member.update({ where, data })
      return include?.users ? withUser(row) : row
    },
  }

  const store: any = { ...tables, ba_member }

  /**
   * The FOR UPDATE owner lock countOwnersForUpdate issues. An in-memory store cannot prove
   * serialization — that is the database's job, and the reason the guard is a lock
   * rather than a re-count — but it returns the owner set the locked recount reads.
   */
  store.$queryRaw = async (
    _strings: TemplateStringsArray,
    organizationId: string
  ) =>
    tables.ba_member.rows
      .filter((r) => r.organizationId === organizationId && r.role === 'owner')
      .map((r) => ({ id: r.id }))

  store.$transaction = async (cb: any) => {
    transactionDepth++
    const snapshot = Object.values(tables).map(
      (t) => [t, t.rows.map((r) => ({ ...r }))] as [Table, Row[]]
    )
    try {
      return await cb(store)
    } catch (e) {
      snapshot.forEach(([table, rows]) => {
        table.rows = rows
      })
      throw e
    } finally {
      transactionDepth--
    }
  }

  return { store, tables, writeLog }
}

type Store = ReturnType<typeof makeStore>

let current: Store
let actingUserId: string | undefined = OWNER

jest.mock('next/headers', () => ({
  headers: async () => new Map(),
}))

jest.mock('next/cache', () => ({
  revalidatePath: () => undefined,
}))

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: actingUserId },
      }),
    },
  },
  sendInviteAcceptEmail: async () => undefined,
}))

jest.mock('@/app/lib/db', () => ({
  db: new Proxy(
    {},
    {
      // Resolved per property access so each test's fresh store is the one the
      // module-level `db` import points at.
      get: (_target, prop) => (current.store as Row)[prop as string],
    }
  ),
}))

/** A canonical membership row with NO projection, as Better Auth leaves when it writes ba_member directly. */
function seedCanonicalOnly(store: Store, userId: string, role: string): void {
  store.tables.ba_member.rows.push({
    id: `member-${userId.slice(0, 8)}`,
    organizationId: ORG,
    userId,
    role,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
}

const projectionRows = (
  store: Store,
  table: 'user_organizations' | 'team_members',
  userId: string
) =>
  store.tables[table].rows.filter((r) => (r.userId ?? r.user_id) === userId)

const memberIdOf = (store: Store, userId: string) =>
  store.tables.ba_member.rows.find((r) => r.userId === userId)!.id

beforeEach(() => {
  current = makeStore()
  actingUserId = OWNER
  current.tables.users.rows.push(
    { id: OWNER, email: 'owner@example.test', name: 'Owner' },
    { id: SECOND_OWNER, email: 'second@example.test', name: 'Second Owner' },
    { id: NEWCOMER, email: 'new@example.test', name: 'Newcomer' }
  )
  seedCanonicalOnly(current, OWNER, 'owner')
})

describe('a member added through the Team UI lands in all three tables', () => {
  it('addMember writes ba_member AND both projections', async () => {
    const { addMember } = await import('../team')

    const result = await addMember({ email: 'new@example.test', role: 'admin' })

    expect(result.success).toBe(true)
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)
    ).toHaveLength(1)
    // Without this row the org never appears
    // in the new teammate's own org list (three Server Actions read this table
    // as an org list, keyed on userId).
    expect(projectionRows(current, 'user_organizations', NEWCOMER)).toHaveLength(
      1
    )
    expect(projectionRows(current, 'team_members', NEWCOMER)).toHaveLength(1)
  })

  it('projects the canonical role down each lossy mirror rather than copying it', async () => {
    const { addMember } = await import('../team')

    // `admin` exists in neither projection's enum: enum_user_organizations_role is
    // {member, owner, superadmin} and enum_team_members_role is {admin, member}. Copying
    // the canonical string across would be a write Postgres rejects.
    await addMember({ email: 'new@example.test', role: 'admin' })

    expect(projectionRows(current, 'user_organizations', NEWCOMER)[0].role).toBe(
      'member'
    )
    expect(projectionRows(current, 'team_members', NEWCOMER)[0].role).toBe(
      'admin'
    )
  })

  it('writes all three inside ONE transaction, not three statements in a row', async () => {
    const { addMember } = await import('../team')

    await addMember({ email: 'new@example.test', role: 'member' })

    const membershipWrites = current.writeLog.filter((w) =>
      /^(ba_member|user_organizations|team_members)\./.test(w.op)
    )
    expect(membershipWrites.length).toBeGreaterThanOrEqual(3)
    // If this fails, someone "fixed" the pairing with sequential statements. The steady state
    // looks identical and a dropped connection between them mints the orphan row again.
    expect(membershipWrites.filter((w) => !w.inTransaction)).toEqual([])
  })

  it('a failed projection write rolls the canonical row back (no half-member)', async () => {
    const { addMember } = await import('../team')
    current.tables.team_members.createMany = async () => {
      throw new Error('pooler connection dropped')
    }

    const result = await addMember({ email: 'new@example.test', role: 'member' })

    expect(result.success).toBe(false)
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)
    ).toEqual([])
    expect(projectionRows(current, 'user_organizations', NEWCOMER)).toEqual([])
  })
})

describe('a member removed through the Team UI is gone from all three', () => {
  it('removeMember clears ba_member AND both projections', async () => {
    const { addMember, removeMember } = await import('../team')
    await addMember({ email: 'new@example.test', role: 'member' })

    const result = await removeMember(memberIdOf(current, NEWCOMER))

    expect(result.success).toBe(true)
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)
    ).toEqual([])
    // A removed person must lose their user_organizations row too, or they
    // still show up as belonging to the org.
    expect(projectionRows(current, 'user_organizations', NEWCOMER)).toEqual([])
    expect(projectionRows(current, 'team_members', NEWCOMER)).toEqual([])
  })

  it('removes a member who never had projection rows without throwing', async () => {
    // A member Better Auth minted directly is in this state.
    // deleteMembershipProjections is purely subtractive, so it must be a no-op, not a 500.
    const { removeMember } = await import('../team')
    seedCanonicalOnly(current, NEWCOMER, 'member')

    const result = await removeMember(memberIdOf(current, NEWCOMER))

    expect(result).toEqual({ success: true })
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)
    ).toEqual([])
  })

  it('deletes all three inside ONE transaction', async () => {
    const { addMember, removeMember } = await import('../team')
    await addMember({ email: 'new@example.test', role: 'member' })
    current.writeLog.length = 0

    await removeMember(memberIdOf(current, NEWCOMER))

    const membershipWrites = current.writeLog.filter((w) =>
      /^(ba_member|user_organizations|team_members)\./.test(w.op)
    )
    expect(membershipWrites.length).toBeGreaterThanOrEqual(3)
    expect(membershipWrites.filter((w) => !w.inTransaction)).toEqual([])
  })

  it('a failed projection delete rolls the canonical delete back', async () => {
    const { addMember, removeMember } = await import('../team')
    await addMember({ email: 'new@example.test', role: 'member' })
    current.tables.team_members.deleteMany = async () => {
      throw new Error('pooler connection dropped')
    }

    const result = await removeMember(memberIdOf(current, NEWCOMER))

    expect(result.success).toBe(false)
    // A half-removed member keeps one table's authority, so the removal must be all or nothing.
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)
    ).toHaveLength(1)
  })
})

/**
 * A single-owner org cannot reach the removal path one request at a time: only an owner may
 * remove an owner, and nobody may remove themselves, so the sole owner has no one who can
 * remove them. The refusal is reachable ONLY under concurrency — two owners removing each
 * other at the same instant — which is why the guard is a FOR UPDATE lock and not a count,
 * and why these tests set the org up with two owners and simulate the other one committing
 * first. Same reasoning as api-nest's membership.spec.ts.
 */
describe('the last owner cannot be removed, and the check is locked', () => {
  it('allows removing an owner while a second owner remains (the guard does not over-fire)', async () => {
    const { removeMember } = await import('../team')
    seedCanonicalOnly(current, SECOND_OWNER, 'owner')
    actingUserId = SECOND_OWNER

    const result = await removeMember(memberIdOf(current, OWNER))

    expect(result).toEqual({ success: true })
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === OWNER)
    ).toEqual([])
  })

  it('refuses, and rolls back, when the locked re-read finds one owner left', async () => {
    const { removeMember } = await import('../team')
    seedCanonicalOnly(current, SECOND_OWNER, 'owner')
    actingUserId = SECOND_OWNER

    // The concurrent commit the FOR UPDATE lock exists for: the OTHER owner-removal committed
    // while this request was blocked on the lock, so the locked re-read inside the transaction
    // sees one owner where a snapshot taken before it saw two. A bare `ba_member.count()`
    // outside any transaction, taking no locks, cannot see that,
    // and both requests proceed, leaving the org with ZERO owners and no way back.
    let lockedReadRan = false
    current.store.$queryRaw = async () => {
      lockedReadRan = true
      return [{ id: 'the-only-owner-left' }]
    }

    const result = await removeMember(memberIdOf(current, OWNER))

    expect(lockedReadRan).toBe(true)
    expect(result).toEqual({
      success: false,
      error: 'Cannot remove the last owner of the organization',
    })
    // Refused, not partially applied: the canonical row and both projections survive.
    expect(
      current.tables.ba_member.rows.filter((r) => r.userId === OWNER)
    ).toHaveLength(1)
  })

  it('the refusal reaches the user as itself, not as "Failed to remove member"', async () => {
    // The guard throws inside the transaction so the write rolls back. If that throw fell into
    // the action's generic catch, the person would be told the operation failed, which reads
    // as a bug rather than the deliberate rule it is.
    const { removeMember } = await import('../team')
    seedCanonicalOnly(current, SECOND_OWNER, 'owner')
    actingUserId = SECOND_OWNER
    current.store.$queryRaw = async () => [{ id: 'the-only-owner-left' }]

    const result = await removeMember(memberIdOf(current, OWNER))

    expect(result.error).not.toBe('Failed to remove member')
  })
})

describe('a role change re-projects onto both mirrors', () => {
  it('updateMemberRole rewrites user_organizations and team_members', async () => {
    const { addMember, updateMemberRole } = await import('../team')
    await addMember({ email: 'new@example.test', role: 'member' })

    const result = await updateMemberRole(memberIdOf(current, NEWCOMER), {
      role: 'admin',
    })

    expect(result.success).toBe(true)
    expect(projectionRows(current, 'user_organizations', NEWCOMER)[0].role).toBe(
      'member'
    )
    // owner/admin both collapse to 'admin' in the mirror's two-value enum.
    expect(projectionRows(current, 'team_members', NEWCOMER)[0].role).toBe(
      'admin'
    )
  })

  it('is a no-op, not a 500, for a member whose projection rows were never created', async () => {
    const { updateMemberRole } = await import('../team')
    seedCanonicalOnly(current, NEWCOMER, 'member')

    const result = await updateMemberRole(memberIdOf(current, NEWCOMER), {
      role: 'admin',
    })

    expect(result.success).toBe(true)
    expect(
      current.tables.ba_member.rows.find((r) => r.userId === NEWCOMER)!.role
    ).toBe('admin')
  })

  it('refuses to demote the last owner (two owners demoting each other concurrently)', async () => {
    const { updateMemberRole } = await import('../team')
    seedCanonicalOnly(current, SECOND_OWNER, 'owner')
    actingUserId = SECOND_OWNER

    // The other owner's demotion committed while this one waited on the lock.
    current.store.$queryRaw = async () => [{ id: 'the-only-owner-left' }]

    const result = await updateMemberRole(memberIdOf(current, OWNER), {
      role: 'member',
    })

    expect(result).toEqual({
      success: false,
      error: 'Cannot demote the last owner of the organization',
    })
    expect(
      current.tables.ba_member.rows.find((r) => r.userId === OWNER)!.role
    ).toBe('owner')
  })
})
