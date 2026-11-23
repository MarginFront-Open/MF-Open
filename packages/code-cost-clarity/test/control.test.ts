// control.test.ts - Spend Control.
//
// WHAT THIS FILE PROVES, and why each test can go red (not trivially green):
//
//   The cap-check SCRIPT (run for real with python3, the interpreter it ships for):
//     - fail-open on missing / corrupt / missing-spent / STALE state (exit 0)
//     - over-cap all+enforce BLOCKS (exit 2 + the stop message), under-cap ALLOWS
//     - a provider-scoped enforce cap does NOT block even when over
//     - cool-off: a trip records a marker and keeps braking under cap until the window rolls
//
//   The SETTINGS-HOOK writer / remover:
//     - writes the exact PreToolUse schema shape Claude Code accepts
//     - merges without clobbering an existing hook; removes ONLY our entry
//
//   syncControlState (daemon pull, injected fetch - never a real network):
//     - materializes only enforce+all caps (track / provider-scoped / other-dev /
//       team excluded); preserves honest-null spend; fails open on a fetch/HTTP error
//
//   resolveControlArmedStamp + periodWindowEndEpoch + the consent paragraph gate.
//
// HOME isolation: every path is an explicit temp path (mkdtemp), never the real
// ~/.claude or ~/.marginfront-ccc.

import { test, expect, describe } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeControlScript,
  writeControlHook,
  removeControlHook,
  syncControlState,
  resolveControlArmedStamp,
  periodWindowEndEpoch,
  controlHookCommand,
  CAP_CHECK_SCRIPT,
} from "../src/control";
import { cmdInit, type InitDeps } from "../src/cli";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// The python cap script and its python3 interpreter are POSIX-only shipping
// artifacts - Windows gets check-cap.mjs instead, proved in windows-cap-hook.test.ts
// on every lane. Running these against whatever python3 happens to be on a Windows
// runner would be testing a file we never install there.
const onPosix = process.platform !== "win32";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-control-"));
}

// Run the materialized cap-check script and return { code, stderr }. execFileSync
// throws on a non-zero exit, so a block (exit 2) arrives as a caught error whose
// .status is the exit code - exactly what we assert on.
function runScript(scriptPath: string): { code: number; stderr: string } {
  try {
    execFileSync("python3", [scriptPath], { encoding: "utf8" });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? "" };
  }
}

// Build a control dir with the script + given policy/spent (+ optional trip) files.
// spentAgeSeconds sets spent.json's mtime into the past (staleness testing).
function setupControlDir(opts: {
  policy?: unknown;
  spent?: unknown;
  trip?: unknown;
  spentAgeSeconds?: number;
  writePolicy?: boolean;
  writeSpent?: boolean;
}): string {
  const dir = tmp();
  const scriptPath = join(dir, "check-cap.py");
  // Pinned to POSIX: this harness runs the file with python3, so it must get the
  // python script whatever host the suite is on.
  writeControlScript(scriptPath, "linux");
  if (opts.writePolicy !== false) {
    writeFileSync(join(dir, "policy.json"), JSON.stringify(opts.policy ?? {}));
  }
  if (opts.writeSpent !== false) {
    const spentPath = join(dir, "spent.json");
    writeFileSync(spentPath, JSON.stringify(opts.spent ?? {}));
    if (opts.spentAgeSeconds) {
      const when = Date.now() / 1000 - opts.spentAgeSeconds;
      utimesSync(spentPath, when, when);
    }
  }
  if (opts.trip !== undefined) {
    writeFileSync(join(dir, "trip.json"), JSON.stringify(opts.trip));
  }
  return dir;
}

// A never-stale window end (far future) so the epoch numbers don't accidentally
// expire a cool-off during the test.
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

function enforceCap(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cap-1",
    scope: "org",
    providerScope: "all",
    mode: "enforce",
    amountUsd: 200,
    period: "week",
    coolOffHours: null,
    ...over,
  };
}

function spentFile(
  orgSpent: number | null,
  over: Record<string, unknown> = {},
) {
  return {
    asOf: new Date().toISOString(),
    byPeriod: {
      week: {
        windowEndEpoch: FAR_FUTURE,
        org: { spentUsd: orgSpent },
        ...over,
      },
    },
  };
}

// A fake fetch that maps a URL-substring to a canned JSON body.
function fakeFetch(
  routes: { match: string; ok?: boolean; status?: number; body: unknown }[],
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no fake route for ${url}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// the cap-check script (run for real)
// ---------------------------------------------------------------------------

describe.runIf(onPosix)("cap-check script: fail-open", () => {
  test("no policy file -> exit 0", () => {
    const dir = setupControlDir({ writePolicy: false, spent: spentFile(999) });
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });

  test("corrupt policy JSON -> exit 0", () => {
    const dir = setupControlDir({ spent: spentFile(999) });
    writeFileSync(join(dir, "policy.json"), "{ not json");
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });

  test("no spent file -> exit 0", () => {
    const dir = setupControlDir({
      policy: { caps: [enforceCap()] },
      writeSpent: false,
    });
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });

  test("STALE spent (older than the freshness window) -> exit 0 even over cap", () => {
    const dir = setupControlDir({
      policy: { caps: [enforceCap()] },
      spent: spentFile(999),
      spentAgeSeconds: 2 * 3600, // 2h old > 1h STALE_SECONDS
    });
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });
});

describe.runIf(onPosix)("cap-check script: enforce all+cap", () => {
  test("over cap -> exit 2 with the stop message contract", () => {
    const dir = setupControlDir({
      policy: { caps: [enforceCap({ amountUsd: 200, period: "week" })] },
      spent: spentFile(250),
    });
    const { code, stderr } = runScript(join(dir, "check-cap.py"));
    expect(code).toBe(2);
    // cap amount + period, admin provenance, raise path, model-refusal distinction.
    expect(stderr).toContain("200");
    expect(stderr).toContain("week");
    expect(stderr).toContain("admin");
    expect(stderr.toLowerCase()).toContain("contact your admin");
    expect(stderr).toContain("not the AI declining");
  });

  test("under cap -> exit 0", () => {
    const dir = setupControlDir({
      policy: { caps: [enforceCap({ amountUsd: 200 })] },
      spent: spentFile(150),
    });
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });

  test("null spend (honest null) -> exit 0 (never a coerced 0 block)", () => {
    const dir = setupControlDir({
      policy: { caps: [enforceCap({ amountUsd: 200 })] },
      spent: spentFile(null),
    });
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });

  test("admin why-note, when present, rides the block message", () => {
    const dir = setupControlDir({
      policy: {
        caps: [enforceCap({ amountUsd: 200, whyNote: "Q3 budget - ask me" })],
      },
      spent: spentFile(300),
    });
    const { code, stderr } = runScript(join(dir, "check-cap.py"));
    expect(code).toBe(2);
    expect(stderr).toContain("Q3 budget - ask me");
  });
});

describe.runIf(onPosix)(
  "cap-check script: provider-scoped never blocks",
  () => {
    test("a provider-scoped enforce cap over its limit -> exit 0", () => {
      const dir = setupControlDir({
        policy: {
          caps: [enforceCap({ providerScope: "anthropic", amountUsd: 200 })],
        },
        spent: spentFile(999),
      });
      expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
    });

    test("a track-mode all cap over its limit -> exit 0", () => {
      const dir = setupControlDir({
        policy: { caps: [enforceCap({ mode: "track", amountUsd: 200 })] },
        spent: spentFile(999),
      });
      expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
    });
  },
);

describe.runIf(onPosix)("cap-check script: cool-off", () => {
  test("a trip writes a marker, and cool-off keeps braking while UNDER cap", () => {
    // First fire: over cap, coolOffHours set -> block + write trip.json.
    const dir = setupControlDir({
      policy: {
        caps: [enforceCap({ amountUsd: 200, coolOffHours: 24 })],
      },
      spent: spentFile(250),
    });
    const first = runScript(join(dir, "check-cap.py"));
    expect(first.code).toBe(2);
    expect(existsSync(join(dir, "trip.json"))).toBe(true);

    // Second fire: spend has dropped BELOW cap, but the cool-off window is still
    // open -> still blocks (the whole point of cool-off).
    writeFileSync(join(dir, "spent.json"), JSON.stringify(spentFile(10)));
    const second = runScript(join(dir, "check-cap.py"));
    expect(second.code).toBe(2);
  });

  test("cool-off lifts once the window has rolled (windowEnd in the past)", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const dir = setupControlDir({
      policy: { caps: [enforceCap({ amountUsd: 200, coolOffHours: 24 })] },
      spent: spentFile(10, { windowEndEpoch: past }),
      trip: {
        "cap-1": {
          trippedAt: Math.floor(Date.now() / 1000) - 3600,
          windowEndEpoch: past,
          coolOffHours: 24,
        },
      },
    });
    // Under cap AND the window has rolled -> nothing to enforce -> exit 0.
    expect(runScript(join(dir, "check-cap.py")).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// settings-hook writer / remover
// ---------------------------------------------------------------------------

describe("writeControlHook", () => {
  test("writes the PreToolUse schema shape Claude Code accepts", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    const ownershipPath = join(dir, "owned.json");
    const scriptPath = join(dir, "check-cap.py");
    const res = writeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    expect(res.action).toBe("added");

    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    const entry = parsed.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("*");
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toBe(controlHookCommand(scriptPath));
    // ownership receipt records the exact command for a surgical uninstall.
    const owned = JSON.parse(readFileSync(ownershipPath, "utf8"));
    expect(owned.command).toBe(controlHookCommand(scriptPath));
  });

  test("merges without clobbering an existing PreToolUse hook", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { EXISTING: "1" },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo hi" }],
            },
          ],
        },
      }),
    );
    writeControlHook({
      settingsPath,
      ownershipPath: join(dir, "owned.json"),
      scriptPath: join(dir, "check-cap.py"),
      log: () => {},
    });
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.env.EXISTING).toBe("1"); // untouched
    expect(parsed.hooks.PreToolUse).toHaveLength(2); // theirs + ours
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("echo hi");
  });

  test("idempotent: a second write is a no-op (already-present)", () => {
    const dir = tmp();
    const args = {
      settingsPath: join(dir, "settings.json"),
      ownershipPath: join(dir, "owned.json"),
      scriptPath: join(dir, "check-cap.py"),
      log: () => {},
    };
    writeControlHook(args);
    const res2 = writeControlHook(args);
    expect(res2.action).toBe("already-present");
    const parsed = JSON.parse(readFileSync(args.settingsPath, "utf8"));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  test("refuses to overwrite a settings file it can't parse (throws + backs up)", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{ not json");
    expect(() =>
      writeControlHook({
        settingsPath,
        ownershipPath: join(dir, "owned.json"),
        scriptPath: join(dir, "check-cap.py"),
        log: () => {},
      }),
    ).toThrow();
    expect(existsSync(`${settingsPath}.ccc-bak`)).toBe(true);
  });
});

describe("removeControlHook", () => {
  test("removes ONLY our entry + the script + the receipt, leaving other hooks", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    const ownershipPath = join(dir, "owned.json");
    const scriptPath = join(dir, "check-cap.py");
    // Seed a user's own hook, then add ours.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo hi" }],
            },
          ],
        },
      }),
    );
    writeControlScript(scriptPath);
    writeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });

    const res = removeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    expect(res.action).toBe("removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("echo hi");
    expect(existsSync(scriptPath)).toBe(false);
    expect(existsSync(ownershipPath)).toBe(false);
  });

  test("deletes the file when ours was the only hook and nothing else was in it", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    const ownershipPath = join(dir, "owned.json");
    const scriptPath = join(dir, "check-cap.py");
    writeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    const res = removeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    expect(res.action).toBe("removed");
    expect(res.backupPath).toBeNull();
    // A file we created and then emptied is not left behind as `{}`; that shape
    // makes a Codex-only machine read as a Claude Code install.
    expect(existsSync(settingsPath)).toBe(false);
    // The temp dir is not a ~/.claude, so it stays.
    expect(existsSync(dir)).toBe(true);
  });

  test("prunes an empty hooks block but keeps the file when the user's settings remain", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    const ownershipPath = join(dir, "owned.json");
    const scriptPath = join(dir, "check-cap.py");
    writeFileSync(settingsPath, JSON.stringify({ model: "claude-opus-4" }));
    writeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    removeControlHook({
      settingsPath,
      ownershipPath,
      scriptPath,
      log: () => {},
    });
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.model).toBe("claude-opus-4");
  });

  test("soft no-op when Control was never armed (no settings file)", () => {
    const dir = tmp();
    const res = removeControlHook({
      settingsPath: join(dir, "settings.json"),
      ownershipPath: join(dir, "owned.json"),
      scriptPath: join(dir, "check-cap.py"),
      log: () => {},
    });
    expect(res.action).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// syncControlState (daemon pull; injected fetch)
// ---------------------------------------------------------------------------

describe("syncControlState", () => {
  function armed(dir: string): string {
    const ownershipPath = join(dir, "owned.json");
    writeFileSync(ownershipPath, JSON.stringify({ command: "x" }));
    return ownershipPath;
  }

  test("materializes only enforce+all caps for this dev/org; excludes the rest", async () => {
    const dir = tmp();
    const ownershipPath = armed(dir);
    const policyPath = join(dir, "policy.json");
    const spentPath = join(dir, "spent.json");
    const caps = [
      {
        id: "org",
        scope: "org",
        scopeValue: null,
        providerScope: "all",
        mode: "enforce",
        amountUsd: 500,
        period: "week",
        coolOffHours: null,
      },
      {
        id: "me",
        scope: "dev",
        scopeValue: "dev@x.example",
        providerScope: "all",
        mode: "enforce",
        amountUsd: 100,
        period: "week",
        coolOffHours: 12,
      },
      {
        id: "track",
        scope: "org",
        scopeValue: null,
        providerScope: "all",
        mode: "track",
        amountUsd: 500,
        period: "week",
        coolOffHours: null,
      },
      {
        id: "prov",
        scope: "org",
        scopeValue: null,
        providerScope: "anthropic",
        mode: "enforce",
        amountUsd: 500,
        period: "week",
        coolOffHours: null,
      },
      {
        id: "other",
        scope: "dev",
        scopeValue: "someone@else.example",
        providerScope: "all",
        mode: "enforce",
        amountUsd: 50,
        period: "week",
        coolOffHours: null,
      },
      {
        id: "team",
        scope: "team",
        scopeValue: "eng",
        providerScope: "all",
        mode: "enforce",
        amountUsd: 999,
        period: "week",
        coolOffHours: null,
      },
    ];
    const res = await syncControlState({
      apiKey: "mf_sk_x",
      serverUrl: "https://billing.example.com/v1",
      devEmail: "dev@x.example",
      ownershipPath,
      policyPath,
      spentPath,
      fetchImpl: fakeFetch([
        { match: "/caps", body: caps },
        {
          match: "/spend",
          body: {
            period: "week",
            asOf: "2026-07-21T00:00:00.000Z",
            org: { spentUsd: 42 },
            dev: { customerExternalId: "dev@x.example", spentUsd: 7 },
          },
        },
      ]),
    });
    expect(res.synced).toBe(true);
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const ids = policy.caps.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual(["me", "org"]); // track / provider / other-dev / team excluded
    const spent = JSON.parse(readFileSync(spentPath, "utf8"));
    expect(spent.byPeriod.week.org.spentUsd).toBe(42);
    expect(spent.byPeriod.week.dev.spentUsd).toBe(7);
  });

  test("preserves honest-null spend (server null -> stored null)", async () => {
    const dir = tmp();
    const ownershipPath = armed(dir);
    const spentPath = join(dir, "spent.json");
    await syncControlState({
      apiKey: "mf_sk_x",
      serverUrl: "https://billing.example.com/v1",
      ownershipPath,
      policyPath: join(dir, "policy.json"),
      spentPath,
      fetchImpl: fakeFetch([
        { match: "/caps", body: [enforceCap()] },
        {
          match: "/spend",
          body: {
            period: "week",
            asOf: "x",
            org: { spentUsd: null },
            dev: null,
          },
        },
      ]),
    });
    const spent = JSON.parse(readFileSync(spentPath, "utf8"));
    expect(spent.byPeriod.week.org.spentUsd).toBeNull();
  });

  test("not armed -> no-op, no fetch", async () => {
    const dir = tmp();
    let called = false;
    const res = await syncControlState({
      apiKey: "mf_sk_x",
      serverUrl: "https://billing.example.com/v1",
      ownershipPath: join(dir, "missing.json"),
      policyPath: join(dir, "policy.json"),
      spentPath: join(dir, "spent.json"),
      fetchImpl: (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => [] } as never;
      }) as unknown as typeof fetch,
    });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe("not-armed");
    expect(called).toBe(false);
  });

  test("fetch error -> fails open (synced:false), leaves any prior policy untouched", async () => {
    const dir = tmp();
    const ownershipPath = armed(dir);
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ sentinel: true }));
    const res = await syncControlState({
      apiKey: "mf_sk_x",
      serverUrl: "https://billing.example.com/v1",
      ownershipPath,
      policyPath,
      spentPath: join(dir, "spent.json"),
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe("network");
    // last-good policy is still there (not wiped by a failed sync).
    expect(JSON.parse(readFileSync(policyPath, "utf8")).sentinel).toBe(true);
  });

  test("HTTP non-ok on caps -> fails open (synced:false)", async () => {
    const dir = tmp();
    const ownershipPath = armed(dir);
    const res = await syncControlState({
      apiKey: "mf_sk_x",
      serverUrl: "https://billing.example.com/v1",
      ownershipPath,
      policyPath: join(dir, "policy.json"),
      spentPath: join(dir, "spent.json"),
      fetchImpl: fakeFetch([
        { match: "/caps", ok: false, status: 503, body: {} },
      ]),
    });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe("http-503");
  });
});

// ---------------------------------------------------------------------------
// armed-status stamp + window math
// ---------------------------------------------------------------------------

describe("resolveControlArmedStamp", () => {
  test("undefined when Control is not armed", () => {
    const dir = tmp();
    expect(
      resolveControlArmedStamp({
        ownershipPath: join(dir, "missing.json"),
        policyPath: join(dir, "policy.json"),
      }),
    ).toBeUndefined();
  });

  test("armed -> stamp carries the policy asOf", () => {
    const dir = tmp();
    const ownershipPath = join(dir, "owned.json");
    const policyPath = join(dir, "policy.json");
    writeFileSync(ownershipPath, JSON.stringify({ command: "x" }));
    writeFileSync(
      policyPath,
      JSON.stringify({ asOf: "2026-07-21T12:00:00.000Z", caps: [] }),
    );
    const stamp = resolveControlArmedStamp({ ownershipPath, policyPath });
    expect(stamp).toEqual({
      controlArmed: true,
      controlPolicyAsOf: "2026-07-21T12:00:00.000Z",
    });
  });

  test("armed but no policy yet -> armed with null asOf", () => {
    const dir = tmp();
    const ownershipPath = join(dir, "owned.json");
    writeFileSync(ownershipPath, JSON.stringify({ command: "x" }));
    const stamp = resolveControlArmedStamp({
      ownershipPath,
      policyPath: join(dir, "policy.json"),
    });
    expect(stamp).toEqual({ controlArmed: true, controlPolicyAsOf: null });
  });
});

describe("periodWindowEndEpoch", () => {
  test("day rolls at the next UTC midnight", () => {
    const now = new Date("2026-07-21T15:00:00.000Z");
    const end = periodWindowEndEpoch("day", now);
    expect(new Date(end * 1000).toISOString()).toBe("2026-07-22T00:00:00.000Z");
  });

  test("week rolls at the next Monday 00:00 UTC (2026-07-21 is a Tuesday)", () => {
    const now = new Date("2026-07-21T15:00:00.000Z");
    const end = periodWindowEndEpoch("week", now);
    expect(new Date(end * 1000).toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });

  test("month rolls at the first of next month UTC", () => {
    const now = new Date("2026-07-21T15:00:00.000Z");
    const end = periodWindowEndEpoch("month", now);
    expect(new Date(end * 1000).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// consent disclosure: the Control paragraph shows ONLY on the --control path
// ---------------------------------------------------------------------------

describe("consent disclosure Control paragraph", () => {
  // Minimal init deps that decline consent (no TTY) so cmdInit prints the
  // disclosure then stops without wiring anything real.
  function disclosureDeps(logs: string[]): InitDeps {
    return {
      ensureConfigFiles: () => {},
      ensureCollectorBinary: () => {},
      stageMeterProgram: () => {},
      writeServerUrl: () => {},
      loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_x" }),
      isTTY: () => false, // no TTY + not --no-prompt => consent defaults to NO
      hasApiKey: () => true,
      claudeInstalled: () => true,
      detectCacheTtl: () => "1h",
      checkKey: async () => ({
        ok: true,
        organizationName: "Test Org",
        keyType: "secret",
      }),
      clearAuthHold: () => {},
      writeCacheTtl: () => {}, // don't touch the real ~/.marginfront-ccc/.env
      log: (m) => logs.push(m),
    };
  }

  test("shown on init --control", async () => {
    const logs: string[] = [];
    await cmdInit(false, true, disclosureDeps(logs));
    const out = logs.join("\n");
    expect(out).toContain("CAN STOP");
    expect(out).toContain("fails OPEN");
  });

  // Consent names BOTH tools and points at the honesty limits.
  // Assert the README pointer exists; test/docs-references.test.ts checks that the
  // README section it names exists, so a dead pointer can't survive a green suite.
  test("the Control paragraph tells the both-tools truth and points at its limits", async () => {
    const logs: string[] = [];
    await cmdInit(false, true, disclosureDeps(logs));
    const out = logs.join("\n");
    // Both tools, one sentence - never "a `claude` tool call" alone.
    expect(out).toContain("Claude Code or Codex tool call");
    // The pointer to where the limits live.
    expect(out).toContain(
      'packages/code-cost-clarity/README.md, "Spend Control"',
    );
    // The undocumented trusted_hash self-grant does NOT ship - it must never be
    // mentioned, let alone offered.
    expect(out).not.toContain("trusted_hash");
  });

  test("the README still carries the honesty limits a reader needs", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    // Tools, not tokens.
    expect(readme).toContain("stops TOOL CALLS, not tokens");
    // Hosted tools stay uncovered.
    expect(readme).toContain("never sees hosted tools");
    // Clean removal covers the Codex entry too.
    expect(readme).toContain(
      "`uninstall` removes the hooks, the Codex entry, and the script completely.",
    );
  });

  test("absent on a plain init (no --control)", async () => {
    const logs: string[] = [];
    await cmdInit(false, false, disclosureDeps(logs));
    const out = logs.join("\n");
    // The enforcement paragraph's unique phrasing never appears without --control.
    expect(out).not.toContain("CAN STOP");
    expect(out).not.toContain("fails OPEN");
  });
});

// A cheap guard that the script constant is what we ship (one file, python3 shebang,
// only exit 2 blocks). Catches an edit that would break fail-open.
describe("CAP_CHECK_SCRIPT invariants", () => {
  test("python3 shebang and a single sys.exit(2) block path", () => {
    expect(CAP_CHECK_SCRIPT.startsWith("#!/usr/bin/env python3")).toBe(true);
    const exit2Count = (CAP_CHECK_SCRIPT.match(/sys\.exit\(2\)/g) ?? []).length;
    expect(exit2Count).toBe(1);
  });
});
