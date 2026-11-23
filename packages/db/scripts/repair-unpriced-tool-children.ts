/**
 * Re-price signal_event_services children that were stranded at
 * NEEDS_COST_BACKFILL before their catalog row existed.
 *
 * Adding a catalog row fixes every FUTURE event and nothing already on the
 * books. This script is the missing re-run. It computes nothing itself — the
 * canon functions do, so a repaired row matches what ingest would have
 * written.
 *
 * Safety posture, in order:
 *   1. --provider picks the blast radius: tool (the default), model (every
 *      provider except tool), or any. The outcome marker is never in scope.
 *   2. Only a child whose sole problem was "no catalog row at ingest"
 *      qualifies. A child that had a row (cache-rate refusal), one that ingest
 *      would have flagged MISSING_VOLUME_DATA, and one whose org mapping
 *      disagrees with the catalog are reported and left alone.
 *   3. Dry-run is the DEFAULT. Writing requires --apply.
 *   4. The child id list is FROZEN in one query before any write, so events
 *      arriving mid-run can never widen the blast radius.
 *   5. Every price comes from resolveEventPrice, which refuses rather than
 *      bill an unpriced cache rate at $0.
 *   6. A rollback snapshot is written to disk before the first write.
 *   7. Each batch is its own transaction, so a midpoint crash leaves every
 *      committed batch internally consistent.
 *   8. --max-total-usd is required with every --apply and must be a plain
 *      number. It aborts before writing if the plan costs more than the
 *      operator expected — the tripwire for a costUnit mis-branch.
 *
 * Usage:
 *   tsx repair-unpriced-tool-children.ts --org-id <uuid> [--provider model]         # plan
 *   tsx repair-unpriced-tool-children.ts --org-id <uuid> --provider model --apply \
 *       --max-total-usd <ceiling>
 *   tsx repair-unpriced-tool-children.ts --all-orgs --provider model                # plan, per org
 *   tsx repair-unpriced-tool-children.ts --all-orgs --provider model --apply \
 *       --max-total-usd <ceiling> --snapshot-dir <dir>
 *   tsx repair-unpriced-tool-children.ts --rollback <snapshot.json>
 */

import { PrismaClient, Prisma } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resolveEventPrice,
  isPriceRefused,
  lookupModelInCatalog,
  type CatalogLookupResult,
  type PriceRefusalKind,
  type UnpricedCacheRate,
} from "../src/lib/model-pricing";
import {
  recomputeParentUsageCost,
  assertEventCostInvariant,
} from "../src/lib/signal-event-rollup";

export const SNAPSHOT_FORMAT = "repair-unpriced-tool-children/v2";
const LEGACY_SNAPSHOT_FORMAT = "repair-unpriced-tool-children/v1";

/**
 * Every agent built-in reports `modelProvider` as the literal "tool". It is
 * the default scope: widening to model children is an explicit
 * --provider choice, never something a bare invocation does.
 */
export const SWEEP_PROVIDER = "tool";

/** The finished-work marker is priced by its own path and is never swept. */
const NEVER_SWEPT_PROVIDER = "outcome";

export type ProviderScope = "tool" | "model" | "any";

export function parseProviderScope(value: string | undefined): ProviderScope {
  if (value === undefined) return "tool";
  if (value === "tool" || value === "model" || value === "any") return value;
  throw new Error(
    `Unknown --provider "${value}". This picks which unpriced children the repair may touch. ` +
      `Fix: pass --provider tool, --provider model or --provider any.`,
  );
}

export function providerInScope(
  provider: string,
  scope: ProviderScope,
): boolean {
  const normalized = provider.trim().toLowerCase();
  if (normalized === NEVER_SWEPT_PROVIDER) return false;
  if (scope === "any") return true;
  return scope === "tool"
    ? normalized === SWEEP_PROVIDER
    : normalized !== SWEEP_PROVIDER;
}

function providerScopeSql(scope: ProviderScope): Prisma.Sql {
  if (scope === "tool") {
    return Prisma.sql`lower(trim(ses."modelProvider")) = ${SWEEP_PROVIDER}`;
  }
  if (scope === "model") {
    return Prisma.sql`lower(trim(ses."modelProvider")) NOT IN (${SWEEP_PROVIDER}, ${NEVER_SWEPT_PROVIDER})`;
  }
  return Prisma.sql`lower(trim(ses."modelProvider")) <> ${NEVER_SWEPT_PROVIDER}`;
}

// Prisma's 5-second interactive-transaction default is a LAN number. A batch
// here is ~100 round trips to a hosted Postgres, so the default aborts a
// perfectly healthy run mid-flight.
const TRANSACTION_LIMITS = { maxWait: 30_000, timeout: 180_000 } as const;

/**
 * usageCostData is `Json?`: an object, a JSON `null`, and a SQL NULL are
 * three distinct states. Prisma reads the last two as the same `null` but
 * needs different sentinels to write them back, so a snapshot that cannot
 * tell them apart cannot roll them back.
 */
export type JsonColumnState =
  | { kind: "sqlNull" }
  | { kind: "jsonNull" }
  | { kind: "value"; json: string };

export interface ChildSnapshot {
  id: string;
  signalEventId: string;
  usageCost: string | null;
  usageCostData: JsonColumnState;
  eventStatus: string;
  servicePricingId: string | null;
}

export interface ParentSnapshot {
  id: string;
  usageCost: string | null;
  /** Optional: when absent, rollback leaves the parent's cost data as it is. */
  usageCostData?: JsonColumnState;
  eventProcessed: string;
  eventProcessedAt: string | null;
}

export interface RepairSnapshot {
  format: typeof SNAPSHOT_FORMAT | typeof LEGACY_SNAPSHOT_FORMAT;
  provider?: ProviderScope;
  organizationId: string;
  capturedAt: string;
  children: ChildSnapshot[];
  parents: ParentSnapshot[];
}

export interface PlannedChange {
  childId: string;
  signalEventId: string;
  model: string;
  modelProvider: string;
  quantity: number;
  costUnit: string;
  servicePricingId: string;
  totalCostUsd: Prisma.Decimal;
}

export interface RepairOptions {
  organizationId: string;
  prisma: PrismaClient;
  provider?: ProviderScope;
  apply?: boolean;
  batchSize?: number;
  snapshotPath?: string;
  maxTotalUsd?: number;
  log?: (line: string) => void;
  /**
   * Test seam. The CLI never passes it; the midpoint-failure test throws
   * from it to prove a crash mid-run leaves committed batches consistent.
   */
  afterBatch?: (batchIndex: number) => Promise<void>;
}

/** A child the canonical guard would not put a number on. */
export interface GuardRefusal {
  childId: string;
  signalEventId: string;
  model: string;
  kind: PriceRefusalKind;
  missingRates: UnpricedCacheRate[];
  reason: string;
}

export type NotQualifiedReason =
  | "priced-row-existed-at-ingest"
  | "missing-volume"
  | "mapping-conflict";

export interface NotQualified {
  childId: string;
  model: string;
  modelProvider: string;
  reason: NotQualifiedReason;
  detail: string;
}

export interface RepairResult {
  organizationId: string;
  provider: ProviderScope;
  frozenChildIds: string[];
  notQualified: NotQualified[];
  planned: PlannedChange[];
  skippedNoCatalogRow: {
    model: string;
    modelProvider: string;
    count: number;
  }[];
  /** Left at NEEDS_COST_BACKFILL on purpose. Never counted as repaired. */
  refusedByGuard: GuardRefusal[];
  plannedTotalUsd: Prisma.Decimal;
  applied: number;
  parentsTouched: number;
  snapshotPath: string | null;
  dryRun: boolean;
}

interface FrozenChildRow {
  id: string;
  signal_event_id: string;
  model: string;
  model_provider: string;
  quantity: Prisma.Decimal | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_data_is_sql_null: boolean;
  usage_cost: Prisma.Decimal | null;
  event_status: string;
  service_pricing_id: string | null;
  usage_cost_data_text: string | null;
  parent_metadata: unknown;
}

function catalogKey(model: string, provider: string): string {
  return `${model.trim().toLowerCase()}|${provider.trim().toLowerCase()}`;
}

/**
 * Selects only children that are BOTH unpriced and flagged for backfill,
 * which is what makes a second run a no-op instead of a double-price — and
 * only SWEEP_PROVIDER children, which is what keeps the sweep inside its name.
 */
export async function freezeCandidates(
  prisma: PrismaClient,
  organizationId: string,
  scope: ProviderScope = "tool",
): Promise<FrozenChildRow[]> {
  return prisma.$queryRaw<FrozenChildRow[]>`
    SELECT ses.id,
           ses."signalEventId"      AS signal_event_id,
           ses.model,
           ses."modelProvider"      AS model_provider,
           ses.quantity,
           ses."inputTokens"        AS input_tokens,
           ses."outputTokens"       AS output_tokens,
           ses."cacheReadTokens"    AS cache_read_tokens,
           ses."cacheWriteTokens"   AS cache_write_tokens,
           ses."usageCost"          AS usage_cost,
           ses."eventStatus"::text  AS event_status,
           ses."servicePricingId"   AS service_pricing_id,
           ses."usageCostData" IS NULL AS cost_data_is_sql_null,
           ses."usageCostData"::text   AS usage_cost_data_text,
           se.metadata              AS parent_metadata
    FROM signal_event_services ses
    JOIN signal_events se ON se.id = ses."signalEventId"
    WHERE se."organizationId" = ${organizationId}::uuid
      AND ${providerScopeSql(scope)}
      AND ses."usageCost" IS NULL
      AND ses."eventStatus" = 'NEEDS_COST_BACKFILL'
    ORDER BY ses.id
  `;
}

function toJsonColumnState(row: {
  cost_data_is_sql_null: boolean;
  usage_cost_data_text: string | null;
}): JsonColumnState {
  if (row.cost_data_is_sql_null) return { kind: "sqlNull" };
  const text = row.usage_cost_data_text ?? "null";
  if (text === "null") return { kind: "jsonNull" };
  return { kind: "value", json: text };
}

type CostDataLine = {
  cost: number;
  units: number | null | undefined;
  costPerUnit: number;
};

/**
 * The parent's usageCostData, rebuilt from its priced children with the same
 * merge rule ingest uses (sdk.service.ts STEP 7): sum cost on a key
 * collision, sum units only when both are numbers, keep the rate.
 */
export function aggregateChildCostData(
  children: { usageCost: unknown; usageCostData: unknown }[],
): Record<string, CostDataLine> | null {
  const aggregated: Record<string, CostDataLine> = {};
  for (const child of children) {
    if (child.usageCost == null) continue;
    const data = child.usageCostData;
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }
    for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
      const line = raw as CostDataLine;
      const seen = aggregated[key];
      if (!seen) {
        aggregated[key] = { ...line };
        continue;
      }
      seen.cost += line.cost;
      if (typeof line.units === "number" && typeof seen.units === "number") {
        seen.units += line.units;
      }
    }
  }
  return Object.keys(aggregated).length > 0 ? aggregated : null;
}

async function rebuildParentCostData(
  parentId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const children = await tx.signal_event_services.findMany({
    where: { signalEventId: parentId },
    select: { usageCost: true, usageCostData: true },
    orderBy: { id: "asc" },
  });
  const aggregated = aggregateChildCostData(children);
  await tx.signal_events.update({
    where: { id: parentId },
    data: {
      usageCostData:
        aggregated == null
          ? Prisma.DbNull
          : (aggregated as unknown as Prisma.InputJsonValue),
    },
  });
}

async function assertOrgExists(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const org = await prisma.organizations.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!org) {
    throw new Error(
      `Organization ${organizationId} does not exist in this database. ` +
        `Usually a copy-paste slip or the wrong DATABASE_URL. Fix: check the id and the database, then re-run.`,
    );
  }
}

async function orgCostTotals(
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ pricedUsd: string; unpricedChildren: number }> {
  const rows = await prisma.$queryRaw<
    { priced_usd: string | null; unpriced: bigint }[]
  >`
    SELECT coalesce(sum(ses."usageCost"), 0)::text AS priced_usd,
           count(*) FILTER (WHERE ses."eventStatus" = 'NEEDS_COST_BACKFILL') AS unpriced
    FROM signal_event_services ses
    JOIN signal_events se ON se.id = ses."signalEventId"
    WHERE se."organizationId" = ${organizationId}::uuid
  `;
  return {
    pricedUsd: rows[0]?.priced_usd ?? "0",
    unpricedChildren: Number(rows[0]?.unpriced ?? 0),
  };
}

function restoreJsonColumn(
  state: JsonColumnState,
): Prisma.InputJsonValue | typeof Prisma.DbNull | typeof Prisma.JsonNull {
  if (state.kind === "sqlNull") return Prisma.DbNull;
  if (state.kind === "jsonNull") return Prisma.JsonNull;
  return JSON.parse(state.json) as Prisma.InputJsonValue;
}

const CEILING_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Number("$0.01") is NaN, and Decimal.greaterThan(NaN) is false, so a loose
 * parse turns a typo into "no ceiling at all".
 */
export function parseMaxTotalUsd(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!CEILING_PATTERN.test(raw.trim())) {
    throw new Error(
      `--max-total-usd must be a plain dollar amount like 2 or 1.27, and got ${JSON.stringify(raw)}. ` +
        `Nothing was written. Fix: drop any "$" or commas, and put the number right after the flag.`,
    );
  }
  return Number(raw.trim());
}

function assertCeilingForApply(
  apply: boolean,
  maxTotalUsd: number | undefined,
): void {
  if (
    maxTotalUsd != null &&
    !(Number.isFinite(maxTotalUsd) && maxTotalUsd >= 0)
  ) {
    throw new Error(
      `--max-total-usd must be a finite amount of zero or more, and got ${maxTotalUsd}. ` +
        `Nothing was written. Fix: pass the dollar ceiling as a plain number, like 2 or 1.27.`,
    );
  }
  if (apply && maxTotalUsd == null) {
    throw new Error(
      "Refusing an --apply without --max-total-usd. The ceiling is the only brake on a bad re-price. " +
        "Fix: run the dry run, read its planned total, and pass a ceiling you believe.",
    );
  }
}

export async function runRepair(options: RepairOptions): Promise<RepairResult> {
  const {
    organizationId,
    prisma,
    provider = "tool",
    apply = false,
    batchSize = 25,
    maxTotalUsd,
    afterBatch,
  } = options;
  const log = options.log ?? ((line: string) => console.log(line));

  assertCeilingForApply(apply, maxTotalUsd);
  await assertOrgExists(prisma, organizationId);

  const frozen = await freezeCandidates(prisma, organizationId, provider);
  const frozenChildIds = frozen.map((row) => row.id);
  log(
    `Frozen work list: ${frozenChildIds.length} unpriced ${provider} children in org ${organizationId}.`,
  );

  const orgMappings = new Map<string, string>();
  for (const mapping of await prisma.org_model_mappings.findMany({
    where: { organizationId },
    select: { sourceModel: true, sourceProvider: true, targetPricingId: true },
  })) {
    orgMappings.set(
      catalogKey(mapping.sourceModel, mapping.sourceProvider),
      mapping.targetPricingId,
    );
  }

  // Resolved once, outside every transaction: the global catalog cannot
  // change mid-run, and per-child lookups would be a round trip per row.
  // lookupModelInCatalog is the SAME resolver ingest uses, so a name the SDK
  // would resolve today (including via an org mapping) resolves here too.
  const catalog = new Map<string, CatalogLookupResult | null>();
  for (const row of frozen) {
    const key = catalogKey(row.model, row.model_provider);
    if (catalog.has(key)) continue;
    catalog.set(
      key,
      await lookupModelInCatalog(
        prisma,
        row.model,
        row.model_provider,
        organizationId,
      ),
    );
  }

  const planned: PlannedChange[] = [];
  const plannedWrites = new Map<
    string,
    { data: Prisma.signal_event_servicesUpdateInput; parentId: string }
  >();
  const skippedCounts = new Map<string, number>();
  const refusedByGuard: GuardRefusal[] = [];
  const notQualified: NotQualified[] = [];
  let plannedTotalUsd = new Prisma.Decimal(0);

  for (const row of frozen) {
    const key = catalogKey(row.model, row.model_provider);
    const report = (reason: NotQualifiedReason, detail: string) =>
      notQualified.push({
        childId: row.id,
        model: row.model,
        modelProvider: row.model_provider,
        reason,
        detail,
      });

    // Ingest stamps servicePricingId whenever it found a row, so a stamped
    // child was refused for something other than a missing row.
    if (row.service_pricing_id != null) {
      report(
        "priced-row-existed-at-ingest",
        `had catalog row ${row.service_pricing_id} at ingest; unpriced for another reason (usually a missing cache rate)`,
      );
      continue;
    }

    const entry = catalog.get(key) ?? null;
    if (!entry) {
      skippedCounts.set(key, (skippedCounts.get(key) ?? 0) + 1);
      continue;
    }

    const mappedTarget = orgMappings.get(key);
    if (mappedTarget != null && mappedTarget !== entry.servicePricingId) {
      report(
        "mapping-conflict",
        `catalog resolves to ${entry.servicePricingId} but the org maps it to ${mappedTarget}`,
      );
      continue;
    }

    // The same volume rule ingest applies once it has a row (sdk.service.ts
    // STEP 7). Tool children keep the rule of a null quantity
    // meaning one call.
    if (row.model_provider.trim().toLowerCase() !== SWEEP_PROVIDER) {
      const isLlm = entry.costUnit === "1M tokens";
      if (isLlm && (row.input_tokens == null || row.output_tokens == null)) {
        report(
          "missing-volume",
          `LLM row needs both token counts; got input=${row.input_tokens} output=${row.output_tokens}`,
        );
        continue;
      }
      if (!isLlm && row.quantity == null) {
        report(
          "missing-volume",
          `costUnit "${entry.costUnit}" needs a quantity; got none`,
        );
        continue;
      }
    }

    const inputTokens = Number(row.input_tokens ?? 0);
    const outputTokens = Number(row.output_tokens ?? 0);
    // Matches the dashboard backfill: a null quantity on a per-request row
    // means one call, not zero.
    const quantity = Number(row.quantity ?? 1);
    const cacheReadTokens = Number(row.cache_read_tokens ?? 0);
    const cacheWriteTokens = Number(row.cache_write_tokens ?? 0);
    const cacheWriteTtl = (
      row.parent_metadata as Record<string, unknown> | null
    )?.cacheWriteTtl;

    // The canonical entry point, never a local copy of its rules: it owns both
    // the missing-cache-rate refusal and the 5m cache-write TTL re-base.
    const resolution = resolveEventPrice({
      inputTokens,
      outputTokens,
      quantity,
      entry,
      // Raw, not coalesced: resolveEventPrice needs the unreadable-count case
      // to stay unreadable rather than become a silent 0.
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      provider: row.model_provider,
      cacheWriteTtl,
      model: row.model,
    });
    if (isPriceRefused(resolution)) {
      refusedByGuard.push({
        childId: row.id,
        signalEventId: row.signal_event_id,
        model: row.model,
        kind: resolution.kind,
        missingRates: resolution.missingRates,
        reason: resolution.reason,
      });
      continue;
    }
    const cost = resolution.price;

    const usageCostData: Record<
      string,
      { cost: number; units: number; costPerUnit: number }
    > = {
      [`${row.model}/input`]: {
        cost: cost.inputCostUsd.toNumber(),
        units: inputTokens,
        costPerUnit: cost.inputCostPerToken,
      },
      [`${row.model}/output`]: {
        cost: cost.outputCostUsd.toNumber(),
        units: outputTokens,
        costPerUnit: cost.outputCostPerToken,
      },
    };
    if (row.cache_read_tokens != null) {
      usageCostData[`${row.model}/cache_read`] = {
        cost: cost.cacheReadCostUsd.toNumber(),
        units: cacheReadTokens,
        costPerUnit: cost.cacheReadCostPerToken,
      };
    }
    if (row.cache_write_tokens != null) {
      usageCostData[`${row.model}/cache_write`] = {
        cost: cost.cacheWriteCostUsd.toNumber(),
        units: cacheWriteTokens,
        costPerUnit: cost.cacheWriteCostPerToken,
      };
    }

    planned.push({
      childId: row.id,
      signalEventId: row.signal_event_id,
      model: row.model,
      modelProvider: row.model_provider,
      quantity,
      costUnit: entry.costUnit,
      servicePricingId: entry.servicePricingId,
      totalCostUsd: cost.totalCostUsd,
    });
    plannedWrites.set(row.id, {
      parentId: row.signal_event_id,
      data: {
        usageCost: cost.totalCostUsd,
        usageCostData: usageCostData as Prisma.InputJsonValue,
        eventStatus: "PROCESSED",
        service_pricing: { connect: { id: entry.servicePricingId } },
      },
    });
    plannedTotalUsd = plannedTotalUsd.add(cost.totalCostUsd);
  }

  const skippedNoCatalogRow = [...skippedCounts.entries()]
    .map(([key, count]) => {
      const [model, modelProvider] = key.split("|");
      return { model, modelProvider, count };
    })
    .sort((a, b) => b.count - a.count);

  const byModel = new Map<string, { count: number; usd: Prisma.Decimal }>();
  for (const change of planned) {
    const label = `${change.modelProvider}/${change.model}`;
    const seen = byModel.get(label) ?? {
      count: 0,
      usd: new Prisma.Decimal(0),
    };
    byModel.set(label, {
      count: seen.count + 1,
      usd: seen.usd.add(change.totalCostUsd),
    });
  }
  log(`Priceable: ${planned.length}. Planned deltas by model:`);
  for (const [label, agg] of [...byModel.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    log(`  ${label}: ${agg.count} rows -> $${agg.usd.toFixed(6)}`);
  }
  const notQualifiedCounts = new Map<string, number>();
  for (const item of notQualified) {
    const label = `${item.reason} ${item.modelProvider}/${item.model}`;
    notQualifiedCounts.set(label, (notQualifiedCounts.get(label) ?? 0) + 1);
  }
  for (const [label, count] of notQualifiedCounts) {
    log(`  NOT QUALIFIED ${label}: ${count} rows — reported, left untouched.`);
  }
  for (const skip of skippedNoCatalogRow) {
    log(
      `  SKIP ${skip.model} (provider ${skip.modelProvider}): ${skip.count} rows — no active catalog row, left untouched.`,
    );
  }
  for (const refusal of refusedByGuard) {
    log(
      `  REFUSED ${refusal.model} (child ${refusal.childId}): ${refusal.reason}`,
    );
  }
  log(`Planned total: $${plannedTotalUsd.toFixed(6)}`);
  const before = await orgCostTotals(prisma, organizationId);
  log(
    `Before: org child cost sum $${before.pricedUsd}, ${before.unpricedChildren} children at NEEDS_COST_BACKFILL.`,
  );

  if (maxTotalUsd != null && plannedTotalUsd.greaterThan(maxTotalUsd)) {
    throw new Error(
      `Planned total $${plannedTotalUsd.toFixed(6)} exceeds the --max-total-usd ceiling of $${maxTotalUsd}. ` +
        `Nothing was written. This usually means a catalog row's costUnit changed and the ` +
        `per-1K branch turned into the flat branch (a 1,000x jump). Check the costUnit on the ` +
        `rows listed above, then re-run with a ceiling you believe.`,
    );
  }

  if (!apply) {
    log("Dry run — no snapshot written, no rows changed. Re-run with --apply.");
    return {
      organizationId,
      provider,
      frozenChildIds,
      notQualified,
      planned,
      skippedNoCatalogRow,
      refusedByGuard,
      plannedTotalUsd,
      applied: 0,
      parentsTouched: 0,
      snapshotPath: null,
      dryRun: true,
    };
  }

  const parentIds = [...new Set(planned.map((p) => p.signalEventId))];
  const parentRows =
    parentIds.length === 0
      ? []
      : await prisma.$queryRaw<
          {
            id: string;
            usage_cost: Prisma.Decimal | null;
            event_processed: string;
            event_processed_at: Date | null;
            cost_data_is_sql_null: boolean;
            usage_cost_data_text: string | null;
          }[]
        >`
          SELECT id,
                 "usageCost"             AS usage_cost,
                 "eventProcessed"::text  AS event_processed,
                 "eventProcessedAt"      AS event_processed_at,
                 "usageCostData" IS NULL AS cost_data_is_sql_null,
                 "usageCostData"::text   AS usage_cost_data_text
          FROM signal_events
          WHERE id = ANY(${parentIds}::uuid[])
        `;

  const snapshot: RepairSnapshot = {
    format: SNAPSHOT_FORMAT,
    provider,
    organizationId,
    capturedAt: new Date().toISOString(),
    children: frozen
      .filter((row) => plannedWrites.has(row.id))
      .map((row) => ({
        id: row.id,
        signalEventId: row.signal_event_id,
        usageCost: row.usage_cost == null ? null : row.usage_cost.toString(),
        usageCostData: toJsonColumnState(row),
        eventStatus: row.event_status,
        servicePricingId: row.service_pricing_id,
      })),
    parents: parentRows.map((row) => ({
      id: row.id,
      usageCost: row.usage_cost == null ? null : row.usage_cost.toString(),
      usageCostData: toJsonColumnState(row),
      eventProcessed: row.event_processed,
      eventProcessedAt: row.event_processed_at
        ? row.event_processed_at.toISOString()
        : null,
    })),
  };

  const snapshotPath =
    options.snapshotPath ??
    path.resolve(
      process.cwd(),
      `repair-snapshot-${organizationId}-${Date.now()}.json`,
    );
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  log(`Snapshot written: ${snapshotPath}`);

  let applied = 0;
  const touchedParents = new Set<string>();
  const changeList = planned;
  for (let offset = 0; offset < changeList.length; offset += batchSize) {
    const batch = changeList.slice(offset, offset + batchSize);
    const batchIndex = offset / batchSize;
    await prisma.$transaction(async (tx) => {
      const batchParents = new Set<string>();
      for (const change of batch) {
        const write = plannedWrites.get(change.childId)!;
        // Re-check inside the transaction. A row already repaired by an
        // earlier run (or a concurrent one) is skipped rather than
        // re-written, which is what makes a second run a no-op.
        const { count } = await tx.signal_event_services.updateMany({
          where: { id: change.childId, usageCost: null },
          data: {
            usageCost: write.data.usageCost as Prisma.Decimal,
            usageCostData: write.data.usageCostData as Prisma.InputJsonValue,
            eventStatus: "PROCESSED",
            servicePricingId: change.servicePricingId,
          },
        });
        if (count === 0) continue;
        applied += 1;
        batchParents.add(change.signalEventId);
      }
      for (const parentId of batchParents) {
        await recomputeParentUsageCost(parentId, prisma, tx);
        await rebuildParentCostData(parentId, tx);
        await assertEventCostInvariant(parentId, prisma, tx);
        touchedParents.add(parentId);
      }
    }, TRANSACTION_LIMITS);
    if (afterBatch) await afterBatch(batchIndex);
  }

  log(
    `Applied: ${applied} children re-priced across ${touchedParents.size} parents.`,
  );
  const after = await orgCostTotals(prisma, organizationId);
  log(
    `After: org child cost sum $${after.pricedUsd}, ${after.unpricedChildren} children at NEEDS_COST_BACKFILL.`,
  );
  return {
    organizationId,
    provider,
    frozenChildIds,
    notQualified,
    planned,
    skippedNoCatalogRow,
    refusedByGuard,
    plannedTotalUsd,
    applied,
    parentsTouched: touchedParents.size,
    snapshotPath,
    dryRun: false,
  };
}

export async function rollbackFromSnapshot(
  prisma: PrismaClient,
  snapshotPath: string,
  log: (line: string) => void = console.log,
  batchSize = 25,
): Promise<{ children: number; parents: number }> {
  const snapshot = JSON.parse(
    fs.readFileSync(snapshotPath, "utf8"),
  ) as RepairSnapshot;
  if (
    snapshot.format !== SNAPSHOT_FORMAT &&
    snapshot.format !== LEGACY_SNAPSHOT_FORMAT
  ) {
    throw new Error(
      `Snapshot at ${snapshotPath} is format "${snapshot.format}", not "${SNAPSHOT_FORMAT}". ` +
        `Refusing to restore from a file this script did not write. Fix: point --rollback at the ` +
        `JSON the matching --apply run printed.`,
    );
  }

  // Batched by PARENT, not by row: a parent and every child the snapshot holds
  // for it restore in the same transaction, so an interrupted rollback still
  // satisfies the parent = SUM(children) invariant on both sides of the cut.
  const childrenByParent = new Map<string, ChildSnapshot[]>();
  for (const child of snapshot.children) {
    const bucket = childrenByParent.get(child.signalEventId) ?? [];
    bucket.push(child);
    childrenByParent.set(child.signalEventId, bucket);
  }

  for (let offset = 0; offset < snapshot.parents.length; offset += batchSize) {
    const batch = snapshot.parents.slice(offset, offset + batchSize);
    await prisma.$transaction(async (tx) => {
      for (const parent of batch) {
        for (const child of childrenByParent.get(parent.id) ?? []) {
          await tx.signal_event_services.update({
            where: { id: child.id },
            data: {
              usageCost:
                child.usageCost == null
                  ? null
                  : new Prisma.Decimal(child.usageCost),
              usageCostData: restoreJsonColumn(child.usageCostData),
              eventStatus:
                child.eventStatus as Prisma.signal_event_servicesUpdateInput["eventStatus"],
              servicePricingId: child.servicePricingId,
            },
          });
        }
        await tx.signal_events.update({
          where: { id: parent.id },
          data: {
            usageCost:
              parent.usageCost == null
                ? null
                : new Prisma.Decimal(parent.usageCost),
            eventProcessed:
              parent.eventProcessed as Prisma.signal_eventsUpdateInput["eventProcessed"],
            eventProcessedAt: parent.eventProcessedAt
              ? new Date(parent.eventProcessedAt)
              : null,
            ...(parent.usageCostData
              ? { usageCostData: restoreJsonColumn(parent.usageCostData) }
              : {}),
          },
        });
      }
    }, TRANSACTION_LIMITS);
  }

  log(
    `Rolled back ${snapshot.children.length} children and ${snapshot.parents.length} parents from ${snapshotPath}.`,
  );
  return {
    children: snapshot.children.length,
    parents: snapshot.parents.length,
  };
}

export interface AllOrgsOptions {
  prisma: PrismaClient;
  provider?: ProviderScope;
  apply?: boolean;
  batchSize?: number;
  maxTotalUsd?: number;
  snapshotDir?: string;
  log?: (line: string) => void;
}

export interface OrgSummary {
  organizationId: string;
  frozen: number;
  planned: number;
  plannedTotalUsd: Prisma.Decimal;
  notQualified: number;
  skippedNoCatalogRow: number;
  refusedByGuard: number;
  applied: number;
  snapshotPath: string | null;
}

export interface AllOrgsResult {
  perOrg: OrgSummary[];
  plannedTotalUsd: Prisma.Decimal;
  dryRun: boolean;
}

function summarize(result: RepairResult): OrgSummary {
  return {
    organizationId: result.organizationId,
    frozen: result.frozenChildIds.length,
    planned: result.planned.length,
    plannedTotalUsd: result.plannedTotalUsd,
    notQualified: result.notQualified.length,
    skippedNoCatalogRow: result.skippedNoCatalogRow.reduce(
      (sum, skip) => sum + skip.count,
      0,
    ),
    refusedByGuard: result.refusedByGuard.length,
    applied: result.applied,
    snapshotPath: result.snapshotPath,
  };
}

/**
 * Plans every org that holds a candidate, checks the ceiling against the
 * grand total, and only then applies org by org, each with its own snapshot.
 */
export async function runRepairAllOrgs(
  options: AllOrgsOptions,
): Promise<AllOrgsResult> {
  const {
    prisma,
    provider = "tool",
    apply = false,
    batchSize,
    maxTotalUsd,
  } = options;
  const log = options.log ?? ((line: string) => console.log(line));

  assertCeilingForApply(apply, maxTotalUsd);

  const orgs = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT o.id
    FROM signal_event_services ses
    JOIN signal_events se ON se.id = ses."signalEventId"
    JOIN organizations o ON o.id = se."organizationId"
    WHERE ${providerScopeSql(provider)}
      AND ses."usageCost" IS NULL
      AND ses."eventStatus" = 'NEEDS_COST_BACKFILL'
    ORDER BY o.id
  `;

  const targets = orgs.map((org) => org.id);

  const plans: RepairResult[] = [];
  let plannedTotalUsd = new Prisma.Decimal(0);
  for (const organizationId of targets) {
    log(`=== org ${organizationId} ===`);
    const plan = await runRepair({
      organizationId,
      prisma,
      provider,
      log: (line) => log(`  ${line}`),
    });
    plans.push(plan);
    plannedTotalUsd = plannedTotalUsd.add(plan.plannedTotalUsd);
  }

  log(
    "Per-org summary (org | unpriced candidates | priceable | $ | not qualified | no row | refused):",
  );
  for (const plan of plans) {
    const summary = summarize(plan);
    log(
      `  ${summary.organizationId} | ${summary.frozen} | ${summary.planned} | $${summary.plannedTotalUsd.toFixed(6)} | ` +
        `${summary.notQualified} | ${summary.skippedNoCatalogRow} | ${summary.refusedByGuard}`,
    );
  }
  log(
    `Grand total across ${plans.length} orgs: $${plannedTotalUsd.toFixed(6)}`,
  );

  if (maxTotalUsd != null && plannedTotalUsd.greaterThan(maxTotalUsd)) {
    throw new Error(
      `Planned grand total $${plannedTotalUsd.toFixed(6)} exceeds the --max-total-usd ceiling of $${maxTotalUsd}. ` +
        `Nothing was written. Fix: read the per-org lines above, then re-run with a ceiling you believe.`,
    );
  }

  if (!apply) {
    log("Dry run — no snapshot written, no rows changed. Re-run with --apply.");
    return {
      perOrg: plans.map(summarize),
      plannedTotalUsd,
      dryRun: true,
    };
  }

  const snapshotDir = path.resolve(options.snapshotDir ?? process.cwd());
  const applied: RepairResult[] = [];
  let spentUsd = new Prisma.Decimal(0);
  for (const plan of plans) {
    if (plan.planned.length === 0) continue;
    const result = await runRepair({
      organizationId: plan.organizationId,
      prisma,
      provider,
      apply: true,
      batchSize,
      maxTotalUsd: new Prisma.Decimal(maxTotalUsd!).sub(spentUsd).toNumber(),
      snapshotPath: path.join(
        snapshotDir,
        `repair-snapshot-${plan.organizationId}-${Date.now()}.json`,
      ),
      log: (line) => log(`  [${plan.organizationId}] ${line}`),
    });
    spentUsd = spentUsd.add(result.plannedTotalUsd);
    applied.push(result);
  }

  return {
    perOrg: applied.map(summarize),
    plannedTotalUsd: spentUsd,
    dryRun: false,
  };
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export type CliArgs =
  | { mode: "rollback"; rollbackPath: string }
  | {
      mode: "single" | "all";
      organizationId?: string;
      provider: ProviderScope;
      apply: boolean;
      batchSize?: number;
      maxTotalUsd?: number;
      snapshotPath?: string;
      snapshotDir?: string;
    };

export function parseCliArgs(argv: string[]): CliArgs {
  const rollbackPath = flagValue(argv, "--rollback");
  if (rollbackPath) return { mode: "rollback", rollbackPath };

  const provider = parseProviderScope(flagValue(argv, "--provider"));
  const apply = argv.includes("--apply");
  const maxTotalUsd = parseMaxTotalUsd(flagValue(argv, "--max-total-usd"));
  const batchSize = flagValue(argv, "--batch-size");
  assertCeilingForApply(apply, maxTotalUsd);

  const common = {
    provider,
    apply,
    batchSize: batchSize ? Number(batchSize) : undefined,
    maxTotalUsd,
  };
  if (argv.includes("--all-orgs")) {
    return {
      mode: "all",
      ...common,
      snapshotDir: flagValue(argv, "--snapshot-dir"),
    };
  }

  const organizationId = flagValue(argv, "--org-id");
  if (!organizationId) {
    throw new Error(
      "No organization given. Fix: pass --org-id <uuid> for one org, or --all-orgs to plan every org.",
    );
  }
  return {
    mode: "single",
    organizationId,
    ...common,
    snapshotPath: flagValue(argv, "--snapshot"),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    if (args.mode === "rollback") {
      await rollbackFromSnapshot(prisma, path.resolve(args.rollbackPath));
      return;
    }
    if (args.mode === "all") {
      await runRepairAllOrgs({
        prisma,
        provider: args.provider,
        apply: args.apply,
        batchSize: args.batchSize,
        maxTotalUsd: args.maxTotalUsd,
        snapshotDir: args.snapshotDir,
      });
      return;
    }
    await runRepair({
      organizationId: args.organizationId!,
      prisma,
      provider: args.provider,
      apply: args.apply,
      batchSize: args.batchSize,
      snapshotPath: args.snapshotPath,
      maxTotalUsd: args.maxTotalUsd,
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
