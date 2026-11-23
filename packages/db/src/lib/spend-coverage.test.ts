/**
 * spend-coverage: the ONE coverage-math path, per tool. Runs under tsx in <1s
 * against an in-memory client stub
 * (packages/db src test convention — standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/spend-coverage.test.ts
 *
 * WHY load-bearing: this is the single source both the dashboard tab
 * and api-nest's GET /v1/control/coverage read from, so they can't drift. The
 * things it must get right, each proven with a failure-capable assertion:
 *   1. The blended total/armed keep their values across both tools.
 *   2. A stamp from a meter with no Codex answer counts for Claude and
 *      NEVER for Codex. Absence of evidence is not evidence of arming.
 *   3. Weakest evidence wins per developer, and the fold is order-independent.
 *   4. INTERNAL scope only — an org's customer-billing events (a different
 *      agentCode) must NOT inflate any count. The NEGATIVE CONTROL replays the
 *      "no internal filter" behavior and shows it over-counts.
 * Plus honest-null asOf when the window is empty.
 */

import assert from "node:assert/strict";

import {
  getSpendCoverage,
  claudeVerdictForEvent,
  codexVerdictForEvent,
  foldDeveloperVerdicts,
  type CoverageQueryClient,
  type ToolArmedVerdict,
} from "./spend-coverage";

interface StubEvent {
  organizationId: string;
  customerExternalId: string;
  usageDate: Date;
  agentCode: string;
  signalName?: string;
  /** signal_events.signalId is nullable, so the real read can return `signals: null`. */
  unlinkedSignal?: boolean;
  metadata?: Record<string, unknown>;
}

const ORG = "org-uuid";
const NOW = new Date("2026-07-22T12:00:00.000Z");
const IN_WINDOW = new Date("2026-07-20T09:00:00.000Z"); // 2 days ago
const OLD = new Date("2026-07-01T00:00:00.000Z"); // outside the 7-day window

// The stamp a current meter writes on a Codex record it could vouch for.
const CODEX_ARMED = {
  controlStampVersion: 2,
  codexControlState: "armed",
  codexControlArmed: true,
};
const CODEX_OFF = {
  controlStampVersion: 2,
  codexControlState: "needs-re-trust",
  codexControlArmed: false,
};
// What a meter from 0.11.0 or earlier wrote on a Codex record: nothing about Codex.
const CODEX_LEGACY = { source: "codex", sessionId: "s1" };

// Turn signal names default per agentCode so fixtures stay readable.
function turnSignal(agentCode: string): string {
  return agentCode === "codex" ? "codex-turn" : "claude-code-turn";
}

/**
 * A stub client that honors exactly the where-fragments getSpendCoverage builds:
 * organizationId, usageDate.gte, the agents.agentCode.in internal filter, the
 * per-tool agents.agentCode filter, and (for the blended armed query)
 * metadata.controlArmed === true. distinct + _max are modeled the way Prisma
 * resolves them.
 *
 * The per-tool read returns the name NESTED under `signals`, mirroring the real
 * relation. Flattening it here would let the stub answer a question the
 * database would not.
 */
function buildStub(events: StubEvent[]): CoverageQueryClient {
  const matches = (e: StubEvent, where: any): boolean => {
    if (where.organizationId && e.organizationId !== where.organizationId)
      return false;
    if (where.usageDate?.gte && e.usageDate < where.usageDate.gte) return false;
    if (
      where.agents?.agentCode?.in &&
      !where.agents.agentCode.in.includes(e.agentCode)
    )
      return false;
    if (
      typeof where.agents?.agentCode === "string" &&
      e.agentCode !== where.agents.agentCode
    )
      return false;
    if (
      where.metadata?.path?.[0] === "controlArmed" &&
      where.metadata.equals === true
    ) {
      if (e.metadata?.controlArmed !== true) return false;
    }
    return true;
  };
  return {
    signal_events: {
      findMany: async (args: any) => {
        const hit = events.filter((e) => matches(e, args.where));
        if (!args.distinct) {
          // Honors `select`, so the stub answers ONLY what it was asked. A stub
          // that volunteers a field cannot fail when the query stops requesting
          // it, and the tripwire below would guard nothing.
          return hit.map((e) => ({
            customerExternalId: e.customerExternalId,
            ...(args.select?.signals
              ? {
                  signals: e.unlinkedSignal
                    ? null
                    : { name: e.signalName ?? turnSignal(e.agentCode) },
                }
              : {}),
            ...(args.select?.metadata ? { metadata: e.metadata ?? {} } : {}),
          }));
        }
        // distinct: ['customerExternalId']
        const seen = new Set<string>();
        const rows: Array<{ customerExternalId: string }> = [];
        for (const e of hit) {
          if (!seen.has(e.customerExternalId)) {
            seen.add(e.customerExternalId);
            rows.push({ customerExternalId: e.customerExternalId });
          }
        }
        return rows;
      },
      aggregate: async (args: any) => {
        const hit = events.filter((e) => matches(e, args.where));
        const max = hit.reduce<Date | null>(
          (acc, e) => (acc === null || e.usageDate > acc ? e.usageDate : acc),
          null,
        );
        return { _max: { usageDate: max } };
      },
    },
  };
}

function ev(
  customerExternalId: string,
  agentCode: string,
  metadata?: Record<string, unknown>,
  over: Partial<StubEvent> = {},
): StubEvent {
  return {
    organizationId: ORG,
    customerExternalId,
    usageDate: IN_WINDOW,
    agentCode,
    metadata,
    ...over,
  };
}

// ─── The roster + armed counts, internal scope only ─────────────────────────

const events: StubEvent[] = [
  // 3 distinct internal devs in-window: a (armed), b (armed), c (not armed).
  ev("a@co.example", "claude-code", { controlArmed: true }),
  ev("a@co.example", "claude-code", { controlArmed: true }, { usageDate: NOW }),
  ev("b@co.example", "codex", { controlArmed: true }),
  ev("c@co.example", "claude-code"),
  // Out-of-window dev: excluded from both counts.
  ev("d@co.example", "claude-code", { controlArmed: true }, { usageDate: OLD }),
  // Customer-billing usage (a different agentCode) — must NEVER count toward the
  // internal roster or armed number, even though it is in-window.
  ev(
    "big-customer",
    "customer-support-bot",
    { controlArmed: true },
    { usageDate: NOW },
  ),
];

async function main() {
  // ─── The FROZEN blended counts, internal scope only ───────────────────────
  {
    const coverage = await getSpendCoverage(buildStub(events), ORG, NOW);
    assert.equal(
      coverage.total,
      3,
      "roster = a,b,c (internal, in-window); d is old, customer-bot excluded",
    );
    assert.equal(
      coverage.armed,
      2,
      "armed = a,b (controlArmed:true); c is unarmed",
    );
    assert.deepEqual(
      coverage.rosterEmails,
      ["a@co.example", "b@co.example", "c@co.example"],
      "rosterEmails are the sorted distinct internal devs in-window",
    );
    assert.equal(
      coverage.asOfMs,
      NOW.getTime(),
      "asOf is the newest internal in-window event time",
    );
    // The per-tool queries pin agentCode to one cost-meter code, which is STRICTLY
    // narrower than the internal filter — so a customer-billing event can't reach
    // a per-tool denominator either. 'big-customer' is in-window and carries
    // controlArmed:true, and appears in neither.
    assert.equal(coverage.claudeCode.total, 2, "a@co.example and c@co.example");
    assert.equal(coverage.codex.total, 1, "b@co.example");
    assert.equal(
      coverage.claudeCode.total + coverage.codex.total,
      3,
      "the customer's usage is invisible to both tool lines",
    );
  }

  // ─── NEGATIVE CONTROL — proves the internal filter is load-bearing ────────
  // Count the roster WITHOUT the internal filter (customer-bot leaks in). If the
  // helper ever dropped cccInternalEventFilter, total would be 4, not 3 — this
  // shows the assertion above can distinguish the two.
  {
    const leakyTotal = new Set(
      events
        .filter(
          (e) =>
            e.organizationId === ORG &&
            e.usageDate >= new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
        )
        .map((e) => e.customerExternalId),
    ).size;
    assert.equal(
      leakyTotal,
      4,
      "NEGATIVE CONTROL: without the internal filter the customer 'big-customer' leaks in (4, not 3) — the exact over-count cccInternalEventFilter closes",
    );
  }

  // ─── Honest-null asOf on an empty window ──────────────────────────────────
  {
    const coverage = await getSpendCoverage(buildStub([]), ORG, NOW);
    assert.equal(coverage.total, 0);
    assert.equal(coverage.armed, 0);
    assert.equal(
      coverage.asOfMs,
      null,
      "no events in window -> asOf is null, never a fabricated time",
    );
    assert.deepEqual(coverage.rosterEmails, []);
    assert.deepEqual(coverage.claudeCode, {
      armed: 0,
      notArmed: 0,
      unknown: 0,
      total: 0,
    });
    assert.deepEqual(coverage.codex, {
      armed: 0,
      notArmed: 0,
      unknown: 0,
      total: 0,
    });
  }

  // ═══ An unversioned stamp never inflates Codex ═════════════════

  // "a Codex event from an older meter, with controlArmed:true and no controlStampVersion counts
  //  UNKNOWN for Codex, never armed"
  // If this ever goes green while asserting armed === 1, the Codex count has
  // fallen back to the blended read the per-tool split exists to prevent.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("legacy@co.example", "codex", {
          ...CODEX_LEGACY,
          controlArmed: true,
        }),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.codex.armed,
      0,
      "an unversioned Codex stamp is NEVER armed",
    );
    assert.equal(coverage.codex.unknown, 1, "it lands in unknown");
    assert.equal(
      coverage.codex.notArmed,
      0,
      "and not in the proven-gap bucket either",
    );
  }

  // "the same unversioned stamp on a claude-code event counts ARMED for Claude"
  // The other half of the rule: the unversioned receipt genuinely does mean the Claude
  // hook exists, so it counts there, on every version of the meter ever shipped.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("legacy@co.example", "claude-code", { controlArmed: true }),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.claudeCode.armed,
      1,
      "the unversioned stamp DOES count for Claude",
    );
    assert.equal(coverage.claudeCode.unknown, 0);
  }

  // "a new-CLI Codex 'off' is told apart from an older meter's Codex event"
  // The exact distinction the rule turns on: one integer being present.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("provenoff@co.example", "codex", CODEX_OFF),
        ev("legacy@co.example", "codex", CODEX_LEGACY),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.codex.notArmed,
      1,
      "the current meter's 'no' is a proven gap",
    );
    assert.equal(coverage.codex.unknown, 1, "the old meter's silence is not");
    assert.equal(coverage.codex.total, 2);
  }

  // "controlStampVersion is checked before codexControlArmed"
  // Negative control against a builder reordering the verdict branches: a forged or
  // malformed old record carrying a stray codexControlArmed:true must not count.
  assert.equal(
    codexVerdictForEvent({ codexControlArmed: true }),
    "unknown",
    "the version key is read FIRST, so a stray boolean can't claim armed",
  );
  assert.equal(
    codexVerdictForEvent({ controlStampVersion: 1, codexControlArmed: true }),
    "unknown",
    "a version we don't recognise is also unknown",
  );

  // "the Codex verdict never reads metadata.controlArmed"
  assert.equal(
    codexVerdictForEvent({ controlStampVersion: 2, controlArmed: true }),
    "unknown",
    "controlArmed is the Claude receipt and says nothing about Codex",
  );

  // "an org with only unversioned stamps reads zero armed and all unknown for Codex"
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("x@co.example", "codex", CODEX_LEGACY),
        ev("y@co.example", "codex", CODEX_LEGACY),
        ev("z@co.example", "codex", { ...CODEX_LEGACY, controlArmed: true }),
      ]),
      ORG,
      NOW,
    );
    assert.equal(coverage.codex.armed, 0);
    assert.equal(coverage.codex.total, 3);
    assert.equal(
      coverage.codex.unknown,
      coverage.codex.total,
      "an org where every machine runs an old meter reads as entirely unvouched, never as clean",
    );
  }

  // ═══ Server half: only a proven trust answer reads as armed ═══
  {
    const coverage = await getSpendCoverage(
      buildStub([ev("trusted@co.example", "codex", CODEX_ARMED)]),
      ORG,
      NOW,
    );
    assert.equal(coverage.codex.armed, 1);
    assert.equal(coverage.codex.unknown, 0);
  }
  assert.equal(
    codexVerdictForEvent({
      controlStampVersion: 2,
      codexControlState: "unknown",
    }),
    "unknown",
    "a current meter that couldn't get an answer is unknown, not armed and not a proven gap",
  );

  // ═══ The counting rule: weakest evidence wins ═════════════════════════════

  const fold = (verdicts: Array<[string, ToolArmedVerdict]>) =>
    foldDeveloperVerdicts(
      verdicts.map(([customerExternalId, verdict]) => ({
        customerExternalId,
        verdict,
      })),
    );

  // "one armed machine and one unarmed machine counts not-armed"
  assert.equal(
    fold([
      ["a", "armed"],
      ["a", "not-armed"],
    ]).get("a"),
    "not-armed",
    "a developer is only as covered as their weakest machine",
  );

  // "one armed machine and one unknown machine counts unknown, not armed"
  assert.equal(
    fold([
      ["a", "armed"],
      ["a", "unknown"],
    ]).get("a"),
    "unknown",
    "a machine we can't read is not a covered machine",
  );

  // "a proven gap outranks an unknown"
  assert.equal(
    fold([
      ["a", "unknown"],
      ["a", "armed"],
      ["a", "not-armed"],
    ]).get("a"),
    "not-armed",
    "a proven gap is actionable and should be reported as one",
  );

  // "the fold is independent of event order" — proves it is not newest-wins.
  {
    const rows: Array<[string, ToolArmedVerdict]> = [
      ["a", "armed"],
      ["a", "unknown"],
      ["a", "not-armed"],
      ["b", "armed"],
      ["b", "armed"],
      ["c", "unknown"],
      ["c", "armed"],
    ];
    const forward = Object.fromEntries(fold(rows));
    const backward = Object.fromEntries(fold([...rows].reverse()));
    assert.deepEqual(
      backward,
      forward,
      "the fold is commutative, so ingestion order can never change the answer",
    );
    assert.deepEqual(forward, { a: "not-armed", b: "armed", c: "unknown" });
  }

  // "if the rule were any-event-armed this fixture would read 3 armed, and it reads 1"
  {
    const rows: Array<[string, ToolArmedVerdict]> = [
      ["a", "armed"],
      ["a", "not-armed"],
      ["b", "armed"],
      ["b", "unknown"],
      ["c", "armed"],
    ];
    const anyEventArmed = new Set(
      rows.filter(([, v]) => v === "armed").map(([dev]) => dev),
    ).size;
    assert.equal(
      anyEventArmed,
      3,
      "NEGATIVE CONTROL: the rejected 'any event armed' rule would call all three covered",
    );
    const weakestWins = [...fold(rows).values()].filter(
      (v) => v === "armed",
    ).length;
    assert.equal(
      weakestWins,
      1,
      "weakest-wins calls only c covered — the rule cannot overstate protection",
    );
  }

  // "a Claude TURN is never 'we can't tell'"
  // The Claude check is a file that either exists or doesn't, on every meter version,
  // so there has never been a Claude turn we couldn't get an answer about. This is an
  // invariant about EVENTS, not developers — see the turn-less case below, where a
  // developer with no Claude turn at all is unknown for the honest reason.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("a@co.example", "claude-code", { controlArmed: true }),
        ev("b@co.example", "claude-code"),
        ev("c@co.example", "claude-code", { source: "whatever" }),
        ev("d@co.example", "claude-code", { controlStampVersion: 2 }),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.claudeCode.unknown,
      0,
      "every one of these devs has a turn, so none of them is 'we can't tell'",
    );
    assert.equal(coverage.claudeCode.armed, 1);
    assert.equal(coverage.claudeCode.notArmed, 3);
    assert.equal(claudeVerdictForEvent(null), "not-armed");
    for (const metadata of [
      null,
      undefined,
      {},
      { controlArmed: false },
      { controlStampVersion: 2 },
    ]) {
      assert.notEqual(
        claudeVerdictForEvent(metadata),
        "unknown",
        "no Claude TURN metadata can produce 'unknown'",
      );
    }
  }

  // ═══ Tool-call records carry no stamp and must not drag anyone down ═══════
  // The same daemon writes "claude-code-tool" / "codex-tool" records under the same
  // agentCode, and those have never carried a cap stamp. Counting them as verdicts
  // under a weakest-wins rule would read every armed developer in the org as unarmed.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("a@co.example", "claude-code", { controlArmed: true }),
        ev(
          "a@co.example",
          "claude-code",
          { source: "tool" },
          { signalName: "claude-code-tool" },
        ),
        ev("b@co.example", "codex", CODEX_ARMED),
        ev(
          "b@co.example",
          "codex",
          { source: "tool" },
          { signalName: "codex-tool" },
        ),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.claudeCode.armed,
      1,
      "a tool-call record can't read as a machine without the cap — it never carried the stamp",
    );
    assert.equal(coverage.claudeCode.notArmed, 0);
    assert.equal(coverage.codex.armed, 1);
    assert.equal(coverage.codex.unknown, 0);
  }

  // ═══ A developer with NO turn record is unknown, never absent ═════════════
  // The overstating direction, and the one a signalName filter in the QUERY would
  // have taken: a developer whose only in-window rows are tool calls would vanish
  // from the per-tool count entirely, shrinking the denominator and raising the
  // fraction. They used the tool; we just have no cap evidence about them.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("armed@co.example", "codex", CODEX_ARMED),
        ev(
          "toolonly@co.example",
          "codex",
          { source: "tool" },
          { signalName: "codex-tool" },
        ),
        ev(
          "toolonly2@co.example",
          "claude-code",
          { source: "tool" },
          { signalName: "claude-code-tool" },
        ),
      ]),
      ORG,
      NOW,
    );
    assert.equal(coverage.codex.total, 2, "the tool-only dev stays counted");
    assert.equal(coverage.codex.armed, 1);
    assert.equal(coverage.codex.unknown, 1, "and lands in 'we can't tell'");
    assert.equal(
      coverage.claudeCode.unknown,
      1,
      "the same rule on the Claude side: no turn, no verdict, so unknown",
    );
    assert.equal(coverage.claudeCode.total, 1);
    // NEGATIVE CONTROL: filtering to turns in the query instead would
    // report Codex as 1 of 1 — a perfect score, on an org where half the machines
    // were never checked.
    assert.notEqual(
      coverage.codex.armed / coverage.codex.total,
      1,
      "NEGATIVE CONTROL: dropping turn-less devs would read as 1 of 1",
    );
  }

  // ═══ Every developer on the roster appears in at least one tool line ══════
  // The tab renders rosterEmails as chips directly under the two tool lines. If the
  // per-tool denominators were narrower than the roster, a reader would see a name
  // in the chip list that neither line accounts for, with nothing on screen saying
  // why. The union of the two per-tool developer sets is exactly the roster.
  {
    const mixed: StubEvent[] = [
      ev("turn@co.example", "claude-code", { controlArmed: true }),
      ev(
        "tool@co.example",
        "claude-code",
        { source: "tool" },
        { signalName: "claude-code-tool" },
      ),
      ev("cx@co.example", "codex", CODEX_LEGACY),
      ev(
        "cxtool@co.example",
        "codex",
        { source: "tool" },
        { signalName: "codex-tool" },
      ),
      ev("both@co.example", "claude-code", { controlArmed: true }),
      ev("both@co.example", "codex", CODEX_ARMED),
    ];
    const coverage = await getSpendCoverage(buildStub(mixed), ORG, NOW);
    assert.equal(coverage.rosterEmails.length, 5);
    assert.equal(
      coverage.claudeCode.total + coverage.codex.total,
      6,
      "both@co.example is counted once per tool, so the per-tool totals over-count the roster by exactly the both-tools users — never under-count it",
    );
    assert.ok(
      coverage.claudeCode.total + coverage.codex.total >=
        coverage.rosterEmails.length,
      "no one on the roster is missing from both tool lines",
    );
  }

  // ═══ The no-identity placeholder can never be called covered ══════════════
  // Every machine that surfaced no developer email bills under ONE placeholder id,
  // so that single row can stand for twenty CI runners. "Every machine we've seen
  // has the cap check running" is not a promise one collapsed row can make.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("real@co.example", "codex", CODEX_ARMED),
        ev("codex-no-identity", "codex", CODEX_ARMED),
        ev("claude-code-no-identity", "claude-code", { controlArmed: true }),
      ]),
      ORG,
      NOW,
    );
    assert.equal(
      coverage.codex.armed,
      1,
      "only the identified developer counts as covered",
    );
    assert.equal(
      coverage.codex.unknown,
      1,
      "the collapsed placeholder row degrades to 'we can't tell'",
    );
    assert.equal(coverage.codex.total, 2, "it still counts as usage we saw");
    assert.equal(coverage.claudeCode.armed, 0);
    assert.equal(coverage.claudeCode.unknown, 1);
  }

  // A PROVEN gap on a placeholder row is still a proven gap: the downgrade only
  // ever moves a row OUT of armed, never out of not-armed into something softer.
  {
    const coverage = await getSpendCoverage(
      buildStub([ev("codex-no-identity", "codex", CODEX_OFF)]),
      ORG,
      NOW,
    );
    assert.equal(coverage.codex.notArmed, 1);
    assert.equal(coverage.codex.unknown, 0);
  }

  // ═══ The two denominators don't add up, on purpose ════════════════════════
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("both@co.example", "claude-code", { controlArmed: true }),
        ev("both@co.example", "codex", CODEX_ARMED),
      ]),
      ORG,
      NOW,
    );
    assert.equal(coverage.claudeCode.total, 1);
    assert.equal(coverage.codex.total, 1);
    assert.equal(
      coverage.total,
      1,
      "one person using both tools is one person in the blended roster and one in each per-tool count — the per-tool totals are not meant to sum to it",
    );
  }

  // ═══ the turn name survives the join ═══════════════════════════
  // Dropping the name from the select would still load the page and still pass
  // every other assertion here, with every developer silently reading unknown.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev("armed@co.example", "claude-code", { controlArmed: true }),
        ev("armed@co.example", "codex", CODEX_ARMED),
      ]),
      ORG,
      NOW,
    );
    assert.deepEqual(
      { ...coverage.claudeCode },
      { armed: 1, notArmed: 0, unknown: 0, total: 1 },
      "a developer with an armed Claude turn must read ARMED — unknown here means the joined signal name never reached the verdict fold",
    );
    assert.deepEqual(
      { ...coverage.codex },
      { armed: 1, notArmed: 0, unknown: 0, total: 1 },
      "a developer with an armed Codex turn must read ARMED — unknown here means the joined signal name never reached the verdict fold",
    );
  }

  // ═══ an event with no signal row to join is unknown ════════════
  // signal_events.signalId is nullable, so `signals` can come back null.
  {
    const coverage = await getSpendCoverage(
      buildStub([
        ev(
          "orphan@co.example",
          "claude-code",
          { controlArmed: true },
          { unlinkedSignal: true },
        ),
      ]),
      ORG,
      NOW,
    );
    assert.deepEqual(
      { ...coverage.claudeCode },
      { armed: 0, notArmed: 0, unknown: 1, total: 1 },
      "an armed stamp on an event with no linked signal is still unknown: we cannot prove it was a coding turn",
    );
  }

  console.log("spend-coverage.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
