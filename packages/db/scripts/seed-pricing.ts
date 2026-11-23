/**
 * Loads the model price catalog (service_pricing) from the snapshot committed
 * in this repo. No network call.
 *
 * Run with: npm run db:seed-pricing            (from packages/db)
 * Reload over a newer catalog: npm run db:seed-pricing -- --force
 * Leave a newer catalog alone and exit cleanly (what db:setup does):
 *   npm run db:seed-pricing -- --skip-if-newer
 *
 * For the latest prices from the live feeds, run `npm run db:sync-pricing`
 * instead (needs internet).
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadPackageEnvFile, requireDatabaseUrl } from "./package-env";
import {
  finishCatalogRows,
  type CatalogRow,
  type NormalizedEntry,
} from "./sync-service-pricing";

export const SNAPSHOT_FILE = path.join(
  __dirname,
  "..",
  "data",
  "price-catalog-snapshot.json",
);

export const FEED_SOURCES = ["openrouter", "litellm"];

export interface PriceSnapshot {
  capturedOn: string;
  rows: NormalizedEntry[];
}

const REFRESH_FIX =
  "Fix: restore the file from the repository, or rebuild it with " +
  "`npm run db:snapshot-pricing` (needs internet). Nothing was changed.";

export function parseSnapshot(text: string, file: string): PriceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `The price snapshot "${file}" is not valid JSON. It was probably ` +
        `truncated or hand-edited. ${REFRESH_FIX}`,
    );
  }

  const snapshot = parsed as Partial<PriceSnapshot> | null;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    typeof snapshot.capturedOn !== "string" ||
    Number.isNaN(new Date(snapshot.capturedOn).getTime()) ||
    !Array.isArray(snapshot.rows) ||
    snapshot.rows.length === 0
  ) {
    throw new Error(
      `The price snapshot "${file}" does not have the expected shape: a ` +
        `"capturedOn" date and a non-empty "rows" list. It was probably ` +
        `hand-edited or written by a different tool. ${REFRESH_FIX}`,
    );
  }

  const badRows = snapshot.rows.filter(
    (row) =>
      row === null ||
      typeof row !== "object" ||
      typeof row.externalId !== "string" ||
      typeof row.provider !== "string" ||
      typeof row.costUnit !== "string" ||
      !FEED_SOURCES.includes(row.source),
  );
  if (badRows.length > 0) {
    const examples = badRows
      .slice(0, 5)
      .map((row) => JSON.stringify(row?.externalId ?? row))
      .join(", ");
    throw new Error(
      `The price snapshot "${file}" has ${badRows.length} row(s) without an ` +
        `externalId, provider, costUnit or a feed source ` +
        `(${FEED_SOURCES.join(" or ")}): ${examples}. Prices typed ` +
        `by hand belong in BUILT_IN_ROWS in sync-service-pricing.ts, not in ` +
        `the snapshot. ${REFRESH_FIX}`,
    );
  }

  return { capturedOn: snapshot.capturedOn, rows: snapshot.rows };
}

export function readSnapshot(file: string = SNAPSHOT_FILE): PriceSnapshot {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read the price snapshot "${file}" ` +
        `(${err instanceof Error ? err.message : String(err)}). ${REFRESH_FIX}`,
    );
  }
  return parseSnapshot(text, file);
}

export function buildSeedRows(snapshot: PriceSnapshot): CatalogRow[] {
  return finishCatalogRows(snapshot.rows);
}

export interface PricingStore {
  /** externalId and source of every row, plus whether it is active. */
  listRows(): Promise<
    { externalId: string; source: string; isActive: boolean }[]
  >;
  createMany(rows: CatalogRow[]): Promise<void>;
  update(row: CatalogRow): Promise<void>;
}

export interface SeedResult {
  created: number;
  updated: number;
  /** Rows already in the database and switched off, which the seed leaves alone. */
  leftSwitchedOff: number;
  /** Set when nothing was written because the catalog is newer than the snapshot. */
  skippedNewerCatalog?: { count: number; example: string };
}

export async function seedPricing(args: {
  store: PricingStore;
  snapshot: PriceSnapshot;
  force?: boolean;
  skipIfNewer?: boolean;
}): Promise<SeedResult> {
  const rows = buildSeedRows(args.snapshot);
  const seedIds = new Set(rows.map((row) => row.externalId));
  const existing = await args.store.listRows();

  // A feed-priced row the snapshot has never heard of can only have come from
  // a later live sync, so the snapshot would roll that database's prices back.
  const newerThanSnapshot = existing.filter(
    (row) =>
      row.isActive &&
      FEED_SOURCES.includes(row.source) &&
      !seedIds.has(row.externalId),
  );
  if (newerThanSnapshot.length > 0 && !args.force) {
    if (args.skipIfNewer) {
      return {
        created: 0,
        updated: 0,
        leftSwitchedOff: 0,
        skippedNewerCatalog: {
          count: newerThanSnapshot.length,
          example: newerThanSnapshot[0].externalId,
        },
      };
    }
    throw new Error(
      `Seeding stopped before any database write: this database already ` +
        `holds ${newerThanSnapshot.length} model price(s) that are not in ` +
        `the snapshot from ${args.snapshot.capturedOn} (for example ` +
        `"${newerThanSnapshot[0].externalId}"). That means it was synced ` +
        `from the live feeds more recently, and loading the snapshot would ` +
        `put older prices back. Fix: do nothing if your prices are current; ` +
        `run \`npm run db:sync-pricing\` for the latest prices; or re-run ` +
        `with --force to load the snapshot anyway. Nothing was changed.`,
    );
  }

  // A row someone switched off (a live sync retiring a model, or an operator by
  // hand) stays off and keeps its values: the seed never turns a price back on.
  const switchedOffIds = new Set(
    existing.filter((row) => !row.isActive).map((row) => row.externalId),
  );
  const existingIds = new Set(existing.map((row) => row.externalId));
  const toCreate = rows.filter((row) => !existingIds.has(row.externalId));
  const toUpdate = rows.filter(
    (row) =>
      existingIds.has(row.externalId) && !switchedOffIds.has(row.externalId),
  );
  const leftSwitchedOff = rows.filter((row) =>
    switchedOffIds.has(row.externalId),
  ).length;

  if (toCreate.length > 0) await args.store.createMany(toCreate);
  for (const row of toUpdate) await args.store.update(row);

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    leftSwitchedOff,
  };
}

export function prismaPricingStore(prisma: PrismaClient): PricingStore {
  return {
    listRows: () =>
      prisma.service_pricing.findMany({
        select: { externalId: true, source: true, isActive: true },
      }),
    createMany: async (rows) => {
      await prisma.service_pricing.createMany({ data: rows });
    },
    update: async (row) => {
      const { externalId, isActive: _neverWritten, ...columns } = row;
      await prisma.service_pricing.update({
        where: { externalId },
        data: columns,
      });
    },
  };
}

const USAGE = "Usage: npm run db:seed-pricing [-- --force | --skip-if-newer]";
const OPTIONS = ["--force", "--skip-if-newer"];

export function parseSeedArgs(argv: string[]): {
  force: boolean;
  skipIfNewer: boolean;
} {
  const unknown = argv.filter((arg) => !OPTIONS.includes(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option ${unknown.map((arg) => `"${arg}"`).join(", ")}. The ` +
        `options are --force, which loads the snapshot even over a newer ` +
        `catalog, and --skip-if-newer, which leaves a newer catalog alone ` +
        `without failing. Nothing was changed. ${USAGE}`,
    );
  }
  const force = argv.includes("--force");
  const skipIfNewer = argv.includes("--skip-if-newer");
  if (force && skipIfNewer) {
    throw new Error(
      `--force and --skip-if-newer ask for opposite things: one loads the ` +
        `snapshot over a newer catalog, the other leaves it alone. Fix: pass ` +
        `one of them. Nothing was changed. ${USAGE}`,
    );
  }
  return { force, skipIfNewer };
}

export function describeSeedResult(
  result: SeedResult,
  capturedOn: string,
): string {
  if (result.skippedNewerCatalog) {
    const { count, example } = result.skippedNewerCatalog;
    return (
      `Price catalog left as it is: this database holds ${count} model ` +
      `price(s) newer than the ${capturedOn} snapshot (for example ` +
      `"${example}"), so it was synced from the live feeds more recently. ` +
      `Nothing was changed. For the latest prices run ` +
      `\`npm run db:sync-pricing\` (needs internet).`
    );
  }
  const switchedOff =
    result.leftSwitchedOff > 0
      ? ` ${result.leftSwitchedOff} price(s) that are switched off in this ` +
        `database were left off and unchanged.`
      : "";
  return (
    `Price catalog loaded from the ${capturedOn} snapshot: ` +
    `${result.created} created, ${result.updated} updated.${switchedOff} ` +
    `For newer prices run \`npm run db:sync-pricing\` (needs internet).`
  );
}

async function main(): Promise<void> {
  const { force, skipIfNewer } = parseSeedArgs(process.argv.slice(2));
  const snapshot = readSnapshot();
  loadPackageEnvFile();
  requireDatabaseUrl();

  const prisma = new PrismaClient();
  try {
    const result = await seedPricing({
      store: prismaPricingStore(prisma),
      snapshot,
      force,
      skipIfNewer,
    });
    console.log(describeSeedResult(result, snapshot.capturedOn));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
