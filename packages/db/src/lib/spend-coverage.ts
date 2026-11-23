/**
 * spend-coverage.ts: the ONE
 * coverage-math path.
 *
 * "Coverage" is the "N of M developers have the cap running" read the Spend Controls
 * tab shows. It is TWO reads, one per tool, because Claude Code and Codex are armed
 * by different mechanisms and a blended number would let a team believe Codex was
 * covered when nothing about Codex had ever been checked:
 *   - claudeCode / codex = armed / notArmed / unknown / total, each counting distinct
 *                          developers who used THAT tool in the trailing 7 days.
 *   - armed / total      = the blended counts across both tools, kept on the
 *                          response for clients that read one number. The two
 *                          per-tool objects are the precise read.
 *   - asOfMs             = the newest event time in the window, for the freshness
 *                          label; null when there is no recent activity (honest
 *                          absence, never a fake time).
 *
 * WHY this lives here: the dashboard action and api-nest's programmatic
 * coverage read (GET /v1/control/coverage) must return the SAME numbers, so the
 * queries live here once and both call this.
 *
 * Scope: internal coding-agent events only, via the shared cccInternalEventFilter
 * — an org's customer-billing events ride the same signal_events table and must
 * never count toward coverage (the same trust line the spend read-back holds).
 */

import type { Prisma } from "@prisma/client";

import {
  cccInternalEventFilter,
  cccToolFilter,
  CCC_NO_IDENTITY_CUSTOMER_IDS,
  CCC_TURN_SIGNAL_NAMES,
  type CccAgentCode,
} from "./cap-policy";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The stamp version a Codex record must carry before anything it says about arming
 * is believed. Mirrored from packages/code-cost-clarity/src/control.ts, not imported
 * — that package is customer-installed and must never depend on @marginfront/db.
 */
export const CODEX_CONTROL_STAMP_VERSION = 2;

/** What we can say about one developer and one tool. Three answers, not two. */
export type ToolArmedVerdict = "armed" | "not-armed" | "unknown";

/**
 * The tiny slice of a Prisma client this read touches. Deliberately structural
 * (a "Prisma-like client arg") so BOTH callers pass their own client
 * with no cast: the dashboard's client and api-nest's PrismaService both
 * satisfy it. Args are
 * left open here — the query shapes below are what's type-checked; the concrete
 * delegates accept a superset.
 */
export interface CoverageQueryClient {
  signal_events: {
    // Foot-gun: method syntax + open args are load-bearing. Narrowing to arrow
    // props or literal arg/return types breaks assignability for one of the two
    // concrete clients — the helper reads the wide `_max` shape defensively.
    findMany(args?: unknown): Promise<
      Array<{
        customerExternalId: string;
        signals?: { name: string } | null;
        metadata?: unknown;
      }>
    >;
    aggregate(
      args?: unknown,
    ): Promise<{ _max?: { usageDate?: Date | null } | null }>;
  };
}

export interface ToolCoverage {
  /** Developers whose every seen machine for this tool has the cap check running. */
  armed: number;
  /** Developers with at least one machine we PROVED is not running the cap check. */
  notArmed: number;
  /** Developers we cannot vouch for: an old meter, a check that didn't answer, or
   *  no turn record at all to read a verdict off. */
  unknown: number;
  /** armed + notArmed + unknown. Distinct developers who used this tool in the window. */
  total: number;
}

export interface SpendCoverageCounts {
  /** FROZEN blended semantics. Distinct developers with metadata.controlArmed === true
   *  on any internal event in the window. In practice this is Claude-hook presence,
   *  because that key only ever lands on claude-code records. claudeCode / codex
   *  carry the per-tool counts. */
  armed: number;
  /** FROZEN blended semantics. Distinct developers with any internal event in the
   *  window, across BOTH tools. NOT the sum of claudeCode.total and codex.total. */
  total: number;
  /** Newest event time in the window (epoch ms), or null when the window is empty. */
  asOfMs: number | null;
  /** The distinct developer emails seen in the window, sorted — the dev-target
   * roster the dashboard prefills its picker with. */
  rosterEmails: string[];
  claudeCode: ToolCoverage;
  codex: ToolCoverage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Claude Code, per TURN event. NEVER returns "unknown": the device check behind
 * this stamp is a file that either exists or doesn't, on every meter version ever
 * shipped, so there has never been a Claude TURN we couldn't read. That invariant
 * is why a Claude event needs no stamp version.
 *
 * It is an invariant about EVENTS, not about developers. `claudeCode.unknown` can
 * still be non-zero, because a developer with no turn record at all has no event
 * for this function to read (see tallyToolCoverage).
 */
export function claudeVerdictForEvent(metadata: unknown): ToolArmedVerdict {
  return isRecord(metadata) && metadata.controlArmed === true
    ? "armed"
    : "not-armed";
}

/**
 * Codex, per event. THE ORDER OF THESE CHECKS MUST NOT BE REARRANGED: the version
 * key is read FIRST, so a record from a meter that had no Codex answer can never
 * reach the armed or the not-armed bucket, whatever other keys it carries.
 *
 * metadata.controlArmed is never read here, in any branch — it is the Claude
 * receipt, and it means only that the Claude hook exists.
 */
export function codexVerdictForEvent(metadata: unknown): ToolArmedVerdict {
  if (!isRecord(metadata)) return "unknown";
  if (metadata.controlStampVersion !== CODEX_CONTROL_STAMP_VERSION) {
    return "unknown";
  }
  if (metadata.codexControlArmed === true) return "armed";
  if (metadata.codexControlArmed === false) return "not-armed";
  return "unknown";
}

// Weakest evidence wins: a safety claim is only as strong as the weakest machine
// the person codes from, so an armed laptop plus an unarmed desktop is not covered.
// Taking the minimum also makes the fold commutative, which "newest event wins"
// could not promise — the answer can't shift with ingestion order.
const VERDICT_STRENGTH: Record<ToolArmedVerdict, number> = {
  "not-armed": 0,
  unknown: 1,
  armed: 2,
};

export function foldDeveloperVerdicts(
  events: ReadonlyArray<{
    customerExternalId: string;
    verdict: ToolArmedVerdict;
  }>,
): Map<string, ToolArmedVerdict> {
  const byDeveloper = new Map<string, ToolArmedVerdict>();
  for (const event of events) {
    const soFar = byDeveloper.get(event.customerExternalId);
    if (
      soFar === undefined ||
      VERDICT_STRENGTH[event.verdict] < VERDICT_STRENGTH[soFar]
    ) {
      byDeveloper.set(event.customerExternalId, event.verdict);
    }
  }
  return byDeveloper;
}

export interface ToolCoverageRow {
  customerExternalId: string;
  signalName?: string | null;
  metadata?: unknown;
}

/**
 * signal_events has no name column: it lives on the joined `signals` row.
 *
 * `satisfies` is load-bearing. CoverageQueryClient keeps its args `unknown` to stay
 * structural, so this literal is the only thing that fails the build on a field the
 * model doesn't have.
 */
const PER_TOOL_SELECT = {
  customerExternalId: true,
  signals: { select: { name: true } },
  metadata: true,
} satisfies Prisma.signal_eventsSelect;

/**
 * One tool's rows -> one tool's four numbers. Three rules, each there to stop the
 * fraction reading higher than the evidence supports:
 *
 * 1. TURNS DECIDE, EVERY ROW COUNTS. Only turns carry a stamp, so only they produce
 *    a verdict — but a developer with tool-call rows and no turn rows is `unknown`,
 *    not absent. Dropping them would shrink the denominator and raise the fraction.
 * 2. WEAKEST WINS, via foldDeveloperVerdicts.
 * 3. THE NO-IDENTITY ROW CANNOT BE ARMED. It stands for an unknown number of
 *    machines under one id, so armed degrades to unknown. Not-armed survives.
 */
function tallyToolCoverage(
  rows: ReadonlyArray<ToolCoverageRow>,
  turnSignalName: string,
  verdictFor: (metadata: unknown) => ToolArmedVerdict,
): ToolCoverage {
  const byDeveloper = foldDeveloperVerdicts(
    rows
      .filter((row) => row.signalName === turnSignalName)
      .map((row) => ({
        customerExternalId: row.customerExternalId,
        verdict: verdictFor(row.metadata),
      })),
  );
  for (const row of rows) {
    if (!byDeveloper.has(row.customerExternalId)) {
      byDeveloper.set(row.customerExternalId, "unknown");
    }
  }

  const counts: ToolCoverage = { armed: 0, notArmed: 0, unknown: 0, total: 0 };
  for (const [customerExternalId, verdict] of byDeveloper) {
    const standsForManyMachines =
      CCC_NO_IDENTITY_CUSTOMER_IDS.includes(customerExternalId);
    if (verdict === "armed" && !standsForManyMachines) counts.armed += 1;
    else if (verdict === "not-armed") counts.notArmed += 1;
    else counts.unknown += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Compute coverage over the trailing 7 days from `now`. Window semantics:
 * `usageDate >= now - 7d`, no upper bound.
 */
export async function getSpendCoverage(
  client: CoverageQueryClient,
  orgId: string,
  now: Date = new Date(),
): Promise<SpendCoverageCounts> {
  const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);
  const rosterScope = cccInternalEventFilter();

  // FOOT-GUN: do NOT push the verdict into a Prisma JSON filter. The unknown bucket
  // is defined by a key being ABSENT, and `NOT: { metadata: { path: [...], equals: 2 } }`
  // compiles to a predicate that is NULL for key-absent rows, which EXCLUDES them —
  // every record from an older meter would silently vanish and an all-old org would
  // read as clean. The jsonb key-exists operator that would work has no Prisma
  // surface, and $queryRaw would break the structural client seam. So fold in JS.
  //
  // agentCode ONLY, no signal name: narrowing here would make the denominator smaller
  // than the roster rendered under it, in the overstating direction. The name is read
  // in JS below, where a turn-less developer becomes `unknown` rather than
  // disappearing.
  const perTool = async (
    agentCode: CccAgentCode,
  ): Promise<ToolCoverageRow[]> => {
    const rows = await client.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: sevenDaysAgo },
        ...cccToolFilter(agentCode),
      },
      select: PER_TOOL_SELECT,
    });
    return rows.map((row) => ({
      customerExternalId: row.customerExternalId,
      signalName: row.signals?.name ?? null,
      metadata: row.metadata,
    }));
  };

  const [rosterRows, armedRows, freshest, claudeRows, codexRows] =
    await Promise.all([
      client.signal_events.findMany({
        where: {
          organizationId: orgId,
          usageDate: { gte: sevenDaysAgo },
          ...rosterScope,
        },
        distinct: ["customerExternalId"],
        select: { customerExternalId: true },
      }),
      client.signal_events.findMany({
        where: {
          organizationId: orgId,
          usageDate: { gte: sevenDaysAgo },
          metadata: { path: ["controlArmed"], equals: true },
          ...rosterScope,
        },
        distinct: ["customerExternalId"],
        select: { customerExternalId: true },
      }),
      client.signal_events.aggregate({
        where: {
          organizationId: orgId,
          usageDate: { gte: sevenDaysAgo },
          ...rosterScope,
        },
        _max: { usageDate: true },
      }),
      perTool("claude-code"),
      perTool("codex"),
    ]);

  return {
    armed: armedRows.length,
    total: rosterRows.length,
    asOfMs: freshest._max?.usageDate?.getTime() ?? null,
    rosterEmails: rosterRows.map((r) => r.customerExternalId).sort(),
    claudeCode: tallyToolCoverage(
      claudeRows,
      CCC_TURN_SIGNAL_NAMES["claude-code"],
      claudeVerdictForEvent,
    ),
    codex: tallyToolCoverage(
      codexRows,
      CCC_TURN_SIGNAL_NAMES.codex,
      codexVerdictForEvent,
    ),
  };
}
