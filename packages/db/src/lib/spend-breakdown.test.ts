/**
 * spend-breakdown: the ONE repo/branch coding-spend rollup and its branch
 * drill. Runs under tsx in <1s against an in-memory client stub
 * (packages/db src test convention — standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/spend-breakdown.test.ts
 *
 * WHY load-bearing: api-nest's GET /control/spend/breakdown serves these
 * numbers to the dashboard's Internal AI Spend page.
 *
 * What this pins, each failure-capable:
 *   1. BUCKET TOTALS — per-repo and per-branch sums, branch keys composite so
 *      'main' in two repos stays two rows, rows sorted by spend descending.
 *   2. THE noMetadata BUCKET — events with no repo/branch recorded land in it,
 *      count in totals, and never vanish.
 *   3. coveragePercent — the tagged share, and NULL on an empty window
 *      ("nothing to measure" is not 0% tagged).
 *   4. HONEST NULL — spentUsd stays null when nothing in a bucket is priced,
 *      never coerced to 0, while unpricedEventCount still counts the activity.
 *   5. INTERNAL SCOPE — a customer-billing event (different agentCode) never
 *      counts. The NEGATIVE CONTROL replays the unfiltered rollup and shows it
 *      differs, which is the exact leak cccInternalEventFilter closes.
 *   6. DRILL AGREEMENT — a branch drill's totals equal that branch's row in the
 *      breakdown, over the same window and the same events.
 */

import assert from "node:assert/strict";

import {
  computeSpendBreakdown,
  computeSpendBreakdownDrill,
  type SpendBreakdownQueryClient,
} from "./spend-breakdown";
import { CCC_AGENT_CODES } from "./cap-policy";

const ORG = "org-uuid";
const OTHER_ORG = "someone-elses-org";
const NOW = new Date("2026-07-22T12:00:00.000Z");
// Inside the month window (July 2026) and inside the week window (Mon Jul 20).
const IN_WINDOW = new Date("2026-07-21T09:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-06-30T09:00:00.000Z");

interface StubEvent {
  organizationId: string;
  usageDate: Date;
  /** null = the platform could not price it (the unpriced bucket). */
  usageCost: number | null;
  agentCode: string;
  customerExternalId?: string | null;
  metadata?: unknown;
}

/**
 * Stands in for the two concrete clients at the seam the shared function uses:
 * one findMany with a where + select. The where is applied for real (org,
 * window, and the agents.agentCode.in the internal filter contributes) so the
 * scope assertions below can actually fail.
 */
function stubClient(events: StubEvent[]): SpendBreakdownQueryClient {
  return {
    signal_events: {
      findMany: (args?: unknown) => {
        const where = (args as { where: Record<string, any> }).where;
        const agentCodes: string[] | undefined =
          where.agents?.agentCode?.in ?? undefined;
        return Promise.resolve(
          events
            .filter((e) => {
              if (e.organizationId !== where.organizationId) return false;
              if (e.usageDate < where.usageDate.gte) return false;
              if (e.usageDate > where.usageDate.lte) return false;
              if (agentCodes && !agentCodes.includes(e.agentCode)) return false;
              return true;
            })
            .map((e) => ({
              usageCost: e.usageCost,
              metadata: e.metadata,
              customerExternalId: e.customerExternalId ?? null,
            })),
        );
      },
    },
  };
}

function internal(
  usageCost: number | null,
  metadata: unknown,
  customerExternalId = "dev@example.com",
): StubEvent {
  return {
    organizationId: ORG,
    usageDate: IN_WINDOW,
    usageCost,
    agentCode: "claude-code",
    customerExternalId,
    metadata,
  };
}

const git = (
  repo: string | null,
  branch?: string | null,
  commitSha?: string,
) => ({
  ...(repo === null ? {} : { repo }),
  ...(branch === undefined || branch === null ? {} : { branch }),
  ...(commitSha ? { commitSha } : {}),
});

async function main() {
  // 1. BUCKET TOTALS, repo grain.
  {
    const result = await computeSpendBreakdown(
      stubClient([
        internal(1.5, git("acme/api", "main")),
        internal(2.5, git("acme/api", "feature")),
        internal(0.75, git("acme/web", "main")),
      ]),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    assert.deepEqual(
      result.rows,
      [
        { key: "acme/api", spentUsd: 4, eventCount: 2, unpricedEventCount: 0 },
        {
          key: "acme/web",
          spentUsd: 0.75,
          eventCount: 1,
          unpricedEventCount: 0,
        },
      ],
      "repo buckets sum per repo and sort by spend descending",
    );
    assert.deepEqual(result.totals, {
      spentUsd: 4.75,
      eventCount: 3,
      unpricedEventCount: 0,
    });
    assert.equal(result.coveragePercent, 100);
    assert.equal(result.dimension, "repo");
    assert.equal(result.period, "month");
    assert.equal(result.asOf, NOW.toISOString());
  }

  // 1b. Branch keys are composite: 'main' in two repos must stay two rows.
  {
    const result = await computeSpendBreakdown(
      stubClient([
        internal(1, git("acme/api", "main")),
        internal(3, git("acme/web", "main")),
      ]),
      ORG,
      { period: "month", dimension: "branch" },
      NOW,
    );
    assert.deepEqual(
      result.rows.map((r) => r.key),
      ["acme/web#main", "acme/api#main"],
      "one bucket per repo#branch, never a merged 'main'",
    );
  }

  // 2. The noMetadata bucket: untagged events are kept, not dropped.
  {
    const result = await computeSpendBreakdown(
      stubClient([
        internal(4, git("acme/api", "main")),
        internal(1, {}),
        internal(2, { repo: null, branch: null }),
        internal(3, "not-an-object"),
      ]),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    assert.deepEqual(
      result.noMetadata,
      { spentUsd: 6, eventCount: 3, unpricedEventCount: 0 },
      "absent keys, explicit JSON nulls, and non-objects all land in noMetadata",
    );
    assert.equal(
      result.totals.eventCount,
      4,
      "noMetadata events count in totals",
    );
    assert.equal(result.totals.spentUsd, 10);
    assert.equal(result.rows.length, 1);
    assert.equal(result.coveragePercent, 25, "1 of 4 events carries a repo");
  }

  // 3. coveragePercent is NULL on an empty window: nothing to measure is not 0%.
  {
    const result = await computeSpendBreakdown(
      stubClient([
        { ...internal(9, git("acme/api", "main")), usageDate: BEFORE_WINDOW },
      ]),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    assert.equal(result.totals.eventCount, 0);
    assert.equal(
      result.coveragePercent,
      null,
      "an empty window reports null coverage, never 0%",
    );
    assert.equal(
      result.totals.spentUsd,
      null,
      "an empty window reports null spend, never $0",
    );
    assert.deepEqual(result.rows, []);
  }

  // 3b. A window with events but no tagged ones reports 0, not null: we DID
  // measure, and the answer was none. The two states must stay distinguishable.
  {
    const result = await computeSpendBreakdown(
      stubClient([internal(1, {}), internal(2, {})]),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    assert.equal(result.coveragePercent, 0);
    assert.equal(result.noMetadata.eventCount, 2);
  }

  // 4. HONEST NULL: an all-unpriced bucket keeps spentUsd null while still
  // counting the activity it saw.
  {
    const result = await computeSpendBreakdown(
      stubClient([
        internal(null, git("acme/api", "main")),
        internal(null, git("acme/api", "main")),
        internal(2, git("acme/web", "main")),
        internal(null, {}),
      ]),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    const api = result.rows.find((r) => r.key === "acme/api");
    assert.deepEqual(
      api,
      { key: "acme/api", spentUsd: null, eventCount: 2, unpricedEventCount: 2 },
      "nothing priced means spentUsd null, never 0, with the events still counted",
    );
    assert.notEqual(api?.spentUsd, 0, "null must not be coerced to zero");
    assert.deepEqual(result.noMetadata, {
      spentUsd: null,
      eventCount: 1,
      unpricedEventCount: 1,
    });
    assert.deepEqual(result.totals, {
      spentUsd: 2,
      eventCount: 4,
      unpricedEventCount: 3,
    });
    assert.equal(
      result.rows[0]?.key,
      "acme/web",
      "a priced bucket outranks an unpriced one",
    );
  }

  // 5. INTERNAL SCOPE, with a negative control. A customer-billing event and
  // another org's event must both be invisible here.
  {
    const events: StubEvent[] = [
      internal(5, git("acme/api", "main")),
      {
        organizationId: ORG,
        usageDate: IN_WINDOW,
        usageCost: 1000,
        agentCode: "customer-billing-agent",
        metadata: git("acme/api", "main"),
      },
      {
        organizationId: OTHER_ORG,
        usageDate: IN_WINDOW,
        usageCost: 500,
        agentCode: "claude-code",
        metadata: git("acme/api", "main"),
      },
    ];
    const result = await computeSpendBreakdown(
      stubClient(events),
      ORG,
      { period: "month", dimension: "repo" },
      NOW,
    );
    assert.equal(
      result.totals.spentUsd,
      5,
      "only this org's internal coding events count",
    );

    // NEGATIVE CONTROL: replay what a rollup with NO internal filter would total.
    const unfiltered = events
      .filter((e) => e.organizationId === ORG)
      .reduce((sum, e) => sum + (e.usageCost ?? 0), 0);
    assert.equal(unfiltered, 1005);
    assert.notEqual(
      result.totals.spentUsd,
      unfiltered,
      "the internal filter is doing real work: without it the customer event leaks in",
    );
    assert.ok(
      !CCC_AGENT_CODES.includes("customer-billing-agent" as never),
      "the control event's agentCode is genuinely outside the internal set",
    );
  }

  // 6. DRILL: (commit, teammate) rows, and totals that equal the branch's row.
  {
    const events = [
      internal(1, git("acme/api", "feature", "aaa1111"), "alice@example.com"),
      internal(2, git("acme/api", "feature", "aaa1111"), "alice@example.com"),
      internal(4, git("acme/api", "feature", "bbb2222"), "bob@example.com"),
      internal(8, git("acme/api", "feature"), "alice@example.com"),
      internal(16, git("acme/api", "main", "ccc3333"), "alice@example.com"),
    ];
    const drill = await computeSpendBreakdownDrill(
      stubClient(events),
      ORG,
      { period: "month", branchKey: "acme/api#feature" },
      NOW,
    );
    assert.deepEqual(
      drill.rows,
      [
        {
          commitSha: null,
          member: "alice@example.com",
          spentUsd: 8,
          eventCount: 1,
          unpricedEventCount: 0,
        },
        {
          commitSha: "bbb2222",
          member: "bob@example.com",
          spentUsd: 4,
          eventCount: 1,
          unpricedEventCount: 0,
        },
        {
          commitSha: "aaa1111",
          member: "alice@example.com",
          spentUsd: 3,
          eventCount: 2,
          unpricedEventCount: 0,
        },
      ],
      "one row per (commit, teammate); a missing sha keeps its own row",
    );
    assert.equal(drill.branchKey, "acme/api#feature");

    const breakdown = await computeSpendBreakdown(
      stubClient(events),
      ORG,
      { period: "month", dimension: "branch" },
      NOW,
    );
    const branchRow = breakdown.rows.find((r) => r.key === "acme/api#feature");
    assert.deepEqual(
      drill.totals,
      {
        spentUsd: branchRow?.spentUsd,
        eventCount: branchRow?.eventCount,
        unpricedEventCount: branchRow?.unpricedEventCount,
      },
      "the drill's totals equal the branch's own breakdown row",
    );
    assert.equal(
      drill.totals.spentUsd,
      15,
      "and the other branch never bleeds in",
    );
  }

  // 6b. Drill honesty: an unpriced (commit, teammate) bucket stays null, and an
  // event with no customerExternalId keeps a row under member ''.
  {
    const drill = await computeSpendBreakdownDrill(
      stubClient([
        internal(null, git("acme/api", "feature", "aaa1111"), null),
        internal(null, git("acme/api", "feature", "aaa1111"), null),
      ]),
      ORG,
      { period: "month", branchKey: "acme/api#feature" },
      NOW,
    );
    assert.deepEqual(drill.rows, [
      {
        commitSha: "aaa1111",
        member: "",
        spentUsd: null,
        eventCount: 2,
        unpricedEventCount: 2,
      },
    ]);
    assert.deepEqual(drill.totals, {
      spentUsd: null,
      eventCount: 2,
      unpricedEventCount: 2,
    });
  }

  // 6c. A branch nobody worked in drills to an empty, honest result.
  {
    const drill = await computeSpendBreakdownDrill(
      stubClient([internal(3, git("acme/api", "main", "ccc3333"))]),
      ORG,
      { period: "month", branchKey: "acme/api#no-such-branch" },
      NOW,
    );
    assert.deepEqual(drill.rows, []);
    assert.deepEqual(drill.totals, {
      spentUsd: null,
      eventCount: 0,
      unpricedEventCount: 0,
    });
  }

  console.log("spend-breakdown.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
