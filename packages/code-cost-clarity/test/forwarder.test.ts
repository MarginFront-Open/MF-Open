// forwarder.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES: proves the translator turns Claude Code telemetry into
// the right MarginFront record - especially the cache-token mapping (cache tokens
// land in the TYPED, server-priced fields by default, never buried in metadata).
// ---------------------------------------------------------------------------

import { test, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// createRequire lets us require() a JSON file from ESM test code -
// the same mechanism forwarder.ts uses to read its own package version.
import { createRequire } from "node:module";
import {
  buildMarginFrontRequestBody,
  buildCodexRequestBody,
  buildRequestBodyForLine,
  buildToolUsageRecords,
  splitIntoPostBatches,
  watchAndForward,
  resolveDeveloperOverride,
  normalizeModelId,
  NO_IDENTITY_CUSTOMER,
  CODEX_NO_IDENTITY_CUSTOMER,
  readNewCompleteLines,
  readWatchCursor,
  writeWatchCursor,
  isRetryablePostResult,
  readQueue,
  appendToQueue,
  writeQueue,
  postToMarginFront,
} from "../src/forwarder";
import type {
  OtlpAttribute,
  OtlpDataPoint,
  OtlpLogAttribute,
  OtlpLogRecord,
  ParsedOtlp,
  PostResult,
  UsageRecord,
  UsageRecordMetadata,
  CodexUsageRecordMetadata,
} from "../src/types";

// Narrow a record's metadata to the Claude Code shape for assertions. A record's
// metadata can be Claude's OR Codex's (a union), so a test that reads
// Claude-only fields (claudeCodeCostUsd, etc.) narrows here first.
function claudeMeta(rec: UsageRecord): UsageRecordMetadata {
  if ("source" in rec.metadata) {
    throw new Error("expected Claude Code metadata, got Codex");
  }
  return rec.metadata;
}

// Narrow a record's metadata to the Codex shape. The union also includes
// the tool-call metadata (which ALSO carries a `source` field), a presence check
// isn't enough - narrow on the discriminant VALUE (source === "codex").
function codexMeta(rec: UsageRecord): CodexUsageRecordMetadata {
  const md = rec.metadata;
  if (!("source" in md) || md.source !== "codex") {
    throw new Error("expected Codex metadata");
  }
  return md;
}

// --- small fixture builders -------------------------------------------------

// One OTLP attribute, in the awkward { key, value: { stringValue } } shape.
function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

// A token datapoint for a (email, model, session, type) with a count. `encoding`
// picks asInt (string, console exporter) or asDouble (number, file exporter).
function tokenPoint({
  email,
  model,
  session,
  type,
  count,
  encoding = "asInt",
}: {
  email: string | null;
  model: string;
  session: string;
  type: string;
  count: number;
  encoding?: "asInt" | "asDouble";
}): OtlpDataPoint {
  const attributes = [];
  if (email !== null) attributes.push(attr("user.email", email));
  attributes.push(attr("model", model));
  attributes.push(attr("session.id", session));
  attributes.push(attr("type", type));
  const dp: {
    attributes: typeof attributes;
    asInt?: string;
    asDouble?: number;
  } = { attributes };
  if (encoding === "asInt") dp.asInt = String(count);
  else dp.asDouble = count;
  return dp;
}

// A cost datapoint (email, model, session) -> USD as asDouble.
function costPoint({
  email,
  model,
  session,
  usd,
}: {
  email: string | null;
  model: string;
  session: string;
  usd: number;
}): OtlpDataPoint {
  const attributes = [];
  if (email !== null) attributes.push(attr("user.email", email));
  attributes.push(attr("model", model));
  attributes.push(attr("session.id", session));
  return { attributes, asDouble: usd };
}

// Wrap token + cost datapoints in the resourceMetrics tree the forwarder reads.
function otlp({
  tokenPoints = [],
  costPoints = [],
}: {
  tokenPoints?: OtlpDataPoint[];
  costPoints?: OtlpDataPoint[];
}): ParsedOtlp {
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: { dataPoints: tokenPoints },
              },
              {
                name: "claude_code.cost.usage",
                sum: { dataPoints: costPoints },
              },
            ],
          },
        ],
      },
    ],
  };
}

const BASE = {
  email: "developer@example.com",
  model: "claude-opus-4-8[1m]",
  session: "session-1",
};

function fullTurn(encoding: "asInt" | "asDouble" = "asDouble"): ParsedOtlp {
  return otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 100, encoding }),
      tokenPoint({ ...BASE, type: "output", count: 50, encoding }),
      tokenPoint({ ...BASE, type: "cacheRead", count: 1000, encoding }),
      tokenPoint({ ...BASE, type: "cacheCreation", count: 200, encoding }),
    ],
    costPoints: [costPoint({ ...BASE, usd: 0.3034 })],
  });
}

// --- normalizeModelId -------------------------------------------------------

test("normalizeModelId strips a [..] context suffix and dots the version", () => {
  expect(normalizeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4.8");
  expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
  expect(normalizeModelId("claude-haiku-4-5[200k]")).toBe("claude-haiku-4.5");
});

test("normalizeModelId leaves an already-normalized id and non-strings alone", () => {
  expect(normalizeModelId("claude-opus-4.8")).toBe("claude-opus-4.8");
  expect(normalizeModelId(undefined)).toBe(undefined);
  expect(normalizeModelId(42)).toBe(42);
});

// --- default path: typed cache fields --------------------

test("DEFAULT sends cache tokens in the typed DTO fields, not folded into input", () => {
  const { records } = buildMarginFrontRequestBody(fullTurn());
  expect(records.length).toBe(1);
  const rec = records[0];

  // Fresh input stays fresh - cache is NOT folded into it.
  expect(rec.inputTokens).toBe(100);
  expect(rec.outputTokens).toBe(50);

  // The whole point: cache lands in the TYPED, server-priced fields.
  expect(rec.cacheReadTokens).toBe(1000);
  // Load-bearing name map: Claude Code "cacheCreation" -> DTO cacheWriteTokens.
  expect(rec.cacheWriteTokens).toBe(200);

  // Raw cache numbers + the choice flag are still audit-recorded in metadata.
  const md = claudeMeta(rec);
  expect(md.cacheReadTokens).toBe(1000);
  expect(md.cacheCreationTokens).toBe(200);
  expect(md.cacheFoldedIntoInput).toBe(false);
  expect(md.claudeCodeCostUsd).toBe(0.3034);
});

test("DEFAULT record carries the fixed envelope + Claude Code identity fields", () => {
  const { records } = buildMarginFrontRequestBody(fullTurn());
  const rec = records[0];
  expect(rec.customerExternalId).toBe(BASE.email);
  expect(rec.agentCode).toBe("claude-code");
  expect(rec.signalName).toBe("claude-code-turn");
  expect(rec.modelProvider).toBe("anthropic");
  expect(rec.environment).toBe("development");
  // Model is normalized for the pricing table.
  expect(rec.model).toBe("claude-opus-4.8");
  expect(claudeMeta(rec).rawModel).toBe("claude-opus-4-8[1m]");
});

// --- Spend Control armed-status stamp ----------------------------

test("controlArmed option stamps the armed status into Claude turn metadata", () => {
  const { records } = buildMarginFrontRequestBody(fullTurn(), {
    controlArmed: {
      controlArmed: true,
      controlPolicyAsOf: "2026-07-21T12:00:00.000Z",
    },
  });
  const md = claudeMeta(records[0]) as unknown as {
    controlArmed?: boolean;
    controlPolicyAsOf?: string | null;
  };
  expect(md.controlArmed).toBe(true);
  expect(md.controlPolicyAsOf).toBe("2026-07-21T12:00:00.000Z");
});

test("without the controlArmed option the stamp is absent", () => {
  const { records } = buildMarginFrontRequestBody(fullTurn());
  expect("controlArmed" in records[0].metadata).toBe(false);
  expect("controlPolicyAsOf" in records[0].metadata).toBe(false);
});

// --- per-tool split: Claude records carry no Codex keys --------

test("a Claude turn record carries NO Codex stamp keys, armed or not", () => {
  // Claude arming is a file that either exists or doesn't, so the Claude answer
  // is never "we don't know" and has no ambiguity to discriminate. Adding a
  // version key here would break the byte-identical-when-unarmed contract above
  // for zero benefit, so every key lands on Codex records only.
  for (const options of [
    {},
    {
      controlArmed: {
        controlArmed: true as const,
        controlPolicyAsOf: "2026-07-21T12:00:00.000Z",
      },
    },
    {
      codexControlStamp: {
        controlStampVersion: 2,
        codexControlState: "armed",
        codexControlArmed: true,
      },
    },
  ]) {
    const md = buildMarginFrontRequestBody(fullTurn(), options).records[0]
      .metadata;
    expect("controlStampVersion" in md).toBe(false);
    expect("codexControlState" in md).toBe(false);
    expect("codexControlArmed" in md).toBe(false);
  }
});

// --- fold-cache path: round-up, no double count -----------------------------

test("--fold-cache rolls cache into input and OMITS the typed fields (no double count)", () => {
  const { records } = buildMarginFrontRequestBody(fullTurn(), {
    foldCache: true,
  });
  const rec = records[0];

  // input = fresh(100) + cacheRead(1000) + cacheCreation(200) = 1300.
  expect(rec.inputTokens).toBe(1300);
  expect(rec.outputTokens).toBe(50);

  // Typed cache fields must be ABSENT when folding, or the server double-counts.
  expect("cacheReadTokens" in rec).toBe(false);
  expect("cacheWriteTokens" in rec).toBe(false);

  // Metadata still records the raw numbers and that we folded.
  const md = claudeMeta(rec);
  expect(md.cacheReadTokens).toBe(1000);
  expect(md.cacheCreationTokens).toBe(200);
  expect(md.cacheFoldedIntoInput).toBe(true);
});

// --- value encodings --------------------------------------------------------

test("reads asInt (string) and asDouble (number) datapoints identically", () => {
  const a = buildMarginFrontRequestBody(fullTurn("asInt")).records[0];
  const b = buildMarginFrontRequestBody(fullTurn("asDouble")).records[0];
  expect({
    i: a.inputTokens,
    o: a.outputTokens,
    r: a.cacheReadTokens,
    w: a.cacheWriteTokens,
  }).toEqual({
    i: b.inputTokens,
    o: b.outputTokens,
    r: b.cacheReadTokens,
    w: b.cacheWriteTokens,
  });
});

// --- empty-tick guard -------------------------------------------------------

test("skips an empty tick (no input AND no output) instead of POSTing 0/0", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 0 }),
      tokenPoint({ ...BASE, type: "output", count: 0 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body);
  expect(records.length).toBe(0);
});

test("a turn with output but zero fresh input is still recorded", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 0 }),
      tokenPoint({ ...BASE, type: "output", count: 30 }),
      tokenPoint({ ...BASE, type: "cacheRead", count: 5000 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body);
  expect(records.length).toBe(1);
  expect(records[0].inputTokens).toBe(0);
  expect(records[0].outputTokens).toBe(30);
  expect(records[0].cacheReadTokens).toBe(5000);
});

// A cache-only tick (cache tokens but no fresh input/output) must NOT be dropped
// in the accurate DEFAULT mode - cache is cost-bearing, and dropping it would
// under-count, which is the exact thing this package exists to fix. Fold-cache
// mode keeps such a tick too.
test("DEFAULT records a cache-only tick instead of treating it as empty", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "cacheRead", count: 4000 }),
      tokenPoint({ ...BASE, type: "cacheCreation", count: 100 }),
      // no input, no output - only cache.
    ],
    costPoints: [costPoint({ ...BASE, usd: 0.012 })],
  });
  const { records } = buildMarginFrontRequestBody(body);
  expect(records.length).toBe(1);
  expect(records[0].inputTokens).toBe(0);
  expect(records[0].outputTokens).toBe(0);
  expect(records[0].cacheReadTokens).toBe(4000);
  expect(records[0].cacheWriteTokens).toBe(100);
});

test("a tick with zero of EVERYTHING (no input, output, OR cache) is still skipped", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 0 }),
      tokenPoint({ ...BASE, type: "output", count: 0 }),
      tokenPoint({ ...BASE, type: "cacheRead", count: 0 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body);
  expect(records.length).toBe(0);
});

// --- no-identity fallback ---------------------------------------------------

test("with no user.email, falls back to the placeholder customer when given one", () => {
  const noEmail = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, email: null, type: "input", count: 10 }),
      tokenPoint({ ...BASE, email: null, type: "output", count: 5 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(noEmail, {
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(NO_IDENTITY_CUSTOMER);
});

test("with no user.email AND no fallback, the datapoint is skipped (no phantom record)", () => {
  const noEmail = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, email: null, type: "input", count: 10 }),
      tokenPoint({ ...BASE, email: null, type: "output", count: 5 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(noEmail);
  expect(records.length).toBe(0);
});

// --- multi-group ------------------------------------------------------------

test("splits two developers into two separate records", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 100 }),
      tokenPoint({ ...BASE, type: "output", count: 10 }),
      tokenPoint({
        email: "second@example.com",
        model: BASE.model,
        session: "s2",
        type: "input",
        count: 7,
      }),
      tokenPoint({
        email: "second@example.com",
        model: BASE.model,
        session: "s2",
        type: "output",
        count: 3,
      }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body);
  expect(records.length).toBe(2);
  const ids = records.map((r) => r.customerExternalId).sort();
  expect(ids).toEqual(["developer@example.com", "second@example.com"]);
});

test("envelope is always { records: [...] }", () => {
  const body = buildMarginFrontRequestBody(fullTurn());
  expect(Array.isArray(body.records)).toBeTruthy();
  expect(Object.keys(body)).toEqual(["records"]);
});

// --- watcher resume cursor (no re-send) --------
// These prove the live watcher resumes where it stopped instead of re-reading
// (and re-billing) the whole append-only file on every `run`.

function tmpJsonl(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-watch-"));
  return { dir, path: join(dir, "live-otlp.jsonl") };
}

test("readNewCompleteLines resumes from the cursor - a restart yields ONLY new lines", () => {
  const { dir, path } = tmpJsonl();
  try {
    const firstBatch = ['{"n":1}', '{"n":2}', '{"n":3}'];
    writeFileSync(path, firstBatch.map((l) => l + "\n").join(""));

    // First pass from the top sees all three lines.
    const first = readNewCompleteLines(path, 0);
    expect(first.lines).toEqual(firstBatch);

    // The collector appends two more lines (a second session).
    const secondBatch = ['{"n":4}', '{"n":5}'];
    appendFileSync(path, secondBatch.map((l) => l + "\n").join(""));

    // Resuming from the persisted cursor yields ONLY the new lines - not all 5.
    const second = readNewCompleteLines(path, first.nextCursor);
    expect(second.lines).toEqual(secondBatch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNewCompleteLines leaves a trailing partial line until it's completed", () => {
  const { dir, path } = tmpJsonl();
  try {
    // One complete line + a partial line the collector is still writing.
    writeFileSync(path, '{"n":1}\n{"n":2', "utf8");
    const first = readNewCompleteLines(path, 0);
    expect(first.lines).toEqual(['{"n":1}']); // partial NOT consumed
    expect(first.nextCursor).toBe('{"n":1}\n'.length);

    // The collector finishes that line.
    appendFileSync(path, "}\n");
    const second = readNewCompleteLines(path, first.nextCursor);
    expect(second.lines).toEqual(['{"n":2}']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNewCompleteLines yields nothing and holds the cursor when there are no new bytes", () => {
  const { dir, path } = tmpJsonl();
  try {
    writeFileSync(path, '{"n":1}\n');
    const first = readNewCompleteLines(path, 0);
    const again = readNewCompleteLines(path, first.nextCursor);
    expect(again.lines).toEqual([]);
    expect(again.nextCursor).toBe(first.nextCursor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNewCompleteLines re-reads from the top if the file shrank (uninstall + fresh init)", () => {
  const { dir, path } = tmpJsonl();
  try {
    writeFileSync(path, '{"old":1}\n{"old":2}\n');
    const advanced = readNewCompleteLines(path, 0).nextCursor;
    // A fresh, smaller file replaces it - the old cursor now points past EOF.
    writeFileSync(path, '{"new":1}\n');
    const after = readNewCompleteLines(path, advanced);
    expect(after.lines).toEqual(['{"new":1}']);
    expect(after.nextCursor).toBe('{"new":1}\n'.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWatchCursor round-trips a saved offset and defaults to 0 when absent/garbage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-cursor-"));
  const path = join(dir, "forwarder.cursor");
  try {
    expect(readWatchCursor(path)).toBe(0); // no file yet
    writeWatchCursor(path, 1234);
    expect(readWatchCursor(path)).toBe(1234); // round-trips
    writeFileSync(path, "not-a-number");
    expect(readWatchCursor(path)).toBe(0); // garbage -> safe 0
    expect(readWatchCursor(undefined)).toBe(0); // no path -> 0
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// CODEX - the OTel LOG source + the accurate nested-token mapping.
// These prove the load-bearing rule: reasoning is NOT folded into output
// (it's already there) and cached is subtracted from input (it's already there),
// so nothing is double-counted. Fixtures mirror the real codex.sse_event shape.
// ===========================================================================

// A string log attribute, in the { key, value: { stringValue } } shape.
function logStrAttr(key: string, value: string): OtlpLogAttribute {
  return { key, value: { stringValue: value } };
}

// A numeric log attribute. `encoding` picks intValue (a JSON string, the int64
// rule) or doubleValue (a JSON number) - both real on the wire.
function logNumAttr(
  key: string,
  value: number,
  encoding: "intValue" | "doubleValue" = "intValue",
): OtlpLogAttribute {
  return encoding === "intValue"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
}

// Build one codex.sse_event log record. Pass null to OMIT an identity field, and
// undefined to OMIT a token field. eventNamePlacement controls where (if at all)
// the "codex.sse_event" name appears, so we can test detection fallbacks.
function codexRecord({
  email = "eng@example.com",
  model = "gpt-5-codex",
  session = "conv-1",
  sessionKey = "conversation.id",
  input,
  output,
  cached,
  reasoning,
  tool,
  encoding = "intValue",
  eventNamePlacement = "attribute",
}: {
  email?: string | null;
  model?: string | null;
  session?: string | null;
  sessionKey?: string;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  tool?: number;
  encoding?: "intValue" | "doubleValue";
  eventNamePlacement?: "attribute" | "body" | "none";
}): OtlpLogRecord {
  const attributes: OtlpLogAttribute[] = [];
  if (eventNamePlacement === "attribute") {
    attributes.push(logStrAttr("event.name", "codex.sse_event"));
  }
  if (email !== null) attributes.push(logStrAttr("user.email", email));
  if (model !== null) attributes.push(logStrAttr("model", model));
  if (session !== null) attributes.push(logStrAttr(sessionKey, session));
  if (input !== undefined)
    attributes.push(logNumAttr("input_token_count", input, encoding));
  if (output !== undefined)
    attributes.push(logNumAttr("output_token_count", output, encoding));
  if (cached !== undefined)
    attributes.push(logNumAttr("cached_token_count", cached, encoding));
  if (reasoning !== undefined)
    attributes.push(logNumAttr("reasoning_token_count", reasoning, encoding));
  if (tool !== undefined)
    attributes.push(logNumAttr("tool_token_count", tool, encoding));

  const record: OtlpLogRecord = { attributes };
  if (eventNamePlacement === "body")
    record.body = { stringValue: "codex.sse_event" };
  return record;
}

// Wrap log records in the resourceLogs tree the Codex forwarder reads.
function codexOtlp(records: OtlpLogRecord[]): ParsedOtlp {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] };
}

// A full, realistic turn: 1000 input (800 of it cached), 500 output (300 of it
// reasoning), 20 tool. The accurate billed split is input=200, cacheRead=800,
// output=500 - and 200 + 800 == 1000, the original input (no double count).
function codexFullTurn(
  encoding: "intValue" | "doubleValue" = "intValue",
): ParsedOtlp {
  return codexOtlp([
    codexRecord({
      input: 1000,
      cached: 800,
      output: 500,
      reasoning: 300,
      tool: 20,
      encoding,
    }),
  ]);
}

// --- the accurate nested mapping --------------

test("CODEX subtracts cached from input and does NOT fold reasoning into output", () => {
  const { records } = buildCodexRequestBody(codexFullTurn());
  expect(records.length).toBe(1);
  const rec = records[0];

  // Fresh input = 1000 input - 800 cached. Cached rides in the typed field.
  expect(rec.inputTokens).toBe(200);
  expect(rec.cacheReadTokens).toBe(800);
  // OpenAI has no cache-CREATION tokens - the write field is never set.
  expect("cacheWriteTokens" in rec).toBe(false);

  // Output is the raw output count; reasoning (300) is ALREADY inside it and is
  // NOT added again. Folding reasoning into output would give 800.
  expect(rec.outputTokens).toBe(500);
  expect(rec.outputTokens).not.toBe(500 + 300);

  // Billed input + cache-read reconstitutes the original input exactly - proof
  // we billed each token once, not twice.
  expect((rec.inputTokens ?? 0) + (rec.cacheReadTokens ?? 0)).toBe(1000);
});

test("CODEX records the raw nested counts in metadata for audit (never billed)", () => {
  const rec = buildCodexRequestBody(codexFullTurn()).records[0];
  const md = codexMeta(rec);
  expect(md.source).toBe("codex");
  expect(md.cachedTokens).toBe(800);
  expect(md.reasoningTokens).toBe(300);
  expect(md.toolTokens).toBe(20);
  expect(md.cacheFoldedIntoInput).toBe(false);
  expect(md.rawModel).toBe("gpt-5-codex");
  expect(md.sessionId).toBe("conv-1");
});

test("CODEX record carries the codex identity fields + normalized model", () => {
  const rec = buildCodexRequestBody(codexFullTurn()).records[0];
  expect(rec.customerExternalId).toBe("eng@example.com");
  expect(rec.agentCode).toBe("codex");
  expect(rec.signalName).toBe("codex-turn");
  expect(rec.modelProvider).toBe("openai");
  expect(rec.environment).toBe("development");
  // gpt-5-codex passes the (claude-scoped) normalizer through unchanged.
  expect(rec.model).toBe("gpt-5-codex");
});

// --- fold-cache: conservative ceiling for an unpriced cache rate -------------

test("CODEX --fold-cache bills the full input (no cache discount) and omits cacheReadTokens", () => {
  const { records } = buildCodexRequestBody(codexFullTurn(), {
    foldCache: true,
  });
  const rec = records[0];
  // Whole input_token_count billed at the input rate (cached already inside it).
  expect(rec.inputTokens).toBe(1000);
  expect(rec.outputTokens).toBe(500);
  // Typed cache field omitted so the server can't double-count.
  expect("cacheReadTokens" in rec).toBe(false);
  const md = codexMeta(rec);
  expect(md.cacheFoldedIntoInput).toBe(true);
});

// --- exclusions + edge mapping ----------------------------------------------

test("CODEX drops the codex-auto-review pseudo-model (case-insensitive)", () => {
  const body = codexOtlp([
    codexRecord({ model: "codex-auto-review", input: 100, output: 50 }),
    codexRecord({ model: "CODEX-AUTO-REVIEW", input: 100, output: 50 }),
    codexRecord({ model: "gpt-5-codex", input: 100, output: 50, cached: 0 }),
  ]);
  const { records } = buildCodexRequestBody(body);
  expect(records.length).toBe(1);
  expect(records[0].model).toBe("gpt-5-codex");
});

// A cache-read count above the input count would bill more cached tokens than the
// turn had tokens at all. Conservation caps the slice at the whole it was carved
// from - see codex-token-conservation.test.ts.
test("CODEX caps cached at input when a malformed event reports cached > input", () => {
  const body = codexOtlp([
    codexRecord({ input: 100, cached: 150, output: 10 }),
  ]);
  const rec = buildCodexRequestBody(body).records[0];
  expect(rec.inputTokens).toBe(0); // never negative
  expect(rec.cacheReadTokens).toBe(100);
  expect(rec.inputTokens! + rec.cacheReadTokens!).toBe(100);
});

test("CODEX reads intValue and doubleValue token encodings identically", () => {
  const a = buildCodexRequestBody(codexFullTurn("intValue")).records[0];
  const b = buildCodexRequestBody(codexFullTurn("doubleValue")).records[0];
  expect({ i: a.inputTokens, o: a.outputTokens, r: a.cacheReadTokens }).toEqual(
    {
      i: b.inputTokens,
      o: b.outputTokens,
      r: b.cacheReadTokens,
    },
  );
});

// --- empty-tick + identity guards -------------------------------------------

test("CODEX skips an event with no cost-bearing tokens", () => {
  const body = codexOtlp([codexRecord({ input: 0, output: 0, cached: 0 })]);
  expect(buildCodexRequestBody(body).records.length).toBe(0);
});

test("CODEX skips an intermediate sse_event that carries no token fields at all", () => {
  // event.name present, model present, but NO token attributes (a streaming
  // delta, not the completed turn) -> nothing to bill, dropped.
  const body = codexOtlp([codexRecord({})]);
  expect(buildCodexRequestBody(body).records.length).toBe(0);
});

test("CODEX falls back to the codex-specific placeholder when user.email is absent", () => {
  const body = codexOtlp([
    codexRecord({ email: null, input: 100, output: 50 }),
  ]);
  // Explicit Codex fallback is honored.
  const withFallback = buildCodexRequestBody(body, {
    fallbackCustomerId: CODEX_NO_IDENTITY_CUSTOMER,
  });
  expect(withFallback.records[0].customerExternalId).toBe(
    CODEX_NO_IDENTITY_CUSTOMER,
  );

  // No explicit fallback -> Codex builder's own default (CODEX_NO_IDENTITY_CUSTOMER).
  const withDefault = buildCodexRequestBody(body);
  expect(withDefault.records[0].customerExternalId).toBe(
    CODEX_NO_IDENTITY_CUSTOMER,
  );

  // No email AND no fallback -> does NOT skip; lands under the Codex placeholder.
  expect(buildCodexRequestBody(body).records.length).toBe(1);
});

test("CODEX skips a record with no model (can't price it)", () => {
  const body = codexOtlp([
    codexRecord({ model: null, input: 100, output: 50 }),
  ]);
  expect(buildCodexRequestBody(body).records.length).toBe(0);
});

// --- event-name detection fallbacks -----------------------------------------

test("CODEX detects the usage event whether the name is on an attr, the body, or absent", () => {
  for (const eventNamePlacement of ["attribute", "body", "none"] as const) {
    const body = codexOtlp([
      codexRecord({ input: 100, output: 50, eventNamePlacement }),
    ]);
    const { records } = buildCodexRequestBody(body);
    expect(records.length).toBe(1); // token fields alone are enough to detect it
  }
});

test("CODEX reads the session id from conversation.id and leaves it null when absent", () => {
  const withSession = buildCodexRequestBody(
    codexOtlp([codexRecord({ input: 100, output: 50 })]),
  ).records[0];
  const md1 = withSession.metadata;
  if (!("source" in md1) || md1.source !== "codex")
    throw new Error("expected Codex metadata");
  expect(md1.sessionId).toBe("conv-1");

  const noSession = buildCodexRequestBody(
    codexOtlp([codexRecord({ input: 100, output: 50, session: null })]),
  ).records[0];
  const md2 = noSession.metadata;
  if (!("source" in md2) || md2.source !== "codex")
    throw new Error("expected Codex metadata");
  expect(md2.sessionId).toBe(null);
});

test("CODEX emits one record per usage event in a multi-record document", () => {
  const body = codexOtlp([
    codexRecord({
      email: "a@example.com",
      session: "c1",
      input: 100,
      output: 50,
    }),
    codexRecord({ email: "b@example.com", session: "c2", input: 7, output: 3 }),
  ]);
  const { records } = buildCodexRequestBody(body);
  expect(records.length).toBe(2);
  expect(records.map((r) => r.customerExternalId).sort()).toEqual([
    "a@example.com",
    "b@example.com",
  ]);
});

// --- the shape-detecting dispatcher -----------------------------------------

test("buildRequestBodyForLine routes a logs line to Codex and a metrics line to Claude", () => {
  const codex = buildRequestBodyForLine(codexFullTurn());
  expect(codex.records[0].agentCode).toBe("codex");

  const claude = buildRequestBodyForLine(fullTurn());
  expect(claude.records[0].agentCode).toBe("claude-code");
});

// ===========================================================================
// IDEMPOTENCY KEY STAMPING - the "no doubles on replay"
// signal the watcher stamps and the server dedups against. The two properties
// that matter: a re-read of the SAME line reproduces the SAME key (replay is a
// no-op), and genuinely DIFFERENT turns get DIFFERENT keys (no false dedup).
// ===========================================================================

const HEX64 = /^[0-9a-f]{64}$/;

test("stamps a sha256 idempotency key only when the raw source line is supplied", () => {
  // No rawSourceLine (preview/dry-run path) -> no key is stamped.
  const withoutLine = buildMarginFrontRequestBody(fullTurn());
  expect(withoutLine.records[0].idempotencyKey).toBeUndefined();

  // With the line (the watcher path) -> a stable 64-char hex key.
  const withLine = buildMarginFrontRequestBody(fullTurn(), {
    rawSourceLine: '{"the":"raw line"}',
  });
  expect(withLine.records[0].idempotencyKey).toMatch(HEX64);
});

test("the SAME line yields the SAME key (a restart/replay is a no-op)", () => {
  const line = '{"some":"otlp line","n":1}';
  const a = buildMarginFrontRequestBody(fullTurn(), { rawSourceLine: line });
  const b = buildMarginFrontRequestBody(fullTurn(), { rawSourceLine: line });
  expect(a.records[0].idempotencyKey).toBe(b.records[0].idempotencyKey);
});

test("a DIFFERENT line yields a DIFFERENT key (distinct turns are not collapsed)", () => {
  const a = buildMarginFrontRequestBody(fullTurn(), {
    rawSourceLine: '{"n":1}',
  });
  const b = buildMarginFrontRequestBody(fullTurn(), {
    rawSourceLine: '{"n":2}',
  });
  expect(a.records[0].idempotencyKey).not.toBe(b.records[0].idempotencyKey);
});

test("two groups from the SAME line get DISTINCT keys (index disambiguation)", () => {
  // Two developers in one export -> two records on one line. Without the
  // within-line index they could collide; with it they must differ.
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, type: "input", count: 100 }),
      tokenPoint({ ...BASE, type: "output", count: 10 }),
      tokenPoint({
        email: "second@example.com",
        model: BASE.model,
        session: "s2",
        type: "input",
        count: 7,
      }),
      tokenPoint({
        email: "second@example.com",
        model: BASE.model,
        session: "s2",
        type: "output",
        count: 3,
      }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body, {
    rawSourceLine: '{"two":"groups"}',
  });
  expect(records.length).toBe(2);
  expect(records[0].idempotencyKey).toMatch(HEX64);
  expect(records[1].idempotencyKey).toMatch(HEX64);
  expect(records[0].idempotencyKey).not.toBe(records[1].idempotencyKey);
});

test("CODEX stamps keys too, and two same-session turns in one line stay distinct", () => {
  // Two completed turns for the SAME (email, model, session) flushed on one
  // line. Codex emits one record per log record (no merge), so the within-line
  // index is what keeps them from false-deduping.
  const body = codexOtlp([
    codexRecord({
      email: "e@x.example",
      session: "c1",
      input: 100,
      output: 50,
    }),
    codexRecord({
      email: "e@x.example",
      session: "c1",
      input: 200,
      output: 80,
    }),
  ]);
  const { records } = buildCodexRequestBody(body, {
    rawSourceLine: '{"codex":"two turns"}',
  });
  expect(records.length).toBe(2);
  expect(records[0].idempotencyKey).toMatch(HEX64);
  expect(records[1].idempotencyKey).not.toBe(records[0].idempotencyKey);
});

// ===========================================================================
// RETRYABLE CLASSIFICATION - what gets queued for retry vs
// dropped as terminal. Transient = network / 429 / 5xx; terminal = other 4xx,
// no-key. A successful result is never "retryable."
// ===========================================================================

test("isRetryablePostResult: a 404 queues, because it means a wrong server address and not a bad record", () => {
  const notFound: PostResult = {
    ok: false,
    reason: "http",
    status: 404,
    body: "Cannot POST /sdk/usage/record",
  };
  expect(isRetryablePostResult(notFound)).toBe(true);
});

test("isRetryablePostResult: network + 429 + 5xx are retryable; other 4xx + no-key + ok are not", () => {
  const network: PostResult = {
    ok: false,
    reason: "network",
    message: "ECONNREFUSED",
  };
  const rate: PostResult = {
    ok: false,
    reason: "http",
    status: 429,
    body: "slow down",
  };
  const server: PostResult = {
    ok: false,
    reason: "http",
    status: 503,
    body: "down",
  };
  const server500: PostResult = {
    ok: false,
    reason: "http",
    status: 500,
    body: "oops",
  };
  const badRequest: PostResult = {
    ok: false,
    reason: "http",
    status: 400,
    body: "bad",
  };
  const unprocessable: PostResult = {
    ok: false,
    reason: "http",
    status: 422,
    body: "nope",
  };
  const noKey: PostResult = { ok: false, reason: "no-key" };
  const ok: PostResult = { ok: true, parsed: null, body: "{}" };

  expect(isRetryablePostResult(network)).toBe(true);
  expect(isRetryablePostResult(rate)).toBe(true);
  expect(isRetryablePostResult(server)).toBe(true);
  expect(isRetryablePostResult(server500)).toBe(true);
  expect(isRetryablePostResult(badRequest)).toBe(false);
  expect(isRetryablePostResult(unprocessable)).toBe(false);
  expect(isRetryablePostResult(noKey)).toBe(false);
  expect(isRetryablePostResult(ok)).toBe(false);
});

// ===========================================================================
// DURABLE QUEUE HELPERS - the on-disk outbox that survives
// a crash. append + read round-trips, write overwrites, an empty write removes
// the file, and a corrupt line never wedges the drain.
// ===========================================================================

function sampleRecord(id: string): UsageRecord {
  return {
    customerExternalId: id,
    agentCode: "claude-code",
    signalName: "claude-code-turn",
    model: "claude-opus-4.8",
    modelProvider: "anthropic",
    inputTokens: 10,
    outputTokens: 5,
    environment: "development",
    metadata: {
      sessionId: "s",
      rawModel: "m",
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheFoldedIntoInput: false,
      claudeCodeCostUsd: null,
    },
    idempotencyKey: "key-" + id,
  };
}

function tmpQueue(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-queue-"));
  return { dir, path: join(dir, "forwarder.queue.jsonl") };
}

test("appendToQueue + readQueue round-trips records and preserves order", () => {
  const { dir, path } = tmpQueue();
  try {
    expect(readQueue(path)).toEqual([]); // no file yet
    appendToQueue(path, [sampleRecord("a"), sampleRecord("b")]);
    appendToQueue(path, [sampleRecord("c")]); // a second failure appends, not clobbers
    const got = readQueue(path);
    expect(got.map((r) => r.customerExternalId)).toEqual(["a", "b", "c"]);
    expect(got[0].idempotencyKey).toBe("key-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeQueue overwrites with exactly the given records, and an empty write removes the file", () => {
  const { dir, path } = tmpQueue();
  try {
    appendToQueue(path, [
      sampleRecord("a"),
      sampleRecord("b"),
      sampleRecord("c"),
    ]);
    // Simulate a partial drain: keep only the tail.
    writeQueue(path, [sampleRecord("c")]);
    expect(readQueue(path).map((r) => r.customerExternalId)).toEqual(["c"]);
    // Draining the rest empties the queue -> the file is removed (no stale file).
    writeQueue(path, []);
    expect(existsSync(path)).toBe(false);
    expect(readQueue(path)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readQueue skips a corrupt line instead of wedging the whole drain", () => {
  const { dir, path } = tmpQueue();
  try {
    // A valid record, a half-written (crash) line, then another valid record.
    writeFileSync(
      path,
      JSON.stringify(sampleRecord("a")) +
        "\n" +
        '{"half":"written' +
        "\n" +
        JSON.stringify(sampleRecord("b")) +
        "\n",
    );
    const got = readQueue(path);
    expect(got.map((r) => r.customerExternalId)).toEqual(["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queue helpers no-op safely when given no path", () => {
  expect(readQueue(undefined)).toEqual([]);
  expect(() => appendToQueue(undefined, [sampleRecord("a")])).not.toThrow();
  expect(() => writeQueue(undefined, [])).not.toThrow();
});

// ===========================================================================
// TOOL-CALL LINE ITEMS - a paid tool (Google Maps, Browserbase, a
// paid MCP server) fired by a coding agent becomes its OWN priced single-service
// event, attributed to the same developer, priced count x pricing-table rate.
// ===========================================================================

// Build one tool_result log record. `eventName` is the event.name value
// ("tool_result" for Claude, "codex.tool_result" for Codex); `toolNameKey`
// exercises the Codex fallback keys. Pass email/session = null to OMIT.
// `toolParameters`/`toolInput` add the two attributes Claude Code emits only under
// OTEL_LOG_TOOL_DETAILS=1 (server+tool identity, and the raw call arguments).
function toolResultRecord({
  eventName = "tool_result",
  toolName,
  toolNameKey = "tool_name",
  email = "developer@example.com",
  session = "session-1",
  sessionKey = "session.id",
  eventNamePlacement = "attribute",
  toolParameters,
  toolInput,
}: {
  eventName?: string;
  toolName: string;
  toolNameKey?: string;
  email?: string | null;
  session?: string | null;
  sessionKey?: string;
  eventNamePlacement?: "attribute" | "body";
  toolParameters?: string;
  toolInput?: string;
}): OtlpLogRecord {
  const attributes: OtlpLogAttribute[] = [];
  if (eventNamePlacement === "attribute")
    attributes.push(logStrAttr("event.name", eventName));
  attributes.push(logStrAttr(toolNameKey, toolName));
  if (email !== null) attributes.push(logStrAttr("user.email", email));
  if (session !== null) attributes.push(logStrAttr(sessionKey, session));
  if (toolParameters !== undefined)
    attributes.push(logStrAttr("tool_parameters", toolParameters));
  if (toolInput !== undefined)
    attributes.push(logStrAttr("tool_input", toolInput));
  const record: OtlpLogRecord = { attributes };
  if (eventNamePlacement === "body") record.body = { stringValue: eventName };
  return record;
}

test("a tool fired N times becomes one record - model=tool name, provider=tool, quantity N, no tokens", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  const rec = records[0];
  expect(rec.quantity).toBe(3);
  // The tool NAME is the service id; MarginFront's catalog prices (name, "tool").
  expect(rec.model).toBe("mcp__browserbase__navigate");
  expect(rec.modelProvider).toBe("tool");
  expect(rec.agentCode).toBe("claude-code");
  expect(rec.signalName).toBe("claude-code-tool");
  expect(rec.customerExternalId).toBe("developer@example.com");
  // A tool record carries NO token fields - it isn't an LLM turn.
  expect(rec.inputTokens).toBeUndefined();
  expect(rec.outputTokens).toBeUndefined();
  if (!("toolName" in rec.metadata)) throw new Error("expected tool metadata");
  expect(rec.metadata.source).toBe("tool");
  expect(rec.metadata.estimated).toBe(true);
  expect(rec.metadata.toolName).toBe("mcp__browserbase__navigate");
  expect(rec.metadata.telemetrySource).toBe("claude-code");
});

test("EVERY non-builtin tool is forwarded with its name (no allowlist; the catalog decides billability)", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "WebSearch" }),
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
    toolResultRecord({ toolName: "mcp__some-other__thing" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  // All three forwarded as distinct line items (model = the tool name); the server
  // prices the ones with a catalog row and lands the rest NEEDS_COST_BACKFILL.
  expect(records.length).toBe(3);
  expect(records.map((r) => r.model).sort()).toEqual(
    [
      "WebSearch",
      "mcp__browserbase__navigate",
      "mcp__some-other__thing",
    ].sort(),
  );
  expect(records.every((r) => r.modelProvider === "tool")).toBe(true);
});

// --- Claude Code MCP identity via OTEL_LOG_TOOL_DETAILS ------------
// Real capture: Claude Code names every MCP call the bare "mcp_tool";
// with OTEL_LOG_TOOL_DETAILS=1 it carries server+tool identity under tool_parameters
// and the call's arguments under tool_input. The forwarder reassembles the
// Codex-identical "mcp__server__tool" from the two NAMES and never forwards args.

test("a bare Claude mcp_tool with tool_parameters is forwarded as mcp__server__tool", () => {
  // Matches the verified real capture: tool_name="mcp_tool", tool_parameters carries
  // {mcp_server_name, mcp_tool_name}, tool_input carries the args.
  const tree = codexOtlp([
    toolResultRecord({
      toolName: "mcp_tool",
      toolParameters:
        '{"mcp_server_name":"slack-team","mcp_tool_name":"slack_list_channels"}',
      toolInput: '{"limit":1}',
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  const rec = records[0];
  expect(rec.model).toBe("mcp__slack-team__slack_list_channels");
  if (!("toolName" in rec.metadata)) throw new Error("expected tool metadata");
  expect(rec.metadata.toolName).toBe("mcp__slack-team__slack_list_channels");
  expect(rec.modelProvider).toBe("tool");
  expect(rec.agentCode).toBe("claude-code");
  expect(rec.signalName).toBe("claude-code-tool");
});

test("arguments NEVER leave the machine - tool_input and tool_parameters content is absent from the outbound body", () => {
  // Both attributes populated with recognizable, distinctive argument content the
  // forwarder must never emit.
  const body = buildToolUsageRecords(
    codexOtlp([
      toolResultRecord({
        toolName: "mcp_tool",
        toolParameters:
          '{"mcp_server_name":"slack-team","mcp_tool_name":"slack_post_message"}',
        toolInput:
          '{"channel":"C-SUPER-SECRET","text":"private-message-do-not-forward","secretArg":"ARGUMENT-CONTENT-SENTINEL"}',
      }),
    ]),
    { rawSourceLine: "raw-line" },
  );
  const serialized = JSON.stringify(body);

  // Identity (the two NAMES) survives...
  expect(serialized).toContain("mcp__slack-team__slack_post_message");
  // ...but NOT ONE byte of the arguments, nor the raw attribute names, appears
  // anywhere in the outbound record or its metadata (assert ABSENCE).
  expect(serialized).not.toContain("C-SUPER-SECRET");
  expect(serialized).not.toContain("private-message-do-not-forward");
  expect(serialized).not.toContain("ARGUMENT-CONTENT-SENTINEL");
  expect(serialized).not.toContain("tool_input");
  expect(serialized).not.toContain("tool_parameters");
  expect(serialized).not.toContain("mcp_server_name");
});

test("a bare mcp_tool with NO tool_parameters (flag off) keeps the bare bucket", () => {
  const tree = codexOtlp([toolResultRecord({ toolName: "mcp_tool" })]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].model).toBe("mcp_tool");
});

test("a malformed tool_parameters keeps the bare bucket and never throws", () => {
  const tree = codexOtlp([
    toolResultRecord({
      toolName: "mcp_tool",
      toolParameters: "{not valid json",
    }),
  ]);
  let records!: ReturnType<typeof buildToolUsageRecords>["records"];
  expect(() => {
    records = buildToolUsageRecords(tree).records;
  }).not.toThrow();
  expect(records.length).toBe(1);
  expect(records[0].model).toBe("mcp_tool");
});

test("reassembled MCP names group per (server, tool) - same name aggregates, different names split", () => {
  const tree = codexOtlp([
    toolResultRecord({
      toolName: "mcp_tool",
      toolParameters:
        '{"mcp_server_name":"browserbase","mcp_tool_name":"navigate"}',
    }),
    toolResultRecord({
      toolName: "mcp_tool",
      toolParameters:
        '{"mcp_server_name":"browserbase","mcp_tool_name":"navigate"}',
    }),
    toolResultRecord({
      toolName: "mcp_tool",
      toolParameters:
        '{"mcp_server_name":"browserbase","mcp_tool_name":"screenshot"}',
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(2);
  const navigate = records.find(
    (r) => r.model === "mcp__browserbase__navigate",
  );
  const screenshot = records.find(
    (r) => r.model === "mcp__browserbase__screenshot",
  );
  expect(navigate?.quantity).toBe(2);
  expect(screenshot?.quantity).toBe(1);
});

test("free built-ins (Read/Bash/exec_command/apply_patch) ARE forwarded, and the catalog's $0 rows price them", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "Bash" }),
    toolResultRecord({ toolName: "Read" }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "exec_command",
      email: "e@xco.example",
      session: "c",
      sessionKey: "conversation.id",
    }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "apply_patch",
      email: "e@xco.example",
      session: "c",
      sessionKey: "conversation.id",
    }),
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.map((r) => r.model).sort()).toEqual(
    [
      "Bash",
      "Read",
      "apply_patch",
      "exec_command",
      "mcp__browserbase__navigate",
    ].sort(),
  );
  // Built-ins still aggregate like any other tool: one record per (dev, session,
  // source, tool) per flush line, quantity = count - never one POST per event.
  expect(records.every((r) => r.quantity === 1)).toBe(true);
  expect(records.every((r) => r.modelProvider === "tool")).toBe(true);
});

test("repeated built-in fires in one flush collapse to ONE record with quantity=N", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "Bash" }),
    toolResultRecord({ toolName: "Bash" }),
    toolResultRecord({ toolName: "Bash" }),
    toolResultRecord({ toolName: "Read" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(2);
  const bash = records.find((r) => r.model === "Bash");
  const read = records.find((r) => r.model === "Read");
  expect(bash?.quantity).toBe(3);
  expect(read?.quantity).toBe(1);
});

test("token-only tools (WebFetch/AskUserQuestion/Skill/ScheduleWakeup/Artifact/Monitor) are forwarded alongside WebSearch", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "WebFetch" }),
    toolResultRecord({ toolName: "AskUserQuestion" }),
    toolResultRecord({ toolName: "Skill" }),
    toolResultRecord({ toolName: "ScheduleWakeup" }),
    toolResultRecord({ toolName: "Artifact" }),
    toolResultRecord({ toolName: "Monitor" }),
    toolResultRecord({ toolName: "WebSearch" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  // All seven forwarded; the catalog decides billability (WebSearch has a real
  // rate, the token-only six have $0 rows).
  expect(records.length).toBe(7);
  expect(records.map((r) => r.model).sort()).toEqual(
    [
      "Artifact",
      "AskUserQuestion",
      "Monitor",
      "ScheduleWakeup",
      "Skill",
      "WebFetch",
      "WebSearch",
    ].sort(),
  );
});

test("a Codex tool (codex.tool_result, tool.name key) is forwarded as a codex-tool record, model=tool name", () => {
  const tree = codexOtlp([
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "mcp__maps__geocode",
      toolNameKey: "tool.name",
      email: "eng@example.com",
      session: "conv-9",
      sessionKey: "conversation.id",
    }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "mcp__maps__geocode",
      toolNameKey: "tool.name",
      email: "eng@example.com",
      session: "conv-9",
      sessionKey: "conversation.id",
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(2);
  expect(records[0].model).toBe("mcp__maps__geocode");
  expect(records[0].modelProvider).toBe("tool");
  expect(records[0].agentCode).toBe("codex");
  expect(records[0].signalName).toBe("codex-tool");
  if (!("toolName" in records[0].metadata))
    throw new Error("expected tool metadata");
  expect(records[0].metadata.telemetrySource).toBe("codex");
});

test("a tool_decision event is NOT counted (only an executed tool_result is)", () => {
  const tree = codexOtlp([
    toolResultRecord({
      eventName: "tool_decision",
      toolName: "mcp__browserbase__navigate",
    }),
  ]);
  expect(buildToolUsageRecords(tree).records.length).toBe(0);
});

test("dispatcher emits BOTH a token record and a tool record from one logs line, with distinct idempotency keys", () => {
  const tree = codexOtlp([
    codexRecord({
      email: "eng@example.com",
      model: "gpt-5-codex",
      session: "conv-1",
      input: 1000,
      cached: 800,
      output: 500,
    }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "mcp__maps__geocode",
      email: "eng@example.com",
      session: "conv-1",
      sessionKey: "conversation.id",
    }),
  ]);
  const raw = JSON.stringify(tree);
  const { records } = buildRequestBodyForLine(tree, { rawSourceLine: raw });
  expect(records.length).toBe(2);
  const tokenRec = records.find((r) => r.quantity === undefined);
  const toolRec = records.find((r) => r.quantity !== undefined);
  expect(tokenRec).toBeDefined();
  expect(toolRec).toBeDefined();
  expect(tokenRec!.model).toBe("gpt-5-codex");
  expect(toolRec!.model).toBe("mcp__maps__geocode");
  expect(tokenRec!.idempotencyKey).toBeDefined();
  expect(toolRec!.idempotencyKey).toBeDefined();
  expect(tokenRec!.idempotencyKey).not.toBe(toolRec!.idempotencyKey);
});

test("a Claude metrics line yields its token record and no tool record (no regression)", () => {
  const { records } = buildRequestBodyForLine(fullTurn());
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBeUndefined(); // still a token record
  expect(records[0].inputTokens).toBe(100);
  expect(records[0].signalName).toBe("claude-code-turn");
});

test("a tool_result with no user.email lands under the codex fallback customer", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "mcp__browserbase__navigate", email: null }),
  ]);
  // Explicit Codex fallback is honored.
  const { records } = buildToolUsageRecords(tree, {
    fallbackCustomerId: CODEX_NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

test("a tool_result with no email and no fallback lands under the codex placeholder", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "mcp__browserbase__navigate", email: null }),
  ]);
  // No explicit fallback -> builder's own default (CODEX_NO_IDENTITY_CUSTOMER), not skipped.
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

test("tool idempotency keys are deterministic across a re-read", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
  ]);
  const raw = JSON.stringify(tree);
  const a = buildToolUsageRecords(tree, { rawSourceLine: raw });
  const b = buildToolUsageRecords(tree, { rawSourceLine: raw });
  expect(a.records[0].idempotencyKey).toBe(b.records[0].idempotencyKey);
});

test("a Claude api_request log (unsuffixed input_tokens) is NOT read as Codex token usage - the double-count guard", () => {
  // Turning on OTEL_LOGS_EXPORTER=otlp puts Claude's api_request events on the logs
  // stream. They carry `input_tokens`/`output_tokens` (NO `_count` suffix), unlike
  // Codex's `input_token_count`. If the Codex token reader matched them, Claude
  // tokens would be counted TWICE (once via the metrics stream, once via logs).
  const apiRequest: OtlpLogRecord = {
    attributes: [
      logStrAttr("event.name", "claude_code.api_request"),
      logStrAttr("user.email", "eng@example.com"),
      logNumAttr("input_tokens", 500),
      logNumAttr("output_tokens", 200),
    ],
  };
  const { records } = buildRequestBodyForLine(codexOtlp([apiRequest]), {
    rawSourceLine: "x",
  });
  // No token record (not codex.sse_event / no *_token_count) AND no tool record
  // (api_request is not a *_result event) -> correctly ignored on the logs stream.
  expect(records.length).toBe(0);
});

test("two DIFFERENT tools in one flush become two SEPARATE records (per-tool grouping)", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "mcp__browserbase__navigate" }),
    toolResultRecord({ toolName: "WebSearch" }),
    toolResultRecord({ toolName: "WebSearch" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  // Dropping toolName from the grouping key would collapse these
  // into one record and fail here.
  expect(records.length).toBe(2);
  const bb = records.find((r) => r.model === "mcp__browserbase__navigate");
  const ws = records.find((r) => r.model === "WebSearch");
  expect(bb!.quantity).toBe(1);
  expect(ws!.quantity).toBe(2);
});

test("a tool key never collides with a token key even if a tool is NAMED like a real LLM model (structural anti-undercount guard)", () => {
  // Contrived: a tool literally named "gpt-5-codex" + a real gpt-5-codex token
  // record on the SAME line. Without the "tool:" key sentinel the two idempotency
  // keys would collide (same line/email/session/index, and the same model string)
  // and the server's exactly-once dedup would silently DROP one (an under-count).
  const tree = codexOtlp([
    codexRecord({
      email: "eng@example.com",
      model: "gpt-5-codex",
      session: "conv-1",
      input: 1000,
      output: 500,
    }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "gpt-5-codex",
      email: "eng@example.com",
      session: "conv-1",
      sessionKey: "conversation.id",
    }),
  ]);
  const raw = JSON.stringify(tree);
  const { records } = buildRequestBodyForLine(tree, { rawSourceLine: raw });
  expect(records.length).toBe(2);
  const tokenRec = records.find((r) => r.quantity === undefined);
  const toolRec = records.find((r) => r.quantity !== undefined);
  expect(tokenRec!.model).toBe("gpt-5-codex");
  expect(toolRec!.model).toBe("gpt-5-codex"); // same model string...
  // ...but the keys still differ thanks to the "tool:" sentinel in the hash.
  expect(tokenRec!.idempotencyKey).not.toBe(toolRec!.idempotencyKey);
});

// ===========================================================================
// CODEX WEB SEARCH - Codex's server-side web search shows up as a
// {"type":"web_search","id":"ws_..."} item INSIDE the model turn (the raw
// `codex exec --json` body), never as a local codex.tool_result, so the
// tool_name/tool_result path above never sees it - it needs its own extraction
// off the SAME codex.sse_event record the token reader already reads.
// ===========================================================================

// Build one Codex model-turn log record: the codex.sse_event a real turn's
// token counts ride on, also carrying the raw exec --json turn body. Pass
// `items` for a realistic nested response.output array, or `rawBody` to drive
// a malformed/non-JSON body directly.
function codexModelTurnRecord({
  email = "eng@example.com",
  session = "conv-1",
  items,
  rawBody,
}: {
  email?: string | null;
  session?: string | null;
  items?: unknown[];
  rawBody?: string;
}): OtlpLogRecord {
  const attributes: OtlpLogAttribute[] = [
    logStrAttr("event.name", "codex.sse_event"),
  ];
  if (email !== null) attributes.push(logStrAttr("user.email", email));
  if (session !== null) attributes.push(logStrAttr("conversation.id", session));
  const record: OtlpLogRecord = { attributes };
  if (rawBody !== undefined) {
    record.body = { stringValue: rawBody };
  } else if (items !== undefined) {
    record.body = {
      stringValue: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", output: items },
      }),
    };
  }
  return record;
}

test("a turn with 2 web_search items + unrelated items becomes one line item, quantity 2", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "message", id: "msg_1", content: [] },
        { type: "web_search", id: "ws_abc123", status: "completed" },
        { type: "function_call", id: "call_1", name: "shell" },
        { type: "web_search", id: "ws_def456", status: "completed" },
      ],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  const rec = records[0];
  expect(rec.quantity).toBe(2);
  // Mirrors the Claude WebSearch tool_result output shape exactly, just with a
  // synthesized service id instead of one lifted from a tool_name attribute.
  expect(rec.model).toBe("web_search");
  expect(rec.modelProvider).toBe("tool");
  expect(rec.agentCode).toBe("codex");
  expect(rec.signalName).toBe("codex-tool");
  expect(rec.customerExternalId).toBe("eng@example.com");
  expect(rec.inputTokens).toBeUndefined();
  expect(rec.outputTokens).toBeUndefined();
  if (!("toolName" in rec.metadata)) throw new Error("expected tool metadata");
  expect(rec.metadata.source).toBe("tool");
  expect(rec.metadata.toolName).toBe("web_search");
  expect(rec.metadata.telemetrySource).toBe("codex");
  expect(rec.metadata.estimated).toBe(true);
});

test("a turn with no web_search items yields no record", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "message", id: "msg_1" },
        { type: "function_call", id: "call_1" },
      ],
    }),
  ]);
  expect(buildToolUsageRecords(tree).records.length).toBe(0);
});

test("the same ws_ id repeated within one turn is deduped, not double-counted", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "web_search", id: "ws_abc123", status: "in_progress" },
        { type: "web_search", id: "ws_abc123", status: "completed" },
        { type: "web_search", id: "ws_def456", status: "completed" },
      ],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(2);
});

test("a missing log record body never crashes and yields no record", () => {
  const tree = codexOtlp([codexModelTurnRecord({})]);
  expect(() => buildToolUsageRecords(tree)).not.toThrow();
  expect(buildToolUsageRecords(tree).records.length).toBe(0);
});

test("a non-JSON body never crashes and yields no record", () => {
  const tree = codexOtlp([codexModelTurnRecord({ rawBody: "not-json{{{" })]);
  expect(() => buildToolUsageRecords(tree)).not.toThrow();
  expect(buildToolUsageRecords(tree).records.length).toBe(0);
});

test("web_search items missing a usable id, and non-object array entries, are never counted or crash", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "web_search" }, // no id at all
        { type: "web_search", id: "" }, // empty id
        null,
        42,
        "web_search", // a bare string, not an object - must not be mistaken for an item
      ],
    }),
  ]);
  expect(() => buildToolUsageRecords(tree)).not.toThrow();
  expect(buildToolUsageRecords(tree).records.length).toBe(0);
});

test("web_search counts across multiple turns in one flush aggregate into one record, alongside an unrelated codex.tool_result", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_1" }],
    }),
    codexModelTurnRecord({
      session: "conv-1",
      items: [
        { type: "web_search", id: "ws_2" },
        { type: "web_search", id: "ws_3" },
      ],
    }),
    toolResultRecord({
      eventName: "codex.tool_result",
      toolName: "mcp__maps__geocode",
      email: "eng@example.com",
      session: "conv-1",
      sessionKey: "conversation.id",
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(2);
  const webSearch = records.find((r) => r.model === "web_search");
  const mapsTool = records.find((r) => r.model === "mcp__maps__geocode");
  expect(webSearch!.quantity).toBe(3);
  expect(mapsTool!.quantity).toBe(1);
});

test("the same ws_ id spread across multiple sse_event records in one flush bills once, not once per record", () => {
  // A single server-side web search surfaces on several codex.sse_event records
  // in one turn - response.output_item.added, .done, and response.completed each
  // echo the SAME ws_ item. Counting per record would bill it 3x; deduping the id
  // across records must bill it once.
  const tree = codexOtlp([
    codexModelTurnRecord({
      session: "conv-1",
      rawBody: JSON.stringify({
        type: "response.output_item.added",
        item: { type: "web_search", id: "ws_same", status: "in_progress" },
      }),
    }),
    codexModelTurnRecord({
      session: "conv-1",
      rawBody: JSON.stringify({
        type: "response.output_item.done",
        item: { type: "web_search", id: "ws_same", status: "completed" },
      }),
    }),
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_same", status: "completed" }],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  const webSearch = records.find((r) => r.model === "web_search");
  expect(webSearch!.quantity).toBe(1);
});

test("across records, a repeated ws_ id is deduped while a genuinely distinct one still counts", () => {
  // Two SSE records echo ws_same (one real search), a third carries ws_other (a
  // second real search). Total distinct = 2.
  const tree = codexOtlp([
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_same", status: "in_progress" }],
    }),
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_same", status: "completed" }],
    }),
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_other", status: "completed" }],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(2);
});

test("a web_search turn with no user.email lands under the codex no-identity placeholder, not dropped", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      email: null,
      items: [{ type: "web_search", id: "ws_1" }],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

// The real OpenAI Responses API types the web-search item "web_search_call",
// not "web_search"; matching only the latter would bill a real $10/1K search
// $0. These pin the actual wire shape.
test("a real Responses-API web_search_call turn is billed, not dropped", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "reasoning", id: "rs_1", summary: [] },
        {
          type: "web_search_call",
          id: "ws_67c9fa0502748190b7dd390736892e10",
          status: "completed",
          action: { type: "search", query: "usage-based billing" },
        },
        { type: "message", id: "msg_1", content: [] },
      ],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  const rec = records[0];
  expect(rec.quantity).toBe(1);
  expect(rec.model).toBe("web_search");
  expect(rec.modelProvider).toBe("tool");
  expect(rec.agentCode).toBe("codex");
});

test("two distinct web_search_call items in one turn count as quantity 2", () => {
  const tree = codexOtlp([
    codexModelTurnRecord({
      items: [
        { type: "web_search_call", id: "ws_aaa", status: "completed" },
        { type: "web_search_call", id: "ws_bbb", status: "completed" },
      ],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(2);
});

test("the same ws_ id under both web_search and web_search_call is one search, not two", () => {
  // Matching both type strings is additive coverage, never a double-count: dedup
  // is by id, so a single search echoed under either spelling bills exactly once.
  const tree = codexOtlp([
    codexModelTurnRecord({
      session: "conv-1",
      rawBody: JSON.stringify({
        type: "response.output_item.added",
        item: { type: "web_search_call", id: "ws_dup", status: "in_progress" },
      }),
    }),
    codexModelTurnRecord({
      session: "conv-1",
      items: [{ type: "web_search", id: "ws_dup", status: "completed" }],
    }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(1);
});

// ===========================================================================
// AGENT-SPECIFIC NO-IDENTITY PLACEHOLDERS
// A Codex developer with no user.email must land under "codex-no-identity", not
// the Claude-branded "claude-code-no-identity".
//
// Test (a) also fails if buildCodexRequestBody's default skips no-email records.
//
// Test (b) acts as the mirror guard: if someone accidentally changed the Claude
// builder to use CODEX_NO_IDENTITY_CUSTOMER, the not.toBe assertion would catch it.
// ===========================================================================

test("(a) CODEX codex.sse_event with no user.email -> actual Codex builder -> customerExternalId === 'codex-no-identity'", () => {
  // No options at all - the builder's own default must be CODEX_NO_IDENTITY_CUSTOMER.
  const body = codexOtlp([
    codexRecord({ email: null, input: 300, output: 150, cached: 50 }),
  ]);
  const { records } = buildCodexRequestBody(body);
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(CODEX_NO_IDENTITY_CUSTOMER);
  // Prove it is the Codex string, not the Claude one.
  expect(records[0].customerExternalId).toBe("codex-no-identity");
  expect(records[0].customerExternalId).not.toBe(NO_IDENTITY_CUSTOMER);
});

test("(b) Claude token datapoint with no user.email -> actual Claude builder -> customerExternalId === 'claude-code-no-identity'", () => {
  // Claude builder with explicit NO_IDENTITY_CUSTOMER: must return the Claude-branded
  // value, never CODEX_NO_IDENTITY_CUSTOMER. This fails if the Claude builder were
  // accidentally changed to use the Codex constant.
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, email: null, type: "input", count: 50 }),
      tokenPoint({ ...BASE, email: null, type: "output", count: 20 }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(body, {
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(NO_IDENTITY_CUSTOMER);
  // Prove it is the Claude string, not the Codex one.
  expect(records[0].customerExternalId).toBe("claude-code-no-identity");
  expect(records[0].customerExternalId).not.toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

test("(c) DISPATCHER (the real runtime path): a Codex line through buildRequestBodyForLine with the CLI's NO_IDENTITY_CUSTOMER fallback -> 'codex-no-identity'", () => {
  // This is the PRODUCTION path. The CLI always passes fallbackCustomerId:
  // NO_IDENTITY_CUSTOMER, and the dispatcher must swap it to the Codex placeholder.
  // If the swap in buildRequestBodyForLine is removed, Codex spend silently
  // re-Claude-brands, and unlike the builder-default tests above, THIS test catches it.
  const body = codexOtlp([
    codexRecord({ email: null, input: 300, output: 150, cached: 50 }),
  ]);
  const { records } = buildRequestBodyForLine(body, {
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe("codex-no-identity");
  expect(records[0].customerExternalId).not.toBe(NO_IDENTITY_CUSTOMER);
});

test("(d) DISPATCHER (the real runtime path): a Claude line through buildRequestBodyForLine with NO_IDENTITY_CUSTOMER stays 'claude-code-no-identity' (the swap must NOT touch Claude)", () => {
  const body = otlp({
    tokenPoints: [
      tokenPoint({ ...BASE, email: null, type: "input", count: 50 }),
      tokenPoint({ ...BASE, email: null, type: "output", count: 20 }),
    ],
  });
  const { records } = buildRequestBodyForLine(body, {
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe("claude-code-no-identity");
  expect(records[0].customerExternalId).not.toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

test("internal built-ins ToolSearch/SlashCommand/Agent are forwarded ($0 catalog rows price them)", () => {
  // These tools have $0 catalog rows, so the right shape is forward-everything
  // and let the catalog price them $0.
  const tree = codexOtlp([
    toolResultRecord({ toolName: "ToolSearch" }),
    toolResultRecord({ toolName: "SlashCommand" }),
    toolResultRecord({ toolName: "Agent" }),
    toolResultRecord({ toolName: "WebSearch" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.map((r) => r.model).sort()).toEqual(
    ["Agent", "SlashCommand", "ToolSearch", "WebSearch"].sort(),
  );
});

test("the Task-tool family (Create/Update/List/Get/Output/Stop) is forwarded ($0 catalog rows price them)", () => {
  const tree = codexOtlp([
    toolResultRecord({ toolName: "TaskCreate" }),
    toolResultRecord({ toolName: "TaskUpdate" }),
    toolResultRecord({ toolName: "TaskList" }),
    toolResultRecord({ toolName: "TaskGet" }),
    toolResultRecord({ toolName: "TaskOutput" }),
    toolResultRecord({ toolName: "TaskStop" }),
    toolResultRecord({ toolName: "WebSearch" }),
  ]);
  const { records } = buildToolUsageRecords(tree);
  expect(records.length).toBe(7);
  expect(records.map((r) => r.model)).toContain("TaskGet");
  expect(records.map((r) => r.model)).toContain("WebSearch");
});

test("a tool_result carrying a token-count attribute is emitted ONLY as a tool record, never also as a token record (structural double-count guard)", () => {
  // Defense-in-depth: even if a codex.tool_result ever ALSO carried a *_token_count
  // attribute, the token reader must skip it (it's a *_result event) so it isn't
  // double-emitted as both a tool record AND a phantom token turn (an over-count).
  const toolResultWithTokens: OtlpLogRecord = {
    attributes: [
      logStrAttr("event.name", "codex.tool_result"),
      logStrAttr("tool_name", "mcp__browserbase__navigate"),
      logStrAttr("user.email", "eng@example.com"),
      logStrAttr("conversation.id", "conv-1"),
      logStrAttr("model", "gpt-5-codex"),
      logNumAttr("input_token_count", 1000),
      logNumAttr("output_token_count", 200),
    ],
  };
  const { records } = buildRequestBodyForLine(
    codexOtlp([toolResultWithTokens]),
    {
      rawSourceLine: "x",
    },
  );
  // Exactly one record, and it's the TOOL record - no phantom token turn.
  expect(records.length).toBe(1);
  expect(records[0].quantity).toBe(1);
  expect(records[0].model).toBe("mcp__browserbase__navigate");
  if (!("toolName" in records[0].metadata))
    throw new Error("expected tool metadata");
  expect(records[0].metadata.source).toBe("tool");
});

// ===========================================================================
// User-Agent producer/consumer coupling test.
//
// detectSource (api-nest lib/request-source.ts) returns 'ccc' ONLY when the request
// carries a User-Agent containing '@marginfront/code-cost-clarity'. This test
// proves postToMarginFront actually sends that header so the two halves can
// never silently drift apart: if someone removes the header from the forwarder
// the test goes red, if someone renames the UA string on the server side the
// test still guards the forwarder half.
// ===========================================================================

test("postToMarginFront sends User-Agent containing '@marginfront/code-cost-clarity' with a semver version", async () => {
  // Intercept the real fetch call so we never hit the network, but still
  // capture every header the forwarder sends. This is a REAL test of a REAL
  // outgoing request - we are asserting on the live headers object, not a mock
  // of our own expectation.
  let capturedHeaders: Headers | null = null;
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      // Build a Headers object from whatever the forwarder passed so we can
      // use .get() with case-insensitive lookup (the Headers API spec guarantees it).
      capturedHeaders = new Headers(
        init?.headers as Record<string, string> | undefined,
      );
      // Return a minimal valid success response so postToMarginFront doesn't error.
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-ua-check";
  try {
    const result = await postToMarginFront({ records: [] });
    expect(result.ok).toBe(true); // request completed (not a no-key early return)

    // The header must exist and must name the package.
    expect(capturedHeaders).not.toBeNull();
    const ua = capturedHeaders!.get("user-agent");
    expect(ua).toBeTruthy();
    expect(ua).toContain("@marginfront/code-cost-clarity");

    // The version portion must be semver-shaped (digits.digits[.digits]), never
    // "undefined" or "".
    expect(ua).toMatch(/@marginfront\/code-cost-clarity\/\d+\.\d+/);
  } finally {
    process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
  }
});

// ===========================================================================
// EXACT VERSION: same version source, cannot drift.
//
// The semver-shape test above would still pass if someone accidentally
// hardcoded "1.0.0" in the forwarder instead of reading package.json.
// When run from source, this test reads the SAME package.json the forwarder
// reads at startup ("../package.json" resolves to the package root from test/
// just as it does from src/) and asserts the header
// contains the EXACT version string. If a refactor ever points the forwarder
// at a different file, or hardcodes the version, this test goes red.
// ===========================================================================

test("postToMarginFront User-Agent version exactly matches the real package.json version", async () => {
  // Read the version from the same package.json the forwarder module reads.
  // createRequire(import.meta.url) makes require() work inside ESM; "../package.json"
  // resolves relative to THIS file's directory (test/), landing at
  // packages/code-cost-clarity/package.json - the identical path forwarder.ts uses
  // from src/. They both read the one source of truth, so they can never drift.
  const testRequire = createRequire(import.meta.url);
  const realVersion: string = (
    testRequire("../package.json") as { version: string }
  ).version;

  // Sanity guard: if package.json somehow has no version, the rest of the test
  // would give a misleading "expected '' to be '@marginfront/code-cost-clarity/'"
  // error. Fail clearly here instead.
  expect(typeof realVersion).toBe("string");
  expect(realVersion.length).toBeGreaterThan(0);

  // Capture the actual fetch call the forwarder makes - never hit the network.
  let capturedHeaders: Headers | null = null;
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedHeaders = new Headers(
        init?.headers as Record<string, string> | undefined,
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-exact-version";
  try {
    const result = await postToMarginFront({ records: [] });
    expect(result.ok).toBe(true);

    expect(capturedHeaders).not.toBeNull();
    const ua = capturedHeaders!.get("user-agent");

    // THE EXACT match: any discrepancy - hardcoded string, wrong file, "unknown"
    // fallback, missing slash - shows up here rather than silently slipping through.
    expect(ua).toBe(`@marginfront/code-cost-clarity/${realVersion}`);
  } finally {
    process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
  }
});

// ===========================================================================
// PER-DEVELOPER ATTRIBUTION OVERRIDE (CCC_DEVELOPER_EMAIL) for a shared login.
// ---------------------------------------------------------------------------
// WHAT THESE PROVE: when a team shares ONE coding-agent login, every turn carries
// the SAME user.email and all cost collapses onto one customer. The override (read
// at runtime from CCC_DEVELOPER_EMAIL, passed in here as developerOverride) WINS over
// that login email so each laptop's spend is attributed to the right developer.
// The critical guarantee: with the override unset/empty, output is byte-identical
// to a record built with no override. The builders are pure - they take the
// override as an option and never read process.env or git themselves.
// ===========================================================================

// A different identity from BASE.email, standing in for the per-machine developer.
const OVERRIDE_EMAIL = "real-developer@example.com";

test("override beats the login email on the Claude metrics path", () => {
  // Guard the premise: the override is genuinely different from the login email.
  expect(OVERRIDE_EMAIL).not.toBe(BASE.email);
  const { records } = buildMarginFrontRequestBody(fullTurn(), {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
});

test("override beats the login email on the Codex logs (token) path", () => {
  const { records } = buildCodexRequestBody(codexFullTurn(), {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
});

test("override beats the login email on the tool-call path", () => {
  const tree = codexOtlp([
    toolResultRecord({
      toolName: "mcp__browserbase__navigate",
      email: "shared-login@example.com",
    }),
  ]);
  const { records } = buildToolUsageRecords(tree, {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
});

test("REGRESSION: an unset/empty override falls back to the login email, byte-identical", () => {
  const baseline = buildMarginFrontRequestBody(fullTurn());
  expect(baseline.records[0].customerExternalId).toBe(BASE.email);
  // Passing the option as undefined or "" must change NOTHING about the output -
  // the rest of this suite relies on that.
  const undefinedOverride = buildMarginFrontRequestBody(fullTurn(), {
    developerOverride: undefined,
  });
  const emptyOverride = buildMarginFrontRequestBody(fullTurn(), {
    developerOverride: "",
  });
  expect(JSON.stringify(undefinedOverride)).toBe(JSON.stringify(baseline));
  expect(JSON.stringify(emptyOverride)).toBe(JSON.stringify(baseline));
});

test("REGRESSION (Codex): an unset override is byte-identical to no override", () => {
  const baseline = buildCodexRequestBody(codexFullTurn());
  const undefinedOverride = buildCodexRequestBody(codexFullTurn(), {
    developerOverride: undefined,
  });
  expect(JSON.stringify(undefinedOverride)).toBe(JSON.stringify(baseline));
});

test("override is used even when NO login email is present - Claude (not the placeholder)", () => {
  // No user.email on the datapoints at all: normally this lands on the no-identity
  // placeholder, but the override pre-empts it.
  const tree = otlp({
    tokenPoints: [
      tokenPoint({
        email: null,
        model: BASE.model,
        session: BASE.session,
        type: "input",
        count: 100,
      }),
      tokenPoint({
        email: null,
        model: BASE.model,
        session: BASE.session,
        type: "output",
        count: 50,
      }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(tree, {
    developerOverride: OVERRIDE_EMAIL,
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
  expect(records[0].customerExternalId).not.toBe(NO_IDENTITY_CUSTOMER);
});

test("override is used even when NO login email is present - Codex (not the placeholder)", () => {
  const tree = codexOtlp([
    codexRecord({ email: null, input: 100, output: 50 }),
  ]);
  const { records } = buildCodexRequestBody(tree, {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
  expect(records[0].customerExternalId).not.toBe(CODEX_NO_IDENTITY_CUSTOMER);
});

test("the cost path honors the override and still joins its token group", () => {
  // The shared-login mess in miniature: the token row and the cost row carry
  // DIFFERENT login emails. Without the override they'd be different groups and the
  // cost wouldn't attach; with it, both resolve to the same developer, so the
  // server-reconcile cost still lands on the record.
  const tree = otlp({
    tokenPoints: [
      tokenPoint({
        email: "login-a@example.com",
        model: BASE.model,
        session: BASE.session,
        type: "input",
        count: 100,
      }),
      tokenPoint({
        email: "login-a@example.com",
        model: BASE.model,
        session: BASE.session,
        type: "output",
        count: 50,
      }),
    ],
    costPoints: [
      costPoint({
        email: "login-b@example.com",
        model: BASE.model,
        session: BASE.session,
        usd: 0.42,
      }),
    ],
  });
  const { records } = buildMarginFrontRequestBody(tree, {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(records.length).toBe(1);
  expect(records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
  // The cost joined despite a different login email on the cost row - proof the
  // override is applied identically at both identity points (token AND cost).
  expect(claudeMeta(records[0]).claudeCodeCostUsd).toBe(0.42);
});

test("buildRequestBodyForLine threads the override into BOTH the Claude and Codex builders", () => {
  const claude = buildRequestBodyForLine(fullTurn(), {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(claude.records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
  const codex = buildRequestBodyForLine(codexFullTurn(), {
    developerOverride: OVERRIDE_EMAIL,
  });
  expect(codex.records[0].customerExternalId).toBe(OVERRIDE_EMAIL);
});

// ===========================================================================
// resolveDeveloperOverride - the env -> override seam, in isolation.
// ---------------------------------------------------------------------------
// The watch path resolves CCC_DEVELOPER_EMAIL through this pure, exported helper.
// Other tests inject developerOverride straight into the builders, so these tests
// pin every branch of the resolution itself.
// ===========================================================================

test("resolveDeveloperOverride: an unset var resolves to undefined (no override)", () => {
  expect(resolveDeveloperOverride({})).toBeUndefined();
});

test("resolveDeveloperOverride: an empty string resolves to undefined", () => {
  expect(resolveDeveloperOverride({ CCC_DEVELOPER_EMAIL: "" })).toBeUndefined();
});

test("resolveDeveloperOverride: a whitespace-only value resolves to undefined", () => {
  expect(
    resolveDeveloperOverride({ CCC_DEVELOPER_EMAIL: "   " }),
  ).toBeUndefined();
});

test("resolveDeveloperOverride: trims surrounding whitespace off a real email", () => {
  expect(
    resolveDeveloperOverride({ CCC_DEVELOPER_EMAIL: "  dev@example.com  " }),
  ).toBe("dev@example.com");
});

// ===========================================================================
// INTEGRATION PROOF: env -> resolveDeveloperOverride -> builder, end to end.
// ---------------------------------------------------------------------------
// The real runtime path under a SHARED coding-agent login: the telemetry's own
// user.email IS the team's single login account, and CCC_DEVELOPER_EMAIL (read
// from the process environment, NOT injected straight into the builder) is what
// re-splits the cost onto the developer actually at this laptop. We mutate
// process.env here on purpose to drive the genuine resolution line, and restore
// it after every test so the rest of the suite stays isolated.
// ===========================================================================

const SHARED_LOGIN_EMAIL = "team-login@example.com";

// A realistic Claude OTLP usage sample whose user.email is the shared team login.
function sharedLoginClaudeTurn(): ParsedOtlp {
  const id = {
    email: SHARED_LOGIN_EMAIL,
    model: "claude-opus-4-8[1m]",
    session: "session-shared-proof-1",
  };
  return otlp({
    tokenPoints: [
      tokenPoint({ ...id, type: "input", count: 1200 }),
      tokenPoint({ ...id, type: "output", count: 340 }),
      tokenPoint({ ...id, type: "cacheRead", count: 800 }),
      tokenPoint({ ...id, type: "cacheCreation", count: 150 }),
    ],
    costPoints: [costPoint({ ...id, usd: 0.1234 })],
  });
}

// The Codex twin of the same shared-login turn, so the proof covers BOTH agents.
function sharedLoginCodexTurn(): ParsedOtlp {
  return codexOtlp([
    codexRecord({
      email: SHARED_LOGIN_EMAIL,
      model: "gpt-5-codex",
      session: "conv-shared-proof-1",
      input: 1000,
      cached: 800,
      output: 500,
      reasoning: 300,
      tool: 20,
    }),
  ]);
}

// Drive ONE case all the way: set (or clear) the env var, resolve it the way the
// watcher does, run the builder, and hand back the customer the record landed on.
function customerForEnv(
  value: string | undefined,
  build: (
    sample: ParsedOtlp,
    options: { developerOverride?: string },
  ) => { records: UsageRecord[] },
  sample: ParsedOtlp,
): string {
  if (value === undefined) {
    delete process.env.CCC_DEVELOPER_EMAIL;
  } else {
    process.env.CCC_DEVELOPER_EMAIL = value;
  }
  // The actual seam under test: environment -> helper -> builder option.
  const developerOverride = resolveDeveloperOverride(process.env);
  const { records } = build(sample, { developerOverride });
  expect(records.length).toBe(1);
  return records[0].customerExternalId;
}

// Restore env isolation no matter how each case left it.
afterEach(() => {
  delete process.env.CCC_DEVELOPER_EMAIL;
});

test("INTEGRATION: env -> resolveDeveloperOverride -> builder re-attributes a shared login", () => {
  // Case A: with the var unset, the shared login email stands - the default
  // behavior the whole suite depends on.
  const customerA = customerForEnv(
    undefined,
    buildMarginFrontRequestBody,
    sharedLoginClaudeTurn(),
  );
  expect(customerA).toBe(SHARED_LOGIN_EMAIL);

  // Case B: a per-machine override wins over the shared login email.
  const customerB = customerForEnv(
    "dev-alpha@example.com",
    buildMarginFrontRequestBody,
    sharedLoginClaudeTurn(),
  );
  expect(customerB).toBe("dev-alpha@example.com");

  // Case C: a different machine, a different developer - same mechanism.
  const customerC = customerForEnv(
    "dev-beta@example.com",
    buildMarginFrontRequestBody,
    sharedLoginClaudeTurn(),
  );
  expect(customerC).toBe("dev-beta@example.com");

  // The Codex log path honors the SAME env override (Case B), proving both agents.
  const codexCustomerB = customerForEnv(
    "dev-alpha@example.com",
    buildCodexRequestBody,
    sharedLoginCodexTurn(),
  );
  expect(codexCustomerB).toBe("dev-alpha@example.com");

  // A demonstration table, printed to the test output.
  console.log(
    "\n" +
      [
        `CCC_DEVELOPER_EMAIL=(unset)               -> customer: ${customerA}`,
        `CCC_DEVELOPER_EMAIL=dev-alpha@example.com -> customer: ${customerB}`,
        `CCC_DEVELOPER_EMAIL=dev-beta@example.com  -> customer: ${customerC}`,
      ].join("\n") +
      "\n",
  );
});

// ===========================================================================
// OVERSIZED FLUSH LINES ARE SPLIT INTO <=100-RECORD POSTS.
// ---------------------------------------------------------------------------
// Ingest (RecordUsageDto) accepts at most 100 records per POST; anything bigger
// is a 400 - TERMINAL, not retryable - which would drop the whole line's spend.
// One 5-minute flush can carry more than 100 tool
// records (many sessions x many tools), so the watcher must chunk.
// ===========================================================================

test("splitIntoPostBatches chunks records at the cap, preserving order", () => {
  const make = (n: number): UsageRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      customerExternalId: `dev@example.com`,
      agentCode: "claude-code",
      signalName: "claude-code-tool",
      model: `tool-${i}`,
      modelProvider: "tool",
      quantity: 1,
      environment: "development",
      metadata: {
        source: "tool",
        sessionId: "s",
        toolName: `tool-${i}`,
        telemetrySource: "claude-code",
        estimated: true,
      },
    }));

  expect(splitIntoPostBatches([])).toEqual([]);
  expect(splitIntoPostBatches(make(1)).map((b) => b.records.length)).toEqual([
    1,
  ]);
  expect(splitIntoPostBatches(make(100)).map((b) => b.records.length)).toEqual([
    100,
  ]);
  expect(splitIntoPostBatches(make(101)).map((b) => b.records.length)).toEqual([
    100, 1,
  ]);
  const batches = splitIntoPostBatches(make(250));
  expect(batches.map((b) => b.records.length)).toEqual([100, 100, 50]);
  // Order preserved across the split - record 0 first, record 249 last.
  expect(batches[0].records[0].model).toBe("tool-0");
  expect(batches[2].records[49].model).toBe("tool-249");
});

test("the watcher sends an oversized line as multiple <=100-record POSTs, nothing dropped", async () => {
  // One collector line carrying 150 DISTINCT tool events -> 150 records.
  const logRecords = Array.from({ length: 150 }, (_, i) => ({
    attributes: [
      { key: "event.name", value: { stringValue: "tool_result" } },
      { key: "tool_name", value: { stringValue: `mcp__load__t${i}` } },
      { key: "user.email", value: { stringValue: "dev@example.com" } },
      { key: "session.id", value: { stringValue: "sess-oversize" } },
    ],
  }));
  const line = JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords }] }],
  });

  const capturedBodies: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBodies.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const dir = mkdtempSync(join(tmpdir(), "ccc-oversize-"));
  const jsonlPath = join(dir, "live.jsonl");
  writeFileSync(jsonlPath, line + "\n");

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-oversize";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
    });
    // The initial poll runs immediately; wait (bounded) for both POSTs to land.
    const deadline = Date.now() + 2_000;
    while (capturedBodies.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(capturedBodies.map((b) => b.records.length)).toEqual([100, 50]);
    // Every one of the 150 records arrived exactly once, each with its own key.
    const keys = capturedBodies.flatMap((b) =>
      b.records.map((r) => r.idempotencyKey),
    );
    expect(new Set(keys).size).toBe(150);
  } finally {
    if (stop) stop();
    process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});
