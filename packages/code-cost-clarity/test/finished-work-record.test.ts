// finished-work-record.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: a finished thing is a usage record with NO
// tokens and NO model cost. It is priced $0 by one catalog row under provider
// "outcome", model "work-item", and that provider word is the ONE marker every read
// on the ROI page uses. So the two things that must never drift are pinned here:
//
//   1. the builder's output carries none of the token keys, ABSENT rather than zero
//      (a zero would still be a token field the pricing path reads), and
//   2. no source file on the done path so much as names one.
//
// This is the structural half of the double-count assertion. The SQL half,
// packages/db/scripts/__tests__/cost-grouping-finished-work.integration.test.ts,
// runs against a real database; what a meter can prove on its own is
// that the record it builds cannot carry a price or a token in the first place.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readSrc, srcFilePaths } from "./helpers/source-strings";
import {
  FINISHED_WORK_MAX_COUNT,
  FINISHED_WORK_MODEL,
  FINISHED_WORK_NAME_MAX_LENGTH,
  FINISHED_WORK_PROVIDER,
  buildFinishedWorkRecord,
  finishedWorkIdempotencyKey,
  normalizeFinishedName,
  parseFinishedCount,
  parseFinishedWorkNames,
  renderFinishedWorkNames,
} from "../src/finished-work";

const DONE_AT = "2026-09-21T14:32:07.001Z";

function record(overrides: Record<string, unknown> = {}) {
  return buildFinishedWorkRecord({
    identity: "dev@example.com",
    agentCode: "claude-code",
    name: "contract summarized",
    count: 1,
    doneAt: DONE_AT,
    ...overrides,
  });
}

describe("the record shape a finished thing lands as", () => {
  test("it names the one provider and model the $0 catalog row prices", () => {
    const built = record();
    expect(built.modelProvider).toBe("outcome");
    expect(built.model).toBe("work-item");
    expect(FINISHED_WORK_PROVIDER).toBe("outcome");
    expect(FINISHED_WORK_MODEL).toBe("work-item");
  });

  test("identity, name, count and environment ride the fields ingest already reads", () => {
    const built = record({ name: "slide deck", count: 3 });
    expect(built.customerExternalId).toBe("dev@example.com");
    expect(built.signalName).toBe("slide deck");
    expect(built.quantity).toBe(3);
    expect(built.environment).toBe("development");
    expect(built.agentCode).toBe("claude-code");
  });

  test("metadata carries source, doneAt, and the work item only when one is set", () => {
    const withLabel = record({ workItem: "PROJ-123" });
    expect(withLabel.metadata).toEqual({
      source: "outcome",
      matterId: "PROJ-123",
      doneAt: DONE_AT,
    });

    const without = record();
    expect(without.metadata).toEqual({ source: "outcome", doneAt: DONE_AT });
    expect(Object.keys(without.metadata)).not.toContain("matterId");
  });

  test("git coordinates ride along when the cwd is a repo, and are omitted when it is not", () => {
    const inRepo = record({
      git: { repo: "example-org/platform", branch: "develop", commitSha: "abc123" },
    });
    expect(inRepo.metadata).toMatchObject({
      repo: "example-org/platform",
      branch: "develop",
      commitSha: "abc123",
    });

    // All-null is what readGitCoordinates returns outside a repo. Stamping three
    // nulls would claim we looked and found nothing; omitting says we have no repo.
    const outside = record({ git: { repo: null, branch: null, commitSha: null } });
    expect(Object.keys(outside.metadata).sort()).toEqual(["doneAt", "source"]);
  });

  // THE GATE. Absent, not zero: ingest prices any token field it is handed, so a
  // zero here would be a priced field with a zero value rather than no field at all.
  test("no token key is present, at any value", () => {
    const built = record({
      workItem: "PROJ-123",
      count: 9,
      git: { repo: "a/b", branch: "main", commitSha: "deadbeef" },
    });
    const forbidden = [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ];
    for (const key of forbidden) {
      expect(Object.keys(built)).not.toContain(key);
      expect(Object.keys(built.metadata)).not.toContain(key);
    }
    // And no session stamp: attribution joins on developer and work item, never on
    // a session the meter cannot see from a terminal command.
    expect(Object.keys(built.metadata)).not.toContain("sessionId");
  });

  test("the meter never computes a cost: no cost field leaves the builder", () => {
    const serialized = JSON.stringify(record({ workItem: "PROJ-123" }));
    expect(serialized).not.toMatch(/cost/i);
    expect(serialized).not.toMatch(/token/i);
  });
});

describe("the dedup key", () => {
  test("the same finished thing in the same minute hashes the same", () => {
    const first = finishedWorkIdempotencyKey(
      "dev@example.com",
      "contract summarized",
      1,
      "2026-09-21T14:32:07.001Z",
    );
    const second = finishedWorkIdempotencyKey(
      "dev@example.com",
      "contract summarized",
      1,
      "2026-09-21T14:32:58.900Z",
    );
    expect(first).toBe(second);
  });

  test("a different minute, name, count or developer hashes differently", () => {
    const base = finishedWorkIdempotencyKey("a@b.example", "contract summarized", 1, DONE_AT);
    expect(
      finishedWorkIdempotencyKey("a@b.example", "contract summarized", 1, "2026-09-21T14:33:07.001Z"),
    ).not.toBe(base);
    expect(finishedWorkIdempotencyKey("a@b.example", "slide deck", 1, DONE_AT)).not.toBe(base);
    expect(finishedWorkIdempotencyKey("a@b.example", "contract summarized", 2, DONE_AT)).not.toBe(base);
    expect(finishedWorkIdempotencyKey("c@d.example", "contract summarized", 1, DONE_AT)).not.toBe(base);
  });

  test("the builder stamps it", () => {
    expect(record().idempotencyKey).toBe(
      finishedWorkIdempotencyKey("dev@example.com", "contract summarized", 1, DONE_AT),
    );
  });
});

describe("the name, as the customer typed it", () => {
  test("it is trimmed and its inner whitespace collapses", () => {
    expect(normalizeFinishedName("  contract   summarized \n")).toBe("contract summarized");
  });

  test("capitals are kept: the ROI page groups by name and shows what was typed", () => {
    expect(normalizeFinishedName("Contract Summarized")).toBe("Contract Summarized");
  });

  test("an empty or whitespace-only name normalizes to nothing", () => {
    expect(normalizeFinishedName("   ")).toBe("");
    expect(normalizeFinishedName(undefined)).toBe("");
  });

  test("it is held to the cap every top-level ingest string has", () => {
    expect(FINISHED_WORK_NAME_MAX_LENGTH).toBe(255);
    expect(normalizeFinishedName("x".repeat(400))).toHaveLength(255);
  });
});

describe("the count", () => {
  test("no count means one", () => {
    expect(parseFinishedCount(undefined)).toEqual({ ok: true, count: 1 });
  });

  test("a positive whole number is taken as typed", () => {
    expect(parseFinishedCount("7")).toEqual({ ok: true, count: 7 });
  });

  test("zero, a negative, a fraction and a word are all refused", () => {
    for (const bad of ["0", "-3", "1.5", "two", "", "  ", "1e3"]) {
      expect(parseFinishedCount(bad).ok, `"${bad}" should be refused`).toBe(false);
    }
  });

  test("a runaway number is refused rather than billed", () => {
    expect(FINISHED_WORK_MAX_COUNT).toBe(10000);
    expect(parseFinishedCount("10000")).toEqual({ ok: true, count: 10000 });
    expect(parseFinishedCount("10001").ok).toBe(false);
  });
});

describe("the names the customer gave init", () => {
  test("they round-trip through the settings line", () => {
    const names = parseFinishedWorkNames("contract summarized, slide deck , memo");
    expect(names).toEqual(["contract summarized", "slide deck", "memo"]);
    expect(renderFinishedWorkNames(names)).toBe("contract summarized, slide deck, memo");
  });

  test("blank entries and a blank line yield no names", () => {
    expect(parseFinishedWorkNames(" , ,, ")).toEqual([]);
    expect(parseFinishedWorkNames(undefined)).toEqual([]);
  });

  test("the same name twice in different capitals is one name, first spelling kept", () => {
    expect(parseFinishedWorkNames("Contract Summarized, contract summarized")).toEqual([
      "Contract Summarized",
    ]);
  });
});

// The twin of the object gate above, over the SOURCE. An object test passes if a
// branch nobody exercised adds a token field; this fails if the words appear on the
// done path at all.
describe("source gate: nothing on the done path names a token field", () => {
  const TOKEN_KEYS =
    /\b(inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|cacheCreationTokens|reasoningTokens|toolTokens|cachedTokens|usageCost|totalCostUsd)\b/;

  // The priced-zero provider is the ONE marker the ROI page reads. A second place in
  // the meter that sets it is a second way for a record to claim it is a finished
  // thing, and the two would drift.
  test("exactly one source file sets the outcome provider", () => {
    const setters = srcFilePaths().filter((path) =>
      /modelProvider:\s*(FINISHED_WORK_PROVIDER|"outcome")/.test(readSrc(path)),
    );
    expect(setters.map((path) => path.split(/[\\/]/).pop())).toEqual([
      "finished-work.ts",
    ]);
  });

  test("src/finished-work.ts names no token or cost field", () => {
    const file = srcFilePaths().find((path) => path.endsWith("finished-work.ts"));
    expect(file, "src/finished-work.ts must exist").toBeDefined();
    const offenders = readSrc(file as string)
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter((entry) => TOKEN_KEYS.test(entry.line))
      .map((entry) => `finished-work.ts:${entry.index + 1}: ${entry.line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
