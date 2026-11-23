/**
 * portal-access-revocation: cascade shape + tenancy test.
 *
 * Pure, no DB hit. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/portal-access-revocation.test.ts
 *
 * What this pins, and why each pin is load-bearing:
 *   1. TENANCY — org B's live link and session are untouched by an org A revoke.
 *   2. WHERE SHAPE — links filter on usedAt:null AND expiresAt:{gt}, sessions on
 *      expiresAt:{gt}. Reducing the WHERE to a bare organizationId
 *      filter would make the returned counts dishonest (claiming to have ended
 *      already-dead access) and goes red here.
 *   3. STRICT-PAST EXPIRY — the written expiresAt is at least a full second
 *      before the `now` every reader compares against with strict gt/lt. Writing
 *      exactly `now` would leave a same-millisecond window where a session still
 *      validates; the >= 1000ms assertion fails for that mutation.
 *   4. HONEST COUNTS — the returned numbers are the updateMany match counts,
 *      not a guess.
 *
 * The in-memory client implements Prisma's {gt: Date} operator semantics —
 * scalar equality cannot express the filters under test.
 */

import assert from "node:assert/strict";

import { revokePortalAccessForOrg } from "./portal-access-revocation";

type Row = Record<string, unknown>;

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (
      cond !== null &&
      typeof cond === "object" &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      return Object.entries(cond as Record<string, unknown>).every(
        ([op, value]) => {
          const current = row[field] as Date;
          if (op === "gt") return current > (value as Date);
          if (op === "lt") return current < (value as Date);
          throw new Error(`Unsupported operator in test matcher: ${op}`);
        },
      );
    }
    return row[field] === cond;
  });
}

function makeDelegate(rows: Row[]) {
  const calls: Array<{ where: Record<string, unknown>; data: Row }> = [];
  return {
    calls,
    async updateMany(args?: unknown) {
      const { where, data } = args as {
        where: Record<string, unknown>;
        data: Row;
      };
      calls.push({ where, data });
      const matched = rows.filter((row) => rowMatches(row, where));
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;

async function main() {
  const testStart = new Date();
  const liveExpiry = new Date(testStart.getTime() + HOUR_MS);
  const deadExpiry = new Date(testStart.getTime() - HOUR_MS);

  const links: Row[] = [
    {
      id: "lnk-a-live",
      organizationId: "org-a",
      usedAt: null,
      expiresAt: liveExpiry,
    },
    {
      id: "lnk-a-used",
      organizationId: "org-a",
      usedAt: testStart,
      expiresAt: liveExpiry,
    },
    {
      id: "lnk-a-dead",
      organizationId: "org-a",
      usedAt: null,
      expiresAt: deadExpiry,
    },
    {
      id: "lnk-b-live",
      organizationId: "org-b",
      usedAt: null,
      expiresAt: liveExpiry,
    },
  ];
  const sessions: Row[] = [
    { id: "ses-a-live", organizationId: "org-a", expiresAt: liveExpiry },
    { id: "ses-a-dead", organizationId: "org-a", expiresAt: deadExpiry },
    { id: "ses-b-live", organizationId: "org-b", expiresAt: liveExpiry },
  ];

  const linkDelegate = makeDelegate(links);
  const sessionDelegate = makeDelegate(sessions);

  const result = await revokePortalAccessForOrg(
    { portal_magic_links: linkDelegate, portal_sessions: sessionDelegate },
    "org-a",
  );

  // 4. Honest counts: exactly the live org A rows, nothing already dead or used.
  assert.deepEqual(result, { magicLinksEnded: 1, portalSessionsEnded: 1 });

  // 1. Tenancy: org B rows are byte-identical to how they started.
  const lnkB = links.find((r) => r.id === "lnk-b-live")!;
  const sesB = sessions.find((r) => r.id === "ses-b-live")!;
  assert.equal(lnkB.expiresAt, liveExpiry, "org B magic link was touched");
  assert.equal(sesB.expiresAt, liveExpiry, "org B portal session was touched");

  // Already-dead and already-used org A rows are also untouched (honest counts).
  assert.equal(links.find((r) => r.id === "lnk-a-used")!.expiresAt, liveExpiry);
  assert.equal(links.find((r) => r.id === "lnk-a-dead")!.expiresAt, deadExpiry);
  assert.equal(
    sessions.find((r) => r.id === "ses-a-dead")!.expiresAt,
    deadExpiry,
  );

  // 2. WHERE shape pins.
  assert.equal(linkDelegate.calls.length, 1);
  assert.equal(sessionDelegate.calls.length, 1);
  const linkWhere = linkDelegate.calls[0].where;
  const sessionWhere = sessionDelegate.calls[0].where;
  assert.equal(linkWhere.organizationId, "org-a");
  assert.equal(linkWhere.usedAt, null, "links WHERE must filter usedAt: null");
  assert.ok(
    linkWhere.expiresAt &&
      (linkWhere.expiresAt as { gt?: Date }).gt instanceof Date,
    "links WHERE must filter expiresAt: { gt: <now> }",
  );
  assert.equal(sessionWhere.organizationId, "org-a");
  assert.ok(
    sessionWhere.expiresAt &&
      (sessionWhere.expiresAt as { gt?: Date }).gt instanceof Date,
    "sessions WHERE must filter expiresAt: { gt: <now> }",
  );

  // 3. Strict-past expiry: the written value sits a full second before the `now`
  // the WHERE compared against, so every strict-gt reader sees it as dead
  // immediately. A mutation to `new Date()` (0ms in the past) fails here.
  const comparedNow = (linkWhere.expiresAt as { gt: Date }).gt;
  const writtenLink = linkDelegate.calls[0].data.expiresAt as Date;
  const writtenSession = sessionDelegate.calls[0].data.expiresAt as Date;
  assert.ok(
    comparedNow.getTime() - writtenLink.getTime() >= 1000,
    "written link expiresAt must be at least 1s before the compared now",
  );
  assert.ok(
    comparedNow.getTime() - writtenSession.getTime() >= 1000,
    "written session expiresAt must be at least 1s before the compared now",
  );
  // Reader predicate check: the strict-gt reader treats the written value as
  // dead even within the same millisecond as the cascade's own `now`.
  assert.equal(writtenLink > comparedNow, false);
  assert.equal(writtenSession > comparedNow, false);

  // The killed org A rows now fail every reader's liveness predicate.
  const killedLink = links.find((r) => r.id === "lnk-a-live")!;
  const killedSession = sessions.find((r) => r.id === "ses-a-live")!;
  assert.ok((killedLink.expiresAt as Date) < new Date());
  assert.ok((killedSession.expiresAt as Date) < new Date());

  console.log("portal-access-revocation.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
