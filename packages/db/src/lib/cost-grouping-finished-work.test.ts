/**
 * cost-grouping: getCostBreakdown's finishedWork option.
 *
 *   npx tsx packages/db/src/lib/cost-grouping-finished-work.test.ts
 *
 * No DB hit — $queryRaw and $transaction are stubbed; what is under test is
 * the SQL this function builds and what it does with the rows it gets back.
 *
 * WHY this is load-bearing: the ROI tab's Cost tile and its "What you
 * finished" table are inches apart on one page, so they read from ONE
 * snapshot. Pinned here: without the option the function runs the same three
 * queries and returns the same result keys; with it, four extra numbers
 * ride the SAME transaction; and the outcome marker is the priced-zero
 * provider on the event's child row, never a second field that could disagree.
 */

import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { getCostBreakdown } from "./cost-grouping";

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_B = "22222222-2222-2222-2222-222222222222";
const WINDOW = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-09-30T23:59:59.999Z"),
};

/** Answers each $queryRaw in call order, and records the SQL it was handed. */
function stubDb(responses: unknown[][]) {
  const calls: Prisma.Sql[] = [];
  const transactions: unknown[][] = [];
  let next = 0;
  const db = {
    $queryRaw: (query: Prisma.Sql) => {
      calls.push(query);
      const rows = responses[next] ?? [];
      next += 1;
      return Promise.resolve(rows);
    },
    $transaction: (promises: Promise<unknown>[]) => {
      transactions.push(promises);
      return Promise.all(promises);
    },
  } as unknown as PrismaClient;
  return { db, calls, transactions };
}

const sqlOf = (query: Prisma.Sql) => query.sql.replace(/\s+/g, " ").trim();

/** The one discriminator, spelled out so a rename has to come through here. */
const MARKER =
  `EXISTS ( SELECT 1 FROM signal_event_services ses ` +
  `WHERE ses."signalEventId" = e.id AND lower(ses."modelProvider") = 'outcome' )`;

const FINISHED_ALL = { finishedWork: { agentIds: null } };

const TOTALS = [{ cost: 12.5, eventCount: 40, eventCountWithNullCost: 1 }];
const SERIES = [
  { date: new Date("2026-09-02T00:00:00.000Z"), cost: 12.5, eventCount: 40 },
];
const ROWS = [
  {
    key: AGENT_A,
    cost: 12.5,
    eventCount: 40,
    totalRowCount: 1,
    isOther: false,
    rn: 1,
  },
];

async function main() {
  // --- Option absent: three queries, base keys, no finished-work fields ---
  {
    const { db, calls, transactions } = stubDb([TOTALS, SERIES, ROWS]);
    const result = await getCostBreakdown(db, ORG, WINDOW, "agent");

    assert.equal(calls.length, 3, "option absent must issue exactly 3 queries");
    assert.equal(transactions.length, 1, "still one transaction");
    assert.equal(transactions[0].length, 3);
    assert.deepEqual(Object.keys(result), [
      "totals",
      "series",
      "rows",
      "totalRowCount",
      "other",
    ]);
    assert.deepEqual(Object.keys(result.totals), [
      "cost",
      "eventCount",
      "eventCountWithNullCost",
    ]);
    assert.deepEqual(Object.keys(result.rows[0]), [
      "key",
      "cost",
      "eventCount",
    ]);
    assert.equal(
      "finishedWork" in result,
      false,
      "no finished-work key when nobody asked for one",
    );
    for (const call of calls) {
      assert.ok(
        !sqlOf(call).includes("signal_event_services"),
        "the marker lookup must not ride along unasked",
      );
    }
  }

  // --- Option present: four more reads inside the SAME transaction ----------
  {
    const totals = [
      {
        cost: 12.5,
        eventCount: 40,
        eventCountWithNullCost: 1,
        eventCountFinishedWork: 3,
      },
    ];
    const rows = [
      {
        key: AGENT_A,
        cost: 12.5,
        eventCount: 40,
        eventCountFinishedWork: 3,
        totalRowCount: 1,
        isOther: false,
        rn: 1,
      },
    ];
    const things = [
      {
        name: "Contract Summarized",
        agentId: AGENT_A,
        customerExternalId: "dev@co.example",
        label: "PROJ-123",
        howMany: 3,
        eventCount: 3,
      },
    ];
    const buckets = [
      {
        customerExternalId: "dev@co.example",
        label: "PROJ-123",
        agentId: AGENT_A,
        cost: 12.5,
        eventCount: 37,
        eventCountWithNullCost: 1,
      },
    ];
    const namedUsage = [
      {
        name: "invoice parsed",
        agentId: AGENT_B,
        howMany: 9,
        cost: 4.25,
        eventCount: 9,
        eventCountWithNullCost: 0,
      },
    ];
    const { db, calls, transactions } = stubDb([
      totals,
      SERIES,
      rows,
      things,
      buckets,
      namedUsage,
    ]);

    const result = await getCostBreakdown(
      db,
      ORG,
      WINDOW,
      "agent",
      {},
      {
        finishedWork: { agentIds: null },
      },
    );

    assert.equal(calls.length, 6, "three more reads");
    assert.equal(transactions.length, 1, "ONE transaction, not two snapshots");
    assert.equal(
      transactions[0].length,
      6,
      "the finished-work reads ride the SAME snapshot as the Cost tile",
    );

    assert.equal(result.totals.eventCountFinishedWork, 3);
    assert.equal(result.rows[0].eventCountFinishedWork, 3);
    assert.deepEqual(result.finishedWork?.things, things);
    assert.deepEqual(result.finishedWork?.buckets, buckets);
    assert.deepEqual(result.finishedWork?.namedUsage, namedUsage);
  }

  // --- The marker is the priced-zero provider, and nothing else ------------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(
      db,
      ORG,
      WINDOW,
      "agent",
      {},
      {
        finishedWork: { agentIds: null },
      },
    );

    for (const index of [0, 2, 3, 4, 5]) {
      assert.ok(
        sqlOf(calls[index]).includes(MARKER),
        `query ${index} must use the provider marker verbatim`,
      );
    }
    // No second marker field anywhere: one word decides, so nothing can disagree.
    for (const call of calls) {
      assert.ok(
        !sqlOf(call).includes("'outcome'::"),
        "no cast-shaped second marker",
      );
      assert.ok(
        !sqlOf(call).includes("metadata' -> 'outcome"),
        "the record's own metadata is never consulted for the marker",
      );
      assert.ok(
        !sqlOf(call).includes('s."type"'),
        "signals.type is never read: the ROI tab does not touch it",
      );
    }

    // The coding meter's own agents are what namedUsage excludes.
    const named = sqlOf(calls[5]);
    assert.ok(
      named.includes('a."agentCode" NOT IN'),
      "namedUsage excludes by agentCode",
    );
    assert.ok(
      calls[5].values.includes("claude-code") &&
        calls[5].values.includes("codex"),
      "and the codes come from CCC_AGENT_CODES, bound not spliced",
    );
  }

  // --- Agent scope narrows every finished-work read, and only those ---------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(
      db,
      ORG,
      WINDOW,
      "agent",
      {},
      {
        finishedWork: { agentIds: [AGENT_A, AGENT_B] },
      },
    );
    for (const index of [3, 4, 5]) {
      assert.ok(
        calls[index].values.includes(AGENT_A) &&
          calls[index].values.includes(AGENT_B),
        `finished-work query ${index} must bind the agent scope`,
      );
    }
    assert.ok(
      !calls[1].values.includes(AGENT_A),
      "the day series is NOT narrowed: the chart still answers for the whole window",
    );
  }

  // --- An empty agent scope reads nothing rather than everything -----------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
    ]);
    const result = await getCostBreakdown(
      db,
      ORG,
      WINDOW,
      "agent",
      {},
      {
        finishedWork: { agentIds: [] },
      },
    );
    assert.equal(
      calls.length,
      3,
      "no agent means no finished-work read at all",
    );
    assert.deepEqual(result.finishedWork, {
      things: [],
      buckets: [],
      namedUsage: [],
    });
    // The tile subtracts this number. Reading the ORG total here while the
    // table below shows nothing would drop the tile by events nobody can see.
    assert.ok(
      !sqlOf(calls[0]).includes("FILTER (WHERE EXISTS"),
      "an empty scope counts no finished work at all, it does not count every agent's",
    );
    assert.ok(
      sqlOf(calls[0]).includes(`(0)::int AS "eventCountFinishedWork"`),
      "and it says so as a flat zero",
    );
    assert.equal(result.totals.eventCountFinishedWork, 0);
  }

  // --- The scoped count matches the scoped lists ---------------------------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(
      db,
      ORG,
      WINDOW,
      "agent",
      {},
      { finishedWork: { agentIds: [AGENT_A] } },
    );
    for (const index of [0, 2]) {
      assert.ok(
        sqlOf(calls[index]).includes(
          `FILTER (WHERE ${MARKER} AND e."agentId" IN (`,
        ),
        `query ${index}'s finished-work count must carry the SAME agent scope the three lists do, or the Usage events tile drops by events the table below shows none of`,
      );
    }
  }

  // --- The bucket is (developer, work item). Not the agent. ----------------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(db, ORG, WINDOW, "agent", {}, FINISHED_ALL);

    const buckets = sqlOf(calls[4]);
    const cte = buckets.slice(0, buckets.indexOf(") SELECT"));
    assert.ok(
      !cte.includes(`e."agentId" AS "agentId"`),
      "the bucket key must NOT include the agent: one person works a ticket with two assistants, and the second one's spend would be attributed to nothing",
    );
    assert.ok(
      !buckets.includes(`e."agentId" = b."agentId"`),
      "and the join must not narrow the money to the agent that recorded the thing",
    );
    assert.ok(
      buckets.includes(`e."agentId"::text AS "agentId"`),
      "the cost still comes back sliced per agent, so the checkboxes can re-scope it",
    );

    // A bucket's cost is CODING-TURN spend. That is also what
    // keeps these rows and the named integration rows disjoint.
    assert.ok(
      buckets.includes(`ca."agentCode" IN`),
      "a bucket's cost is the coding meter's spend, not every non-outcome event",
    );
    assert.ok(
      calls[4].values.includes("claude-code") &&
        calls[4].values.includes("codex"),
      "and the codes are bound, not spliced",
    );
    const named = sqlOf(calls[5]);
    assert.ok(
      named.includes(`a."agentCode" NOT IN`),
      "the named rows are the exact complement, so no dollar is in both",
    );
  }

  // --- The label is the RESOLVED work item, then the raw tag ---------------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(db, ORG, WINDOW, "agent", {}, FINISHED_ALL);

    const label = `COALESCE(e."matterId"::text, e."metadata" ->> 'matterId', '')`;
    for (const index of [3, 4]) {
      assert.ok(
        sqlOf(calls[index]).includes(label),
        `query ${index} must group on the resolved work item first: work items are assigned by rule and by hand too, and reading only the tag would show that spend against a work item on one tab and outside every work item on this one`,
      );
    }
  }

  // --- A nameless record cannot take the whole report down ----------------
  {
    const { db, calls } = stubDb([
      [
        {
          cost: 0,
          eventCount: 0,
          eventCountWithNullCost: 0,
          eventCountFinishedWork: 0,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    await getCostBreakdown(db, ORG, WINDOW, "agent", {}, FINISHED_ALL);

    const things = sqlOf(calls[3]);
    assert.ok(
      things.includes(`array_agg(COALESCE(s."name", '')`),
      "the selected name must be COALESCE'd the same way the GROUP BY is: signalId is nullable, and a null name fails the row schema, which fails the WHOLE report",
    );
  }

  console.log("cost-grouping-finished-work: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
