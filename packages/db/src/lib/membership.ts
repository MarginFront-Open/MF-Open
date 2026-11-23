/**
 * Three tables look like "who belongs to which org". Only one decides anything.
 *
 *   `ba_member`          CANONICAL. Every authorization surface reads it and only
 *                        it. In api-nest: OrgRoleGuard (org-role.guard.ts),
 *                        OrgAccessGuard,
 *                        TeamService.getActorMembership, all three reads in
 *                        OrganizationsService. In the dashboard: the four
 *                        `app/actions/_shared/assert-*` gates,
 *                        `app/lib/require-route-roles.ts`, and the team actions.
 *                        Its `role` is free-form text and holds the real model:
 *                        owner / admin / finance / developer / legal / member.
 *
 *   `user_organizations` PROJECTION. Its `role` is the enum
 *                        `enum_user_organizations_role` = {member, owner,
 *                        superadmin}, which cannot represent `admin` or `finance`.
 *                        It carries `isDefault` and `joinedAt`, which ba_member has
 *                        no column for, and three dashboard server actions read it
 *                        as an org LIST (get-organizations-onboarding-status.ts,
 *                        check-org-by-name.ts, onboarding.ts).
 *
 *   `team_members`       MIRROR with no readers, kept in step so it can be dropped
 *                        cleanly.
 *
 * THE RULE: `ba_member` is written by the service or server action that owns the
 * decision (the last-owner lock has to sit next to it); the two projections are
 * written ONLY through the helpers below, so there is one add path, one role path,
 * one remove path, one org-wide teardown path. A sweep fails the build if that stops
 * being true: `apps/api-nest/src/modules/organizations/membership.sweep.spec.ts`.
 *
 * WHAT CANNOT BE MADE ATOMIC. Better Auth writes `ba_member` from inside
 * node_modules on its own connection and COMMITS before it calls our hooks
 * (apps/dashboard/app/lib/membership-hooks.ts). On that path there is no transaction
 * to join, so a projection write that fails leaves the canonical row correct and the
 * mirrors missing. Every helper below is at least internally atomic (see `runPaired`),
 * so the two mirrors cannot disagree with EACH OTHER, and every swallowed failure logs
 * the `MEMBERSHIP_PROJECTION_DRIFT` marker with the step an operator can take in the
 * Team settings.
 *
 * The gaps that remain are listed in the sweep's header under "WHAT THIS DOES NOT
 * COVER".
 *
 * WHY THIS FILE LIVES IN packages/db AND NOT IN EITHER APP. Both apps write
 * membership: api-nest owns the public team API, and the dashboard's Team UI calls
 * its OWN server actions (app/actions/team.ts), which never touch api-nest. A copy of
 * this logic per app would drift: two implementations of `toUserOrganizationsRole`
 * diverge the day someone adds a canonical role and updates one of them, and the
 * damage (a projection row whose role disagrees with the canonical one) is silent,
 * because nothing authorizes off the projection. Same reasoning, and the same home,
 * as `org-roles.ts` and `portal-access-revocation.ts`.
 */

import { randomUUID } from "node:crypto";

/**
 * The tiny slice of a Prisma client the projection writes touch. Structural on
 * purpose (the house pattern — see `portal-access-revocation.ts` and
 * `spend-coverage.ts`) so BOTH callers pass their own client with no cast: the
 * dashboard's client and api-nest's PrismaService, or either
 * one's interactive transaction client.
 *
 * Foot-gun: method syntax and open `unknown` args are load-bearing. Narrowing to
 * arrow properties or literal arg types breaks assignability for one of the
 * concrete clients — the generated delegate signatures are not identical across an
 * extended client and a plain one.
 */
export interface MembershipProjectionClient {
  user_organizations: {
    createMany(args?: unknown): Promise<{ count: number }>;
    updateMany(args?: unknown): Promise<{ count: number }>;
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
  team_members: {
    createMany(args?: unknown): Promise<{ count: number }>;
    updateMany(args?: unknown): Promise<{ count: number }>;
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
}

/**
 * Separate from `MembershipProjectionClient` because it is a different capability,
 * not a different table: `countOwnersForUpdate` needs raw SQL, and only callers
 * inside an OPEN transaction may use it at all. Keeping it its own type means a
 * caller cannot accidentally satisfy the lock's contract by handing over a
 * non-transactional client that happens to expose `$queryRaw`.
 */
export interface MembershipOwnerLockClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

/**
 * A TOP-LEVEL client, which can open a transaction. An interactive-transaction client
 * cannot: Prisma strips `$transaction` from the client it hands a `$transaction`
 * callback (its itx deny list is ["$connect","$disconnect","$on","$transaction",
 * "$extends"]). That asymmetry is the whole mechanism behind `runPaired` — presence of
 * the method IS the answer to "am I already inside a transaction?", so a caller cannot
 * get it wrong and no caller has to pass a flag.
 */
interface MembershipTransactionCapableClient extends MembershipProjectionClient {
  $transaction<T>(
    run: (tx: MembershipProjectionClient) => Promise<T>,
  ): Promise<T>;
}

/**
 * Run a pair of projection writes so they land together or not at all.
 *
 * WHY THIS EXISTS. Every helper below touches BOTH mirrors. Without this, each
 * helper's two statements would run independently. Inside an api-nest or Server Action
 * transaction that is fine, because the caller's `$transaction` covers them. But the four
 * Better Auth hooks and the onboarding back-fill call these helpers with a top-level
 * client, and Better Auth owns the two highest-volume membership events in the product
 * (org creation and invite acceptance). A dropped connection between the two statements
 * on THAT path would leave `user_organizations` and `team_members` disagreeing with each
 * other as well as with the canonical row.
 *
 * Given a top-level client this opens a short transaction; given a `tx` it runs inline,
 * because the caller's transaction already provides the guarantee and Prisma forbids
 * nesting. Given a plain test double with neither, it runs inline too.
 */
async function runPaired<T>(
  db: MembershipProjectionClient,
  work: (client: MembershipProjectionClient) => Promise<T>,
): Promise<T> {
  // Called as a property of `db`, not through `.call`, so `this` stays bound to the client.
  const client = db as Partial<MembershipTransactionCapableClient>;
  if (typeof client.$transaction !== "function") return work(db);
  return client.$transaction((tx) => work(tx));
}

/**
 * Better Auth stores MULTIPLE roles as one comma-joined string: its `parseRoles` is
 * `Array.isArray(roles) ? roles.join(",") : roles`, and both `/organization/add-member`
 * and `/organization/update-member-role` accept `z.union([z.string(),
 * z.array(z.string())])`. So `member.role` can arrive as "owner,admin", and its own
 * remove path proves the format by calling `member.role.split(",")`.
 *
 * Splitting here rather than comparing the whole string is what stops a comma-joined
 * OWNER projecting as a plain member in both mirrors. Our UI only ever sends a single
 * role; anyone POSTing the array form directly reaches this.
 */
function canonicalRoles(role: string): string[] {
  return role
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Project a canonical `ba_member` role onto `enum_user_organizations_role`
 * ({member, owner, superadmin}). `admin` and `finance` have no representation
 * there, so they land on `member`.
 *
 * This is LOSSY ON PURPOSE and the loss is safe only because the value is never
 * read to decide anything; see the header. If anything ever
 * authorizes off `user_organizations.role`, this flattening becomes a privilege bug,
 * so move that reader to `ba_member` instead of widening the enum.
 *
 * `superadmin` is unreachable from here by design, which is why every write below
 * refuses to overwrite an EXISTING superadmin row: no canonical role maps to it, so
 * every rewrite would be a downgrade of a value this code did not set.
 */
export function toUserOrganizationsRole(role: string): "owner" | "member" {
  return canonicalRoles(role).includes("owner") ? "owner" : "member";
}

/**
 * Project a canonical role onto `enum_team_members_role` ({admin, member}).
 * owner/admin collapse to `admin`, everything else to `member`. Same
 * lossy-but-unread reasoning as above.
 */
export function toLegacyTeamMembersRole(role: string): "admin" | "member" {
  return canonicalRoles(role).some((r) => r === "owner" || r === "admin")
    ? "admin"
    : "member";
}

/**
 * Inside an OPEN transaction, take a row-level write lock (SELECT ... FOR UPDATE)
 * on every current owner row of the org and return how many there are.
 *
 * WHY A LOCK AND NOT A PLAIN COUNT (the last-owner race):
 * the platform runs Postgres' default READ COMMITTED isolation. A bare `count()`
 * takes NO locks, so two concurrent owner-removals each open with their own
 * snapshot, BOTH read ownerCount = 2, BOTH delete a DIFFERENT owner, and the org
 * lands at ZERO owners — orphaned. Re-counting inside a transaction does not fix
 * this by itself; nothing serializes the two transactions. The FOR UPDATE lock
 * does: it covers the contended owner rows, so the second transaction BLOCKS until
 * the first commits, then re-reads the now-smaller owner set and correctly trips
 * the <= 1 check. The lock MUST be acquired on the same `tx` client that then
 * performs the delete/update — locking on a different connection protects nothing.
 *
 * organizationId is a uuid column; the cast keeps the bound parameter typed for
 * Postgres.
 */
export async function countOwnersForUpdate(
  tx: MembershipOwnerLockClient,
  organizationId: string,
): Promise<number> {
  const owners = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ba_member"
      WHERE "organizationId" = ${organizationId}::uuid AND role = 'owner'
      FOR UPDATE`;
  return owners.length;
}

export interface MembershipProjectionInput {
  organizationId: string;
  userId: string;
  /** The CANONICAL role just written to ba_member. Projected down per table. */
  role: string;
  invitedBy?: string;
}

/**
 * `createMany` + `skipDuplicates`, never `create`: every path through this file is also
 * a REPAIR path. `switchOrganization` reaches it for a canonical member who has no
 * projection row, the onboarding back-fill reaches it for anyone Better Auth minted,
 * and the role sync reaches it when it finds nothing to update. None of those may throw
 * on the (userId, organizationId) unique constraint.
 *
 * Split per table rather than written as one "create both" so the role sync can heal
 * exactly the mirror that was missing and leave the other alone — including leaving a
 * `superadmin` row untouched, which is why healing has to be a create-if-absent and
 * never an upsert.
 */
async function createUserOrganizationsRow(
  db: MembershipProjectionClient,
  { organizationId, userId, role, invitedBy }: MembershipProjectionInput,
): Promise<void> {
  const now = new Date();
  await db.user_organizations.createMany({
    data: [
      {
        id: randomUUID(),
        userId,
        organizationId,
        role: toUserOrganizationsRole(role),
        // Never true here. The default org is one flag across ALL of a user's orgs, so
        // setting it means clearing it everywhere else in the same breath —
        // `setDefaultOrganization` is the only thing that may write it.
        isDefault: false,
        joinedAt: now,
        invitedBy: invitedBy ?? null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

async function createTeamMembersRow(
  db: MembershipProjectionClient,
  { organizationId, userId, role, invitedBy }: MembershipProjectionInput,
): Promise<void> {
  const now = new Date();
  await db.team_members.createMany({
    data: [
      {
        id: randomUUID(),
        user_id: userId,
        organization_id: organizationId,
        role: toLegacyTeamMembersRole(role),
        status: "active",
        invited_by: invitedBy ?? null,
        joined_at: now,
        created_at: now,
        updated_at: now,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Force both mirrors onto the canonical role, and return how many rows each one
 * actually moved so the caller can tell "corrected" from "there was nothing there".
 *
 * `role: { not: "superadmin" }` is the one exclusion, and it is deliberate: no
 * canonical role projects to `superadmin` (see `toUserOrganizationsRole`), so
 * rewriting such a row would silently demote a value this code did not set and does
 * not understand. The cost of the exclusion is that a superadmin row reports `count: 0`, which the callers
 * below treat as "missing" and answer with a create-if-absent — a no-op on a row that
 * exists, so the row survives untouched either way.
 *
 * `status: "active"` on the `team_members` mirror closes the re-add case: a row left at
 * `inactive` matches the unique pair, so a plain create skips it and the person
 * ends up an active canonical member whose mirror still says they left.
 */
async function reprojectRoles(
  db: MembershipProjectionClient,
  {
    organizationId,
    userId,
    role,
  }: Omit<MembershipProjectionInput, "invitedBy">,
): Promise<{ projected: number; legacy: number }> {
  const now = new Date();

  const projected = await db.user_organizations.updateMany({
    where: { userId, organizationId, role: { not: "superadmin" } },
    data: { role: toUserOrganizationsRole(role), updatedAt: now },
  });

  const legacy = await db.team_members.updateMany({
    where: { user_id: userId, organization_id: organizationId },
    data: {
      role: toLegacyTeamMembersRole(role),
      status: "active",
      updated_at: now,
    },
  });

  return { projected: projected.count, legacy: legacy.count };
}

/**
 * Make the `user_organizations` and `team_members` rows for a canonical `ba_member`
 * exist AND carry the canonical role.
 *
 * The role sync at the end is not belt-and-braces, it is the point. `createMany` +
 * `skipDuplicates` alone is create-only, so adding a member on top of a STALE
 * projection row (one with no canonical pair) would leave the old role sitting there
 * while `ba_member` carried the new one.
 *
 * Grants nothing: a projection row is not an authorization input anywhere.
 */
export async function writeMembershipProjections(
  db: MembershipProjectionClient,
  input: MembershipProjectionInput,
): Promise<void> {
  await runPaired(db, async (client) => {
    await createUserOrganizationsRow(client, input);
    await createTeamMembersRow(client, input);
    await reprojectRoles(client, input);
  });
}

/**
 * Point the user's default org at `organizationId`, clearing the flag on every other
 * org first — and make sure the projection rows this flag lives on exist before
 * reaching for them.
 *
 * `isDefault` is a property of the USER, not of one membership: exactly one of a
 * user's `user_organizations` rows may carry it, which is why nothing else in this file
 * is allowed to write the column. `getUserOrganizations` sorts on it and falls back to
 * it when `users.current_organization_id` is unset (`getUserOrganizations` in
 * apps/api-nest/src/modules/organizations/organizations.service.ts), so two of them is a user whose
 * current org depends on row order, and none of them is a user whose org list opens
 * wherever.
 *
 * `runPaired` covers all three statements: outside a transaction, a failure after the
 * clear and before the set leaves a user with NO default org at all.
 */
export async function setDefaultOrganization(
  db: MembershipProjectionClient,
  {
    organizationId,
    userId,
    role,
  }: Omit<MembershipProjectionInput, "invitedBy">,
): Promise<void> {
  await runPaired(db, async (client) => {
    // The row may not exist yet: on the onboarding path Better Auth minted the
    // canonical row and our hook projected it, but on the api-nest path a member added
    // through the team API reaches here with no projection row at all.
    await createUserOrganizationsRow(client, { organizationId, userId, role });
    await createTeamMembersRow(client, { organizationId, userId, role });

    await client.user_organizations.updateMany({
      where: { userId },
      data: { isDefault: false },
    });
    await client.user_organizations.updateMany({
      where: { userId, organizationId },
      data: { isDefault: true },
    });
  });
}

/**
 * Re-project a role change onto both mirrors, creating a mirror row that was never
 * there rather than skipping it.
 *
 * `updateMany` (not `update`) because a member can be missing its projection rows, and
 * a 500 on a role change would be a worse answer than a no-op. A no-op is not enough
 * either: re-roling a member with no mirror row would leave them without one. Every
 * caller here has already written the canonical `ba_member` row, so a missing mirror is
 * drift by definition, and it is created here inside the same transaction.
 */
export async function syncMembershipProjectionRole(
  db: MembershipProjectionClient,
  {
    organizationId,
    userId,
    role,
  }: Omit<MembershipProjectionInput, "invitedBy">,
): Promise<void> {
  await runPaired(db, async (client) => {
    const moved = await reprojectRoles(client, {
      organizationId,
      userId,
      role,
    });
    if (moved.projected === 0) {
      await createUserOrganizationsRow(client, {
        organizationId,
        userId,
        role,
      });
    }
    if (moved.legacy === 0) {
      await createTeamMembersRow(client, { organizationId, userId, role });
    }
  });
}

/**
 * Purely SUBTRACTIVE, so it is always safe to call, including for a user who has no
 * projection rows. Every caller MUST run it in the same transaction as the canonical
 * `ba_member.delete`. A removal that clears one table and not the other is the drift
 * this file exists to prevent. `runPaired` supplies that transaction for the callers
 * that have none of their own, which is every Better Auth hook.
 */
export async function deleteMembershipProjections(
  db: MembershipProjectionClient,
  { organizationId, userId }: { organizationId: string; userId: string },
): Promise<void> {
  await runPaired(db, async (client) => {
    await client.user_organizations.deleteMany({
      where: { userId, organizationId },
    });
    await client.team_members.deleteMany({
      where: { user_id: userId, organization_id: organizationId },
    });
  });
}

/**
 * Clear EVERY projection row for an organization, for the case where the org itself is
 * going away.
 *
 * WHY THIS IS NOT COVERED BY THE FOREIGN KEYS. `ba_member` and `user_organizations`
 * both declare `onDelete: Cascade` on `organizationId` in
 * packages/db/prisma/schema.prisma. The `team_members` model declares NO relation at
 * all; it carries bare uuid columns — so deleting an
 * `organizations` row leaves its `team_members` rows behind, pointing at an org id that
 * no longer exists.
 *
 * Better Auth's `/organization/delete` bulk-deletes the org's `ba_member` rows with no
 * per-member hook (see the organization plugin's adapter in better-auth), so `afterRemoveMember` never fires and only an org-wide sweep can keep up.
 * That is what `afterDeleteOrganization` calls.
 *
 * STILL UNCOVERED BY ANY CODE PATH, and named so it is a decision: a hard DELETE of a
 * `users` or `organizations` row straight through psql bypasses this entirely. The two
 * cascading tables clean themselves up and `team_members` does not. Nothing reads
 * `team_members`, so a leftover row there grants nothing.
 */
export async function deleteOrganizationMembershipProjections(
  db: MembershipProjectionClient,
  { organizationId }: { organizationId: string },
): Promise<void> {
  await runPaired(db, async (client) => {
    await client.user_organizations.deleteMany({ where: { organizationId } });
    await client.team_members.deleteMany({
      where: { organization_id: organizationId },
    });
  });
}
