// work-id.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: this machine's WORK ITEM ID rides every record
// the meter sends, through the seam CCC_DEVELOPER_EMAIL already uses - one line in
// ~/.marginfront-ccc/.env, threaded into pure builders, stamped as metadata.matterId
// on Claude token records, Codex token records, and tool records from both sources.
// metadata.matterId is the wire field MarginFront ingest matches against, so the
// meter adds no new concept: it fills in a field ingest already reads. The field
// name is a wire contract.
//
// TWO KEYS ARE SUPPORTED: CCC_WORK_ID and the older CCC_MATTER_ID. Precedence,
// highest first: CCC_WORK_ID in the settings file, then CCC_MATTER_ID in that file,
// then either key exported into the shell that started the meter. A key that is
// set but blank never beats a key that has a value - a blank line the template ships
// would otherwise silently delete the attribution of a machine whose value sits on
// CCC_MATTER_ID.
//
// THE NO-NUMBER HALF MATTERS AS MUCH AS THE FEATURE HALF: with the line unset, every
// built record must be deep-equal to the same build with no matterNumber option at
// all. That is the "unchanged output" guarantee - a user who never sets a number
// sees no difference in what lands in signal_events.
//
// THE THIRD THING: the number is re-read
// from disk per telemetry line behind a modified-time guard, so a person who edits
// the line sees it on the next record instead of after a `stop` and a `start` nobody
// performs on a meter they cannot see.
// ---------------------------------------------------------------------------

import { test, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildMarginFrontRequestBody,
  buildCodexRequestBody,
  buildToolUsageRecords,
  resolveWorkId,
  createWorkIdReader,
  watchAndForward,
  MATTER_NUMBER_ENV_KEY,
  WORK_ID_ENV_KEY,
  WORK_ITEM_NOUN,
  WORK_ITEM_NOUN_PLAIN,
} from "../src/forwarder";
import { cmdInit, workIdInitStep, workIdStatusLine } from "../src/cli";
import { ENV_PATH, renderEnvFile } from "../src/connector";
import type {
  OtlpLogAttribute,
  OtlpLogRecord,
  ParsedOtlp,
  UsageRecord,
} from "../src/types";
import type {
  CodexControlStatus,
  CodexTrustCacheEntry,
  CodexTrustDeps,
} from "../src/control";

// --- minimal OTLP fixtures (local copies, so this file stands alone) ---------

function strAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function logStrAttr(key: string, value: string): OtlpLogAttribute {
  return { key, value: { stringValue: value } };
}

function logIntAttr(key: string, value: number): OtlpLogAttribute {
  return { key, value: { intValue: String(value) } };
}

const EMAIL = "dev@example.com";

// One Claude Code turn: input + output tokens and a cost point for one session.
function claudeTurn(sessionId = "session-matter-1"): ParsedOtlp {
  const id = [
    strAttr("user.email", EMAIL),
    strAttr("model", "claude-opus-4-8[1m]"),
    strAttr("session.id", sessionId),
  ];
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  dataPoints: [
                    {
                      attributes: [...id, strAttr("type", "input")],
                      asInt: "1200",
                    },
                    {
                      attributes: [...id, strAttr("type", "output")],
                      asInt: "340",
                    },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: { dataPoints: [{ attributes: id, asDouble: 0.1234 }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

// One codex.sse_event token record.
function codexTurn(): ParsedOtlp {
  const record: OtlpLogRecord = {
    attributes: [
      logStrAttr("event.name", "codex.sse_event"),
      logStrAttr("user.email", EMAIL),
      logStrAttr("model", "gpt-5-codex"),
      logStrAttr("conversation.id", "conv-matter-1"),
      logIntAttr("input_token_count", 1000),
      logIntAttr("output_token_count", 500),
      logIntAttr("cached_token_count", 800),
      logIntAttr("reasoning_token_count", 300),
      logIntAttr("tool_token_count", 20),
    ],
  };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }] };
}

// One executed tool call. eventName picks the source: Claude's "tool_result" or
// Codex's "codex.tool_result".
function toolCall(eventName: string, toolName: string): OtlpLogRecord {
  return {
    attributes: [
      logStrAttr("event.name", eventName),
      logStrAttr(
        eventName === "tool_result" ? "tool_name" : "tool.name",
        toolName,
      ),
      logStrAttr("user.email", EMAIL),
      logStrAttr("session.id", "session-matter-1"),
    ],
  };
}

function toolTree(eventName: string, toolName: string): ParsedOtlp {
  return {
    resourceLogs: [
      { scopeLogs: [{ logRecords: [toolCall(eventName, toolName)] }] },
    ],
  };
}

// ===========================================================================
// 1. resolveWorkId - the environment -> {value, key} seam, in isolation (same shape
//    as the resolveDeveloperOverride tests in forwarder.test.ts). It reports WHICH
//    key answered, because `status` prints that back and a machine still on the
//    older key must be told the older name.
// ===========================================================================

test("resolveWorkId: an unset environment resolves to nothing", () => {
  expect(resolveWorkId({})).toEqual({ value: undefined });
});

test("resolveWorkId: an empty string resolves to nothing", () => {
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: "" }).value).toBeUndefined();
});

test("resolveWorkId: a whitespace-only value resolves to nothing", () => {
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: "   \t " }).value).toBeUndefined();
});

test("resolveWorkId: trims surrounding whitespace off a real ID", () => {
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: "  PROJ-123  " })).toEqual({
    value: "PROJ-123",
    key: WORK_ID_ENV_KEY,
  });
});

test("resolveWorkId: the older key still answers, and names itself", () => {
  expect(resolveWorkId({ [MATTER_NUMBER_ENV_KEY]: "PROJ-123" })).toEqual({
    value: "PROJ-123",
    key: MATTER_NUMBER_ENV_KEY,
  });
});

test("resolveWorkId: the new key wins when both carry a value", () => {
  expect(
    resolveWorkId({
      [WORK_ID_ENV_KEY]: "NEW-KEY",
      [MATTER_NUMBER_ENV_KEY]: "OLD-KEY",
    }),
  ).toEqual({ value: "NEW-KEY", key: WORK_ID_ENV_KEY });
});

// The footgun this ordering exists to close: the template ships a blank
// CCC_WORK_ID= line, so "the new key wins" read as "the new key wins even blank"
// would delete the attribution of every machine whose value sits on the older key.
test("resolveWorkId: a blank new key never beats an older key that has a value", () => {
  expect(
    resolveWorkId({
      [WORK_ID_ENV_KEY]: "   ",
      [MATTER_NUMBER_ENV_KEY]: "OLD-KEY",
    }),
  ).toEqual({ value: "OLD-KEY", key: MATTER_NUMBER_ENV_KEY });
});

test("resolveWorkId: a 255-character ID passes through whole", () => {
  const exact = "x".repeat(255);
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: exact }).value).toBe(exact);
});

test("resolveWorkId: a longer ID is truncated to the 255-char ingest cap", () => {
  const long = "y".repeat(300);
  const resolved = resolveWorkId({ [WORK_ID_ENV_KEY]: long }).value;
  expect(resolved).toHaveLength(255);
  expect(resolved).toBe("y".repeat(255));
});

test("resolveWorkId: trimming happens BEFORE the cap, so padding can't eat the ID", () => {
  const padded = `   ${"z".repeat(255)}   `;
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: padded }).value).toBe(
    "z".repeat(255),
  );
});

// Ingest matches the ID EXACTLY, capitals included, so a meter that "helpfully"
// upper-cased a typed value would turn a diagnosable Unassigned row into a silently
// wrong attribution.
test("resolveWorkId: capitalisation is never changed - proj-123 stays proj-123", () => {
  expect(resolveWorkId({ [WORK_ID_ENV_KEY]: "proj-123" }).value).toBe(
    "proj-123",
  );
});

// ===========================================================================
// 2. The number reaches EVERY builder as metadata.matterId.
// ===========================================================================

const MATTER = "PROJ-123";

test("a Claude token record carries metadata.matterId when the number is set", () => {
  const { records } = buildMarginFrontRequestBody(claudeTurn(), {
    matterNumber: MATTER,
  });
  expect(records.length).toBe(1);
  expect(records[0].metadata.matterId).toBe(MATTER);
});

test("a Codex token record carries metadata.matterId when the number is set", () => {
  const { records } = buildCodexRequestBody(codexTurn(), {
    matterNumber: MATTER,
  });
  expect(records.length).toBe(1);
  expect(records[0].metadata.matterId).toBe(MATTER);
});

test("a Claude TOOL record carries metadata.matterId when the number is set", () => {
  const { records } = buildToolUsageRecords(
    toolTree("tool_result", "mcp__browserbase__navigate"),
    { matterNumber: MATTER },
  );
  expect(records.length).toBe(1);
  expect(records[0].signalName).toBe("claude-code-tool");
  expect(records[0].metadata.matterId).toBe(MATTER);
});

test("a Codex TOOL record carries metadata.matterId when the number is set", () => {
  const { records } = buildToolUsageRecords(
    toolTree("codex.tool_result", "shell"),
    { matterNumber: MATTER },
  );
  expect(records.length).toBe(1);
  expect(records[0].signalName).toBe("codex-tool");
  expect(records[0].metadata.matterId).toBe(MATTER);
});

// Nothing may stamp metadata.task: the platform reads matterId and only matterId.
test("no builder stamps metadata.task", () => {
  const bodies = [
    buildMarginFrontRequestBody(claudeTurn(), { matterNumber: MATTER }),
    buildCodexRequestBody(codexTurn(), { matterNumber: MATTER }),
    buildToolUsageRecords(toolTree("tool_result", "Read"), {
      matterNumber: MATTER,
    }),
    buildToolUsageRecords(toolTree("codex.tool_result", "shell"), {
      matterNumber: MATTER,
    }),
  ];
  for (const body of bodies) {
    for (const record of body.records) {
      expect("task" in record.metadata).toBe(false);
    }
  }
});

// ===========================================================================
// 3. No number => identical to a build that never heard of the
//    option. Deep-equal, all four shapes.
// ===========================================================================

test("no number: every builder's output is deep-equal to a build with no matterNumber option", () => {
  expect(
    buildMarginFrontRequestBody(claudeTurn(), { matterNumber: undefined }),
  ).toEqual(buildMarginFrontRequestBody(claudeTurn()));

  expect(
    buildCodexRequestBody(codexTurn(), { matterNumber: undefined }),
  ).toEqual(buildCodexRequestBody(codexTurn()));

  const claudeTool = toolTree("tool_result", "Read");
  expect(
    buildToolUsageRecords(claudeTool, { matterNumber: undefined }),
  ).toEqual(buildToolUsageRecords(claudeTool));

  const codexTool = toolTree("codex.tool_result", "shell");
  expect(buildToolUsageRecords(codexTool, { matterNumber: undefined })).toEqual(
    buildToolUsageRecords(codexTool),
  );
});

test("no number: the key is ABSENT, not present-and-undefined (a serialized record gains no matterId)", () => {
  const { records } = buildMarginFrontRequestBody(claudeTurn());
  expect("matterId" in records[0].metadata).toBe(false);
  expect(JSON.stringify(records[0])).not.toContain('"matterId"');
});

// The same guarantee one layer up, through the real reader rather than a hand-passed
// undefined: the file the template writes carries BOTH keys, both blank. That
// is what every customer who never sets either one has on disk, so it is the shape
// that has to produce an untagged record.
test("no number: a settings file with both keys blank builds records deep-equal to a build that never heard of the option", () => {
  const { dir, path } = tempEnvFile(
    `${WORK_ID_ENV_KEY}=\n${MATTER_NUMBER_ENV_KEY}=\n`,
  );
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    const resolved = read();
    expect(resolved.value).toBeUndefined();

    expect(
      buildMarginFrontRequestBody(claudeTurn(), {
        matterNumber: resolved.value,
      }),
    ).toEqual(buildMarginFrontRequestBody(claudeTurn()));
    expect(
      buildCodexRequestBody(codexTurn(), { matterNumber: resolved.value }),
    ).toEqual(buildCodexRequestBody(codexTurn()));

    const claudeTool = toolTree("tool_result", "Read");
    expect(
      buildToolUsageRecords(claudeTool, { matterNumber: resolved.value }),
    ).toEqual(buildToolUsageRecords(claudeTool));

    const codexTool = toolTree("codex.tool_result", "shell");
    expect(
      buildToolUsageRecords(codexTool, { matterNumber: resolved.value }),
    ).toEqual(buildToolUsageRecords(codexTool));

    const serialized = JSON.stringify(
      buildMarginFrontRequestBody(claudeTurn(), {
        matterNumber: resolved.value,
      }),
    );
    expect(serialized).not.toContain('"matterId"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. INTEGRATION: environment -> resolveWorkId -> builder, the path a machine
//    takes when it exports the variable instead of writing the settings line.
// ===========================================================================

afterEach(() => {
  delete process.env.CCC_MATTER_ID;
  delete process.env.CCC_WORK_ID;
});

test("INTEGRATION: env -> resolveWorkId -> builder stamps the machine's work item", () => {
  delete process.env.CCC_MATTER_ID;
  delete process.env.CCC_WORK_ID;
  const untagged = buildMarginFrontRequestBody(claudeTurn(), {
    matterNumber: resolveWorkId(process.env).value,
  });
  expect("matterId" in untagged.records[0].metadata).toBe(false);

  process.env.CCC_WORK_ID = "  Q3-pricing-model  ";
  const tagged = buildMarginFrontRequestBody(claudeTurn(), {
    matterNumber: resolveWorkId(process.env).value,
  });
  expect(tagged.records[0].metadata.matterId).toBe("Q3-pricing-model");
});

test("INTEGRATION: a machine exporting the older key is metered under it", () => {
  delete process.env.CCC_WORK_ID;
  process.env.CCC_MATTER_ID = "OLD-KEY-JOB";
  const tagged = buildMarginFrontRequestBody(claudeTurn(), {
    matterNumber: resolveWorkId(process.env).value,
  });
  expect(tagged.records[0].metadata.matterId).toBe("OLD-KEY-JOB");
});

// ===========================================================================
// 5. The settings template ships the line, blank, with instructions a
//    non-technical person can follow.
// ===========================================================================

test("the .env template carries a blank CCC_WORK_ID= line", () => {
  const template = renderEnvFile();
  expect(template).toMatch(/^CCC_WORK_ID=$/m);
});

// The older key stays in the template, blank and documented as the older name. A
// customer who set it before upgrading opens this file, finds their own line still
// here, and is told it still works rather than left guessing.
test("the .env template still carries a blank CCC_MATTER_ID= line, documented as the older name", () => {
  const template = renderEnvFile();
  expect(template).toMatch(/^CCC_MATTER_ID=$/m);
  const idx = template.indexOf("\nCCC_MATTER_ID=");
  const above = template.slice(0, idx).split("\n").slice(-4).join("\n");
  expect(above).toMatch(/older name/);
  expect(above).toMatch(/CCC_WORK_ID/);
});

test("the template says what the line does, in which order, and that capitals count", () => {
  const template = renderEnvFile();
  const idx = template.indexOf("\nCCC_WORK_ID=");
  expect(idx).toBeGreaterThan(-1);
  // The comment block directly above the line: at least three explanatory lines,
  // every one of them a comment.
  const above = template.slice(0, idx).split("\n").slice(-6);
  expect(
    above.filter((line) => line.startsWith("#")).length,
  ).toBeGreaterThanOrEqual(3);
  // The template never says "create it first" or mentions an Unassigned bucket,
  // because the meter knows neither. The spelling rule is what it can honestly
  // promise.
  expect(template).toMatch(/Pick a short name for the piece of work/);
  expect(template).toMatch(/USE THE SAME SPELLING EVERY TIME/);
  // The tab lists what the meter RECORDED, and this file cannot see whether
  // recording is even on, so it sends nobody there.
  expect(template).not.toMatch(/Finished work\n# tab|Finished work tab/);
  expect(template).toMatch(/Counting what you FINISH is a separate switch/);
  // The promise the live re-read makes: no stop, no start.
  expect(template).toMatch(/nothing to\n#\s+restart/);
});

// This file lands on the user's own hard drive, and `init` never rewrites one that
// already exists - so the worked example must stay generic for the life of the
// install.
test("the template's worked example names ordinary work, in neutral wording", () => {
  const template = renderEnvFile();
  expect(template).toContain("$18 went to the Q3 pricing model");
  const block = template.slice(
    template.indexOf("# WHICH WORK ITEM"),
    template.indexOf("\nCCC_MATTER_ID="),
  );
  expect(block).not.toMatch(/\bmatters?\b/i);
  expect(block).not.toMatch(/\b(legal|law firm|attorney|filing)\b/i);
});

test("the template has no CCC_TASK_LABEL line", () => {
  expect(renderEnvFile()).not.toContain("CCC_TASK_LABEL");
});

// ===========================================================================
// 6. THE LIVE RE-READ. The settings file is consulted per telemetry line, behind a
//    modified-time guard, so an edit lands on the next record with no restart.
// ===========================================================================

function tempEnvFile(contents: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-work-id-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return { dir, path };
}

// Writing twice inside the same millisecond leaves mtimeMs unchanged, which would
// make these tests flake rather than fail. Stamping the time explicitly takes the
// clock out of the test without taking the guard out of the code.
function rewrite(path: string, contents: string, secondsLater: number): void {
  writeFileSync(path, contents);
  const when = new Date(Date.now() + secondsLater * 1000);
  utimesSync(path, when, when);
}

test("the file line, not the shell, decides the work item", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=FROM-FILE\n");
  try {
    const read = createWorkIdReader({
      envPath: path,
      env: { CCC_WORK_ID: "FROM-SHELL" },
    });
    expect(read()).toEqual({ value: "FROM-FILE", key: WORK_ID_ENV_KEY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the older key alone in the file still decides the work item, and says so", () => {
  const { dir, path } = tempEnvFile("CCC_MATTER_ID=FROM-OLD-KEY\n");
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read()).toEqual({
      value: "FROM-OLD-KEY",
      key: MATTER_NUMBER_ENV_KEY,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both keys in the file: the new one wins", () => {
  const { dir, path } = tempEnvFile(
    "CCC_WORK_ID=NEW-KEY\nCCC_MATTER_ID=OLD-KEY\n",
  );
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read().value).toBe("NEW-KEY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The upgrade shape: the template writes a blank CCC_WORK_ID= line above the
// customer's existing CCC_MATTER_ID line. Their attribution has to survive that.
test("a blank new-key line does not delete a value set on the older key", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=\nCCC_MATTER_ID=OLD-KEY\n");
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read()).toEqual({ value: "OLD-KEY", key: MATTER_NUMBER_ENV_KEY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both lines present but blank means not set, even with the variable exported", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=\nCCC_MATTER_ID=\n");
  try {
    const read = createWorkIdReader({
      envPath: path,
      env: { CCC_MATTER_ID: "FROM-SHELL" },
    });
    expect(read().value).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one line present but blank, the other absent, means not set", () => {
  const { dir, path } = tempEnvFile("CCC_MATTER_ID=\n");
  try {
    const read = createWorkIdReader({
      envPath: path,
      env: { CCC_MATTER_ID: "FROM-SHELL" },
    });
    expect(read().value).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no settings file at all: an exported older-key variable still works", () => {
  const read = createWorkIdReader({
    envPath: join(tmpdir(), "ccc-work-id-no-such-file", ".env"),
    env: { CCC_MATTER_ID: "FROM-SHELL" },
  });
  expect(read()).toEqual({
    value: "FROM-SHELL",
    key: MATTER_NUMBER_ENV_KEY,
  });
});

test("an edited line is picked up without rebuilding the reader", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=JOB-ONE\n");
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read().value).toBe("JOB-ONE");
    rewrite(path, "CCC_WORK_ID=JOB-TWO\n", 2);
    expect(read().value).toBe("JOB-TWO");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the new-key line falls back to the older key still in the file", () => {
  const { dir, path } = tempEnvFile(
    "CCC_WORK_ID=JOB-ONE\nCCC_MATTER_ID=OLD-KEY\n",
  );
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read().value).toBe("JOB-ONE");
    rewrite(path, "CCC_MATTER_ID=OLD-KEY\n", 2);
    expect(read()).toEqual({ value: "OLD-KEY", key: MATTER_NUMBER_ENV_KEY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the only line unsets the work item", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=JOB-ONE\n");
  try {
    const read = createWorkIdReader({ envPath: path, env: {} });
    expect(read().value).toBe("JOB-ONE");
    rewrite(path, "CCC_DEVELOPER_EMAIL=someone@example.com\n", 2);
    expect(read().value).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the modified-time guard: the file is parsed once until it actually changes", () => {
  const { dir, path } = tempEnvFile("CCC_WORK_ID=JOB-ONE\n");
  const parses: string[] = [];
  try {
    const read = createWorkIdReader({
      envPath: path,
      env: {},
      readFileValues: (filePath) => {
        parses.push(filePath);
        return { CCC_WORK_ID: "JOB-ONE" };
      },
    });
    // The call site runs once per telemetry line. Ten lines, one parse - and one
    // parse for BOTH keys, not one per key.
    for (let i = 0; i < 10; i++) expect(read().value).toBe("JOB-ONE");
    expect(parses.length).toBe(1);

    // Touching the file is what buys a second parse, nothing else.
    rewrite(path, "CCC_WORK_ID=JOB-ONE\n", 3);
    expect(read().value).toBe("JOB-ONE");
    expect(parses.length).toBe(2);
    for (let i = 0; i < 5; i++) read();
    expect(parses.length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function inMemoryCodexTrust(): CodexTrustDeps {
  const status: CodexControlStatus = { state: "unknown", reason: "test" };
  let cached: CodexTrustCacheEntry | null = null;
  return {
    resolveStatus: async () => status,
    readCache: () => cached,
    writeCache: (resolved, cccVersion) => {
      cached = {
        state: resolved.state,
        reason: resolved.reason ?? null,
        resolvedAt: new Date().toISOString(),
        ccc: cccVersion,
      };
      return cached;
    },
  };
}

// Poll until the stubbed fetch has taken `count` batches, so these tests wait on the
// watcher's real timer instead of a sleep long enough to be flaky on a loaded machine.
async function waitForCaptured(
  captured: Array<{ records: UsageRecord[] }>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (captured.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(captured.length).toBeGreaterThanOrEqual(count);
}

// The one that proves the promise a customer is given. The watcher keeps running the
// whole time: no stop, no start, no new process.
test("LIVE: a number edited on disk reaches the NEXT record the running meter builds", async () => {
  const captured: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const dir = mkdtempSync(join(tmpdir(), "ccc-work-id-live-"));
  const jsonlPath = join(dir, "live.jsonl");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "CCC_MATTER_ID=MATTER-ONE\n");
  writeFileSync(jsonlPath, JSON.stringify(claudeTurn("session-live-1")) + "\n");

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-matter-live";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
      matterEnvPath: envPath,
      // This test runs the watcher across several polls, and the Codex trust rider
      // fires on one of them. Its real cache writer creates ~/.marginfront-ccc on
      // whatever machine is running, which on a CI box trips the suite's own
      // real-home guard in the NEXT test file. In memory, it touches nothing.
      codexTrustDeps: inMemoryCodexTrust(),
    });

    await waitForCaptured(captured, 1);
    expect(captured[0].records[0].metadata.matterId).toBe("MATTER-ONE");

    // The person switches jobs: one line edited, nothing restarted.
    rewrite(envPath, "CCC_MATTER_ID=MATTER-TWO\n", 2);
    appendFileSync(
      jsonlPath,
      JSON.stringify(claudeTurn("session-live-2")) + "\n",
    );

    await waitForCaptured(captured, 2);
    expect(captured[1].records[0].metadata.matterId).toBe("MATTER-TWO");
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
// The same promise on CCC_WORK_ID, and the move between the two keys. A person who
// moves their value from CCC_MATTER_ID to CCC_WORK_ID gets the switch on the next
// record, with the meter still running.
test("LIVE: the new key is read per record, and taking over from the older key needs no restart", async () => {
  const captured: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const dir = mkdtempSync(join(tmpdir(), "ccc-work-id-live-"));
  const jsonlPath = join(dir, "live.jsonl");
  const envPath = join(dir, ".env");
  // A blank CCC_WORK_ID line above a CCC_MATTER_ID line that carries the value.
  writeFileSync(envPath, "CCC_WORK_ID=\nCCC_MATTER_ID=OLD-KEY-JOB\n");
  writeFileSync(jsonlPath, JSON.stringify(claudeTurn("session-work-1")) + "\n");

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-work-id-live";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
      matterEnvPath: envPath,
      codexTrustDeps: inMemoryCodexTrust(),
    });

    await waitForCaptured(captured, 1);
    expect(captured[0].records[0].metadata.matterId).toBe("OLD-KEY-JOB");

    // The person moves their value up to CCC_WORK_ID. Nothing restarted.
    rewrite(envPath, "CCC_WORK_ID=NEW-KEY-JOB\nCCC_MATTER_ID=OLD-KEY-JOB\n", 2);
    appendFileSync(
      jsonlPath,
      JSON.stringify(claudeTurn("session-work-2")) + "\n",
    );

    await waitForCaptured(captured, 2);
    expect(captured[1].records[0].metadata.matterId).toBe("NEW-KEY-JOB");

    // And blanking both lines unsets it, rather than resurrecting the older value.
    rewrite(envPath, "CCC_WORK_ID=\nCCC_MATTER_ID=\n", 4);
    appendFileSync(
      jsonlPath,
      JSON.stringify(claudeTurn("session-work-3")) + "\n",
    );

    await waitForCaptured(captured, 3);
    expect(captured[2].records[0].metadata.matterId).toBeUndefined();
    expect(JSON.stringify(captured[2])).not.toContain('"matterId"');
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// The unset half of the same promise. `run` copies the settings file into this
// process's environment at startup, so "fall back to the environment" and "read the
// file" stop being different questions the moment the meter starts, so a deleted
// line must not keep resolving out of that copy and leave the records carrying a
// matter number the file no longer names.
test("LIVE: deleting the line unsets the matter, even after startup copied it into the environment", async () => {
  const captured: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const dir = mkdtempSync(join(tmpdir(), "ccc-work-id-unset-"));
  const jsonlPath = join(dir, "live.jsonl");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "CCC_MATTER_ID=OLD-JOB\n");
  writeFileSync(
    jsonlPath,
    JSON.stringify(claudeTurn("session-unset-1")) + "\n",
  );

  const savedKey = process.env.MARGINFRONT_API_KEY;
  const savedMatter = process.env.CCC_MATTER_ID;
  process.env.MARGINFRONT_API_KEY = "test-key-matter-unset";
  // Exactly what loadEnvFile() leaves behind at `run` startup: the file's own value,
  // sitting in the environment, indistinguishable from a shell export.
  process.env.CCC_MATTER_ID = "OLD-JOB";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
      matterEnvPath: envPath,
      codexTrustDeps: inMemoryCodexTrust(),
    });

    await waitForCaptured(captured, 1);
    expect(captured[0].records[0].metadata.matterId).toBe("OLD-JOB");

    // The person finishes the job and deletes the line instead of blanking it.
    rewrite(envPath, "CCC_DEVELOPER_EMAIL=someone@example.com\n", 2);
    appendFileSync(
      jsonlPath,
      JSON.stringify(claudeTurn("session-unset-2")) + "\n",
    );

    await waitForCaptured(captured, 2);
    expect(captured[1].records[0].metadata.matterId).toBeUndefined();
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    if (savedMatter === undefined) delete process.env.CCC_MATTER_ID;
    else process.env.CCC_MATTER_ID = savedMatter;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// The upgrade path the snapshot keeps alive: a settings file can carry no
// CCC_MATTER_ID line at all, so a variable exported in the shell that
// started the meter is still the answer.
test("LIVE: with no such line in the file, the exported variable rides every record", async () => {
  const captured: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const dir = mkdtempSync(join(tmpdir(), "ccc-work-id-exported-"));
  const jsonlPath = join(dir, "live.jsonl");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "CCC_DEVELOPER_EMAIL=someone@example.com\n");
  writeFileSync(
    jsonlPath,
    JSON.stringify(claudeTurn("session-exported-1")) + "\n",
  );

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-matter-exported";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
      matterEnvPath: envPath,
      matterEnv: { CCC_MATTER_ID: "EXPORTED-JOB" },
      codexTrustDeps: inMemoryCodexTrust(),
    });

    await waitForCaptured(captured, 1);
    expect(captured[0].records[0].metadata.matterId).toBe("EXPORTED-JOB");
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// ===========================================================================
// 7. `status` says what the ID is and what happens if it matches nothing. It may
//    never say the ID is valid: the meter cannot check.
// ===========================================================================

test("the status line names the ID, the key that supplied it, the real file path, and where to go to see it", () => {
  expect(
    workIdStatusLine({ value: "PROJ-123", key: WORK_ID_ENV_KEY }, true),
  ).toBe(
    `Work item: PROJ-123 (from CCC_WORK_ID in ${ENV_PATH}). Everything this machine sends carries that name, so this machine's AI spend adds up under it. On your MarginFront dashboard, open ROI in the left menu (ask whoever owns your MarginFront account if you don't see it), then the Finished work tab, to see what you finished under it and what it cost in AI.`,
  );
});

// A name on the spend is not a row on the tab, which lists what `done` recorded, so
// with counting off this line stops rather than pointing at an empty tab.
test("with finished-work counting off, the status line promises no tab", () => {
  expect(
    workIdStatusLine({ value: "PROJ-123", key: WORK_ID_ENV_KEY }, false),
  ).toBe(
    `Work item: PROJ-123 (from CCC_WORK_ID in ${ENV_PATH}). Everything this machine sends carries that name, so this machine's AI spend adds up under it.`,
  );
  expect(workIdStatusLine({ value: undefined }, false)).toBe(
    `Work item: not set. Set CCC_WORK_ID in ${ENV_PATH}, or run node ~/.marginfront-ccc/cli.js work "<name>" in your terminal, and this machine's AI spend adds up under that one name.`,
  );
});

// All four shapes, not the two that were easiest to type out: a claim about the
// status line has to hold in both finished-work modes.
function everyStatusLine(): string[] {
  return [true, false].flatMap((counted) => [
    workIdStatusLine({ value: "PROJ-123", key: WORK_ID_ENV_KEY }, counted),
    workIdStatusLine({ value: undefined }, counted),
  ]);
}

// A machine still on the older key is told the older key's name. Printing
// CCC_WORK_ID here would send that customer looking for a line their file does not
// have.
test("the status line names whichever key actually supplied the ID", () => {
  expect(
    workIdStatusLine({ value: "PROJ-123", key: MATTER_NUMBER_ENV_KEY }, true),
  ).toContain("(from CCC_MATTER_ID in ");
});

test("the status line with nothing set says where the spend goes and how to change it", () => {
  expect(workIdStatusLine({ value: undefined }, true)).toBe(
    `Work item: not set. Set CCC_WORK_ID in ${ENV_PATH}, or run node ~/.marginfront-ccc/cli.js work "<name>" in your terminal, and this machine's AI spend adds up under that one name. On your MarginFront dashboard, open ROI in the left menu (ask whoever owns your MarginFront account if you don't see it), then the Finished work tab, to see what you've finished so far and what it cost in AI.`,
  );
});

// The Windows half of that: every other row of `status` prints the resolved path, so
// a hardcoded tilde would make one command print two spellings of the same file on the one
// platform that does not use tildes.
test("the status line prints the resolved settings path, never a hardcoded tilde", () => {
  for (const line of everyStatusLine()) {
    expect(line).toContain(ENV_PATH);
    expect(line).not.toContain("~/.marginfront-ccc/.env");
  }
});

test("the status line never claims the ID is valid or matched", () => {
  for (const line of everyStatusLine()) {
    expect(line).not.toMatch(/\bvalid\b/i);
    expect(line).not.toMatch(/\bmatched\b/i);
  }
});

// One exported noun, so renaming what the product calls this thing is one line here
// rather than a hunt through printed copy.
test("the printed nouns come from the two exported constants", () => {
  expect(WORK_ITEM_NOUN).toBe("work item");
  expect(WORK_ITEM_NOUN_PLAIN).toBe("piece of work");
  // Mid-sentence, straight from the constants: rename either one and a hardcoded
  // copy of the old spelling fails here instead of shipping beside the new one.
  const step = workIdInitStep({ value: undefined });
  expect(step).toContain(`put this machine's spend on a ${WORK_ITEM_NOUN}.`);
  expect(step).toContain(`Pick a short name for the ${WORK_ITEM_NOUN_PLAIN}:`);
  // And the label that opens each line, capitalised from the same constant rather
  // than written out a second time.
  const label =
    WORK_ITEM_NOUN.charAt(0).toUpperCase() + WORK_ITEM_NOUN.slice(1);
  expect(
    workIdStatusLine({ value: undefined }, false).startsWith(`${label}: `),
  ).toBe(true);
  expect(
    workIdStatusLine(
      { value: "PROJ-123", key: WORK_ID_ENV_KEY },
      true,
    ).startsWith(`${label}: `),
  ).toBe(true);
});

// ===========================================================================
// 8. The last thing `init` prints about this. `init` never rewrites a settings file
//    that already exists, so an upgrading customer is reading this with the OLDER
//    key sitting in their file: name the key they have, not the one they don't.
// ===========================================================================

test("init: a fresh settings file gets the new key, and only the new key", () => {
  const step = workIdInitStep(resolveWorkId({}));

  expect(step).toContain(
    `Put that name after ${WORK_ID_ENV_KEY}= in ${ENV_PATH}`,
  );
  expect(step).not.toContain(MATTER_NUMBER_ENV_KEY);
});

test("init: a file already carrying the older key is told to use the key it has", () => {
  const step = workIdInitStep(
    resolveWorkId({ [MATTER_NUMBER_ENV_KEY]: "PROJ-123" }),
  );

  expect(step).toContain(
    `Put that name after ${MATTER_NUMBER_ENV_KEY}= in ${ENV_PATH}`,
  );
  expect(step).toContain(`${MATTER_NUMBER_ENV_KEY} is the key in effect`);
  expect(step).toContain(`${WORK_ID_ENV_KEY} is the newer name`);
});

test("init: a file already carrying the new key names that one, alone", () => {
  const step = workIdInitStep(resolveWorkId({ [WORK_ID_ENV_KEY]: "PROJ-123" }));

  expect(step).toContain(
    `Put that name after ${WORK_ID_ENV_KEY}= in ${ENV_PATH}`,
  );
  expect(step).not.toContain(MATTER_NUMBER_ENV_KEY);
});

// The wiring, not the renderer: cmdInit has to hand it the settings file this run
// kept. A version resolving from process.env instead passes every test above and
// still sends an upgrading customer after a line they have not got.
test("init: the real command reads the kept settings file, not the shell", async () => {
  process.env[MATTER_NUMBER_ENV_KEY] = "FROM-THE-SHELL";

  const logs: string[] = [];
  const code = await cmdInit(true, false, {
    platform: () => "darwin",
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_saved",
      [MATTER_NUMBER_ENV_KEY]: "PROJ-123",
    }),
    isTTY: () => false,
    hasApiKey: () => true,
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    claudeInstalled: () => false,
    codexInstalled: () => false,
    installDaemon: () => ({ reloaded: false }),
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    log: (message) => logs.push(message),
    errorLog: (message) => logs.push(message),
  });
  const out = logs.join("\n");

  expect(code).toBe(0);
  expect(out).toContain(
    `Put that name after ${MATTER_NUMBER_ENV_KEY}= in ${ENV_PATH}`,
  );
  expect(out).not.toContain("FROM-THE-SHELL");
});

// ===========================================================================
// 9. The REAL CLI, spawned under a throwaway HOME: `status` and `preview` tell the
//    truth about the number, not only the pure renderer above.
// ===========================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CLI_SOURCE = join(PACKAGE_ROOT, "src", "cli.ts");
const TS_HOOK_URL = pathToFileURL(
  join(HERE, "helpers", "ts-import-hook.mjs"),
).href;
const FIXTURE = join(HERE, "fixtures", "claude-with-email.otlp.json");
// A real Codex exec capture that carries no token counts: previews as {"records": []}.
const EMPTY_FIXTURE = join(HERE, "fixtures", "codex-exec-capture-0.146.json");

// A throwaway HOME means the CLI derives ~/.marginfront-ccc/.env inside it, so the
// settings line under test is the real one the real code path reads.
function runCli(
  args: string[],
  options: { envLine?: string; workIdVar?: string } = {},
): string {
  const home = mkdtempSync(join(tmpdir(), "ccc-work-id-home-"));
  // libuv's os.homedir() reads USERPROFILE on Windows, not HOME, and ENV_PATH is
  // built from it at module load: set both or the child reads the runner's own home.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  delete env.MARGINFRONT_API_KEY;
  delete env.CCC_MATTER_ID;
  delete env.CCC_WORK_ID;
  if (options.workIdVar !== undefined) env.CCC_WORK_ID = options.workIdVar;
  try {
    if (options.envLine !== undefined) {
      const configDir = join(home, ".marginfront-ccc");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, ".env"), options.envLine);
    }
    const result = spawnSync(
      process.execPath,
      ["--import", TS_HOOK_URL, CLI_SOURCE, ...args],
      { encoding: "utf8", env, timeout: 120_000 },
    );
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("CLI status on a machine with nothing set prints the not-set sentence", () => {
  const out = runCli(["status"]);
  expect(out).toContain("Work item: not set.");
  expect(out).toContain("Set CCC_WORK_ID in ");
  // Counting finished work is off on a fresh machine, so the work-item line sends
  // nobody to a tab that would have nothing on it.
  expect(out).toContain("this machine's AI spend adds up under that one name.");
  expect(out).not.toContain("to see it.");
}, 180_000);

test("CLI status reads the ID back off the new settings line", () => {
  const out = runCli(["status"], { envLine: "CCC_WORK_ID=Q3-pricing-model\n" });
  expect(out).toContain("Work item: Q3-pricing-model (from CCC_WORK_ID in ");
  expect(out).toContain(
    "Everything this machine sends carries that name, so this machine's AI spend adds up under it.",
  );
}, 180_000);

// The upgrade path end to end, through the real binary: nothing about a machine on
// the older key stops working, and status names the key that machine actually has.
test("CLI status reads the ID back off the older settings line and names that key", () => {
  const out = runCli(["status"], { envLine: "CCC_MATTER_ID=OLD-KEY-JOB\n" });
  expect(out).toContain("Work item: OLD-KEY-JOB (from CCC_MATTER_ID in ");
}, 180_000);

test("CLI status uses neutral wording throughout", () => {
  const out = runCli(["status"]);
  expect(out).not.toMatch(/\bmatters?\b/i);
  expect(out).not.toMatch(/\b(legal|law firm|attorney)\b/i);
}, 180_000);

test("preview with a work item set shows it on the record it would send, and names it", () => {
  const out = runCli(["preview", FIXTURE], { workIdVar: "preview-job-check" });
  expect(out).toContain('"matterId": "preview-job-check"');
  expect(out).toContain("Work item: preview-job-check");
}, 180_000);

test("preview with nothing set shows no matterId key at all", () => {
  expect(runCli(["preview", FIXTURE])).not.toContain("matterId");
}, 180_000);

// A capture with nothing billable in it previews as an empty record list. Naming a
// work item under that would read as "this went to the job" when nothing went
// anywhere.
test("preview of a capture with no records does not name a work item", () => {
  const out = runCli(["preview", EMPTY_FIXTURE], {
    workIdVar: "empty-capture-job",
  });
  expect(out).toContain('"records": []');
  expect(out).not.toContain("Work item: empty-capture-job");
}, 180_000);
