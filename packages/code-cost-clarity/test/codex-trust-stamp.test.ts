// codex-trust-stamp.test.ts: what a Codex record is allowed to claim.
//
// THE ONE FAILURE THIS FILE EXISTS TO PREVENT: a Codex record telling the dashboard
// the cap is on when it is not, or when nobody ever checked. Three rules are pinned
// here, each with a test that can actually go red:
//
//   RULE 1 - an old meter never inflates Codex. Versions up to 0.11.0 had no
//     Codex answer to give, so their records carry no stamp at all, and the absence
//     of the stamp has to stay readable as "we don't know" forever. That is what
//     controlStampVersion is for, and why it rides EVERY record this version emits,
//     including the ones that report we couldn't tell.
//   RULE 2 - armed means trusted. A hook that is installed but not approved in
//     Codex's /hooks is inert; Codex skips it without a word. So the stamp comes
//     from the trust resolver, never from a receipt file existing.
//   RULE 3 - the stamp never slows the meter down. Asking Codex spawns a Codex
//     process. The per-line record builder must not do that, and must not read a
//     file either - swapping a spawn for a syscall on a path that runs many times a
//     second is the near-miss version of the same mistake.
//
// Every path here is a temp path. Nothing reads or writes the real ~/.codex or
// ~/.marginfront-ccc.

import { test, expect, describe, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexControlStamp,
  resolveCodexControlStatus,
  readCodexTrustCache,
  writeCodexTrustCache,
  validateCodexTrustCache,
  codexTrustValidForMs,
  CODEX_CONTROL_STAMP_VERSION,
  CODEX_TRUST_TTL_MS,
  type CodexControlState,
  type CodexControlStatus,
  type CodexTrustCacheEntry,
} from "../src/control";
import {
  buildCodexRequestBody,
  watchAndForward,
  CCC_PACKAGE_VERSION,
} from "../src/forwarder";
import type {
  CodexUsageRecordMetadata,
  OtlpLogRecord,
  ParsedOtlp,
  UsageRecord,
} from "../src/types";

// The RUNNING version. watchAndForward validates a cached verdict against the real
// CCC_PACKAGE_VERSION, so a literal here fails three tests on every version bump.
const VERSION = CCC_PACKAGE_VERSION;
const NOW = new Date("2026-07-30T12:00:00.000Z");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-codextrust-"));
}

function cacheEntry(
  over: Partial<CodexTrustCacheEntry> = {},
): CodexTrustCacheEntry {
  return {
    state: "armed",
    reason: null,
    resolvedAt: NOW.toISOString(),
    ccc: VERSION,
    ...over,
  };
}

function stampFor(
  cached: CodexTrustCacheEntry | null,
  policyPath = join(tmp(), "policy.json"),
) {
  return resolveCodexControlStamp({
    cached,
    cccVersion: VERSION,
    policyPath,
    now: NOW,
  });
}

// --- one real Codex telemetry line, so the stamp is proven on the WIRE ------

function strAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
function numAttr(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function codexLine(): ParsedOtlp {
  const record: OtlpLogRecord = {
    attributes: [
      strAttr("event.name", "codex.sse_event"),
      strAttr("user.email", "dev@co.example"),
      strAttr("model", "gpt-5.6-sol"),
      strAttr("session.id", "sess-1"),
      numAttr("input_token_count", 1000),
      numAttr("cached_token_count", 800),
      numAttr("output_token_count", 500),
    ],
  };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }] };
}

function codexMeta(rec: UsageRecord): CodexUsageRecordMetadata {
  const md = rec.metadata;
  if (!("source" in md) || md.source !== "codex") {
    throw new Error("expected Codex metadata");
  }
  return md;
}

// ---------------------------------------------------------------------------
// RULE 2 - armed means Codex told us it trusts the hook
// ---------------------------------------------------------------------------

describe("rule 2: Codex armed means trusted", () => {
  test("an installed-but-untrusted Codex hook is NOT armed", () => {
    const stamp = stampFor(
      cacheEntry({ state: "needs-re-trust", reason: "untrusted" }),
    );
    expect(stamp.codexControlArmed).toBe(false);
    expect(stamp.codexControlState).toBe("needs-re-trust");
  });

  test("file existence is never the source of the Codex stamp", () => {
    // The receipt that says "we wrote a hook into Codex's hooks file" EXISTS on
    // disk, which is exactly the signal a builder is tempted to reuse. The trust
    // resolver still says the hook was never approved, and the resolver wins.
    const dir = tmp();
    const receiptPath = join(dir, "codex-control-hook-owned.json");
    writeFileSync(receiptPath, JSON.stringify({ command: "anything" }));
    expect(existsSync(receiptPath)).toBe(true);

    const stamp = stampFor(cacheEntry({ state: "needs-re-trust" }));
    expect(stamp.codexControlArmed).toBe(false);
  });

  const STATES: CodexControlState[] = [
    "armed",
    "needs-re-trust",
    "hooks-disabled",
    "not-installed",
    "unknown",
  ];

  test("five resolver states map to exactly one codexControlArmed:true", () => {
    const armed = STATES.filter(
      (state) => stampFor(cacheEntry({ state })).codexControlArmed === true,
    );
    expect(armed).toEqual(["armed"]);
  });

  test("the three proven-no states stamp false, and unknown stamps nothing", () => {
    for (const state of [
      "needs-re-trust",
      "hooks-disabled",
      "not-installed",
    ] as const) {
      expect(stampFor(cacheEntry({ state })).codexControlArmed).toBe(false);
    }
    // A proven gap and an unread machine are different facts. Only the first one
    // gets a boolean; the second omits the key entirely.
    expect(
      "codexControlArmed" in stampFor(cacheEntry({ state: "unknown" })),
    ).toBe(false);
  });

  test("armed carries the policy freshness, and the other states carry none", () => {
    const dir = tmp();
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({ asOf: "2026-07-30T11:00:00.000Z" }),
    );
    expect(stampFor(cacheEntry(), policyPath).controlPolicyAsOf).toBe(
      "2026-07-30T11:00:00.000Z",
    );
    expect(
      "controlPolicyAsOf" in
        stampFor(cacheEntry({ state: "hooks-disabled" }), policyPath),
    ).toBe(false);
  });

  test("armed with no readable policy is still armed, with an honest null", () => {
    const stamp = stampFor(cacheEntry(), join(tmp(), "never-written.json"));
    expect(stamp.codexControlArmed).toBe(true);
    expect(stamp.controlPolicyAsOf).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cache: nothing survives that we cannot vouch for
// ---------------------------------------------------------------------------

describe("a cached answer we cannot vouch for degrades to unknown", () => {
  test("a missing trust cache stamps unknown, never true", () => {
    const stamp = stampFor(null);
    expect(stamp.controlStampVersion).toBe(CODEX_CONTROL_STAMP_VERSION);
    expect(stamp.codexControlState).toBe("unknown");
    expect("codexControlArmed" in stamp).toBe(false);
  });

  test("a stale trust cache stamps unknown, never the last known true", () => {
    const stale = cacheEntry({
      resolvedAt: new Date(
        NOW.getTime() - CODEX_TRUST_TTL_MS - 60_000,
      ).toISOString(),
    });
    expect(stale.state).toBe("armed");
    const stamp = stampFor(stale);
    expect(stamp.codexControlState).toBe("unknown");
    expect("codexControlArmed" in stamp).toBe(false);
  });

  test("a stale FALSE also degrades to unknown, one uniform rule", () => {
    const stale = cacheEntry({
      state: "not-installed",
      resolvedAt: new Date(
        NOW.getTime() - CODEX_TRUST_TTL_MS - 1,
      ).toISOString(),
    });
    expect(stampFor(stale).codexControlState).toBe("unknown");
  });

  test("a trust cache written by a different CCC version is discarded", () => {
    // The frozen hook command the resolver matches on can move between releases,
    // so an "armed" written by another version is not evidence about this one.
    expect(stampFor(cacheEntry({ ccc: "0.11.0" })).codexControlState).toBe(
      "unknown",
    );
  });

  test("a trust cache with a future resolvedAt is discarded", () => {
    const skewed = cacheEntry({
      resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(stampFor(skewed).codexControlState).toBe("unknown");
  });

  test("a malformed or unknown state is discarded", () => {
    expect(
      validateCodexTrustCache(
        { ...cacheEntry(), state: "probably-fine" },
        VERSION,
        NOW,
      ),
    ).toBeNull();
    expect(validateCodexTrustCache("not an object", VERSION, NOW)).toBeNull();
    expect(
      validateCodexTrustCache(
        { ...cacheEntry(), resolvedAt: "yesterday" },
        VERSION,
        NOW,
      ),
    ).toBeNull();
  });

  test("an unreadable or absent cache file reads as no answer, and never throws", () => {
    const dir = tmp();
    expect(
      readCodexTrustCache(VERSION, { cachePath: join(dir, "nope.json") }),
    ).toBeNull();
    const junkPath = join(dir, "junk.json");
    writeFileSync(junkPath, "{not json");
    expect(readCodexTrustCache(VERSION, { cachePath: junkPath })).toBeNull();
  });

  test("every resolution is written, including unknown, so resolvedAt keeps moving", () => {
    // "We checked and couldn't tell" has to stay distinguishable from "we never
    // checked" when someone is debugging a machine.
    const cachePath = join(tmp(), "control", "codex-trust.json");
    writeCodexTrustCache(
      { state: "unknown", reason: "codex-missing" },
      VERSION,
      {
        cachePath,
        now: NOW,
      },
    );
    const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(onDisk).toEqual({
      state: "unknown",
      reason: "codex-missing",
      resolvedAt: NOW.toISOString(),
      ccc: VERSION,
    });
    expect(
      readCodexTrustCache(VERSION, { cachePath, now: NOW }),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RULE 1 - an old meter never inflates Codex
// ---------------------------------------------------------------------------

describe("rule 1: old meters never inflate Codex", () => {
  test("a Codex record with no trust answer STILL carries controlStampVersion", () => {
    // Without this, "unknown from a current meter" and "unknown because the meter
    // is old" collapse into the same record, the discriminator rots, and rule 1
    // becomes unenforceable on the server.
    const stamp = stampFor(null);
    const { records } = buildCodexRequestBody(codexLine(), {
      codexControlStamp: stamp,
    });
    const md = codexMeta(records[0]);
    expect(md.controlStampVersion).toBe(CODEX_CONTROL_STAMP_VERSION);
    expect(md.codexControlState).toBe("unknown");
    expect("codexControlArmed" in md).toBe(false);
  });

  test("without the stamp a Codex record carries no stamp keys", () => {
    // A record from 0.11.0 or earlier looks like this, and so does what preview
    // and one-shot send emit. No version key means no claim about Codex at all.
    const { records } = buildCodexRequestBody(codexLine());
    const md = records[0].metadata;
    expect("controlStampVersion" in md).toBe(false);
    expect("codexControlState" in md).toBe(false);
    expect("codexControlArmed" in md).toBe(false);
    expect("controlPolicyAsOf" in md).toBe(false);
  });

  test("an armed Codex record carries the version, the state, and the boolean", () => {
    const dir = tmp();
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({ asOf: "2026-07-30T11:00:00.000Z" }),
    );
    const { records } = buildCodexRequestBody(codexLine(), {
      codexControlStamp: stampFor(cacheEntry(), policyPath),
    });
    const md = codexMeta(records[0]);
    expect(md.controlStampVersion).toBe(CODEX_CONTROL_STAMP_VERSION);
    expect(md.codexControlState).toBe("armed");
    expect(md.codexControlArmed).toBe(true);
    expect(md.controlPolicyAsOf).toBe("2026-07-30T11:00:00.000Z");
  });

  test("the Codex stamp never writes the Claude controlArmed key", () => {
    // controlArmed is the Claude receipt and means only that the Claude hook
    // exists. If the Codex path wrote it, a server filter keyed on controlArmed
    // would count Codex machines as Claude ones.
    for (const state of ["armed", "needs-re-trust", "unknown"] as const) {
      expect("controlArmed" in stampFor(cacheEntry({ state }))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RULE 3 - the stamp never slows the meter down
// ---------------------------------------------------------------------------

describe("rule 3: the Codex answer is never resolved per event", () => {
  const forwarderSource = readFileSync(
    new URL("../src/forwarder.ts", import.meta.url),
    "utf8",
  );

  // processNewLines runs once per poll and loops over every telemetry line in it.
  // Slicing its exact body (brace-matched, not "everything after the watcher
  // starts") is what makes the scan bite. processNewLines lives inside
  // watchAndForward, so a scan of everything after `export function
  // watchAndForward` stays green when a spawn moves INTO the per-line loop, the
  // exact mistake this rule exists to stop.
  function processNewLinesBody(): string {
    const start = forwarderSource.indexOf("async function processNewLines()");
    expect(start).toBeGreaterThan(0);
    let depth = 0;
    let seenOpen = false;
    for (let i = start; i < forwarderSource.length; i += 1) {
      const ch = forwarderSource[i];
      if (ch === "{") {
        depth += 1;
        seenOpen = true;
      } else if (ch === "}") {
        depth -= 1;
        if (seenOpen && depth === 0) return forwarderSource.slice(start, i + 1);
      }
    }
    throw new Error("could not find the end of processNewLines");
  }

  for (const symbol of [
    "resolveCodexControlStatus",
    "resolveCodexTrust",
    "readCodexTrustCache",
    "readCodexTrust",
    "writeCodexTrustCache",
    "writeCodexTrust",
    "resolveCodexControlStamp",
    "refreshCodexStamp",
  ]) {
    test(`${symbol} is never named inside the per-line loop`, () => {
      expect(processNewLinesBody()).not.toContain(symbol);
    });
  }

  test("the stamp the per-line path reads is a plain in-memory lookup", () => {
    // currentCodexControlStamp is the ONE thing processNewLines is allowed to call
    // for this, and its whole body is two clock comparisons against variables.
    expect(processNewLinesBody()).toContain("currentCodexControlStamp()");
    const at = forwarderSource.indexOf("function currentCodexControlStamp()");
    expect(at).toBeGreaterThan(0);
    const body = forwarderSource.slice(at, forwarderSource.indexOf("}", at));
    expect(body).not.toMatch(/read|write|resolve|spawn|exec|Sync\(/);
  });

  test("500 telemetry lines through the watcher spawn Codex ZERO times and read the cache ONCE", async () => {
    // THE test for this rule. Counting stand-ins for all three doors, 500 real
    // Codex lines down the real watcher, and the assertion is the call counts. A
    // string-equality check could never fail for the thing being forbidden here;
    // a call count of 0 can only pass if nothing resolved per line.
    const calls = { resolve: 0, read: 0, write: 0 };
    const cached: CodexTrustCacheEntry = cacheEntry({
      resolvedAt: new Date().toISOString(),
    });
    const deps = {
      resolveStatus: async () => {
        calls.resolve += 1;
        return { state: "armed" } as CodexControlStatus;
      },
      readCache: () => {
        calls.read += 1;
        return cached;
      },
      writeCache: () => {
        calls.write += 1;
        return cached;
      },
    };

    const posted: Array<{ records: UsageRecord[] }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    });

    const dir = tmp();
    const jsonlPath = join(dir, "live.jsonl");
    writeFileSync(
      jsonlPath,
      Array.from({ length: 500 }, () => JSON.stringify(codexLine())).join("\n") +
        "\n",
    );

    const savedKey = process.env.MARGINFRONT_API_KEY;
    process.env.MARGINFRONT_API_KEY = "test-key-rule-three";
    let stop: (() => void) | null = null;
    try {
      stop = watchAndForward(jsonlPath, {
        cursorPath: join(dir, "cursor"),
        codexTrustDeps: deps,
      });
      const deadline = Date.now() + 10_000;
      while (posted.length < 500 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(posted.length).toBe(500);
      // Every record carries the armed stamp, so the stamp really did ride all 500
      // lines - this is not passing because nothing was stamped.
      const armed = posted.filter(
        (b) =>
          (b.records[0].metadata as CodexUsageRecordMetadata)
            .codexControlArmed === true,
      );
      expect(armed.length).toBe(500);

      expect(calls.resolve).toBe(0); // never a subprocess on the hot path
      expect(calls.read).toBe(1); // one warm-up read at boot, and no more
      expect(calls.write).toBe(0);
    } finally {
      if (stop) stop();
      process.env.MARGINFRONT_API_KEY = savedKey;
      vi.unstubAllGlobals();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The TTL binds at STAMP time, not only at refresh time
// ---------------------------------------------------------------------------

describe("an aged-out verdict stops riding records", () => {
  test("the stamp's remaining life shrinks with the verdict's age, and floors at zero", () => {
    const fresh = cacheEntry({ resolvedAt: NOW.toISOString() });
    expect(codexTrustValidForMs(fresh, VERSION, NOW)).toBe(CODEX_TRUST_TTL_MS);

    const halfway = cacheEntry({
      resolvedAt: new Date(NOW.getTime() - CODEX_TRUST_TTL_MS / 2).toISOString(),
    });
    expect(codexTrustValidForMs(halfway, VERSION, NOW)).toBe(
      CODEX_TRUST_TTL_MS / 2,
    );

    // Past the TTL, a version mismatch, a future timestamp, or no answer at all:
    // all of them mean the stamp must already have flipped to unknown.
    const expired = cacheEntry({
      resolvedAt: new Date(NOW.getTime() - CODEX_TRUST_TTL_MS - 1).toISOString(),
    });
    expect(codexTrustValidForMs(expired, VERSION, NOW)).toBe(0);
    expect(codexTrustValidForMs(cacheEntry({ ccc: "0.11.0" }), VERSION, NOW)).toBe(0);
    expect(codexTrustValidForMs(null, VERSION, NOW)).toBe(0);
  });

  test("the daemon expires the stamp on a MONOTONIC deadline, not a wall clock", () => {
    // The failure this pins: the wall clock jumps backwards (NTP correction,
    // restored snapshot), every Date.now() deadline lands hours in the future, the
    // refresh stops running, and the daemon keeps stamping "armed" from a verdict
    // nobody has re-checked. performance.now() cannot be walked backwards.
    const source = readFileSync(
      new URL("../src/forwarder.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("function monotonicNowMs()");
    expect(source).toContain("performance.now()");
    // Both the refresh throttle and the stamp deadline live on it.
    expect(source).toMatch(
      /codexTrustInFlight \|\| monotonicNow\(\) < nextCodexTrustAtMono/,
    );
    expect(source).toMatch(/monotonicNow\(\) < codexStampExpiresAtMono/);
    // Both clocks gate the stamp: monotonic catches a wall clock corrected
    // backwards, wall catches a suspend that monotonic time sleeps through.
    expect(source).toMatch(/wallNow\(\) < codexStampExpiresAtWall/);
    expect(source).not.toMatch(/Date\.now\(\) < nextCodexTrust/);
  });

  test("an armed stamp flips to unknown mid run once its TTL passes", async () => {
    // Same daemon, same armed cache, no refresh in between: only time moves. A
    // stamp frozen at boot would make line 2 here still claim the cap was on.
    let mono = 0;
    const cached: CodexTrustCacheEntry = cacheEntry({
      resolvedAt: new Date().toISOString(),
    });
    const posted: Array<{ records: UsageRecord[] }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    });

    const dir = tmp();
    const jsonlPath = join(dir, "live.jsonl");
    writeFileSync(jsonlPath, JSON.stringify(codexLine()) + "\n");

    const savedKey = process.env.MARGINFRONT_API_KEY;
    process.env.MARGINFRONT_API_KEY = "test-key-ttl";
    let stop: (() => void) | null = null;
    try {
      stop = watchAndForward(jsonlPath, {
        cursorPath: join(dir, "cursor"),
        codexTrustDeps: {
          resolveStatus: async () => ({ state: "armed" }) as CodexControlStatus,
          readCache: () => cached,
          writeCache: () => cached,
          monotonicNow: () => mono,
        },
      });
      const waitFor = async (n: number) => {
        const deadline = Date.now() + 5_000;
        while (posted.length < n && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(posted.length).toBeGreaterThanOrEqual(n);
      };
      await waitFor(1);
      expect(
        (posted[0].records[0].metadata as CodexUsageRecordMetadata)
          .codexControlArmed,
      ).toBe(true);

      // 31 minutes later, with no successful re-check.
      mono += CODEX_TRUST_TTL_MS + 60_000;
      appendFileSync(jsonlPath, JSON.stringify(codexLine()) + "\n");
      await waitFor(2);
      const later = posted[1].records[0]
        .metadata as CodexUsageRecordMetadata;
      expect(later.codexControlState).toBe("unknown");
      expect("codexControlArmed" in later).toBe(false);
      // Still a current meter, so the server can tell this apart from an old one.
      expect(later.controlStampVersion).toBe(CODEX_CONTROL_STAMP_VERSION);
    } finally {
      if (stop) stop();
      process.env.MARGINFRONT_API_KEY = savedKey;
      vi.unstubAllGlobals();
    }
  }, 20_000);

  test("a laptop that slept past the TTL wakes up unknown, not armed", async () => {
    // The sleep hole. On macOS the monotonic source is mach_absolute_time, which
    // does NOT advance while the machine is asleep, so a lid closed at 5pm and
    // opened at 9am has burned about 30 seconds of monotonic time. Guarding the
    // stamp on that clock alone leaves an overnight verdict looking fresh, while a
    // Codex auto-update in the meantime can have reset hook trust. Here the
    // monotonic clock barely moves and only the wall clock jumps.
    let mono = 0;
    // Anchored to the real clock because codexTrustValidForMs ages the cache
    // against Date.now(); a fabricated "now" would look stale before we start.
    let wall = Date.now();
    const cached: CodexTrustCacheEntry = cacheEntry({
      resolvedAt: new Date(wall).toISOString(),
    });
    const posted: Array<{ records: UsageRecord[] }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    });

    const dir = tmp();
    const jsonlPath = join(dir, "live.jsonl");
    writeFileSync(jsonlPath, JSON.stringify(codexLine()) + "\n");

    const savedKey = process.env.MARGINFRONT_API_KEY;
    process.env.MARGINFRONT_API_KEY = "test-key-sleep";
    let stop: (() => void) | null = null;
    try {
      stop = watchAndForward(jsonlPath, {
        cursorPath: join(dir, "cursor"),
        codexTrustDeps: {
          resolveStatus: async () => ({ state: "armed" }) as CodexControlStatus,
          readCache: () => cached,
          writeCache: () => cached,
          monotonicNow: () => mono,
          wallNow: () => wall,
        },
      });
      const waitFor = async (n: number) => {
        const deadline = Date.now() + 5_000;
        while (posted.length < n && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(posted.length).toBeGreaterThanOrEqual(n);
      };
      await waitFor(1);
      expect(
        (posted[0].records[0].metadata as CodexUsageRecordMetadata)
          .codexControlArmed,
      ).toBe(true);

      // Lid closed 30 seconds later, reopened sixteen hours on.
      mono += 30_000;
      wall += 16 * 60 * 60 * 1000;
      appendFileSync(jsonlPath, JSON.stringify(codexLine()) + "\n");
      await waitFor(2);
      const afterWake = posted[1].records[0]
        .metadata as CodexUsageRecordMetadata;
      expect(afterWake.codexControlState).toBe("unknown");
      expect("codexControlArmed" in afterWake).toBe(false);
    } finally {
      if (stop) stop();
      process.env.MARGINFRONT_API_KEY = savedKey;
      vi.unstubAllGlobals();
    }
  }, 20_000);

  test("the daemon asks Codex about a STABLE directory, not wherever it was launched", () => {
    // Codex resolves hooks per working directory. Under launchd the daemon's cwd is
    // "/", from a shell it is whatever repo the developer was standing in - so an
    // answer resolved there means something different on every machine, while the
    // dashboard presents it as one org-wide claim.
    const source = readFileSync(
      new URL("../src/forwarder.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const CODEX_TRUST_SCOPE_CWD = homedir();");
    expect(source).toContain(
      "resolveCodexTrust({ cwd: CODEX_TRUST_SCOPE_CWD })",
    );
  });

  test("resolveCodexControlStatus passes the caller's directory through to Codex", async () => {
    const seen: Array<string | undefined> = [];
    const hooksList = async (opts: { cwd?: string; timeoutMs?: number }) => {
      seen.push(opts.cwd);
      return { ok: true, hooks: [], warnings: [], errors: [] };
    };
    await resolveCodexControlStatus({
      codexInstalled: true,
      configPath: join(tmp(), "no-config.toml"),
      hooksList: hooksList as never,
      cwd: "/var/tmp/some-stable-dir",
    });
    expect(seen).toEqual(["/var/tmp/some-stable-dir"]);

    // Omitted, the human `status` command uses Codex's own default: the
    // directory the human is standing in.
    seen.length = 0;
    await resolveCodexControlStatus({
      codexInstalled: true,
      configPath: join(tmp(), "no-config.toml"),
      hooksList: hooksList as never,
    });
    expect(seen).toEqual([undefined]);
  });
});
