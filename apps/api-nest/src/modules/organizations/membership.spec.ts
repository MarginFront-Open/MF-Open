/**
 * The membership tables, proved in step end to end.
 *
 * WHAT THESE TESTS ARE FOR. `ba_member` and `user_organizations` both answer "who belongs to
 * which org". If TeamService wrote only `ba_member` while OrganizationsService authorized off
 * `user_organizations`, the two APIs would disagree about who a member is, in both directions at
 * once: owners locked out of their own org settings, removed people still holding write access to
 * theirs.
 *
 * A per-method unit test with a `jest.fn()` per table cannot catch that class of bug: each side
 * passes its own mock happily while pointing at a different table. The disagreement only shows up
 * when BOTH services run against ONE store. So this file stands up a small in-memory Postgres
 * stand-in, drives the REAL TeamService and the REAL OrganizationsService against the same
 * tables, and asks the question that failure is actually made of:
 *
 *     Can a member ADDED through the team API administer their org?
 *     Can a member REMOVED through the team API still administer it?
 *
 * The store deliberately reproduces three real Prisma behaviors, because a store that papered
 * over them would prove nothing:
 *   - `where` fields whose value is `undefined` are DROPPED, not compared. That is the trap
 *     documented in org-role.guard.ts — a lookup with
 *     `userId: undefined` degenerates to "the first member of the target org". A service that
 *     fails closed has to do it BEFORE the query, and this store will hand back a stranger's row
 *     if it does not.
 *   - `createMany({ skipDuplicates: true })` skips on the unique pair instead of throwing.
 *   - A throwing `$transaction` callback ROLLS BACK. Without that, a removal that clears two of
 *     three tables and then dies would look like a pass.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { TeamService } from '../team/team.service';
import { hashApiKeyForLookup } from '@marginfront/db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEWCOMER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Row = Record<string, any>;

/**
 * Mirrors Prisma: a `where` field whose value is `undefined` is DROPPED from the query rather
 * than compared. Keeping this faithful is the point of the fail-closed cases below.
 *
 * `{ not: value }` is supported because the shared role sync depends on it —
 * `role: { not: 'superadmin' }` is what stops a projection row nothing in this codebase can
 * produce from being silently demoted. A double that read that filter as a literal object would
 * match nothing, report zero rows moved, and pass a test of the wrong behaviour.
 */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    if (value !== null && typeof value === 'object' && 'not' in value) {
      return row[field] !== (value as { not: unknown }).not;
    }
    return row[field] === value;
  });
}

/**
 * One table. Methods are arrow properties so the object can be handed straight to a service as a
 * Prisma model delegate without losing `this`.
 */
class Table {
  rows: Row[] = [];

  constructor(
    private readonly name: string,
    private readonly uniqueBy: string[],
    private readonly log: (op: string) => void,
  ) {}

  private key = (row: Row) => this.uniqueBy.map((f) => row[f]).join('::');

  findFirst = async ({ where }: any = {}) => this.rows.find((r) => matches(r, where)) ?? null;

  findUnique = async ({ where }: any = {}) => this.rows.find((r) => matches(r, where)) ?? null;

  findMany = async ({ where }: any = {}) =>
    this.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));

  count = async ({ where }: any = {}) => this.rows.filter((r) => matches(r, where)).length;

  create = async ({ data }: any) => {
    this.log(`${this.name}.create`);
    const row = { ...data };
    this.rows.push(row);
    return { ...row };
  };

  createMany = async ({ data, skipDuplicates }: any) => {
    this.log(`${this.name}.createMany`);
    let count = 0;
    for (const item of data) {
      if (this.rows.some((r) => this.key(r) === this.key(item))) {
        if (!skipDuplicates) throw new Error(`unique constraint violated on ${this.name}`);
        continue;
      }
      this.rows.push({ ...item });
      count++;
    }
    return { count };
  };

  update = async ({ where, data }: any) => {
    this.log(`${this.name}.update`);
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error(`${this.name}.update matched no row`);
    Object.assign(row, data);
    return { ...row };
  };

  updateMany = async ({ where, data }: any) => {
    this.log(`${this.name}.updateMany`);
    const hits = this.rows.filter((r) => matches(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  };

  delete = async ({ where }: any) => {
    this.log(`${this.name}.delete`);
    const index = this.rows.findIndex((r) => matches(r, where));
    if (index === -1) throw new Error(`${this.name}.delete matched no row`);
    return this.rows.splice(index, 1)[0];
  };

  deleteMany = async ({ where }: any = {}) => {
    this.log(`${this.name}.deleteMany`);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  };
}

interface WriteEntry {
  op: string;
  inTransaction: boolean;
}

function makeStore() {
  const writeLog: WriteEntry[] = [];
  let transactionDepth = 0;
  const log = (op: string) => writeLog.push({ op, inTransaction: transactionDepth > 0 });

  const tables = {
    ba_member: new Table('ba_member', ['organizationId', 'userId'], log),
    user_organizations: new Table('user_organizations', ['userId', 'organizationId'], log),
    team_members: new Table('team_members', ['user_id', 'organization_id'], log),
    users: new Table('users', ['id'], log),
    organizations: new Table('organizations', ['id'], log),
    ba_session: new Table('ba_session', ['id'], log),
    api_keys: new Table('api_keys', ['id'], log),
    team_invitations: new Table('team_invitations', ['id'], log),
  };

  const withOrg = (row: Row) => ({
    ...row,
    organizations: tables.organizations.rows.find((o) => o.id === row.organizationId) ?? null,
  });
  const withUser = (row: Row) => ({
    ...row,
    users: tables.users.rows.find((u) => u.id === row.userId) ?? null,
  });

  // `include` support only where the services actually ask for it.
  const ba_member = {
    ...tables.ba_member,
    findFirst: async ({ where, include }: any = {}) => {
      const row = await tables.ba_member.findFirst({ where });
      if (!row) return null;
      return include?.users ? withUser(row) : row;
    },
    findMany: async ({ where, include }: any = {}) => {
      const rows = await tables.ba_member.findMany({ where });
      if (include?.organizations) return rows.map(withOrg);
      if (include?.users) return rows.map(withUser);
      return rows;
    },
    create: async ({ data, include }: any) => {
      const row = await tables.ba_member.create({ data });
      return include?.users ? withUser(row) : row;
    },
    update: async ({ where, data, include }: any) => {
      const row = await tables.ba_member.update({ where, data });
      return include?.users ? withUser(row) : row;
    },
  };

  const store: any = { ...tables, ba_member };

  // The FOR UPDATE owner lock. An in-memory store cannot prove serialization — that is the
  // database's job — but it returns the owner set the locked recount reads.
  store.$queryRaw = async (_strings: TemplateStringsArray, organizationId: string) =>
    tables.ba_member.rows
      .filter((r) => r.organizationId === organizationId && r.role === 'owner')
      .map((r) => ({ id: r.id }));

  // The callback gets a client with NO $transaction on it, which is what Prisma actually hands
  // over: its interactive-transaction deny list is ["$connect","$disconnect","$on","$transaction",
  // "$extends"]. That absence is load-bearing — the shared membership helpers read it to
  // decide whether they are already inside a transaction or have to open one (packages/db/src/lib/
  // membership.ts, runPaired). A double that left $transaction on the tx would send every helper
  // down a nesting path the real client cannot reach, and prove nothing about the real one.
  store.$transaction = async (cb: any) => {
    transactionDepth++;
    const snapshot = Object.values(tables).map(
      (t) => [t, t.rows.map((r) => ({ ...r }))] as [Table, Row[]],
    );
    // Rebuilt per call, not once at construction, so a test that swaps $queryRaw or a delegate on
    // the store AFTER makeStore() still has its override seen inside the transaction.
    const { $transaction: _denied, ...txClient } = store;
    try {
      return await cb(txClient);
    } catch (e) {
      snapshot.forEach(([table, rows]) => {
        table.rows = rows;
      });
      throw e;
    } finally {
      transactionDepth--;
    }
  };

  return { store, tables, writeLog };
}

type Store = ReturnType<typeof makeStore>;

function seedWorld({ tables }: Store, { onboardingComplete = true } = {}) {
  tables.organizations.rows.push(
    { id: ORG, name: 'Acme', onboarding_complete: onboardingComplete },
    { id: OTHER_ORG, name: 'Other', onboarding_complete: true },
  );
  tables.users.rows.push(
    { id: OWNER, email: 'owner@example.com', name: 'Owner' },
    { id: SECOND_OWNER, email: 'second@example.com', name: 'Second Owner' },
    { id: NEWCOMER, email: 'new@example.com', name: 'Newcomer' },
  );
}

/** A canonical membership row with NO projection — exactly what Better Auth leaves behind. */
function seedCanonicalOnly(
  { tables }: Store,
  userId: string,
  role: string,
  organizationId = ORG,
): void {
  tables.ba_member.rows.push({
    id: `member-${userId.slice(0, 8)}-${organizationId.slice(0, 8)}`,
    organizationId,
    userId,
    role,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

/** A stale projection row with NO canonical membership — a "ghost" removed member. */
function seedProjectionOnly(
  { tables }: Store,
  userId: string,
  role: string,
  organizationId = ORG,
): void {
  tables.user_organizations.rows.push({
    id: `uo-${userId.slice(0, 8)}`,
    userId,
    organizationId,
    role,
    isDefault: true,
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function makeServices(store: Store) {
  return {
    orgs: new OrganizationsService(store.store),
    team: new TeamService(store.store, {} as any, {} as any),
  };
}

const membershipOf = (store: Store, table: 'user_organizations' | 'team_members', userId: string) =>
  store.tables[table].rows.filter((r) => (r.userId ?? r.user_id) === userId);

// ═══════════════════════════════════════════════════════════════════════════
// Both APIs agree on who is a member
// ═══════════════════════════════════════════════════════════════════════════

describe('the team API and the org API agree on who is a member', () => {
  it('a member ADDED through the team API can administer their org', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs, team } = makeServices(store);

    await team.addMember(ORG, NEWCOMER, 'owner', OWNER);

    await expect(
      orgs.updateOrganization(NEWCOMER, ORG, { name: 'Renamed' } as any),
    ).resolves.toEqual(expect.objectContaining({ message: 'Organization updated successfully' }));

    // Now take the projection row away. That is the state Better Auth leaves behind — it owns
    // ba_member and writes nothing else. Authorization must not notice: if it read the
    // projection, a member who has only a ba_member row would be locked out.
    store.tables.user_organizations.rows = [];
    await expect(
      orgs.updateOrganization(NEWCOMER, ORG, { name: 'Renamed again' } as any),
    ).resolves.toBeDefined();
  });

  it('adding a member writes BOTH projection rows, so the org shows up in their own org list', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs, team } = makeServices(store);

    await team.addMember(ORG, NEWCOMER, 'member', OWNER);

    expect(membershipOf(store, 'user_organizations', NEWCOMER)).toHaveLength(1);
    expect(membershipOf(store, 'team_members', NEWCOMER)).toHaveLength(1);

    const listed = (await orgs.getCurrentOrganization(NEWCOMER)) as any;
    expect(listed.hasOrg).toBe(true);
    expect(listed.orgs.map((o: any) => o.id)).toEqual([ORG]);
  });

  it('a member REMOVED through the team API can no longer administer their org', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs, team } = makeServices(store);

    await team.addMember(ORG, NEWCOMER, 'owner', OWNER);
    const added = store.tables.ba_member.rows.find((r) => r.userId === NEWCOMER)!;
    await team.removeMember(ORG, added.id, OWNER);

    await expect(
      orgs.updateOrganization(NEWCOMER, ORG, { name: 'Renamed by a ghost' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removal clears EVERY membership table, inside ONE transaction', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);

    await team.addMember(ORG, NEWCOMER, 'owner', OWNER);
    const added = store.tables.ba_member.rows.find((r) => r.userId === NEWCOMER)!;
    store.writeLog.length = 0;

    await team.removeMember(ORG, added.id, OWNER);

    expect(store.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)).toHaveLength(0);
    expect(membershipOf(store, 'user_organizations', NEWCOMER)).toHaveLength(0);
    expect(membershipOf(store, 'team_members', NEWCOMER)).toHaveLength(0);

    // All three deletes inside the transaction. The session kill is deliberately outside it
    // (different table, best-effort cleanup) — assert that too so the split stays intentional.
    const inTx = store.writeLog.filter((w) => w.inTransaction).map((w) => w.op);
    expect(inTx).toEqual([
      'ba_member.delete',
      'user_organizations.deleteMany',
      'team_members.deleteMany',
    ]);
    expect(store.writeLog.find((w) => w.op === 'ba_session.deleteMany')?.inTransaction).toBe(false);
  });

  it('a removal that trips the last-owner guard ROLLS BACK all three tables', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);
    await team.addMember(ORG, SECOND_OWNER, 'owner', OWNER);
    const secondRow = store.tables.ba_member.rows.find((r) => r.userId === SECOND_OWNER)!;

    // Simulate the concurrent commit the FOR UPDATE lock exists for: a second owner-removal
    // committed between this request's read and this transaction taking the lock, so the locked
    // recount sees ONE owner. This branch is unreachable any other way — with two distinct owner
    // rows on the table, a plain count can never be 1 — so the lock result is what we vary.
    store.store.$queryRaw = async () => [{ id: 'the-only-owner-left' }];

    await expect(team.removeMember(ORG, secondRow.id, OWNER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // A partial removal leaves orphan rows. Nothing moved.
    expect(store.tables.ba_member.rows.filter((r) => r.userId === SECOND_OWNER)).toHaveLength(1);
    expect(membershipOf(store, 'user_organizations', SECOND_OWNER)).toHaveLength(1);
    expect(membershipOf(store, 'team_members', SECOND_OWNER)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two paths that CREATE members, and the crash window between their writes
//
// Writing the canonical row and the projections as two separate statements keeps the tables in
// step in the happy case and leaves a gap in the unhappy one: a pod restart, a redeploy SIGTERM,
// or a dropped database connection landing between the commits mints a canonical member with
// no projection row, an orphan. The steady-state tests above cannot see that gap, because both
// writes succeed. These pin the atomicity itself.
// ═══════════════════════════════════════════════════════════════════════════

describe('creating a member is atomic, not just eventually consistent', () => {
  const INVITE_TOKEN = 'invite-token-newcomer';

  function seedInvitation(store: Store, { role = 'member' } = {}) {
    store.tables.team_invitations.rows.push({
      id: 'invitation-1',
      organization_id: ORG,
      email: 'new@example.com',
      token: hashApiKeyForLookup(INVITE_TOKEN),
      role,
      status: 'pending',
      invited_by: OWNER,
      expires_at: new Date('2099-01-01T00:00:00Z'),
    });
  }

  it('addMember writes the canonical row and BOTH projections inside ONE transaction', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);
    store.writeLog.length = 0;

    await team.addMember(ORG, NEWCOMER, 'member', OWNER);

    // The two updateManys are not redundant, they are the STALE-ROW repair: createMany +
    // skipDuplicates is create-only, so adding someone who still has a leftover projection row
    // from an earlier membership would otherwise leave the old role sitting on it while
    // ba_member carried the new one. Proved directly in the next case.
    expect(store.writeLog.filter((w) => w.inTransaction).map((w) => w.op)).toEqual([
      'ba_member.create',
      'user_organizations.createMany',
      'team_members.createMany',
      'user_organizations.updateMany',
      'team_members.updateMany',
    ]);
    expect(store.writeLog.every((w) => w.inTransaction)).toBe(true);
  });

  it('adding a member on top of a STALE projection row corrects its role, not just its existence', async () => {
    // A user_organizations row with no ba_member pair. Add that person back as an OWNER and a
    // create-only write path would skip the row on the unique constraint and leave it saying
    // 'member', a role MISMATCH on exactly the rows the write should clean up.
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    store.tables.user_organizations.rows.push({
      id: 'ghost-uo',
      userId: NEWCOMER,
      organizationId: ORG,
      role: 'member',
      isDefault: false,
    });
    store.tables.team_members.rows.push({
      id: 'ghost-tm',
      user_id: NEWCOMER,
      organization_id: ORG,
      role: 'member',
      // The other half of the same shape: a stale row left INACTIVE, which matches the unique
      // pair and so is skipped, leaving an active canonical member the mirror says has left.
      status: 'inactive',
    });
    const { team } = makeServices(store);

    await team.addMember(ORG, NEWCOMER, 'owner', OWNER);

    expect(membershipOf(store, 'user_organizations', NEWCOMER)[0].role).toBe('owner');
    expect(membershipOf(store, 'team_members', NEWCOMER)[0]).toMatchObject({
      role: 'admin',
      status: 'active',
    });
  });

  it('a projection write that dies mid-add ROLLS BACK the canonical row', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);

    // The connection drops after ba_member commits and before the projections do. Outside a
    // transaction this is the orphan factory; inside one it is a no-op the caller sees as a 500.
    store.tables.user_organizations.createMany = async () => {
      throw new Error('connection terminated');
    };

    await expect(team.addMember(ORG, NEWCOMER, 'member', OWNER)).rejects.toThrow(
      'connection terminated',
    );

    expect(store.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)).toHaveLength(0);
    expect(membershipOf(store, 'team_members', NEWCOMER)).toHaveLength(0);
  });

  it('acceptInvitation writes the member, both projections and the status in ONE transaction', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedInvitation(store);
    const { team } = makeServices(store);
    store.writeLog.length = 0;

    await team.acceptInvitation(INVITE_TOKEN, NEWCOMER);

    expect(store.writeLog.filter((w) => w.inTransaction).map((w) => w.op)).toEqual([
      'ba_member.create',
      'user_organizations.createMany',
      'team_members.createMany',
      'user_organizations.updateMany',
      'team_members.updateMany',
      'team_invitations.update',
    ]);
    expect(store.writeLog.every((w) => w.inTransaction)).toBe(true);
  });

  it('an invite acceptance that dies mid-write leaves NO member and the invite still pending', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedInvitation(store);
    const { team } = makeServices(store);

    store.tables.team_members.createMany = async () => {
      throw new Error('connection terminated');
    };

    await expect(team.acceptInvitation(INVITE_TOKEN, NEWCOMER)).rejects.toThrow(
      'connection terminated',
    );

    expect(store.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)).toHaveLength(0);
    expect(membershipOf(store, 'user_organizations', NEWCOMER)).toHaveLength(0);
    // Still pending, so the invitee can retry. Marking it accepted outside the transaction would
    // burn the only token they have while leaving them a non-member.
    expect(store.tables.team_invitations.rows[0].status).toBe('pending');
  });

  it('re-accepting an old invite projects the CANONICAL role, not the invitation role', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    // Invited as a member, accepted, then promoted to owner through a path that wrote ba_member
    // alone — Better Auth, or any promotion. Now they re-click the original link
    // before it expires. Projecting invitation.role would write 'member' against a canonical
    // 'owner' and manufacture the role disagreement membership.ts promises cannot happen.
    seedCanonicalOnly(store, NEWCOMER, 'owner');
    seedInvitation(store, { role: 'member' });
    const { team } = makeServices(store);

    await team.acceptInvitation(INVITE_TOKEN, NEWCOMER);

    expect(membershipOf(store, 'user_organizations', NEWCOMER)[0].role).toBe('owner');
    expect(membershipOf(store, 'team_members', NEWCOMER)[0].role).toBe('admin');
    expect(store.tables.ba_member.rows.filter((r) => r.userId === NEWCOMER)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two orphan shapes, one test each
// ═══════════════════════════════════════════════════════════════════════════

describe('rows where the membership tables disagree', () => {
  it('a canonical owner with NO user_organizations row can administer their org', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs } = makeServices(store);

    expect(store.tables.user_organizations.rows).toHaveLength(0);

    await expect(
      orgs.updateOrganization(OWNER, ORG, { name: 'Renamed' } as any),
    ).resolves.toBeDefined();
    const listed = (await orgs.getCurrentOrganization(OWNER)) as any;
    expect(listed.hasOrg).toBe(true);
    expect(listed.organization.role).toBe('owner');
  });

  it('a user_organizations owner with NO ba_member row is denied everywhere', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedProjectionOnly(store, NEWCOMER, 'owner');
    const { orgs } = makeServices(store);

    await expect(
      orgs.updateOrganization(NEWCOMER, ORG, { name: 'Renamed' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(orgs.switchOrganization(NEWCOMER, ORG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(orgs.deleteOrganization(NEWCOMER, ORG)).rejects.toBeInstanceOf(ForbiddenException);

    const listed = (await orgs.getCurrentOrganization(NEWCOMER)) as any;
    expect(listed.hasOrg).toBe(false);
  });

  it('switching into an org repairs a canonical member who has no projection row', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs } = makeServices(store);

    await expect(orgs.switchOrganization(OWNER, ORG)).resolves.toBeDefined();

    const [projection] = membershipOf(store, 'user_organizations', OWNER);
    expect(projection).toMatchObject({ organizationId: ORG, role: 'owner', isDefault: true });
    expect(membershipOf(store, 'team_members', OWNER)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The role is read, not mere presence — and the undefined-userId trap stays shut
// ═══════════════════════════════════════════════════════════════════════════

describe('authorization reads the canonical ROLE', () => {
  it('an admin cannot update the organization (owner-only, unchanged)', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedCanonicalOnly(store, NEWCOMER, 'admin');
    const { orgs } = makeServices(store);

    await expect(
      orgs.updateOrganization(NEWCOMER, ORG, { name: 'Renamed' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin CAN switch into the org (membership, not owner, is the bar)', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, NEWCOMER, 'admin');
    const { orgs } = makeServices(store);

    await expect(orgs.switchOrganization(NEWCOMER, ORG)).resolves.toBeDefined();
  });

  it('never queries ba_member with userId: undefined — the Prisma where-drop trap', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { orgs } = makeServices(store);
    const spy = jest.spyOn(store.store.ba_member, 'findFirst');

    // If any of these reached Prisma with `userId: undefined`, the store (faithfully) drops the
    // field and hands back OWNER's row — an unidentifiable caller inheriting an owner's authority.
    await expect(orgs.updateOrganization(undefined as any, ORG, {} as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(orgs.switchOrganization(undefined as any, ORG)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(orgs.deleteOrganization(undefined as any, ORG)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Creating and leaving an org
// ═══════════════════════════════════════════════════════════════════════════

describe('org creation and leaving', () => {
  it('creating an org gives the creator a CANONICAL owner row, not just a projection', async () => {
    const store = makeStore();
    seedWorld(store);
    const { orgs, team } = makeServices(store);

    const created = (await orgs.createOrganization(OWNER, { name: 'Fresh Co' } as any)) as any;
    const orgId = created.organization.id;

    expect(store.tables.ba_member.rows.filter((r) => r.organizationId === orgId)).toMatchObject([
      { userId: OWNER, role: 'owner' },
    ]);
    expect(
      store.tables.user_organizations.rows.filter((r) => r.organizationId === orgId),
    ).toHaveLength(1);

    // The creator is a real member as far as the team API is concerned, so the org's own creator
    // can add people to it.
    await expect(team.addMember(orgId, NEWCOMER, 'member', OWNER)).resolves.toBeDefined();
  });

  it('leaving an org removes all three membership rows in one transaction', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedCanonicalOnly(store, SECOND_OWNER, 'owner');
    seedProjectionOnly(store, OWNER, 'owner');
    const { orgs } = makeServices(store);
    store.writeLog.length = 0;

    await expect(orgs.deleteOrganization(OWNER, ORG)).resolves.toBeDefined();

    expect(store.tables.ba_member.rows.filter((r) => r.userId === OWNER)).toHaveLength(0);
    expect(membershipOf(store, 'user_organizations', OWNER)).toHaveLength(0);

    const inTx = store.writeLog.filter((w) => w.inTransaction).map((w) => w.op);
    expect(inTx).toEqual([
      'ba_member.delete',
      'user_organizations.deleteMany',
      'team_members.deleteMany',
    ]);
  });

  it('the LAST owner cannot leave, and nothing is written when they try', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    seedProjectionOnly(store, OWNER, 'owner');
    const { orgs } = makeServices(store);

    await expect(orgs.deleteOrganization(OWNER, ORG)).rejects.toBeInstanceOf(ForbiddenException);

    expect(store.tables.ba_member.rows.filter((r) => r.userId === OWNER)).toHaveLength(1);
    expect(membershipOf(store, 'user_organizations', OWNER)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Role changes stay in step
// ═══════════════════════════════════════════════════════════════════════════

describe('a role change re-projects onto both mirrors', () => {
  it('promoting a member to owner updates all three tables inside one transaction', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);
    await team.addMember(ORG, NEWCOMER, 'member', OWNER);
    const row = store.tables.ba_member.rows.find((r) => r.userId === NEWCOMER)!;
    store.writeLog.length = 0;

    await team.updateMemberRole(ORG, row.id, { role: 'owner' } as any, OWNER);

    expect(row.role).toBe('owner');
    expect(membershipOf(store, 'user_organizations', NEWCOMER)[0].role).toBe('owner');
    expect(membershipOf(store, 'team_members', NEWCOMER)[0].role).toBe('admin');
    expect(store.writeLog.every((w) => w.inTransaction)).toBe(true);
  });

  it('demoting an owner to finance projects DOWN, because neither mirror enum can hold it', async () => {
    const store = makeStore();
    seedWorld(store);
    seedCanonicalOnly(store, OWNER, 'owner');
    const { team } = makeServices(store);
    await team.addMember(ORG, NEWCOMER, 'owner', OWNER);
    const row = store.tables.ba_member.rows.find((r) => r.userId === NEWCOMER)!;
    expect(membershipOf(store, 'user_organizations', NEWCOMER)[0].role).toBe('owner');
    expect(membershipOf(store, 'team_members', NEWCOMER)[0].role).toBe('admin');

    await team.updateMemberRole(ORG, row.id, { role: 'finance' } as any, OWNER);

    // The canonical row carries the real role; the mirrors flatten it. That flattening is only
    // safe because nothing authorizes off either mirror — see membership.ts.
    expect(row.role).toBe('finance');
    expect(membershipOf(store, 'user_organizations', NEWCOMER)[0].role).toBe('member');
    expect(membershipOf(store, 'team_members', NEWCOMER)[0].role).toBe('member');
  });
});
