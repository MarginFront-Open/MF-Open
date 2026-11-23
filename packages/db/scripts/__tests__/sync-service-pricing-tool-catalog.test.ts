/**
 * The built-in tool rows, as the runtime lookup sees them after a build.
 *
 * The cost meter sends a tool call as (model = the tool name, provider =
 * "tool"), and the lookup matches canonicalName + provider. A row whose
 * canonicalName drifts from the name the agent sends prices nothing.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      throw new Error("this suite must never construct a database client");
    }
  },
}));

import {
  BUILT_IN_ROWS,
  buildCatalogRows,
  normalizeLiteLLM,
  normalizeOpenRouter,
} from "../sync-service-pricing";

// buildCatalogRows aborts on zero remote entries, so both feeds carry one
// unrelated model. Neither collides with any built-in row.
const OR_GPT_4O = {
  id: "openai/gpt-4o",
  name: "OpenAI: GPT-4o",
  pricing: { prompt: "0.0000025", completion: "0.00001" },
  context_length: 128000,
};
const LL_WHISPER = {
  "whisper-1": {
    mode: "audio_transcription",
    input_cost_per_second: 0.0001,
    litellm_provider: "openai",
  },
};

// The names exactly as Claude Code and Codex send them, typed out rather than
// read from the script, so a renamed row fails here.
const NAMES_AS_SENT = [
  "Read",
  "Bash",
  "WebFetch",
  "WebSearch",
  "ExitPlanMode",
  "ReportFindings",
  "exec_command",
  "apply_patch",
  "spawn_agent",
  "web_search",
];

function buildRows() {
  return buildCatalogRows(
    normalizeOpenRouter({ data: [OR_GPT_4O] }),
    normalizeLiteLLM({ ...LL_WHISPER }),
  ).rows;
}

describe("built-in tool rows", () => {
  it.each(NAMES_AS_SENT)(
    "%s resolves to an active tool row by the lowercased name",
    (name) => {
      const hit = buildRows().find(
        (row) =>
          row.canonicalName === name.toLowerCase() &&
          row.provider === "tool" &&
          row.isActive,
      );
      expect(hit, `no built row for ${name}`).toBeDefined();
      expect(hit!.inputCost).not.toBeNull();
    },
  );

  it("canonicalizes every built-in tool row to the name after tool/", () => {
    const rows = buildRows().filter((row) => row.source === "builtin");
    for (const row of rows) {
      if (row.provider !== "tool") continue;
      expect(row.canonicalName).toBe(row.externalId.slice("tool/".length));
    }
  });

  it("has no externalId twice", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of BUILT_IN_ROWS) {
      if (seen.has(entry.externalId)) duplicates.push(entry.externalId);
      seen.add(entry.externalId);
    }
    expect(duplicates).toEqual([]);
  });

  it("leaves no two built-in rows fighting over one lookup key", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const row of buildRows()) {
      if (row.source !== "builtin") continue;
      const key = `${row.canonicalName}|${row.provider}`;
      const first = seen.get(key);
      if (first) collisions.push(`${key}: ${first} vs ${row.externalId}`);
      else seen.set(key, row.externalId);
    }
    expect(collisions).toEqual([]);
  });

  it("holds no MCP tool rows: an MCP tool is the builder's to price", () => {
    const mcpRows = BUILT_IN_ROWS.filter((entry) =>
      entry.externalId.startsWith("tool/mcp"),
    );
    expect(mcpRows).toEqual([]);
  });
});
