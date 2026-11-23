// launchd.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the launchd daemon lifecycle generates the
// right .plist, loads/unloads it in the right order, and refuses to install a
// crash-loop-prone daemon when there's no API key.
//
// WHY IT EXISTS: the daemon is what lets the meter survive logout/reboot without a
// second terminal. Three things have to hold or it's worse than useless:
//   1. The plist must point at the REAL node binary (process.execPath), NEVER "npx"
//      - an npx-pointed daemon crash-loops once npm cleans its cache.
//   2. Re-installing must be a clean RELOAD (bootout BEFORE bootstrap), not a
//      double-bootstrap that launchd rejects.
//   3. `start` must refuse without a key, because launchd's KeepAlive would respawn
//      a keyless forwarder forever.
//
// HOW WE TEST IT WITHOUT TOUCHING REAL launchd: every lifecycle call takes an
// injectable launchctl runner. The fake runner records the exact argv of every call,
// so we assert the REAL command sequence. File effects (plist write, cli.js copy,
// removal) run against throwaway temp paths and we assert the ACTUAL bytes/existence.
// Nothing here shells out to launchctl, writes to ~/Library, or touches ~/.claude.
// These assertions fail if the logic is wrong; they are not trivially green.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDaemonPlist,
  installDaemon,
  uninstallDaemon,
  PLIST_LABEL,
  DAEMON_CLI_PATH,
  CONFIG_DIR,
  setDesktopGuiEnv,
  unsetDesktopGuiEnv,
  CCC_TELEMETRY_VALUES,
  CCC_OWNED_TELEMETRY_KEYS,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../src/connector";
import { cmdStart, type StartDeps } from "../src/cli";
import { selectServiceManager } from "../src/service-manager";

// Silence progress logging; we assert on call sequences + files, not log lines.
const QUIET = { log: () => {} };

// A fake launchctl that records every argv it's asked to run. `printStatus` controls
// what `launchctl print ...` reports: 0 = "already loaded", nonzero = "not loaded".
// All other verbs (bootout/bootstrap) succeed unless `bootoutStatus` overrides them.
function makeFakeLaunchctl(opts: {
  printStatus: number;
  bootoutStatus?: number;
}): { calls: string[][]; runLaunchctl: LaunchctlRunner } {
  const calls: string[][] = [];
  // After a bootout, the job is actually GONE - so `print` must start reporting
  // "not loaded" (nonzero). This is what lets installDaemon's wait-for-gone poll
  // terminate; modelling it here keeps the fake faithful to real launchd.
  let bootedOut = false;
  const runLaunchctl: LaunchctlRunner = (args): LaunchctlResult => {
    calls.push(args);
    if (args[0] === "print") {
      const status = bootedOut ? 1 : opts.printStatus;
      return { status, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      bootedOut = true;
      return { status: opts.bootoutStatus ?? 0, stdout: "", stderr: "" };
    }
    // bootstrap, enable, list, print-disabled, setenv, unsetenv: succeed.
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runLaunchctl };
}

// A throwaway temp dir the test owns, pre-seeded with a fake "built cli.js" to copy.
function makeTmp(): {
  dir: string;
  sourceCliPath: string;
  daemonCliPath: string;
  plistPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "ccc-launchd-"));
  const sourceCliPath = join(dir, "src-cli.js");
  // Distinct marker content so we can prove the copy actually happened.
  writeFileSync(sourceCliPath, "// fake built cli.js - DAEMON SOURCE MARKER\n");
  return {
    dir,
    sourceCliPath,
    daemonCliPath: join(dir, "installed-cli.js"),
    plistPath: join(dir, "ai.marginfront.ccc.plist"),
  };
}

const TEST_UID = 501; // a stable fake uid for the "gui/<uid>" domain target

// ---------------------------------------------------------------------------
// 1. renderDaemonPlist: real node binary (NOT npx), RunAtLoad + KeepAlive true,
//    the label, and the CONFIG_DIR cli.js path.
// ---------------------------------------------------------------------------
test("renderDaemonPlist: pins process.execPath (never npx), sets RunAtLoad+KeepAlive, the label, and the stable cli.js path", () => {
  const plist = renderDaemonPlist({
    nodePath: process.execPath,
    cliPath: DAEMON_CLI_PATH,
  });

  // The REAL node binary is baked in as the program...
  expect(plist).toContain(`<string>${process.execPath}</string>`);
  // ...and "npx" is nowhere in it (an npx-pointed daemon would crash-loop).
  expect(plist).not.toContain("npx");
  // The third program argument is the subcommand "run".
  expect(plist).toContain("<string>run</string>");

  // RunAtLoad and KeepAlive are BOTH the boolean true (start at login + auto-restart).
  expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);

  // The job is labeled with our reverse-DNS id.
  expect(plist).toContain(`<string>${PLIST_LABEL}</string>`);

  // It runs the STABLE cli.js under our config dir, not a transient npx path.
  expect(plist).toContain(`<string>${DAEMON_CLI_PATH}</string>`);
  expect(DAEMON_CLI_PATH).toBe(join(CONFIG_DIR, "cli.js"));

  // Logs are captured to files (so `status` can tail them).
  expect(plist).toContain("<key>StandardOutPath</key>");
  expect(plist).toContain("<key>StandardErrorPath</key>");
});

// ---------------------------------------------------------------------------
// 2a. installDaemon, ALREADY LOADED: bootout BEFORE bootstrap (a clean reload).
//
// This is the headline ordering assertion. A double-bootstrap (no bootout) is what
// launchd rejects with "service already loaded"; if someone drops the reload branch,
// the bootout disappears from the recorded sequence and this test fails.
// ---------------------------------------------------------------------------
test("installDaemon (already loaded): calls bootout BEFORE bootstrap - a clean reload", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 0 }); // 0 = loaded
  try {
    const result = installDaemon({
      runLaunchctl,
      nodePath: process.execPath,
      sourceCliPath,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      sleep: () => {}, // no real waiting in the wait-for-gone poll
      ...QUIET,
    });

    const verbs = calls.map((c) => c[0]);
    const bootoutAt = verbs.indexOf("bootout");
    const enableAt = verbs.indexOf("enable");
    const bootstrapAt = verbs.indexOf("bootstrap");

    // We probed, unloaded, waited for it to be gone (a re-probe), enabled, then
    // loaded - in that order.
    expect(verbs).toEqual(["print", "bootout", "print", "enable", "bootstrap"]);
    expect(bootoutAt).toBeGreaterThanOrEqual(0);
    expect(enableAt).toBeGreaterThan(bootoutAt);
    expect(bootstrapAt).toBeGreaterThan(enableAt);

    // Targets are the modern domain/service forms.
    expect(calls[bootoutAt]).toEqual([
      "bootout",
      `gui/${TEST_UID}/${PLIST_LABEL}`,
    ]);
    expect(calls[bootstrapAt]).toEqual([
      "bootstrap",
      `gui/${TEST_UID}`,
      plistPath,
    ]);

    // We told the caller it was a reload (not a fresh install).
    expect(result.reloaded).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2b. installDaemon, NOT loaded: bootstrap only, NO bootout. (Mirror of 2a so the
//     bootout isn't unconditional - proves the reload is gated on "already loaded".)
// ---------------------------------------------------------------------------
test("installDaemon (not loaded): bootstraps without a bootout, copies cli.js, writes a process.execPath plist", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 1 }); // 1 = not loaded
  try {
    const result = installDaemon({
      runLaunchctl,
      nodePath: process.execPath,
      sourceCliPath,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      ...QUIET,
    });

    const verbs = calls.map((c) => c[0]);
    // No bootout when nothing was loaded; it still enables before bootstrapping.
    expect(verbs).toEqual(["print", "enable", "bootstrap"]);
    expect(result.reloaded).toBe(false);

    // The built cli.js was actually copied to the stable path (byte-identical marker).
    expect(existsSync(daemonCliPath)).toBe(true);
    expect(readFileSync(daemonCliPath, "utf8")).toBe(
      readFileSync(sourceCliPath, "utf8"),
    );

    // The plist on disk pins the real node binary and the installed cli.js path.
    const plistOnDisk = readFileSync(plistPath, "utf8");
    expect(plistOnDisk).toContain(`<string>${process.execPath}</string>`);
    expect(plistOnDisk).toContain(`<string>${daemonCliPath}</string>`);
    expect(plistOnDisk).not.toContain("npx");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2c. installDaemon refuses "npx" as the program (the crash-loop trap), and does NOT
//     reach launchctl when it does.
// ---------------------------------------------------------------------------
test("installDaemon: refuses to bake 'npx' into the plist and never calls launchctl", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 1 });
  try {
    expect(() =>
      installDaemon({
        runLaunchctl,
        nodePath: "/opt/homebrew/bin/npx", // the forbidden program
        sourceCliPath,
        daemonCliPath,
        plistPath,
        uid: TEST_UID,
        ...QUIET,
      }),
    ).toThrow(/npx/);
    // It bailed before loading anything into launchd.
    expect(calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. uninstallDaemon: issues bootout AND removes both the plist and the cli.js copy.
// ---------------------------------------------------------------------------
test("uninstallDaemon: boots out the job and removes the plist + the cli.js copy", () => {
  const { dir, daemonCliPath, plistPath } = makeTmp();
  // Pretend a prior install left both files behind.
  writeFileSync(plistPath, "<plist/>\n");
  writeFileSync(daemonCliPath, "// installed cli.js\n");
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 0 });
  try {
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(daemonCliPath)).toBe(true);

    uninstallDaemon({
      runLaunchctl,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      ...QUIET,
    });

    // It unloaded the job by its service target...
    expect(calls).toContainEqual(["bootout", `gui/${TEST_UID}/${PLIST_LABEL}`]);
    // ...and both files are gone.
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(daemonCliPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. uninstallDaemon when the daemon was NEVER loaded: a "not loaded" bootout
//     failure is ignored and removal still happens (uninstall must never crash).
// ---------------------------------------------------------------------------
test("uninstallDaemon: ignores a 'not loaded' bootout failure and still removes files", () => {
  const { dir, daemonCliPath, plistPath } = makeTmp();
  writeFileSync(plistPath, "<plist/>\n");
  writeFileSync(daemonCliPath, "// installed cli.js\n");
  // bootout fails (nonzero) - exactly what launchctl returns for a job that isn't loaded.
  const { calls, runLaunchctl } = makeFakeLaunchctl({
    printStatus: 1,
    bootoutStatus: 3,
  });
  try {
    expect(() =>
      uninstallDaemon({
        runLaunchctl,
        daemonCliPath,
        plistPath,
        uid: TEST_UID,
        ...QUIET,
      }),
    ).not.toThrow();

    expect(calls).toContainEqual(["bootout", `gui/${TEST_UID}/${PLIST_LABEL}`]);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(daemonCliPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// setDesktopGuiEnv / unsetDesktopGuiEnv: the launchctl-setenv mechanism that gives the
// Claude/Codex DESKTOP apps the collector endpoint (they don't read settings.json's env
// block). Asserts the exact launchctl argv via the fake runner - the real GUI env is
// never touched. Dropping a var or pointing it elsewhere fails here.
// ---------------------------------------------------------------------------
test("setDesktopGuiEnv: launchctl setenv for all eight telemetry vars with the exact values", () => {
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 1 });
  setDesktopGuiEnv(runLaunchctl);
  const setenvs = calls.filter((c) => c[0] === "setenv");
  expect(setenvs.length).toBe(CCC_OWNED_TELEMETRY_KEYS.length);
  const written = Object.fromEntries(setenvs.map((c) => [c[1], c[2]]));
  expect(written).toEqual(CCC_TELEMETRY_VALUES);
  // The endpoint must point at the local collector - the whole reason this exists.
  expect(written.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
});

test("unsetDesktopGuiEnv: launchctl unsetenv for exactly the eight telemetry vars", () => {
  const { calls, runLaunchctl } = makeFakeLaunchctl({ printStatus: 1 });
  unsetDesktopGuiEnv(runLaunchctl);
  const unsetenvs = calls.filter((c) => c[0] === "unsetenv");
  expect(unsetenvs.map((c) => c[1]).sort()).toEqual(
    [...CCC_OWNED_TELEMETRY_KEYS].sort(),
  );
});

// ---------------------------------------------------------------------------
// 4. cmdStart REFUSES (exit 1, clear message) when there's no API key - and crucially
//    does NOT install the daemon. The injected installDaemon spy is the proof: if the
//    guard is removed, the spy gets called and this test fails.
// ---------------------------------------------------------------------------
test("cmdStart: refuses with exit 1 and a clear 'init' message when no API key, and never installs the daemon", async () => {
  let installed = 0;
  const errors: string[] = [];
  const deps: StartDeps = {
    platform: () => "darwin",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => false, // simulate: no key saved anywhere
    isSetUp: () => true, // setup is fine; the key is the only thing missing
    errorLog: (m) => errors.push(m),
    log: () => {},
  };

  const code = await cmdStart(deps);

  expect(code).toBe(1); // refused
  expect(installed).toBe(0); // the daemon was NOT installed (no crash-loop created)
  // The message tells a non-technical user exactly what to do.
  const joined = errors.join("\n");
  expect(joined).toMatch(/no MarginFront API key/i);
  expect(joined).toMatch(/init/);
});

// ---------------------------------------------------------------------------
// 4a. cmdStart PROCEEDS on Windows.
//
//     Init arms a cap hook that really blocks. If `start` refused on win32, there would
//     be no meter, the spend figure the cap reads would go stale, and the cap would
//     fail open about an hour later.
// ---------------------------------------------------------------------------
test("cmdStart: on Windows, installs the service and returns 0 instead of refusing", async () => {
  let installed = 0;
  let statusQueries = 0;
  const errors: string[] = [];
  const logs: string[] = [];

  const code = await cmdStart({
    platform: () => "win32",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => true,
    isSetUp: () => true,
    queryStatus: () => {
      statusQueries += 1;
      return { loaded: true, running: true, pid: 1, lastExitCode: null };
    },
    sleep: async () => {},
    errorLog: (m) => errors.push(m),
    log: (m) => logs.push(m),
  });

  expect(code).toBe(0);
  expect(installed).toBe(1);
  expect(statusQueries).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(logs.join("\n")).toContain("running in the background");
});

// ---------------------------------------------------------------------------
// 4a-linux. cmdStart on a platform with no service manager: a refusal it prints
//     itself, not a throw that escapes into main()'s "Something went wrong" catch.
//     cmdStart reaches for a manager at TWO sites, and both must be guarded:
//     `installed` staying 0 pins the install site, `statusQueries` staying 0 pins the
//     health check.
// ---------------------------------------------------------------------------
test("cmdStart: on a platform with no background meter, it refuses cleanly and touches neither seam", async () => {
  let installed = 0;
  let statusQueries = 0;
  const errors: string[] = [];

  const code = await cmdStart({
    platform: () => "linux",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => true,
    isSetUp: () => true,
    queryStatus: () => {
      statusQueries += 1;
      return { loaded: true, running: true, pid: 1, lastExitCode: null };
    },
    sleep: async () => {},
    errorLog: (m) => errors.push(m),
    log: () => {},
  });

  expect(code).toBe(1);
  expect(installed).toBe(0);
  expect(statusQueries).toBe(0);

  // What happened, why, and the thing that does work - in the user's own words.
  const joined = errors.join("\n");
  expect(joined).toContain("There's no background meter for linux yet.");
  expect(joined).toContain("node ~/.marginfront-ccc/cli.js run");
  expect(joined).toContain("lost, not buffered");
});

// The negative control for 4a: without it, a win32 refusal on a narrower condition
// than platform() would leave 4a green.
test("cmdStart: no Windows refusal copy exists to be printed", async () => {
  const cli = await import("../src/cli");

  expect("WINDOWS_START_REFUSAL" in cli).toBe(false);

  const source = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
  expect(source).not.toMatch(/WINDOWS_START_REFUSAL/);
  expect(source).not.toMatch(/Native Windows support isn't ready yet/);
});

// 4a-bis: the win32 seam is not decorative - it is what picks schtasks over launchd.
test("cmdStart: the platform seam selects the Windows service manager", () => {
  expect(selectServiceManager("win32").backend).toBe("schtasks");
  expect(selectServiceManager("darwin").backend).toBe("launchd");
});

// ---------------------------------------------------------------------------
// 4b. The mirror: with a key AND setup present AND the daemon comes up running,
//     cmdStart DOES install and returns 0. Without this, test 4 could pass only
//     because cmdStart always refused. queryStatus is injected (running:true) so we
//     never shell out to real launchctl, and sleep is a no-op so it doesn't wait.
// ---------------------------------------------------------------------------
test("cmdStart: with a key and setup present, installs the daemon once and returns 0", async () => {
  let installed = 0;
  const deps: StartDeps = {
    platform: () => "darwin",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => true,
    isSetUp: () => true,
    queryStatus: () => ({
      loaded: true,
      running: true,
      pid: 4321,
      lastExitCode: null,
    }),
    sleep: async () => {},
    errorLog: () => {},
    log: () => {},
  };

  const code = await cmdStart(deps);

  expect(code).toBe(0);
  expect(installed).toBe(1);
});

// ---------------------------------------------------------------------------
// 4c. Also refuses (without installing) when init never ran, even if a key exists -
//     the second crash-loop guard (missing collector/config).
// ---------------------------------------------------------------------------
test("cmdStart: refuses without installing when init hasn't run (no collector/config)", async () => {
  let installed = 0;
  const errors: string[] = [];
  const deps: StartDeps = {
    platform: () => "darwin",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => true,
    isSetUp: () => false, // collector/config absent
    errorLog: (m) => errors.push(m),
    log: () => {},
  };

  const code = await cmdStart(deps);

  expect(code).toBe(1);
  expect(installed).toBe(0);
  expect(errors.join("\n")).toMatch(/init/);
});

// ---------------------------------------------------------------------------
// 5. HEALTH GATE, happy path: cmdStart prints the "running in the
//    background" message ONLY after launchd confirms the job is actually running.
//    Proves the success line is gated on the status poll, not printed blindly.
// ---------------------------------------------------------------------------
test("cmdStart: prints the 'running in the background' success message only once the daemon is confirmed running", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  let statusChecks = 0;
  const deps: StartDeps = {
    platform: () => "darwin",
    installDaemon: () => {},
    hasApiKey: () => true,
    isSetUp: () => true,
    // First check: not up yet (launchd hasn't spawned it). Second check: running.
    // This proves we actually POLL rather than read once and give up/claim success.
    queryStatus: () => {
      statusChecks += 1;
      return statusChecks >= 2
        ? { loaded: true, running: true, pid: 999, lastExitCode: null }
        : { loaded: true, running: false, pid: null, lastExitCode: null };
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
    errorLog: (m) => errors.push(m),
  };

  const code = await cmdStart(deps);

  expect(code).toBe(0);
  expect(statusChecks).toBeGreaterThanOrEqual(2); // it kept polling until running
  expect(logs.join("\n")).toMatch(/running in the background/);
  // It did NOT print the failure diagnostic.
  expect(errors.join("\n")).not.toMatch(/isn't running/);
});

// ---------------------------------------------------------------------------
// 6. HEALTH GATE, dead daemon: the forwarder is loaded but never comes
//    up (e.g. a bad key). cmdStart must NOT claim success - it returns 1, shows the
//    error-log tail, and never prints "running in the background". This is the test
//    that fails if start reads "bootstrap exited 0" as success.
// ---------------------------------------------------------------------------
test("cmdStart: does NOT report success when the daemon never comes up - returns 1 and surfaces the error-log tail", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  let installed = 0;
  const deps: StartDeps = {
    platform: () => "darwin",
    installDaemon: () => {
      installed += 1;
    },
    hasApiKey: () => true,
    isSetUp: () => true,
    // Loaded by launchd, but never actually running - the crash-loop symptom.
    queryStatus: () => ({
      loaded: true,
      running: false,
      pid: null,
      lastExitCode: null,
    }),
    sleep: async () => {},
    // The real cause the user needs to see, pulled from the forwarder's err log.
    errLogTail: () => [
      "MARGINFRONT_API_KEY is not set. Set it in your shell before watching:",
    ],
    log: (m) => logs.push(m),
    errorLog: (m) => errors.push(m),
  };

  const code = await cmdStart(deps);

  expect(code).toBe(1); // honest failure, not a false success
  expect(installed).toBe(1); // it WAS installed (we install, then detect it's dead)
  // The happy message must NOT appear...
  expect(logs.join("\n")).not.toMatch(/running in the background/);
  // ...and the diagnostic + the actual error-log line must.
  const joinedErrors = errors.join("\n");
  expect(joinedErrors).toMatch(/isn't running/);
  expect(joinedErrors).toMatch(/MARGINFRONT_API_KEY is not set/);
});
