// init-uninstall-orchestration.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES (the "init and go" orchestration):
//
//   cmdInit:
//     - The BLOCKING CONSENT gate actually gates the global-config writes:
//         * an explicit "yes"  -> telemetry settings + Codex config are written AND
//           the background daemon is installed, and the "just run claude/codex"
//           outcome is printed.
//         * a "no"             -> NOTHING global is written, the daemon is not
//           installed, and the manual fallback is printed.
//         * non-interactive without --no-prompt (the EOF/piped case) -> default NO,
//           nothing written, the consent prompt is never even asked.
//         * --no-prompt        -> proceeds WITHOUT asking, and still writes/installs.
//     - The disclosure names the exact eight telemetry keys + both config files.
//     - The daemon is NOT installed without a saved key (no keyless crash-loop),
//       but the config IS still wired.
//     - The ~/.zshrc source-line cleanup is OFFERED, not silent: yes -> remove called,
//       no -> remove NOT called.
//
//   cmdUninstall:
//     - Calls EACH reverter (daemon, collector, Claude settings, Codex config) and
//       removes every runtime file; --purge additionally nukes the config dir.
//
// HOW IT'S TESTED HONESTLY: every side-effecting dependency is injected as a spy, so
// we assert the REAL orchestration (which functions ran, in which order, with what
// effect) WITHOUT touching ~/.claude, ~/.codex, ~/.zshrc, launchd, or downloading a
// 360 MB collector. The real writers/reverters themselves are covered by
// connector-settings.test.ts, codex-toml.test.ts, launchd.test.ts, and
// zshrc-migration.test.ts. These assertions fail if a gate or a wiring step is
// dropped - they are not trivially green.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdInit,
  cmdUninstall,
  type InitDeps,
  type UninstallDeps,
} from "../src/cli";
import {
  CCC_OWNED_TELEMETRY_KEYS,
  COLLECTOR_BIN_PATH,
  FORWARDER_PID_PATH,
  LAST_AGENT_PATH,
  FORWARDER_AUTH_HOLD_PATH,
} from "../src/connector";

// ---------------------------------------------------------------------------
// init test rig
// ---------------------------------------------------------------------------

interface InitProbe {
  ensureConfigFiles: number;
  ensureCollectorBinary: number;
  promptConsent: number;
  promptSecret: number;
  writeApiKey: string[];
  // Per-developer attribution (shared coding-agent login).
  promptDeveloperEmail: number;
  writeDeveloperEmail: string[];
  // Cache-write TTL.
  detectCacheTtl: number;
  promptCacheTtl: number;
  writeCacheTtl: string[];
  writeClaudeTelemetry: number;
  writeCodexConfig: number;
  installDaemon: number;
  promptRemoveZshrc: number;
  removeZshrcLines: number;
}

// Builds a "happy default" InitDeps (interactive TTY, a key already saved, consent
// granted, nothing leftover in ~/.zshrc) plus a probe counting every call.
//
// The DYNAMIC ANSWERS (what the pasted key is, what the user answers to the consent
// and zshrc prompts) come in through `answers` - NOT by overriding the prompt
// closures - so the probe's call-counters survive. `overrides` is for the static,
// uncounted pieces (loadEnv / isTTY / hasApiKey / findZshrcLines).
interface InitAnswers {
  pastedKey?: string; // what promptSecret returns (default "" = skipped)
  consent?: boolean; // what promptConsent returns (default true)
  removeZshrc?: boolean; // what promptRemoveZshrc returns (default false)
  // What promptDeveloperEmail returns (default "" = leave blank / auto-detect) and the
  // git email used to pre-fill it (default "" = git missing/unset). Injected so the
  // developer prompt never touches real stdin or a real git in these tests.
  developerEmail?: string;
  gitDefaultEmail?: string;
}
function makeInitDeps(
  overrides: Partial<InitDeps> = {},
  answers: InitAnswers = {},
): {
  deps: InitDeps;
  probe: InitProbe;
  logs: string[];
} {
  const probe: InitProbe = {
    ensureConfigFiles: 0,
    ensureCollectorBinary: 0,
    promptConsent: 0,
    promptSecret: 0,
    writeApiKey: [],
    promptDeveloperEmail: 0,
    writeDeveloperEmail: [],
    detectCacheTtl: 0,
    promptCacheTtl: 0,
    writeCacheTtl: [],
    writeClaudeTelemetry: 0,
    writeCodexConfig: 0,
    installDaemon: 0,
    promptRemoveZshrc: 0,
    removeZshrcLines: 0,
  };
  const logs: string[] = [];

  const deps: InitDeps = {
    ensureConfigFiles: () => {
      probe.ensureConfigFiles += 1;
    },
    ensureCollectorBinary: () => {
      probe.ensureCollectorBinary += 1;
    },
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    // A key is already saved, so the happy path skips the key prompt entirely.
    loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_already_saved" }),
    isTTY: () => true,
    hasApiKey: () => true,
    promptSecret: async () => {
      probe.promptSecret += 1;
      return answers.pastedKey ?? "";
    },
    writeApiKey: (value: string) => {
      probe.writeApiKey.push(value);
    },
    // KEY VALIDATION - inert by default: the server always vouches,
    // so these tests never reach the real network.
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    // Per-developer attribution deps - injected so the developer prompt never reads
    // real stdin or runs a real git. By default it returns "" (leave blank).
    gitDefaultEmail: () => answers.gitDefaultEmail ?? "",
    // If a test pins `developerEmail`, return it (a typed override, or "" for blank).
    // Otherwise simulate "press Enter to accept the pre-filled default" by echoing
    // back the defaultValue the prompt was handed.
    promptDeveloperEmail: async (defaultValue: string) => {
      probe.promptDeveloperEmail += 1;
      return answers.developerEmail ?? defaultValue;
    },
    writeDeveloperEmail: (value: string) => {
      probe.writeDeveloperEmail.push(value);
    },
    // Cache-write TTL deps - injected so init never runs real
    // detection (~/.claude/settings.json), reads real stdin, or writes the
    // real ~/.marginfront-ccc/.env. Default: ambiguous machine, "not sure".
    detectCacheTtl: () => {
      probe.detectCacheTtl += 1;
      return null;
    },
    promptCacheTtl: async () => {
      probe.promptCacheTtl += 1;
      return "3";
    },
    writeCacheTtl: (value: string) => {
      probe.writeCacheTtl.push(value);
    },
    // Init ends with one optional finished-work question. This file's
    // subject is not that question, so it answers No and changes nothing.
    promptFinishedWork: async () => false,
    promptConsent: async () => {
      probe.promptConsent += 1;
      return answers.consent ?? true;
    },
    writeClaudeTelemetry: () => {
      probe.writeClaudeTelemetry += 1;
      return {
        written: [...CCC_OWNED_TELEMETRY_KEYS],
        skipped: [],
        backupPath: null,
      };
    },
    writeCodexConfig: () => {
      probe.writeCodexConfig += 1;
      return { action: "created", backupPath: null };
    },
    codexHasCccBlock: () => true,
    // Codex IS on this rig's machine unless a test says otherwise - pinned so these
    // assertions never depend on whether the developer running them has Codex.
    codexInstalled: () => true,
    claudeInstalled: () => true,
    installDaemon: () => {
      probe.installDaemon += 1;
    },
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    promptRemoveZshrc: async () => {
      probe.promptRemoveZshrc += 1;
      return answers.removeZshrc ?? false;
    },
    removeZshrcLines: () => {
      probe.removeZshrcLines += 1;
    },
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, probe, logs };
}

// --- consent: YES proceeds and writes everything -----------------------------

test("cmdInit (consent yes): writes telemetry + Codex config AND installs the daemon", async () => {
  const { deps, probe, logs } = makeInitDeps();

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  expect(probe.promptConsent).toBe(1); // it actually asked
  expect(probe.writeClaudeTelemetry).toBe(1); // settings.json wired
  expect(probe.writeCodexConfig).toBe(1); // config.toml wired
  expect(probe.installDaemon).toBe(1); // background meter started
  // The run ends on ONE summit - the checklist - and then the final block. A
  // "Done. Just run claude or codex" line must not appear: it reads as the end of the
  // command while more output (and a required action) still follows.
  const joined = logs.join("\n");
  expect(joined).toMatch(/^SETUP COMPLETE\./m);
  expect(joined).toMatch(/ {2}Claude Code: usage reporting on/);
  expect(joined).toContain("NOTHING LEFT TO DO.");
  expect(joined).not.toMatch(/Just run `claude` or `codex`/);
  // Nothing prints after the final block.
  expect(joined.trimEnd().endsWith("status")).toBe(true);
});

// --- a launchd failure is reported, not fatal ---------------------
// It throws for every Linux and WSL user with a key saved, so it must not
// throw out of cmdInit after the telemetry wiring has already landed.

test("cmdInit: a throwing installDaemon still finishes the run and prints the fix", async () => {
  const { deps, logs } = makeInitDeps({
    installDaemon: () => {
      throw new Error(
        "Could not start the background meter (launchctl bootstrap failed).",
      );
    },
  });

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  const joined = logs.join("\n");
  expect(joined).toMatch(/^SETUP COMPLETE\./m);
  expect(joined).toContain("NOTHING LEFT TO DO.");
  // The wiring that DID land is still reported.
  expect(joined).toMatch(/ {2}Claude Code: usage reporting is on/);
  expect(joined).toContain("the background meter didn't install");
  expect(joined).toContain("launchctl bootstrap failed");
  expect(joined).toContain("Your key is saved.");
  expect(joined).toContain("node ~/.marginfront-ccc/cli.js run");
  expect(joined).toContain('packages/code-cost-clarity/README.md, "Platforms"');
  // And it never claims a meter that isn't there.
  expect(joined).not.toContain("Meter: installed and running");
  expect(joined).not.toContain("Meter:       running, starts at login");
});

// --- the closing headline cannot promise Windows desktop metering ---
//
// applyDesktopEnvironment is a no-op on Windows, so "(desktop app too)" there would
// promise counting that never starts. The darwin case is the negative control:
// deleting the phrase outright must not pass.

test("cmdInit: on Windows the SETUP COMPLETE line never mentions the desktop app", async () => {
  const { deps, logs } = makeInitDeps({ platform: () => "win32" });

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  const joined = logs.join("\n");
  expect(joined).toMatch(/^SETUP COMPLETE\./m);
  expect(joined).toMatch(/Quit and reopen Claude/);
  expect(joined).not.toMatch(/desktop app/i);
});

test("cmdInit: on macOS it still says to reopen the desktop app", async () => {
  const { deps, logs } = makeInitDeps({ platform: () => "darwin" });

  await cmdInit(false, false, deps);

  expect(logs.join("\n")).toMatch(/desktop app/i);
});

// --- the disclosure is real: it names the eight keys and both files ----------

// Split in two: the consent SCREEN names the files it will edit and
// points at the README; the README carries the key-by-key list. Both halves are
// asserted here, so the detail can move but it cannot disappear.
test("cmdInit: the consent screen names both config files and points at the full list", async () => {
  const { deps, logs } = makeInitDeps();
  await cmdInit(false, false, deps);
  const joined = logs.join("\n");

  // The screen prints real paths, so it says .claude\settings.json on Windows. The
  // regex pins that both files are NAMED on any host; the join pins that the host's
  // own separator is what actually rendered.
  expect(joined).toMatch(/\.claude[\\/]settings\.json/);
  expect(joined).toMatch(/\.codex[\\/]config\.toml/);
  expect(joined).toContain(join(".claude", "settings.json"));
  expect(joined).toContain(join(".codex", "config.toml"));
  expect(joined).toContain('README, "What init changes"');
  // The undo path stays on screen, next to the question that needs it.
  expect(joined).toMatch(/Undo it all anytime: node .* uninstall/);
});

test("the README carries the key-by-key list the consent screen points at", () => {
  const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
  for (const key of CCC_OWNED_TELEMETRY_KEYS) {
    expect(readme).toContain(key);
  }
  // A representative exact value, so the user sees what's written.
  expect(readme).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318");
  // And that telemetry becomes always-on for every claude session.
  expect(readme).toMatch(/EVERY `claude` session/);
});

// --- consent: NO aborts with NOTHING written ---------------------------------

test("cmdInit (consent no): writes NOTHING global, installs NOTHING, prints the manual fallback", async () => {
  const { deps, probe, logs } = makeInitDeps({}, { consent: false }); // user declines

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  // The gate held: no global writes, no daemon.
  expect(probe.writeClaudeTelemetry).toBe(0);
  expect(probe.writeCodexConfig).toBe(0);
  expect(probe.installDaemon).toBe(0);
  // ...and the user is shown the manual path instead.
  const joined = logs.join("\n");
  expect(joined).toMatch(/did NOT change/);
  expect(joined).toMatch(/source ~\/\.marginfront-ccc\/\.env/);
});

// --- non-interactive without --no-prompt = default NO (the EOF/piped case) ----

test("cmdInit (no TTY, no --no-prompt): defaults to NO, never asks, writes nothing", async () => {
  // Not an interactive terminal (e.g. piped/EOF stdin). The default promptConsent
  // WOULD say yes if called - its call-count proves it is never consulted here.
  const { deps, probe } = makeInitDeps({ isTTY: () => false });

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  // We never prompt a non-TTY for consent...
  expect(probe.promptConsent).toBe(0);
  // ...and with no explicit consent, nothing global is touched.
  expect(probe.writeClaudeTelemetry).toBe(0);
  expect(probe.writeCodexConfig).toBe(0);
  expect(probe.installDaemon).toBe(0);
});

// --- --no-prompt proceeds WITHOUT asking, and still wires + installs ----------

test("cmdInit (--no-prompt): proceeds without asking and still writes + installs", async () => {
  // The default promptConsent would answer "no" here (consent:false). --no-prompt must
  // skip it entirely, so promptConsent is never called yet the wiring still happens.
  const { deps, probe } = makeInitDeps({}, { consent: false });

  const code = await cmdInit(true, false, deps); // noPrompt = true

  expect(code).toBe(0);
  expect(probe.promptConsent).toBe(0); // the consent question was skipped
  expect(probe.writeClaudeTelemetry).toBe(1); // but the wiring still happened
  expect(probe.writeCodexConfig).toBe(1);
  expect(probe.installDaemon).toBe(1);
});

// --- daemon is NOT installed without a key (config still wired) ---------------

test("cmdInit (consent yes, NO key): wires the config but does NOT install a keyless crash-loop daemon", async () => {
  // No saved key, and the user skips the paste (pastedKey ""), and no key ever
  // becomes available - so the daemon must be held back to avoid a crash-loop.
  const { deps, probe, logs } = makeInitDeps(
    {
      loadEnv: () => ({}), // no saved key
      hasApiKey: () => false, // and none becomes available
    },
    { pastedKey: "" }, // user presses Enter at the key prompt
  );

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  // Config IS wired (consent was given)...
  expect(probe.writeClaudeTelemetry).toBe(1);
  expect(probe.writeCodexConfig).toBe(1);
  // ...but the daemon is held back so launchd can't respawn a keyless forwarder forever.
  expect(probe.installDaemon).toBe(0);
  expect(logs.join("\n")).toMatch(/did NOT start the background meter/);
});

// --- the key prompt path: a pasted key is saved, then the daemon starts -------

test("cmdInit: when no key is saved, it prompts, saves the pasted key, and then installs the daemon", async () => {
  // keySaved becomes true after the paste, so the default hasApiKey (=keySaved) is
  // true; we set hasApiKey undefined so the REAL keySaved -> install path is exercised.
  const { deps, probe } = makeInitDeps(
    {
      loadEnv: () => ({}), // nothing saved yet
      hasApiKey: undefined,
    },
    { pastedKey: "mf_sk_pasted_by_user" },
  );

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  expect(probe.promptSecret).toBe(1); // it prompted
  expect(probe.writeApiKey).toEqual(["mf_sk_pasted_by_user"]); // saved exactly what was pasted
  expect(probe.installDaemon).toBe(1); // and with a key now present, the daemon starts
});

// --- migration is OFFERED, not silent ----------------------------------------

test("cmdInit (zshrc line present, user says yes): removes the redundant line", async () => {
  const { deps, probe } = makeInitDeps(
    {
      findZshrcLines: () => ({
        found: true,
        matchedLines: ["source ~/.marginfront-ccc/.env"],
      }),
    },
    { removeZshrc: true }, // user agrees to tidy up
  );

  await cmdInit(false, false, deps);

  expect(probe.promptRemoveZshrc).toBe(1); // it asked first
  expect(probe.removeZshrcLines).toBe(1); // and removed on yes
});

test("cmdInit (zshrc line present, user says no): leaves ~/.zshrc untouched", async () => {
  const { deps, probe, logs } = makeInitDeps(
    {
      findZshrcLines: () => ({
        found: true,
        matchedLines: ["source ~/.marginfront-ccc/.env"],
      }),
    },
    { removeZshrc: false }, // user declines
  );

  await cmdInit(false, false, deps);

  expect(probe.promptRemoveZshrc).toBe(1); // it asked...
  expect(probe.removeZshrcLines).toBe(0); // ...and did NOT remove on no
  expect(logs.join("\n")).toMatch(/Left your ~\/\.zshrc as-is/);
});

// --- per-developer attribution (shared coding-agent login) -------------------

test("cmdInit: asks the developer prompt and writes the accepted git default as CCC_DEVELOPER_EMAIL", async () => {
  // No developerEmail pinned => the rig echoes back the prefilled default, i.e. the
  // user pressed Enter to accept the global git email.
  const { deps, probe } = makeInitDeps(
    {},
    { gitDefaultEmail: "alex@example.com" },
  );

  const code = await cmdInit(false, false, deps);

  expect(code).toBe(0);
  expect(probe.promptDeveloperEmail).toBe(1); // it asked
  // The git-sourced default flowed through and was persisted.
  expect(probe.writeDeveloperEmail).toEqual(["alex@example.com"]);
});

test("cmdInit: a typed developer email overrides the git default and is what gets written", async () => {
  const { deps, probe } = makeInitDeps(
    {},
    {
      gitDefaultEmail: "git@example.com",
      developerEmail: "chosen@example.com",
    },
  );

  await cmdInit(false, false, deps);

  expect(probe.writeDeveloperEmail).toEqual(["chosen@example.com"]);
});

test("cmdInit: a BLANK developer answer writes an empty CCC_DEVELOPER_EMAIL (runtime = unset)", async () => {
  // The user cleared the prefilled default and pressed Enter => "" => auto-detect.
  const { deps, probe } = makeInitDeps(
    {},
    { gitDefaultEmail: "alex@example.com", developerEmail: "" },
  );

  await cmdInit(false, false, deps);

  expect(probe.promptDeveloperEmail).toBe(1);
  expect(probe.writeDeveloperEmail).toEqual([""]); // blank persisted -> treated as unset
});

test("cmdInit (--no-prompt): skips the developer prompt and never writes CCC_DEVELOPER_EMAIL", async () => {
  const { deps, probe } = makeInitDeps(
    {},
    { gitDefaultEmail: "alex@example.com" },
  );

  await cmdInit(true, false, deps); // noPrompt = true (CI / scripted install)

  expect(probe.promptDeveloperEmail).toBe(0); // never asked
  expect(probe.writeDeveloperEmail).toEqual([]); // never wrote -> stays unset
});

test("cmdInit (no TTY): skips the developer prompt", async () => {
  const { deps, probe } = makeInitDeps(
    { isTTY: () => false },
    { gitDefaultEmail: "alex@example.com" },
  );

  await cmdInit(false, false, deps);

  expect(probe.promptDeveloperEmail).toBe(0);
  expect(probe.writeDeveloperEmail).toEqual([]);
});

// ---------------------------------------------------------------------------
// uninstall test rig
// ---------------------------------------------------------------------------

interface UninstallProbe {
  order: string[];
  uninstallDaemon: number;
  stopCollector: number;
  removeClaudeTelemetry: number;
  removeCodexConfig: number;
  removedFiles: string[];
  removeControlHook: number;
  removeCodexControlHook: number;
  removeControlStateDir: number;
  purgeConfigDir: number;
  unsetDesktopEnv: number;
}

function makeUninstallDeps(overrides: Partial<UninstallDeps> = {}): {
  deps: UninstallDeps;
  probe: UninstallProbe;
  logs: string[];
} {
  const probe: UninstallProbe = {
    order: [],
    uninstallDaemon: 0,
    stopCollector: 0,
    removeClaudeTelemetry: 0,
    removeCodexConfig: 0,
    removedFiles: [],
    removeControlHook: 0,
    removeCodexControlHook: 0,
    removeControlStateDir: 0,
    purgeConfigDir: 0,
    unsetDesktopEnv: 0,
  };
  const logs: string[] = [];

  const deps: UninstallDeps = {
    uninstallDaemon: () => {
      probe.uninstallDaemon += 1;
      probe.order.push("uninstallDaemon");
    },
    stopCollector: () => {
      probe.stopCollector += 1;
      probe.order.push("stopCollector");
    },
    removeClaudeTelemetry: () => {
      probe.removeClaudeTelemetry += 1;
      probe.order.push("removeClaudeTelemetry");
      return { removed: [], kept: [], backupPath: null };
    },
    removeCodexConfig: () => {
      probe.removeCodexConfig += 1;
      probe.order.push("removeCodexConfig");
      return { action: "missing", backupPath: null };
    },
    removeRuntimeFile: (path: string) => {
      probe.removedFiles.push(path);
    },
    // The three real-HOME sinks. Left to their defaults, they delete the RUNNER's
    // ~/.marginfront-ccc/control, ~/.codex/hooks.json entry, and cap-check script -
    // those paths come from homedir() at module load, so no temp dir can reach them.
    removeControlHook: () => {
      probe.removeControlHook += 1;
    },
    removeCodexControlHook: () => {
      probe.removeCodexControlHook += 1;
    },
    removeControlStateDir: () => {
      probe.removeControlStateDir += 1;
    },
    purgeConfigDir: () => {
      probe.purgeConfigDir += 1;
    },
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    unsetDesktopEnv: () => {
      probe.unsetDesktopEnv += 1;
      probe.order.push("unsetDesktopEnv");
    },
    // Hermetic forwarder teardown: no live forwarder (so the engine skips signalling
    // and just stops the collector), no real pidfile read, no real waiting. The
    // dedicated test below drives the signalling path with a recorded kill.
    readForwarderPid: () => null,
    sleep: async () => {},
    now: () => 0,
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, probe, logs };
}

test("cmdUninstall: calls each reverter once, removes every runtime file, and does NOT purge without --purge", async () => {
  const { deps, probe } = makeUninstallDeps();

  const code = await cmdUninstall(false, deps);

  expect(code).toBe(0);
  // Every reverter ran exactly once.
  expect(probe.uninstallDaemon).toBe(1);
  expect(probe.stopCollector).toBe(1);
  expect(probe.removeClaudeTelemetry).toBe(1);
  expect(probe.removeCodexConfig).toBe(1);
  expect(probe.unsetDesktopEnv).toBe(1);

  // The daemon is removed FIRST (so it can't respawn the forwarder mid-teardown),
  // then the collector, then the config reverters, then the desktop GUI-env clear.
  expect(probe.order).toEqual([
    "uninstallDaemon",
    "stopCollector",
    "removeClaudeTelemetry",
    "removeCodexConfig",
    "unsetDesktopEnv",
  ]);

  // All ten runtime files were targeted for removal (incl. the collector binary,
  // the single-instance pidfile, the auth-hold marker, and the last-agent note) -
  // proof the cleanup list is wired through.
  expect(probe.removedFiles.length).toBe(10);
  expect(probe.removedFiles).toContain(COLLECTOR_BIN_PATH);
  expect(probe.removedFiles).toContain(FORWARDER_PID_PATH);
  expect(probe.removedFiles).toContain(FORWARDER_AUTH_HOLD_PATH);
  // Left behind it outlives the assistant it names: uninstall, drop Codex, reinstall
  // with only Claude Code, and `done` trusts a stale "codex" and picks the wrong column.
  expect(probe.removedFiles).toContain(LAST_AGENT_PATH);

  // Without --purge, the config dir (and the saved key) is kept.
  expect(probe.purgeConfigDir).toBe(0);
});

// Each of these three paths is built from homedir() when the module loads, so a
// test that hands cmdUninstall a temp dir would still delete the runner's real
// ~/.marginfront-ccc/control and cap-check hooks if the teardown skipped its seam.
// This test fails the moment any of them stops going through its seam.
test("cmdUninstall: the Control teardown goes through injectable seams, never a hardcoded home path", async () => {
  const { deps, probe } = makeUninstallDeps();

  await cmdUninstall(false, deps);

  expect(probe.removeControlHook).toBe(1);
  expect(probe.removeCodexControlHook).toBe(1);
  expect(probe.removeControlStateDir).toBe(1);
});

test("cmdUninstall --purge: additionally purges the config dir", async () => {
  const { deps, probe, logs } = makeUninstallDeps();

  await cmdUninstall(true, deps);

  // The reverters still ran...
  expect(probe.removeClaudeTelemetry).toBe(1);
  expect(probe.removeCodexConfig).toBe(1);
  // ...and the config dir was nuked.
  expect(probe.purgeConfigDir).toBe(1);
  expect(logs.join("\n")).toMatch(/Purged/);
});

test("cmdUninstall: reminds about a leftover ~/.zshrc line but never edits it", async () => {
  const { deps, logs } = makeUninstallDeps({
    findZshrcLines: () => ({
      found: true,
      matchedLines: ["source ~/.marginfront-ccc/.env"],
    }),
  });

  await cmdUninstall(false, deps);

  const joined = logs.join("\n");
  // It points at the leftover line (there is no removeZshrc dependency on uninstall,
  // so it structurally cannot edit ~/.zshrc - it can only remind).
  expect(joined).toMatch(/Reminder:/);
  expect(joined).toContain("source ~/.marginfront-ccc/.env");
});

// --- no Codex on the machine means no Codex file ------------------

test("cmdInit: with no Codex on the machine, ~/.codex/config.toml is never written", async () => {
  // darwin declared, not inherited: the assertion below pins the exact headline, whose
  // desktop half is macOS-only. The subject here is Codex, not the platform.
  const { deps, probe, logs } = makeInitDeps({
    codexInstalled: () => false,
    platform: () => "darwin",
  });

  const code = await cmdInit(true, false, deps); // --no-prompt, no --control

  expect(code).toBe(0);
  // The Claude half still wires...
  expect(probe.writeClaudeTelemetry).toBe(1);
  // ...and the Codex writer is never even consulted, so no ~/.codex is created for a
  // tool that isn't installed.
  expect(probe.writeCodexConfig).toBe(0);
  const joined = logs.join("\n");
  expect(joined).toContain(
    "  Codex:       not found on this machine, nothing to do",
  );
  // The relaunch instruction doesn't name a tool that isn't here.
  expect(joined).toContain(
    "SETUP COMPLETE. Quit and reopen Claude (desktop app too)",
  );
  expect(joined).not.toContain("reopen Claude and Codex");
});

test("cmdInit: with Codex present, the Codex config IS written", async () => {
  const { deps, probe } = makeInitDeps({ codexInstalled: () => true });

  await cmdInit(true, false, deps);

  expect(probe.writeCodexConfig).toBe(1);
});

// --- a hook writer that throws does not swallow the rest of the run ---

test("cmdInit --control: a thrown Claude hook write reports the problem, finishes the run, and exits 1", async () => {
  const errors: string[] = [];
  let codexHookCalls = 0;
  const { deps, logs } = makeInitDeps({
    isTTY: () => false,
    findZshrcLines: () => ({
      found: true,
      matchedLines: ["source ~/.marginfront-ccc/.env"],
    }),
    installControlScript: () => {},
    installControlHook: () => {
      throw new Error(
        "Could not update ~/.claude/settings.json.\n" +
          "What happened: your settings file has a hooks.PreToolUse entry that isn't a list, so we stopped instead of overwriting it.\n" +
          "What we did: saved an untouched copy at ~/.claude/settings.json.ccc-bak\n" +
          "Fix: make hooks.PreToolUse a list (or remove it), then run init --control again.",
      );
    },
    installCodexControlHook: () => {
      codexHookCalls += 1;
      return "wired";
    },
    syncControl: async () => {},
    errorLog: (m: string) => errors.push(m),
  });

  // --no-prompt so the run reaches the control step without a keyboard.
  const code = await cmdInit(true, true, deps);

  // It still fails, loudly, for any script watching the exit code.
  expect(code).toBe(1);
  const said = errors.join("\n");
  expect(said).toContain("PROBLEM: I couldn't update");
  expect(said).toContain("hooks.PreToolUse");
  expect(said).toContain("saved an untouched copy at");
  expect(said).toMatch(/Run: node .* init --control/);
  // The writer's own headline and Fix line are not repeated: one headline, one fix.
  expect(said).not.toContain("Could not update ~/.claude/settings.json.");

  // ...and the rest of the run still happens after a throwing writer, instead of
  // the throw killing everything queued behind it.
  expect(codexHookCalls).toBe(0); // no Codex attempt on a broken Claude file
  const joined = logs.join("\n");
  expect(joined).toContain("Left your ~/.zshrc as-is");
  expect(joined).toContain("SETUP COMPLETE, except one problem (above).");
  expect(joined).toContain(
    "  Claude Code: cap check NOT installed (see PROBLEM above)",
  );
  expect(joined).toContain(
    "  Codex:       cap check not attempted, fix the problem first",
  );
});
// ---------------------------------------------------------------------------
// Init RUNS on Windows, and arms a cap that really stops things.
//
// WHY init does not refuse on win32. A cap hook that shells to python3 (the
// Microsoft Store stub on a stock Windows box) or /bin/sh (absent) would report an
// armed cap that stops nothing, because control.ts lets a tool call through whenever
// the check cannot run. Windows gets a node interpreter that actually runs the check,
// so the tests pin the claim that matters: init reaches EVERY step that arms a cap,
// and skips none of them. On the Windows lane this test runs on Windows.
//
// The other half - that a cap armed this way BLOCKS - cannot be proved by a call
// graph, so it is proved by exit code against the real installed command string in
// windows-cap-hook.test.ts and windows-init-arms-a-real-cap.test.ts.
//
// cmdInit does not branch on platform, which is why there is no platform seam to
// inject: the per-OS choice lives in control.ts, where the command string and the
// cap script are chosen.
// ---------------------------------------------------------------------------

function makeArmingInitDeps(): {
  deps: InitDeps;
  probe: InitProbe;
  errors: string[];
  logs: string[];
  reached: string[];
} {
  const reached: string[] = [];
  const errors: string[] = [];

  // The control-path deps are NOT in the base rig, so leaving them unnamed here
  // would let the real cap installers run against the test home.
  const { deps, probe, logs } = makeInitDeps({
    errorLog: (m: string) => errors.push(m),
    installControlScript: () => {
      reached.push("installControlScript");
    },
    installControlHook: () => {
      reached.push("installControlHook");
      return { action: "added", backupPath: null };
    },
    installCodexControlHook: () => {
      reached.push("installCodexControlHook");
      return "wired";
    },
    syncControl: async () => {
      reached.push("syncControl");
    },
    resolveCodexTrust: async () => {
      reached.push("resolveCodexTrust");
      return { state: "armed" };
    },
  });

  return { deps, probe, errors, logs, reached };
}

test("cmdInit --control: arms every part of the cap, and exits 0", async () => {
  const { deps, probe, errors, reached } = makeArmingInitDeps();

  // --no-prompt auto-consents every question, and --control is the flag that arms
  // spend caps.
  const code = await cmdInit(true, true, deps);

  expect(code).toBe(0);
  // The cap script on disk, the Claude hook wired, the Codex hook wired, and the
  // first spend pull so the numbers are real before the meter's next cycle. A cap
  // missing any one of these is a cap that reports itself armed and stops nothing.
  expect(reached).toContain("installControlScript");
  expect(reached).toContain("installControlHook");
  expect(reached).toContain("installCodexControlHook");
  expect(reached).toContain("syncControl");

  // And the ordinary setup still happened around it.
  expect(probe.ensureConfigFiles).toBe(1);
  expect(probe.ensureCollectorBinary).toBe(1);
  expect(probe.writeClaudeTelemetry).toBe(1);

  expect(errors.join("\n")).not.toMatch(/isn't ready yet/);
});

test("cmdInit without --control: sets up the meter and arms no cap", async () => {
  const { deps, probe, reached } = makeArmingInitDeps();

  const code = await cmdInit(true, false, deps);

  expect(code).toBe(0);
  // Spend Control is opt-in. Arming it unasked is the mirror image of failing to arm
  // it when asked.
  expect(reached).toEqual([]);
  expect(probe.ensureConfigFiles).toBe(1);
  expect(probe.writeClaudeTelemetry).toBe(1);
});

test("cli.ts carries no Windows init refusal, reachable or not", () => {
  // WINDOWS_INIT_REFUSAL must stay absent: an unused refusal constant is one line
  // away from being wired up. The WSL guidance belongs in the docs, not in a refusal.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  expect(cli).not.toContain("WINDOWS_INIT_REFUSAL");
  // The refusal's own clause, not its opening sentence, which is generic enough to
  // match unrelated copy.
  expect(cli).not.toContain("so setup stops here");
});
