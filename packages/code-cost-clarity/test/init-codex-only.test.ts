// init-codex-only.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES (a Codex-only Windows laptop):
//
//   Codex has a presence gate: a Claude-only laptop gets no ~/.codex file it
//   never asked for. Claude Code has the symmetric gate, so a Codex-only machine
//   is never asked "how do you sign in to Claude?", never told init will edit
//   ~/.claude/settings.json, and never gets that file created for a tool that
//   isn't installed.
//
//   The init test is REAL where it matters: a throwaway HOME with .codex and no
//   .claude, a PATH with no claude binary, the real presence check pointed at that
//   HOME, and the REAL Claude settings writer pointed at that HOME. If the gate is
//   dropped, <tempHome>/.claude appears on disk and the first assertion fails.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdStatus, type InitDeps, type StatusDeps } from "../src/cli";
import {
  controlHookCommand,
  isClaudeCodeInstalled,
  writeControlHook,
} from "../src/control";
import {
  writeClaudeTelemetrySettings,
  CCC_COMMAND_INVOCATION,
  CCC_TELEMETRY_VALUES,
} from "../src/connector";

const NOT_DETECTED_ROW = `  Claude Code: not detected on this machine. Install it, then run ${CCC_COMMAND_INVOCATION} init to meter it.`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-codex-only-"));
}

// A machine with Codex and nothing else: ~/.codex exists, ~/.claude does not, and
// PATH holds one empty directory.
function codexOnlyHome(): { home: string; emptyBin: string } {
  const home = tmp();
  mkdirSync(join(home, ".codex"));
  const emptyBin = tmp();
  return { home, emptyBin };
}

// A Codex-only machine where an earlier `init --control` wrote Claude settings: the
// real telemetry writer and the real cap-hook writer, pointed at this HOME, and
// nothing else under ~/.claude. Returns the cap-hook command those writers recorded.
//
// The command comes back out of the receipt the writer just wrote, never rebuilt
// here. Rebuilding it here would pin one platform's form: the writer emits
// "python3 ..." on POSIX and "node ..." on Windows, and a mismatch makes the gate read
// our own hook as a stranger's.
function stageAs015Left(home: string): string {
  const settingsPath = join(home, ".claude", "settings.json");
  writeClaudeTelemetrySettings(CCC_TELEMETRY_VALUES, {
    settingsPath,
    ownershipPath: join(home, ".marginfront-ccc", "claude-owned.json"),
    log: () => {},
  });
  const scriptPath = join(home, ".marginfront-ccc", "control", "check-cap.py");
  const hookReceiptPath = join(
    home,
    ".marginfront-ccc",
    "control-hook-owned.json",
  );
  mkdirSync(join(home, ".marginfront-ccc", "control"), { recursive: true });
  writeControlHook({
    settingsPath,
    ownershipPath: hookReceiptPath,
    scriptPath,
    log: () => {},
  });
  const receipt = JSON.parse(readFileSync(hookReceiptPath, "utf8")) as {
    command?: unknown;
  };
  if (typeof receipt.command !== "string") {
    throw new Error(
      `writeControlHook recorded no command in ${hookReceiptPath}, so this staged ` +
        "machine cannot say what the gate should be comparing against.",
    );
  }
  return receipt.command;
}

interface Probe {
  writeClaudeTelemetry: number;
  writeCodexConfig: number;
  installDaemon: number;
  installControlHook: number;
  installCodexControlHook: number;
  promptCacheTtl: number;
}

function rig(
  home: string,
  emptyBin: string,
  overrides: Partial<InitDeps> = {},
): { deps: InitDeps; probe: Probe; logs: string[] } {
  const logs: string[] = [];
  const probe: Probe = {
    writeClaudeTelemetry: 0,
    writeCodexConfig: 0,
    installDaemon: 0,
    installControlHook: 0,
    installCodexControlHook: 0,
    promptCacheTtl: 0,
  };
  const deps: InitDeps = {
    platform: () => "darwin",
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_saved" }),
    isTTY: () => true,
    hasApiKey: () => true,
    promptSecret: async () => "",
    writeApiKey: () => {},
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    gitDefaultEmail: () => "sam@example.com",
    promptDeveloperEmail: async () => "sam@example.com",
    writeDeveloperEmail: () => {},
    detectCacheTtl: () => null,
    promptCacheTtl: async () => {
      probe.promptCacheTtl += 1;
      return "3";
    },
    writeCacheTtl: () => {},
    promptConsent: async () => true,
    promptControlConsent: async () => true,
    // Init ends with one optional finished-work question. This file's
    // subject is not that question, so it answers No and changes nothing.
    promptFinishedWork: async () => false,
    codexInstalled: () => true,
    claudeInstalled: () =>
      isClaudeCodeInstalled({
        claudeDir: join(home, ".claude"),
        pathEnv: emptyBin,
      }),
    // The REAL writer, pointed at the throwaway home. Nothing here stubs the file
    // system: if init calls this, <home>/.claude/settings.json really appears.
    writeClaudeTelemetry: () => {
      probe.writeClaudeTelemetry += 1;
      return writeClaudeTelemetrySettings(CCC_TELEMETRY_VALUES, {
        settingsPath: join(home, ".claude", "settings.json"),
        ownershipPath: join(home, ".marginfront-ccc", "claude-owned.json"),
        log: () => {},
      });
    },
    writeCodexConfig: () => {
      probe.writeCodexConfig += 1;
      return { action: "created", backupPath: null };
    },
    codexHasCccBlock: () => true,
    installDaemon: () => {
      probe.installDaemon += 1;
      return { reloaded: false };
    },
    installControlScript: () => {},
    installControlHook: () => {
      probe.installControlHook += 1;
      return { action: "added", backupPath: null };
    },
    installCodexControlHook: () => {
      probe.installCodexControlHook += 1;
      return "wired";
    },
    syncControl: async () => {},
    resolveCodexTrust: async () => ({ state: "needs-re-trust" }),
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    log: (m) => logs.push(m),
    errorLog: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, probe, logs };
}

describe("init on a Codex-only machine", () => {
  test("never creates ~/.claude, never asks how you sign in to Claude, and names only the Codex file", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const { deps, probe, logs } = rig(home, emptyBin);

    const code = await cmdInit(false, false, deps);
    const out = logs.join("\n");

    expect(code).toBe(0);
    // The filesystem is the witness: no Claude file for a tool that isn't here.
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(probe.writeClaudeTelemetry).toBe(0);
    // The cache-pricing step is a Claude question. It leaves the plan entirely.
    expect(out).not.toContain("sign in to Claude");
    expect(probe.promptCacheTtl).toBe(0);
    // A saved key is all a Codex-only machine needs, so this already reads as a re-run.
    // Three steps: the developer email, the wiring consent, and
    // the finished-work question. The Claude-only cache question is absent,
    // which is what this assertion guards.
    expect(out).toContain(
      "Your key is already saved, so this run has 3 steps.",
    );
    expect(out).not.toContain("Step 4 of");
    // The consent screen names the file it will touch, and only that one.
    expect(out).not.toContain(join(".claude", "settings.json"));
    expect(out).toContain(join(".codex", "config.toml"));
    // Codex setup runs as it does on any machine with Codex.
    expect(probe.writeCodexConfig).toBe(1);
    expect(probe.installDaemon).toBe(1);
    // The checklist row says what to do about it, in one line.
    expect(out).toContain(NOT_DETECTED_ROW);
    expect(out).toContain(
      "SETUP COMPLETE. Quit and reopen Codex (desktop app too) so counting starts.",
    );
    expect(out).not.toContain("reopen Claude");
  });

  test("--no-prompt: the printed change record names only the Codex file", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const { deps, logs } = rig(home, emptyBin);

    await cmdInit(true, false, deps);
    const out = logs.join("\n");

    expect(out).toContain("Changes I'll make:");
    expect(out).not.toContain(join(".claude", "settings.json"));
    expect(out).toContain(join(".codex", "config.toml"));
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("--control: the Claude cap hook is skipped, the Codex cap hook still arms", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const { deps, probe, logs } = rig(home, emptyBin);

    const code = await cmdInit(false, true, deps);
    const out = logs.join("\n");

    expect(code).toBe(0);
    expect(probe.installControlHook).toBe(0);
    expect(probe.installCodexControlHook).toBe(1);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(out).toContain(NOT_DETECTED_ROW);
    // The Codex trust step is the last thing on screen.
    expect(out).toContain("LAST STEP: turn on the Codex cap check.");
  });

  test("--control with a Codex hooks file it can't edit: the PROBLEM block never claims a Claude cap", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const { deps, probe, logs } = rig(home, emptyBin, {
      installCodexControlHook: () => {
        probe.installCodexControlHook += 1;
        return "skipped";
      },
    });

    await cmdInit(false, true, deps);
    const out = logs.join("\n");

    expect(probe.installControlHook).toBe(0);
    expect(out).toContain("PROBLEM: I couldn't add the Codex cap check");
    // Zero caps are armed on this machine, so the screen must not say one is.
    expect(out).not.toContain("Your Claude Code cap is on and working");
    expect(out).toContain(
      "  Nothing else changed. The meter is still running and still counting Codex.",
    );
  });

  test("--no-prompt names the Codex file as the one global change", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const { deps, logs } = rig(home, emptyBin);

    await cmdInit(true, false, deps);
    const out = logs.join("\n");

    expect(out).toContain(
      "--no-prompt set: proceeding without asking (CI / scripted install). This WILL change ",
    );
    expect(out).toContain(`${join(".codex", "config.toml")} as listed above.`);
    expect(out).not.toContain("Claude/Codex config");
    expect(out).not.toContain(join(".claude", "settings.json"));
  });
});

describe("init on a Codex-only machine an earlier init already wrote to", () => {
  test("the settings.json we created is not taken as proof of Claude Code", async () => {
    const { home, emptyBin } = codexOnlyHome();
    const capHookCommand = stageAs015Left(home);
    const settingsPath = join(home, ".claude", "settings.json");
    const before = readFileSync(settingsPath, "utf8");
    const { deps, probe, logs } = rig(home, emptyBin, {
      claudeInstalled: () =>
        isClaudeCodeInstalled({
          claudeDir: join(home, ".claude"),
          pathEnv: emptyBin,
          capHookCommand,
        }),
    });

    const code = await cmdInit(false, true, deps);
    const out = logs.join("\n");

    expect(code).toBe(0);
    expect(probe.writeClaudeTelemetry).toBe(0);
    expect(probe.installControlHook).toBe(0);
    expect(probe.promptCacheTtl).toBe(0);
    expect(out).not.toContain("sign in to Claude");
    expect(out).not.toContain(join(".claude", "settings.json"));
    expect(out).toContain(NOT_DETECTED_ROW);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });
});

describe("init with neither coding agent on the machine", () => {
  test("saves nothing global, installs the meter, and says so in one line", async () => {
    const home = tmp();
    const emptyBin = tmp();
    const { deps, probe, logs } = rig(home, emptyBin, {
      codexInstalled: () => false,
    });

    const code = await cmdInit(true, false, deps);
    const out = logs.join("\n");

    expect(code).toBe(0);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(probe.writeClaudeTelemetry).toBe(0);
    expect(probe.writeCodexConfig).toBe(0);
    expect(probe.installDaemon).toBe(1);
    expect(out).toContain(
      `  Neither Claude Code nor Codex was found on this machine, so nothing was wired. Install one, then run ${CCC_COMMAND_INVOCATION} init to meter it.`,
    );
    expect(out).toContain(NOT_DETECTED_ROW);
    expect(out).toContain(
      "  Codex:       not found on this machine, nothing to do",
    );
    expect(out).not.toContain("Quit and reopen");
    // The --no-prompt line is the only record a CI log gets. It must agree with the
    // change record one line above it: no coding-agent file changed.
    expect(out).not.toContain("WILL change your global Claude/Codex config");
    expect(out).not.toContain("WILL change");
    expect(out).toMatch(
      /--no-prompt set: proceeding without asking \(CI \/ scripted install\)\. Nothing outside .*\.marginfront-ccc changes on this machine\./,
    );
  });
});

describe("status on a Codex-only machine", () => {
  test("the Claude Code row is one action-bearing line", async () => {
    const logs: string[] = [];
    const deps: StatusDeps = {
      log: (m) => logs.push(m),
      queryStatus: () => ({
        loaded: true,
        running: true,
        pid: 4242,
        lastExitCode: 0,
      }),
      readOutputLog: () => [],
      readErrorLog: () => [],
      hasApiKey: () => true,
      errorLogMtimeMs: () => null,
      now: () => 0,
      claudeInstalled: () => false,
      claudeTelemetryOn: () => false,
      codexInstalled: () => true,
      codexCaptureWired: () => true,
      controlIsArmed: () => false,
      codexControlStatus: async () => ({ state: "not-installed" }),
      authHold: () => null,
      queueDepth: () => 0,
      capsSpentMtimeMs: () => null,
    };

    await cmdStatus(deps);
    const out = logs.join("\n");

    expect(out).toContain(NOT_DETECTED_ROW);
    expect(out).not.toContain("Claude Code: ACTION NEEDED");
    expect(out).toContain("  Codex:       OK. Codex usage is being captured.");
  });
});

describe("isClaudeCodeInstalled", () => {
  test("true when ~/.claude holds what Claude Code creates on first run (projects/)", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    expect(
      isClaudeCodeInstalled({ claudeDir: join(home, ".claude"), pathEnv: "" }),
    ).toBe(true);
  });

  test("true when settings.json carries anything of the user's beside our keys", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-opus-4" }) + "\n",
    );
    expect(
      isClaudeCodeInstalled({ claudeDir: join(home, ".claude"), pathEnv: "" }),
    ).toBe(true);
  });

  test("false when ~/.claude holds only what an earlier init wrote there", () => {
    const home = tmp();
    const capHookCommand = stageAs015Left(home);
    expect(
      isClaudeCodeInstalled({
        claudeDir: join(home, ".claude"),
        pathEnv: "",
        capHookCommand,
      }),
    ).toBe(false);
  });

  test("false when ~/.claude is empty or holds only an empty settings.json", () => {
    const empty = tmp();
    mkdirSync(join(empty, ".claude"));
    expect(
      isClaudeCodeInstalled({ claudeDir: join(empty, ".claude"), pathEnv: "" }),
    ).toBe(false);
    const braces = tmp();
    mkdirSync(join(braces, ".claude"));
    writeFileSync(join(braces, ".claude", "settings.json"), "{}\n");
    expect(
      isClaudeCodeInstalled({
        claudeDir: join(braces, ".claude"),
        pathEnv: "",
      }),
    ).toBe(false);
  });

  test("true when only ~/.claude.json exists beside it", () => {
    const home = tmp();
    writeFileSync(join(home, ".claude.json"), "{}\n");
    expect(
      isClaudeCodeInstalled({ claudeDir: join(home, ".claude"), pathEnv: "" }),
    ).toBe(true);
  });

  // Host platform on purpose: a Windows temp path carries a drive colon, so a forced
  // posix split would shred it. The single-entry PATH is valid on every host.
  test("true when the claude binary is on PATH", () => {
    const binDir = tmp();
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    expect(
      isClaudeCodeInstalled({
        claudeDir: join(tmp(), ".claude"),
        pathEnv: binDir,
      }),
    ).toBe(true);
  });

  for (const fileName of ["claude.cmd", "claude.exe", "claude"]) {
    test(`win32: finds ${fileName} in a ";"-separated PATH`, () => {
      const other = tmp();
      const binDir = tmp();
      writeFileSync(join(binDir, fileName), "");
      expect(
        isClaudeCodeInstalled({
          claudeDir: join(tmp(), ".claude"),
          pathEnv: `${other};${binDir}`,
          platform: "win32",
        }),
      ).toBe(true);
    });
  }

  test("posix wants a bare claude, not claude.cmd", () => {
    const cmdOnly = tmp();
    writeFileSync(join(cmdOnly, "claude.cmd"), "");
    expect(
      isClaudeCodeInstalled({
        claudeDir: join(tmp(), ".claude"),
        pathEnv: cmdOnly,
        platform: "darwin",
      }),
    ).toBe(false);
  });

  test("false when nothing is there", () => {
    expect(
      isClaudeCodeInstalled({
        claudeDir: join(tmp(), ".claude"),
        pathEnv: tmp(),
      }),
    ).toBe(false);
  });

  // Windows spells one file several ways. The hook an earlier init wrote and the receipt
  // the gate reads it back through can disagree on drive-letter case or on which
  // slash separates, and on Windows that is still the same file. Platform is injected
  // so this runs on every host, not only on a Windows CI lane.
  function stageWindowsCapHook(scriptPath: string): string {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: controlHookCommand(scriptPath, "win32"),
                },
              ],
            },
          ],
        },
      }) + "\n",
    );
    return join(home, ".claude");
  }

  test("win32: our own hook spelled with the other slash is still ours", () => {
    const claudeDir = stageWindowsCapHook(
      "C:\\Users\\dev\\.marginfront-ccc\\control\\check-cap.mjs",
    );
    const otherSpelling = controlHookCommand(
      "c:/Users/dev/.marginfront-ccc/control/check-cap.mjs",
      "win32",
    );
    expect(
      isClaudeCodeInstalled({
        claudeDir,
        pathEnv: "",
        platform: "win32",
        capHookCommand: otherSpelling,
      }),
    ).toBe(false);
  });

  test("posix keeps the exact match: two spellings are two files there", () => {
    const claudeDir = stageWindowsCapHook(
      "C:\\Users\\dev\\.marginfront-ccc\\control\\check-cap.mjs",
    );
    const otherSpelling = controlHookCommand(
      "c:/Users/dev/.marginfront-ccc/control/check-cap.mjs",
      "win32",
    );
    expect(
      isClaudeCodeInstalled({
        claudeDir,
        pathEnv: "",
        platform: "darwin",
        capHookCommand: otherSpelling,
      }),
    ).toBe(true);
  });

  test("win32: a hook that is genuinely someone else's still proves Claude Code", () => {
    const claudeDir = stageWindowsCapHook(
      "C:\\Users\\dev\\.marginfront-ccc\\control\\check-cap.mjs",
    );
    expect(
      isClaudeCodeInstalled({
        claudeDir,
        pathEnv: "",
        platform: "win32",
        capHookCommand: controlHookCommand(
          "C:\\Users\\dev\\.marginfront-ccc\\control\\some-other-check.mjs",
          "win32",
        ),
      }),
    ).toBe(true);
  });
});
