/**
 * cost-grouping: getMatterCostRollups contract.
 *
 * No DB hit — $queryRaw is stubbed; what's under test is the query the
 * function builds and what it does with the rows. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/cost-grouping.test.ts
 *
 * WHY this test is load-bearing: every matter-cost surface (Law tab, REST,
 * MCP) orders from this one function, so its filter branches ARE the
 * multi-tenant and window contract. Pinned here: the org filter is always
 * present, the window rides only when asked, the bucket restriction takes
 * the IN / IS NULL branches correctly, every requested bucket comes back
 * exactly once (zero-filled), and an empty request never touches the DB.
 * SQL-vs-Postgres truth (does the query really sum right on real rows) is
 * a real-database test's job, not this script's.
 */

import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "@prisma/client";

import { getMatterCostRollups } from "./cost-grouping";

type RawRow = {
  matterId: string | null;
  cost: number;
  eventCount: number;
  eventsMissingCost: number;
};

function stubDb(rows: RawRow[]) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push(query);
      return rows;
    },
  } as unknown as PrismaClient;
  return { db, calls };
}

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MATTER_A = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MATTER_B = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function main() {
  // --- Unfiltered: org-only WHERE, rows returned as queried -----------------
  {
    const { db, calls } = stubDb([
      { matterId: MATTER_A, cost: 4.6, eventCount: 14, eventsMissingCost: 2 },
      { matterId: null, cost: 1.0, eventCount: 3, eventsMissingCost: 0 },
    ]);
    const rollups = await getMatterCostRollups(db, ORG);
    assert.equal(rollups.length, 2);
    assert.deepEqual(rollups[0], {
      matterId: MATTER_A,
      cost: 4.6,
      eventCount: 14,
      eventsMissingCost: 2,
    });
    assert.equal(calls.length, 1);
    const sql = calls[0].sql;
    assert.match(sql, /"organizationId" = \?::uuid/);
    assert.match(sql, /GROUP BY 1/);
    assert.doesNotMatch(sql, /"usageDate"/, "no window unless requested");
    assert.doesNotMatch(
      sql,
      /"matterId" IN|"matterId" IS NULL/,
      "no bucket restriction unless requested",
    );
    assert.deepEqual(calls[0].values, [ORG]);
  }

  // --- Window: both bounds ride as ISO params (canon C2: usageDate) ---------
  {
    const start = new Date("2026-08-01T00:00:00.000Z");
    const end = new Date("2026-08-31T23:59:59.999Z");
    const { db, calls } = stubDb([]);
    await getMatterCostRollups(db, ORG, { window: { start, end } });
    const sql = calls[0].sql;
    assert.match(sql, /"usageDate" >= \?::timestamptz/);
    assert.match(sql, /"usageDate" <= \?::timestamptz/);
    assert.deepEqual(calls[0].values, [
      ORG,
      start.toISOString(),
      end.toISOString(),
    ]);
  }

  // --- Bucket restriction: ids only, null only, mixed -----------------------
  {
    const { db, calls } = stubDb([]);
    await getMatterCostRollups(db, ORG, { matterIds: [MATTER_A, MATTER_B] });
    assert.match(calls[0].sql, /"matterId" IN \(\?::uuid,\?::uuid\)/);
    assert.doesNotMatch(calls[0].sql, /"matterId" IS NULL/);
  }
  {
    const { db, calls } = stubDb([]);
    await getMatterCostRollups(db, ORG, { matterIds: [null] });
    assert.match(calls[0].sql, /"matterId" IS NULL/);
    assert.doesNotMatch(calls[0].sql, /"matterId" IN/);
  }
  {
    const { db, calls } = stubDb([]);
    await getMatterCostRollups(db, ORG, { matterIds: [MATTER_A, null] });
    assert.match(
      calls[0].sql,
      /\(e\."matterId" IN \(\?::uuid\) OR e\."matterId" IS NULL\)/,
    );
  }

  // --- Zero-fill: every requested bucket exactly once, request order kept ---
  {
    const { db } = stubDb([
      { matterId: MATTER_B, cost: 2.5, eventCount: 4, eventsMissingCost: 1 },
    ]);
    const rollups = await getMatterCostRollups(db, ORG, {
      matterIds: [MATTER_A, MATTER_B, null, MATTER_A],
    });
    assert.deepEqual(rollups, [
      { matterId: MATTER_A, cost: 0, eventCount: 0, eventsMissingCost: 0 },
      { matterId: MATTER_B, cost: 2.5, eventCount: 4, eventsMissingCost: 1 },
      { matterId: null, cost: 0, eventCount: 0, eventsMissingCost: 0 },
    ]);
  }

  // --- Empty request: [] back, DB never touched -----------------------------
  {
    const { db, calls } = stubDb([
      { matterId: MATTER_A, cost: 99, eventCount: 1, eventsMissingCost: 0 },
    ]);
    const rollups = await getMatterCostRollups(db, ORG, { matterIds: [] });
    assert.deepEqual(rollups, []);
    assert.equal(calls.length, 0, "empty bucket request must not query");
  }

  console.log(
    "[cost-grouping] OK — getMatterCostRollups: org always filtered, window/bucket branches, zero-fill, empty short-circuit",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
