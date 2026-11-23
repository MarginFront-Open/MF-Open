/**
 * Codex cache-write capture.
 *
 * Every OTLP record below comes from a real Codex OTLP capture: verbatim
 * attribute names, verbatim token counts, verbatim model ids and
 * event names. Only free text and identifiers were scrubbed, and tool_input /
 * tool_parameters were dropped rather than read.
 *
 * codex-pre-cache-write-golden.json is the output this fixture produces without
 * cache-write capture. Anything the capture must not move has to match it byte
 * for byte.
 *
 * WHY THE OBVIOUS INVARIANT IS NOT ENOUGH:
 * inputTokens + cacheReadTokens + cacheWriteTokens === input_token_count also
 * holds when the whole cache-write slice sits inside inputTokens, because the
 * sum comes out the same either way.
 * It cannot fail, so it cannot be the proof. The assertions that actually bite are
 * the two below it: cacheWriteTokens must equal the reported count, and inputTokens
 * must be the fresh remainder with BOTH slices removed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildCodexRequestBody,
  buildRequestBodyForLine,
} from "../src/forwarder";
import type { CodexUsageRecordMetadata, ParsedOtlp } from "../src/types";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const capture = JSON.parse(
  readFileSync(`${fixtureDir}codex-cache-write-capture.json`, "utf8"),
) as Record<string, ParsedOtlp> & {
  claudeCodeMetricLines: ParsedOtlp[];
};
const golden = JSON.parse(
  readFileSync(`${fixtureDir}codex-pre-cache-write-golden.json`, "utf8"),
) as Record<string, unknown>;

const BUILD_OPTIONS = { fallbackCustomerId: "dev@example.test" };

// Reads a token count straight off the raw fixture attributes, so the expected
// numbers in this file come from the capture and never from the code under test.
function rawCount(
  fixtureKey: string,
  recordIndex: number,
  attr: string,
): number {
  const logRecord =
    capture[fixtureKey].resourceLogs![0].scopeLogs![0].logRecords![recordIndex];
  const value = logRecord.attributes!.find((a) => a.key === attr)?.value;
  if (value === undefined) return 0;
  return Number(value.intValue ?? value.stringValue ?? 0);
}

function recordsFor(fixtureKey: string, foldCache = false) {
  return buildRequestBodyForLine(capture[fixtureKey], {
    ...BUILD_OPTIONS,
    foldCache,
  }).records;
}

describe("the three-way partition of input_token_count", () => {
  // 13,175 input = 0 cached + 13,172 written + 3 fresh. A cache-cold turn.
  it("splits a cold gpt-5.6-sol turn into fresh input and a cache write", () => {
    const [record] = recordsFor("codexSolColdBigWrite");
    const input = rawCount("codexSolColdBigWrite", 0, "input_token_count");
    const cached = rawCount("codexSolColdBigWrite", 0, "cached_token_count");
    const written = rawCount(
      "codexSolColdBigWrite",
      0,
      "cache_write_token_count",
    );

    expect(record.cacheWriteTokens).toBe(written);
    expect(record.cacheReadTokens).toBe(cached);
    expect(record.inputTokens).toBe(input - cached - written);
    expect(
      record.inputTokens! + record.cacheReadTokens! + record.cacheWriteTokens!,
    ).toBe(input);
  });

  // 13,301 input = 13,172 cached + 126 written + 3 fresh. All three buckets non-zero,
  // which is the case a two-way mapping gets most wrong: it would bill 129 as fresh.
  it("splits a warm gpt-5.6-sol turn across all three buckets", () => {
    const [record] = recordsFor("codexSolWarmBothSlices");
    const input = rawCount("codexSolWarmBothSlices", 0, "input_token_count");
    const cached = rawCount("codexSolWarmBothSlices", 0, "cached_token_count");
    const written = rawCount(
      "codexSolWarmBothSlices",
      0,
      "cache_write_token_count",
    );

    expect(cached).toBeGreaterThan(0);
    expect(written).toBeGreaterThan(0);
    expect(record.cacheWriteTokens).toBe(written);
    expect(record.cacheReadTokens).toBe(cached);
    expect(record.inputTokens).toBe(input - cached - written);
    expect(
      record.inputTokens! + record.cacheReadTokens! + record.cacheWriteTokens!,
    ).toBe(input);
  });

  it("mirrors the write count into audit metadata", () => {
    const [record] = recordsFor("codexSolColdBigWrite");
    const metadata = record.metadata as CodexUsageRecordMetadata;
    expect(metadata.cacheWriteTokens).toBe(
      rawCount("codexSolColdBigWrite", 0, "cache_write_token_count"),
    );
  });
});

describe("no double-count, in tokens", () => {
  // The dollar half is packages/db/src/lib/codex-cache-write-cost.test.ts, which
  // prices these same counts through the real calculateEventCost.
  it("assigns every input token to exactly one bucket", () => {
    for (const key of [
      "codexSolColdBigWrite",
      "codexSolWarmBothSlices",
      "codexSolZeroWrite",
    ]) {
      const [record] = recordsFor(key);
      const input = rawCount(key, 0, "input_token_count");
      const cached = rawCount(key, 0, "cached_token_count");
      const written = rawCount(key, 0, "cache_write_token_count");
      const total =
        (record.inputTokens ?? 0) +
        (record.cacheReadTokens ?? 0) +
        (record.cacheWriteTokens ?? 0);
      expect(total, `${key} buckets must sum to input_token_count`).toBe(input);
      // The sum alone is satisfied by a two-way mapping too. This is the
      // assertion that separates them: the fresh bucket carries the remainder and
      // nothing else, so the written slice is billed once, at the write rate.
      expect(
        record.inputTokens,
        `${key} fresh input is the remainder after both slices`,
      ).toBe(input - cached - written);
      expect(record.cacheWriteTokens ?? 0, `${key} write bucket`).toBe(written);
    }
  });
});

describe("--fold-cache", () => {
  // Documented behavior: folding bills the WHOLE input_token_count at the plain
  // input rate and emits neither cache field, so no cache token can reach a pricing
  // row that has no cache rate. For the cached slice that is a high ceiling; for the
  // written slice it is a 20% floor, because the real write rate is 1.25x input.
  it("bills the whole input and emits no cache fields", () => {
    for (const key of ["codexSolColdBigWrite", "codexSolWarmBothSlices"]) {
      const [record] = recordsFor(key, true);
      expect(record.inputTokens).toBe(rawCount(key, 0, "input_token_count"));
      expect(record).not.toHaveProperty("cacheReadTokens");
      expect(record).not.toHaveProperty("cacheWriteTokens");
      expect(
        (record.metadata as CodexUsageRecordMetadata).cacheFoldedIntoInput,
      ).toBe(true);
    }
  });

  // Folding stamps the write count into audit metadata, the same way it stamps the
  // folded cached count, so the folded output is NOT byte-identical to the golden -
  // it carries that one unpriced key. Everything that bills matches.
  it("changes nothing that bills, and adds only the audit key", () => {
    for (const key of [
      "codexSolColdBigWrite",
      "codexSolWarmBothSlices",
      "codexSolZeroWrite",
    ]) {
      const records = recordsFor(key, true).map((record) => {
        const metadata = {
          ...(record.metadata as CodexUsageRecordMetadata),
        };
        delete metadata.cacheWriteTokens;
        return { ...record, metadata };
      });
      expect(
        JSON.stringify({ records }),
        `${key} under --fold-cache, audit key removed`,
      ).toBe(JSON.stringify(golden[`${key}::foldCache`]));
    }
  });
});

describe("regression: paths the cache-write split must not move", () => {
  // Claude Code usage arrives on the METRICS tree via a different builder, so this
  // should be untouched - but "should be" is what the assertion is for. These three
  // lines carry real splits, up to 377,030 cache-read / 78,067 written on one turn.
  it("Claude Code metric lines match the golden output byte for byte", () => {
    const after = capture.claudeCodeMetricLines.map((line) =>
      buildRequestBodyForLine(line, BUILD_OPTIONS),
    );
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(golden.claudeCodeMetricLines),
    );
    // Guard against the fixture silently emptying out and the assertion above
    // comparing "nothing" to "nothing".
    expect(after.flatMap((body) => body.records).length).toBeGreaterThan(0);
  });

  it("pre-5.6 Codex models match the golden output byte for byte", () => {
    for (const key of [
      "codexGpt55WithZeroCacheWriteAttr",
      "codexGpt55NoCacheWriteAttr",
      "codexGpt54Mini",
      "codexSolZeroWrite",
    ]) {
      const records = recordsFor(key);
      expect(records.length).toBeGreaterThan(0);
      expect(JSON.stringify({ records }), key).toBe(
        JSON.stringify(golden[key]),
      );
    }
  });
});

describe("negative controls", () => {
  // THE REVENUE GATE. api-nest (sdk.service.ts) flips any event with
  // cacheWriteTokens > 0 against a pricing row whose cacheWriteCost is NULL to
  // NEEDS_COST_BACKFILL with a null cost. gpt-5.5's pricing row
  // has a NULL cacheWriteCost - so a reported ZERO must produce no field at all,
  // not a zero. Both of these records are real gpt-5.5 turns on Codex 0.145.0 and
  // 0.146.0 that reported cache_write_token_count as a literal 0.
  it("a reported zero cache-write emits no cacheWriteTokens field", () => {
    const records = recordsFor("codexGpt55WithZeroCacheWriteAttr");
    expect(records.length).toBe(2);
    for (const record of records) {
      expect(
        rawCount(
          "codexGpt55WithZeroCacheWriteAttr",
          0,
          "cache_write_token_count",
        ),
      ).toBe(0);
      expect(record).not.toHaveProperty("cacheWriteTokens");
      expect(record.metadata).not.toHaveProperty("cacheWriteTokens");
    }
  });

  it("a Claude Code LOG record is still not read as a Codex token turn", () => {
    // Claude names its cache fields cache_read_tokens / cache_creation_tokens. Adding
    // cache_write_token_count to the Codex detector must not widen the net onto them.
    const claudeShapedLog: ParsedOtlp = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "api_request" },
                    },
                    { key: "model", value: { stringValue: "claude-sonnet-5" } },
                    { key: "input_tokens", value: { intValue: 4096 } },
                    { key: "output_tokens", value: { intValue: 512 } },
                    { key: "cache_read_tokens", value: { intValue: 20272 } },
                    {
                      key: "cache_creation_tokens",
                      value: { intValue: 71516 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(
      buildCodexRequestBody(claudeShapedLog, BUILD_OPTIONS).records,
    ).toEqual([]);
  });

  // 100 input reported as 90 cached + 90 written. Billing both 90s in full would be
  // 180 tokens against a 100-token turn, a 1.8x over-bill. The write slice absorbs
  // the overrun and the read slice is preserved ahead of it; reasoning in
  // codex-token-conservation.test.ts.
  it("a malformed turn whose slices exceed input bills no more than that input", () => {
    const malformed: ParsedOtlp = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "codex.sse_event" },
                    },
                    { key: "model", value: { stringValue: "gpt-5.6-sol" } },
                    { key: "input_token_count", value: { stringValue: "100" } },
                    { key: "cached_token_count", value: { intValue: 90 } },
                    {
                      key: "cache_write_token_count",
                      value: { intValue: 90 },
                    },
                    { key: "output_token_count", value: { stringValue: "10" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [record] = buildCodexRequestBody(malformed, BUILD_OPTIONS).records;
    expect(record.inputTokens).toBe(0);
    expect(record.cacheReadTokens).toBe(90);
    expect(record.cacheWriteTokens).toBe(10);
    expect(
      record.inputTokens! + record.cacheReadTokens! + record.cacheWriteTokens!,
    ).toBe(100);
  });
});
