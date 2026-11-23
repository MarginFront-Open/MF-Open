/**
 * membership: the properties the projection helpers have to hold, none of which the calling
 * services can be trusted to hold on their own.
 *
 *   npx tsx packages/db/src/lib/membership.test.ts
 *
 * Pure, no DB hit — the helpers take a structural client on purpose (see the interface comment in
 * membership.ts), so an in-memory store exercises the real code path rather than a mock of it.
 *
 * WHY EACH ONE IS LOAD-BEARING:
 *
 *   1. BOTH MIRRORS MOVE TOGETHER. Every helper touches two tables. The four Better Auth hooks and
 *      the onboarding back-fill call them with a TOP-LEVEL client, and Better Auth owns the two
 *      highest-volume membership events in the product, so two independent statements there would
 *      split the mirrors themselves.
 *   2. A STALE ROW IS CORRECTED, NOT SKIPPED. createMany + skipDuplicates is create-only.
 *      Re-adding someone with a stale projection row must not leave the old role on the row while
 *      ba_member carries the new one.
 *   3. `superadmin` IS NEVER OVERWRITTEN. No canonical role projects to it, so every rewrite would
 *      demote a value this code did not set.
 *   4. A COMMA-JOINED ROLE STILL PROJECTS AS AN OWNER. Better Auth stores multi-roles as
 *      "owner,admin"; an exact string compare would read that as a plain member in both mirrors.
 */

import assert from "node:assert/strict";

import {
  deleteMembershipProjections,
  deleteOrganizationMembershipProjections,
  setDefaultOrganization,
  syncMembershipProjectionRole,
  toLegacyTeamMembersRole,
  toUserOrganizationsRole,
  writeMembershipProjections,
} from "./membership";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";

type Row = Record<string, unknown>;

/** Prisma semantics: an undefined field is dropped, and `{ not: v }` is an inequality. */
function whereMatches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    if (value !== null && typeof value === "object" && "not" in value) {
      return row[field] !== (value as { not: unknown }).not;
    }
    return row[field] === value;
  });
}

function makeStore({ failOn = "" } = {}) {
  const userOrganizations: Row[] = [];
  const teamMembers: Row[] = [];
  let transactionsOpened = 0;

  const table = (rows: Row[], name: string, uniqueBy: string[]) => {
    const key = (row: Row) => uniqueBy.map((f) => row[f]).join("::");
    return {
      createMany: async ({ data }: any) => {
        if (failOn === `${name}.createMany`)
          throw new Error(`${name} exploded`);
        let count = 0;
        for (const item of data) {
          if (rows.some((r) => key(r) === key(item))) continue;
          rows.push({ ...item });
          count++;
        }
        return { count };
      },
      updateMany: async ({ where, data }: any) => {
        if (failOn === `${name}.updateMany`)
          throw new Error(`${name} exploded`);
        const hits = rows.filter((r) => whereMatches(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      },
      deleteMany: async ({ where }: any = {}) => {
        if (failOn === `${name}.deleteMany`)
          throw new Error(`${name} exploded`);
        const before = rows.length;
        const kept = rows.filter((r) => !whereMatches(r, where));
        rows.length = 0;
        rows.push(...kept);
        return { count: before - rows.length };
      },
    };
  };

  const client: Record<string, unknown> = {
    user_organizations: table(userOrganizations, "user_organizations", [
      "userId",
      "organizationId",
    ]),
    team_members: table(teamMembers, "team_members", [
      "user_id",
      "organization_id",
    ]),
  };

  // A transaction that rolls back on a throw, and hands over a client with NO $transaction —
  // exactly what Prisma does (its itx deny list is ["$connect","$disconnect","$on",
  // "$transaction","$extends"]). That absence is what the helpers read to tell "already inside a
  // transaction" from "open one".
  client.$transaction = async (run: (tx: unknown) => Promise<unknown>) => {
    transactionsOpened++;
    const snapshot = {
      uo: userOrganizations.map((r) => ({ ...r })),
      tm: teamMembers.map((r) => ({ ...r })),
    };
    const { $transaction: _denied, ...tx } = client;
    try {
      return await run(tx);
    } catch (error) {
      userOrganizations.length = 0;
      userOrganizations.push(...snapshot.uo);
      teamMembers.length = 0;
      teamMembers.push(...snapshot.tm);
      throw error;
    }
  };

  return {
    client: client as any,
    userOrganizations,
    teamMembers,
    openedTransactions: () => transactionsOpened,
  };
}

// ── 1. Role projection, including the comma-joined multi-role shape ────────────────────────────

assert.equal(toUserOrganizationsRole("owner"), "owner");
assert.equal(toUserOrganizationsRole("admin"), "member");
assert.equal(toUserOrganizationsRole("finance"), "member");
// Better Auth's parseRoles joins an array with commas, and its own remove path proves the format
// by calling member.role.split(","). An exact compare would project this owner as a plain member.
assert.equal(toUserOrganizationsRole("owner,admin"), "owner");
assert.equal(toUserOrganizationsRole("admin, owner"), "owner");
assert.equal(toUserOrganizationsRole("developer,finance"), "member");

assert.equal(toLegacyTeamMembersRole("owner"), "admin");
assert.equal(toLegacyTeamMembersRole("admin"), "admin");
assert.equal(toLegacyTeamMembersRole("member"), "member");
assert.equal(toLegacyTeamMembersRole("finance,admin"), "admin");
assert.equal(toLegacyTeamMembersRole("developer,finance"), "member");

async function main(): Promise<void> {
  // ── 2. Both mirrors move together, in one transaction ──────────────────────────────────────────

  {
    const store = makeStore();
    await writeMembershipProjections(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "owner",
    });

    assert.equal(store.userOrganizations.length, 1);
    assert.equal(store.teamMembers.length, 1);
    assert.equal(store.userOrganizations[0].role, "owner");
    assert.equal(store.teamMembers[0].role, "admin");
    assert.equal(store.teamMembers[0].status, "active");
    assert.equal(
      store.openedTransactions(),
      1,
      "a top-level client must get a transaction opened for it",
    );
    // isDefault is never set here: it is one flag per USER, so only setDefaultOrganization may
    // write it, and it clears the others in the same transaction.
    assert.equal(store.userOrganizations[0].isDefault, false);
  }

  {
    // The split this prevents: the first mirror commits, the second dies, and the two mirrors end up
    // disagreeing with each other as well as with ba_member.
    const store = makeStore({ failOn: "team_members.createMany" });
    await assert.rejects(() =>
      writeMembershipProjections(store.client, {
        organizationId: ORG,
        userId: USER,
        role: "owner",
      }),
    );
    assert.equal(
      store.userOrganizations.length,
      0,
      "the first mirror write must roll back when the second fails",
    );
  }

  {
    // Handed a tx (no $transaction on it), the helper must NOT try to open one — Prisma forbids
    // nesting, and the caller's transaction already provides the guarantee.
    const store = makeStore();
    const { $transaction: _omitted, ...tx } = store.client;
    await writeMembershipProjections(tx as any, {
      organizationId: ORG,
      userId: USER,
      role: "member",
    });
    assert.equal(store.openedTransactions(), 0);
    assert.equal(store.userOrganizations.length, 1);
  }

  // ── 3. A stale row is corrected, not skipped ───────────────────────────────────────────────────

  {
    const store = makeStore();
    store.userOrganizations.push({
      userId: USER,
      organizationId: ORG,
      role: "member",
      isDefault: false,
    });
    store.teamMembers.push({
      user_id: USER,
      organization_id: ORG,
      role: "member",
      // The re-add shape: the pair matches, so a plain create skips it and the person
      // is an active canonical member whose team_members row still says they left.
      status: "inactive",
    });

    await writeMembershipProjections(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "owner",
    });

    assert.equal(store.userOrganizations.length, 1);
    assert.equal(store.userOrganizations[0].role, "owner");
    assert.equal(store.teamMembers[0].role, "admin");
    assert.equal(store.teamMembers[0].status, "active");
  }

  // ── 4. superadmin is never overwritten ─────────────────────────────────────────────────────────

  {
    const store = makeStore();
    store.userOrganizations.push({
      userId: USER,
      organizationId: ORG,
      role: "superadmin",
      isDefault: false,
    });

    await syncMembershipProjectionRole(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "member",
    });

    assert.equal(
      store.userOrganizations[0].role,
      "superadmin",
      "no canonical role maps to superadmin, so a rewrite could only be a demotion",
    );
    assert.equal(
      store.userOrganizations.length,
      1,
      "and the skipped update must not be answered with a duplicate row",
    );
  }

  // ── 5. The role sync heals a mirror row that was never written ─────────────────────────────────

  {
    // Re-roling a member with no mirror row must create it. Every caller has already written
    // ba_member, so a missing mirror row is drift by definition.
    const store = makeStore();
    await syncMembershipProjectionRole(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "admin",
    });

    assert.equal(store.userOrganizations.length, 1);
    assert.equal(store.userOrganizations[0].role, "member");
    assert.equal(store.teamMembers.length, 1);
    assert.equal(store.teamMembers[0].role, "admin");
  }

  // ── 6. setDefaultOrganization owns the flag, end to end ────────────────────────────────────────

  {
    const store = makeStore();
    store.userOrganizations.push({
      userId: USER,
      organizationId: OTHER_ORG,
      role: "owner",
      isDefault: true,
    });
    // What afterAddMember leaves at org-creation time: the row exists, the flag is false.
    store.userOrganizations.push({
      userId: USER,
      organizationId: ORG,
      role: "owner",
      isDefault: false,
    });

    await setDefaultOrganization(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "owner",
    });

    const flags = Object.fromEntries(
      store.userOrganizations.map((r) => [r.organizationId, r.isDefault]),
    );
    assert.deepEqual(flags, { [ORG]: true, [OTHER_ORG]: false });
    // It also creates the mirror the hook may have failed to write, rather than only flipping a
    // flag on what happens to be there.
    assert.equal(store.teamMembers.length, 1);
  }

  // ── 7. Removal, per member and per organization ────────────────────────────────────────────────

  {
    const store = makeStore();
    await writeMembershipProjections(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "owner",
    });
    await deleteMembershipProjections(store.client, {
      organizationId: ORG,
      userId: USER,
    });
    assert.equal(store.userOrganizations.length, 0);
    assert.equal(store.teamMembers.length, 0);
  }

  {
    // The org-wide sweep. Better Auth's /organization/delete bulk-deletes every ba_member row with
    // no per-member hook, and team_members has no FK to organizations, so nothing else clears it.
    const store = makeStore();
    await writeMembershipProjections(store.client, {
      organizationId: ORG,
      userId: USER,
      role: "owner",
    });
    await writeMembershipProjections(store.client, {
      organizationId: ORG,
      userId: "user-2",
      role: "member",
    });
    await writeMembershipProjections(store.client, {
      organizationId: OTHER_ORG,
      userId: USER,
      role: "owner",
    });

    await deleteOrganizationMembershipProjections(store.client, {
      organizationId: ORG,
    });

    assert.deepEqual(
      store.userOrganizations.map((r) => r.organizationId),
      [OTHER_ORG],
    );
    assert.deepEqual(
      store.teamMembers.map((r) => r.organization_id),
      [OTHER_ORG],
    );
  }

  console.log("membership.test.ts: all assertions passed");
}

// tsx compiles this file to CJS, where top-level await is unavailable, so the async half runs
// inside main(). A rejection has to set a non-zero exit code or run-lib-tests.mjs reads the
// failure as a pass.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
