import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FEED_SOURCES,
  SNAPSHOT_FILE,
  buildSeedRows,
  describeSeedResult,
  parseSeedArgs,
  parseSnapshot,
  readSnapshot,
  prismaPricingStore,
  seedPricing,
  type PricingStore,
} from "../seed-pricing";
import { loadPackageEnvFile, requireDatabaseUrl } from "../package-env";
import {
  parseSnapshotArgs,
  renderSnapshot,
  snapshotRowsFromCatalog,
} from "../snapshot-pricing";
import {
  BUILT_IN_ROWS,
  KNOWN_COST_UNITS,
  type CatalogRow,
} from "../sync-service-pricing";

function fakeStore(
  initial: { externalId: string; source: string; isActive: boolean }[] = [],
) {
  const rows = new Map(initial.map((row) => [row.externalId, row]));
  const calls = { created: [] as CatalogRow[], updated: [] as CatalogRow[] };
  const store: PricingStore = {
    listRows: async () => Array.from(rows.values()),
    createMany: async (created) => {
      for (const row of created) {
        if (rows.has(row.externalId)) {
          throw new Error(`duplicate externalId ${row.externalId}`);
        }
        rows.set(row.externalId, row);
        calls.created.push(row);
      }
    },
    update: async (row) => {
      const current = rows.get(row.externalId);
      if (!current) {
        throw new Error(`no row to update: ${row.externalId}`);
      }
      rows.set(row.externalId, { ...row, isActive: current.isActive });
      calls.updated.push(row);
    },
  };
  return { store, calls, rows };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the committed price snapshot", () => {
  const snapshot = readSnapshot();
  const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));

  it("records the date it was captured and where its feed came from", () => {
    expect(snapshot.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(snapshot.capturedOn).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const urls = raw.sources.map((source: { url: string }) => source.url);
    expect(urls.some((url: string) => url.includes("BerriAI/litellm"))).toBe(
      true,
    );
  });

  it("holds a real catalog, not a stub", () => {
    expect(snapshot.rows.length).toBeGreaterThan(1000);
    const names = new Set(snapshot.rows.map((row) => row.externalId));
    expect(names.size).toBe(snapshot.rows.length);
  });

  it("holds feed rows only, each priced in a unit the cost math knows", () => {
    for (const row of snapshot.rows) {
      expect(FEED_SOURCES).toContain(row.source);
      expect(KNOWN_COST_UNITS.has(row.costUnit)).toBe(true);
    }
  });

  it("is sorted by externalId, so a refresh diffs row by row", () => {
    const ids = snapshot.rows.map((row) => row.externalId);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("buildSeedRows", () => {
  const snapshot = readSnapshot();
  const rows = buildSeedRows(snapshot);
  const byId = new Map(rows.map((row) => [row.externalId, row]));

  it("adds every built-in row from the code to the snapshot's feed rows", () => {
    for (const builtIn of BUILT_IN_ROWS) {
      expect(byId.get(builtIn.externalId)?.source).toBe("builtin");
    }
    expect(byId.get("outcome/work-item")).toMatchObject({
      provider: "outcome",
      canonicalName: "work-item",
      inputCost: 0,
      isActive: true,
    });
  });

  it("stores each snapshot price exactly as captured: the overrides are a no-op the second time", () => {
    const builtInIds = new Set(BUILT_IN_ROWS.map((entry) => entry.externalId));
    for (const captured of snapshot.rows) {
      if (builtInIds.has(captured.externalId)) continue;
      const built = byId.get(captured.externalId);
      expect(built, captured.externalId).toBeDefined();
      expect({
        inputCost: built?.inputCost,
        outputCost: built?.outputCost,
        cacheReadCost: built?.cacheReadCost,
        cacheWriteCost: built?.cacheWriteCost,
        costUnit: built?.costUnit,
      }).toEqual({
        inputCost: captured.inputCost,
        outputCost: captured.outputCost,
        cacheReadCost: captured.cacheReadCost ?? null,
        cacheWriteCost: captured.cacheWriteCost ?? null,
        costUnit: captured.costUnit,
      });
    }
  });
});

describe("seedPricing", () => {
  const snapshot = readSnapshot();
  const expectedCount = buildSeedRows(snapshot).length;

  it("fills an empty catalog without one network call", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the offline seed must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { store, calls } = fakeStore();

    const result = await seedPricing({ store, snapshot });

    expect(result).toEqual({
      created: expectedCount,
      updated: 0,
      leftSwitchedOff: 0,
    });
    expect(calls.created).toHaveLength(expectedCount);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the finished-work row the baseline migration already inserted, updating it in place", async () => {
    const { store, calls } = fakeStore([
      { externalId: "outcome/work-item", source: "builtin", isActive: true },
    ]);

    const result = await seedPricing({ store, snapshot });

    expect(result).toMatchObject({ created: expectedCount - 1, updated: 1 });
    expect(calls.updated.map((row) => row.externalId)).toEqual([
      "outcome/work-item",
    ]);
  });

  it("can be run twice: the second run updates every row and creates none", async () => {
    const { store } = fakeStore();
    await seedPricing({ store, snapshot });

    const second = await seedPricing({ store, snapshot });

    expect(second).toMatchObject({ created: 0, updated: expectedCount });
  });

  it("leaves a switched-off price off and untouched, and says how many", async () => {
    const retired = buildSeedRows(snapshot).find(
      (row) => row.source === "litellm",
    )!;
    const { store, calls, rows } = fakeStore([
      { externalId: retired.externalId, source: "litellm", isActive: false },
    ]);

    const result = await seedPricing({ store, snapshot });

    expect(result).toEqual({
      created: expectedCount - 1,
      updated: 0,
      leftSwitchedOff: 1,
    });
    expect(calls.updated).toHaveLength(0);
    expect(rows.get(retired.externalId)?.isActive).toBe(false);
    expect(describeSeedResult(result, snapshot.capturedOn)).toContain(
      "1 price(s) that are switched off in this database were left off",
    );
  });

  it("never writes isActive when it updates a row", async () => {
    const written: Record<string, unknown>[] = [];
    const prisma = {
      service_pricing: {
        update: async (args: { data: Record<string, unknown> }) => {
          written.push(args.data);
        },
      },
    } as unknown as Parameters<typeof prismaPricingStore>[0];

    await prismaPricingStore(prisma).update(buildSeedRows(snapshot)[0]);

    expect(written).toHaveLength(1);
    expect(written[0]).not.toHaveProperty("isActive");
    expect(written[0]).toHaveProperty("inputCost");
  });

  it("with --skip-if-newer, leaves a newer catalog alone and reports it instead of failing", async () => {
    const { store, calls } = fakeStore([
      {
        externalId: "newvendor/model-2099",
        source: "openrouter",
        isActive: true,
      },
    ]);

    const result = await seedPricing({ store, snapshot, skipIfNewer: true });

    expect(result.skippedNewerCatalog).toEqual({
      count: 1,
      example: "newvendor/model-2099",
    });
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(0);
    expect(describeSeedResult(result, snapshot.capturedOn)).toMatch(
      /left as it is.*newvendor\/model-2099.*Nothing was changed.*db:sync-pricing/s,
    );
  });

  it("refuses to roll back a catalog that a live sync has moved past the snapshot", async () => {
    const { store, calls } = fakeStore([
      {
        externalId: "newvendor/model-2099",
        source: "openrouter",
        isActive: true,
      },
    ]);

    await expect(seedPricing({ store, snapshot })).rejects.toThrow(
      /newvendor\/model-2099.*db:sync-pricing.*--force.*Nothing was changed/s,
    );
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(0);
  });

  it("loads the snapshot over a newer catalog when forced, and retires nothing", async () => {
    const { store, rows } = fakeStore([
      { externalId: "newvendor/model-2099", source: "litellm", isActive: true },
    ]);

    const result = await seedPricing({ store, snapshot, force: true });

    expect(result.created).toBe(expectedCount);
    expect(rows.get("newvendor/model-2099")?.isActive).toBe(true);
  });

  it("is not blocked by retired feed rows or by an operator's own rows", async () => {
    const { store } = fakeStore([
      {
        externalId: "oldvendor/retired",
        source: "openrouter",
        isActive: false,
      },
      { externalId: "custom/in-house-model", source: "custom", isActive: true },
    ]);

    await expect(seedPricing({ store, snapshot })).resolves.toMatchObject({
      created: expectedCount,
    });
  });
});

describe("a damaged snapshot stops the seed with a fix", () => {
  it("names the file when it is not JSON", () => {
    expect(() => parseSnapshot("{not json", "snap.json")).toThrow(
      /"snap\.json" is not valid JSON.*db:snapshot-pricing.*Nothing was changed/s,
    );
  });

  it("rejects a file with no rows", () => {
    expect(() =>
      parseSnapshot(
        JSON.stringify({ capturedOn: "2026-10-09", rows: [] }),
        "s",
      ),
    ).toThrow(/expected shape/);
  });

  it("rejects a hand-typed row smuggled into the snapshot", () => {
    const text = JSON.stringify({
      capturedOn: "2026-10-09",
      rows: [
        {
          externalId: "api/hand-typed",
          provider: "x",
          costUnit: "request",
          source: "builtin",
        },
      ],
    });
    expect(() => parseSnapshot(text, "s")).toThrow(
      /api\/hand-typed.*BUILT_IN_ROWS/s,
    );
  });

  it("explains a missing file", () => {
    expect(() => readSnapshot("/nonexistent/price-snapshot.json")).toThrow(
      /Could not read the price snapshot.*restore the file/s,
    );
  });
});

describe("command line and environment", () => {
  it("accepts no options or --force, and refuses anything else", () => {
    expect(parseSeedArgs([])).toEqual({ force: false, skipIfNewer: false });
    expect(parseSeedArgs(["--force"])).toEqual({
      force: true,
      skipIfNewer: false,
    });
    expect(parseSeedArgs(["--skip-if-newer"])).toEqual({
      force: false,
      skipIfNewer: true,
    });
    expect(() => parseSeedArgs(["--frce"])).toThrow(/Unknown option "--frce"/);
    expect(() => parseSeedArgs(["--force", "--skip-if-newer"])).toThrow(
      /opposite things.*Nothing was changed/s,
    );
  });

  it("db:setup loads prices with --skip-if-newer, so re-running it after a live sync does not fail", () => {
    const scripts = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).scripts as Record<string, string>;
    expect(scripts["db:setup"]).toMatch(/seed-pricing\.ts --skip-if-newer$/);
  });

  it("on a Node too old to read the .env file, says so instead of blaming a missing DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    const envFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "db-env-")),
      "settings",
    );
    fs.writeFileSync(envFile, "DATABASE_URL=postgresql://localhost/example\n");
    const loadEnvFile = process.loadEnvFile;
    // @ts-expect-error simulating Node older than 20.12
    process.loadEnvFile = undefined;
    try {
      expect(() => loadPackageEnvFile(envFile)).toThrow(
        /too old to read packages\/db\/\.env.*Node 20\.12 or newer.*export DATABASE_URL/s,
      );
    } finally {
      process.loadEnvFile = loadEnvFile;
    }
  });

  it("says how to fix a missing DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => requireDatabaseUrl()).toThrow(
      /DATABASE_URL is not set.*\.env\.example.*Nothing was changed/s,
    );
  });
});

describe("refreshing the snapshot", () => {
  const catalog = [
    {
      externalId: "tool/built-in-row",
      canonicalName: "built-in-row",
      displayName: "Built-in",
      provider: "tool",
      serviceType: "Search",
      inputCost: 1,
      outputCost: null,
      cacheReadCost: null,
      cacheWriteCost: null,
      costUnit: "1K requests",
      contextWindow: null,
      source: "builtin",
      isApi: true,
      isActive: true,
    },
    {
      externalId: "vendor/model-a",
      canonicalName: "model-a",
      displayName: "Model A",
      provider: "vendor",
      serviceType: "LLM",
      inputCost: 2,
      outputCost: 8,
      cacheReadCost: 0.2,
      cacheWriteCost: null,
      costUnit: "1M tokens",
      contextWindow: 128000,
      source: "openrouter",
      isApi: false,
      isActive: true,
    },
  ];

  it("keeps feed rows only, in the shape the seed reads", () => {
    const rows = snapshotRowsFromCatalog(catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "vendor/model-a",
      cacheReadCost: 0.2,
    });
    expect(rows[0]).not.toHaveProperty("isActive");
    expect(rows[0]).not.toHaveProperty("canonicalName");
  });

  it("writes a file the seed reads back, keeping the attribution header and stamping the new date", () => {
    const previous = fs.readFileSync(SNAPSHOT_FILE, "utf8");
    const text = renderSnapshot(
      previous,
      snapshotRowsFromCatalog(catalog),
      "2026-12-01",
    );

    const reread = parseSnapshot(text, "refreshed");
    expect(reread.capturedOn).toBe("2026-12-01");
    expect(reread.rows).toHaveLength(1);
    expect(JSON.parse(text).sources).toEqual(JSON.parse(previous).sources);
  });

  it("takes an optional saved LiteLLM file and refuses anything else", () => {
    expect(parseSnapshotArgs([])).toEqual({});
    expect(parseSnapshotArgs(["--litellm-file", "feed.json"])).toEqual({
      litellmFile: "feed.json",
    });
    expect(() => parseSnapshotArgs(["--openrouter-file", "o.json"])).toThrow(
      /only option is --litellm-file.*Nothing was changed/,
    );
    expect(() => parseSnapshotArgs(["--litellm-file"])).toThrow(
      /Unknown arguments/,
    );
  });

  it("ships LiteLLM rows only", () => {
    const sources = new Set(readSnapshot().rows.map((row) => row.source));
    expect([...sources]).toEqual(["litellm"]);
  });
});
