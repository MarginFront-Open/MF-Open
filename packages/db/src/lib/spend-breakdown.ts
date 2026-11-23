/**
 * spend-breakdown.ts: the ONE repo/branch
 * coding-spend rollup.
 *
 * Internal coding spend for a period window, rolled up per repo or per branch
 * from the git coordinates the code-cost-clarity meter stamps into
 * signal_events.metadata, plus the
 * (commit, teammate) drill behind one branch row. Branch is the honest stand-in
 * for a pull request: no PR number exists anywhere in the pipeline, so nothing
 * here claims PR grain.
 *
 * Honesty contract (identical across both functions, and the reason the buckets
 * are shaped the way they are):
 *   - spentUsd is null wherever there is no PRICED usage — never a coerced 0.
 *     unpricedEventCount surfaces activity we saw but could not price.
 *   - Events with no repo/branch recorded (meters that send none, non-git
 *     sessions) land in the explicit `noMetadata` bucket, never vanish, and
 *     `coveragePercent` states the tagged share — null when the window has no
 *     events at all (nothing to measure is not 0% tagged).
 *   - In the drill, an event with no commitSha groups under commitSha:null and
 *     an event with no customerExternalId groups under member '' — kept, never
 *     dropped.
 *   - Internal coding-agent events ONLY (cccInternalEventFilter): an org's
 *     customer-billing events share this table and must never count.
 *
 * In-memory rollup, same as the canonical CostMetrics Map path: the window
 * holds one org's internal coding events (hundreds to low thousands), and
 * Prisma groupBy cannot traverse JSON keys anyway.
 */

import type { Prisma } from "@prisma/client";

import { cccInternalEventFilter, currentPeriodWindow } from "./cap-policy";
import type { CapPeriod } from "./cap-policy";
import { gitBranchKey, gitCommitSha, gitRepoKey } from "./git-coordinates";
import { toNumber } from "./revenue-calc";

/**
 * The two grains the platform can honestly serve. There is deliberately no
 * 'pr' value: the pipeline records repo/branch/commitSha, not pull-request
 * numbers.
 */
export type SpendBreakdownDimension = "repo" | "branch";

/**
 * The tiny slice of a Prisma client this read touches. Deliberately structural
 * (the same "Prisma-like client arg" seam spend-coverage.ts uses) so a caller
 * passes its own client with no cast, such as api-nest's PrismaService.
 */
export interface SpendBreakdownQueryClient {
  signal_events: {
    // Foot-gun: method syntax + open args are load-bearing. Narrowing to arrow
    // props or literal arg types breaks assignability for one of the two
    // concrete clients.
    findMany(args?: unknown): Promise<
      Array<{
        usageCost?: unknown;
        metadata?: unknown;
        customerExternalId?: string | null;
      }>
    >;
  };
}

export interface SpendBreakdownBucket {
  /** null = no priced usage in this bucket (honest absence, never $0). */
  spentUsd: number | null;
  eventCount: number;
  unpricedEventCount: number;
}

export interface SpendBreakdownRow extends SpendBreakdownBucket {
  /** 'owner/repo' for the repo dimension; 'owner/repo#branch' for branch. */
  key: string;
}

export interface SpendBreakdownQuery {
  period: CapPeriod;
  dimension: SpendBreakdownDimension;
}

export interface SpendBreakdownResult {
  dimension: SpendBreakdownDimension;
  period: CapPeriod;
  window: { start: string; end: string };
  asOf: string;
  totals: SpendBreakdownBucket;
  rows: SpendBreakdownRow[];
  noMetadata: SpendBreakdownBucket;
  /** Percent of events carrying the repo/branch key; null on an empty window. */
  coveragePercent: number | null;
}

export interface SpendBreakdownDrillQuery {
  period: CapPeriod;
  /** The composite 'owner/repo#branch' key a breakdown branch row is keyed by. */
  branchKey: string;
}

export interface SpendBreakdownDrillRow extends SpendBreakdownBucket {
  commitSha: string | null;
  /** The teammate's customerExternalId (the dev email); '' when none was recorded. */
  member: string;
}

export interface SpendBreakdownDrillResult {
  branchKey: string;
  period: CapPeriod;
  window: { start: string; end: string };
  asOf: string;
  rows: SpendBreakdownDrillRow[];
  totals: SpendBreakdownBucket;
}

/**
 * `satisfies` is load-bearing. SpendBreakdownQueryClient keeps its args
 * `unknown` to stay structural, so these literals are the only thing that fails
 * the build on a field the model does not have.
 */
const BREAKDOWN_SELECT = {
  usageCost: true,
  metadata: true,
} satisfies Prisma.signal_eventsSelect;

const DRILL_SELECT = {
  usageCost: true,
  metadata: true,
  customerExternalId: true,
} satisfies Prisma.signal_eventsSelect;

function emptyBucket(): SpendBreakdownBucket {
  return { spentUsd: null, eventCount: 0, unpricedEventCount: 0 };
}

function addTo(bucket: SpendBreakdownBucket, usageCost: unknown): void {
  bucket.eventCount += 1;
  if (usageCost === null || usageCost === undefined) {
    bucket.unpricedEventCount += 1;
  } else {
    bucket.spentUsd = (bucket.spentUsd ?? 0) + toNumber(usageCost);
  }
}

/**
 * Internal coding spend for the current period window, one row per repo or per
 * branch. See the header for the honesty contract every bucket here upholds.
 */
export async function computeSpendBreakdown(
  client: SpendBreakdownQueryClient,
  organizationId: string,
  query: SpendBreakdownQuery,
  now: Date = new Date(),
): Promise<SpendBreakdownResult> {
  const window = currentPeriodWindow(query.period, now);
  const events = await client.signal_events.findMany({
    where: {
      organizationId,
      usageDate: { gte: window.start, lte: window.end },
      ...cccInternalEventFilter(),
    },
    select: BREAKDOWN_SELECT,
  });

  const keyFor = query.dimension === "repo" ? gitRepoKey : gitBranchKey;
  const keyed = new Map<string, SpendBreakdownBucket>();
  const noMetadata = emptyBucket();
  const totals = emptyBucket();
  for (const ev of events) {
    addTo(totals, ev.usageCost);
    const key = keyFor(ev.metadata);
    if (key === null) {
      addTo(noMetadata, ev.usageCost);
      continue;
    }
    const bucket = keyed.get(key) ?? emptyBucket();
    addTo(bucket, ev.usageCost);
    keyed.set(key, bucket);
  }

  const rows = Array.from(keyed.entries())
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((a, b) => {
      if (a.spentUsd !== b.spentUsd) {
        return (b.spentUsd ?? -1) - (a.spentUsd ?? -1);
      }
      return a.key.localeCompare(b.key);
    });

  const taggedEventCount = totals.eventCount - noMetadata.eventCount;
  return {
    dimension: query.dimension,
    period: query.period,
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    asOf: now.toISOString(),
    totals,
    rows,
    noMetadata,
    coveragePercent:
      totals.eventCount === 0
        ? null
        : (taggedEventCount / totals.eventCount) * 100,
  };
}

/**
 * The drill-down behind ONE branch row of computeSpendBreakdown, split per
 * (commitSha, teammate).
 *
 * The accuracy guarantee: this result's `totals` equal that branch's row in
 * computeSpendBreakdown, because it starts from the exact same event set and
 * the exact same branch-key rule. It never re-prices or re-filters differently.
 */
export async function computeSpendBreakdownDrill(
  client: SpendBreakdownQueryClient,
  organizationId: string,
  query: SpendBreakdownDrillQuery,
  now: Date = new Date(),
): Promise<SpendBreakdownDrillResult> {
  const window = currentPeriodWindow(query.period, now);
  const events = await client.signal_events.findMany({
    where: {
      organizationId,
      usageDate: { gte: window.start, lte: window.end },
      ...cccInternalEventFilter(),
    },
    select: DRILL_SELECT,
  });

  const keyed = new Map<string, SpendBreakdownDrillRow>();
  const totals = emptyBucket();
  for (const ev of events) {
    if (gitBranchKey(ev.metadata) !== query.branchKey) continue;
    addTo(totals, ev.usageCost);
    const commitSha = gitCommitSha(ev.metadata);
    const member = ev.customerExternalId ?? "";
    // Structured key so (null-sha, alice) and (null-sha, bob) stay two rows and
    // no sha/email concatenation can ever collide two distinct buckets.
    const mapKey = JSON.stringify([commitSha, member]);
    const bucket = keyed.get(mapKey) ?? {
      commitSha,
      member,
      ...emptyBucket(),
    };
    addTo(bucket, ev.usageCost);
    keyed.set(mapKey, bucket);
  }

  const rows = Array.from(keyed.values()).sort((a, b) => {
    if (a.spentUsd !== b.spentUsd) {
      return (b.spentUsd ?? -1) - (a.spentUsd ?? -1);
    }
    if (a.member !== b.member) return a.member.localeCompare(b.member);
    return (a.commitSha ?? "").localeCompare(b.commitSha ?? "");
  });

  return {
    branchKey: query.branchKey,
    period: query.period,
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    asOf: now.toISOString(),
    rows,
    totals,
  };
}
