/**
 * Catalog dry-run contract for sync-service-pricing.ts.
 *
 *   npx tsx sync-service-pricing.ts --dry-run --out <file.json>
 *       [--litellm-file <path>] [--openrouter-file <path>] [--save-feeds <dir>]
 *
 * A dry run computes exactly the rows a real run would upsert — the same
 * builder feeds both paths — and writes them sorted by externalId with numeric
 * prices, without constructing a PrismaClient or touching the network when
 * feed files are given. Hermetic: Prisma, fetch and the filesystem targets are
 * all faked or scoped to a temp directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  current: null as unknown as ReturnType<typeof createFakePrisma>,
  constructions: 0,
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      mockDb.constructions += 1;
      return new Proxy(
        {},
        {
          get: (_target, prop) =>
            (mockDb.current.client as Record<PropertyKey, unknown>)[prop],
        },
      );
    }
  },
}));

import {
  BUILT_IN_ROWS,
  buildCatalogRows,
  main,
  normalizeLiteLLM,
  normalizeOpenRouter,
  parseCliArgs,
  type CatalogRow,
} from "../sync-service-pricing";

interface RecordedCall {
  op: string;
  args: unknown;
}

function createFakePrisma() {
  const calls: RecordedCall[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const service_pricing = {
    async findMany(args: unknown) {
      calls.push({ op: "findMany", args });
      return [...rows.values()].map((row) => ({
        externalId: row.externalId,
      }));
    },
    async upsert(args: {
      where: { externalId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) {
      calls.push({ op: "upsert", args });
      const existing = rows.get(args.where.externalId);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      rows.set(args.where.externalId, { ...args.create });
      return args.create;
    },
    async updateMany(args: unknown) {
      calls.push({ op: "updateMany", args });
      return { count: 0 };
    },
  };
  return {
    calls,
    rows,
    client: {
      service_pricing,
      async $disconnect() {
        calls.push({ op: "$disconnect", args: undefined });
      },
    },
  };
}

const GPT_4O = {
  id: "openai/gpt-4o",
  name: "OpenAI: GPT-4o",
  pricing: { prompt: "0.0000025", completion: "0.00001" },
  context_length: 128000,
};

const SONNET = {
  id: "anthropic/claude-sonnet-4.6",
  name: "Anthropic: Claude Sonnet 4.6",
  pricing: {
    prompt: "0.000003",
    completion: "0.000015",
    input_cache_read: "0.0000003",
    input_cache_write: "0.00000375",
  },
  context_length: 200000,
};

const GEMINI_25_FLASH_BATCH = {
  id: "google/gemini-2.5-flash:batch",
  name: "Google: Gemini 2.5 Flash (batch)",
  pricing: {
    prompt: "0.00000015",
    completion: "0.00000125",
    input_cache_read: "0.00000003",
  },
  context_length: 1048576,
};

const LITELLM_FEED = {
  "gemini/gemini-2.0-flash": {
    mode: "chat",
    input_cost_per_token: 1e-7,
    output_cost_per_token: 4e-7,
    litellm_provider: "gemini",
    max_input_tokens: 1048576,
  },
  "whisper-1": {
    mode: "audio_transcription",
    input_cost_per_second: 0.0001,
    litellm_provider: "openai",
  },
};

const OPENROUTER_FEED = { data: [GPT_4O, SONNET, GEMINI_25_FLASH_BATCH] };

function stubNetwork(
  openRouter: unknown = OPENROUTER_FEED,
  litellm: unknown = LITELLM_FEED,
) {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).includes("openrouter.ai")) {
      return { ok: true, json: async () => openRouter };
    }
    return { ok: true, json: async () => litellm };
  });
}

function stubNetworkDown() {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network reached during a file-fed run");
  });
}

function readCatalog(file: string): CatalogRow[] {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

let tempDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockDb.current = createFakePrisma();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-dry-run-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("--dry-run never touches the database", () => {
  it("constructs no PrismaClient and issues no query, even on a fresh module", async () => {
    vi.resetModules();
    // Captured BEFORE the import so a client built at module load counts.
    const constructionsBefore = mockDb.constructions;
    const fresh = await import("../sync-service-pricing");
    stubNetwork();
    const out = path.join(tempDir, "nested", "catalog.json");

    await fresh.main({ dryRun: true, out });

    expect(mockDb.constructions).toBe(constructionsBefore);
    expect(mockDb.current.calls).toHaveLength(0);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("writes one summary line to stdout and every progress line to stderr", async () => {
    stubNetwork();
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out });

    expect(logSpy.mock.calls).toHaveLength(1);
    const summary = String(logSpy.mock.calls[0][0]);
    expect(summary).toMatch(/^Dry run: wrote \d+ catalog rows to /);
    expect(summary).toContain(out);
    expect(summary).toContain("no database was touched");
    expect(summary).toContain(
      `(builtin ${BUILT_IN_ROWS.length}, litellm 2, openrouter 3)`,
    );
    expect(summary).toContain(`wrote ${5 + BUILT_IN_ROWS.length} catalog rows`);
    const stderrLines = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => line.includes("Fetching from"))).toBe(
      true,
    );
    expect(stderrLines.some((line) => line.includes("Final counts"))).toBe(
      true,
    );
  });
});

describe("--out file shape", () => {
  it("is a JSON array sorted by externalId with numeric-or-null prices and every persisted column", async () => {
    stubNetwork();
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out });

    const catalog = readCatalog(out);
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBe(5 + BUILT_IN_ROWS.length);

    const ids = catalog.map((row) => row.externalId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);

    const persistedColumns = [
      "externalId",
      "canonicalName",
      "displayName",
      "provider",
      "serviceType",
      "inputCost",
      "outputCost",
      "cacheReadCost",
      "cacheWriteCost",
      "costUnit",
      "contextWindow",
      "source",
      "isApi",
      "isActive",
    ];
    for (const row of catalog) {
      expect(Object.keys(row).sort()).toEqual([...persistedColumns].sort());
      for (const price of [
        "inputCost",
        "outputCost",
        "cacheReadCost",
        "cacheWriteCost",
      ] as const) {
        const value = row[price];
        expect(
          value === null || typeof value === "number",
          `${row.externalId}.${price} is ${typeof value}`,
        ).toBe(true);
      }
      expect(row.isActive).toBe(true);
    }

    const gpt = catalog.find((row) => row.externalId === "openai/gpt-4o")!;
    expect(gpt.inputCost).toBe(2.5);
    expect(gpt.outputCost).toBe(10);
    expect(gpt.source).toBe("openrouter");

    const whisper = catalog.find(
      (row) => row.externalId === "litellm/whisper-1",
    )!;
    expect(whisper.costUnit).toBe("second");
    expect(whisper.inputCost).toBe(0.0001);
    expect(whisper.outputCost).toBeNull();
  });

  it("carries every merge-time override and backfill the real run applies", async () => {
    stubNetwork();
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out });

    const catalog = readCatalog(out);
    const sonnet = catalog.find(
      (row) => row.externalId === "anthropic/claude-sonnet-4.6",
    )!;
    expect(sonnet.cacheWriteCost).toBe(6);

    const batch = catalog.find(
      (row) => row.externalId === "google/gemini-2.5-flash:batch",
    )!;
    expect(batch.cacheWriteCost).toBe(0.0833333333);

    const websearch = catalog.find(
      (row) => row.externalId === "tool/websearch",
    )!;
    expect(websearch.source).toBe("builtin");
    expect(websearch.inputCost).toBe(10);
  });
});

describe("one builder feeds both paths", () => {
  it("the real run upserts exactly buildCatalogRows' rows, in order, and the dry run writes the same rows sorted", async () => {
    const fake = mockDb.current;
    stubNetwork();
    await main();

    const upserted = fake.calls
      .filter((call) => call.op === "upsert")
      .map(
        (call) =>
          (call.args as { create: CatalogRow; update: Record<string, unknown> })
            .create,
      );
    const { rows } = buildCatalogRows(
      normalizeOpenRouter(OPENROUTER_FEED),
      normalizeLiteLLM(LITELLM_FEED),
    );
    expect(upserted).toEqual(rows);
    expect(upserted.length).toBe(5 + BUILT_IN_ROWS.length);

    for (const call of fake.calls.filter((c) => c.op === "upsert")) {
      const { create, update } = call.args as {
        create: CatalogRow;
        update: Record<string, unknown>;
      };
      const { externalId, ...columns } = create;
      expect(update).toEqual(columns);
      expect(externalId).toBeDefined();
    }

    const out = path.join(tempDir, "catalog.json");
    await main({ dryRun: true, out });
    const expected = JSON.parse(
      JSON.stringify(
        [...rows].sort((a, b) =>
          a.externalId < b.externalId
            ? -1
            : a.externalId > b.externalId
              ? 1
              : 0,
        ),
      ),
    );
    expect(readCatalog(out)).toEqual(expected);
  });

  it("a feed row colliding with a built-in externalId yields ONE persisted row, the built-in one, in both paths", async () => {
    const fake = mockDb.current;
    const impostor = {
      id: "tool/bash",
      name: "Impostor: bash-llm",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      context_length: 8192,
    };
    stubNetwork({ data: [GPT_4O, impostor] }, LITELLM_FEED);

    await main();
    const bashUpserts = fake.calls.filter(
      (call) =>
        call.op === "upsert" &&
        (call.args as { where: { externalId: string } }).where.externalId ===
          "tool/bash",
    );
    expect(bashUpserts).toHaveLength(1);
    expect(fake.rows.get("tool/bash")!.source).toBe("builtin");
    expect(fake.rows.get("tool/bash")!.inputCost).toBe(0);

    const out = path.join(tempDir, "catalog.json");
    await main({ dryRun: true, out });
    const bashRows = readCatalog(out).filter(
      (row) => row.externalId === "tool/bash",
    );
    expect(bashRows).toHaveLength(1);
    expect(bashRows[0].source).toBe("builtin");
    expect(bashRows[0].inputCost).toBe(0);
  });
});

describe("feed files", () => {
  it("--litellm-file and --openrouter-file replace the network entirely", async () => {
    stubNetworkDown();
    const openRouterFile = path.join(tempDir, "openrouter.json");
    const litellmFile = path.join(tempDir, "litellm.json");
    fs.writeFileSync(openRouterFile, JSON.stringify(OPENROUTER_FEED));
    fs.writeFileSync(litellmFile, JSON.stringify(LITELLM_FEED));
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out, openRouterFile, litellmFile });

    const catalog = readCatalog(out);
    expect(catalog.length).toBe(5 + BUILT_IN_ROWS.length);
    expect(
      catalog.find(
        (row) => row.externalId === "litellm/gemini/gemini-2.0-flash",
      )!.outputCost,
    ).toBe(0.4);
    expect(mockDb.current.calls).toHaveLength(0);
  });

  it("prices are rounded to the column's 10 decimals in both paths, so the file equals the persisted value", async () => {
    // 4e-7 x 1e6 is 0.39999999999999997 in JS; Decimal(18,10) stores 0.4.
    const fake = mockDb.current;
    stubNetwork();
    await main();
    expect(fake.rows.get("litellm/gemini/gemini-2.0-flash")!.outputCost).toBe(
      0.4,
    );

    const out = path.join(tempDir, "catalog.json");
    await main({ dryRun: true, out });
    expect(fs.readFileSync(out, "utf8")).toContain('"outputCost": 0.4,');
    for (const row of readCatalog(out)) {
      for (const price of [
        row.inputCost,
        row.outputCost,
        row.cacheReadCost,
        row.cacheWriteCost,
      ]) {
        if (price === null) continue;
        expect(Number(price.toFixed(10)), row.externalId).toBe(price);
      }
    }
  });

  it("two runs over the same feed files produce byte-identical catalogs", async () => {
    stubNetworkDown();
    const openRouterFile = path.join(tempDir, "openrouter.json");
    const litellmFile = path.join(tempDir, "litellm.json");
    fs.writeFileSync(openRouterFile, JSON.stringify(OPENROUTER_FEED));
    fs.writeFileSync(litellmFile, JSON.stringify(LITELLM_FEED));
    const first = path.join(tempDir, "first.json");
    const second = path.join(tempDir, "second.json");

    await main({ dryRun: true, out: first, openRouterFile, litellmFile });
    await main({ dryRun: true, out: second, openRouterFile, litellmFile });

    expect(fs.readFileSync(first, "utf8")).toBe(
      fs.readFileSync(second, "utf8"),
    );
  });

  it("--save-feeds writes the fetched payloads to <dir>/openrouter.json and <dir>/litellm.json", async () => {
    stubNetwork();
    const saveFeeds = path.join(tempDir, "feeds");
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out, saveFeeds });

    expect(
      JSON.parse(
        fs.readFileSync(path.join(saveFeeds, "openrouter.json"), "utf8"),
      ),
    ).toEqual(OPENROUTER_FEED);
    expect(
      JSON.parse(fs.readFileSync(path.join(saveFeeds, "litellm.json"), "utf8")),
    ).toEqual(LITELLM_FEED);
  });

  it("a saved feed replayed through the file flags reproduces the network run's catalog", async () => {
    stubNetwork();
    const saveFeeds = path.join(tempDir, "feeds");
    const fromNetwork = path.join(tempDir, "network.json");
    await main({ dryRun: true, out: fromNetwork, saveFeeds });

    stubNetworkDown();
    const fromFiles = path.join(tempDir, "files.json");
    await main({
      dryRun: true,
      out: fromFiles,
      openRouterFile: path.join(saveFeeds, "openrouter.json"),
      litellmFile: path.join(saveFeeds, "litellm.json"),
    });

    expect(fs.readFileSync(fromFiles, "utf8")).toBe(
      fs.readFileSync(fromNetwork, "utf8"),
    );
  });

  it("the zero-remote-rows guard still aborts on empty feed files, and writes no --out", async () => {
    stubNetworkDown();
    const openRouterFile = path.join(tempDir, "openrouter.json");
    const litellmFile = path.join(tempDir, "litellm.json");
    fs.writeFileSync(openRouterFile, JSON.stringify({ data: [] }));
    fs.writeFileSync(litellmFile, "{}");
    const out = path.join(tempDir, "catalog.json");

    await expect(
      main({ dryRun: true, out, openRouterFile, litellmFile }),
    ).rejects.toThrow(/zero usable pricing entries/);
    expect(fs.existsSync(out)).toBe(false);
    expect(mockDb.current.calls).toHaveLength(0);
  });

  it("a missing feed file aborts with the path in the message instead of silently running one-feed", async () => {
    stubNetworkDown();
    const litellmFile = path.join(tempDir, "does-not-exist.json");
    const out = path.join(tempDir, "catalog.json");

    await expect(main({ dryRun: true, out, litellmFile })).rejects.toThrow(
      /does-not-exist\.json/,
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it("a feed file that is not JSON aborts and names the file", async () => {
    stubNetworkDown();
    const openRouterFile = path.join(tempDir, "openrouter.json");
    fs.writeFileSync(openRouterFile, "{ not json");
    const out = path.join(tempDir, "catalog.json");

    await expect(main({ dryRun: true, out, openRouterFile })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it("an OpenRouter fetch failure leaves LiteLLM to price alone and says so", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("openrouter.ai")) {
        throw new Error("openrouter down");
      }
      return { ok: true, json: async () => LITELLM_FEED };
    });
    const out = path.join(tempDir, "catalog.json");

    await main({ dryRun: true, out });

    const sources = new Set(
      (JSON.parse(fs.readFileSync(out, "utf8")) as { source: string }[]).map(
        (row) => row.source,
      ),
    );
    expect([...sources].sort()).toEqual(["builtin", "litellm"]);
    expect(mockDb.current.calls).toHaveLength(0);
    expect(
      errorSpy.mock.calls.some((args) =>
        String(args[0]).includes(
          "OpenRouter returned zero usable pricing entries",
        ),
      ),
    ).toBe(true);
    const fetchFailure = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("OpenRouter fetch failed"));
    expect(fetchFailure).toBeDefined();
  });
});

describe("a feed that loads but no longer parses aborts the whole run", () => {
  it("real run: a LiteLLM body of [null] aborts before any database call, naming the feed", async () => {
    stubNetwork(OPENROUTER_FEED, [null]);

    await expect(main()).rejects.toThrow(
      /LiteLLM feed loaded but has an entry this script cannot read/,
    );
    expect(mockDb.current.calls).toHaveLength(0);
  });

  it("real run: an OpenRouter model without an id aborts the same way", async () => {
    stubNetwork(
      { data: [{ pricing: { prompt: "0.000001", completion: "0.000002" } }] },
      LITELLM_FEED,
    );

    await expect(main()).rejects.toThrow(
      /OpenRouter feed loaded but has an entry this script cannot read/,
    );
    expect(mockDb.current.calls).toHaveLength(0);
  });

  it("dry run: the same abort writes no --out and says what to fix", async () => {
    stubNetwork(OPENROUTER_FEED, [null]);
    const out = path.join(tempDir, "catalog.json");

    await expect(main({ dryRun: true, out })).rejects.toThrow(
      /Fix: open https:\/\/raw\.githubusercontent\.com.*Nothing was changed/,
    );
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("unwritable output paths fail early with a what/why/fix message", () => {
  it("--out pointing at an existing directory aborts before any feed is fetched", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network reached before the --out check");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = path.join(tempDir, "i-am-a-directory");
    fs.mkdirSync(out);

    await expect(main({ dryRun: true, out })).rejects.toThrow(
      /Could not write to ".*i-am-a-directory" for --out \(it is a directory, not a file\).*Fix:.*Nothing was changed/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--save-feeds pointing at an existing file aborts before any feed is fetched", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network reached before the --save-feeds check");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const saveFeeds = path.join(tempDir, "not-a-dir.json");
    fs.writeFileSync(saveFeeds, "{}");
    const out = path.join(tempDir, "catalog.json");

    await expect(main({ dryRun: true, out, saveFeeds })).rejects.toThrow(
      /Could not write to ".*not-a-dir\.json" for --save-feeds \(.*\).*directory this user can write to.*Nothing was changed/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("parseCliArgs", () => {
  it("parses the documented flags", () => {
    expect(
      parseCliArgs([
        "--dry-run",
        "--out",
        "/tmp/catalog.json",
        "--litellm-file",
        "/tmp/litellm.json",
        "--openrouter-file",
        "/tmp/openrouter.json",
        "--save-feeds",
        "/tmp/feeds",
      ]),
    ).toEqual({
      dryRun: true,
      out: "/tmp/catalog.json",
      litellmFile: "/tmp/litellm.json",
      openRouterFile: "/tmp/openrouter.json",
      saveFeeds: "/tmp/feeds",
    });
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(["--litellm-only"])).toEqual({ litellmOnly: true });
  });

  it("refuses --litellm-only with --openrouter-file, since the file would never be read", () => {
    expect(() =>
      parseCliArgs([
        "--dry-run",
        "--out",
        "x.json",
        "--litellm-only",
        "--openrouter-file",
        "o.json",
      ]),
    ).toThrow(/--litellm-only skips the OpenRouter feed.*did not run/);
  });

  it("refuses --dry-run without --out, --out without --dry-run, a flag with no value, and an unknown flag", () => {
    expect(() => parseCliArgs(["--dry-run"])).toThrow(/--out/);
    expect(() => parseCliArgs(["--out", "x.json"])).toThrow(/--dry-run/);
    expect(() => parseCliArgs(["--dry-run", "--out"])).toThrow(/needs a path/);
    expect(() =>
      parseCliArgs(["--dry-run", "--out", "--save-feeds", "d"]),
    ).toThrow(/needs a path/);
    expect(() => parseCliArgs(["--dryrun"])).toThrow(/Unknown argument/);
  });

  it("refuses a feed file on a real sync: a stale file would overwrite and retire live prices", () => {
    expect(() => parseCliArgs(["--litellm-file", "old.json"])).toThrow(
      /--litellm-file only work with --dry-run.*retire every row missing from it.*Fix:.*The script did not run/,
    );
    expect(() =>
      parseCliArgs([
        "--litellm-file",
        "old.json",
        "--openrouter-file",
        "old2.json",
      ]),
    ).toThrow(/--litellm-file and --openrouter-file only work with --dry-run/);
    expect(() => parseCliArgs(["--openrouter-file", "old.json"])).toThrow(
      /--openrouter-file only work with --dry-run/,
    );
    // --save-feeds stays allowed on a real sync: it only records what was fetched.
    expect(parseCliArgs(["--save-feeds", "feeds"])).toEqual({
      saveFeeds: "feeds",
    });
  });
});
