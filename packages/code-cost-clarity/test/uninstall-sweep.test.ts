// uninstall-sweep.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: uninstall/purge TRULY kills + sweeps.
//   1. cmdUninstall signals a running forwarder (SIGTERM, then SIGKILL if it won't
//      stop), read from the pidfile, so a foreground `run` or a wedged forwarder
//      cannot keep sending after --purge.
//   2. uninstallDaemon boots out EVERY ai.marginfront.ccc* label - the main job AND
//      an orphan like ai.marginfront.ccc.orphan - not only the one main label.
//
// WHAT EACH TEST CATCHES: a cmdUninstall that never reads FORWARDER_PID_PATH sends no
// signal (test 1 records zero signals -> fails). An uninstallDaemon that boots out
// only PLIST_LABEL never sweeps an orphan label (test 3 sees only one bootout ->
// fails).
//
// All side effects are injected: the kill is a recorder, the label list is a fake,
// file ops are spies. No real process is signalled and no real launchctl runs.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdUninstall, type UninstallDeps } from "../src/cli";
import {
  uninstallDaemon,
  PLIST_LABEL,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../src/connector";

const QUIET = { log: () => {} };
const TEST_UID = 501;

// A fully-injected UninstallDeps so cmdUninstall never touches the real machine. The
// caller overrides only the forwarder-teardown bits it wants to observe.
function inertUninstallDeps(
  overrides: Partial<UninstallDeps> = {},
): UninstallDeps {
  return {
    uninstallDaemon: () => {},
    stopCollector: () => {},
    removeClaudeTelemetry: () => ({ removed: [], kept: [], backupPath: null }),
    removeCodexConfig: () => ({ action: "missing", backupPath: null }),
    removeRuntimeFile: () => {},
    // These three reach paths built from homedir() at module load, so a temp dir
    // can't redirect them: left to their defaults they delete the RUNNER's real
    // ~/.marginfront-ccc/control and cap-check hooks.
    removeControlHook: () => {},
    removeCodexControlHook: () => {},
    removeControlStateDir: () => {},
    purgeConfigDir: () => {},
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    unsetDesktopEnv: () => {},
    readForwarderPid: () => null,
    isForwarderAlive: () => false,
    signalForwarder: () => {},
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. A LIVE forwarder that stops on SIGTERM: cmdUninstall signals it (SIGTERM, no
//    SIGKILL needed) with the pid from the pidfile.
// ---------------------------------------------------------------------------
test("cmdUninstall: SIGTERMs a running forwarder read from the pidfile", async () => {
  const signals: Array<{ pid: number; signal: string }> = [];
  let aliveChecks = 0;
  const code = await cmdUninstall(
    false,
    inertUninstallDeps({
      readForwarderPid: () => 4242,
      // Alive on the first check (so SIGTERM is sent), gone immediately after.
      isForwarderAlive: () => {
        aliveChecks += 1;
        return aliveChecks === 1;
      },
      signalForwarder: (pid, signal) => signals.push({ pid, signal }),
    }),
  );

  expect(code).toBe(0);
  // It signalled the EXACT pid from the pidfile, and a SIGTERM was sent.
  expect(signals.some((s) => s.pid === 4242 && s.signal === "SIGTERM")).toBe(
    true,
  );
  // It stopped on SIGTERM, so no SIGKILL was needed.
  expect(signals.some((s) => s.signal === "SIGKILL")).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. A WEDGED forwarder that ignores SIGTERM: cmdUninstall escalates to SIGKILL.
// ---------------------------------------------------------------------------
test("cmdUninstall: escalates to SIGKILL when the forwarder won't stop", async () => {
  const signals: Array<{ pid: number; signal: string }> = [];
  let t = 0;
  const code = await cmdUninstall(
    false,
    inertUninstallDeps({
      readForwarderPid: () => 9001,
      isForwarderAlive: () => true, // never dies on its own
      signalForwarder: (pid, signal) => signals.push({ pid, signal }),
      // Advance the clock past the timeout so the patience loops exit fast.
      now: () => {
        const v = t;
        t += 4000;
        return v;
      },
    }),
  );

  expect(code).toBe(0);
  expect(signals.some((s) => s.pid === 9001 && s.signal === "SIGTERM")).toBe(
    true,
  );
  expect(signals.some((s) => s.pid === 9001 && s.signal === "SIGKILL")).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------
// 3. uninstallDaemon sweeps the main label AND an orphan ai.marginfront.ccc.* label,
//    but leaves unrelated labels alone.
// ---------------------------------------------------------------------------
test("uninstallDaemon: boots out the main label AND an orphan ai.marginfront.ccc.orphan, not unrelated labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-sweep-"));
  const calls: string[][] = [];
  const runLaunchctl: LaunchctlRunner = (args): LaunchctlResult => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    uninstallDaemon({
      runLaunchctl,
      daemonCliPath: join(dir, "cli.js"),
      plistPath: join(dir, "ai.marginfront.ccc.plist"),
      uid: TEST_UID,
      // The fake "what's loaded" view: our two labels plus an unrelated one.
      labelLister: () => [
        "ai.marginfront.ccc",
        "ai.marginfront.ccc.orphan",
        "com.apple.somethingelse",
      ],
      ...QUIET,
    });

    const bootouts = calls.filter((c) => c[0] === "bootout").map((c) => c[1]);

    // Both OUR labels were booted out, by their gui/<uid>/<label> service target.
    expect(bootouts).toContain(`gui/${TEST_UID}/${PLIST_LABEL}`);
    expect(bootouts).toContain(`gui/${TEST_UID}/ai.marginfront.ccc.orphan`);
    // The unrelated label was left alone.
    expect(bootouts).not.toContain(`gui/${TEST_UID}/com.apple.somethingelse`);
    // The main label is booted out exactly once (the Set dedupes it).
    expect(
      bootouts.filter((t) => t === `gui/${TEST_UID}/${PLIST_LABEL}`).length,
    ).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The default label lister parses `launchctl list` + `print-disabled` and returns
//    only what those sources name (so uninstallDaemon's filter has real input to work
//    on). Proves the production discovery path, not only the injected fake.
// ---------------------------------------------------------------------------
test("uninstallDaemon: with the default lister, discovers an orphan from launchctl list output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-sweep-default-"));
  const calls: string[][] = [];
  const runLaunchctl: LaunchctlRunner = (args): LaunchctlResult => {
    calls.push(args);
    if (args[0] === "list") {
      return {
        status: 0,
        // "PID\tStatus\tLabel" rows, like real `launchctl list`.
        stdout:
          "-\t0\tcom.apple.foo\n123\t0\tai.marginfront.ccc.orphan\n-\t0\tcom.apple.bar\n",
        stderr: "",
      };
    }
    if (args[0] === "print-disabled") {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    uninstallDaemon({
      runLaunchctl,
      daemonCliPath: join(dir, "cli.js"),
      plistPath: join(dir, "ai.marginfront.ccc.plist"),
      uid: TEST_UID,
      // NOTE: no labelLister override -> exercises defaultLaunchdLabelLister.
      ...QUIET,
    });

    const bootouts = calls.filter((c) => c[0] === "bootout").map((c) => c[1]);

    expect(bootouts).toContain(`gui/${TEST_UID}/${PLIST_LABEL}`);
    expect(bootouts).toContain(`gui/${TEST_UID}/ai.marginfront.ccc.orphan`);
    expect(bootouts).not.toContain(`gui/${TEST_UID}/com.apple.foo`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
