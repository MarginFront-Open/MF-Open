/**
 * Tests for TeamService (team-endpoint authorization).
 *
 * These drive the REAL TeamService decision logic with a hand-stubbed PrismaService (every
 * table call is a jest.fn). No live DB. The point is to prove the relational rules a static
 * guard can't express actually fire:
 *   - self-promotion is blocked
 *   - the grant matrix caps add / invite / re-role
 *   - re-role and remove respect owner-only and admin-can't-touch-admin
 *   - the last owner can never be demoted or removed
 *   - removing a member kills their org sessions (proven wired, not faked)
 *
 * Mutation sensitivity: several cases flip ONLY the stubbed actor role or target role and
 * watch the verdict flip — proving the gate reads ROLE, not mere presence.
 */

import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { hashApiKeyForLookup } from '@marginfront/db';
import { TeamService } from './team.service';

const ORG = 'org-1111';
const ACTOR = 'actor-user-id';
const TARGET_ID = 'target-member-row-id';
const TARGET_USER = 'target-user-id';

type Row = { id?: string; userId: string; role: string };

interface PrismaOpts {
  /** actor's ba_member row, keyed by their userId (null => actor isn't a member). */
  actor?: Row | null;
  /** the target ba_member row, looked up by id. */
  target?: Row | null;
  /** owner count returned by ba_member.count (for last-owner checks). */
  ownerCount?: number;
  /** users.findUnique result (for addMember / sendInvitation existence checks). */
  userRow?: { id: string; email: string } | null;
  /** an already-existing membership for a looked-up userId (addMember dup check). */
  existingMemberByUserId?: Record<string, Row | null>;
  /** existing pending invitation (sendInvitation dup check). */
  existingInvitation?: any;
}

function makePrisma(opts: PrismaOpts) {
  const {
    actor = null,
    target = null,
    ownerCount = 2,
    userRow = null,
    existingMemberByUserId = {},
    existingInvitation = null,
  } = opts;

  const ba_member = {
    // Routes by the shape of `where`: an `id` lookup is the target row; a `userId` lookup
    // is either the actor (ACTOR) or a dup-membership check for some other user.
    findFirst: jest.fn(async ({ where }: any) => {
      if (where.id) {
        return target && target.id === where.id ? target : null;
      }
      if (where.userId === ACTOR) return actor;
      if (where.userId in existingMemberByUserId) return existingMemberByUserId[where.userId];
      return null;
    }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(ownerCount),
    create: jest.fn(async ({ data }: any) => ({ ...data, users: null })),
    update: jest.fn(async ({ data }: any) => ({ id: TARGET_ID, ...data, users: null })),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const ba_session = { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) };

  // Projection membership store (team_members), a mirror of ba_member. TWO directions matter:
  //  - removeMember must DELETE the removed user's row here too, so the mirror never lists
  //    someone who is gone.
  //  - addMember / acceptInvitation must CREATE a row here too (dual-write), so a SECONDARY
  //    member (primary org != this org) appears in the mirror like every other member.
  const team_members = {
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };

  // The THIRD membership table. OrganizationsService authorizes org-settings writes off it, so
  // every add and every remove must keep all three tables in step. Both projections are written
  // through the one helper in packages/db/src/lib/membership.ts, which is why every team_members
  // assertion below has a user_organizations twin.
  const user_organizations = {
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };

  const users = { findUnique: jest.fn().mockResolvedValue(userRow) };

  const team_invitations = {
    findFirst: jest.fn().mockResolvedValue(existingInvitation),
    create: jest.fn(async ({ data }: any) => ({ ...data })),
  };

  const prisma: any = {
    ba_member,
    ba_session,
    team_members,
    user_organizations,
    users,
    team_invitations,
  };

  // The last-owner guard runs as `prisma.$transaction(cb)` with a
  // `tx.$queryRaw\`... FOR UPDATE\`` owner-lock inside it.
  //
  // $queryRaw stub: returns ONE row per current owner so `.length` equals the ownerCount the
  // test asked for — that's what the locked recount reads. (ownerCount = 1 -> last owner.)
  prisma.$queryRaw = jest.fn(async () =>
    Array.from({ length: ownerCount }, (_, i) => ({ id: `owner-row-${i}` })),
  );

  // $transaction stub: runs the callback against the same delegates so the existing assertions on
  // ba_member.delete / ba_member.update / team_members.deleteMany still observe the calls, but
  // with $transaction ITSELF stripped off. That is what Prisma actually hands over — its
  // interactive-transaction deny list is ["$connect","$disconnect","$on","$transaction",
  // "$extends"] — and the absence is load-bearing: the shared membership helpers read it to
  // tell "already inside a transaction" from "open one" (packages/db/src/lib/membership.ts,
  // runPaired). A stub that left $transaction on the tx would send them down a nesting path the
  // real client cannot reach, and this file's "opened exactly once" assertions would count it.
  //
  // A real DB would serialize concurrent callbacks on the FOR UPDATE lock; a unit mock can't
  // prove serialization — that's the DB-gated integration test's job. What this stub DOES let us
  // prove is co-location: the lock + recount + write all run inside this callback.
  prisma.$transaction = jest.fn(async (cb: any) => {
    const { $transaction: _denied, ...tx } = prisma;
    return cb(tx);
  });

  return {
    prisma,
    ba_member,
    ba_session,
    team_members,
    user_organizations,
    users,
    team_invitations,
  };
}

function makeService(prisma: any): TeamService {
  // EmailService + ConfigService are never touched by the paths under test.
  return new TeamService(prisma, {} as any, {} as any);
}

describe('TeamService.updateMemberRole', () => {
  it('BLOCKS self-promotion and never writes the role', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: ACTOR, role: 'admin' }, // target IS the actor
    });
    const svc = makeService(prisma);
    await expect(
      svc.updateMemberRole(ORG, TARGET_ID, { role: 'owner' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ba_member.update).not.toHaveBeenCalled();
  });

  it('rejects an admin changing another admin (admin-cant-touch-admin)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'admin' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'member' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ba_member.update).not.toHaveBeenCalled();
  });

  it('rejects an admin demoting an owner (owner-only)', async () => {
    const { prisma } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'member' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an admin promoting someone TO owner (only owner grants owner)', async () => {
    const { prisma } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'owner' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an owner to promote a member to admin', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).resolves.toBeDefined();
    expect(ba_member.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TARGET_ID }, data: { role: 'admin' } }),
    );
  });

  it('blocks demoting the LAST owner (count = 1)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 1,
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ba_member.update).not.toHaveBeenCalled();
  });

  it('allows demoting an owner when another owner remains (count = 2)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).resolves.toBeDefined();
    expect(ba_member.update).toHaveBeenCalled();
  });

  it('rejects a caller who is not an owner/admin (e.g. an API key with no member row)', async () => {
    const { prisma } = makePrisma({
      actor: null, // no ba_member row for the actor
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // MUTATION SENSITIVITY: same target, flip ONLY the actor role -> verdict flips.
  it('flips on actor role: owner demotes owner (count 2) passes, admin fails', async () => {
    const ownerActor = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    await expect(
      makeService(ownerActor.prisma).updateMemberRole(
        ORG,
        TARGET_ID,
        { role: 'admin' } as any,
        ACTOR,
      ),
    ).resolves.toBeDefined();

    const adminActor = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    await expect(
      makeService(adminActor.prisma).updateMemberRole(
        ORG,
        TARGET_ID,
        { role: 'admin' } as any,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TeamService.removeMember', () => {
  it('rejects removing yourself', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: ACTOR, role: 'admin' },
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ba_member.delete).not.toHaveBeenCalled();
  });

  it('rejects an admin removing another admin', async () => {
    const { prisma } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'admin' },
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects an admin removing an owner', async () => {
    const { prisma } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('blocks removing the LAST owner (count = 1)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 1,
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ba_member.delete).not.toHaveBeenCalled();
  });

  it('allows an admin to remove a member AND fully revokes (all three membership tables + sessions)', async () => {
    const { prisma, ba_member, ba_session, team_members, user_organizations } = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).resolves.toBeUndefined();
    expect(ba_member.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
    // The user_organizations row must go too. Without this, the removed person keeps
    // owner-level write access to the org's settings.
    expect(user_organizations.deleteMany).toHaveBeenCalledTimes(1);
    expect(user_organizations.deleteMany).toHaveBeenCalledWith({
      where: { userId: TARGET_USER, organizationId: ORG },
    });
    // The team_members mirror row is deleted too, so it stays in step with ba_member.
    expect(team_members.deleteMany).toHaveBeenCalledTimes(1);
    expect(team_members.deleteMany).toHaveBeenCalledWith({
      where: { user_id: TARGET_USER, organization_id: ORG },
    });
    // Proves the session kill is wired, not faked.
    expect(ba_session.deleteMany).toHaveBeenCalledTimes(1);
    expect(ba_session.deleteMany).toHaveBeenCalledWith({
      where: { userId: TARGET_USER, activeOrganizationId: ORG },
    });
  });

  it('does NOT touch the team_members row when removal is denied (self-removal)', async () => {
    const { prisma, ba_member, team_members } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: ACTOR, role: 'admin' },
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ba_member.delete).not.toHaveBeenCalled();
    expect(team_members.deleteMany).not.toHaveBeenCalled();
  });

  // MUTATION SENSITIVITY: same actor, flip ONLY the target role -> verdict flips.
  it('flips on target role: admin removes member passes, admin removes admin fails', async () => {
    const removable = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(
      makeService(removable.prisma).removeMember(ORG, TARGET_ID, ACTOR),
    ).resolves.toBeUndefined();

    const blocked = makePrisma({
      actor: { userId: ACTOR, role: 'admin' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'admin' },
    });
    await expect(
      makeService(blocked.prisma).removeMember(ORG, TARGET_ID, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// The last-owner RACE guard. These are STRUCTURE/ordering proofs on a mocked
// PrismaService: they show the FOR UPDATE owner-lock, the recount, and the write are co-located
// inside ONE $transaction callback, and that the guard short-circuits before the write when only
// one owner remains. They do NOT prove serialization — a mock can't. The genuine invariant proof
// ("two parallel removals can never zero the owners") needs a DB-gated integration test
// against a real scratch Postgres, never production.
describe('TeamService last-owner guard — transactional structure', () => {
  it('removeMember on an owner LOCKS owners (FOR UPDATE) then deletes, all inside one $transaction', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).resolves.toBeUndefined();

    // The transaction was opened exactly once, and the owner-lock query ran inside it.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(ba_member.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });

    // ORDERING: the FOR UPDATE lock is acquired BEFORE the delete (lock-then-write, not the
    // reverse). invocationCallOrder is a global monotonic counter across all jest mocks.
    const lockOrder = (prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
    const deleteOrder = (ba_member.delete as jest.Mock).mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(deleteOrder);
  });

  it('removeMember does NOT delete outside the transaction (co-location proof)', async () => {
    const { prisma, ba_member, team_members } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    // Replace $transaction with a stub that NEVER runs the callback. If the delete/mirror-delete
    // were happening outside the transaction, they'd still fire. They must not.
    prisma.$transaction = jest.fn(async () => undefined);
    await makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR);
    expect(ba_member.delete).not.toHaveBeenCalled();
    expect(team_members.deleteMany).not.toHaveBeenCalled();
  });

  it('removeMember blocks the LAST owner via the LOCKED recount (not the unlocked count)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 1, // the locked SELECT returns a single owner row
    });
    await expect(makeService(prisma).removeMember(ORG, TARGET_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The lock ran, but the throw happened before any write.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(ba_member.delete).not.toHaveBeenCalled();
    // The guard does not decide on an unlocked count().
    expect(ba_member.count).not.toHaveBeenCalled();
  });

  it('updateMemberRole owner-demotion LOCKS owners then updates inside one $transaction', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 2,
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).resolves.toBeDefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const lockOrder = (prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
    const updateOrder = (ba_member.update as jest.Mock).mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(updateOrder);
  });

  it('updateMemberRole blocks demoting the LAST owner via the LOCKED recount', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'owner' },
      ownerCount: 1,
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(ba_member.update).not.toHaveBeenCalled();
  });

  it('a NON-owner demotion takes NO owner lock (only owner-demotions need serializing)', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      target: { id: TARGET_ID, userId: TARGET_USER, role: 'member' },
    });
    await expect(
      makeService(prisma).updateMemberRole(ORG, TARGET_ID, { role: 'admin' } as any, ACTOR),
    ).resolves.toBeDefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(ba_member.update).toHaveBeenCalled();
  });
});

describe('TeamService.addMember — grant cap', () => {
  it('rejects finance adding an admin', async () => {
    const { prisma, ba_member } = makePrisma({ actor: { userId: ACTOR, role: 'finance' } });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'admin', ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ba_member.create).not.toHaveBeenCalled();
  });

  it('rejects member adding finance', async () => {
    const { prisma } = makePrisma({ actor: { userId: ACTOR, role: 'member' } });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'finance', ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects admin adding an owner (only owner grants owner)', async () => {
    const { prisma } = makePrisma({ actor: { userId: ACTOR, role: 'admin' } });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'owner', ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a member to add another member', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'member' },
      userRow: { id: 'new-user', email: 'n@x.example' },
    });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'member', ACTOR),
    ).resolves.toBeDefined();
    expect(ba_member.create).toHaveBeenCalled();
  });

  it('allows an owner to add an owner', async () => {
    const { prisma, ba_member } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      userRow: { id: 'new-user', email: 'n@x.example' },
    });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'owner', ACTOR),
    ).resolves.toBeDefined();
    expect(ba_member.create).toHaveBeenCalled();
  });

  // A successful add must write BOTH projection rows.
  //  - team_members: the mirror of ba_member stays in step.
  //  - user_organizations: without it the new member cannot open the org's
  //    settings and the org never appears in their own org list.
  // Both enums are narrower than ba_member's free-form role column, so the role is mapped DOWN
  // (admin -> 'admin' for team_members, -> 'member' for user_organizations, which has no `admin`
  // value at all). Neither mapped value gates access — both consumers only care that the row
  // exists — which is exactly why neither can be the authorization source.
  it('writes BOTH projection rows on a successful add', async () => {
    const { prisma, ba_member, team_members, user_organizations } = makePrisma({
      actor: { userId: ACTOR, role: 'owner' },
      userRow: { id: 'new-user', email: 'n@x.example' },
    });
    await makeService(prisma).addMember(ORG, 'new-user', 'admin', ACTOR);
    expect(ba_member.create).toHaveBeenCalled();

    expect(team_members.createMany).toHaveBeenCalledTimes(1);
    const legacyArg = team_members.createMany.mock.calls[0][0];
    expect(legacyArg.skipDuplicates).toBe(true);
    expect(legacyArg.data[0]).toEqual(
      expect.objectContaining({ user_id: 'new-user', organization_id: ORG, role: 'admin' }),
    );

    expect(user_organizations.createMany).toHaveBeenCalledTimes(1);
    const orgLinkArg = user_organizations.createMany.mock.calls[0][0];
    expect(orgLinkArg.skipDuplicates).toBe(true);
    expect(orgLinkArg.data[0]).toEqual(
      expect.objectContaining({ userId: 'new-user', organizationId: ORG, role: 'member' }),
    );
  });

  it('does NOT write either projection when the add is denied by the grant cap', async () => {
    const { prisma, team_members, user_organizations } = makePrisma({
      actor: { userId: ACTOR, role: 'finance' },
    });
    await expect(
      makeService(prisma).addMember(ORG, 'new-user', 'admin', ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(team_members.createMany).not.toHaveBeenCalled();
    expect(user_organizations.createMany).not.toHaveBeenCalled();
  });
});

describe('TeamService.acceptInvitation — dual-write parity', () => {
  const TOKEN = 'invite-token';
  const INVITEE = 'invitee-user-id';

  function makeAcceptPrisma() {
    const { prisma, ba_member, team_members, user_organizations } = makePrisma({});
    // No existing ba_member for the invitee -> the create branch runs.
    ba_member.findFirst = jest.fn().mockResolvedValue(null);
    ba_member.create = jest.fn(async ({ data }: any) => ({ ...data, users: null }));
    prisma.team_invitations = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv-1',
        organization_id: ORG,
        email: 'invitee@x.example',
        role: 'member',
        invited_by: 'inviter-id',
        status: 'pending',
        expires_at: new Date(Date.now() + 60_000),
      }),
      update: jest.fn().mockResolvedValue({}),
    };
    prisma.users = {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: INVITEE, email: 'invitee@x.example', name: 'Invitee' }),
    };
    prisma.organizations = { findUnique: jest.fn().mockResolvedValue({ id: ORG, name: 'Org' }) };
    return { prisma, ba_member, team_members, user_organizations };
  }

  it('writes BOTH projection rows when a token invite is accepted (same as addMember)', async () => {
    const { prisma, ba_member, team_members, user_organizations } = makeAcceptPrisma();
    await expect(makeService(prisma).acceptInvitation(TOKEN, INVITEE)).resolves.toBeDefined();
    expect(ba_member.create).toHaveBeenCalled();

    expect(team_members.createMany).toHaveBeenCalledTimes(1);
    expect(team_members.createMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ user_id: INVITEE, organization_id: ORG, role: 'member' }),
    );

    expect(user_organizations.createMany).toHaveBeenCalledTimes(1);
    expect(user_organizations.createMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ userId: INVITEE, organizationId: ORG, role: 'member' }),
    );
  });
});

describe('TeamService.sendInvitation — grant cap + persistence guard', () => {
  it('rejects an admin inviting as owner (grant cap)', async () => {
    const { prisma, team_invitations } = makePrisma({ actor: { userId: ACTOR, role: 'admin' } });
    await expect(
      makeService(prisma).sendInvitation(
        ORG,
        { email: 'x@y.example', role: 'owner' } as any,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(team_invitations.create).not.toHaveBeenCalled();
  });

  it('allows finance to invite a member', async () => {
    const { prisma, team_invitations } = makePrisma({ actor: { userId: ACTOR, role: 'finance' } });
    await expect(
      makeService(prisma).sendInvitation(
        ORG,
        { email: 'x@y.example', role: 'member' } as any,
        ACTOR,
      ),
    ).resolves.toBeDefined();
    expect(team_invitations.create).toHaveBeenCalled();
  });

  it('allows an admin to invite a member', async () => {
    const { prisma, team_invitations } = makePrisma({ actor: { userId: ACTOR, role: 'admin' } });
    await expect(
      makeService(prisma).sendInvitation(
        ORG,
        { email: 'x@y.example', role: 'member' } as any,
        ACTOR,
      ),
    ).resolves.toBeDefined();
    expect(team_invitations.create).toHaveBeenCalled();
  });

  // DOCUMENTED DEVIATION: an owner IS authorized by the matrix to invite finance, but the
  // team_invitations DB enum only stores {admin, member}. So this path is blocked at the
  // PERSISTENCE layer with a clear BadRequest (NOT a Forbidden) — proving it's a storage
  // limit, not an authz denial. Finance/owner are granted via Add Member / role change.
  it('blocks owner inviting finance at the persistence layer (BadRequest, not Forbidden)', async () => {
    const { prisma, team_invitations } = makePrisma({ actor: { userId: ACTOR, role: 'owner' } });
    await expect(
      makeService(prisma).sendInvitation(
        ORG,
        { email: 'x@y.example', role: 'finance' } as any,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(team_invitations.create).not.toHaveBeenCalled();
  });

  it('rejects a member inviting an admin (grant cap)', async () => {
    const { prisma } = makePrisma({ actor: { userId: ACTOR, role: 'member' } });
    await expect(
      makeService(prisma).sendInvitation(
        ORG,
        { email: 'x@y.example', role: 'admin' } as any,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TeamService invitation tokens — only the hash is looked up', () => {
  const RAW_TOKEN = 'raw-invite-token';

  function makeInvitationPrisma(storedToken: string) {
    const { prisma } = makePrisma({});
    const invitation = {
      id: 'inv-1',
      organization_id: ORG,
      email: 'invitee@x.example',
      role: 'member',
      token: storedToken,
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000),
    };
    const findFirst = jest.fn(async ({ where }: any) =>
      where.token === invitation.token && where.status === invitation.status ? invitation : null,
    );
    prisma.team_invitations = { findFirst, update: jest.fn() };
    prisma.organizations = { findUnique: jest.fn().mockResolvedValue({ id: ORG, name: 'Org' }) };
    return { prisma, findFirst };
  }

  it('verifies a raw token against its stored hash', async () => {
    const { prisma } = makeInvitationPrisma(hashApiKeyForLookup(RAW_TOKEN));

    await expect(makeService(prisma).verifyInvitationToken(RAW_TOKEN)).resolves.toMatchObject({
      success: true,
    });
  });

  it('rejects the stored hash presented as a token, so database read access is not an invite', async () => {
    const storedHash = hashApiKeyForLookup(RAW_TOKEN);
    const { prisma, findFirst } = makeInvitationPrisma(storedHash);

    await expect(makeService(prisma).verifyInvitationToken(storedHash)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(makeService(prisma).acceptInvitation(storedHash, 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
