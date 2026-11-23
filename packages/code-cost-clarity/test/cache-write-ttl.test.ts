// cache-write-ttl.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, end to end on the device side:
//   1. detectCacheWriteTtl reads BOTH env sources (process env + the
//      ~/.claude/settings.json "env" block) in the vendor-documented order:
//      FORCE_PROMPT_CACHING_5M wins over ENABLE_PROMPT_CACHING_1H, across
//      sources. Malformed settings never throw and never leak contents.
//   2. cmdInit's detect-or-ask flow: a saved answer is never re-asked,
//      detection persists without a question, the one question maps
//      1->1h / 2->5m / everything-else->1h, and no-TTY leaves it unset.
//   3. writeCacheWriteTtlToEnv persists into ~/.marginfront-ccc/.env (temp
//      path here) exactly like the developer-email writer: in place, 0600,
//      append-if-missing, everything else byte-identical.
//   4. The forwarder stamps metadata.cacheWriteTtl on CLAUDE records only
//      when the option is set - an unstamped record carries no
//      cacheWriteTtl key, and Codex records never carry the stamp.
// All disk I/O uses mkdtemp paths; nothing touches the real ~/.claude,
// ~/.marginfront-ccc, or process.env.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { expectOwnerOnly } from "./helpers/owner-only";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCacheWriteTtl,
  renderEnvFile,
  writeCacheWriteTtlToEnv,
} from "../src/connector";
import {
  buildCodexRequestBody,
  buildMarginFrontRequestBody,
  resolveCacheWriteTtl,
} from "../src/forwarder";
import { cmdInit, type InitDeps } from "../src/cli";
import type {
  CacheWriteTtl,
  OtlpDataPoint,
  OtlpLogAttribute,
  OtlpLogRecord,
  ParsedOtlp,
} from "../src/types";

// --- tiny fixture builders (same shapes as forwarder.test.ts) ---------------

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function tokenPoint(type: string, count: number): OtlpDataPoint {
  return {
    attributes: [
      attr("user.email", "developer@example.com"),
      attr("model", "claude-opus-4-8"),
      attr("session.id", "session-1"),
      attr("type", type),
    ],
    asDouble: count,
  };
}

function claudeTurn(): ParsedOtlp {
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
                    tokenPoint("input", 100),
                    tokenPoint("output", 50),
                    tokenPoint("cacheRead", 1000),
                    tokenPoint("cacheCreation", 200),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function logStrAttr(key: string, value: string): OtlpLogAttribute {
  return { key, value: { stringValue: value } };
}

function codexTurn(): ParsedOtlp {
  const record: OtlpLogRecord = {
    attributes: [
      logStrAttr("event.name", "codex.sse_event"),
      logStrAttr("user.email", "developer@example.com"),
      logStrAttr("model", "gpt-5.2-codex"),
      { key: "input_token_count", value: { intValue: "1000" } },
      { key: "output_token_count", value: { intValue: "500" } },
    ],
  };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }] };
}

// A temp stand-in for ~/.claude/settings.json with the given env block.
function settingsFileWith(envBlock: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-ttl-settings-"));
  const path = join(dir, "settings.json");
  if (envBlock !== null) {
    writeFileSync(path, JSON.stringify({ env: envBlock }));
  }
  return path;
}

const NO_SETTINGS = settingsFileWith(null); // path exists, file doesn't

// --- 1. detection -----------------------------------------------------------

describe("detectCacheWriteTtl", () => {
  test("FORCE_PROMPT_CACHING_5M in the process env -> 5m", () => {
    expect(
      detectCacheWriteTtl({ FORCE_PROMPT_CACHING_5M: "1" }, NO_SETTINGS),
    ).toBe("5m");
    expect(
      detectCacheWriteTtl({ FORCE_PROMPT_CACHING_5M: "true" }, NO_SETTINGS),
    ).toBe("5m");
  });

  test("ENABLE_PROMPT_CACHING_1H in the process env -> 1h", () => {
    expect(
      detectCacheWriteTtl({ ENABLE_PROMPT_CACHING_1H: "1" }, NO_SETTINGS),
    ).toBe("1h");
  });

  test("FORCE wins over ENABLE when both are set (vendor-documented override)", () => {
    expect(
      detectCacheWriteTtl(
        { FORCE_PROMPT_CACHING_5M: "1", ENABLE_PROMPT_CACHING_1H: "1" },
        NO_SETTINGS,
      ),
    ).toBe("5m");
  });

  test("settings.json env block alone is detected (string and JSON-boolean values)", () => {
    expect(
      detectCacheWriteTtl(
        {},
        settingsFileWith({ FORCE_PROMPT_CACHING_5M: "1" }),
      ),
    ).toBe("5m");
    expect(
      detectCacheWriteTtl(
        {},
        settingsFileWith({ ENABLE_PROMPT_CACHING_1H: true }),
      ),
    ).toBe("1h");
  });

  test("FORCE wins ACROSS sources: ENABLE in the shell, FORCE in settings.json -> 5m", () => {
    expect(
      detectCacheWriteTtl(
        { ENABLE_PROMPT_CACHING_1H: "1" },
        settingsFileWith({ FORCE_PROMPT_CACHING_5M: "1" }),
      ),
    ).toBe("5m");
  });

  test('only explicit truthy values count as set - "0"/"false"/"" do not detect', () => {
    expect(
      detectCacheWriteTtl(
        { FORCE_PROMPT_CACHING_5M: "0", ENABLE_PROMPT_CACHING_1H: "false" },
        settingsFileWith({ ENABLE_PROMPT_CACHING_1H: "" }),
      ),
    ).toBe(null);
  });

  test("nothing set anywhere -> null (ambiguous: init asks the question)", () => {
    expect(detectCacheWriteTtl({}, NO_SETTINGS)).toBe(null);
    expect(detectCacheWriteTtl({}, settingsFileWith({}))).toBe(null);
  });

  test("a malformed settings.json is treated as empty - no throw, env still wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-ttl-bad-"));
    const badPath = join(dir, "settings.json");
    writeFileSync(badPath, "{ this is not json");
    expect(detectCacheWriteTtl({}, badPath)).toBe(null);
    expect(
      detectCacheWriteTtl({ ENABLE_PROMPT_CACHING_1H: "1" }, badPath),
    ).toBe("1h");
  });
});

// --- 2. the init detect-or-ask flow ----------------------------------------

// Minimal fully-injected InitDeps: nothing real runs. Interactive tests DECLINE
// consent so cmdInit returns right after the TTL step; the --no-prompt path
// auto-consents and continues through the wiring, so every post-consent dep
// (settings write, codex config, daemon install, zshrc cleanup) is stubbed
// too, so no test reaches a real service manager or reinstalls the machine's
// own daemon.
function ttlInitDeps(opts: {
  savedTtl?: string;
  detected?: CacheWriteTtl | null;
  answer?: string;
  isTTY?: boolean;
}) {
  const written: CacheWriteTtl[] = [];
  let asked = 0;
  let detectCalls = 0;
  let installs = 0;
  const logs: string[] = [];
  const deps: InitDeps = {
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_saved",
      ...(opts.savedTtl ? { CCC_CACHE_WRITE_TTL: opts.savedTtl } : {}),
    }),
    isTTY: () => opts.isTTY ?? true,
    hasApiKey: () => true,
    claudeInstalled: () => true,
    promptSecret: async () => "",
    writeApiKey: () => {},
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    gitDefaultEmail: () => "",
    promptDeveloperEmail: async () => "",
    writeDeveloperEmail: () => {},
    detectCacheTtl: () => {
      detectCalls += 1;
      return opts.detected ?? null;
    },
    promptCacheTtl: async () => {
      asked += 1;
      return opts.answer ?? "";
    },
    writeCacheTtl: (value) => {
      written.push(value);
    },
    promptConsent: async () => false,
    writeClaudeTelemetry: () => ({
      written: [],
      skipped: [],
      backupPath: null,
    }),
    writeCodexConfig: () => ({ action: "created", backupPath: null }),
    codexHasCccBlock: () => true,
    installDaemon: () => {
      installs += 1;
    },
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    promptRemoveZshrc: async () => false,
    removeZshrcLines: () => {},
    log: (m) => logs.push(m),
  };
  return {
    deps,
    written,
    logs,
    askedCount: () => asked,
    detectCount: () => detectCalls,
    installCount: () => installs,
  };
}

describe("cmdInit cache-TTL step", () => {
  test("a saved CCC_CACHE_WRITE_TTL is kept: no detection, no question, no write", async () => {
    const rig = ttlInitDeps({ savedTtl: "5m" });
    await cmdInit(false, false, rig.deps);
    expect(rig.detectCount()).toBe(0);
    expect(rig.askedCount()).toBe(0);
    expect(rig.written).toEqual([]);
    // It still says WHICH rate it kept, in the words the README uses.
    expect(rig.logs.join("\n")).toContain(
      "Kept your saved cache setting: the 5-minute rate.",
    );
    // And it hands back no env-var name. That is our plumbing, not the reader's.
    expect(rig.logs.join("\n")).not.toContain("CCC_CACHE_WRITE_TTL");
  });

  test("detection short-circuits the question: 5m detected -> written, never asked", async () => {
    const rig = ttlInitDeps({ detected: "5m" });
    await cmdInit(false, false, rig.deps);
    expect(rig.written).toEqual(["5m"]);
    expect(rig.askedCount()).toBe(0);
    expect(rig.logs.join("\n")).toContain("FORCE_PROMPT_CACHING_5M");
  });

  test("detection short-circuits the question: 1h detected -> written, never asked", async () => {
    const rig = ttlInitDeps({ detected: "1h" });
    await cmdInit(false, false, rig.deps);
    expect(rig.written).toEqual(["1h"]);
    expect(rig.askedCount()).toBe(0);
    expect(rig.logs.join("\n")).toContain("ENABLE_PROMPT_CACHING_1H");
  });

  test("detection persists even under --no-prompt (it is not a question)", async () => {
    const rig = ttlInitDeps({ detected: "5m", isTTY: false });
    await cmdInit(true, false, rig.deps);
    expect(rig.written).toEqual(["5m"]);
    expect(rig.askedCount()).toBe(0);
    // --no-prompt auto-consents and runs the full wiring: prove it reached the
    // STUBBED daemon install, never a real one.
    expect(rig.installCount()).toBe(1);
  });

  test.each([
    ["1", "1h"], // Claude subscription
    ["2", "5m"], // API key / Bedrock / Vertex
    ["3", "1h"], // not sure -> ceiling
    ["", "1h"], // bare Enter -> ceiling
    ["banana", "1h"], // typo -> ceiling, never under-count
  ])('ambiguous + TTY: answer "%s" persists %s', async (answer, expected) => {
    const rig = ttlInitDeps({ detected: null, answer });
    await cmdInit(false, false, rig.deps);
    expect(rig.askedCount()).toBe(1);
    expect(rig.written).toEqual([expected]);
  });

  test("ambiguous + NO TTY: nothing persisted (server keeps the 1h ceiling)", async () => {
    const rig = ttlInitDeps({ detected: null, isTTY: false });
    await cmdInit(false, false, rig.deps);
    expect(rig.askedCount()).toBe(0);
    expect(rig.written).toEqual([]);
  });
});

// --- 3. persistence ---------------------------------------------------------

describe("writeCacheWriteTtlToEnv", () => {
  test("no .env yet: creates one from the template with the value filled in, mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-ttl-env-"));
    const envPath = join(dir, ".env");
    writeCacheWriteTtlToEnv("5m", envPath);
    const content = readFileSync(envPath, "utf8");
    expect(content).toMatch(/^CCC_CACHE_WRITE_TTL=5m$/m);
    // Template intact around it (it's a real settings file, not a fragment).
    expect(content).toContain("MARGINFRONT_API_KEY=");
    expectOwnerOnly(envPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("existing .env: replaces the line in place, everything else byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-ttl-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "# my notes\nMARGINFRONT_API_KEY=mf_sk_secret\nCCC_CACHE_WRITE_TTL=\nCCC_DEVELOPER_EMAIL=dev@x.example\n",
    );
    writeCacheWriteTtlToEnv("1h", envPath);
    expect(readFileSync(envPath, "utf8")).toBe(
      "# my notes\nMARGINFRONT_API_KEY=mf_sk_secret\nCCC_CACHE_WRITE_TTL=1h\nCCC_DEVELOPER_EMAIL=dev@x.example\n",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("older .env without the line: appends it, never loses the answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-ttl-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "MARGINFRONT_API_KEY=mf_sk_secret\n");
    writeCacheWriteTtlToEnv("5m", envPath);
    expect(readFileSync(envPath, "utf8")).toBe(
      "MARGINFRONT_API_KEY=mf_sk_secret\nCCC_CACHE_WRITE_TTL=5m\n",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("the .env template ships the (blank) line so init's write is an in-place fill", () => {
    expect(renderEnvFile()).toMatch(/^CCC_CACHE_WRITE_TTL=$/m);
  });
});

// --- 4. env -> option -> metadata stamp -------------------------------------

describe("resolveCacheWriteTtl", () => {
  test("valid values pass through (trimmed, case-folded)", () => {
    expect(resolveCacheWriteTtl({ CCC_CACHE_WRITE_TTL: "5m" })).toBe("5m");
    expect(resolveCacheWriteTtl({ CCC_CACHE_WRITE_TTL: " 1H " })).toBe("1h");
  });

  test("unset, blank, or invalid collapse to undefined (no stamp, ceiling pricing)", () => {
    expect(resolveCacheWriteTtl({})).toBe(undefined);
    expect(resolveCacheWriteTtl({ CCC_CACHE_WRITE_TTL: "" })).toBe(undefined);
    expect(resolveCacheWriteTtl({ CCC_CACHE_WRITE_TTL: "10m" })).toBe(
      undefined,
    );
    expect(resolveCacheWriteTtl({ CCC_CACHE_WRITE_TTL: "yes" })).toBe(
      undefined,
    );
  });
});

describe("metadata stamp", () => {
  test('CLAUDE records carry metadata.cacheWriteTtl when the option is set - "5m" and "1h"', () => {
    for (const ttl of ["5m", "1h"] as const) {
      const { records } = buildMarginFrontRequestBody(claudeTurn(), {
        cacheWriteTtl: ttl,
      });
      expect(records.length).toBe(1);
      expect(records[0].metadata).toMatchObject({ cacheWriteTtl: ttl });
    }
  });

  test("the stamp rides in --fold-cache mode too (metadata is audit ground truth)", () => {
    const { records } = buildMarginFrontRequestBody(claudeTurn(), {
      foldCache: true,
      cacheWriteTtl: "5m",
    });
    expect(records[0].metadata).toMatchObject({ cacheWriteTtl: "5m" });
  });

  test("NO option -> the key is ABSENT and the record is byte-identical to an older meter's", () => {
    const without = buildMarginFrontRequestBody(claudeTurn());
    expect("cacheWriteTtl" in without.records[0].metadata).toBe(false);
    // Passing the option explicitly undefined changes nothing at all.
    const withUndefined = buildMarginFrontRequestBody(claudeTurn(), {
      cacheWriteTtl: undefined,
    });
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(without));
  });

  test("CODEX records never carry the stamp (no Anthropic cache writes)", () => {
    const { records } = buildCodexRequestBody(codexTurn(), {
      cacheWriteTtl: "5m",
    });
    expect(records.length).toBe(1);
    expect("cacheWriteTtl" in records[0].metadata).toBe(false);
  });
});
