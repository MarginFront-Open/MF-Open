/**
 * Suite for sync-service-pricing.ts.
 *
 * service_pricing.id is a cascade anchor: org_model_mappings.targetPricingId
 * and signal_services.servicePricingId both declare onDelete: Cascade
 * (schema.prisma). A sync that ran deleteMany({}) + createMany on every run
 * would cascade-delete every org's private model mappings. These tests pin the
 * contract: all writes are upserts keyed on the
 * externalId unique, absent rows retire via isActive=false, a run missing
 * the LiteLLM feed aborts before any write, and no delete of any kind is ever
 * issued. Hermetic: Prisma and fetch are
 * faked; no database, no network.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockDb = vi.hoisted(() => ({
  current: null as unknown as ReturnType<typeof createFakePrisma>,
}));

// The proxy defers to mockDb.current at call time, so the script's single
// module-level `new PrismaClient()` picks up each test's fresh fake.
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
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
  CACHE_RATE_BACKFILLS,
  BUILT_IN_ROWS,
  KNOWN_COST_UNITS,
  OUTPUT_RATE_PINS,
  buildCatalogRows,
  main,
  normalizeLiteLLM,
} from "../sync-service-pricing";
import {
  findIncompleteCachePricing,
  type CachePricingRow,
} from "../report-cache-pricing";

interface RecordedCall {
  op: string;
  args: unknown;
  branch?: "create" | "update";
}

interface FakeRow {
  id: string;
  externalId: string;
  isActive: boolean;
  [field: string]: unknown;
}

function createFakePrisma() {
  const calls: RecordedCall[] = [];
  const rows = new Map<string, FakeRow>();
  let nextId = 0;

  const service_pricing = {
    async findMany(args: unknown) {
      calls.push({ op: "findMany", args });
      return [...rows.values()].map((row) => ({ externalId: row.externalId }));
    },
    async upsert(args: {
      where: { externalId: string };
      create: FakeRow;
      update: Record<string, unknown>;
    }) {
      const existing = rows.get(args.where.externalId);
      calls.push({
        op: "upsert",
        args,
        branch: existing ? "update" : "create",
      });
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const created: FakeRow = { ...args.create, id: `sp-${++nextId}` };
      rows.set(args.create.externalId, created);
      return created;
    },
    async updateMany(args: {
      where: {
        externalId?: { notIn: string[] };
        source?: { in: string[] };
        isActive?: boolean;
      };
      data: Record<string, unknown>;
    }) {
      calls.push({ op: "updateMany", args });
      const keep = new Set(args.where.externalId?.notIn ?? []);
      let count = 0;
      for (const row of rows.values()) {
        if (keep.has(row.externalId)) continue;
        if (
          args.where.source !== undefined &&
          !args.where.source.in.includes(row.source as string)
        )
          continue;
        if (
          args.where.isActive !== undefined &&
          row.isActive !== args.where.isActive
        )
          continue;
        Object.assign(row, args.data);
        count += 1;
      }
      return { count };
    },
    async deleteMany(args: unknown) {
      calls.push({ op: "deleteMany", args });
      const count = rows.size;
      rows.clear();
      return { count };
    },
    async delete(args: { where: { externalId?: string; id?: string } }) {
      calls.push({ op: "delete", args });
      for (const [key, row] of rows) {
        if (
          row.externalId === args.where.externalId ||
          row.id === args.where.id
        ) {
          rows.delete(key);
          return row;
        }
      }
      throw new Error("delete: row not found");
    },
    async createMany(args: { data: FakeRow[] }) {
      calls.push({ op: "createMany", args });
      for (const data of args.data) {
        rows.set(data.externalId, { ...data, id: `sp-${++nextId}` });
      }
      return { count: args.data.length };
    },
  };

  return {
    calls,
    rows,
    seed(row: { id: string; externalId: string } & Partial<FakeRow>) {
      rows.set(row.externalId, { isActive: true, ...row });
    },
    client: {
      service_pricing,
      async $disconnect() {
        calls.push({ op: "$disconnect", args: undefined });
      },
    },
  };
}

function stubSources(
  openRouterModels: unknown[],
  litellmModels: Record<string, unknown>,
) {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).includes("openrouter.ai")) {
      return { ok: true, json: async () => ({ data: openRouterModels }) };
    }
    return { ok: true, json: async () => litellmModels };
  });
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
  pricing: { prompt: "0.000003", completion: "0.000015" },
  context_length: 200000,
};

const LITELLM_GEMINI = {
  "gemini/gemini-2.0-flash": {
    mode: "chat",
    input_cost_per_token: 1e-7,
    output_cost_per_token: 4e-7,
    litellm_provider: "vertex_ai-language-models",
    max_input_tokens: 1048576,
  },
};

function destructiveCalls(fake: ReturnType<typeof createFakePrisma>) {
  return fake.calls.filter((c) => c.op === "delete" || c.op === "deleteMany");
}

function upsertCalls(fake: ReturnType<typeof createFakePrisma>) {
  return fake.calls.filter((c) => c.op === "upsert");
}

function retireCalls(fake: ReturnType<typeof createFakePrisma>) {
  return fake.calls.filter(
    (c) =>
      c.op === "updateMany" &&
      (c.args as { data?: { isActive?: boolean } }).data?.isActive === false,
  );
}

function idSnapshot(fake: ReturnType<typeof createFakePrisma>) {
  const ids = new Map<string, string>();
  for (const row of fake.rows.values()) ids.set(row.externalId, row.id);
  return ids;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockDb.current = createFakePrisma();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sync-service-pricing contract", () => {
  it("upserts keyed on externalId with stable ids across two identical runs", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O, SONNET], LITELLM_GEMINI);

    await main();
    const idsAfterRun1 = idSnapshot(fake);
    expect(fake.rows.size).toBe(3 + BUILT_IN_ROWS.length);

    const callCountAfterRun1 = fake.calls.length;
    await main();
    const idsAfterRun2 = idSnapshot(fake);

    expect(idsAfterRun2).toEqual(idsAfterRun1);

    for (const call of upsertCalls(fake)) {
      expect(
        Object.keys((call.args as { where: Record<string, unknown> }).where),
      ).toEqual(["externalId"]);
    }

    const secondRunUpserts = fake.calls
      .slice(callCountAfterRun1)
      .filter((c) => c.op === "upsert");
    expect(secondRunUpserts.length).toBe(3 + BUILT_IN_ROWS.length);
    for (const call of secondRunUpserts) {
      expect(call.branch).toBe("update");
    }

    const opsUsed = new Set(fake.calls.map((c) => c.op));
    expect(opsUsed).toEqual(
      new Set(["findMany", "upsert", "updateMany", "$disconnect"]),
    );
  });

  it("retires a row absent from source data via isActive=false update, never a delete", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-stale-1",
      externalId: "openai/gpt-legacy",
      source: "openrouter",
      isActive: true,
    });
    stubSources([GPT_4O], LITELLM_GEMINI);

    await main();

    const stale = fake.rows.get("openai/gpt-legacy");
    expect(stale).toBeDefined();
    expect(stale!.id).toBe("sp-stale-1");
    expect(stale!.isActive).toBe(false);

    const retires = retireCalls(fake);
    expect(retires.length).toBe(1);
    const where = (
      retires[0].args as {
        where: { externalId: { notIn: string[] }; isActive: boolean };
      }
    ).where;
    expect(where.isActive).toBe(true);
    expect(where.externalId.notIn).toContain("openai/gpt-4o");
    expect(where.externalId.notIn).not.toContain("openai/gpt-legacy");

    expect(destructiveCalls(fake)).toHaveLength(0);

    const summaryLine = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("retired"));
    expect(summaryLine).toContain("1 retired");
  });

  it("sync never issues a destructive statement against service_pricing (org_model_mappings cascade guard)", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-mapped-1",
      externalId: "anthropic/claude-sonnet-4.6",
      source: "openrouter",
      isActive: true,
    });

    stubSources([GPT_4O, SONNET], LITELLM_GEMINI);
    await main();

    stubSources([GPT_4O], LITELLM_GEMINI);
    await main();

    expect(destructiveCalls(fake)).toHaveLength(0);
    const mapped = fake.rows.get("anthropic/claude-sonnet-4.6");
    expect(mapped).toBeDefined();
    expect(mapped!.id).toBe("sp-mapped-1");
  });

  it("reactivates a previously-retired externalId with its original id (upsert update path)", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-original-1",
      externalId: "openai/gpt-4o",
      source: "openrouter",
      isActive: false,
    });
    stubSources([GPT_4O], LITELLM_GEMINI);

    await main();

    const row = fake.rows.get("openai/gpt-4o");
    expect(row).toBeDefined();
    expect(row!.id).toBe("sp-original-1");
    expect(row!.isActive).toBe(true);

    const gpt4oUpserts = upsertCalls(fake).filter(
      (c) =>
        (c.args as { where: { externalId: string } }).where.externalId ===
        "openai/gpt-4o",
    );
    expect(gpt4oUpserts.length).toBe(1);
    expect(gpt4oUpserts[0].branch).toBe("update");
  });

  it("aborts and retires nothing when every source returns empty (sanity floor)", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-live-1",
      externalId: "openai/gpt-4o",
      isActive: true,
    });
    fake.seed({
      id: "sp-live-2",
      externalId: "anthropic/claude-sonnet-4.6",
      isActive: true,
    });
    stubSources([], {});

    await expect(main()).rejects.toThrow();
    expect(retireCalls(fake)).toHaveLength(0);
  });

  it("aborts before any write when LiteLLM is empty but OpenRouter answered: LiteLLM is the feed a sync needs", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-litellm-only-1",
      externalId: "litellm/gemini/gemini-1.0-pro",
      source: "litellm",
      isActive: true,
    });
    stubSources([GPT_4O], {});

    await expect(main()).rejects.toThrow(
      /LiteLLM returned zero usable pricing entries/,
    );

    const litellmRow = fake.rows.get("litellm/gemini/gemini-1.0-pro");
    expect(litellmRow!.isActive).toBe(true);
    expect(litellmRow!.id).toBe("sp-litellm-only-1");
    expect(upsertCalls(fake)).toHaveLength(0);
    expect(retireCalls(fake)).toHaveLength(0);
    expect(destructiveCalls(fake)).toHaveLength(0);
  });

  it("syncs from LiteLLM alone when OpenRouter is empty, retiring the OpenRouter rows without deleting them", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-or-only-1",
      externalId: "anthropic/claude-sonnet-4.6",
      source: "openrouter",
      isActive: true,
    });
    stubSources([], LITELLM_GEMINI);
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});

    await main();

    expect(warnings).toHaveBeenCalledWith(
      expect.stringMatching(/OpenRouter returned zero usable pricing entries/),
    );
    expect(fake.rows.get("litellm/gemini/gemini-2.0-flash")!.isActive).toBe(
      true,
    );
    const openRouterRow = fake.rows.get("anthropic/claude-sonnet-4.6");
    expect(openRouterRow!.isActive).toBe(false);
    expect(openRouterRow!.id).toBe("sp-or-only-1");
    expect(destructiveCalls(fake)).toHaveLength(0);
  });

  it("--litellm-only never asks OpenRouter and prints no warning about it", async () => {
    const fake = mockDb.current;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      urls.push(String(url));
      return { ok: true, json: async () => LITELLM_GEMINI };
    });
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});

    await main({ litellmOnly: true });

    expect(urls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    expect(urls.some((url) => url.includes("BerriAI/litellm"))).toBe(true);
    expect(warnings).not.toHaveBeenCalledWith(
      expect.stringMatching(/OpenRouter/),
    );
    expect(fake.rows.get("litellm/gemini/gemini-2.0-flash")!.isActive).toBe(
      true,
    );
  });
});

describe("$0 catalog rows for free coding-agent built-ins", () => {
  // sync-service-pricing.ts keeps toCanonical/dedupeKey module-private, so
  // this mirrors the same derivation to prove uniqueness independently of
  // the script's own internals (not imported, kept deliberately in sync).
  function toCanonical(externalId: string): string {
    let s = externalId.toLowerCase();
    if (s.startsWith("litellm/")) s = s.slice(8);
    else if (s.startsWith("api/")) s = s.slice(4);
    if (s.includes("/")) s = s.split("/").pop()!;
    return s;
  }

  function dedupeKey(entry: { externalId: string; provider: string }) {
    return `${toCanonical(entry.externalId)}|${entry.provider.toLowerCase()}`;
  }

  const TOOL_ROWS = BUILT_IN_ROWS.filter((entry) => entry.provider === "tool");
  const ZERO_TOOL_ROWS = TOOL_ROWS.filter(
    (entry) => entry.inputCost === 0 && entry.outputCost === null,
  );

  // Typed out, not derived from the script: a list generated from the source
  // it checks would pass on an empty catalog.
  const EXPECTED_ZERO_ROW_NAMES = [
    // Claude Code (39)
    "tool/read",
    "tool/edit",
    "tool/write",
    "tool/multiedit",
    "tool/notebookedit",
    "tool/notebookread",
    "tool/bash",
    "tool/bashoutput",
    "tool/killshell",
    "tool/killbash",
    "tool/grep",
    "tool/glob",
    "tool/ls",
    "tool/todowrite",
    "tool/exitplanmode",
    "tool/task",
    "tool/agent",
    "tool/slashcommand",
    "tool/toolsearch",
    "tool/taskcreate",
    "tool/taskupdate",
    "tool/tasklist",
    "tool/taskget",
    "tool/taskoutput",
    "tool/taskstop",
    "tool/webfetch",
    "tool/askuserquestion",
    "tool/skill",
    "tool/schedulewakeup",
    "tool/artifact",
    "tool/monitor",
    "tool/structuredoutput",
    "tool/sendmessage",
    "tool/senduserfile",
    "tool/workflow",
    "tool/pushnotification",
    "tool/reportfindings",
    "tool/enterworktree",
    "tool/exitworktree",
    // Codex (17)
    "tool/exec_command",
    "tool/exec",
    "tool/shell",
    "tool/apply_patch",
    "tool/tool_search",
    "tool/update_plan",
    "tool/write_stdin",
    "tool/view_image",
    "tool/list_mcp_resources",
    "tool/wait",
    "tool/run",
    "tool/spawn_agent",
    "tool/wait_agent",
    "tool/send_message",
    "tool/send_input",
    "tool/followup_task",
    "tool/close_agent",
  ];

  it("has no canonicalName|provider collision anywhere in BUILT_IN_ROWS", () => {
    const seen = new Map<string, string>();
    for (const entry of BUILT_IN_ROWS) {
      const key = dedupeKey(entry);
      const priorExternalId = seen.get(key);
      expect(
        priorExternalId,
        `dedupe key "${key}" collides between "${priorExternalId}" and "${entry.externalId}"`,
      ).toBeUndefined();
      seen.set(key, entry.externalId);
    }
  });

  it("seeds exactly the expected 56 $0 rows by exact externalId", () => {
    expect(EXPECTED_ZERO_ROW_NAMES.length).toBe(56);
    expect([...ZERO_TOOL_ROWS.map((e) => e.externalId)].sort()).toEqual(
      [...EXPECTED_ZERO_ROW_NAMES].sort(),
    );
  });

  it("every $0 row is priced exactly zero, not merely unset", () => {
    for (const entry of ZERO_TOOL_ROWS) {
      expect(entry.inputCost).toBe(0);
      expect(entry.outputCost).toBeNull();
      expect(entry.provider).toBe("tool");
      expect(entry.source).toBe("builtin");
      expect(entry.isApi).toBe(true);
      expect(entry.contextWindow).toBeNull();
    }
  });

  it("keeps the two vendor-metered web search rows priced, apart from the $0 rows", () => {
    const claudeWebSearch = BUILT_IN_ROWS.find(
      (e) => e.externalId === "tool/websearch",
    );
    const codexWebSearch = BUILT_IN_ROWS.find(
      (e) => e.externalId === "tool/web_search",
    );
    expect(claudeWebSearch?.inputCost).toBe(10.0);
    expect(codexWebSearch?.inputCost).toBe(10.0);
    expect(TOOL_ROWS).toHaveLength(EXPECTED_ZERO_ROW_NAMES.length + 2);
  });

  it("a built-in $0 tool row survives the sync untouched by hasValidCost and lands active with canonicalName derived from its externalId", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], LITELLM_GEMINI);

    await main();

    const bash = fake.rows.get("tool/bash");
    expect(bash).toBeDefined();
    expect(bash!.isActive).toBe(true);
    expect(bash!.inputCost).toBe(0);
    expect(bash!.provider).toBe("tool");
    expect(bash!.canonicalName).toBe("bash");

    const execCommand = fake.rows.get("tool/exec_command");
    expect(execCommand!.canonicalName).toBe("exec_command");
    const toolSearchCodex = fake.rows.get("tool/tool_search");
    expect(toolSearchCodex!.canonicalName).toBe("tool_search");
  });

  it("never retires a $0 tool row on a normal run (it's always present in BUILT_IN_ROWS)", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], LITELLM_GEMINI);

    await main();

    for (const call of retireCalls(fake)) {
      const notIn = (
        call.args as { where: { externalId: { notIn: string[] } } }
      ).where.externalId.notIn;
      for (const name of EXPECTED_ZERO_ROW_NAMES) {
        expect(notIn).toContain(name);
      }
    }
  });
});

describe("built-in row durability: no sync path can drop a built-in row", () => {
  it("two consecutive healthy runs leave every built-in row present and active", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O, SONNET], LITELLM_GEMINI);

    await main();
    await main();

    for (const entry of BUILT_IN_ROWS) {
      const row = fake.rows.get(entry.externalId);
      expect(row, `built-in row ${entry.externalId} missing`).toBeDefined();
      expect(row!.isActive, `built-in row ${entry.externalId} inactive`).toBe(
        true,
      );
      expect(row!.source).toBe("builtin");
    }
    expect(destructiveCalls(fake)).toHaveLength(0);
  });

  it("a single-feed outage aborts before any write, and a healthy run's retire notIn-list shields every built-in row", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-builtin-preexisting",
      externalId: "tool/read",
      source: "builtin",
      isActive: true,
    });
    stubSources([GPT_4O], {});

    await expect(main()).rejects.toThrow(/zero usable pricing entries/);
    expect(fake.rows.get("tool/read")!.isActive).toBe(true);
    expect(upsertCalls(fake)).toHaveLength(0);
    expect(retireCalls(fake)).toHaveLength(0);

    stubSources([GPT_4O], LITELLM_GEMINI);
    await main();
    expect(retireCalls(fake)).toHaveLength(1);

    for (const entry of BUILT_IN_ROWS) {
      expect(fake.rows.get(entry.externalId)!.isActive).toBe(true);
    }
    expect(fake.rows.get("tool/read")!.id).toBe("sp-builtin-preexisting");

    for (const call of retireCalls(fake)) {
      const notIn = (
        call.args as { where: { externalId: { notIn: string[] } } }
      ).where.externalId.notIn;
      for (const entry of BUILT_IN_ROWS) {
        expect(notIn).toContain(entry.externalId);
      }
    }
  });

  it("a total feed outage aborts before any write: built-in rows in the database are untouched", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-builtin-live",
      externalId: "tool/bash",
      source: "builtin",
      isActive: true,
    });
    stubSources([], {});

    await expect(main()).rejects.toThrow();

    const row = fake.rows.get("tool/bash");
    expect(row!.isActive).toBe(true);
    expect(row!.id).toBe("sp-builtin-live");
    expect(upsertCalls(fake)).toHaveLength(0);
    expect(retireCalls(fake)).toHaveLength(0);
    expect(destructiveCalls(fake)).toHaveLength(0);
  });

  it("a feed entry colliding with a built-in externalId cannot clobber it: the built-in row upserts last and wins", async () => {
    const fake = mockDb.current;
    const impostor = {
      id: "tool/bash",
      name: "Impostor: bash-llm",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      context_length: 8192,
    };
    stubSources([GPT_4O, impostor], LITELLM_GEMINI);

    await main();

    const row = fake.rows.get("tool/bash");
    expect(row!.source).toBe("builtin");
    expect(row!.inputCost).toBe(0);
    expect(row!.provider).toBe("tool");
    expect(row!.serviceType).toBe("Agent Built-in");
    expect(row!.isActive).toBe(true);
  });

  it("retires a built-in row once it leaves the list, and leaves a row with any other source alone", async () => {
    const fake = mockDb.current;
    fake.seed({
      id: "sp-dropped",
      externalId: "tool/dropped-from-the-list",
      source: "builtin",
      isActive: true,
    });
    fake.seed({
      id: "sp-own",
      externalId: "acme/own-row",
      source: "acme",
      isActive: true,
    });
    stubSources([GPT_4O], LITELLM_GEMINI);

    await main();

    expect(fake.rows.get("tool/dropped-from-the-list")!.isActive).toBe(false);
    expect(fake.rows.get("acme/own-row")!.isActive).toBe(true);
    expect(destructiveCalls(fake)).toHaveLength(0);
  });
});

describe("a row a builder adds to BUILT_IN_ROWS", () => {
  it("lands active with canonicalName and provider derived per the file's own rules", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], LITELLM_GEMINI);
    BUILT_IN_ROWS.push({
      externalId: "api/acme-search",
      displayName: "Acme Search",
      provider: "Acme",
      serviceType: "Web Search",
      inputCost: 4.0,
      outputCost: null,
      costUnit: "1K requests",
      contextWindow: null,
      source: "builtin",
      isApi: true,
    });

    try {
      await main();
    } finally {
      BUILT_IN_ROWS.pop();
    }

    const row = fake.rows.get("api/acme-search");
    expect(row!.canonicalName).toBe("acme-search");
    expect(row!.provider).toBe("acme");
    expect(row!.inputCost).toBe(4);
    expect(row!.source).toBe("builtin");
    expect(row!.isActive).toBe(true);
  });
});

describe("costUnit gate", () => {
  it("every built-in costUnit is in KNOWN_COST_UNITS (typo tripwire at test time, before a sync ever runs)", () => {
    for (const entry of BUILT_IN_ROWS) {
      expect(
        KNOWN_COST_UNITS.has(entry.costUnit),
        `"${entry.externalId}" carries unknown costUnit "${entry.costUnit}"`,
      ).toBe(true);
    }
  });

  it("a costUnit outside the allow-list aborts the run before any DB write", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], LITELLM_GEMINI);
    BUILT_IN_ROWS.push({
      externalId: "api/unit-typo",
      displayName: "Unit Typo",
      provider: "typo",
      serviceType: "Web Search",
      inputCost: 1.0,
      outputCost: null,
      costUnit: "1K MBs",
      contextWindow: null,
      source: "builtin",
      isApi: true,
    });

    try {
      await expect(main()).rejects.toThrow(/costUnit/);
    } finally {
      BUILT_IN_ROWS.pop();
    }

    expect(upsertCalls(fake)).toHaveLength(0);
    expect(retireCalls(fake)).toHaveLength(0);
    expect(destructiveCalls(fake)).toHaveLength(0);
  });
});

describe("cache-rate backfills for half-priced feed rows", () => {
  // Feed entries in the OpenRouter payload's shape: the non-batch google row publishes both cache rates, the :batch row omits
  // input_cache_write, and the qwen row omits input_cache_read.
  const GEMINI_25_FLASH = {
    id: "google/gemini-2.5-flash",
    name: "Google: Gemini 2.5 Flash",
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000025",
      input_cache_read: "0.00000003",
      input_cache_write: "0.0000000833333333333333",
    },
    context_length: 1048576,
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

  const QWEN_36_FLASH = {
    id: "qwen/qwen3.6-flash",
    name: "Qwen: Qwen3.6 Flash",
    pricing: {
      prompt: "0.0000001875",
      completion: "0.00000075",
      input_cache_write: "0.000000234375",
    },
    context_length: 262144,
  };

  const EXPECTED_BACKFILL_KEYS = [
    "gemini-2.5-flash-lite:batch|google",
    "gemini-2.5-flash:batch|google",
    "gemini-2.5-pro:batch|google",
    "gemini-3.1-flash-lite:batch|google",
    "gemini-3.5-flash-lite:batch|google",
    "gemini-3.5-flash:batch|google",
    "gpt-5.6-luna-pro:batch|openai",
    "gpt-5.6-luna:batch|openai",
    "gpt-5.6-terra-pro:batch|openai",
    "gpt-5.6-terra:batch|openai",
    "qwen3.5-plus-20260420|qwen",
    "qwen3.6-flash|qwen",
    "qwen3.6-max-preview|qwen",
    "qwen3.6-plus|qwen",
  ];

  it("pins the table: exactly these 14 rows, one half each", () => {
    expect(Object.keys(CACHE_RATE_BACKFILLS).sort()).toEqual(
      EXPECTED_BACKFILL_KEYS,
    );
    for (const [key, backfill] of Object.entries(CACHE_RATE_BACKFILLS)) {
      const halves = [backfill.cacheReadCost, backfill.cacheWriteCost].filter(
        (half) => half !== undefined,
      );
      expect(halves, `${key} must fill exactly one half`).toHaveLength(1);
      expect(Number.isFinite(halves[0])).toBe(true);
      expect(halves[0]).toBeGreaterThan(0);
      // Key shape = `${toCanonical(externalId)}|${provider.toLowerCase()}` —
      // an uppercase or slash-bearing key would silently never match.
      expect(key).toMatch(/^[^|/A-Z]+\|[a-z0-9-]+$/);
    }
  });

  it("pins each rate to the vendor page's number", () => {
    const write = (key: string) => CACHE_RATE_BACKFILLS[key].cacheWriteCost;
    const read = (key: string) => CACHE_RATE_BACKFILLS[key].cacheReadCost;

    // Google batch writes are the tier's own storage price prorated to the
    // 5-minute TTL. Most models print the same storage price in batch as
    // standard ($1.00/hr here, $4.50/hr on 2.5 Pro), so the write looks
    // un-halved; 3.1 Flash-Lite's batch tier halves storage ($0.50 vs
    // $1.00), so its write is genuinely halved.
    expect(write("gemini-2.5-flash-lite:batch|google")).toBe(0.0833333333);
    expect(write("gemini-2.5-flash:batch|google")).toBe(0.0833333333);
    expect(write("gemini-2.5-pro:batch|google")).toBe(0.375);
    expect(write("gemini-3.1-flash-lite:batch|google")).toBe(0.0416666667);
    expect(write("gemini-3.5-flash-lite:batch|google")).toBe(0.0833333333);
    expect(write("gemini-3.5-flash:batch|google")).toBe(0.0833333333);
    // OpenAI publishes batch cache writes at 50% of standard.
    expect(write("gpt-5.6-luna:batch|openai")).toBe(0.125);
    expect(write("gpt-5.6-luna-pro:batch|openai")).toBe(0.125);
    expect(write("gpt-5.6-terra:batch|openai")).toBe(1.25);
    expect(write("gpt-5.6-terra-pro:batch|openai")).toBe(1.25);
    // Alibaba explicit-cache hit = 10% of the standard input price.
    expect(read("qwen3.5-plus-20260420|qwen")).toBe(0.03);
    expect(read("qwen3.6-flash|qwen")).toBe(0.01875);
    expect(read("qwen3.6-max-preview|qwen")).toBe(0.1027);
    expect(read("qwen3.6-plus|qwen")).toBe(0.0325);
  });

  it("derives each rate from the vendor rule and the feed row's own price basis — a rate incoherent with the row it lands on fails here, not on an invoice", () => {
    const write = (key: string) => CACHE_RATE_BACKFILLS[key].cacheWriteCost;
    const read = (key: string) => CACHE_RATE_BACKFILLS[key].cacheReadCost;

    // Feed bases per 1M tokens from the OpenRouter models API, the same feed
    // rows the backfill lands on. A vendor-page rate quoted for a row with a
    // different input price fails here, even when the quote itself is right.
    const FEED_INPUT_PER_1M: Record<string, number> = {
      "gpt-5.6-luna-pro:batch|openai": 0.1,
      "gpt-5.6-luna:batch|openai": 0.1,
      "gpt-5.6-terra-pro:batch|openai": 1.0,
      "gpt-5.6-terra:batch|openai": 1.0,
    };
    const QWEN_FEED_INPUT_PER_1M: Record<string, number> = {
      "qwen3.5-plus-20260420|qwen": 0.3,
      "qwen3.6-flash|qwen": 0.1875,
      "qwen3.6-max-preview|qwen": 1.027,
      "qwen3.6-plus|qwen": 0.325,
    };

    // Google: the write encodes storage — the model's own Batch-table price
    // per 1M token-hours prorated to the 5-minute default TTL. The storage
    // rates below are the vendor page's Batch rows: $1.00
    // for the flash family, $4.50 for 2.5 Pro (same as standard), $0.50 for
    // 3.1 Flash-Lite (the one batch tier that halves storage).
    const GOOGLE_BATCH_STORAGE_PER_1M_TOKEN_HOURS: Record<string, number> = {
      "gemini-2.5-flash-lite:batch|google": 1.0,
      "gemini-2.5-flash:batch|google": 1.0,
      "gemini-2.5-pro:batch|google": 4.5,
      "gemini-3.1-flash-lite:batch|google": 0.5,
      "gemini-3.5-flash-lite:batch|google": 1.0,
      "gemini-3.5-flash:batch|google": 1.0,
    };
    for (const [key, storage] of Object.entries(
      GOOGLE_BATCH_STORAGE_PER_1M_TOKEN_HOURS,
    )) {
      expect(write(key), key).toBeCloseTo(storage * (5 / 60), 9);
    }

    // OpenAI: cache write = 1.25x input on every published SKU, both tiers.
    for (const [key, input] of Object.entries(FEED_INPUT_PER_1M)) {
      expect(write(key), key).toBeCloseTo(1.25 * input, 10);
    }

    // Alibaba explicit cache: hit = 10% of the STANDARD input price (the
    // feed's write on these rows is 125% of that same input).
    for (const [key, input] of Object.entries(QWEN_FEED_INPUT_PER_1M)) {
      expect(read(key), key).toBeCloseTo(0.1 * input, 10);
    }
  });

  it("keeps unresolved rows OUT of the table", () => {
    expect(
      CACHE_RATE_BACKFILLS["qwen-plus-2025-07-28:thinking|qwen"],
    ).toBeUndefined();
    // The sol family: OpenRouter feed prices at exactly half the vendor page
    // on every field, so no cache-write number coheres with both sources.
    // Held out until the feed and page agree.
    expect(CACHE_RATE_BACKFILLS["gpt-5.6-sol:batch|openai"]).toBeUndefined();
    expect(
      CACHE_RATE_BACKFILLS["gpt-5.6-sol-pro:batch|openai"],
    ).toBeUndefined();
  });

  it("backfills the missing write half on a google :batch row", async () => {
    const fake = mockDb.current;
    stubSources([GEMINI_25_FLASH, GEMINI_25_FLASH_BATCH], LITELLM_GEMINI);

    await main();

    const batch = fake.rows.get("google/gemini-2.5-flash:batch");
    expect(batch!.cacheWriteCost).toBe(0.0833333333);
    expect(batch!.cacheReadCost).toBeCloseTo(0.03, 10);

    // The fully-priced sibling is untouched: feed value.
    const sibling = fake.rows.get("google/gemini-2.5-flash");
    expect(sibling!.cacheWriteCost).toBeCloseTo(0.0833333333, 8);
  });

  it("backfills the missing read half on a qwen row (the WRITE-PRICED-READ-MISSING direction)", async () => {
    const fake = mockDb.current;
    stubSources([QWEN_36_FLASH], LITELLM_GEMINI);

    await main();

    const row = fake.rows.get("qwen/qwen3.6-flash");
    expect(row!.cacheReadCost).toBe(0.01875);
    expect(row!.cacheWriteCost).toBeCloseTo(0.234375, 10);
  });

  it("a rate the feed starts publishing wins — the backfill fills holes, never overwrites", async () => {
    const fake = mockDb.current;
    const healedBatch = {
      ...GEMINI_25_FLASH_BATCH,
      pricing: {
        ...GEMINI_25_FLASH_BATCH.pricing,
        input_cache_write: "0.0000001",
      },
    };
    stubSources([healedBatch], LITELLM_GEMINI);

    await main();

    const row = fake.rows.get("google/gemini-2.5-flash:batch");
    expect(row!.cacheWriteCost).toBeCloseTo(0.1, 10);
    expect(row!.cacheWriteCost).not.toBe(0.0833333333);
  });

  it("a feed-published ZERO is a price, not a hole — the backfill leaves it alone", async () => {
    const fake = mockDb.current;
    const freeWriteBatch = {
      ...GEMINI_25_FLASH_BATCH,
      pricing: {
        ...GEMINI_25_FLASH_BATCH.pricing,
        input_cache_write: "0",
      },
    };
    stubSources([freeWriteBatch], LITELLM_GEMINI);

    await main();

    const row = fake.rows.get("google/gemini-2.5-flash:batch");
    expect(row!.cacheWriteCost).toBe(0);
  });

  it("closes the loop with the completeness check: backfilled rows stop flagging, an unfixed half-priced row still flags", async () => {
    const fake = mockDb.current;
    // The vendor page prints the same $4.50/hr storage in Batch as Standard,
    // so 0.375 is the rate and this row stops flagging.
    const GEMINI_25_PRO = {
      id: "google/gemini-2.5-pro",
      name: "Google: Gemini 2.5 Pro",
      pricing: {
        prompt: "0.00000125",
        completion: "0.00001",
        input_cache_read: "0.000000125",
        input_cache_write: "0.000000375",
      },
      context_length: 1048576,
    };
    const GEMINI_25_PRO_BATCH = {
      id: "google/gemini-2.5-pro:batch",
      name: "Google: Gemini 2.5 Pro (batch)",
      pricing: {
        prompt: "0.000000625",
        completion: "0.000005",
        input_cache_read: "0.000000125",
      },
      context_length: 1048576,
    };
    const GPT_56_SOL = {
      id: "openai/gpt-5.6-sol",
      name: "OpenAI: GPT-5.6 Sol",
      pricing: {
        prompt: "0.0000025",
        completion: "0.000015",
        input_cache_read: "0.00000025",
        input_cache_write: "0.000003125",
      },
      context_length: 1050000,
    };
    // Deliberately NOT in the backfill table: no cache-write rate coheres with
    // both the feed and the vendor page, so it must keep flagging.
    const GPT_56_SOL_BATCH = {
      id: "openai/gpt-5.6-sol:batch",
      name: "OpenAI: GPT-5.6 Sol (batch)",
      pricing: {
        prompt: "0.00000125",
        completion: "0.0000075",
        input_cache_read: "0.000000125",
      },
      context_length: 1050000,
    };
    stubSources(
      [
        GEMINI_25_FLASH,
        GEMINI_25_FLASH_BATCH,
        GEMINI_25_PRO,
        GEMINI_25_PRO_BATCH,
        GPT_56_SOL,
        GPT_56_SOL_BATCH,
      ],
      LITELLM_GEMINI,
    );

    await main();

    const catalog = [...fake.rows.values()].map(
      (row) =>
        ({
          externalId: row.externalId,
          displayName: row.displayName,
          provider: row.provider,
          source: row.source,
          canonicalName: row.canonicalName,
          costUnit: row.costUnit,
          inputCost: row.inputCost ?? null,
          cacheReadCost: row.cacheReadCost ?? null,
          cacheWriteCost: row.cacheWriteCost ?? null,
        }) as CachePricingRow,
    );

    const findings = findIncompleteCachePricing(catalog);
    expect(findings.map((f) => f.externalId)).toEqual([
      "openai/gpt-5.6-sol:batch",
    ]);
  });

  it("drives EVERY backfill key through main() and checks each landed rate against the row's own feed basis (the sol rows stay held out)", async () => {
    const fake = mockDb.current;
    // OpenRouter payload shapes (https://openrouter.ai/api/v1/models): every row the backfill table
    // targets, plus the sol rows it deliberately does not.
    stubSources(
      [
        {
          id: "google/gemini-2.5-flash-lite:batch",
          name: "Google: Gemini 2.5 Flash Lite (batch)",
          pricing: {
            prompt: "0.00000005",
            completion: "0.0000002",
            input_cache_read: "0.00000001",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-2.5-flash:batch",
          name: "Google: Gemini 2.5 Flash (batch)",
          pricing: {
            prompt: "0.00000015",
            completion: "0.00000125",
            input_cache_read: "0.00000003",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-2.5-pro:batch",
          name: "Google: Gemini 2.5 Pro (batch)",
          pricing: {
            prompt: "0.000000625",
            completion: "0.000005",
            input_cache_read: "0.000000125",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-3.1-flash-lite:batch",
          name: "Google: Gemini 3.1 Flash Lite (batch)",
          pricing: {
            prompt: "0.000000125",
            completion: "0.00000075",
            input_cache_read: "0.0000000125",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-3.5-flash-lite:batch",
          name: "Google: Gemini 3.5 Flash Lite (batch)",
          pricing: {
            prompt: "0.00000015",
            completion: "0.00000125",
            input_cache_read: "0.000000015",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-3.5-flash:batch",
          name: "Google: Gemini 3.5 Flash (batch)",
          pricing: {
            prompt: "0.00000075",
            completion: "0.0000045",
            input_cache_read: "0.000000075",
          },
          context_length: 1048576,
        },
        {
          id: "openai/gpt-5.6-luna:batch",
          name: "OpenAI: GPT-5.6 Luna (batch)",
          pricing: {
            prompt: "0.0000001",
            completion: "0.0000006",
            input_cache_read: "0.00000001",
          },
          context_length: 1050000,
        },
        {
          id: "openai/gpt-5.6-luna-pro:batch",
          name: "OpenAI: GPT-5.6 Luna Pro (batch)",
          pricing: {
            prompt: "0.0000001",
            completion: "0.0000006",
            input_cache_read: "0.00000001",
          },
          context_length: 1050000,
        },
        {
          id: "openai/gpt-5.6-terra:batch",
          name: "OpenAI: GPT-5.6 Terra (batch)",
          pricing: {
            prompt: "0.000001",
            completion: "0.000006",
            input_cache_read: "0.0000001",
          },
          context_length: 1050000,
        },
        {
          id: "openai/gpt-5.6-terra-pro:batch",
          name: "OpenAI: GPT-5.6 Terra Pro (batch)",
          pricing: {
            prompt: "0.000001",
            completion: "0.000006",
            input_cache_read: "0.0000001",
          },
          context_length: 1050000,
        },
        {
          id: "openai/gpt-5.6-sol:batch",
          name: "OpenAI: GPT-5.6 Sol (batch)",
          pricing: {
            prompt: "0.00000125",
            completion: "0.0000075",
            input_cache_read: "0.000000125",
          },
          context_length: 1050000,
        },
        {
          id: "openai/gpt-5.6-sol-pro:batch",
          name: "OpenAI: GPT-5.6 Sol Pro (batch)",
          pricing: {
            prompt: "0.00000125",
            completion: "0.0000075",
            input_cache_read: "0.000000125",
          },
          context_length: 1050000,
        },
        {
          id: "qwen/qwen3.5-plus-20260420",
          name: "Qwen: Qwen3.5 Plus 2026-04-20",
          pricing: {
            prompt: "0.0000003",
            completion: "0.0000018",
            input_cache_write: "0.000000375",
          },
          context_length: 1000000,
        },
        {
          id: "qwen/qwen3.6-flash",
          name: "Qwen: Qwen3.6 Flash",
          pricing: {
            prompt: "0.0000001875",
            completion: "0.000001125",
            input_cache_write: "0.000000234375",
          },
          context_length: 1000000,
        },
        {
          id: "qwen/qwen3.6-max-preview",
          name: "Qwen: Qwen3.6 Max Preview",
          pricing: {
            prompt: "0.000001027",
            completion: "0.000006162",
            input_cache_write: "0.00000128375",
          },
          context_length: 262144,
        },
        {
          id: "qwen/qwen3.6-plus",
          name: "Qwen: Qwen3.6 Plus",
          pricing: {
            prompt: "0.000000325",
            completion: "0.00000195",
            input_cache_write: "0.00000040625",
          },
          context_length: 1000000,
        },
      ],
      LITELLM_GEMINI,
    );

    await main();

    // Google: write = the model's own Batch-table storage price (per 1M
    // token-hours) prorated to the 5-minute default TTL — $1.00 on the
    // flash family, $4.50 on 2.5 Pro, $0.50 on 3.1 Flash-Lite.
    const googleBatchStorage: Record<string, number> = {
      "google/gemini-2.5-flash-lite:batch": 1.0,
      "google/gemini-2.5-flash:batch": 1.0,
      "google/gemini-2.5-pro:batch": 4.5,
      "google/gemini-3.1-flash-lite:batch": 0.5,
      "google/gemini-3.5-flash-lite:batch": 1.0,
      "google/gemini-3.5-flash:batch": 1.0,
    };
    for (const [id, storage] of Object.entries(googleBatchStorage)) {
      const row = fake.rows.get(id)!;
      expect(row.cacheWriteCost as number, id).toBeCloseTo(
        storage * (5 / 60),
        9,
      );
    }

    // OpenAI: write = 1.25x the SAME row's input — incoherence with the
    // row's own basis fails here.
    for (const id of [
      "openai/gpt-5.6-luna:batch",
      "openai/gpt-5.6-luna-pro:batch",
      "openai/gpt-5.6-terra:batch",
      "openai/gpt-5.6-terra-pro:batch",
    ]) {
      const row = fake.rows.get(id)!;
      expect(row.cacheWriteCost as number, id).toBeCloseTo(
        1.25 * (row.inputCost as number),
        10,
      );
    }

    // Sol: feed and vendor page disagree 2x on the whole family, so the
    // rows stay half-priced: still flagged, never guessed.
    for (const id of [
      "openai/gpt-5.6-sol:batch",
      "openai/gpt-5.6-sol-pro:batch",
    ]) {
      const row = fake.rows.get(id)!;
      expect(row.cacheWriteCost, id).toBeNull();
    }

    // Alibaba: hit = 10% of the SAME row's standard input (whose feed write
    // is 125% of that input).
    for (const id of [
      "qwen/qwen3.5-plus-20260420",
      "qwen/qwen3.6-flash",
      "qwen/qwen3.6-max-preview",
      "qwen/qwen3.6-plus",
    ]) {
      const row = fake.rows.get(id)!;
      expect(row.cacheReadCost as number, id).toBeCloseTo(
        0.1 * (row.inputCost as number),
        10,
      );
      expect(row.cacheWriteCost as number, id).toBeCloseTo(
        1.25 * (row.inputCost as number),
        10,
      );
    }
  });
});

describe("LiteLLM image-token output pricing", () => {
  // Raw entries in the LiteLLM feed's shape.
  const GPT_IMAGE_25_FLARE = {
    cache_read_input_token_cost: 0.00000125,
    input_cost_per_token: 0.000005,
    litellm_provider: "openai",
    mode: "image_generation",
    input_cost_per_image_token: 0.000008,
    output_cost_per_image_token: 0.00003,
  };
  const GEMINI_25_FLASH_IMAGE = {
    input_cost_per_token: 3e-7,
    input_cost_per_audio_token: 0.000001,
    output_cost_per_token: 0.0000025,
    output_cost_per_reasoning_token: 0.0000025,
    output_cost_per_image_token: 0.00003,
    output_cost_per_image: 0.039,
    litellm_provider: "gemini",
    mode: "image_generation",
    supported_output_modalities: ["text", "image"],
  };
  const GROK_IMAGINE_VIDEO = {
    input_cost_per_image: 0.002,
    litellm_provider: "xai",
    mode: "video_generation",
    output_cost_per_second: 0.05,
    output_cost_per_second_480p: 0.05,
    output_cost_per_second_720p: 0.07,
    supported_output_modalities: ["video"],
  };
  const MARENGO_EMBED = {
    input_cost_per_query: 0.00007,
    input_cost_per_video_per_second: 0.0007,
    input_cost_per_audio_per_second: 0.00014,
    input_cost_per_image: 0.0001,
    output_cost_per_token: 0,
    litellm_provider: "bedrock",
    mode: "embedding",
  };
  const FLASH_EXP_IMAGE_GENERATION = {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    output_cost_per_image: 0.039,
    litellm_provider: "gemini",
    mode: "image_generation",
  };
  // No live row has this shape; it pins that only the per-TOKEN image field
  // may stand in for a missing text output.
  const PER_IMAGE_OUTPUT_ONLY = {
    input_cost_per_token: 0.000005,
    output_cost_per_image: 0.04,
    litellm_provider: "openai",
    mode: "image_generation",
  };

  it("a per-image price never stands in for a missing per-token output", () => {
    const [row] = normalizeLiteLLM({
      "per-image-output-only": PER_IMAGE_OUTPUT_ONLY,
    });
    expect(row.costUnit).toBe("1M tokens");
    expect(row.inputCost).toBe(5);
    expect(row.outputCost).toBeNull();
  });

  it("prices gpt-image-2.5-flare output at $30/1M from output_cost_per_image_token when output_cost_per_token is absent", () => {
    const [row] = normalizeLiteLLM({
      "gpt-image-2.5-flare": GPT_IMAGE_25_FLARE,
    });
    expect(row.externalId).toBe("litellm/gpt-image-2.5-flare");
    expect(row.outputCost).toBe(30);
    expect(row.inputCost).toBe(5);
    expect(row.cacheReadCost).toBe(1.25);
    expect(row.costUnit).toBe("1M tokens");
    expect(row.serviceType).toBe("Image Generation");
    expect(row.provider).toBe("openai");
  });

  it("a row publishing both output_cost_per_token and output_cost_per_image_token keeps its text price", () => {
    const [row] = normalizeLiteLLM({
      "gemini/gemini-2.5-flash-image": GEMINI_25_FLASH_IMAGE,
    });
    expect(row.outputCost).toBe(2.5);
    expect(row.inputCost).toBeCloseTo(0.3, 10);
    expect(row.costUnit).toBe("1M tokens");
  });

  it("a published zero text price is a price, not an absence — the image fallback never overrides it", () => {
    const [row] = normalizeLiteLLM({
      "zero-text-output": {
        ...GPT_IMAGE_25_FLARE,
        output_cost_per_token: 0,
      },
    });
    expect(row.outputCost).toBe(0);
  });

  it("mixed-unit rows are unchanged: a per-image or per-second output never lands in a per-token row", () => {
    const rows = normalizeLiteLLM({
      "xai/grok-imagine-video": GROK_IMAGINE_VIDEO,
      "twelvelabs.marengo-embed-2-7-v1:0": MARENGO_EMBED,
      "gemini/gemini-2.0-flash-exp-image-generation":
        FLASH_EXP_IMAGE_GENERATION,
    });
    expect(rows.map((row) => row.externalId)).toEqual([
      "litellm/xai/grok-imagine-video",
      "litellm/twelvelabs.marengo-embed-2-7-v1:0",
    ]);

    const grok = rows[0];
    expect(grok.costUnit).toBe("image");
    expect(grok.inputCost).toBe(0.002);
    expect(grok.outputCost).toBeNull();

    const marengo = rows[1];
    expect(marengo.costUnit).toBe("image");
    expect(marengo.inputCost).toBe(0.0001);
    expect(marengo.outputCost).toBeNull();
  });

  it("through main(): the gpt-image-2.5-flare row lands in the database with outputCost 30", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], {
      "gpt-image-2.5-flare": GPT_IMAGE_25_FLARE,
      "gemini/gemini-2.5-flash-image": GEMINI_25_FLASH_IMAGE,
      "xai/grok-imagine-video": GROK_IMAGINE_VIDEO,
    });

    await main();

    const flare = fake.rows.get("litellm/gpt-image-2.5-flare")!;
    expect(flare.outputCost).toBe(30);
    expect(flare.inputCost).toBe(5);
    expect(flare.costUnit).toBe("1M tokens");
    expect(flare.isActive).toBe(true);

    expect(
      fake.rows.get("litellm/gemini/gemini-2.5-flash-image")!.outputCost,
    ).toBe(2.5);
    expect(
      fake.rows.get("litellm/xai/grok-imagine-video")!.outputCost,
    ).toBeNull();
  });
});

describe("OUTPUT_RATE_PINS: a vendor-verified output rate over a stale feed number", () => {
  // A LiteLLM feed entry in which the alias carries gpt-image-1's 4e-5 image-token rate; OpenAI's pricing page prints
  // "Image | $8.00 | $2.00 | $32.00" and "Text | $5.00 | $1.25 | $10.00".
  const CHATGPT_IMAGE_LATEST = {
    cache_read_input_token_cost: 0.00000125,
    deprecation_date: "2026-12-01",
    input_cost_per_image_token: 0.00001,
    input_cost_per_token: 0.000005,
    litellm_provider: "openai",
    mode: "image_generation",
    output_cost_per_image_token: 0.00004,
    supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
  };
  const GPT_IMAGE_2 = {
    cache_read_input_token_cost: 0.00000125,
    input_cost_per_image_token: 0.000008,
    input_cost_per_token: 0.000005,
    litellm_provider: "openai",
    mode: "image_generation",
    output_cost_per_image_token: 0.00003,
  };
  const PIN_KEY = "chatgpt-image-latest|openai";

  it("pins the table: exactly one entry, $32/1M image output for chatgpt-image-latest, replacing only null, the stale 40, or the vendor text rate 10", () => {
    expect(Object.keys(OUTPUT_RATE_PINS)).toEqual([PIN_KEY]);
    const pin = OUTPUT_RATE_PINS[PIN_KEY];
    expect(pin.outputCost).toBe(32);
    expect(pin.costUnit).toBe("1M tokens");
    expect(pin.replaces).toEqual([null, 40, 10]);
    for (const [key, entry] of Object.entries(OUTPUT_RATE_PINS)) {
      // Same key shape as CACHE_RATE_BACKFILLS: canonicalName|provider.
      expect(key).toMatch(/^[^|/A-Z]+\|[a-z0-9-]+$/);
      expect(KNOWN_COST_UNITS.has(entry.costUnit)).toBe(true);
      expect(entry.outputCost).toBeGreaterThan(0);
      expect(entry.replaces.length).toBeGreaterThan(0);
    }
  });

  it("through main(): chatgpt-image-latest lands at 32, not the feed's 40; the unpinned sibling keeps its feed value", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], {
      "chatgpt-image-latest": CHATGPT_IMAGE_LATEST,
      "gpt-image-2": GPT_IMAGE_2,
    });

    await main();

    const pinned = fake.rows.get("litellm/chatgpt-image-latest")!;
    expect(pinned.outputCost).toBe(32);
    expect(pinned.inputCost).toBe(5);
    expect(pinned.cacheReadCost).toBe(1.25);
    expect(pinned.costUnit).toBe("1M tokens");

    const sibling = fake.rows.get("litellm/gpt-image-2")!;
    expect(sibling.outputCost).toBe(30);
  });

  it("also fills the original hole: a feed row with no output price at all lands at 32", async () => {
    const fake = mockDb.current;
    const { output_cost_per_image_token: _dropped, ...noOutput } =
      CHATGPT_IMAGE_LATEST;
    stubSources([GPT_4O], { "chatgpt-image-latest": noOutput });

    await main();

    expect(fake.rows.get("litellm/chatgpt-image-latest")!.outputCost).toBe(32);
  });

  it("goes quiet when the feed moves off the stale value: the feed's new number wins", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], {
      "chatgpt-image-latest": {
        ...CHATGPT_IMAGE_LATEST,
        output_cost_per_image_token: 0.000035,
      },
    });

    await main();

    const row = fake.rows.get("litellm/chatgpt-image-latest")!;
    expect(row.outputCost).toBe(35);
  });

  it("holds 32 when the feed adds the vendor's $10 text rate, which the parser would otherwise store", async () => {
    const fake = mockDb.current;
    stubSources([GPT_4O], {
      "chatgpt-image-latest": {
        ...CHATGPT_IMAGE_LATEST,
        output_cost_per_token: 0.00001,
        output_cost_per_image_token: 0.000032,
      },
    });

    await main();

    const row = fake.rows.get("litellm/chatgpt-image-latest")!;
    expect(row.outputCost).toBe(32);
  });

  it("never applies across units: a per-image row with the same canonical name is left alone", () => {
    const { rows } = buildCatalogRows(
      [],
      normalizeLiteLLM({
        "medium/1536-x-1024/chatgpt-image-latest": {
          input_cost_per_image: 0.05,
          litellm_provider: "openai",
          mode: "image_generation",
        },
      }),
    );
    const row = rows.find(
      (r) => r.externalId === "litellm/medium/1536-x-1024/chatgpt-image-latest",
    )!;
    expect(row.canonicalName).toBe("chatgpt-image-latest");
    expect(row.costUnit).toBe("image");
    expect(row.outputCost).toBeNull();
  });
});
