/**
 * Rebuilds data/price-catalog-snapshot.json from the LiteLLM feed alone, so
 * `npm run db:seed-pricing` loads newer prices offline. The snapshot ships in
 * the repository, so it holds MIT-licensed LiteLLM data only and never
 * OpenRouter's. Needs internet unless --litellm-file names a saved copy of
 * LiteLLM's model_prices_and_context_window.json. Touches no database.
 *
 * Run with: npm run db:snapshot-pricing        (from packages/db)
 *     or:   npm run db:snapshot-pricing -- --litellm-file <path>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FEED_SOURCES, SNAPSHOT_FILE } from "./seed-pricing";
import { main as syncPricing, type CatalogRow } from "./sync-service-pricing";

export function snapshotRowsFromCatalog(catalog: CatalogRow[]) {
  return catalog
    .filter((row) => FEED_SOURCES.includes(row.source))
    .map((row) => ({
      externalId: row.externalId,
      displayName: row.displayName,
      provider: row.provider,
      serviceType: row.serviceType,
      inputCost: row.inputCost,
      outputCost: row.outputCost,
      cacheReadCost: row.cacheReadCost,
      cacheWriteCost: row.cacheWriteCost,
      costUnit: row.costUnit,
      contextWindow: row.contextWindow,
      source: row.source,
      isApi: row.isApi,
    }));
}

export function renderSnapshot(
  previousText: string,
  rows: ReturnType<typeof snapshotRowsFromCatalog>,
  capturedOn: string,
): string {
  const { rows: _replaced, ...header } = JSON.parse(previousText);
  const head = JSON.stringify({ ...header, capturedOn }, null, 2);
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return `${head.replace(/\n}$/, "")},\n  "rows": [\n${body}\n  ]\n}\n`;
}

const USAGE = "Usage: npm run db:snapshot-pricing [-- --litellm-file <path>]";

export function parseSnapshotArgs(argv: string[]): { litellmFile?: string } {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--litellm-file" && argv[1] !== "") {
    return { litellmFile: argv[1] };
  }
  throw new Error(
    `Unknown arguments "${argv.join(" ")}". The only option is ` +
      `--litellm-file <path>, a saved copy of LiteLLM's ` +
      `model_prices_and_context_window.json. Nothing was changed. ${USAGE}`,
  );
}

async function main(): Promise<void> {
  const { litellmFile } = parseSnapshotArgs(process.argv.slice(2));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-snapshot-"));
  const catalogFile = path.join(workDir, "catalog.json");
  try {
    await syncPricing({
      dryRun: true,
      out: catalogFile,
      litellmOnly: true,
      litellmFile,
    });
    const rows = snapshotRowsFromCatalog(
      JSON.parse(fs.readFileSync(catalogFile, "utf8")),
    );
    const capturedOn = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      SNAPSHOT_FILE,
      renderSnapshot(fs.readFileSync(SNAPSHOT_FILE, "utf8"), rows, capturedOn),
    );
    console.log(
      `Wrote ${rows.length} feed prices dated ${capturedOn} to ${SNAPSHOT_FILE}. ` +
        `Commit the file to ship them.`,
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
