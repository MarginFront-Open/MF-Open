/**
 * getCostBreakdown — SQL GROUP BY twin of getCostMetrics (canon C1, C2, W1).
 *
 * Same predicate as computeCostMetricsForWindow (org + usageDate window +
 * optional customer/agent/signal/subscription filters), but the grouping
 * runs in Postgres so rows returned scale with bucket count, not event
 * count. One dimension per call; the day series always rides along for the
 * chart. Prisma groupBy cannot do this job (no relation traversal, JSON
 * extraction, or date_trunc), hence parameterized $queryRaw + Zod row-parse.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  FinishedThingRowSchema,
  FinishedWorkBucketRowSchema,
  MatterCostRollupSchema,
  NamedUsageRowSchema,
  type BreakdownRow,
  type CostBreakdown,
  type CostBreakdownFinishedWork,
  type Dimension,
  type MatterCostRollup,
} from "../schemas/cost-grouping";
import { CCC_AGENT_CODES } from "./cap-policy";
import type {
  CostByDayRow,
  RevenueFilters,
  RevenueWindow,
} from "../schemas/revenue-metrics";

export const COST_BREAKDOWN_DEFAULT_PAGE_SIZE = 25;

/**
 * Hard server cap on breakdown page size, the ONE home for the 500-row cap.
 * The api-nest row caps must import this const, not redeclare it.
 */
export const ANALYTICS_MAX_ROWS = 500;

/**
 * `agentIds: null` is every agent (what the ROI page passes — its checkboxes
 * re-scope in memory so a click costs no round trip). An EMPTY list is NO
 * agent: the reads are skipped and the lists come back empty.
 */
export interface FinishedWorkScope {
  agentIds: string[] | null;
}

export interface CostBreakdownOptions {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Rows per page. Default 25, clamped to [1, ANALYTICS_MAX_ROWS]. */
  pageSize?: number;
  /** When false, `other` returns null (rollup skipped). Default true. */
  includeOtherRollup?: boolean;
  /**
   * Ask for the finished-work numbers too. Omit it and the result has only the
   * base keys from the same three queries, so every other caller is unaffected.
   */
  finishedWork?: FinishedWorkScope;
}

/**
 * The thing that prices a finished thing at $0 IS the thing that marks it as
 * one, so there is no second field to disagree with the first.
 *
 * Built on call, not at module scope, for the same reason the dimension
 * registry is: the dashboard's jest suites mock '@prisma/client' without the
 * Prisma namespace, so an import-time `Prisma.sql` crashes every test file
 * that merely imports '@marginfront/db'.
 */
const outcomeMarker = () => Prisma.sql`EXISTS (
      SELECT 1 FROM signal_event_services ses
      WHERE ses."signalEventId" = e.id AND lower(ses."modelProvider") = 'outcome'
    )`;

/**
 * '' is a real bucket (no work item), not a missing value. The resolved column
 * wins because matters are also assigned by rule and by operator, and neither
 * leaves a tag in metadata; the tag stays as the fallback for a free-text
 * `code-cost-clarity work` name that resolved to nothing.
 */
const labelKey = () =>
  Prisma.sql`COALESCE(e."matterId"::text, e."metadata" ->> 'matterId', '')`;

/** The casing of the EARLIEST record under a case-folded name. COALESCE'd to
 *  match the GROUP BY: signalId is nullable, and a null name fails
 *  FinishedThingRowSchema, which fails the whole ROI read, not just this table. */
const firstSeenName = () =>
  Prisma.sql`(array_agg(COALESCE(s."name", '') ORDER BY e."createdAt" ASC, e.id ASC))[1]`;

/**
 * A bucket's cost is CODING-TURN spend. It is also the exact
 * complement of namedUsage's exclusion below, which is what stops one dollar
 * landing in the table twice when a customer records a finished thing on the
 * same agent they meter named signals on.
 */
const codingAgent = () => Prisma.sql`EXISTS (
      SELECT 1 FROM agents ca
      WHERE ca.id = e."agentId" AND ca."agentCode" IN (${Prisma.join(
        CCC_AGENT_CODES.map((code) => Prisma.sql`${code}`),
      )})
    )`;

/**
 * Dimension registry — closed enum → hardcoded-SQL-fragment map.
 *
 * SQL-injection safety: the dimension name is only ever a lookup key into
 * this map; user input is never spliced into SQL. Every fragment is a
 * compile-time Prisma.sql literal; window/filter values ride as bound
 * parameters.
 *
 * Built lazily (memoized) rather than at module scope: dashboard jest
 * suites mock '@prisma/client' with factories that omit the Prisma
 * namespace, so evaluating Prisma.sql at import time would crash every
 * test file that merely imports '@marginfront/db'.
 *
 * Extension point: a `metadata:<key>` entry would add
 * `payload/metadata ->> $key` grouping behind the same BreakdownRow shape.
 * Register the new fragment here; nothing else changes.
 */
type DimensionSqlRegistry = Record<
  Dimension,
  { key: Prisma.Sql; join: Prisma.Sql }
>;

let dimensionSqlRegistry: DimensionSqlRegistry | null = null;

function getDimensionSqlRegistry(): DimensionSqlRegistry {
  if (dimensionSqlRegistry) return dimensionSqlRegistry;
  dimensionSqlRegistry = {
    agent: { key: Prisma.sql`e."agentId"::text`, join: Prisma.empty },
    customer: { key: Prisma.sql`e."customerId"::text`, join: Prisma.empty },
    signal: { key: Prisma.sql`e."signalId"::text`, join: Prisma.empty },
    day: {
      // date_trunc('day', tstz AT TIME ZONE 'UTC') hits the same UTC-midnight
      // boundary as the in-memory Math.floor(epochMs / MS_PER_DAY) bucketing
      // (canon W1) — both floor toward -infinity in UTC days.
      key: Prisma.sql`to_char(date_trunc('day', e."usageDate" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
      join: Prisma.empty,
    },
    plan: {
      key: Prisma.sql`sub."planId"::text`,
      join: Prisma.sql`LEFT JOIN subscriptions sub ON sub.id = e."subscriptionId"`,
    },
    model: {
      // Model comes from the ingest payload, NOT signal_event_services.model:
      // service rows are per-SERVICE (one event → many rows), so grouping
      // there fans out eventCount. The jsonb_typeof guard mirrors
      // computeCostMetricsForWindow's typeof === "string" check — a non-string
      // payload.model buckets as null instead of being stringified by ->>.
      key: Prisma.sql`CASE WHEN jsonb_typeof(r.payload -> 'model') = 'string' THEN NULLIF(r.payload ->> 'model', '') END`,
      join: Prisma.sql`INNER JOIN raw_ingest_events r ON r.id = e."rawIngestEventId"`,
    },
    costCategory: {
      key: Prisma.sql`COALESCE(s."costCategory"::text, 'UNCLASSIFIED')`,
      join: Prisma.sql`LEFT JOIN signals s ON s.id = e."signalId"`,
    },
    environment: {
      key: Prisma.sql`e."environment"::text`,
      join: Prisma.empty,
    },
  };
  return dimensionSqlRegistry;
}

const RawTotalsRowSchema = z.object({
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  eventCountWithNullCost: z.number().int().nonnegative(),
  eventCountFinishedWork: z.number().int().nonnegative().optional(),
});

const RawSeriesRowSchema = z.object({
  date: z.date(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
});

const RawBreakdownRowSchema = z.object({
  key: z.string().nullable(),
  cost: z.number(),
  eventCount: z.number().int().nonnegative(),
  eventCountFinishedWork: z.number().int().nonnegative().optional(),
  totalRowCount: z.number().int().nonnegative(),
  isOther: z.boolean(),
});

/**
 * Grouped cost for one dimension over a window, plus window totals and the
 * always-day-grain series. Pagination + "Other" rollup:
 * buckets order by cost DESC, `other` aggregates every bucket not on the
 * returned page, so totals.cost === Σ rows[].cost + (other?.cost ?? 0) holds
 * on every page.
 */
export async function getCostBreakdown(
  db: PrismaClient,
  orgId: string,
  window: RevenueWindow,
  dimension: Dimension,
  filters: RevenueFilters = {},
  opts: CostBreakdownOptions = {},
): Promise<CostBreakdown> {
  const registry = getDimensionSqlRegistry();
  const dimensionSql = registry[dimension];
  if (!dimensionSql) {
    throw new Error(
      `Unknown cost-breakdown dimension "${String(dimension)}". ` +
        `Valid dimensions: ${Object.keys(registry).join(", ")}. ` +
        `New dimensions must be registered in the dimension registry (packages/db/src/lib/cost-grouping.ts).`,
    );
  }

  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const pageSize = Math.min(
    ANALYTICS_MAX_ROWS,
    Math.max(1, Math.trunc(opts.pageSize ?? COST_BREAKDOWN_DEFAULT_PAGE_SIZE)),
  );
  const offset = (page - 1) * pageSize;
  const includeOtherRollup = opts.includeOtherRollup ?? true;

  // ISO strings + explicit ::timestamptz casts keep the window comparison
  // session-timezone-proof (the 'Z' pins the instant), matching how Prisma
  // binds these same Dates on the findMany path.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`e."organizationId" = ${orgId}::uuid`,
    Prisma.sql`e."usageDate" >= ${window.start.toISOString()}::timestamptz`,
    Prisma.sql`e."usageDate" <= ${window.end.toISOString()}::timestamptz`,
  ];
  if (filters.customerId) {
    conditions.push(Prisma.sql`e."customerId" = ${filters.customerId}::uuid`);
  }
  if (filters.agentId) {
    conditions.push(Prisma.sql`e."agentId" = ${filters.agentId}::uuid`);
  }
  if (filters.signalId) {
    conditions.push(Prisma.sql`e."signalId" = ${filters.signalId}::uuid`);
  }
  if (filters.subscriptionId) {
    conditions.push(
      Prisma.sql`e."subscriptionId" = ${filters.subscriptionId}::uuid`,
    );
  }
  const where = Prisma.join(conditions, " AND ");

  const finished = opts.finishedWork;
  const finishedIds = finished?.agentIds ?? null;
  const readFinishedWork = Boolean(finished) && finishedIds?.length !== 0;
  const finishedScope =
    finishedIds === null || finishedIds.length === 0
      ? Prisma.empty
      : Prisma.sql` AND e."agentId" IN (${Prisma.join(
          finishedIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`;

  /** The count the Usage events tile subtracts, under the SAME scope the three
   *  lists honor, or the tile drops by events its own table shows none of. An
   *  empty scope reads no lists, so its count is a flat zero. */
  const finishedCount = readFinishedWork
    ? Prisma.sql`COUNT(*) FILTER (WHERE ${outcomeMarker()}${finishedScope})`
    : Prisma.sql`0`;

  const totalsQuery = Prisma.sql`
    SELECT
      COALESCE(SUM(COALESCE(e."usageCost", 0)), 0)::float8 AS "cost",
      COUNT(*)::int AS "eventCount",
      (COUNT(*) FILTER (WHERE e."usageCost" IS NULL))::int AS "eventCountWithNullCost"${
        finished
          ? Prisma.sql`,
      (${finishedCount})::int AS "eventCountFinishedWork"`
          : Prisma.empty
      }
    FROM signal_events e
    WHERE ${where}
  `;

  const seriesQuery = Prisma.sql`
    SELECT
      date_trunc('day', e."usageDate" AT TIME ZONE 'UTC') AS "date",
      SUM(COALESCE(e."usageCost", 0))::float8 AS "cost",
      COUNT(*)::int AS "eventCount"
    FROM signal_events e
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  // Second UNION branch = the "Other" aggregate over the same grouped CTE.
  // It always returns exactly one row (aggregate with no GROUP BY), which
  // also carries totalRowCount for pages past the end of the data. The
  // key-ASC tiebreak makes pagination deterministic when costs tie.
  const rowsQuery = Prisma.sql`
    WITH grouped AS (
      SELECT
        ${dimensionSql.key} AS "key",
        SUM(COALESCE(e."usageCost", 0)) AS "cost",
        COUNT(*) AS "eventCount"${
          finished
            ? Prisma.sql`,
        ${finishedCount} AS "eventCountFinishedWork"`
            : Prisma.empty
        }
      FROM signal_events e
      ${dimensionSql.join}
      WHERE ${where}
      GROUP BY 1
    ),
    ranked AS (
      SELECT
        "key",
        "cost",
        "eventCount",${
          finished
            ? Prisma.sql`
        "eventCountFinishedWork",`
            : Prisma.empty
        }
        ROW_NUMBER() OVER (ORDER BY "cost" DESC, "key" ASC NULLS LAST) AS "rn",
        COUNT(*) OVER () AS "totalRowCount"
      FROM grouped
    )
    SELECT
      "key",
      "cost"::float8 AS "cost",
      "eventCount"::int AS "eventCount",${
        finished
          ? Prisma.sql`
      "eventCountFinishedWork"::int AS "eventCountFinishedWork",`
          : Prisma.empty
      }
      "totalRowCount"::int AS "totalRowCount",
      FALSE AS "isOther",
      "rn"::int AS "rn"
    FROM ranked
    WHERE "rn" > ${offset} AND "rn" <= ${offset + pageSize}
    UNION ALL
    SELECT
      NULL::text,
      COALESCE(SUM("cost"), 0)::float8,
      COALESCE(SUM("eventCount"), 0)::int,${
        finished
          ? Prisma.sql`
      COALESCE(SUM("eventCountFinishedWork"), 0)::int,`
          : Prisma.empty
      }
      (SELECT COUNT(*) FROM grouped)::int,
      TRUE,
      NULL::int
    FROM ranked
    WHERE "rn" <= ${offset} OR "rn" > ${offset + pageSize}
    ORDER BY "isOther" ASC, "rn" ASC
  `;

  // SUM(quantity), not COUNT(*): one record can carry "5 contracts summarized".
  const thingsQuery = Prisma.sql`
    SELECT
      ${firstSeenName()} AS "name",
      e."agentId"::text AS "agentId",
      e."customerExternalId" AS "customerExternalId",
      ${labelKey()} AS "label",
      SUM(COALESCE(e."quantity", 1))::float8 AS "howMany",
      COUNT(*)::int AS "eventCount"
    FROM signal_events e
    LEFT JOIN signals s ON s.id = e."signalId"
    WHERE ${where} AND ${outcomeMarker()}${finishedScope}
    GROUP BY lower(btrim(COALESCE(s."name", ''))), 2, 3, 4
    ORDER BY 5 DESC, 1 ASC
  `;

  // The bucket is (developer, work-item label). The cost still comes
  // back SLICED per agent so the checkbox row can re-scope in memory, but the
  // agent is a filter, never part of the key.
  //
  // LEFT JOIN, deliberately. A bucket with things and no spend comes back at
  // eventCount 0, which the page renders as a dash; an INNER JOIN would drop
  // the bucket and the row would vanish instead.
  const bucketsQuery = Prisma.sql`
    WITH buckets AS (
      SELECT DISTINCT
        e."customerExternalId" AS "customerExternalId",
        ${labelKey()} AS "label"
      FROM signal_events e
      WHERE ${where} AND ${outcomeMarker()}${finishedScope}
    )
    SELECT
      b."customerExternalId" AS "customerExternalId",
      b."label" AS "label",
      e."agentId"::text AS "agentId",
      COALESCE(SUM(COALESCE(e."usageCost", 0)), 0)::float8 AS "cost",
      COUNT(e.id)::int AS "eventCount",
      (COUNT(e.id) FILTER (WHERE e."usageCost" IS NULL))::int AS "eventCountWithNullCost"
    FROM buckets b
    LEFT JOIN signal_events e
      ON ${where}
      AND e."customerExternalId" = b."customerExternalId"
      AND ${labelKey()} = b."label"
      AND NOT ${outcomeMarker()}
      AND ${codingAgent()}${finishedScope}
    GROUP BY 1, 2, 3
    ORDER BY 1 ASC, 2 ASC, 3 ASC NULLS LAST
  `;

  const namedUsageQuery = Prisma.sql`
    SELECT
      ${firstSeenName()} AS "name",
      e."agentId"::text AS "agentId",
      SUM(COALESCE(e."quantity", 1))::float8 AS "howMany",
      COALESCE(SUM(COALESCE(e."usageCost", 0)), 0)::float8 AS "cost",
      COUNT(*)::int AS "eventCount",
      (COUNT(*) FILTER (WHERE e."usageCost" IS NULL))::int AS "eventCountWithNullCost"
    FROM signal_events e
    INNER JOIN signals s ON s.id = e."signalId"
    INNER JOIN agents a ON a.id = e."agentId"
    WHERE ${where}${finishedScope}
      AND NOT ${outcomeMarker()}
      AND a."agentCode" NOT IN (${Prisma.join(
        CCC_AGENT_CODES.map((code) => Prisma.sql`${code}`),
      )})
    GROUP BY lower(btrim(s."name")), 2
    ORDER BY 4 DESC, 1 ASC
  `;

  // READ COMMITTED would give each SELECT its own snapshot; REPEATABLE READ
  // pins all three to one, so tiles, chart, and table can never disagree
  // mid-ingest (the "same query pass" guarantee). The finished-work
  // reads join that snapshot because the Cost tile and the costs attributed
  // under it sit inches apart on the ROI page.
  const queries: Prisma.PrismaPromise<unknown>[] = [
    db.$queryRaw(totalsQuery),
    db.$queryRaw(seriesQuery),
    db.$queryRaw(rowsQuery),
  ];
  if (readFinishedWork) {
    queries.push(
      db.$queryRaw(thingsQuery),
      db.$queryRaw(bucketsQuery),
      db.$queryRaw(namedUsageQuery),
    );
  }
  const [totalsRaw, seriesRaw, rowsRaw, thingsRaw, bucketsRaw, namedUsageRaw] =
    await db.$transaction(queries, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });

  const totalsRow = RawTotalsRowSchema.parse((totalsRaw as unknown[])[0]);
  const seriesRows = z.array(RawSeriesRowSchema).parse(seriesRaw);
  const breakdownRaw = z.array(RawBreakdownRowSchema).parse(rowsRaw);

  const otherRow = breakdownRaw.find((row) => row.isOther);
  const pageRows = breakdownRaw.filter((row) => !row.isOther);

  const rows: BreakdownRow[] = pageRows.map((row) =>
    finished
      ? {
          key: row.key,
          cost: row.cost,
          eventCount: row.eventCount,
          eventCountFinishedWork: row.eventCountFinishedWork ?? 0,
        }
      : { key: row.key, cost: row.cost, eventCount: row.eventCount },
  );
  const series: CostByDayRow[] = seriesRows.map((row) => ({
    date: row.date,
    cost: row.cost,
    eventCount: row.eventCount,
  }));

  // Spread rather than a conditional key, so a caller WITHOUT the option gets
  // the base shape only, with no finishedWork key at all.
  const finishedWork: { finishedWork?: CostBreakdownFinishedWork } = finished
    ? {
        finishedWork: {
          things: z.array(FinishedThingRowSchema).parse(thingsRaw ?? []),
          buckets: z.array(FinishedWorkBucketRowSchema).parse(bucketsRaw ?? []),
          namedUsage: z.array(NamedUsageRowSchema).parse(namedUsageRaw ?? []),
        },
      }
    : {};

  return {
    totals: {
      cost: totalsRow.cost,
      eventCount: totalsRow.eventCount,
      eventCountWithNullCost: totalsRow.eventCountWithNullCost,
      ...(finished
        ? { eventCountFinishedWork: totalsRow.eventCountFinishedWork ?? 0 }
        : {}),
    },
    series,
    rows,
    totalRowCount: otherRow?.totalRowCount ?? pageRows[0]?.totalRowCount ?? 0,
    other:
      includeOtherRollup && otherRow && otherRow.eventCount > 0
        ? { cost: otherRow.cost, eventCount: otherRow.eventCount }
        : null,
    ...finishedWork,
  };
}

/**
 * The one capability the rollup needs. Declared structurally (not
 * PrismaClient) so any Prisma client, or a transaction client whose type
 * drops `$on`, can call in without a cast or a second client instance.
 */
export type MatterCostRollupClient = Pick<PrismaClient, "$queryRaw">;

export interface MatterCostRollupFilters {
  /**
   * Restrict to these buckets; `null` in the list requests the Unassigned
   * bucket. Every requested bucket comes back exactly once (zero-filled when
   * it has no events); an empty list returns [] without querying. Omit for
   * every bucket that has events.
   */
  matterIds?: (string | null)[];
  /** Inclusive usageDate window (canon C2). Omit for all time — the Law tab's
   * default lens; the audit export is the windowed surface. */
  window?: { start: Date; end: Date };
}

/**
 * Per-matter cost rollup (canon C1) — the ONE aggregator for matter-scoped
 * cost. Every surface that shows "cost per matter" (Law tab,
 * /v1/matters, MCP matter tools) orders from here; a signal_events
 * aggregate/groupBy on usageCost in matter code is a canon violation
 * (audit script R2/R9, and the same rule binds the dashboard actions).
 *
 * Second caller: the ROI page's matter-scoped initiative reads
 * (apps/dashboard/app/actions/_shared/initiative-actuals.ts). It passes ONE
 * matterId plus the initiative's window — the Law tab reads a matter
 * all-time, an initiative reads it over the goal's window.
 *
 * Deliberately NOT a Dimension registry entry: the registry feeds
 * getCostBreakdown, which the org-wide analytics surface exposes to any
 * non-ingest key — matter buckets belong to the role-gated law surface only.
 */
export async function getMatterCostRollups(
  db: MatterCostRollupClient,
  orgId: string,
  filters: MatterCostRollupFilters = {},
): Promise<MatterCostRollup[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`e."organizationId" = ${orgId}::uuid`,
  ];
  if (filters.window) {
    conditions.push(
      Prisma.sql`e."usageDate" >= ${filters.window.start.toISOString()}::timestamptz`,
    );
    conditions.push(
      Prisma.sql`e."usageDate" <= ${filters.window.end.toISOString()}::timestamptz`,
    );
  }

  let requested: (string | null)[] | null = null;
  if (filters.matterIds) {
    requested = [...new Set(filters.matterIds)];
    if (requested.length === 0) return [];
    const ids = requested.filter((id): id is string => id !== null);
    const bucketConditions: Prisma.Sql[] = [];
    if (ids.length > 0) {
      bucketConditions.push(
        Prisma.sql`e."matterId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    }
    if (requested.includes(null)) {
      bucketConditions.push(Prisma.sql`e."matterId" IS NULL`);
    }
    conditions.push(Prisma.sql`(${Prisma.join(bucketConditions, " OR ")})`);
  }

  const raw = await db.$queryRaw(Prisma.sql`
    SELECT
      e."matterId"::text AS "matterId",
      SUM(COALESCE(e."usageCost", 0))::float8 AS "cost",
      COUNT(*)::int AS "eventCount",
      (COUNT(*) FILTER (WHERE e."usageCost" IS NULL))::int AS "eventsMissingCost"
    FROM signal_events e
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1
    ORDER BY 1 ASC NULLS LAST
  `);
  const rows = z.array(MatterCostRollupSchema).parse(raw);

  if (!requested) return rows;
  const byBucket = new Map(rows.map((row) => [row.matterId, row]));
  return requested.map(
    (matterId) =>
      byBucket.get(matterId) ?? {
        matterId,
        cost: 0,
        eventCount: 0,
        eventsMissingCost: 0,
      },
  );
}
