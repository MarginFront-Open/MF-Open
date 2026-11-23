/**
 * Token conservation on the Codex path.
 *
 * input_token_count is a WHOLE that cached + cache-write + fresh are carved out of.
 * The billed trio must therefore never sum past it. On a turn whose reported
 * slices exceed its own input, flooring fresh at zero while both slices still
 * bill in full would OVER-bill.
 *
 * Priced at real gpt-5.6-sol catalog rates (input $5.00, cache-read $0.50,
 * cache-write $6.25 per 1M) one such turn would go $0.00030000 -> $0.03155000, a
 * 105x over-bill.
 *
 * THE ABSORPTION RULE, asserted rather than implied: the WRITE slice gives up
 * everything. It is the newest count (absent on Codex 0.142.x, always zero pre-5.6)
 * and the dearest per token, so shrinking it errs toward under-billing and lands on
 * the field likeliest to be wrong. cached_token_count is preserved ahead of it, and
 * only clamped when it alone overruns input.
 *
 * Malformed inputs here are real captured records with ONLY the three token counts
 * overridden - real attribute names, real model ids, real event names. The counts
 * are 60 input, 600 cached, 5000 written.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildRequestBodyForLine } from "../src/forwarder";
import type { CodexUsageRecordMetadata, ParsedOtlp } from "../src/types";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const capture = JSON.parse(
  readFileSync(`${fixtureDir}codex-cache-write-capture.json`, "utf8"),
) as Record<string, ParsedOtlp> & { claudeCodeMetricLines: ParsedOtlp[] };

const BUILD_OPTIONS = { fallbackCustomerId: "dev@example.test" };

const CODEX_FIXTURE_KEYS = [
  "codexSolColdBigWrite",
  "codexSolWarmBothSlices",
  "codexSolZeroWrite",
  "codexGpt55WithZeroCacheWriteAttr",
  "codexGpt55NoCacheWriteAttr",
  "codexGpt54Mini",
] as const;

// gpt-5.6-sol, per 1M, the catalog rates the golden harness prices against.
const RATE_INPUT = 5.0;
const RATE_CACHE_READ = 0.5;
const RATE_CACHE_WRITE = 6.25;

function priceOf(record: {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return (
    ((record.inputTokens ?? 0) * RATE_INPUT +
      (record.cacheReadTokens ?? 0) * RATE_CACHE_READ +
      (record.cacheWriteTokens ?? 0) * RATE_CACHE_WRITE) /
    1e6
  );
}

function attrOf(logRecord: Record<string, never>, key: string) {
  return (
    logRecord as unknown as {
      attributes: { key: string; value: Record<string, unknown> }[];
    }
  ).attributes.find((a) => a.key === key);
}

// A real captured line with only the three counts rewritten. Everything else -
// attribute names, model id, event name, resource envelope - is untouched capture.
function malformed(
  input: number,
  cached: number,
  cacheWrite: number,
): ParsedOtlp {
  const line = JSON.parse(
    JSON.stringify(capture.codexSolWarmBothSlices),
  ) as ParsedOtlp;
  const logRecords = line.resourceLogs![0].scopeLogs![0].logRecords!;
  // Keep exactly one turn on the line so the assertions read unambiguously.
  logRecords.length = 1;

  const set = (key: string, value: number): void => {
    const attr = attrOf(logRecords[0] as never, key);
    if (attr === undefined) {
      throw new Error(`capture has no ${key} to override`);
    }
    attr.value = { intValue: String(value) };
  };

  set("input_token_count", input);
  set("cached_token_count", cached);
  set("cache_write_token_count", cacheWrite);
  return line;
}

function recordsOf(line: ParsedOtlp, foldCache = false) {
  return buildRequestBodyForLine(line, { ...BUILD_OPTIONS, foldCache }).records;
}

function rawInput(line: ParsedOtlp, index: number): number {
  const logRecord = line.resourceLogs![0].scopeLogs![0].logRecords![index];
  const attr = attrOf(logRecord as never, "input_token_count");
  return Number(attr?.value.intValue ?? attr?.value.stringValue ?? 0);
}

describe("the billed slices never sum past input_token_count", () => {
  // The property, over every Codex turn in the capture rather than a chosen one.
  for (const key of CODEX_FIXTURE_KEYS) {
    it(`holds for every turn in ${key}`, () => {
      const records = recordsOf(capture[key]);
      expect(records.length).toBeGreaterThan(0);

      records.forEach((record, index) => {
        const billed =
          (record.inputTokens ?? 0) +
          (record.cacheReadTokens ?? 0) +
          (record.cacheWriteTokens ?? 0);
        expect(
          billed,
          `${key}[${index}] bills ${billed} tokens against an input of ${rawInput(capture[key], index)}`,
        ).toBeLessThanOrEqual(rawInput(capture[key], index));
      });
    });
  }

  it("holds under --fold-cache too, where the whole input bills at the input rate", () => {
    for (const key of CODEX_FIXTURE_KEYS) {
      recordsOf(capture[key], true).forEach((record, index) => {
        expect(record.cacheReadTokens).toBeUndefined();
        expect(record.cacheWriteTokens).toBeUndefined();
        expect(record.inputTokens).toBe(rawInput(capture[key], index));
      });
    }
  });
});

describe("a turn whose slices overrun its input cannot over-bill", () => {
  // 60 input reported as 600 cached + 5000 written: a 105x overrun.
  const OVERRUN_INPUT = 60;
  const OVERRUN_CACHED = 600;
  const OVERRUN_WRITE = 5000;

  it("clamps a 105x overrun back to the input it was carved from", () => {
    const [record] = recordsOf(
      malformed(OVERRUN_INPUT, OVERRUN_CACHED, OVERRUN_WRITE),
    );

    const billed =
      (record.inputTokens ?? 0) +
      (record.cacheReadTokens ?? 0) +
      (record.cacheWriteTokens ?? 0);
    expect(billed).toBe(OVERRUN_INPUT);

    // Unclamped, this prices at $0.03155000 against a $0.00030000 turn.
    expect(priceOf(record)).toBeCloseTo(0.00003, 10);

    const unclamped =
      (0 * RATE_INPUT +
        OVERRUN_CACHED * RATE_CACHE_READ +
        OVERRUN_WRITE * RATE_CACHE_WRITE) /
      1e6;
    expect(unclamped / priceOf(record)).toBeGreaterThan(1000);
  });

  it("spends the discrepancy out of the write slice, not the read slice", () => {
    // 1000 input, 600 cached, 900 written: 1500 of slices against 1000 of whole.
    // cached survives intact; the write takes the full 500-token overrun.
    const [record] = recordsOf(malformed(1000, 600, 900));

    expect(record.cacheReadTokens).toBe(600);
    expect(record.cacheWriteTokens).toBe(400);
    expect(record.inputTokens).toBe(0);
    expect(
      record.inputTokens! + record.cacheReadTokens! + record.cacheWriteTokens!,
    ).toBe(1000);
  });

  it("clamps the read slice only when it alone overruns the input", () => {
    const [record] = recordsOf(malformed(100, 900, 0));

    expect(record.cacheReadTokens).toBe(100);
    expect(record.inputTokens).toBe(0);
    expect(record.cacheWriteTokens).toBeUndefined();
  });

  it("omits the write field entirely when the clamp takes it to zero", () => {
    // A positive reported write that survives nothing must not ship as a zero: a
    // zero write against a pricing row with no write rate flips the whole event to
    // NEEDS_COST_BACKFILL and unbills real revenue.
    const [record] = recordsOf(malformed(60, 600, 5000));
    expect(record.cacheWriteTokens).toBeUndefined();
    expect("cacheWriteTokens" in record).toBe(false);
  });

  it("keeps the raw reported counts in metadata and flags the disagreement", () => {
    const [record] = recordsOf(malformed(60, 600, 5000));
    const metadata = record.metadata as CodexUsageRecordMetadata;

    expect(metadata.cachedTokens).toBe(600);
    expect(metadata.cacheWriteTokens).toBe(5000);
    expect(metadata.cacheSlicesClamped).toBe(true);
  });
});

describe("negative control: well-formed turns are not touched by the clamp", () => {
  it("no captured Codex turn carries the clamp flag", () => {
    for (const key of CODEX_FIXTURE_KEYS) {
      for (const record of recordsOf(capture[key])) {
        const metadata = record.metadata as CodexUsageRecordMetadata;
        expect(
          metadata.cacheSlicesClamped,
          `${key} tripped the clamp on well-formed capture`,
        ).toBeUndefined();
      }
    }
  });

  it("a turn whose slices exactly fill its input keeps every token", () => {
    // 1000 = 400 cached + 600 written, nothing fresh. Sits on the boundary the
    // clamp tests, and must pass through untouched.
    const [record] = recordsOf(malformed(1000, 400, 600));

    expect(record.cacheReadTokens).toBe(400);
    expect(record.cacheWriteTokens).toBe(600);
    expect(record.inputTokens).toBe(0);
    expect(
      (record.metadata as CodexUsageRecordMetadata).cacheSlicesClamped,
    ).toBeUndefined();
  });

  it("Claude Code records are unchanged - its buckets are disjoint, not nested", () => {
    // Anthropic's cache counts sit BESIDE input rather than inside it, so summing
    // them against input is meaningless there and the clamp must never apply.
    const before = JSON.stringify(
      capture.claudeCodeMetricLines.map((line) =>
        buildRequestBodyForLine(line, BUILD_OPTIONS),
      ),
    );
    expect(before).toContain('"inputTokens"');
    expect(before).not.toContain("cacheSlicesClamped");
  });
});
