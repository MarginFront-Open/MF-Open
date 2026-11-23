// init-step-feedback.test.ts: init step feedback.
//
// WHAT THIS FILE PROVES:
//
//   ONE STEP, ONE OUTCOME. The wiring step reports what it did BEFORE the Spend
//   Control question is printed, so answering "yes" to Step 4 visibly does
//   something.
//
//   THE CLOSING HEADLINE FOLLOWS THE RUN, NOT THE FLAGS. A run that installed
//   anything asks for the relaunch; only a run that put nothing new on the machine
//   says everything is still in place. Keying off "was a key already saved"
//   would tell a fresh --no-prompt install that nothing had changed.
//
//   NO PLUMBING IN THE COPY. The kept-cache line names the rate, not the env var.
//
//   status counts in English. "last 1 line", not "last 1 lines".

import { test, expect, describe } from "vitest";
import { cmdInit, cmdStatus, type InitDeps, type StatusDeps } from "../src/cli";

const EIGHT_KEYS = Array.from({ length: 8 }, (_, i) => `KEY_${i}`);

interface Wiring {
  claudeChanged: boolean;
  codexAction: "created" | "skipped-existing";
  daemonReloaded: boolean;
  hookAction: "added" | "already-present";
  codexHook: "wired" | "already-wired" | "no-codex";
}

// Every side-effecting dependency injected, so this drives the REAL cmdInit narration
// with no disk, no launchd, no network, and no reach into the runner's HOME.
function initRig(
  wiring: Wiring,
  overrides: Partial<InitDeps> = {},
): { deps: InitDeps; logs: string[]; order: string[] } {
  const logs: string[] = [];
  const order: string[] = [];
  const deps: InitDeps = {
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    isTTY: () => true,
    gitDefaultEmail: () => "alex@example.com",
    promptDeveloperEmail: async () => "alex@example.com",
    writeDeveloperEmail: () => {},
    writeApiKey: () => {},
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    writeCacheTtl: () => {},
    detectCacheTtl: () => null,
    hasApiKey: () => true,
    codexInstalled: () => true,
    claudeInstalled: () => true,
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_saved",
      CCC_CACHE_WRITE_TTL: "1h",
    }),
    promptConsent: async () => {
      order.push("ask-wiring");
      return true;
    },
    // Init ends with one optional finished-work question. This file's
    // subject is not that question, so it answers No and changes nothing.
    promptFinishedWork: async () => false,
    promptControlConsent: async () => {
      order.push("ask-control");
      return true;
    },
    writeClaudeTelemetry: () => {
      order.push("write-claude");
      return {
        written: EIGHT_KEYS,
        skipped: [],
        backupPath: null,
        changed: wiring.claudeChanged,
      };
    },
    writeCodexConfig: () => {
      order.push("write-codex");
      return { action: wiring.codexAction, backupPath: null };
    },
    codexHasCccBlock: () => true,
    installDaemon: () => {
      order.push("install-daemon");
      return { reloaded: wiring.daemonReloaded };
    },
    installControlScript: () => {},
    installControlHook: () => {
      order.push("install-hook");
      return { action: wiring.hookAction, backupPath: null };
    },
    installCodexControlHook: () => {
      order.push("install-codex-hook");
      return wiring.codexHook;
    },
    syncControl: async () => {},
    resolveCodexTrust: async () => ({ state: "needs-re-trust" }),
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    log: (m) => logs.push(m),
    errorLog: () => {},
    ...overrides,
  };
  return { deps, logs, order };
}

const FRESH: Wiring = {
  claudeChanged: true,
  codexAction: "created",
  daemonReloaded: false,
  hookAction: "added",
  codexHook: "wired",
};

const NOTHING_NEW: Wiring = {
  claudeChanged: false,
  codexAction: "skipped-existing",
  daemonReloaded: true,
  hookAction: "already-present",
  codexHook: "already-wired",
};

// ---------------------------------------------------------------------------
// one step, one outcome
// ---------------------------------------------------------------------------

describe("each step reports itself before the next step is asked", () => {
  test("the wiring outcome lands above the Spend Control header, not below it", async () => {
    const rig = initRig(FRESH);
    await cmdInit(false, true, rig.deps);
    const out = rig.logs.join("\n");

    const claudeLine = out.indexOf("Claude Code: usage reporting is on");
    const codexLine = out.indexOf("Codex: reports to the same meter now");
    const meterLine = out.indexOf("Meter: installed and running");
    // The header reads "turn on Spend Control?" on a first run and "keep Spend
    // Control on?" on a re-run, so anchor on the part both share.
    const controlHeader = out.indexOf("Spend Control");
    const capLine = out.indexOf("Cap check installed for Claude Code");

    expect(claudeLine).toBeGreaterThan(-1);
    expect(controlHeader).toBeGreaterThan(-1);
    expect(capLine).toBeGreaterThan(-1);

    // Everything the wiring answer caused reads BEFORE the next question.
    expect(claudeLine).toBeLessThan(controlHeader);
    expect(codexLine).toBeLessThan(controlHeader);
    expect(meterLine).toBeLessThan(controlHeader);
    // And everything the Control answer caused reads after it.
    expect(capLine).toBeGreaterThan(controlHeader);
  });

  test("the writers actually run before the Control question is asked", async () => {
    const rig = initRig(FRESH);
    await cmdInit(false, true, rig.deps);

    expect(rig.order).toEqual([
      "ask-wiring",
      "write-claude",
      "write-codex",
      "install-daemon",
      "ask-control",
      "install-hook",
      "install-codex-hook",
    ]);
  });

  test("declining Spend Control still leaves the wiring reported and done", async () => {
    const rig = initRig(FRESH, { promptControlConsent: async () => false });
    await cmdInit(false, true, rig.deps);
    const out = rig.logs.join("\n");

    expect(rig.order).toContain("write-claude");
    expect(rig.order).not.toContain("install-hook");
    expect(out).toContain("Claude Code: usage reporting is on");
  });

  test("a run with no Control step is unchanged: outcome right after the answer", async () => {
    const rig = initRig(FRESH);
    await cmdInit(false, false, rig.deps);
    const out = rig.logs.join("\n");

    expect(out).toContain("Claude Code: usage reporting is on");
    expect(out).not.toContain("Spend Control");
  });
});

// ---------------------------------------------------------------------------
// the closing headline
// ---------------------------------------------------------------------------

// These pin the exact headline, and its desktop half is macOS-only, so they declare
// darwin rather than inheriting the host. What they are actually asserting is which
// TOOLS the line names; the seam keeps them passing on any host.
describe("SETUP COMPLETE says what this run actually did", () => {
  test("saved key and pricing, but a fresh install: it asks for the relaunch", async () => {
    // The --no-prompt case: nothing was asked, everything was installed, so the
    // headline must not say it was all already in place.
    const rig = initRig(FRESH, {
      isTTY: () => false,
      platform: () => "darwin",
    });
    await cmdInit(true, true, rig.deps);

    expect(rig.logs.join("\n")).toContain(
      "SETUP COMPLETE. Quit and reopen Claude and Codex (desktop apps too) so counting starts.",
    );
  });

  test("nothing new on the machine: it says everything is still in place", async () => {
    const rig = initRig(NOTHING_NEW);
    await cmdInit(false, true, rig.deps);

    expect(rig.logs.join("\n")).toContain(
      "SETUP COMPLETE. Everything from before is still in place.",
    );
  });

  test("one newly installed piece is enough to ask for the relaunch", async () => {
    // Everything was already wired EXCEPT the Codex cap check. Codex still has to
    // restart before that hook does anything, so the relaunch line has to print.
    const rig = initRig({ ...NOTHING_NEW, codexHook: "wired" });
    await cmdInit(false, true, rig.deps);

    expect(rig.logs.join("\n")).toContain("SETUP COMPLETE. Quit and reopen");
  });

  test("no Codex on the machine: the relaunch line stays singular", async () => {
    const rig = initRig(
      { ...FRESH, codexHook: "no-codex" },
      { codexInstalled: () => false, platform: () => "darwin" },
    );
    await cmdInit(false, false, rig.deps);

    expect(rig.logs.join("\n")).toContain(
      "SETUP COMPLETE. Quit and reopen Claude (desktop app too) so counting starts.",
    );
  });
});

// ---------------------------------------------------------------------------
// plain English, no plumbing
// ---------------------------------------------------------------------------

test("the kept-cache line names the rate and not the env var", async () => {
  const rig = initRig(NOTHING_NEW);
  await cmdInit(false, true, rig.deps);
  const out = rig.logs.join("\n");

  expect(out).toContain("Kept your saved cache setting: the 1-hour rate.");
  expect(out).not.toContain("CCC_CACHE_WRITE_TTL");
});

// ---------------------------------------------------------------------------
// status counts in English
// ---------------------------------------------------------------------------

function statusRig(outputLines: string[]): {
  deps: StatusDeps;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      queryStatus: () => ({
        loaded: true,
        running: true,
        pid: 12345,
        lastExitCode: 0,
      }),
      hasApiKey: () => true,
      claudeTelemetryOn: () => true,
      codexInstalled: () => false,
      codexCaptureWired: () => false,
      controlIsArmed: () => false,
      codexControlStatus: async () => ({ state: "not-installed" }),
      errorLogMtimeMs: () => null,
      now: () => Date.now(),
      readOutputLog: () => outputLines,
      readErrorLog: () => [],
      log: (m: string) => logs.push(m),
    } as StatusDeps,
  };
}

describe("the log tail counts its own lines correctly", () => {
  test("one line is a line", async () => {
    const rig = statusRig(["[12:01:07] recorded developer@example.com"]);
    await cmdStatus(rig.deps);

    expect(rig.logs.join("\n")).toContain("(last 1 line of ");
    expect(rig.logs.join("\n")).not.toContain("last 1 lines");
  });

  test("two lines are lines", async () => {
    const rig = statusRig(["first", "second"]);
    await cmdStatus(rig.deps);

    expect(rig.logs.join("\n")).toContain("(last 2 lines of ");
  });
});
